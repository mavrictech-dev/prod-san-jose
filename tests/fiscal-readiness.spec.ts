import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FiscalReadinessService, assertOfficialFiscalActivation } from '../services/sunat-service/src/application/fiscal-readiness.service';

// Las dependencias son dobles de prueba. No se abre ningún certificado/secretos del usuario.
const ruc = '20615878481';
const companyId = '14';
const authorization = 'Bearer MOCK-LOCAL-AUTH';
const fingerprint = 'a'.repeat(64);

function fixture() {
  const opened: Buffer[] = [];
  const configuration = { status: vi.fn(async () => ({ ruc, revision: 1 })) };
  const row = {
    revision: 1, certificateCipher: 'MOCK_CERTIFICATE_ENVELOPE', certificatePasswordCipher: 'MOCK_CERTIFICATE_PASSWORD_ENVELOPE',
    certificateFingerprint: fingerprint, solUsernameCipher: 'MOCK_SOL_USER_ENVELOPE', solPasswordCipher: 'MOCK_SOL_PASSWORD_ENVELOPE',
    greClientIdCipher: null, greClientSecretCipher: null,
  };
  const prisma = { sunatCredentials: { findUnique: vi.fn(async () => row) } };
  const values: Record<string, string> = {
    readinessProbe: 'readiness-local-probe', solUsername: 'MOCK_QA_USER', solPassword: 'MOCK_QA_PASSWORD',
    certificate: 'MOCK_P12_BYTES_NOT_A_CERTIFICATE', certificatePassword: 'MOCK_P12_PASSWORD',
  };
  const vault = {
    seal: vi.fn(() => 'MOCK_PROBE_ENVELOPE'),
    open: vi.fn((_cipher: string, context: { field: string }) => {
      const bytes = Buffer.from(values[context.field]); opened.push(bytes); return bytes;
    }),
  };
  const metadata = {
    fingerprint, expiresAt: new Date('2030-01-01T00:00:00Z'), selfSigned: false,
    certificatePem: 'MOCK_PUBLIC_CERTIFICATE', chainPems: [], digitalSignature: true, subjectRucCandidates: [ruc],
  };
  const certificates = { inspect: vi.fn(async () => metadata) };
  const trust = { evaluate: vi.fn(async () => ({
    profile: 'OFFLINE-PINNED-ROOTS-CRL-v1' as const, chainValid: true, identityMatched: true,
    revocation: 'VERIFIED_OFFLINE_CRL' as 'VERIFIED_OFFLINE_CRL' | 'PENDING' | 'INVALID',
    trustStoreSha256: 'b'.repeat(64), certificateFingerprint: fingerprint,
    checkedAt: '2026-10-02T20:30:00Z', blockers: [] as string[],
  })) };
  const service = new FiscalReadinessService(configuration as never, prisma as never, vault as never, certificates as never, trust as never);
  const inspect = () => service.inspect(companyId, 'BETA', authorization);
  return { service, inspect, configuration, prisma, row, vault, certificates, trust, opened };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Preparación del emisor Beta: guardado no equivale a habilitación', () => {
  it('ni certificado/SOL ni confianza simulada habilitan despacho oficial', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const f = fixture();
    const report = await f.inspect();
    expect(report).toMatchObject({ ruc, environment: 'BETA', revision: 1, state: 'BLOCKED',
      fiscalTransmission: false, readyForOfficialBeta: false, readyForProduction: false, activationImplemented: false,
      rules: { coverageComplete: false } });
    expect(report.checks).toContainEqual(expect.objectContaining({ code: 'CERTIFICATE_CHAIN', status: 'PASS' }));
    expect(report.blockers).toEqual(expect.arrayContaining(['FISCAL_RULES_COVERAGE', 'SUNAT_REGISTRATION', 'OFFICIAL_BETA_PILOT', 'OFFICIAL_ACTIVATION']));
    expect(() => assertOfficialFiscalActivation()).toThrow('bloqueada');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('GRE ausente no añade bloqueo al circuito 01/03/07/08', async () => {
    const report = await fixture().inspect();
    expect(report.checks).toContainEqual(expect.objectContaining({ code: 'GRE_SECRETS_LOCAL', status: 'NOT_APPLICABLE' }));
    expect(report.blockers).not.toContain('GRE_SECRETS_LOCAL');
  });

  it('consulta únicamente el contexto autorizado y borra buffers de prueba', async () => {
    const f = fixture();
    const report = await f.inspect();
    expect(f.configuration.status).toHaveBeenCalledExactlyOnceWith(companyId, 'BETA', authorization);
    expect(f.prisma.sunatCredentials.findUnique).toHaveBeenCalledExactlyOnceWith({ where: { issuerRuc_environment: { issuerRuc: ruc, environment: 'BETA' } } });
    for (const [, context] of f.vault.open.mock.calls) expect(context).toMatchObject({ ruc, environment: 'BETA' });
    expect(f.opened.length).toBe(5);
    for (const bytes of f.opened) expect(bytes.every(byte => byte === 0)).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/MOCK_(?:P12|SOL|QA|CERTIFICATE|PROBE)/);
  });

  it('una revisión concurrente falla antes de abrir material criptográfico', async () => {
    const f = fixture(); f.row.revision = 2;
    await expect(f.inspect()).rejects.toThrow('cambió durante la revisión');
    expect(f.vault.open).not.toHaveBeenCalled(); expect(f.vault.seal).not.toHaveBeenCalled();
    expect(f.certificates.inspect).not.toHaveBeenCalled(); expect(f.trust.evaluate).not.toHaveBeenCalled();
  });

  it('una huella distinta impide evaluar confianza y conserva bloqueos', async () => {
    const f = fixture(); f.row.certificateFingerprint = 'c'.repeat(64);
    const report = await f.inspect();
    expect(f.trust.evaluate).not.toHaveBeenCalled();
    expect(report.certificateTrust).toBeNull();
    expect(report.blockers).toEqual(expect.arrayContaining(['CERTIFICATE_KEY_PAIR', 'CERTIFICATE_RUC', 'CERTIFICATE_CHAIN']));
    for (const bytes of f.opened) expect(bytes.every(byte => byte === 0)).toBe(true);
  });

  it('un error del inspector no expone detalles ni deja buffers legibles', async () => {
    const f = fixture(); f.certificates.inspect.mockRejectedValueOnce(new Error('MOCK_PRIVATE_PKCS12_DIAGNOSTIC'));
    const report = await f.inspect();
    expect(report.blockers).toContain('CERTIFICATE_KEY_PAIR');
    expect(JSON.stringify(report)).not.toContain('MOCK_PRIVATE');
    expect(f.trust.evaluate).not.toHaveBeenCalled();
    for (const bytes of f.opened) expect(bytes.every(byte => byte === 0)).toBe(true);
  });

  it.each(['PENDING', 'INVALID'] as const)('la revocación %s impide confundir carga con confianza', async revocation => {
    const f = fixture();
    f.trust.evaluate.mockResolvedValueOnce({ ...(await f.trust.evaluate()), revocation });
    f.trust.evaluate.mockClear();
    const report = await f.inspect();
    expect(report.blockers).toContain('CERTIFICATE_REVOCATION');
    expect(report.fiscalTransmission).toBe(false);
  });

  it('un certificado no vinculado al RUC bloquea identidad aunque pase la cadena', async () => {
    const f = fixture();
    f.trust.evaluate.mockResolvedValueOnce({ ...(await f.trust.evaluate()), identityMatched: false });
    f.trust.evaluate.mockClear();
    const report = await f.inspect();
    expect(report.blockers).toContain('CERTIFICATE_RUC');
    expect(report.readyForOfficialBeta).toBe(false);
  });

  it.each([
    { environment: 'PRODUCTION' }, { companyId: 'OTHER_MOCK_COMPANY' },
    { issuer: { identityNumber: '00000000000' } },
  ])('rechaza snapshot ajeno sin guardarlo (%j)', async mismatch => {
    vi.stubGlobal('fetch', vi.fn());
    const f = fixture();
    const report = await f.service.validate(companyId, 'BETA', {
      snapshot: { companyId, environment: 'BETA', issuer: { identityNumber: ruc }, ...mismatch },
    }, authorization);
    expect(report).toMatchObject({ ruc, environment: 'BETA', valid: false, persisted: false, official: false });
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'ISSUER_CONTEXT_MISMATCH' }));
    expect(f.prisma.sunatCredentials.findUnique).not.toHaveBeenCalled();
    expect(f.vault.open).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});
