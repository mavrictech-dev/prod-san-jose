import { Injectable, BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import { assertFiscalSnapshot, fiscalSnapshotSha256 } from '@factuez/sunat-core';
import { PrismaService } from '../infrastructure/prisma.service';
import { FiscalConfigurationService } from './fiscal-configuration.service';
import { FiscalReadinessService } from './fiscal-readiness.service';
import { loadPinnedPublicFile } from '../infrastructure/crypto/certificate-trust.service';

export const PRODUCTION_INVOICE_PROFILE = '01-PEN-0101-IGV18-v1';
export const PRODUCTION_RECEIPT_PROFILE = '01-03-PEN-0101-IGV18-v2';
export function productionDocumentTypes(profile: string): Array<'01' | '03'> {
  return profile === PRODUCTION_RECEIPT_PROFILE ? ['01', '03'] : profile === PRODUCTION_INVOICE_PROFILE ? ['01'] : [];
}
export const PRODUCTION_CONFIRMATION = 'ACTIVAR ENVÍOS REALES A SUNAT';
const required = ['ISSUER_REAL_RUC', 'SECRET_VAULT', 'SOL_SECRETS_LOCAL', 'CERTIFICATE_KEY_PAIR', 'CERTIFICATE_RUC', 'CERTIFICATE_CHAIN', 'CERTIFICATE_REVOCATION', 'XSD_RUNTIME', 'CDR_TRUST', 'BILLING_PRODUCTION_ADMISSION'];
export const productionWorkflowEnabled = () => process.env.SUNAT_PRODUCTION_WORKFLOW_ENABLED === 'true';
export function assertProductionInvoice(snapshot: FiscalDocumentSnapshot) {
  if (snapshot.environment !== 'PRODUCTION' || !['01', '03'].includes(snapshot.documentTypeCode) || snapshot.currencyCode !== 'PEN' || snapshot.operationTypeCode !== '0101') throw new Error('El perfil de producción sólo admite 01/03 PEN, operación 0101 e IGV 18 %');
  assertFiscalSnapshot(snapshot, { mode: 'REAL_PREPARATION' });
}
function storageUnavailable() { return new ServiceUnavailableException('La autorización de despacho no está instalada en este servidor'); }
@Injectable()
export class ProductionDispatchPolicy {
  constructor(private readonly prisma: PrismaService, private readonly configuration: FiscalConfigurationService,
    private readonly readiness: FiscalReadinessService) {}
  async status(companyId: string, environment: string, authorization: string) {
    if (environment !== 'PRODUCTION') throw new BadRequestException('Esta autorización corresponde a Producción');
    const config = await this.configuration.status(companyId, environment, authorization);
    let grant;
    try { grant = await this.prisma.fiscalDispatchAuthorization.findUnique({ where: { issuerRuc_environment: { issuerRuc: config.ruc, environment: 'PRODUCTION' } } }); }
    catch { throw storageUnavailable(); }
    return { ruc: config.ruc, environment, profile: grant?.profile ?? PRODUCTION_INVOICE_PROFILE, supportedDocumentTypes: productionDocumentTypes(grant?.profile ?? PRODUCTION_INVOICE_PROFILE), availableDocumentTypes: ['01', '03'],
      serverEnabled: productionWorkflowEnabled(), version: grant?.version ?? 0, credentialRevision: config.revision,
      enabled: productionWorkflowEnabled() && grant?.enabled === true && productionDocumentTypes(grant.profile).length > 0 && !!grant.registrationAttestedAt && grant.credentialRevision === config.revision && grant.certificateFingerprint === config.certificate.fingerprint,
      updatedAt: grant?.updatedAt?.toISOString() ?? null };
  }
  async configure(companyId: string, environment: string, input: unknown, authorization: string, actorId: string) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('Solicitud inválida');
    const value = input as Record<string, unknown>;
    if (Object.keys(value).some(key => !['enabled','expectedRevision','expectedVersion','registrationConfirmed','confirmation','authorizedDocumentTypes'].includes(key)) ||
      typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0 ||
      !Number.isSafeInteger(value.expectedVersion) || Number(value.expectedVersion) < 0) throw new BadRequestException('Solicitud inválida');
    const selected = value.authorizedDocumentTypes;
    if (selected !== undefined && (!Array.isArray(selected) ||
        !(JSON.stringify(selected) === '["01"]' || JSON.stringify(selected) === '["01","03"]')))
      throw new BadRequestException('Elija factura 01 o factura 01 y boleta 03 explícitamente');
    const before = await this.status(companyId, environment, authorization);
    if (before.version !== value.expectedVersion || before.credentialRevision !== value.expectedRevision) throw new ConflictException('La configuración cambió; actualice el estado');
    const report = value.enabled ? await this.readiness.inspect(companyId, environment, authorization) : undefined;
    if (value.enabled) {
      if (!productionWorkflowEnabled()) throw new ServiceUnavailableException('El servicio de despacho de producción no está habilitado en este servidor');
      if (value.registrationConfirmed !== true || value.confirmation !== PRODUCTION_CONFIRMATION) throw new BadRequestException('Confirme el registro del emisor y la activación de envíos reales');
      if (required.some(code => !report!.checks.some(check => check.code === code && check.status === 'PASS'))) throw new BadRequestException('Complete las verificaciones del emisor, certificado y credenciales');
      // Public deployment pin only. The signature and its chain are checked again on every received CDR.
      try { await loadPinnedPublicFile(process.env.SUNAT_CDR_SIGNER_CERT_FILE, process.env.SUNAT_CDR_SIGNER_CERT_SHA256); }
      catch { throw new ServiceUnavailableException('Falta configurar la confianza del firmante CDR en el servidor'); }
    }
    const config = await this.configuration.status(companyId, environment, authorization);
    if (config.revision !== value.expectedRevision || (report !== undefined && config.revision !== report.revision)) throw new ConflictException('La configuración cambió; actualice el estado');
    const fingerprint = config.certificate.fingerprint;
    if (value.enabled && (!fingerprint || !/^[a-f0-9]{64}$/i.test(fingerprint))) throw new BadRequestException('Certificado no disponible');
    await this.prisma.$transaction(async tx => {
      const credentials = await tx.sunatCredentials.findUnique({ where: { issuerRuc_environment: { issuerRuc: config.ruc, environment: 'PRODUCTION' } }, select: { revision: true, certificateFingerprint: true } });
      if ((credentials?.revision ?? 0) !== value.expectedRevision || (value.enabled && credentials?.certificateFingerprint !== fingerprint)) throw new ConflictException('La configuración cambió');
      const data = { enabled: value.enabled as boolean, credentialRevision: config.revision, certificateFingerprint: fingerprint ?? '0'.repeat(64),
        profile: value.enabled ? (Array.isArray(selected) && selected.includes('03') ? PRODUCTION_RECEIPT_PROFILE : PRODUCTION_INVOICE_PROFILE) : before.profile, actorId, registrationAttestedAt: value.enabled ? new Date() : null, version: before.version + 1 };
      if (before.version === 0) await tx.fiscalDispatchAuthorization.create({ data: { issuerRuc: config.ruc, environment: 'PRODUCTION', ...data } });
      else {
        const changed = await tx.fiscalDispatchAuthorization.updateMany({ where: { issuerRuc: config.ruc, environment: 'PRODUCTION', version: before.version }, data });
        if (changed.count !== 1) throw new ConflictException('La autorización cambió; actualice el estado');
      }
      await tx.fiscalDispatchAudit.create({ data: { issuerRuc: config.ruc, environment: 'PRODUCTION', enabled: data.enabled,
        version: data.version, credentialRevision: data.credentialRevision, actorId } });
    });
    return this.status(companyId, environment, authorization);
  }
  async admit(companyId: string, snapshot: unknown, authorization: string) {
    const config = await this.configuration.status(companyId, 'PRODUCTION', authorization);
    if (config.emissionEnvironment !== 'PRODUCTION') throw new BadRequestException('El emisor no tiene configurada la emisión en Producción');
    const candidate = snapshot as FiscalDocumentSnapshot;
    if (!candidate || String(candidate.companyId) !== companyId || candidate.issuer?.identityNumber !== config.ruc) throw new BadRequestException('Snapshot no corresponde al emisor autorizado');
    assertProductionInvoice(candidate);
    await this.assertCurrent(candidate, config.revision);
    const report = await this.readiness.inspect(companyId, 'PRODUCTION', authorization);
    if (required.some(code => !report.checks.some(check => check.code === code && check.status === 'PASS'))) throw new BadRequestException('El emisor no supera las verificaciones de emisión');
    await this.assertCurrent(candidate, config.revision);
    return { authorized: true, environment: 'PRODUCTION', issuerRuc: config.ruc, profile: candidate.documentTypeCode === '03' ? PRODUCTION_RECEIPT_PROFILE : PRODUCTION_INVOICE_PROFILE,
      documentId: candidate.documentId, snapshotSha256: fiscalSnapshotSha256(candidate) };
  }
  /** Private worker call; no client DTO or flag can supply this authority. */
  async assertCurrent(snapshot: FiscalDocumentSnapshot, expectedRevision?: number) {
    assertProductionInvoice(snapshot);
    if (!productionWorkflowEnabled()) throw new Error('Despacho de producción deshabilitado');
    const ruc = snapshot.issuer.identityNumber;
    const grant = await this.prisma.fiscalDispatchAuthorization.findUnique({ where: { issuerRuc_environment: { issuerRuc: ruc, environment: 'PRODUCTION' } } });
    const credentials = await this.prisma.sunatCredentials.findUnique({ where: { issuerRuc_environment: { issuerRuc: ruc, environment: 'PRODUCTION' } },
      select: { revision: true, certificateFingerprint: true, certificateExpiresAt: true, certificateSelfSigned: true } });
    if (!grant?.enabled || !productionDocumentTypes(grant.profile).includes(snapshot.documentTypeCode as '01' | '03') || !grant.registrationAttestedAt || !credentials ||
      credentials.certificateSelfSigned !== false || !credentials.certificateExpiresAt || credentials.certificateExpiresAt <= new Date() ||
      grant.credentialRevision !== credentials.revision || grant.certificateFingerprint !== credentials.certificateFingerprint ||
      (expectedRevision !== undefined && credentials.revision !== expectedRevision)) throw new Error('Autorización fiscal ausente, revocada o desactualizada');
  }
}
