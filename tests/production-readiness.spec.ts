import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CertificateTrustResult } from '../services/sunat-service/src/infrastructure/crypto/certificate-trust.service';
vi.mock('../services/sunat-service/src/infrastructure/prisma.service', () => ({ PrismaService: class {} }));
vi.mock('../services/sunat-service/src/application/fiscal-configuration.service', () => ({ FiscalConfigurationService: class {} }));
vi.mock('../services/sunat-service/src/infrastructure/crypto/secret-vault', () => ({ SecretVault: class {} }));
vi.mock('../services/sunat-service/src/infrastructure/crypto/certificate-inspection.service', () => ({ CertificateInspectionService: class {} }));
vi.mock('../services/sunat-service/src/infrastructure/crypto/certificate-trust.service', () => ({ CertificateTrustService: class {} }));
vi.mock('../services/sunat-service/src/infrastructure/crypto/cdr-signature-trust.service', () => ({ CdrSignatureTrustService: class {} }));
vi.mock('../services/sunat-service/src/infrastructure/sunat/xsd-validation.service', () => ({ XsdValidationService: class {} }));
import { FiscalReadinessService } from '../services/sunat-service/src/application/fiscal-readiness.service';

const RUC = '20615878481', COMPANY = '14', AUTH = 'ISOLATED_READINESS_AUTH', REVISION = 4, FP = 'a'.repeat(64);
const NOW = new Date('2026-10-28T18:00:00Z');
function fixture() {
  const config = { ruc: RUC, revision: REVISION, emissionEnvironment: 'PRODUCTION' as string | undefined, productionInvoiceAdmission: true as boolean | undefined };
  const credentials = { revision: REVISION, certificateCipher: 'MOCK_CERT_ENVELOPE' as string | null, certificatePasswordCipher: 'MOCK_CERT_PASSWORD_ENVELOPE' as string | null,
    certificateFingerprint: FP, solUsernameCipher: 'MOCK_SOL_USER_ENVELOPE' as string | null, solPasswordCipher: 'MOCK_SOL_PASSWORD_ENVELOPE' as string | null,
    greClientIdCipher: null, greClientSecretCipher: null };
  const grant = { enabled: true, profile: '01-PEN-0101-IGV18-v1', credentialRevision: REVISION, certificateFingerprint: FP, registrationAttestedAt: NOW as Date | null };
  const state = { credentials: credentials as typeof credentials | null, grant: grant as typeof grant | null };
  const configuration = { status: vi.fn(async (_id: string, _environment: string, _authorization: string) => ({ ...config })) };
  const prisma = { sunatCredentials: { findUnique: vi.fn(async (_query: unknown) => state.credentials) },
    fiscalDispatchAuthorization: { findUnique: vi.fn(async (_query: unknown) => state.grant) } };
  const opened: Buffer[] = [];
  const values: Record<string, string> = { readinessProbe: 'readiness-local-probe', solUsername: 'ISOLATED_TEST_USER', solPassword: 'ISOLATED_TEST_PASSWORD',
    certificate: 'OPAQUE_NOT_A_REAL_CERTIFICATE', certificatePassword: 'ISOLATED_P12_PASSWORD' };
  const vault = { seal: vi.fn(() => 'MOCK_PROBE_ENVELOPE'), open: vi.fn((_envelope: string, context: { ruc: string; environment: string; field: string }) => {
    const bytes = Buffer.from(values[context.field]); opened.push(bytes); return bytes;
  }) };
  const metadata = { fingerprint: FP, expiresAt: new Date('2027-10-28T18:00:00Z'), selfSigned: false, digitalSignature: true,
    certificatePem: 'MOCK_PUBLIC_CERTIFICATE', chainPems: [], subjectRucCandidates: [RUC] };
  const proof: CertificateTrustResult = { profile: 'OFFLINE-PINNED-ROOTS-CRL-v1', chainValid: true, identityMatched: true, revocation: 'VERIFIED_OFFLINE_CRL',
    trustStoreSha256: 'b'.repeat(64), certificateFingerprint: FP, checkedAt: NOW.toISOString(), blockers: [] };
  const certificates = { inspect: vi.fn(async (_bytes: Buffer, _password: string) => metadata) };
  const trust = { evaluate: vi.fn(async (_metadata: unknown, _ruc: string, _now?: Date) => proof) };
  const cdrTrust = { configured: vi.fn(async () => true) }, xsd = { configured: vi.fn(async () => true) };
  const create = (withCdr = true, withXsd = true) => new FiscalReadinessService(configuration as never, prisma as never, vault as never,
    certificates as never, trust as never, withCdr ? cdrTrust as never : undefined, withXsd ? xsd as never : undefined);
  const service = create();
  return { config, credentials, grant, state, configuration, prisma, vault, values, metadata, proof, certificates, trust, cdrTrust, xsd, opened, create, service,
    inspect: () => service.inspect(COMPANY, 'PRODUCTION', AUTH) };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); vi.stubEnv('SUNAT_PRODUCTION_WORKFLOW_ENABLED', 'true');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('NETWORK_FORBIDDEN'); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('FiscalReadinessService PRODUCTION: readiness is the intersection of current independent requirements', () => {
  it('is READY only with exact current credentials/grant, certificate trust, CDR, XSD, server opt-in and Billing admission', async () => {
    const f = fixture(), report = await f.inspect();
    expect(report).toMatchObject({ ruc: RUC, environment: 'PRODUCTION', revision: REVISION, state: 'READY', readyForProduction: true,
      fiscalTransmission: true, readyForOfficialBeta: false, readyForLocalDevelopment: false, activationImplemented: true, checkedAt: NOW.toISOString() });
    expect(report.blockers).toEqual([]); expect(report.checks.every(check => ['PASS', 'NOT_APPLICABLE'].includes(check.status))).toBe(true);
    for (const code of ['CERTIFICATE_KEY_PAIR', 'CERTIFICATE_CHAIN', 'CERTIFICATE_RUC', 'CERTIFICATE_REVOCATION', 'CDR_TRUST', 'XSD_RUNTIME',
      'EMITTER_REGISTRATION_ATTESTED', 'PRODUCTION_RUNTIME', 'OFFICIAL_ACTIVATION', 'BILLING_PRODUCTION_ADMISSION', 'EMISSION_ENVIRONMENT'])
      expect(report.checks).toContainEqual(expect.objectContaining({ code, status: 'PASS' }));
    expect(f.cdrTrust.configured).toHaveBeenCalledOnce(); expect(f.xsd.configured).toHaveBeenCalledOnce();
    expect(report.rules.coverageComplete).toBe(false);
  });
  it('resolves the authorized company before querying either production table and zeroes every opened buffer', async () => {
    const f = fixture(), report = await f.inspect();
    expect(f.configuration.status).toHaveBeenCalledExactlyOnceWith(COMPANY, 'PRODUCTION', AUTH);
    for (const read of [f.prisma.sunatCredentials.findUnique, f.prisma.fiscalDispatchAuthorization.findUnique]) {
      expect(read).toHaveBeenCalledExactlyOnceWith({ where: { issuerRuc_environment: { issuerRuc: RUC, environment: 'PRODUCTION' } } });
      expect(f.configuration.status.mock.invocationCallOrder[0]).toBeLessThan(read.mock.invocationCallOrder[0]);
    }
    for (const [, context] of f.vault.open.mock.calls) expect(context).toMatchObject({ ruc: RUC, environment: 'PRODUCTION' });
    expect(f.opened.length).toBeGreaterThan(0); for (const bytes of f.opened) expect(bytes.every(byte => byte === 0)).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/ISOLATED_TEST_PASSWORD|ISOLATED_P12_PASSWORD|MOCK_.*ENVELOPE|OPAQUE_NOT_A_REAL_CERTIFICATE/);
  });
  it.each(['certificate', 'certificate-password', 'certificate-parse', 'certificate-fingerprint', 'certificate-ruc', 'certificate-chain', 'revocation-pending', 'revocation-invalid',
    'CDR', 'XSD', 'grant-absent', 'grant-revoked', 'grant-profile', 'grant-revision', 'grant-fingerprint', 'attestation', 'SOL-user', 'SOL-password', 'vault'])(
    'cannot be ready when %s is missing, invalid or stale', async reason => {
      const f = fixture(); let blocker = '';
      switch (reason) {
        case 'certificate': f.credentials.certificateCipher = null; blocker = 'CERTIFICATE_KEY_PAIR'; break;
        case 'certificate-password': f.credentials.certificatePasswordCipher = null; blocker = 'CERTIFICATE_KEY_PAIR'; break;
        case 'certificate-parse': f.certificates.inspect.mockRejectedValueOnce(new Error('PRIVATE_CERT_DETAIL')); blocker = 'CERTIFICATE_KEY_PAIR'; break;
        case 'certificate-fingerprint': f.metadata.fingerprint = 'c'.repeat(64); blocker = 'CERTIFICATE_KEY_PAIR'; break;
        case 'certificate-ruc': f.proof.identityMatched = false; blocker = 'CERTIFICATE_RUC'; break;
        case 'certificate-chain': f.proof.chainValid = false; blocker = 'CERTIFICATE_CHAIN'; break;
        case 'revocation-pending': f.proof.revocation = 'PENDING'; blocker = 'CERTIFICATE_REVOCATION'; break;
        case 'revocation-invalid': f.proof.revocation = 'INVALID'; blocker = 'CERTIFICATE_REVOCATION'; break;
        case 'CDR': f.cdrTrust.configured.mockResolvedValueOnce(false); blocker = 'CDR_TRUST'; break;
        case 'XSD': f.xsd.configured.mockResolvedValueOnce(false); blocker = 'XSD_RUNTIME'; break;
        case 'grant-absent': f.state.grant = null; blocker = 'OFFICIAL_ACTIVATION'; break;
        case 'grant-revoked': f.grant.enabled = false; blocker = 'OFFICIAL_ACTIVATION'; break;
        case 'grant-profile': f.grant.profile = 'OTHER_PROFILE'; blocker = 'OFFICIAL_ACTIVATION'; break;
        case 'grant-revision': f.grant.credentialRevision++; blocker = 'OFFICIAL_ACTIVATION'; break;
        case 'grant-fingerprint': f.grant.certificateFingerprint = 'c'.repeat(64); blocker = 'OFFICIAL_ACTIVATION'; break;
        case 'attestation': f.grant.registrationAttestedAt = null; blocker = 'EMITTER_REGISTRATION_ATTESTED'; break;
        case 'SOL-user': f.credentials.solUsernameCipher = null; blocker = 'SOL_SECRETS_LOCAL'; break;
        case 'SOL-password': f.credentials.solPasswordCipher = null; blocker = 'SOL_SECRETS_LOCAL'; break;
        case 'vault': f.vault.seal.mockImplementationOnce(() => { throw new Error('PRIVATE_VAULT_DETAIL'); }); blocker = 'SECRET_VAULT'; break;
      }
      const report = await f.inspect();
      expect(report).toMatchObject({ state: 'BLOCKED', readyForProduction: false, fiscalTransmission: false }); expect(report.blockers).toContain(blocker);
      expect(JSON.stringify(report)).not.toMatch(/PRIVATE_CERT_DETAIL|PRIVATE_VAULT_DETAIL/);
      for (const bytes of f.opened) expect(bytes.every(byte => byte === 0)).toBe(true);
    });
  it.each(['false', '', 'TRUE', '1'])('requires the exact server flag true, got %j', async flag => {
    vi.stubEnv('SUNAT_PRODUCTION_WORKFLOW_ENABLED', flag); const report = await fixture().inspect();
    expect(report.readyForProduction).toBe(false); expect(report.fiscalTransmission).toBe(false); expect(report.blockers).toContain('PRODUCTION_RUNTIME');
  });
  it.each([false, undefined, 'true', 1])('requires exact Billing catalog capability true, got %j', async admission => {
    const f = fixture(); Object.assign(f.config, { productionInvoiceAdmission: admission });
    const report = await f.inspect(); expect(report.readyForProduction).toBe(false); expect(report.fiscalTransmission).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({ code: 'BILLING_PRODUCTION_ADMISSION', status: 'BLOCKED' }));
  });
  it.each(['BETA', undefined])('PRODUCTION credentials cannot replace emissionEnvironment=%j', async emissionEnvironment => {
    const f = fixture(); f.config.emissionEnvironment = emissionEnvironment;
    const report = await f.inspect(); expect(report.readyForProduction).toBe(false); expect(report.fiscalTransmission).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({ code: 'EMISSION_ENVIRONMENT', status: 'PENDING' }));
    expect(f.config.emissionEnvironment).toBe(emissionEnvironment);
  });
  it.each([[false, true, 'CDR_TRUST'], [true, false, 'XSD_RUNTIME'], [false, false, 'CDR_TRUST']] as const)(
    'optional dependency absence fails closed: CDR=%s XSD=%s', async (withCdr, withXsd, blocker) => {
      const f = fixture(), report = await f.create(withCdr, withXsd).inspect(COMPANY, 'PRODUCTION', AUTH);
      expect(report.readyForProduction).toBe(false); expect(report.fiscalTransmission).toBe(false); expect(report.blockers).toContain(blocker);
    });
  it('fails closed on a credential revision changed since configuration resolution before opening secrets', async () => {
    const f = fixture(); f.credentials.revision++;
    await expect(f.inspect()).rejects.toMatchObject({ status: 503 }); expect(f.vault.open).not.toHaveBeenCalled(); expect(f.vault.seal).not.toHaveBeenCalled();
  });
  it('does not treat an absent credential row at revision zero as readiness', async () => {
    const f = fixture(); f.config.revision = 0; f.state.credentials = null;
    const report = await f.inspect(); expect(report.readyForProduction).toBe(false); expect(report.blockers).toContain('CERTIFICATE_KEY_PAIR');
  });
  it('reports grant storage failure as blocked rather than inferring authorization', async () => {
    const f = fixture(); f.prisma.fiscalDispatchAuthorization.findUnique.mockRejectedValueOnce(new Error('PRIVATE_DATABASE_DETAIL'));
    const report = await f.inspect(); expect(report.readyForProduction).toBe(false); expect(report.blockers).toContain('PRODUCTION_AUTHORIZATION_STORAGE');
    expect(JSON.stringify(report)).not.toContain('PRIVATE_DATABASE_DETAIL');
  });
  it('rechecks current grant state instead of reusing an earlier READY result', async () => {
    const f = fixture(); expect((await f.inspect()).readyForProduction).toBe(true); f.grant.enabled = false;
    expect((await f.inspect()).readyForProduction).toBe(false); expect(f.prisma.fiscalDispatchAuthorization.findUnique).toHaveBeenCalledTimes(2);
  });
  it('does not open secrets or query tables if company authorization fails', async () => {
    const f = fixture(); f.configuration.status.mockRejectedValueOnce(new Error('COMPANY_NOT_AUTHORIZED'));
    await expect(f.inspect()).rejects.toThrow('COMPANY_NOT_AUTHORIZED'); expect(f.prisma.sunatCredentials.findUnique).not.toHaveBeenCalled(); expect(f.vault.open).not.toHaveBeenCalled();
  });
  it('keeps BETA blocked and never checks production grants or optional runtime configuration', async () => {
    const f = fixture(), report = await f.service.inspect(COMPANY, 'BETA', AUTH);
    expect(report).toMatchObject({ state: 'BLOCKED', readyForProduction: false, readyForOfficialBeta: false, fiscalTransmission: false, activationImplemented: false });
    expect(report.blockers).toContain('OFFICIAL_ACTIVATION'); expect(f.prisma.fiscalDispatchAuthorization.findUnique).not.toHaveBeenCalled();
    expect(f.cdrTrust.configured).not.toHaveBeenCalled(); expect(f.xsd.configured).not.toHaveBeenCalled();
  });
});
