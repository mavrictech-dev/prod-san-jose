import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IssueDocumentService, type IssueDocumentInput } from '../services/billing-service/src/application/issue-document.service';
import { DocumentsController } from '../services/billing-service/src/documents.controller';
import { IssuanceQueryService } from '../services/billing-service/src/application/issuance-query.service';
import { StationAdminService } from '../services/billing-service/src/application/station-admin.service';
import { StationsController } from '../services/billing-service/src/stations.controller';
import { REQUIRED_PERMISSIONS_KEY } from '../services/billing-service/src/auth/jwt-permission.guard';
import { PermissionCodes } from '../packages/contracts/src';
import { fiscalSnapshotSha256 } from '../packages/sunat-core/src/fiscal-note';

// Exercise the actual fiscal rules and canonical digest; replace only transport/persistence.
vi.mock('@factuez/sunat-core', async () => ({
  ...await import('../packages/sunat-core/src/tax'),
  ...await import('../packages/sunat-core/src/fiscal-rules'),
  ...await import('../packages/sunat-core/src/fiscal-note'),
}));
const BRANCH = '10000000-0000-4000-8000-000000000001', POINT = '20000000-0000-4000-8000-000000000001';
const SERIES = '40000000-0000-4000-8000-000000000001', ACTOR = '30000000-0000-4000-8000-000000000001';
const RUC = '20615878481', AUTH = 'Bearer SYNTHETIC.NOT.A.CREDENTIAL';
const request = () => ({ headers: { authorization: AUTH }, user: { sub: ACTOR, scope: { kind: 'GLOBAL' }, roles: ['ADMIN'], permissions: [PermissionCodes.SETUP_MANAGE, PermissionCodes.SUNAT_CONFIGURE, PermissionCodes.DOCUMENT_ISSUE] } } as any);
const transition = () => ({ expectedRevision: 1, environment: 'PRODUCTION', confirmation: 'CAMBIAR EMISOR A PRODUCCIÓN' });
const input = (): IssueDocumentInput => ({ emissionPointId: POINT, documentType: 'INVOICE', series: 'F001', issueDate: '2026-10-28T17:00:00Z',
  currencyCode: 'PEN', paymentTerms: { type: 'CONTADO' }, customer: { identityType: '6', identityNumber: RUC, legalName: 'SYNTHETIC CUSTOMER' },
  lines: [{ description: 'SYNTHETIC ITEM', unitCode: 'NIU', quantity: '1', unitPriceWithTax: '1.18', taxAffectationCode: '10', igvRate: '18' }] });
function proof(snapshot: any) {
  return { authorized: true, environment: 'PRODUCTION', issuerRuc: snapshot.issuer.identityNumber, snapshotSha256: fiscalSnapshotSha256(snapshot), documentId: snapshot.documentId, profile: '01-PEN-0101-IGV18-v1' };
}

function fixture(environment = 'PRODUCTION') {
  const state: any = {
    companySettings: [{ id: 7, ruc: RUC, legalName: 'SYNTHETIC ISSUER', environment, active: true, configVersion: 1, taxAddress: 'TEST ADDRESS', ubigeo: '150101', tradeName: null }],
    branch: [{ id: BRANCH, companyId: 7, active: true, name: 'SYNTHETIC BRANCH', address: 'TEST ADDRESS', establishmentCode: '0000' }],
    emissionPoint: [{ id: POINT, companyId: 7, branchId: BRANCH, active: true, code: 'CAJA01', name: 'SYNTHETIC POINT' }],
    seriesCounter: [{ id: SERIES, companyId: 7, emissionPointId: POINT, active: true, series: 'F001', documentType: 'INVOICE', nextNumber: 1n }],
    document: [], outboxEvent: [], idempotencyRecord: [], configurationAudit: [], dailySummary: [],
  };
  let inTransaction = false;
  function matches(row: any, where: any = {}): boolean {
    return Object.entries(where).every(([key, value]: any) => {
      if (key === 'OR') return value.some((part: any) => matches(row, part));
      if (key === 'companyId_documentType_series') return matches(row, value);
      if (key === 'payload' && value?.path) return value.path.reduce((target: any, part: string) => target?.[part], row.payload) === value.equals;
      if (value && typeof value === 'object' && 'not' in value) return row[key] !== value.not;
      if (value && typeof value === 'object' && 'in' in value) return value.in.includes(row[key]);
      return row[key] === value;
    });
  }
  const tx: any = { $queryRawUnsafe: vi.fn(async (sql: string) => sql.startsWith('SELECT "companyId"') ? [{ companyId: 7, branchId: BRANCH }] : []) };
  for (const name of Object.keys(state)) {
    const find = (where: any) => state[name].find((row: any) => matches(row, where));
    tx[name] = {
      findUnique: vi.fn(async ({ where, include }: any) => { const row = find(where); return row ? structuredClone(include?.branch ? { ...row, branch: state.branch.find((b: any) => b.id === row.branchId) } : row) : null; }),
      findUniqueOrThrow: vi.fn(async ({ where }: any) => { const row = find(where); if (!row) throw { code: 'P2025' }; return structuredClone(row); }),
      findMany: vi.fn(async ({ where }: any) => structuredClone(state[name].filter((row: any) => matches(row, where)))),
      count: vi.fn(async ({ where }: any) => state[name].filter((row: any) => matches(row, where)).length),
      create: vi.fn(async ({ data }: any) => { const row = structuredClone(data); state[name].push(row); return structuredClone(row); }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = find(where); if (!row) throw { code: 'P2025' };
        for (const [key, value] of Object.entries(data) as any) row[key] = value && typeof value === 'object' && 'increment' in value ? row[key] + (typeof row[key] === 'bigint' ? BigInt(value.increment) : value.increment) : value;
        return structuredClone(row);
      }),
    };
  }
  const prisma: any = { $transaction: vi.fn(async (work: any) => {
    const before = structuredClone(state); inTransaction = true;
    try { return await work(tx); }
    catch (error) { Object.assign(state, before); throw error; }
    finally { inTransaction = false; }
  }) };
  const service = new IssueDocumentService(prisma), admin = new StationAdminService(prisma);
  const context = () => ({ idempotencyKey: ACTOR + ':SYNTHETIC_KEY', userId: ACTOR, correlationId: 'SYNTHETIC_CORRELATION', scope: { kind: 'GLOBAL' as const }, authorization: AUTH });
  const admit = (reply: (snapshot: any) => Response | Promise<Response> = snapshot => Response.json(proof(snapshot))) => {
    const transport = vi.fn(async (_url: string, options: RequestInit) => {
      expect(inTransaction).toBe(true);
      expect(tx.document.create).not.toHaveBeenCalled(); expect(tx.seriesCounter.update).not.toHaveBeenCalled();
      return reply(JSON.parse(options.body as string).snapshot);
    });
    vi.stubGlobal('fetch', transport); return transport;
  };
  return { state, tx, prisma, service, admin, context, admit };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-28T18:00:00Z'));
  vi.stubEnv('BILLING_PRODUCTION_ISSUANCE_ENABLED', 'true'); vi.stubEnv('STATION_MASTER_CRUD_ENABLED', 'true');
  vi.stubEnv('SUNAT_INTERNAL_URL', 'http://sunat-service:3003');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected real transport'); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function unchanged(f: ReturnType<typeof fixture>) {
  expect(f.state.seriesCounter[0].nextNumber).toBe(1n);
  for (const table of ['document', 'outboxEvent', 'idempotencyRecord']) expect(f.state[table]).toEqual([]);
}

describe('Billing production admission: real fiscal validation, synthetic transport', () => {
  it('POSTs exactly {snapshot} inside the transaction before numbering, then commits document/outbox/idempotency', async () => {
    const f = fixture(), transport = f.admit();
    const result = await f.service.execute(input(), f.context());
    expect(result.number).toBe(1n); expect(f.state.seriesCounter[0].nextNumber).toBe(2n);
    expect(f.state.document).toHaveLength(1); expect(f.state.outboxEvent).toHaveLength(1); expect(f.state.idempotencyRecord).toHaveLength(1);
    const [url, options] = transport.mock.calls[0];
    expect(url).toBe('http://sunat-service:3003/api/v1/setup/sunat/7/PRODUCTION/admission');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: AUTH, 'Content-Type': 'application/json', Accept: 'application/json' } });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(JSON.parse(options.body as string))).toEqual(['snapshot']);
    expect(JSON.parse(options.body as string).snapshot).toEqual(result.immutableSnapshot);
    expect(f.state.outboxEvent[0].payload.payload).toEqual(result.immutableSnapshot);
    expect(JSON.stringify(f.state, (_key, value) => typeof value === 'bigint' ? value.toString() : value)).not.toContain(AUTH);
    expect(f.prisma.$transaction.mock.calls[0][1]).toEqual({ timeout: 25_000 });
    const locks = f.tx.$queryRawUnsafe.mock.calls.map((call: any[]) => call[0]);
    expect(locks.slice(1).map((sql: string) => sql.match(/FROM "(\w+)"/)![1])).toEqual(['CompanySettings', 'Branch', 'EmissionPoint', 'SeriesCounter']);
  });
  it('admits a boleta only with the explicit 01/03 v2 profile before consuming its number', async () => {
    const f=fixture(),body=input();body.documentType='SALES_RECEIPT';body.series='B001';
    f.state.seriesCounter[0].series='B001';f.state.seriesCounter[0].documentType='SALES_RECEIPT';
    const transport=f.admit(snapshot=>Response.json({...proof(snapshot),profile:'01-03-PEN-0101-IGV18-v2'}));
    const result=await f.service.execute(body,f.context());
    expect(result.immutableSnapshot.documentTypeCode).toBe('03');expect(result.immutableSnapshot.issuer.establishmentCode).toBe('0000');
    expect(f.state.seriesCounter[0].nextNumber).toBe(2n);expect(transport).toHaveBeenCalledOnce();
  });
  it('an invoice-only authorization cannot admit a boleta and never consumes its number', async () => {
    const f=fixture(),body=input();body.documentType='SALES_RECEIPT';body.series='B001';
    f.state.seriesCounter[0].series='B001';f.state.seriesCounter[0].documentType='SALES_RECEIPT';
    const transport=f.admit();await expect(f.service.execute(body,f.context())).rejects.toThrow('admisión fiscal válida');
    unchanged(f);expect(transport).toHaveBeenCalledOnce();
  });
  it('Beta is unchanged: no admission, no Authorization required, ordinary transaction with flag off', async () => {
    vi.stubEnv('BILLING_PRODUCTION_ISSUANCE_ENABLED', 'false'); vi.stubEnv('STATION_MASTER_CRUD_ENABLED', 'false');
    const f = fixture('BETA'), context = { ...f.context(), authorization: undefined };
    const result = await f.service.execute(input(), context);
    expect(result.immutableSnapshot.environment).toBe('BETA'); expect(f.state.seriesCounter[0].nextNumber).toBe(2n);
    expect(fetch).not.toHaveBeenCalled(); expect(f.prisma.$transaction.mock.calls[0]).toHaveLength(1);
  });
  it.each(['false', '', 'TRUE', '1'])('requires the exact server flag value, rejects %j without numbering or transport', async flag => {
    vi.stubEnv('BILLING_PRODUCTION_ISSUANCE_ENABLED', flag); const f = fixture();
    await expect(f.service.execute(input(), f.context())).rejects.toThrow('producción bloqueada');
    unchanged(f); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['USD', 'B2B', 'unknown-environment', 'inactive', 'no-authorization', 'array-authorization'])('rejects ineligible production %s before POST', async reason => {
    const f = fixture(), body = input(), context: any = f.context();
    if (reason === 'USD') body.currencyCode = 'USD';
    if (reason === 'unknown-environment') f.state.companySettings[0].environment = 'OTHER';
    if (reason === 'inactive') f.state.companySettings[0].active = false;
    if (reason === 'no-authorization') delete context.authorization;
    if (reason === 'array-authorization') context.authorization = [AUTH];
    if (reason === 'B2B') {
      context.userId = null; context.scope = { kind: 'ASSIGNED', branchIds: [BRANCH], emissionPointIds: [POINT], series: [SERIES] };
      context.b2b = { draftId: ACTOR, actor: { kind: 'SERVICE', clientId: ACTOR, revision: 1, subjectId: null, userAuthRevision: null }, binding: { issuerId: 7, issuerRuc: RUC, environment: 'BETA', branchId: BRANCH, pointId: POINT, seriesId: SERIES, documentType: '01' } };
    }
    await expect(f.service.execute(body, context)).rejects.toThrow(); unchanged(f); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['synthetic-ruc', 'invalid-customer-ruc', 'invalid-establishment', 'future-date', 'invalid-series', 'invalid-payment', 'exhausted'])('REAL rules reject %s before POST and number allocation', async reason => {
    const f = fixture(), body = input();
    if (reason === 'synthetic-ruc') f.state.companySettings[0].ruc = '00000000000';
    if (reason === 'invalid-customer-ruc') body.customer.identityNumber = '20123456789';
    if (reason === 'invalid-establishment') f.state.branch[0].establishmentCode = 'CAJA01';
    if (reason === 'future-date') body.issueDate = '2030-01-01T00:00:00Z';
    if (reason === 'invalid-series') { body.series = 'B001'; f.state.seriesCounter[0].series = 'B001'; }
    if (reason === 'invalid-payment') delete body.paymentTerms;
    if (reason === 'exhausted') f.state.seriesCounter[0].nextNumber = 100000000n;
    const before = f.state.seriesCounter[0].nextNumber;
    await expect(f.service.execute(body, f.context())).rejects.toThrow();
    expect(f.state.seriesCounter[0].nextNumber).toBe(before); expect(f.tx.seriesCounter.update).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['authorized', 'environment', 'issuerRuc', 'snapshotSha256', 'documentId', 'profile', 'missing', 'extra', 'null', 'array'])('rejects mismatched/non-exact attestation: %s', async change => {
    const f = fixture(); f.admit(snapshot => {
      const p: any = proof(snapshot);
      if (change === 'missing') delete p.profile;
      else if (change === 'extra') p.credentialRevision = 4;
      else if (change === 'null') return Response.json(null);
      else if (change === 'array') return Response.json([p]);
      else p[change] = change === 'authorized' ? 'true' : 'MISMATCH';
      return Response.json(p);
    });
    await expect(f.service.execute(input(), f.context())).rejects.toThrow('admisión fiscal válida'); unchanged(f);
    expect(f.tx.seriesCounter.update).not.toHaveBeenCalled(); expect(f.tx.document.create).not.toHaveBeenCalled();
  });
  it.each([201, 202, 204, 302, 400, 401, 403, 500, 503])('requires HTTP 200, rejects %i', async status => {
    const f = fixture(); f.admit(() => new Response(null, { status, headers: { 'Content-Type': 'application/json', Location: 'https://never-contact.invalid' } }));
    await expect(f.service.execute(input(), f.context())).rejects.toThrow('admisión fiscal válida'); unchanged(f);
  });
  it.each(['html', 'malformed', 'declared-oversize', 'stream-oversize', 'invalid-utf8', 'network'])('fails closed on %s', async mode => {
    const f = fixture(); f.admit(() => {
      if (mode === 'network') throw new Error('SYNTHETIC failure: never expose upstream text');
      if (mode === 'html') return new Response('<html>not json</html>');
      if (mode === 'declared-oversize') return new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '4097' } });
      if (mode === 'stream-oversize') return new Response(' '.repeat(4097), { headers: { 'Content-Type': 'application/json' } });
      if (mode === 'invalid-utf8') return new Response(new Uint8Array([255]), { headers: { 'Content-Type': 'application/json' } });
      return new Response('{', { headers: { 'Content-Type': 'application/json' } });
    });
    await expect(f.service.execute(input(), f.context())).rejects.toThrow('admisión fiscal válida'); unchanged(f);
  });
  it.each(['headers', 'body'])('15s deadline also bounds a stalled %s', async stage => {
    const f = fixture();
    if (stage === 'headers') f.admit(() => new Promise(() => {}));
    else f.admit(() => new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'application/json' } }));
    const pending = expect(f.service.execute(input(), f.context())).rejects.toThrow('admisión fiscal válida');
    await vi.advanceTimersByTimeAsync(15_001); await pending; unchanged(f);
  });
  it.each(['document', 'outboxEvent', 'idempotencyRecord'])('rolls back numbering and all writes if %s fails after valid admission', async table => {
    const f = fixture(); f.admit(); f.tx[table].create.mockRejectedValueOnce(new Error('SYNTHETIC persistence failure'));
    await expect(f.service.execute(input(), f.context())).rejects.toThrow('persistence failure'); unchanged(f);
  });
  it('idempotent replay returns the existing document without a second admission or counter increment', async () => {
    const f = fixture(), transport = f.admit(); const first = await f.service.execute(input(), f.context());
    const replay = await f.service.execute(input(), f.context());
    expect(replay.id).toBe(first.id); expect(transport).toHaveBeenCalledTimes(1); expect(f.state.seriesCounter[0].nextNumber).toBe(2n);
  });
  it('controller forwards only the string Authorization header and keeps document.issue permission', async () => {
    const execute = vi.fn().mockResolvedValue({ id: ACTOR, companyId: 7, immutableSnapshot: { issuer: { identityNumber: RUC } }, fullNumber: 'F001-1', sunatStatus: 'QUEUED' });
    const controller = new DocumentsController({ execute } as never, {} as never);
    await controller.issue(input(), 'SYNTHETIC', request());
    expect(execute.mock.calls[0][1].authorization).toBe(AUTH);
    const req = request(); req.headers.authorization = [AUTH]; await controller.issue(input(), 'SYNTHETIC', req);
    expect(execute.mock.calls[1][1].authorization).toBeUndefined();
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, DocumentsController.prototype.issue)).toEqual([PermissionCodes.DOCUMENT_ISSUE]);
  });
});

describe('Empty issuer production transition and quiet catalogue capability', () => {
  it('changes only environment/revision with ordered locks, CAS and atomic audit; never resets a series', async () => {
    const f = fixture('BETA');
    const result = await new StationsController(f.admin).configureEnvironment('7', transition(), request());
    expect(result).toEqual({ id: 7, ruc: RUC, environment: 'PRODUCTION', revision: 2 });
    expect(f.tx.companySettings.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 7, configVersion: 1, environment: 'BETA' }, data: { environment: 'PRODUCTION', configVersion: { increment: 1 } } }));
    expect(f.state.configurationAudit[0]).toMatchObject({ action: 'issuer.environment.changed', actorId: ACTOR, metadata: { companyId: 7, issuerRuc: RUC, environment: 'PRODUCTION', previousEnvironment: 'BETA', changedFields: ['environment'] } });
    expect(f.tx.$queryRawUnsafe.mock.calls.map((call: any[]) => call[0].match(/FROM "(\w+)"/)![1])).toEqual(['CompanySettings', 'Branch', 'EmissionPoint', 'SeriesCounter']);
    expect(f.tx.$queryRawUnsafe.mock.calls.every((call: any[]) => call[0].includes('FOR UPDATE') && call[1] === 7)).toBe(true);
    expect(f.tx.seriesCounter.update).not.toHaveBeenCalled(); unchanged(f); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['no-user', 'not-admin', 'assigned', 'no-setup', 'no-sunat', 'flag', 'crud-flag'])('rejects unauthorized transition %s before opening a transaction', async reason => {
    const f = fixture('BETA'), req = request();
    if (reason === 'no-user') delete req.user;
    if (reason === 'not-admin') req.user.roles = ['CASHIER'];
    if (reason === 'assigned') req.user.scope = { kind: 'ASSIGNED', branchIds: [BRANCH], emissionPointIds: [POINT], series: [SERIES] };
    if (reason === 'no-setup') req.user.permissions = [PermissionCodes.SUNAT_CONFIGURE];
    if (reason === 'no-sunat') req.user.permissions = [PermissionCodes.SETUP_MANAGE];
    if (reason === 'flag') vi.stubEnv('BILLING_PRODUCTION_ISSUANCE_ENABLED', 'false');
    if (reason === 'crud-flag') vi.stubEnv('STATION_MASTER_CRUD_ENABLED', 'false');
    await expect(f.admin.configureEnvironment('7', transition(), req)).rejects.toThrow(); expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it.each(['document', 'summary', 'outbox', 'outbox-ruc', 'published-outbox', 'consumed', 'invalid-counter', 'production', 'inactive', 'revision', 'audit', 'cas'])('preserves issuer and history on %s', async reason => {
    const f = fixture('BETA'), body = transition();
    if (reason === 'document') f.state.document.push({ companyId: 7, id: ACTOR });
    if (reason === 'summary') f.state.dailySummary.push({ companyId: 7 });
    if (reason === 'outbox' || reason === 'published-outbox') f.state.outboxEvent.push({ publishedAt: reason === 'published-outbox' ? new Date() : null, payload: { payload: { companyId: 7 } } });
    if (reason === 'outbox-ruc') f.state.outboxEvent.push({ payload: { payload: { issuer: { identityNumber: RUC } } } });
    if (reason === 'consumed') f.state.seriesCounter[0].nextNumber = 2n;
    if (reason === 'invalid-counter') f.state.seriesCounter[0].nextNumber = 0n;
    if (reason === 'production') f.state.companySettings[0].environment = 'PRODUCTION';
    if (reason === 'inactive') f.state.companySettings[0].active = false;
    if (reason === 'revision') body.expectedRevision = 2;
    if (reason === 'audit') f.tx.configurationAudit.create.mockRejectedValueOnce(new Error('SYNTHETIC audit failure'));
    if (reason === 'cas') f.tx.companySettings.update.mockRejectedValueOnce({ code: 'P2025' });
    const before = structuredClone(f.state);
    await expect(f.admin.configureEnvironment('7', body, request())).rejects.toThrow();
    expect(f.state).toEqual(before); expect(f.tx.seriesCounter.update).not.toHaveBeenCalled();
  });
  it.each([{ confirmation: 'CAMBIAR' }, { environment: 'BETA' }, { expectedRevision: '1' }, { nextNumber: 1 }, { expectedRevision: 0 }])('rejects invalid transition body %j', async patch => {
    const f = fixture('BETA'); await expect(f.admin.configureEnvironment('7', { ...transition(), ...patch }, request())).rejects.toThrow();
    expect(f.state.companySettings[0].environment).toBe('BETA'); expect(f.state.configurationAudit).toEqual([]);
  });
  it('unrelated issuers do not prevent transition and both permissions are declared on the route', async () => {
    const f = fixture('BETA'); f.state.outboxEvent.push({ payload: { payload: { companyId: 99 } } }); f.state.document.push({ companyId: 99 });
    await f.admin.configureEnvironment('7', transition(), request());
    expect(f.state.outboxEvent).toHaveLength(1); expect(f.state.document).toHaveLength(1);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, StationsController.prototype.configureEnvironment)).toEqual([PermissionCodes.SETUP_MANAGE, PermissionCodes.SUNAT_CONFIGURE]);
  });
  it.each(['false', 'true', 'TRUE'])('catalogue exposes only the server admission flag (%s), never RUC authorization', async flag => {
    vi.stubEnv('BILLING_PRODUCTION_ISSUANCE_ENABLED', flag);
    const find = () => ({ findMany: vi.fn().mockResolvedValue([]) });
    const prisma: any = { companySettings: find(), branch: find(), emissionPoint: find(), fuelProduct: find() };
    const result = await new IssuanceQueryService(prisma).catalog({ kind: 'GLOBAL' });
    expect(result.capabilities).toMatchObject({ fiscalTransmission: false, productionInvoiceAdmission: flag === 'true' });
    const environment = prisma.companySettings.findMany.mock.calls[0][0].where.environment;
    expect(environment).toEqual(flag === 'true' ? { in: ['BETA', 'PRODUCTION'] } : 'BETA');
    expect(prisma.branch.findMany.mock.calls[0][0].where.company.environment).toEqual(environment);
    expect(prisma.emissionPoint.findMany.mock.calls[0][0].where.company.environment).toEqual(environment);
    expect(fetch).not.toHaveBeenCalled();
  });
});
