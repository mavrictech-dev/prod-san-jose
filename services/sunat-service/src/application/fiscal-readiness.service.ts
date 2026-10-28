import { CdrSignatureTrustService } from '../infrastructure/crypto/cdr-signature-trust.service';
import { XsdValidationService } from '../infrastructure/sunat/xsd-validation.service';
import { BadRequestException, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { FISCAL_RULE_COVERAGE, FISCAL_RULE_PROFILE, FISCAL_RULES_SOURCE, isRucStructurallyValid, validateFiscalSnapshot } from '@factuez/sunat-core';
import { FiscalConfigurationService } from './fiscal-configuration.service';
import { PrismaService } from '../infrastructure/prisma.service';
import { SecretVault } from '../infrastructure/crypto/secret-vault';
import { CertificateInspectionService } from '../infrastructure/crypto/certificate-inspection.service';
import { CertificateTrustService, type CertificateTrustResult } from '../infrastructure/crypto/certificate-trust.service';

export type ReadinessCheck = { code: string; status: 'PASS' | 'BLOCKED' | 'PENDING' | 'NOT_APPLICABLE'; description: string };
export type FiscalReadinessReport = {
  ruc: string; environment: string; revision: number; checkedAt: string;
  state: 'LOCAL_ONLY' | 'BLOCKED' | 'READY'; fiscalTransmission: boolean; readyForLocalDevelopment: boolean;
  readyForOfficialBeta: false; readyForProduction: boolean; activationImplemented: boolean;
  certificateTrust: CertificateTrustResult | null; checks: ReadinessCheck[]; blockers: string[];
  rules: { profile: string; coverageComplete: false; source: typeof FISCAL_RULES_SOURCE; coverage: typeof FISCAL_RULE_COVERAGE };
};

/** No network to SUNAT, OAuth, SMTP, mutable activation flag or cross-service table access. */
@Injectable()
export class FiscalReadinessService {
  constructor(private readonly configuration: FiscalConfigurationService, private readonly prisma: PrismaService,
    private readonly vault: SecretVault, private readonly certificates: CertificateInspectionService,
    private readonly trust: CertificateTrustService, @Optional() private readonly cdrTrust?: CdrSignatureTrustService,
    @Optional() private readonly xsd?: XsdValidationService) {}

  async inspect(companyId: string, environment: string, authorization: string): Promise<FiscalReadinessReport> {
    // Resolves through scoped Billing catalog. Client cannot choose a free-form RUC.
    const configured = await this.configuration.status(companyId, environment, authorization);
    const now = new Date();
    const row = await this.prisma.sunatCredentials.findUnique({ where: { issuerRuc_environment: { issuerRuc: configured.ruc, environment: environment as 'BETA' | 'PRODUCTION' } } });
    if ((row?.revision ?? 0) !== configured.revision) throw new ServiceUnavailableException('La configuración cambió durante la revisión; consulte nuevamente');
    const fictitious = /^00\d{9}$/.test(configured.ruc) && environment === 'BETA';
    const checks: ReadinessCheck[] = [];
    const check = (code: string, status: ReadinessCheck['status'], description: string) => { checks.push({ code, status, description }); };
    check('ISSUER_REAL_RUC', isRucStructurallyValid(configured.ruc) ? 'PASS' : 'BLOCKED', fictitious
      ? 'Identificador ficticio: permitido para desarrollo, no para emisión oficial'
      : 'Sólo se verifica estructura/dígito de RUC; no autorización o padrón SUNAT');
    const context = { ruc: configured.ruc, environment };
    try {
      const encrypted = this.vault.seal('readiness-local-probe', { ...context, field: 'readinessProbe' });
      const probe = this.vault.open(encrypted, { ...context, field: 'readinessProbe' });
      try { if (probe.toString() !== 'readiness-local-probe') throw new Error(); }
      finally { probe.fill(0); }
      check('SECRET_VAULT', 'PASS', 'Bóveda disponible y sobre autenticado comprobado en memoria');
    } catch { check('SECRET_VAULT', 'BLOCKED', 'No se pudo comprobar la bóveda local de secretos'); }
    const verifySecretGroup = (fields: Array<{ field: string; cipher?: string | null; maximum: number; pattern?: RegExp }>) => {
      if (fields.some(field => !field.cipher)) return false;
      const decrypted: Buffer[] = [];
      try {
        for (const field of fields) {
          const bytes = this.vault.open(field.cipher!, { ...context, field: field.field }); decrypted.push(bytes);
          const value = bytes.toString('utf8');
          if (!Buffer.from(value).equals(bytes) || !value.length || value.length > field.maximum || /[\x00-\x1f\x7f]/.test(value) || (field.pattern && !field.pattern.test(value))) return false;
        }
        return true;
      } catch { return false; }
      finally { for (const bytes of decrypted) bytes.fill(0); }
    };
    check('SOL_SECRETS_LOCAL', verifySecretGroup([
      { field: 'solUsername', cipher: row?.solUsernameCipher, maximum: 80, pattern: /^[A-Za-z0-9._-]{3,80}$/ },
      { field: 'solPassword', cipher: row?.solPasswordCipher, maximum: 512 },
    ]) ? 'PASS' : 'BLOCKED', 'Integridad y formato local de SOL; no se ha probado autenticación con SUNAT');
    check('GRE_SECRETS_LOCAL', verifySecretGroup([
      { field: 'greClientId', cipher: row?.greClientIdCipher, maximum: 160 },
      { field: 'greClientSecret', cipher: row?.greClientSecretCipher, maximum: 512 },
    ]) ? 'PASS' : 'NOT_APPLICABLE', 'OAuth GRE independiente: requerido sólo al habilitar 09, sin solicitar tokens');
    let certificateTrust: CertificateTrustResult | null = null;
    let certificateParsed = false;
    const decrypted: Buffer[] = [];
    try {
      if (!row?.certificateCipher || !row.certificatePasswordCipher) throw new Error();
      const bytes = this.vault.open(row.certificateCipher, { ...context, field: 'certificate' }); decrypted.push(bytes);
      const password = this.vault.open(row.certificatePasswordCipher, { ...context, field: 'certificatePassword' }); decrypted.push(password);
      if (!password.length || password.length > 512 || !Buffer.from(password.toString('utf8')).equals(password)) throw new Error();
      const metadata = await this.certificates.inspect(bytes, password.toString('utf8'));
      if (metadata.fingerprint !== row.certificateFingerprint) throw new Error();
      certificateParsed = true;
      certificateTrust = await this.trust.evaluate(metadata, configured.ruc, now);
    } catch { /* Safe summary below; never return vault/Forge/OpenSSL diagnostics. */ }
    finally { for (const bytes of decrypted) bytes.fill(0); }
    check('CERTIFICATE_KEY_PAIR', certificateParsed ? 'PASS' : 'BLOCKED', 'Par PKCS#12 RSA de firma, vigencia y huella recalculados desde los bytes cifrados');
    check('CERTIFICATE_RUC', certificateTrust?.identityMatched ? 'PASS' : 'BLOCKED', 'RUC exacto en atributo de identidad del certificado; no coincidencia por texto libre o CN');
    check('CERTIFICATE_CHAIN', certificateTrust?.chainValid ? 'PASS' : 'BLOCKED', 'Cadena offline estricta hasta raíces explícitas fijadas por SHA-256; autofirmado de emisor no permitido');
    check('CERTIFICATE_REVOCATION', certificateTrust?.revocation === 'VERIFIED_OFFLINE_CRL' ? 'PASS' : certificateTrust?.revocation === 'INVALID' ? 'BLOCKED' : 'PENDING',
      'Se requiere CRL firmada/vigente para toda la cadena; ausencia/errores bloquean habilitación');
    let productionReady = false;
    if (environment === 'PRODUCTION') {
      let grant; let storageReady = true;
      try { grant = await this.prisma.fiscalDispatchAuthorization.findUnique({ where: { issuerRuc_environment: { issuerRuc: configured.ruc, environment: 'PRODUCTION' } } }); }
      catch { storageReady = false; }
      const active = grant?.enabled === true && ['01-PEN-0101-IGV18-v1', '01-03-PEN-0101-IGV18-v2'].includes(grant.profile) && !!grant.registrationAttestedAt && grant.credentialRevision === configured.revision && grant.certificateFingerprint === row?.certificateFingerprint;
      check('EMISSION_ENVIRONMENT', configured.emissionEnvironment === 'PRODUCTION' ? 'PASS' : 'PENDING', 'El ambiente de emisión de la empresa debe ser Producción; guardar credenciales no cambia el ambiente de las ventas.');
      check('FISCAL_PROFILE', 'PASS', grant?.profile === '01-03-PEN-0101-IGV18-v2' ? 'Factura 01 y boleta 03: PEN, operación 0101 e IGV 18 %. Boleta enviada mediante RC individual con evidencia propia.' : 'Factura 01: PEN, operación 0101 e IGV 18 %. Boleta 03 requiere una nueva elección y versión de autorización.');
      check('EMITTER_REGISTRATION_ATTESTED', grant?.registrationAttestedAt ? 'PASS' : 'PENDING', 'El responsable debe confirmar el registro SEE del emisor. Su declaración no sustituye una consulta oficial de SUNAT.');
      check('XSD_RUNTIME', await this.xsd?.configured() ? 'PASS' : 'BLOCKED', 'Paquete XSD fijado y validador local disponibles; cada XML se valida antes del envío.');
      check('CDR_TRUST', await this.cdrTrust?.configured() ? 'PASS' : 'BLOCKED', 'Firmante CDR, cadena y revocación verificados contra archivos de confianza del servidor.');
      check('BILLING_PRODUCTION_ADMISSION', configured.productionInvoiceAdmission === true ? 'PASS' : 'BLOCKED', 'Billing debe tener instalada y habilitada la admisión de factura 01 antes de confirmar el documento y su numeración.');
      check('PRODUCTION_RUNTIME', process.env.SUNAT_PRODUCTION_WORKFLOW_ENABLED === 'true' ? 'PASS' : 'BLOCKED', 'El servidor debe tener instalado y habilitado el servicio de despacho de Producción.');
      check('PRODUCTION_AUTHORIZATION_STORAGE', storageReady ? 'PASS' : 'BLOCKED', 'Almacenamiento de autorización por emisor disponible.');
      check('OFFICIAL_ACTIVATION', active ? 'PASS' : 'BLOCKED', 'Autorización explícita del perfil elegido ligada a la revisión actual del certificado y las credenciales.');
      productionReady = checks.every(item => item.status === 'PASS' || item.status === 'NOT_APPLICABLE');
    } else {
      check('FISCAL_RULES_COVERAGE', 'BLOCKED', 'Perfil 01/03 limitado y versionado; no se han automatizado todas las reglas del XLSX ni padrones');
      check('SUNAT_REGISTRATION', 'PENDING', 'Registro SEE, situación RUC y certificado registrado pendientes de evidencia oficial por emisor');
      check('OFFICIAL_BETA_PILOT', 'PENDING', 'El emulador local no sustituye un piloto Beta oficial ni acredita validación tributaria');
      check('OFFICIAL_ACTIVATION', 'BLOCKED', 'Despacho Beta de esta versión no habilitado');
    }
    return { ruc: configured.ruc, environment, revision: configured.revision, checkedAt: now.toISOString(),
      state: productionReady ? 'READY' : fictitious ? 'LOCAL_ONLY' : 'BLOCKED', fiscalTransmission: productionReady, readyForLocalDevelopment: fictitious,
      readyForOfficialBeta: false, readyForProduction: productionReady, activationImplemented: environment === 'PRODUCTION', certificateTrust, checks,
      blockers: checks.filter(item => item.status === 'BLOCKED' || item.status === 'PENDING').map(item => item.code),
      rules: { profile: FISCAL_RULE_PROFILE, coverageComplete: false, source: FISCAL_RULES_SOURCE, coverage: FISCAL_RULE_COVERAGE } };
  }

  async validate(companyId: string, environment: string, body: unknown, authorization: string) {
    const configured = await this.configuration.status(companyId, environment, authorization);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'snapshot') || !('snapshot' in body))
      throw new BadRequestException('Envíe únicamente un snapshot para validación sin emisión');
    const snapshot = (body as { snapshot: unknown }).snapshot;
    const mode = /^00\d{9}$/.test(configured.ruc) && environment === 'BETA' ? 'LOCAL_DEVELOPMENT' : 'REAL_PREPARATION';
    const validation = validateFiscalSnapshot(snapshot, { mode });
    const document = snapshot as { issuer?: { identityNumber?: unknown }; companyId?: unknown; environment?: unknown } | null;
    if (!document || document.issuer?.identityNumber !== configured.ruc || document.environment !== environment || (document.companyId !== undefined && String(document.companyId) !== companyId)) {
      validation.valid = false;
      validation.issues.unshift({ code: 'ISSUER_CONTEXT_MISMATCH', path: 'issuer/environment/companyId', category: 'INVALID', message: 'Snapshot no corresponde al emisor y ambiente elegidos' });
    }
    return { ...validation, mode, ruc: configured.ruc, environment, persisted: false, official: false };
  }
}

/** Version-level dispatch guard: reports/flags from a client never confer authorization. */
export function assertOfficialFiscalActivation(): never {
  throw new ServiceUnavailableException('Emisión oficial bloqueada: desarrollo local, reglas completas y habilitación oficial pendientes');
}
