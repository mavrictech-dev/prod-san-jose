import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { LOCAL_XML_PROFILE, validateLocalInvoice, assertFiscalSnapshot } from '@factuez/sunat-core';
import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import type { LocalXmlValidation } from '../generated/prisma/client';
import { PrismaService } from '../infrastructure/prisma.service';
import { ArtifactStore } from '../infrastructure/artifact-store';
import { SecretVault } from '../infrastructure/crypto/secret-vault';
import { LocalXmlWorkerService } from '../infrastructure/crypto/local-xml-worker.service';
import type { PrintOwner } from './current-pdf.service';

const hash = (snapshot: unknown) => createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
export class LocalDocumentPendingError extends ConflictException {
  constructor() { super('XML en preparación. Reintente en unos segundos'); }
}

@Injectable()
export class LocalXmlValidationService {
  constructor(private readonly prisma: PrismaService, private readonly store: ArtifactStore,
    private readonly vault: SecretVault, private readonly worker: LocalXmlWorkerService) {}

  async context(documentId: string, authorization?: string) {
    if (process.env.LOCAL_XML_VALIDATION_ENABLED !== 'true') throw new ServiceUnavailableException('Las pruebas XML locales están deshabilitadas en esta instalación');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(documentId)) throw new BadRequestException('Documento inválido');
    if (!authorization || !/^Bearer [A-Za-z0-9_.-]{1,8192}$/i.test(authorization)) throw new UnauthorizedException('Inicie sesión');
    let response: Response;
    try { response = await fetch(`${process.env.BILLING_INTERNAL_URL ?? 'http://billing-service:3002'}/api/v1/documents/${documentId}`, {
      headers: { Authorization: authorization, Accept: 'application/json', 'Cache-Control': 'no-store' }, signal: AbortSignal.timeout(5000), redirect: 'error' }); }
    catch { throw new ServiceUnavailableException('No se pudo verificar el documento en Billing'); }
    if (response.status === 401) throw new UnauthorizedException('Inicie sesión nuevamente');
    if (response.status === 403) throw new ForbiddenException('Documento no autorizado');
    if (response.status === 404) throw new NotFoundException('Documento no disponible');
    if (!response.ok) throw new ServiceUnavailableException('Billing no está disponible');
    let detail: { id: string; immutableSnapshot: FiscalDocumentSnapshot; fiscalTransmission: boolean; printContext?: PrintOwner };
    try { detail = await response.json() as typeof detail; } catch { throw new ServiceUnavailableException('Respuesta de Billing inválida'); }
    const snapshot = detail.immutableSnapshot;
    if (detail.id !== documentId || snapshot?.documentId !== documentId || detail.fiscalTransmission !== false) throw new ConflictException('Contexto de prueba inconsistente');
    if (snapshot.environment !== 'BETA' || !/^00\d{9}$/.test(snapshot.issuer?.identityNumber ?? '')) throw new ConflictException('Sólo se admiten emisores ficticios 00… en BETA; no se firman comprobantes del RUC real');
    try { validateLocalInvoice(snapshot, { allowCredit: true }); } catch { throw new BadRequestException('Documento fuera del perfil local: venta onerosa 01/03, IGV 18%, importes y forma de pago consistentes'); }
    try { assertFiscalSnapshot(snapshot, { mode: 'LOCAL_DEVELOPMENT' }); } catch { throw new BadRequestException('Snapshot fuera del perfil fiscal versionado local; revise identidad, calendario, unidades, identificación de cliente e importes'); }
    const fiscal = await this.prisma.fiscalDocument.findUnique({ where: { documentId } });
    if (!fiscal) throw new LocalDocumentPendingError();
    if (fiscal.issuerRuc !== snapshot.issuer.identityNumber || fiscal.environment !== 'BETA' ||
      !['QUEUED', 'BUILDING'].includes(fiscal.status) || !isDeepStrictEqual(fiscal.immutablePayload, JSON.parse(JSON.stringify(snapshot)))) throw new ConflictException('Contexto fiscal inconsistente o documento fuera de prueba local');
    const credentials = await this.prisma.sunatCredentials.findUnique({ where: { issuerRuc_environment: { issuerRuc: fiscal.issuerRuc, environment: 'BETA' } } });
    if (!credentials?.certificateCipher || !credentials.certificatePasswordCipher || !credentials.certificateFingerprint ||
      credentials.certificateSelfSigned !== true || !credentials.certificateExpiresAt || credentials.certificateExpiresAt <= new Date()) throw new ConflictException('Configure un certificado ficticio autofirmado y vigente para este RUC en BETA');
    return { snapshot, fiscal, credentials, printContext: detail.printContext };
  }

  private view(row: LocalXmlValidation | null) {
    return { ready: Boolean(row), id: row?.id ?? null, profile: LOCAL_XML_PROFILE,
      signatureVerified: Boolean(row), amountsValidated: Boolean(row), xsdValidated: false,
      sunatRulesValidated: false, trustAndRucVerified: false, fiscalTransmission: false, cdrReceived: false,
      certificateFingerprint: row?.certificateFingerprint ?? null, digestValue: row?.digestValue ?? null,
      credentialRevision: row?.credentialRevision ?? null, zipSha256: row?.zipSha256 ?? null, createdAt: row?.createdAt ?? null };
  }
  private key(documentId: string, revision: number) {
    return { documentId_profile_credentialRevision: { documentId, profile: LOCAL_XML_PROFILE, credentialRevision: revision } };
  }
  private check(row: LocalXmlValidation, context: Awaited<ReturnType<LocalXmlValidationService['context']>>) {
    if (row.snapshotSha256 !== hash(context.snapshot) || row.certificateFingerprint !== context.credentials.certificateFingerprint) throw new ConflictException('Prueba archivada inconsistente');
  }
  async status(documentId: string, authorization?: string) {
    const context = await this.context(documentId, authorization);
    const row = await this.prisma.localXmlValidation.findUnique({ where: this.key(documentId, context.credentials.revision) });
    if (row) this.check(row, context);
    return this.view(row);
  }
  async prepare(documentId: string, actorId: string, authorization?: string) {
    const context = await this.context(documentId, authorization);
    const { snapshot, credentials, fiscal } = context;
    const where = this.key(documentId, credentials.revision);
    const existing = await this.prisma.localXmlValidation.findUnique({ where });
    if (existing) { this.check(existing, context); return this.view(existing); }
    const secretContext = { ruc: fiscal.issuerRuc, environment: 'BETA' };
    const bytes = this.vault.open(credentials.certificateCipher!, { ...secretContext, field: 'certificate' });
    let passwordBytes: Buffer | undefined;
    let prepared: Awaited<ReturnType<LocalXmlWorkerService['prepare']>>;
    try {
      passwordBytes = this.vault.open(credentials.certificatePasswordCipher!, { ...secretContext, field: 'certificatePassword' });
      prepared = await this.worker.prepare(snapshot, bytes, passwordBytes.toString('utf8'));
    } finally { bytes.fill(0); passwordBytes?.fill(0); }
    if (prepared.certificateFingerprintSha256 !== credentials.certificateFingerprint || prepared.profile !== LOCAL_XML_PROFILE) throw new ConflictException('Identidad criptográfica inconsistente');
    // Revalida revocación/acceso después del trabajo criptográfico y antes de persistir.
    await this.context(documentId, authorization);
    const xml = await this.store.put(documentId, `${prepared.fileName}-LOCAL-QA.xml`, Buffer.from(prepared.xml));
    const zip = await this.store.put(documentId, `${prepared.fileName}-LOCAL-QA.zip`, prepared.zip);
    const row = await this.prisma.$transaction(async tx => {
      // Mismo lock que el cambio de credenciales; no guardar con revisión obsoleta.
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', `${fiscal.issuerRuc}:BETA`);
      const current = await tx.sunatCredentials.findUnique({ where: { issuerRuc_environment: { issuerRuc: fiscal.issuerRuc, environment: 'BETA' } } });
      if (current?.revision !== credentials.revision || current.certificateFingerprint !== credentials.certificateFingerprint) throw new ConflictException('El certificado cambió. Repita la prueba');
      await tx.$queryRawUnsafe('SELECT "documentId" FROM "FiscalDocument" WHERE "documentId" = $1::uuid FOR UPDATE', documentId);
      const document = await tx.fiscalDocument.findUnique({ where: { documentId } });
      if (!document || !['QUEUED', 'BUILDING'].includes(document.status) || !isDeepStrictEqual(document.immutablePayload, fiscal.immutablePayload)) throw new ConflictException('El contexto fiscal cambió');
      return tx.localXmlValidation.upsert({ where, update: {}, create: {
        documentId, profile: LOCAL_XML_PROFILE, credentialRevision: credentials.revision,
        certificateFingerprint: prepared.certificateFingerprintSha256, snapshotSha256: hash(snapshot), digestValue: prepared.digestValue,
        xmlStorageKey: xml.storageKey, xmlSha256: xml.sha256, xmlSizeBytes: BigInt(xml.sizeBytes),
        zipStorageKey: zip.storageKey, zipSha256: zip.sha256, zipSizeBytes: BigInt(zip.sizeBytes), actorId,
      } });
    }).catch(error => {
      if (error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException('No se pudo archivar la prueba local de forma segura');
    });
    this.check(row, context);
    return this.view(row);
  }
  async download(documentId: string, authorization?: string) {
    const context = await this.context(documentId, authorization);
    const row = await this.prisma.localXmlValidation.findUnique({ where: this.key(documentId, context.credentials.revision) });
    if (!row) throw new ConflictException('Ejecute primero la validación local del XML');
    this.check(row, context);
    let bytes: Buffer;
    try {
      await this.store.read(documentId, { storageKey: row.xmlStorageKey, sha256: row.xmlSha256, sizeBytes: row.xmlSizeBytes });
      bytes = await this.store.read(documentId, { storageKey: row.zipStorageKey, sha256: row.zipSha256, sizeBytes: row.zipSizeBytes });
    } catch { throw new ServiceUnavailableException('No se pudo verificar la integridad de los archivos locales'); }
    const s = context.snapshot;
    return { bytes, fileName: `${s.issuer.identityNumber}-${s.documentTypeCode}-${s.fullNumber}-PRUEBA-LOCAL.zip` };
  }
}
