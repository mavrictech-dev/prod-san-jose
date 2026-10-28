import { Injectable, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { Queue, Worker } from 'bullmq';
import { redisConnection } from '@factuez/service-access';
import { assertFiscalSnapshot, buildInvoiceUbl, buildReceiptSummary, buildReceiptSummarySnapshot, receiptSummaryReconstructionAsOf, fiscalSnapshotSha256 } from '@factuez/sunat-core';
import { PrismaService } from '../infrastructure/prisma.service';
import { ArtifactStore } from '../infrastructure/artifact-store';
import { SecretVault } from '../infrastructure/crypto/secret-vault';
import { CertificateInspectionService } from '../infrastructure/crypto/certificate-inspection.service';
import { CertificateTrustService, type InspectedSigningCertificate } from '../infrastructure/crypto/certificate-trust.service';
import { PublicSignerArchive } from '../infrastructure/crypto/public-signer-archive';
import { verifyLocalSignedInvoice } from '../infrastructure/crypto/xml-signer.service';
import { CdrSignatureTrustService } from '../infrastructure/crypto/cdr-signature-trust.service';
import { BetaXmlWorkerService } from '../infrastructure/crypto/beta-xml-worker.service';
import { BoundedSoapAdapter, SUNAT_BETA_PUBLIC_CREDENTIAL } from '../infrastructure/sunat/bounded-soap.adapter';
import { parseCdrZip } from '../infrastructure/sunat/cdr-parser';
import { XsdValidationService } from '../infrastructure/sunat/xsd-validation.service';
import { assertOfficialFiscalActivation } from './fiscal-readiness.service';
import { BetaIssuanceRepository, type BetaManifest } from './beta-issuance.repository';
import { BetaDispatchPipeline, type BetaDispatchPorts, type BetaDispatchRow, type BetaPrepared } from './beta-dispatch-pipeline';
const QUEUE = 'sunat-beta-dispatch';

/** Vertical normal compartida. Beta conserva su gate; Producción exige política privada por emisor. */
@Injectable()
export class BetaIssuanceService implements OnApplicationBootstrap, OnModuleDestroy {
  protected readonly environment: 'BETA' | 'PRODUCTION' = 'BETA';
  protected queueName() { return this.environment === 'BETA' ? QUEUE : 'sunat-production-invoice-dispatch'; }
  protected workflowEnabled() { if (process.env.SUNAT_BETA_WORKFLOW_ENABLED !== 'true') return false; try { assertOfficialFiscalActivation(); } catch { return false; } }
  private queue?: Queue; private worker?: Worker; private timer?: NodeJS.Timeout; private flushing = false;
  constructor(protected readonly prisma: PrismaService, protected readonly repository: BetaIssuanceRepository,
    private readonly store: ArtifactStore, protected readonly vault: SecretVault, protected readonly inspection: CertificateInspectionService,
    protected readonly trust: CertificateTrustService, private readonly signer: BetaXmlWorkerService,
    private readonly xsd: XsdValidationService, private readonly cdrTrust: CdrSignatureTrustService,
    @Optional() private readonly publicSigners: PublicSignerArchive = new PublicSignerArchive()) {}
  protected async authorize(row: BetaDispatchRow) {
    if (row.snapshot.environment !== 'BETA') throw new Error('Producción bloqueada');
    assertOfficialFiscalActivation(); // No sustituir por flag ni por certificado guardado.
  }
  protected async context(row: BetaDispatchRow, revision?: number) {
    assertFiscalSnapshot(row.snapshot, { mode: 'REAL_PREPARATION' });
    const document = await this.prisma.fiscalDocument.findUnique({ where: { documentId: row.documentId } });
    if (document?.environment !== this.environment || document.issuerRuc !== row.snapshot.issuer.identityNumber ||
      !isDeepStrictEqual(document.immutablePayload, JSON.parse(JSON.stringify(row.snapshot)))) throw new Error('Contexto fiscal cambió');
    const credentials = await this.prisma.sunatCredentials.findUnique({ where: { issuerRuc_environment: {
      issuerRuc: row.snapshot.issuer.identityNumber, environment: this.environment } } });
    if (!credentials?.certificateCipher || !credentials.certificatePasswordCipher || credentials.certificateSelfSigned !== false ||
      !credentials.certificateFingerprint || !credentials.certificateExpiresAt || credentials.certificateExpiresAt <= new Date() ||
      (revision !== undefined && credentials.revision !== revision)) throw new Error('Certificado Beta no preparado');
    return credentials;
  }
  protected async adapter(row: BetaDispatchRow) {
    return new BoundedSoapAdapter({ environment: 'BETA', ruc: row.snapshot.issuer.identityNumber,
      solUser: SUNAT_BETA_PUBLIC_CREDENTIAL, solPassword: SUNAT_BETA_PUBLIC_CREDENTIAL });
  }
  private async prepare(row: BetaDispatchRow): Promise<BetaPrepared> {
    const credentials = await this.context(row), context = { ruc: row.snapshot.issuer.identityNumber, environment: this.environment };
    const bytes = this.vault.open(credentials.certificateCipher!, { ...context, field: 'certificate' }); let password: Buffer | undefined;
    let prepared: Awaited<ReturnType<BetaXmlWorkerService['prepare']>>;
    let publicMetadata: InspectedSigningCertificate | undefined;
    let summaryIdentifier: string | undefined;
    try {
      password = this.vault.open(credentials.certificatePasswordCipher!, { ...context, field: 'certificatePassword' });
      const metadata = await this.inspection.inspect(bytes, password.toString());
      const checkedAt = new Date();
      const trust = await this.trust.evaluate(metadata, context.ruc, checkedAt);
      if (metadata.fingerprint !== credentials.certificateFingerprint || !trust.chainValid || !trust.identityMatched ||
        trust.revocation !== 'VERIFIED_OFFLINE_CRL') throw new Error('Cadena/identidad/revocación pendientes');
      if (this.environment === 'PRODUCTION') {
        if (trust.profile !== 'OFFLINE-PINNED-ROOTS-CRL-v1' || trust.certificateFingerprint !== metadata.fingerprint ||
            trust.checkedAt !== checkedAt.toISOString() || !Array.isArray(trust.blockers) || trust.blockers.length ||
            !/^[a-f0-9]{64}$/.test(trust.trustStoreSha256 ?? '')) throw new Error('Confianza pública de producción no acreditada');
        publicMetadata = structuredClone(metadata);
      }
      summaryIdentifier = row.snapshot.documentTypeCode === '03' ? await this.repository.reserveSummary(row) : undefined;
      prepared = await this.signer.prepare(row.snapshot, bytes, password.toString(), summaryIdentifier);
    } finally { bytes.fill(0); password?.fill(0); }
    if (prepared.document.certificateFingerprintSha256 !== credentials.certificateFingerprint) throw new Error('Firmante cambió');
    if (row.snapshot.documentTypeCode === '03' && !Buffer.isBuffer(prepared.individualZip)) throw new Error('Paquete individual de boleta ausente');
    const documentProof = await this.xsd.validate(prepared.document.xml, 'Invoice');
    const requestProof = row.snapshot.documentTypeCode === '03' ? await this.xsd.validate(prepared.request.xml, 'SummaryDocuments') : documentProof;
    await this.context(row, credentials.revision);
    if (!await this.repository.owns(row, 'PREPARING')) throw new Error('Preparación perdió su lease');
    if (this.environment === 'PRODUCTION') {
      if (!publicMetadata || !['01', '03'].includes(row.snapshot.documentTypeCode) ||
          prepared.request.certificateFingerprintSha256 !== publicMetadata.fingerprint ||
          (row.snapshot.documentTypeCode === '01' && (prepared.request.xml !== prepared.document.xml || prepared.request.digestValue !== prepared.document.digestValue)) ||
          verifyLocalSignedInvoice(prepared.document.xml, publicMetadata.certificatePem,
            buildInvoiceUbl(row.snapshot, { mode: 'REAL_PREPARATION' })) !== prepared.document.digestValue)
        throw new Error('XML productivo no corresponde al firmante público verificado');
      if (row.snapshot.documentTypeCode === '03' && (!summaryIdentifier ||
          prepared.document.certificateFingerprintSha256 !== publicMetadata.fingerprint ||
          prepared.fileName !== context.ruc + '-' + summaryIdentifier ||
          prepared.documentFileName !== context.ruc + '-03-' + row.snapshot.fullNumber ||
          verifyLocalSignedInvoice(prepared.request.xml, publicMetadata.certificatePem,
            buildReceiptSummary(row.snapshot, summaryIdentifier, 'REAL_PREPARATION'), 'SummaryDocuments') !== prepared.request.digestValue))
        throw new Error('RC productivo no corresponde exactamente a la boleta y firmante verificados');
      // Publish PUBLIC chain before any prepared artifact/manifest can be committed. Never alter history.
      await this.publicSigners.archive(context.ruc, publicMetadata);
      await this.context(row, credentials.revision);
      if (!await this.repository.owns(row, 'PREPARING')) throw new Error('Preparación perdió su lease');
    }
    const reference = row.snapshot.documentTypeCode === '01' ? row.snapshot.fullNumber : summaryIdentifier!;
    const requestOwnerId = row.snapshot.documentTypeCode === '03' ? buildReceiptSummarySnapshot(row.snapshot, reference).documentId : row.documentId;
    const manifest: BetaManifest = { fileName: `${prepared.fileName}.zip`, reference, requestOwnerId,
      ...(this.environment === 'PRODUCTION' && row.snapshot.documentTypeCode === '03' ? { documentSnapshotSha256: fiscalSnapshotSha256(row.snapshot) } : {}),
      revision: credentials.revision, fingerprint: credentials.certificateFingerprint!, digest: prepared.document.digestValue,
      zip: await this.store.put(requestOwnerId, `${prepared.fileName}.zip`, prepared.zip),
      xml: await this.store.put(requestOwnerId, `${prepared.fileName}.xml`, Buffer.from(prepared.request.xml)),
      ...(row.snapshot.documentTypeCode === '03' ? { documentZip: await this.store.put(row.documentId, `${prepared.fileName}.zip`, prepared.zip) } : {}),
      ...(prepared.individualZip ? { individualXmlZip: await this.store.put(row.documentId, `${prepared.documentFileName}.zip`, prepared.individualZip) } : {}),
      documentXml: await this.store.put(row.documentId, `${prepared.documentFileName}.xml`, Buffer.from(prepared.document.xml)),
      xsdEvidence: { document: documentProof, request: requestProof } };
    if (manifest.xml.sha256 !== requestProof.xmlSha256 || manifest.documentXml.sha256 !== documentProof.xmlSha256) throw new Error('XSD no corresponde al artefacto');
    this.manifests.set(row.id, manifest);
    return { fileName: manifest.fileName, reference: manifest.reference, zip: prepared.zip, sha256: manifest.zip.sha256, revision: manifest.revision };
  }
  // Sólo manifiestos públicos/hashes durante una ejecución; no certificados/password/JWT.
  private readonly manifests = new Map<string, BetaManifest>();
  private async archived(row: BetaDispatchRow): Promise<BetaPrepared> {
    const manifest = await this.repository.manifest(row);
    await this.context(row, manifest.revision);
    if (this.environment === 'PRODUCTION' && row.snapshot.documentTypeCode === '03')
      await this.repository.receiptSummaryEvidence(row, manifest);
    const ownerId = manifest.requestOwnerId ?? row.documentId;
    const xml = await this.store.read(ownerId, manifest.xml);
    const proof = await this.xsd.validate(xml, row.snapshot.documentTypeCode === '01' ? 'Invoice' : 'SummaryDocuments');
    if (proof.xmlSha256 !== manifest.xml.sha256) throw new Error('Paquete inconsistente');
    const zip = await this.store.read(ownerId, manifest.zip);
    const { unzipSync } = await import('fflate'); let entryCount = 0; const entries = unzipSync(zip, { filter: entry => {
      if (++entryCount !== 1 || entry.name !== manifest.fileName.replace(/\.zip$/, '.xml') || entry.originalSize !== xml.length) throw new Error('ZIP inconsistente'); return true;
    } });
    if (Object.keys(entries).length !== 1 || !Buffer.from(Object.values(entries)[0]).equals(xml)) throw new Error('ZIP no corresponde al XSD');
    if (this.environment === 'PRODUCTION' && row.snapshot.documentTypeCode === '03') {
      if (!manifest.documentZip || !(await this.store.read(row.documentId, manifest.documentZip)).equals(zip))
        throw new Error('Copia documental del RC enviado inconsistente');
    }
    // Older manifests have no individual archive. New 03 manifests keep it separate
    // from the RC transport; validate both files again when resuming a prepared job.
    if (manifest.individualXmlZip) {
      if (row.snapshot.documentTypeCode !== '03') throw new Error('Paquete individual inesperado');
      const memberXml = await this.store.read(row.documentId, manifest.documentXml);
      const memberProof = await this.xsd.validate(memberXml, 'Invoice');
      if (memberProof.xmlSha256 !== manifest.documentXml.sha256) throw new Error('XML individual inconsistente');
      const memberZip = await this.store.read(row.documentId, manifest.individualXmlZip);
      const name = `${row.snapshot.issuer.identityNumber}-03-${row.snapshot.fullNumber}.xml`; let count = 0;
      const members = unzipSync(memberZip, { filter: entry => {
        if (++count !== 1 || entry.name !== name || entry.originalSize !== memberXml.length) throw new Error('ZIP individual inconsistente'); return true;
      } });
      if (Object.keys(members).length !== 1 || !Buffer.from(Object.values(members)[0]).equals(memberXml)) throw new Error('ZIP individual no corresponde al XML');
    }
    if (this.environment === 'PRODUCTION' && row.snapshot.documentTypeCode === '03') {
      const material = await this.publicSigners.load(row.snapshot.issuer.identityNumber, manifest.fingerprint);
      const memberXml = await this.store.read(row.documentId, manifest.documentXml);
      if (verifyLocalSignedInvoice(memberXml.toString('utf8'), material.certificatePem,
          buildInvoiceUbl(row.snapshot, { mode: 'REAL_PREPARATION' })) !== manifest.digest)
        throw new Error('XML individual archivado no corresponde al snapshot');
      verifyLocalSignedInvoice(xml.toString('utf8'), material.certificatePem,
        buildReceiptSummary(row.snapshot, manifest.reference, 'REAL_PREPARATION', receiptSummaryReconstructionAsOf(manifest.reference)), 'SummaryDocuments');
    }
    return { fileName: manifest.fileName, reference: manifest.reference, zip, sha256: manifest.zip.sha256, revision: manifest.revision };
  }
  async process(id: string) {
    const row = await this.repository.load(id); if (!row) return;
    const ports: BetaDispatchPorts = {
      authorize: value => this.authorize(value), claim: (value, phase) => this.repository.claim(value, phase),
      prepare: value => this.prepare(value), archived: value => this.archived(value),
      owns: (value, phase) => this.repository.owns(value, phase),
      savePrepared: async value => {
        const manifest = this.manifests.get(value.id) ?? await this.repository.manifest(value);
        return this.repository.savePrepared(value, manifest);
      },
      transition: (value, from, to, details) => this.repository.transition(value, from, to, details),
      submit: async (value, prepared) => {
        await this.context(value, prepared.revision); // Revisión nuevamente inmediatamente antes del POST.
        if (this.environment === 'PRODUCTION' && value.snapshot.documentTypeCode === '03') {
          const exact = await this.archived(value);
          if (exact.sha256 !== prepared.sha256 || exact.reference !== prepared.reference || exact.fileName !== prepared.fileName || !exact.zip.equals(prepared.zip))
            throw new Error('Paquete RC cambió antes del envío');
        }
        const pkg = { documentId: value.documentId, fileName: prepared.fileName, zip: prepared.zip, sha256: prepared.sha256 };
        const adapter = await this.adapter(value);
        return value.snapshot.documentTypeCode === '01' ? adapter.submit(pkg) : { kind: 'TICKET', ticket: await adapter.submitSummary(pkg) };
      },
      getStatus: async (value, ticket) => (await this.adapter(value)).getStatus(ticket),
      cdr: async (value, prepared, bytes) => {
        let receiptSummary;
        if (this.environment === 'PRODUCTION' && value.snapshot.documentTypeCode === '03') {
          const exact = await this.archived(value);
          if (exact.sha256 !== prepared.sha256 || exact.reference !== prepared.reference || exact.fileName !== prepared.fileName || !exact.zip.equals(prepared.zip))
            throw new Error('CDR no vinculado al RC archivado');
          receiptSummary = await this.repository.receiptSummaryEvidence(value, await this.repository.manifest(value));
        }
        const parsed = parseCdrZip(bytes, { fileName: `R-${prepared.fileName.replace(/\.zip$/, '.xml')}`, issuerRuc: value.snapshot.issuer.identityNumber, reference: prepared.reference });
        const trusted = await this.cdrTrust.verify(parsed.xml);
        const zip = await this.store.put(value.documentId, `R-${prepared.fileName}`, bytes), xml = await this.store.put(value.documentId, `R-${prepared.fileName.replace(/\.zip$/, '.xml')}`, parsed.xml);
        const batchOwner = value.snapshot.documentTypeCode === '03' ? buildReceiptSummarySnapshot(value.snapshot, prepared.reference).documentId : undefined;
        const batchZip = batchOwner ? await this.store.put(batchOwner, `R-${prepared.fileName}`, bytes) : undefined;
        const batchXml = batchOwner ? await this.store.put(batchOwner, `R-${prepared.fileName.replace(/\.zip$/, '.xml')}`, parsed.xml) : undefined;
        await this.prisma.$transaction(async tx => {
          // CAS primero: el lock dura toda la transacción. Un worker antiguo
          // nunca adjunta CDR ni publica evidencia después de perder el lease.
          const owned = await tx.sunatSubmission.updateMany({ where: { id: value.id, documentId: value.documentId,
            startedAt: value.owner, attempt: value.attempt, errorCode: { in: ['SENDING', 'POLLING'] },
            result: 'PENDING', completedAt: null, nextRetryAt: { gt: new Date() } },
            data: { responseArtifactKey: zip.storageKey, nextRetryAt: new Date(Date.now() + 60000) } });
          if (owned.count !== 1) throw new Error('CDR perdió su lease');
          if (batchOwner) {
            const stored = await tx.sunatSubmission.findUniqueOrThrow({ where: { id: value.id } });
            if (!stored.batchId || !batchZip || !batchXml) throw new Error('CDR de resumen sin lote propio');
            for (const [kind, file, mediaType] of [['CDR_ZIP', batchZip, 'application/zip'], ['CDR_XML', batchXml, 'application/xml']] as const) {
              const key = { batchId_kind: { batchId: stored.batchId, kind } };
              const previous = await tx.batchArtifact.findUnique({ where: key });
              if (previous && previous.sha256 !== file.sha256) throw new Error('No se reemplaza CDR de resumen');
              await tx.batchArtifact.upsert({ where: key, update: {}, create: { batchId: stored.batchId, kind, ...file, mediaType } });
            }
          }
          for (const [kind, file, mediaType] of [['CDR_ZIP', zip, 'application/zip'], ['CDR_XML', xml, 'application/xml']] as const)
            await tx.documentArtifact.upsert({ where: { documentId_kind: { documentId: value.documentId, kind } }, update: {}, create: { documentId: value.documentId, kind, ...file, mediaType } });
          await tx.cdrLog.create({ data: { documentId: value.documentId, submissionId: value.id, responseCode: parsed.code,
            description: trusted ? parsed.description : 'CDR recibido: firma/confianza no acreditadas', notes: parsed.notes, cdrStorageKey: zip.storageKey, cdrSha256: zip.sha256 } });
        });
        return { trusted, status: parsed.status, code: parsed.code, description: parsed.description, notes: parsed.notes, ...(receiptSummary ? { receiptSummary } : {}) };
      },
    };
    try { await new BetaDispatchPipeline(ports, this.environment).run(row); } finally { this.manifests.delete(id); }
  }
  onApplicationBootstrap() {
    if (!this.workflowEnabled()) return;
    this.queue = new Queue(this.queueName(), { connection: redisConnection() });
    const worker = new Worker(this.queueName(), job => this.process(String(job.data.id)), { connection: redisConnection(), concurrency: 1 });
    this.worker = worker; worker.on('error', () => {});
    this.timer = setInterval(() => void this.dispatch(), 2000);
  }
  private async dispatch() {
    if (this.flushing || !this.queue) return; this.flushing = true;
    try {
      await this.repository.recoverInterrupted();
      for (const row of await this.repository.due()) await this.queue.add('beta-dispatch', { id: row.id }, {
        jobId: `${row.id}-${row.errorCode}-${row.attempt}-${row.startedAt.getTime()}`, removeOnComplete: 100, removeOnFail: 100 });
    } catch { /* BD conserva el estado; no imprimir errores externos/snapshots. */ }
    finally { this.flushing = false; }
  }
  async onModuleDestroy() { if (this.timer) clearInterval(this.timer); await this.worker?.close(); await this.queue?.close(); }
}
