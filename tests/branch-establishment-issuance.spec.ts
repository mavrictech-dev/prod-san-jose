import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IssueDocumentService, type IssueDocumentInput } from '../services/billing-service/src/application/issue-document.service';
import { StationAdminService } from '../services/billing-service/src/application/station-admin.service';
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
const input = (): IssueDocumentInput => ({ emissionPointId: POINT, documentType: 'INVOICE', series: 'F001', issueDate: '2026-10-28T17:00:00Z',
  currencyCode: 'PEN', paymentTerms: { type: 'CONTADO' }, customer: { identityType: '6', identityNumber: RUC, legalName: 'SYNTHETIC CUSTOMER' },
  lines: [{ description: 'SYNTHETIC ITEM', unitCode: 'NIU', quantity: '1', unitPriceWithTax: '1.18', taxAffectationCode: '10', igvRate: '18' }] });
function proof(snapshot: any) {
  return { authorized: true, environment: 'PRODUCTION', issuerRuc: snapshot.issuer.identityNumber, snapshotSha256: fiscalSnapshotSha256(snapshot), documentId: snapshot.documentId, profile: '01-PEN-0101-IGV18-v1' };
}

function fixture(environment = 'PRODUCTION') {
  const state: any = {
    companySettings: [{ id: 7, ruc: RUC, legalName: 'SYNTHETIC ISSUER', environment, active: true, configVersion: 1, taxAddress: 'TEST ADDRESS', ubigeo: '150101', tradeName: null }],
    branch: [{ id: BRANCH, companyId: 7, active: true, name: 'SYNTHETIC BRANCH', establishmentCode: '0042', address: 'TEST ADDRESS' }],
    emissionPoint: [{ id: POINT, companyId: 7, branchId: BRANCH, active: true, code: 'CAJA_A', name: 'SYNTHETIC POINT' }],
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


describe('Establecimiento del emisor por sede: snapshot, admisión y contador', () => {
  it.each([null, undefined, '', '123', '12345', 'CAJA01', '0042\n'])('Prod sin código válido %j falla antes de contador, admisión, documento u outbox', async value => {
    const f = fixture(); f.state.branch[0].establishmentCode = value;
    f.state.emissionPoint[0].code = '9876';
    await expect(f.service.execute(input(), f.context())).rejects.toThrow('establecimiento SUNAT de la sede');
    unchanged(f); expect(f.tx.seriesCounter.update).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(f.tx.document.create).not.toHaveBeenCalled(); expect(f.tx.outboxEvent.create).not.toHaveBeenCalled();
  });
  it('dos puntos de la misma sede comparten establecimiento y conservan sus series y snapshots anteriores', async () => {
    const f = fixture();
    const pointB = '20000000-0000-4000-8000-000000000002', seriesB = '40000000-0000-4000-8000-000000000002';
    f.state.emissionPoint.push({ ...f.state.emissionPoint[0], id: pointB, code: 'CAJA_B' });
    f.state.seriesCounter.push({ ...f.state.seriesCounter[0], id: seriesB, emissionPointId: pointB, series: 'F002' });
    const snapshots: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
      const snapshot = JSON.parse(options.body as string).snapshot; snapshots.push(snapshot);
      expect(snapshot.issuer.establishmentCode).toBe(snapshots.length < 3 ? '0042' : '0087');
      return Response.json(proof(snapshot));
    }));
    const first = await f.service.execute(input(), f.context());
    const second = await f.service.execute({ ...input(), emissionPointId: pointB, series: 'F002' }, { ...f.context(), idempotencyKey: 'SYNTHETIC_TWO' });
    expect(first.immutableSnapshot.issuer.establishmentCode).toBe('0042');
    expect(second.immutableSnapshot.issuer.establishmentCode).toBe('0042');
    const frozen = structuredClone(f.state.document);
    f.state.branch[0].establishmentCode = '0087';
    const third = await f.service.execute(input(), { ...f.context(), idempotencyKey: 'SYNTHETIC_THREE' });
    expect(third.immutableSnapshot.issuer.establishmentCode).toBe('0087');
    expect(f.state.document.slice(0, 2)).toEqual(frozen);
    expect(f.state.seriesCounter.map((s: any) => s.nextNumber)).toEqual([3n, 2n]);
    expect(f.state.outboxEvent.map((e: any) => e.payload.payload.issuer.establishmentCode)).toEqual(['0042', '0042', '0087']);
  });
  it.each([null, undefined, '0042'])('Beta usa configuración o fallback legacy sin admisión: %j', async value => {
    const f = fixture('BETA'); f.state.branch[0].establishmentCode = value;
    const result = await f.service.execute(input(), { ...f.context(), authorization: undefined });
    expect(result.immutableSnapshot.issuer.establishmentCode).toBe(value ?? 'CAJA_A');
    expect(f.state.seriesCounter[0].nextNumber).toBe(2n); expect(fetch).not.toHaveBeenCalled();
  });
  it('una sede de otro RUC no aporta su establecimiento a la emisión', async () => {
    const f = fixture(); f.state.branch[0].companyId = 99;
    await expect(f.service.execute(input(), f.context())).rejects.toThrow('no autorizados');
    unchanged(f); expect(fetch).not.toHaveBeenCalled();
  });
  it('el código de sede no abre producción a B2B', async () => {
    const f = fixture(); const context: any = f.context();
    context.b2b = { binding: { issuerId: 7, issuerRuc: RUC, environment: 'BETA', branchId: BRANCH, pointId: POINT, seriesId: SERIES, documentType: '01' },
      draftId: ACTOR, actor: { kind: 'USER', clientId: ACTOR, revision: 1, subjectId: ACTOR, userAuthRevision: 1 } };
    await expect(f.service.execute(input(), context)).rejects.toThrow(); unchanged(f); expect(fetch).not.toHaveBeenCalled();
  });
});
