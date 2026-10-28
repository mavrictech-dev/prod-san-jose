import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FiscalDocumentSnapshot } from '../packages/contracts/src';
import { calculateDocumentTotals } from '../packages/sunat-core/src/tax';
import { assertFiscalSnapshot } from '../packages/sunat-core/src/fiscal-rules';
import { fiscalSnapshotSha256 } from '../packages/sunat-core/src/fiscal-note';

// Keep REAL_PREPARATION validation real, but never instantiate runtime services.
vi.mock('@factuez/sunat-core', () => ({ assertFiscalSnapshot, fiscalSnapshotSha256 }));
vi.mock('../services/sunat-service/src/infrastructure/prisma.service', () => ({ PrismaService: class {} }));
vi.mock('../services/sunat-service/src/application/fiscal-configuration.service', () => ({ FiscalConfigurationService: class {} }));
vi.mock('../services/sunat-service/src/application/fiscal-readiness.service', () => ({ FiscalReadinessService: class {} }));
const pinned = vi.hoisted(() => vi.fn());
vi.mock('../services/sunat-service/src/infrastructure/crypto/certificate-trust.service', () => ({ loadPinnedPublicFile: pinned }));
import { ProductionDispatchPolicy, PRODUCTION_CONFIRMATION, PRODUCTION_INVOICE_PROFILE, PRODUCTION_RECEIPT_PROFILE } from '../services/sunat-service/src/application/production-dispatch-policy';

const RUC = '20615878481', COMPANY = '7', AUTH = 'isolated-authorization-placeholder', ACTOR = 'isolated-actor';
const REVISION = 4, VERSION = 2, FINGERPRINT = 'a'.repeat(64);
const NOW = new Date('2026-10-28T18:00:00Z');
const REQUIRED = ['ISSUER_REAL_RUC', 'SECRET_VAULT', 'SOL_SECRETS_LOCAL', 'CERTIFICATE_KEY_PAIR', 'CERTIFICATE_RUC', 'CERTIFICATE_CHAIN', 'CERTIFICATE_REVOCATION', 'XSD_RUNTIME', 'CDR_TRUST', 'BILLING_PRODUCTION_ADMISSION'];
function invoice(): FiscalDocumentSnapshot {
  return { documentId: '50000000-0000-4000-8000-000000000771', companyId: 7, environment: 'PRODUCTION', documentTypeCode: '01',
    series: 'F001', number: '1', fullNumber: 'F001-1', issueDate: '2026-10-28T17:00:00Z', currencyCode: 'PEN', operationTypeCode: '0101',
    issuer: { identityType: '6', identityNumber: RUC, legalName: 'ISOLATED TEST ISSUER', address: 'TEST ADDRESS', ubigeo: '150101', establishmentCode: '0000' },
    customer: { identityType: '6', identityNumber: RUC, legalName: 'ISOLATED TEST CUSTOMER' }, paymentTerms: { type: 'CONTADO' },
    ...calculateDocumentTotals([{ description: 'ISOLATED TEST ITEM', quantity: '1', unitCode: 'NIU', unitPriceWithTax: '1.18', igvRate: '18', taxAffectationCode: '10' }]) };
}
type Grant = { issuerRuc: string; environment: string; enabled: boolean; version: number; credentialRevision: number; certificateFingerprint: string;
  profile: string; registrationAttestedAt: Date | null; updatedAt: Date; actorId?: string };
type Credentials = { revision: number; certificateFingerprint: string; certificateExpiresAt: Date | null; certificateSelfSigned: boolean | null };
function fixture() {
  const state = {
    grant: { issuerRuc: RUC, environment: 'PRODUCTION', enabled: true, version: VERSION, credentialRevision: REVISION, certificateFingerprint: FINGERPRINT,
      profile: PRODUCTION_INVOICE_PROFILE, registrationAttestedAt: NOW, updatedAt: NOW } as Grant | null,
    credentials: { revision: REVISION, certificateFingerprint: FINGERPRINT, certificateExpiresAt: new Date('2027-10-28T18:00:00Z'), certificateSelfSigned: false } as Credentials | null,
    config: { emissionEnvironment: 'PRODUCTION', ruc: RUC, revision: REVISION, certificate: { fingerprint: FINGERPRINT as string | null } },
    report: { revision: REVISION, checks: REQUIRED.map(code => ({ code, status: 'PASS' })) },
  };
  const matches = (query: any) => query.where.issuerRuc_environment.issuerRuc === RUC && query.where.issuerRuc_environment.environment === 'PRODUCTION';
  const credentialsRead = vi.fn(async (query: any) => matches(query) ? state.credentials : null);
  const tx = {
    sunatCredentials: { findUnique: vi.fn(async (query: any) => matches(query) ? state.credentials : null) },
    fiscalDispatchAuthorization: {
      create: vi.fn(async ({ data }: any) => { if (state.grant) throw new Error('UNIQUE_CONFLICT'); state.grant = { ...data, updatedAt: NOW }; return state.grant; }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (!state.grant || where.issuerRuc !== RUC || where.environment !== 'PRODUCTION' || where.version !== state.grant.version) return { count: 0 };
        state.grant = { ...state.grant, ...data }; return { count: 1 };
      }),
    },
    fiscalDispatchAudit: { create: vi.fn(async ({ data }: any) => data) },
  };
  const prisma = { fiscalDispatchAuthorization: { findUnique: vi.fn(async (query: any) => matches(query) ? state.grant : null) },
    sunatCredentials: { findUnique: credentialsRead }, $transaction: vi.fn(async (run: (value: typeof tx) => Promise<void>) => run(tx)) };
  const configuration = { status: vi.fn(async (_company: string, _environment: string, _authorization: string) => structuredClone(state.config)) };
  const readiness = { inspect: vi.fn(async (_company: string, _environment: string, _authorization: string) => structuredClone(state.report)) };
  const policy = new ProductionDispatchPolicy(prisma as never, configuration as never, readiness as never);
  const input = (enabled = true) => ({ enabled, expectedRevision: REVISION, expectedVersion: state.grant?.version ?? 0,
    ...(enabled ? { registrationConfirmed: true, confirmation: PRODUCTION_CONFIRMATION } : {}) });
  const configure = (body: unknown = input()) => policy.configure(COMPANY, 'PRODUCTION', body, AUTH, ACTOR);
  return { state, prisma, tx, configuration, readiness, policy, input, configure };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  vi.stubEnv('SUNAT_PRODUCTION_WORKFLOW_ENABLED', 'true');
  vi.stubEnv('SUNAT_CDR_SIGNER_CERT_FILE', 'isolated-public-pin.pem'); vi.stubEnv('SUNAT_CDR_SIGNER_CERT_SHA256', 'b'.repeat(64));
  pinned.mockReset().mockResolvedValue(Buffer.from('ISOLATED PUBLIC PIN DOUBLE'));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('NETWORK_FORBIDDEN'); }));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('ProductionDispatchPolicy.assertCurrent: private server gate and current database authority', () => {
  it('accepts a valid REAL 01 invoice with both opt-ins and the exact credential revision/fingerprint', async () => {
    const f = fixture(); expect(() => assertFiscalSnapshot(invoice(), { mode: 'REAL_PREPARATION' })).not.toThrow();
    await expect(f.policy.assertCurrent(invoice(), REVISION)).resolves.toBeUndefined();
    for (const read of [f.prisma.fiscalDispatchAuthorization.findUnique, f.prisma.sunatCredentials.findUnique])
      expect(read).toHaveBeenCalledWith(expect.objectContaining({ where: { issuerRuc_environment: { issuerRuc: RUC, environment: 'PRODUCTION' } } }));
    expect(f.configuration.status).not.toHaveBeenCalled(); expect(f.readiness.inspect).not.toHaveBeenCalled(); expect(pinned).not.toHaveBeenCalled();
  });
  it.each(['false', '', 'TRUE', '1'])('a database grant cannot replace server opt-in %j', async flag => {
    vi.stubEnv('SUNAT_PRODUCTION_WORKFLOW_ENABLED', flag); const f = fixture();
    await expect(f.policy.assertCurrent(invoice())).rejects.toThrow(); expect(f.prisma.fiscalDispatchAuthorization.findUnique).not.toHaveBeenCalled();
  });
  it('server opt-in cannot replace an issuer grant', async () => {
    const f = fixture(); f.state.grant = null; await expect(f.policy.assertCurrent(invoice())).rejects.toThrow();
  });
  it.each(['revoked', 'profile', 'unattested', 'credential-missing', 'grant-revision', 'fingerprint', 'self-signed', 'self-signed-unknown', 'expired', 'expiry-boundary', 'expiry-missing'])('denies %s', async reason => {
    const f = fixture();
    switch (reason) {
      case 'revoked': f.state.grant!.enabled = false; break;
      case 'profile': f.state.grant!.profile = 'OTHER_PROFILE'; break;
      case 'unattested': f.state.grant!.registrationAttestedAt = null; break;
      case 'credential-missing': f.state.credentials = null; break;
      case 'grant-revision': f.state.grant!.credentialRevision++; break;
      case 'fingerprint': f.state.credentials!.certificateFingerprint = 'b'.repeat(64); break;
      case 'self-signed': f.state.credentials!.certificateSelfSigned = true; break;
      case 'self-signed-unknown': f.state.credentials!.certificateSelfSigned = null; break;
      case 'expired': f.state.credentials!.certificateExpiresAt = new Date(NOW.getTime() - 1); break;
      case 'expiry-boundary': f.state.credentials!.certificateExpiresAt = NOW; break;
      case 'expiry-missing': f.state.credentials!.certificateExpiresAt = null; break;
    }
    await expect(f.policy.assertCurrent(invoice(), REVISION)).rejects.toThrow();
  });
  it('rejects a caller revision that differs even if grant and credentials agree', async () => {
    const f = fixture(); await expect(f.policy.assertCurrent(invoice(), REVISION + 1)).rejects.toThrow();
  });
  it('re-reads revocation on the next call instead of caching authority', async () => {
    const f = fixture(); await f.policy.assertCurrent(invoice()); f.state.grant!.enabled = false;
    await expect(f.policy.assertCurrent(invoice())).rejects.toThrow(); expect(f.prisma.fiscalDispatchAuthorization.findUnique).toHaveBeenCalledTimes(2);
  });
  it('does not borrow the grant of another structurally valid RUC', async () => {
    const f = fixture(), other = invoice(); other.issuer.identityNumber = '20450819230';
    await expect(f.policy.assertCurrent(other)).rejects.toThrow();
    expect(f.prisma.fiscalDispatchAuthorization.findUnique).toHaveBeenCalledWith({ where: { issuerRuc_environment: { issuerRuc: other.issuer.identityNumber, environment: 'PRODUCTION' } } });
  });
  it.each(['BETA', '03', '07', 'missing-payment', 'invalid-ruc', 'invalid-totals', 'invalid-operation'])('rejects non-REAL/ineligible snapshot %s before database access', async change => {
    const f = fixture(), snapshot = invoice();
    if (change === 'BETA') snapshot.environment = 'BETA';
    else if (change === '03' || change === '07') snapshot.documentTypeCode = change;
    else if (change === 'missing-payment') delete snapshot.paymentTerms;
    else if (change === 'invalid-ruc') snapshot.issuer.identityNumber = '00000000000';
    else if (change === 'invalid-totals') snapshot.totals.payableAmount = '999.00';
    else snapshot.operationTypeCode = '0200';
    await expect(f.policy.assertCurrent(snapshot)).rejects.toThrow(); expect(f.prisma.fiscalDispatchAuthorization.findUnique).not.toHaveBeenCalled();
  });
});

describe('ProductionDispatchPolicy.status: scoped issuer and honest stale state', () => {
  it('resolves the authorized target RUC through configuration before looking up its grant', async () => {
    const f = fixture(), result = await f.policy.status(COMPANY, 'PRODUCTION', AUTH);
    expect(f.configuration.status).toHaveBeenCalledExactlyOnceWith(COMPANY, 'PRODUCTION', AUTH);
    expect(f.configuration.status.mock.invocationCallOrder[0]).toBeLessThan(f.prisma.fiscalDispatchAuthorization.findUnique.mock.invocationCallOrder[0]);
    expect(result).toMatchObject({ ruc: RUC, environment: 'PRODUCTION', enabled: true, serverEnabled: true, version: VERSION, credentialRevision: REVISION, supportedDocumentTypes: ['01'] });
    expect(result).not.toHaveProperty('certificateFingerprint');
  });
  it('cannot query grants for an unauthorized company', async () => {
    const f = fixture(); f.configuration.status.mockRejectedValueOnce(new Error('NOT_AUTHORIZED'));
    await expect(f.policy.status(COMPANY, 'PRODUCTION', AUTH)).rejects.toThrow('NOT_AUTHORIZED'); expect(f.prisma.fiscalDispatchAuthorization.findUnique).not.toHaveBeenCalled();
  });
  it.each(['revision', 'fingerprint', 'server-disabled', 'revoked', 'absent'])('reports enabled false for %s', async reason => {
    const f = fixture();
    if (reason === 'revision') f.state.config.revision++;
    if (reason === 'fingerprint') f.state.config.certificate.fingerprint = 'b'.repeat(64);
    if (reason === 'server-disabled') vi.stubEnv('SUNAT_PRODUCTION_WORKFLOW_ENABLED', 'false');
    if (reason === 'revoked') f.state.grant!.enabled = false;
    if (reason === 'absent') f.state.grant = null;
    expect(await f.policy.status(COMPANY, 'PRODUCTION', AUTH)).toMatchObject({ enabled: false });
  });
  it('rejects BETA before resolving a company', async () => {
    const f = fixture(); await expect(f.policy.status(COMPANY, 'BETA', AUTH)).rejects.toMatchObject({ status: 400 }); expect(f.configuration.status).not.toHaveBeenCalled();
  });
  it('reports unavailable storage without reflecting private database details', async () => {
    const f = fixture(); f.prisma.fiscalDispatchAuthorization.findUnique.mockRejectedValueOnce(new Error('PRIVATE_DATABASE_DETAIL'));
    await expect(f.policy.status(COMPANY, 'PRODUCTION', AUTH)).rejects.toMatchObject({ status: 503 });
  });
});

describe('ProductionDispatchPolicy.configure: validation, CAS, readiness and revocation', () => {
  it.each([null, undefined, [], 'true', {}, { enabled: true }, { enabled: 'false', expectedRevision: 4, expectedVersion: 2 },
    { enabled: true, expectedRevision: -1, expectedVersion: 2 }, { enabled: false, expectedRevision: 4.5, expectedVersion: 2 },
    { enabled: false, expectedRevision: 4, expectedVersion: '2' }, { enabled: false, expectedRevision: 4, expectedVersion: -1 },
    { enabled: false, expectedRevision: 4, expectedVersion: 2, serverEnabled: true }])('rejects invalid body %# without reads or writes', async body => {
    const f = fixture(); await expect(f.policy.configure(COMPANY, 'PRODUCTION', body, AUTH, ACTOR)).rejects.toMatchObject({ status: 400 });
    expect(f.configuration.status).not.toHaveBeenCalled(); expect(f.readiness.inspect).not.toHaveBeenCalled(); expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it.each(['expectedVersion', 'expectedRevision'])('rejects stale %s before readiness or writes', async field => {
    const f = fixture(); await expect(f.configure({ ...f.input(), [field]: 99 })).rejects.toMatchObject({ status: 409 });
    expect(f.readiness.inspect).not.toHaveBeenCalled(); expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it.each(REQUIRED)('cannot enable without a passing %s check', async code => {
    const f = fixture(); f.state.report.checks = f.state.report.checks.filter(check => check.code !== code);
    await expect(f.configure()).rejects.toMatchObject({ status: 400 }); expect(f.prisma.$transaction).not.toHaveBeenCalled(); expect(pinned).not.toHaveBeenCalled();
  });
  it.each(['BLOCKED', 'PENDING', 'FAIL'])('a non-PASS readiness result %s cannot authorize dispatch', async status => {
    const f = fixture(); f.state.report.checks[0].status = status;
    await expect(f.configure()).rejects.toMatchObject({ status: 400 }); expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it.each([{ registrationConfirmed: false }, { confirmation: 'ACTIVATE' }, { confirmation: undefined }])('requires explicit enablement confirmations %#', async change => {
    const f = fixture(); await expect(f.configure({ ...f.input(), ...change })).rejects.toMatchObject({ status: 400 }); expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it('cannot enable using only database intent while the server gate is off', async () => {
    vi.stubEnv('SUNAT_PRODUCTION_WORKFLOW_ENABLED', 'false'); const f = fixture();
    await expect(f.configure()).rejects.toMatchObject({ status: 503 }); expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it('requires the public CDR signer pin without opening a real file', async () => {
    const f = fixture(); pinned.mockRejectedValueOnce(new Error('NO_PIN'));
    await expect(f.configure()).rejects.toMatchObject({ status: 503 }); expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it('enables and audits only with the current credential revision and compare-and-swap grant version', async () => {
    const f = fixture(); expect(await f.configure()).toMatchObject({ enabled: true, version: VERSION + 1 });
    expect(pinned).toHaveBeenCalledExactlyOnceWith('isolated-public-pin.pem', 'b'.repeat(64));
    expect(f.tx.fiscalDispatchAuthorization.updateMany).toHaveBeenCalledExactlyOnceWith({ where: { issuerRuc: RUC, environment: 'PRODUCTION', version: VERSION },
      data: { enabled: true, credentialRevision: REVISION, certificateFingerprint: FINGERPRINT, profile: PRODUCTION_INVOICE_PROFILE, actorId: ACTOR, registrationAttestedAt: NOW, version: VERSION + 1 } });
    expect(f.tx.fiscalDispatchAudit.create).toHaveBeenCalledExactlyOnceWith({ data: { issuerRuc: RUC, environment: 'PRODUCTION', enabled: true, version: VERSION + 1, credentialRevision: REVISION, actorId: ACTOR } });
  });
  it('creates the first grant at version one rather than pretending an update won CAS', async () => {
    const f = fixture(); f.state.grant = null; expect(await f.configure()).toMatchObject({ enabled: true, version: 1 });
    expect(f.tx.fiscalDispatchAuthorization.create).toHaveBeenCalledOnce(); expect(f.tx.fiscalDispatchAuthorization.updateMany).not.toHaveBeenCalled();
  });
  it.each(['readiness-revision', 'configuration-revision', 'database-revision', 'database-fingerprint', 'lost-grant-cas'])('rejects concurrent change %s without auditing success', async reason => {
    const f = fixture();
    if (reason === 'readiness-revision') f.state.report.revision++;
    if (reason === 'configuration-revision') f.configuration.status.mockResolvedValueOnce(structuredClone(f.state.config)).mockResolvedValueOnce({ ...f.state.config, revision: REVISION + 1 });
    if (reason === 'database-revision') f.state.credentials!.revision++;
    if (reason === 'database-fingerprint') f.state.credentials!.certificateFingerprint = 'b'.repeat(64);
    if (reason === 'lost-grant-cas') f.tx.fiscalDispatchAuthorization.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(f.configure()).rejects.toMatchObject({ status: 409 }); expect(f.tx.fiscalDispatchAudit.create).not.toHaveBeenCalled();
  });
  it('can disable with the server gate off, no confirmations, failed checks and no public pin', async () => {
    const f = fixture(); vi.stubEnv('SUNAT_PRODUCTION_WORKFLOW_ENABLED', 'false'); f.state.report.checks = []; f.state.config.certificate.fingerprint = null;
    pinned.mockRejectedValue(new Error('PIN_UNAVAILABLE'));
    expect(await f.configure(f.input(false))).toMatchObject({ enabled: false, version: VERSION + 1 });
    expect(pinned).not.toHaveBeenCalled(); expect(f.tx.fiscalDispatchAudit.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ enabled: false }) }));
  });
  it('can revoke after credentials were removed without requiring a certificate or confirmation', async () => {
    const f = fixture(); f.state.credentials = null; f.state.config.revision = 0; f.state.config.certificate.fingerprint = null;
    f.state.report.revision = 0; f.state.report.checks = [];
    await expect(f.configure({ enabled: false, expectedRevision: 0, expectedVersion: VERSION })).resolves.toMatchObject({ enabled: false, version: VERSION + 1 });
    expect(f.tx.fiscalDispatchAuthorization.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ enabled: false, credentialRevision: 0, registrationAttestedAt: null }) }));
    expect(pinned).not.toHaveBeenCalled();
  });
  it('can revoke even when readiness itself is unavailable', async () => {
    const f = fixture(); vi.stubEnv('SUNAT_PRODUCTION_WORKFLOW_ENABLED', 'false');
    f.readiness.inspect.mockRejectedValueOnce(new Error('READINESS_UNAVAILABLE'));
    await expect(f.configure(f.input(false))).resolves.toMatchObject({ enabled: false, version: VERSION + 1 });
    expect(pinned).not.toHaveBeenCalled();
  });
});

function receipt() { const snapshot = invoice(); return { ...snapshot, documentTypeCode: '03', series: 'B001', fullNumber: 'B001-1' }; }
describe('Production receipt profile: explicit new human selection, no automatic grant expansion', () => {
  it('v1 still authorizes 01 and cannot authorize valid 03', async () => {
    const f = fixture(); await expect(f.policy.assertCurrent(invoice())).resolves.toBeUndefined();
    await expect(f.policy.assertCurrent(receipt())).rejects.toThrow('Autorización');
  });
  it('explicit 01/03 selection stores v2 with a new CAS version and authorizes both documents', async () => {
    const f = fixture(); expect(await f.configure({ ...f.input(), authorizedDocumentTypes: ['01', '03'] }))
      .toMatchObject({ profile: PRODUCTION_RECEIPT_PROFILE, supportedDocumentTypes: ['01', '03'], version: VERSION + 1 });
    await expect(f.policy.assertCurrent(receipt(), REVISION)).resolves.toBeUndefined();
    await expect(f.policy.assertCurrent(invoice(), REVISION)).resolves.toBeUndefined();
    expect(await f.policy.admit(COMPANY, receipt(), AUTH)).toEqual({ authorized: true, environment: 'PRODUCTION', issuerRuc: RUC,
      profile: PRODUCTION_RECEIPT_PROFILE, documentId: receipt().documentId, snapshotSha256: fiscalSnapshotSha256(receipt()) });
    expect(await f.policy.admit(COMPANY, invoice(), AUTH)).toEqual({ authorized: true, environment: 'PRODUCTION', issuerRuc: RUC,
      profile: PRODUCTION_INVOICE_PROFILE, documentId: invoice().documentId, snapshotSha256: fiscalSnapshotSha256(invoice()) });
  });
  it.each([undefined, ['01']])('old clients or explicit 01 never broaden authority: %j', async selected => {
    const f = fixture(); await f.configure({ ...f.input(), ...(selected ? { authorizedDocumentTypes: selected } : {}) });
    expect(f.state.grant!.profile).toBe(PRODUCTION_INVOICE_PROFILE); await expect(f.policy.assertCurrent(receipt())).rejects.toThrow();
  });
  it.each([[], ['03'], ['01', '03', '07'], ['01', '03', '03'], ['03', '01'], '03', null])('rejects invalid scope %j before writing', async selected => {
    const f = fixture(); await expect(f.configure({ ...f.input(), authorizedDocumentTypes: selected })).rejects.toMatchObject({ status: 400 });
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it('rechecks revision and revocation for 03 and preserves scope on suspension', async () => {
    const f = fixture(); await f.configure({ ...f.input(), authorizedDocumentTypes: ['01', '03'] });
    f.state.credentials!.revision++; await expect(f.policy.assertCurrent(receipt())).rejects.toThrow(); f.state.credentials!.revision--;
    await f.configure(f.input(false)); expect(f.state.grant!.profile).toBe(PRODUCTION_RECEIPT_PROFILE);
    await expect(f.policy.assertCurrent(receipt())).rejects.toThrow();
  });
});
