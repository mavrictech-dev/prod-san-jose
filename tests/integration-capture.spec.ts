import { describe, expect, it, vi } from 'vitest';
import { parseIntegrationDocumentFilters, type IntegrationDocumentFiltersV1 } from '../packages/contracts/src/integration-extraction';
import { deny, snapshotHash, type ReadPrincipal } from '../packages/service-access/src/integration';
import { mapBillingDocument } from '../services/billing-service/src/integration/read';
import {
  BillingCapture, billingCaptureMaxBytes, billingCaptureMaxDocuments,
  type BillingCaptureBinding, type BillingCaptureRepository,
} from '../services/billing-service/src/integration/capture';
import { PrismaBillingCapture } from '../services/billing-service/src/integration/capture-repository';
import { branchId, counterId, documentId, issuerRuc, otherRuc, pointId, principal, sale, secondId } from './integration-read.fixture';

const token = 'fixture-token';
const query = { issuerRuc, from: '2026-01-01', to: '2026-01-02', types: '01,03,07,08' };
const time = Date.parse('2026-01-03T12:00:00.000Z');
const idAt = (n: number) => '40000000-0000-4000-8000-' + n.toString(16).padStart(12, '0');
const otherBranch = '10000000-0000-4000-8000-000000000002';
const otherPoint = '20000000-0000-4000-8000-000000000002';
const otherCounter = '30000000-0000-4000-8000-000000000002';
const filters = (q: Record<string, string> = query) => parseIntegrationDocumentFilters(q);
const binding = (row = sale()): BillingCaptureBinding => {
  const d = mapBillingDocument(row, principal(), issuerRuc, new Date(time)).document;
  return { id: d.id, branchId: d.branchId!, pointId: d.pointId!, seriesCounterId: d.seriesCounterId!,
    type: d.type as BillingCaptureBinding['type'], snapshotSha256: d.snapshotSha256! };
};

function fixture(rows = [sale()]) {
  const p = principal();
  const identity = { authenticate: vi.fn(async (t: string, _scopes: unknown) => {
    if (t !== token) return deny(401, 'UNAUTHENTICATED');
    return structuredClone(p);
  }) };
  const repository = {
    capture: vi.fn(async (_f: IntegrationDocumentFiltersV1, _p: ReadPrincipal) => rows),
    reauthorize: vi.fn(async (_ruc: string, ids: string[]) => rows.filter(row => ids.includes(row.id))),
  } satisfies BillingCaptureRepository;
  return { p, rows, identity, repository, service: new BillingCapture(repository, identity, () => time) };
}

// An in-memory transaction double: never instantiate PrismaService or contact storage.
function database(pages: any[][] = [], budgets: bigint[] = []) {
  const events: string[] = [];
  const tx = {
    $executeRawUnsafe: vi.fn(async (sql: string) => { events.push(sql); return 0; }),
    $queryRaw: vi.fn(async (_sql: TemplateStringsArray) => { events.push('CLOCK'); return [{ snapshotAt: new Date(time) }]; }),
    $queryRawUnsafe: vi.fn(async (sql: string, ..._values: unknown[]) => {
      if (sql.startsWith('SELECT COALESCE')) {
        events.push('BUDGET');
        const rawBytes = budgets.shift() ?? (pages[0] ?? []).reduce((total, row) => total +
          (row.immutableSnapshot === undefined ? 0n : BigInt(Buffer.byteLength(JSON.stringify(row.immutableSnapshot)))), 0n);
        return [{ rawBytes }];
      }
      events.push('SELECT'); return pages.shift() ?? [];
    }),
  };
  const db = { $transaction: vi.fn(async (run: (t: typeof tx) => Promise<any>, _options: unknown) => {
    events.push('BEGIN'); const result = await run(tx); events.push('COMMIT'); return result;
  }) };
  return { db, tx, events, repository: new PrismaBillingCapture(db as any),
    projectionCalls: () => tx.$queryRawUnsafe.mock.calls.filter(([sql]) => !sql.startsWith('SELECT COALESCE')),
    budgetCalls: () => tx.$queryRawUnsafe.mock.calls.filter(([sql]) => sql.startsWith('SELECT COALESCE')) };
}

describe('Billing capture: synthetic frozen documents and coverage', () => {
  it('uses the exact existing mapper for all four sales types and a single observation time', async () => {
    const rows = (['01', '03', '07', '08'] as const).map((type, i) => sale(type, idAt(i + 1)));
    const f = fixture(rows), result = await f.service.capture(token, query);
    expect(result).toEqual({ documents: rows.map(row => mapBillingDocument(row, f.p, issuerRuc, new Date(time)).document),
      snapshotAt: new Date(time).toISOString(), coverage: {
        complete: true, types: [
          ...['01', '03', '07', '08'].map(type => ({ type, state: 'READY', reasonCode: null })),
          ...['09', '31'].map(type => ({ type, state: 'UNSUPPORTED', reasonCode: 'SOURCE_NOT_SUPPORTED' })),
        ],
      } });
    expect(result.documents.every(d => d.state.fiscal === 'NOT_CHECKED' && d.state.transport === 'ACCEPTED')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/private-proof|immutableSnapshot|creditHistoryIds/);
    expect(f.identity.authenticate).toHaveBeenCalledTimes(2);
    expect(f.repository.capture).toHaveBeenCalledWith(filters(), f.p);
  });

  it('sorts by Lima issue day, issuedAt and id without truncating to the HTTP page limit', async () => {
    const early = sale('01', secondId), late = sale('01', idAt(3));
    early.issueDate = new Date('2026-01-01T05:00:00.000Z'); early.immutableSnapshot.issueDate = early.issueDate.toISOString();
    late.issueDate = new Date('2026-01-02T05:00:00.000Z'); late.immutableSnapshot.issueDate = late.issueDate.toISOString();
    const f = fixture([late, sale('01', secondId), sale(), early]);
    // Distinct ids for the different instant, same-day ordering must precede the id tie-break.
    early.id = idAt(4); early.immutableSnapshot.documentId = early.id;
    const result = await f.service.capture(token, { ...query, types: '01', limit: '1' });
    expect(result.documents.map(d => d.id)).toEqual([early.id, documentId, secondId, late.id]);
    expect(result.documents).toHaveLength(4);
  });

  it('rejects duplicate documents instead of silently deduplicating the cut', async () => {
    await expect(fixture([sale(), sale()]).service.capture(token, query)).rejects.toMatchObject({ status: 409, code: 'EVIDENCE_INCONSISTENT' });
  });

  it('uses the UTC clock attached to the captured rows, including empty captures', async () => {
    const f = fixture(), snapshotAt = '2026-01-03T10:00:00.123Z';
    f.repository.capture.mockResolvedValue(Object.assign(f.rows, { snapshotAt }));
    const result = await f.service.capture(token, query);
    expect(result.snapshotAt).toBe(snapshotAt); expect(result.documents[0].observedAt).toBe(snapshotAt);
    f.repository.capture.mockResolvedValue(Object.assign([], { snapshotAt }));
    expect((await f.service.capture(token, query)).snapshotAt).toBe(snapshotAt);
  });

  it('rejects a malformed or non-UTC transaction clock', async () => {
    const f = fixture();
    for (const snapshotAt of ['invalid', '2026-01-03T05:00:00.000-05:00']) {
      f.repository.capture.mockResolvedValue(Object.assign(f.rows, { snapshotAt }));
      await expect(f.service.capture(token, query)).rejects.toMatchObject({ status: 503, code: 'CONSISTENT_READ_UNAVAILABLE' });
    }
  });

  it.each([null, undefined, {}, { length: 0, snapshotAt: new Date(time).toISOString() }, { rows: [] }, 'rows'])
    ('fails closed for a non-array capture repository response %j', async response => {
      const f = fixture(); f.repository.capture.mockResolvedValue(response as any);
      await expect(f.service.capture(token, query)).rejects.toMatchObject({ status: 503, code: 'CONSISTENT_READ_UNAVAILABLE' });
    });

  it('rejects an array with an unsafe reported length before mapping', async () => {
    const f = fixture(), rows = new Proxy([], { get: (target, key) => key === 'length' ? Number.MAX_SAFE_INTEGER + 1 : Reflect.get(target, key) });
    f.repository.capture.mockResolvedValue(rows);
    await expect(f.service.capture(token, query)).rejects.toMatchObject({ status: 503, code: 'CONSISTENT_READ_UNAVAILABLE' });
  });

  it('accepts persisted cancelled business documents but refuses drafts', async () => {
    const row = sale(); row.status = 'CANCELLED'; const f = fixture([row]);
    expect((await f.service.capture(token, query)).documents[0].state.local).toBe('CANCELLED');
    row.status = 'DRAFT';
    await expect(f.service.capture(token, query)).rejects.toMatchObject({ status: 409, code: 'EVIDENCE_INCONSISTENT' });
  });

  it('marks missing grant types unavailable and bases completeness only on requested types', async () => {
    const f = fixture([]); f.p.grants[0].documentTypes = ['01'];
    const all = await f.service.capture(token, { issuerRuc, from: query.from, to: query.to });
    expect(all.coverage.complete).toBe(false);
    expect(all.coverage.types.find(t => t.type === '03')).toEqual({ type: '03', state: 'UNAVAILABLE', reasonCode: 'INSUFFICIENT_SCOPE' });
    expect((await f.service.capture(token, { ...query, types: '01' })).coverage.complete).toBe(true);
    expect((await f.service.capture(token, { ...query, types: '09,31' })).coverage).toMatchObject({ complete: false,
      types: expect.arrayContaining([{ type: '09', state: 'UNSUPPORTED', reasonCode: 'SOURCE_NOT_SUPPORTED' },
        { type: '31', state: 'UNSUPPORTED', reasonCode: 'SOURCE_NOT_SUPPORTED' }]) });
  });

  it('does not report ready for empty selections or for disjoint branch/point grant fragments', async () => {
    const f = fixture([]), g = f.p.grants[0];
    f.p.grants = [{ ...g, branches: { kind: 'IDS', ids: [branchId] }, points: { kind: 'IDS', ids: [otherPoint] } },
      { ...g, branches: { kind: 'IDS', ids: [otherBranch] }, points: { kind: 'IDS', ids: [pointId] } }];
    const result = await f.service.capture(token, { ...query, branchId, pointId, types: '01' });
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.types[0]).toMatchObject({ state: 'UNAVAILABLE', reasonCode: 'INSUFFICIENT_SCOPE' });
    f.p.grants = [{ ...g, documentTypes: ['01'] }, { ...g, documentTypes: ['03'], series: { kind: 'IDS', ids: [] } }];
    expect((await f.service.capture(token, { ...query, types: '03' })).coverage.types[1].state).toBe('UNAVAILABLE');
  });

  it('accepts NOT_CHECKED without filtering the transport projection', async () => {
    const f = fixture(); const result = await f.service.capture(token, { ...query, fiscalStatus: 'NOT_CHECKED' });
    expect(result.documents[0].state).toMatchObject({ fiscal: 'NOT_CHECKED', transport: 'ACCEPTED' });
  });

  it.each(['ACCEPTED', 'REJECTED', 'PENDING', 'VOIDED'])('refuses unverified fiscal filter %s before reading', async fiscalStatus => {
    const f = fixture();
    await expect(f.service.capture(token, { ...query, fiscalStatus })).rejects.toMatchObject({ status: 503, code: 'CONSISTENT_READ_UNAVAILABLE' });
    expect(f.repository.capture).not.toHaveBeenCalled();
  });

  it.each([
    { ...query, extra: 'value' }, { ...query, from: '2026-02-30' }, { ...query, to: '2025-12-31' },
    { ...query, environment: 'PRODUCTION' }, { ...query, dataset: 'LAB' }, { ...query, issuerRuc: '00044232378' },
    { ...query, cursor: 'a'.repeat(43) }, { ...query, types: '01,01' }, { ...query, fiscalStatus: 'UNVERIFIED' },
    { ...query, currency: 'EUR' }, { ...query, limit: '10000' },
  ])('rejects a noncanonical capture query %j', async q => {
    const f = fixture(); await expect(f.service.capture(token, q)).rejects.toMatchObject({ status: 400, code: 'INVALID_QUERY' });
    expect(f.repository.capture).not.toHaveBeenCalled();
  });

  it('normalizes UUID query filters and enforces all returned filter bindings', async () => {
    const f = fixture();
    await f.service.capture(token, { ...query, branchId: branchId.toUpperCase(), pointId: pointId.toUpperCase(), series: 'F001', currency: 'PEN' });
    expect(f.repository.capture.mock.calls[0][0]).toMatchObject({ branchId, pointId, series: 'F001', currency: 'PEN' });
    await expect(f.service.capture(token, { ...query, currency: 'USD' })).rejects.toMatchObject({ code: 'EVIDENCE_INCONSISTENT' });
  });

  it('rejects unauthorized rows and corrupt canonical/snapshot bindings', async () => {
    const f = fixture(); f.p.grants[0].points = { kind: 'IDS', ids: [otherPoint] };
    await expect(f.service.capture(token, query)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    const corrupt = sale(); corrupt.seriesCounter.emissionPointId = otherPoint;
    await expect(fixture([corrupt]).service.capture(token, query)).rejects.toMatchObject({ code: 'INCOMPLETE_BINDING' });
    const changed = sale(); changed.immutableSnapshot.series = 'F002';
    await expect(fixture([changed]).service.capture(token, query)).rejects.toMatchObject({ code: 'EVIDENCE_INCONSISTENT' });
  });

  it('refuses invalid identity, missing scope and foreign issuer before the repository', async () => {
    const f = fixture(); await expect(f.service.capture('bad-token', query)).rejects.toMatchObject({ status: 401 });
    f.p.scopes = ['integration:catalog:read'];
    await expect(f.service.capture(token, query)).rejects.toMatchObject({ status: 403, code: 'INSUFFICIENT_SCOPE' });
    f.p.scopes.push('integration:documents:read');
    await expect(f.service.capture(token, { ...query, issuerRuc: otherRuc })).rejects.toMatchObject({ status: 404 });
    expect(f.repository.capture).not.toHaveBeenCalled();
  });

  it.each(['revision', 'client', 'grants', 'scopes'] as const)('reauthenticates and rejects changed %s after the read', async change => {
    const f = fixture();
    f.repository.capture.mockImplementation(async () => {
      if (change === 'revision') f.p.revision++;
      if (change === 'client') f.p.clientId = '80000000-0000-4000-8000-000000000002';
      if (change === 'grants') f.p.grants[0].documentTypes = ['01'];
      if (change === 'scopes') f.p.scopes = ['integration:documents:read'];
      return f.rows;
    });
    await expect(f.service.capture(token, query)).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    expect(f.identity.authenticate).toHaveBeenCalledTimes(2);
  });

  it('does not deliver a cut after token revocation', async () => {
    const f = fixture(); f.identity.authenticate.mockImplementationOnce(async () => structuredClone(f.p))
      .mockImplementationOnce(async () => deny(401, 'UNAUTHENTICATED'));
    await expect(f.service.capture(token, query)).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });

  it('fails on document 10001 with EXPORT_TOO_LARGE without mapping/truncating', async () => {
    const f = fixture([]); f.repository.capture.mockResolvedValue(Array(billingCaptureMaxDocuments + 1).fill(null));
    await expect(f.service.capture(token, query)).rejects.toMatchObject({ status: 422, code: 'EXPORT_TOO_LARGE' });
  });

  it('measures UTF-8 response bytes and rejects a whole oversized cut', async () => {
    const rows = Array.from({ length: 600 }, (_, i) => {
      const row = sale('01', idAt(i + 1)); row.immutableSnapshot.lines[0].description = '界'.repeat(9000); return row;
    });
    const f = fixture(rows.slice(0, 400)), result = await f.service.capture(token, { ...query, types: '01' });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(billingCaptureMaxBytes);
    const projected = { ...result, documents: rows.map(row => mapBillingDocument(row, f.p, issuerRuc, new Date(time)).document) };
    expect(JSON.stringify(projected).length).toBeLessThan(billingCaptureMaxBytes);
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeGreaterThan(billingCaptureMaxBytes);
    f.repository.capture.mockResolvedValue(rows);
    await expect(f.service.capture(token, { ...query, types: '01' })).rejects.toMatchObject({ status: 422, code: 'EXPORT_TOO_LARGE' });
  });

  it('accepts exactly 16 MiB including the metadata envelope, then rejects one extra byte', async () => {
    const f = fixture([]), q = { ...query, types: '01' };
    const emptyBytes = Buffer.byteLength(JSON.stringify(await f.service.capture(token, q)));
    const template = sale(); template.immutableSnapshot.lines[0].description = 'x'.repeat(9000);
    const documentBytes = Buffer.byteLength(JSON.stringify(mapBillingDocument(template, f.p, issuerRuc, new Date(time)).document));
    const count = Math.floor((billingCaptureMaxBytes - emptyBytes + 1) / (documentBytes + 1));
    const rows = Array.from({ length: count }, (_, i) => {
      const row = sale('01', idAt(i + 1)); row.immutableSnapshot.lines[0].description = 'x'.repeat(9000); return row;
    });
    let remaining = billingCaptureMaxBytes - emptyBytes - count * documentBytes - (count - 1);
    for (const row of rows) {
      const padding = Math.min(1000, remaining); row.immutableSnapshot.lines[0].description += 'x'.repeat(padding); remaining -= padding;
    }
    expect(remaining).toBe(0); f.repository.capture.mockResolvedValue(rows);
    const result = await f.service.capture(token, q);
    expect(Buffer.byteLength(JSON.stringify(result))).toBe(billingCaptureMaxBytes);
    rows.find(row => row.immutableSnapshot.lines[0].description.length < 10000)!.immutableSnapshot.lines[0].description += 'x';
    await expect(f.service.capture(token, q)).rejects.toMatchObject({ status: 422, code: 'EXPORT_TOO_LARGE' });
  });
});

describe('Billing reauthorization: strict canonical bindings, no resourceVersion dependency', () => {
  it('accepts changed local/transport state and version when the frozen snapshot is unchanged', async () => {
    const row = sale(), original = binding(row), before = mapBillingDocument(row, principal(), issuerRuc).document.resourceVersion;
    row.status = 'CANCELLED'; row.sunatStatus = 'VOIDED'; row.sunatResponseCode = 'changed';
    row.updatedAt = new Date('2026-01-04T00:00:00.000Z');
    expect(mapBillingDocument(row, principal(), issuerRuc).document.resourceVersion).not.toBe(before);
    const f = fixture([row]);
    expect(await f.service.reauthorize(token, { issuerRuc, bindings: [original] })).toEqual({ valid: true });
    expect(f.repository.reauthorize).toHaveBeenCalledWith(issuerRuc, [documentId]);
    expect(f.identity.authenticate).toHaveBeenCalledTimes(2);
  });

  it('accepts an empty export and binds every supplied id regardless of repository row order', async () => {
    const f = fixture([sale('03', secondId), sale()]);
    expect(await f.service.reauthorize(token, { issuerRuc, bindings: [binding(sale()), binding(sale('03', secondId))] })).toEqual({ valid: true });
    expect(await f.service.reauthorize(token, { issuerRuc, bindings: [] })).toEqual({ valid: true });
  });

  it.each([null, undefined, {}, { length: 0 }, { rows: [] }, 'rows'])
    ('fails closed for a non-array reauthorization response %j', async response => {
      const f = fixture(); f.repository.reauthorize.mockResolvedValue(response as any);
      await expect(f.service.reauthorize(token, { issuerRuc, bindings: [] }))
        .rejects.toMatchObject({ status: 503, code: 'CONSISTENT_READ_UNAVAILABLE' });
    });

  it('rejects an oversized reauthorization array before inspecting rows', async () => {
    const f = fixture(); f.repository.reauthorize.mockResolvedValue(Array(10001).fill(null));
    await expect(f.service.reauthorize(token, { issuerRuc, bindings: [] }))
      .rejects.toMatchObject({ status: 422, code: 'EXPORT_TOO_LARGE' });
  });

  it.each(['branchId', 'pointId', 'seriesCounterId', 'type', 'snapshotSha256'] as const)('rejects a forged %s', async key => {
    const b = binding(); Object.assign(b, { [key]: key === 'type' ? '03' : key === 'snapshotSha256' ? 'a'.repeat(64) : otherCounter });
    await expect(fixture().service.reauthorize(token, { issuerRuc, bindings: [b] })).rejects.toMatchObject({ status: 409, code: 'EVIDENCE_INCONSISTENT' });
  });

  it('rejects changed frozen content even if its canonical ids still match', async () => {
    const row = sale(), b = binding(row); row.immutableSnapshot.customer.legalName = 'Changed';
    expect(snapshotHash(row.immutableSnapshot)).not.toBe(b.snapshotSha256);
    await expect(fixture([row]).service.reauthorize(token, { issuerRuc, bindings: [b] })).rejects.toMatchObject({ code: 'EVIDENCE_INCONSISTENT' });
  });

  it('refuses a document that is now a draft in the business dataset', async () => {
    const row = sale(), b = binding(row); row.status = 'DRAFT';
    await expect(fixture([row]).service.reauthorize(token, { issuerRuc, bindings: [b] }))
      .rejects.toMatchObject({ status: 409, code: 'EVIDENCE_INCONSISTENT' });
  });

  it('rejects changed canonical ownership despite a still-matching frozen hash', async () => {
    const row = sale(), b = binding(row); row.emissionPoint.id = otherPoint; row.seriesCounter.emissionPointId = otherPoint;
    await expect(fixture([row]).service.reauthorize(token, { issuerRuc, bindings: [b] })).rejects.toMatchObject({ code: 'EVIDENCE_INCONSISTENT' });
  });

  it('fails closed for missing, duplicate, extra and foreign/BETA-mismatched rows', async () => {
    const f = fixture([]), request = { issuerRuc, bindings: [binding()] };
    await expect(f.service.reauthorize(token, request)).rejects.toMatchObject({ status: 404, code: 'RESOURCE_NOT_FOUND' });
    f.repository.reauthorize.mockResolvedValue([sale(), sale()]);
    await expect(f.service.reauthorize(token, request)).rejects.toMatchObject({ code: 'EVIDENCE_INCONSISTENT' });
    f.repository.reauthorize.mockResolvedValue([sale(), sale('03', secondId)]);
    await expect(f.service.reauthorize(token, request)).rejects.toMatchObject({ code: 'EVIDENCE_INCONSISTENT' });
    const row = sale(); row.company.ruc = otherRuc; f.repository.reauthorize.mockResolvedValue([row]);
    await expect(f.service.reauthorize(token, request)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    row.company.ruc = issuerRuc; row.immutableSnapshot.environment = 'PRODUCTION';
    await expect(f.service.reauthorize(token, request)).rejects.toMatchObject({ code: 'EVIDENCE_INCONSISTENT' });
  });

  it('checks canonical permissions rather than trusting the submitted grant tuple', async () => {
    const f = fixture(); f.p.grants[0].points = { kind: 'IDS', ids: [otherPoint] };
    await expect(f.service.reauthorize(token, { issuerRuc, bindings: [{ ...binding(), pointId: otherPoint }] }))
      .rejects.toMatchObject({ status: 404, code: 'RESOURCE_NOT_FOUND' });
  });

  it.each([
    null, { issuerRuc }, { issuerRuc, bindings: 'wrong' }, { issuerRuc, bindings: [], extra: true },
    { issuerRuc, bindings: [{ ...binding(), resourceVersion: 'a'.repeat(64) }] },
    { issuerRuc, bindings: [{ ...binding(), snapshotSha256: null }] },
    { issuerRuc, bindings: [{ ...binding(), branchId: null }] },
    { issuerRuc, bindings: [{ ...binding(), type: '09' }] },
    { issuerRuc, bindings: [binding(), binding()] },
    { issuerRuc, bindings: [{ ...binding(), pointId: 'admin' }] },
  ])('rejects malformed/extra binding fields before lookup %j', async body => {
    const f = fixture(); await expect(f.service.reauthorize(token, body)).rejects.toMatchObject({ status: 400, code: 'INVALID_REQUEST' });
    expect(f.repository.reauthorize).not.toHaveBeenCalled();
  });

  it('limits bindings to 10000 and rechecks identity after canonical lookup', async () => {
    const f = fixture();
    await expect(f.service.reauthorize(token, { issuerRuc, bindings: Array(10001).fill(binding()) }))
      .rejects.toMatchObject({ status: 422, code: 'EXPORT_TOO_LARGE' });
    expect(f.repository.reauthorize).not.toHaveBeenCalled();
    f.repository.reauthorize.mockImplementation(async () => { f.p.revision++; return f.rows; });
    await expect(f.service.reauthorize(token, { issuerRuc, bindings: [binding()] }))
      .rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });
});

describe('Billing SQL capture repository: transaction doubles only', () => {
  it('sets READ ONLY before the first SELECT and uses one RepeatableRead transaction', async () => {
    const f = database([[sale()]]); expect(await f.repository.capture(filters(), principal())).toHaveLength(1);
    expect(f.events).toEqual(['BEGIN', 'SET TRANSACTION READ ONLY', 'CLOCK', 'BUDGET', 'SELECT', 'COMMIT']);
    expect(f.db.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'RepeatableRead' });
    expect(f.tx.$queryRaw.mock.calls[0][0][0]).toBe('SELECT transaction_timestamp() AS "snapshotAt"');
    expect((await database().repository.capture(filters(), principal())).snapshotAt).toBe(new Date(time).toISOString());
    const [sql, ...values] = f.projectionCalls()[0];
    expect(sql).toContain('d."issueDate" >= ($3::date::timestamp AT TIME ZONE \'America/Lima\')');
    expect(sql).toContain('d."issueDate" < (($4::date + 1)::timestamp AT TIME ZONE \'America/Lima\')');
    expect(sql).toContain('d."immutableSnapshot"->>\'environment\' = \'BETA\'');
    expect(sql).toContain('d."status"::text IN (\'ISSUED\', \'CANCELLED\')');
    expect(values.slice(0, 4)).toEqual([issuerRuc, ['INVOICE', 'SALES_RECEIPT', 'CREDIT_NOTE', 'DEBIT_NOTE'], query.from, query.to]);
    expect(values.at(-1)).toBe(500);
    expect(sql).not.toMatch(/SELECT\s+\*|credentials|outbox|nextNumber|OFFSET|FOR UPDATE/i);
    expect(sql).toContain('d."payableAmount"::text');
  });

  it('fails closed before document selection if the transaction clock is unavailable', async () => {
    for (const clock of [[], [{ snapshotAt: new Date('invalid') }]]) {
      const f = database(); f.tx.$queryRaw.mockResolvedValue(clock);
      await expect(f.repository.capture(filters(), principal())).rejects.toMatchObject({ status: 503, code: 'CONSISTENT_READ_UNAVAILABLE' });
      expect(f.tx.$queryRawUnsafe).not.toHaveBeenCalled();
    }
  });

  it('counts only the selected page as uncompressed text, using exactly the projection selection and parameters', async () => {
    const first = Array.from({ length: 500 }, (_, i) => ({ id: idAt(i + 1), issueDate: new Date(time) }));
    const f = database([first, [sale('01', idAt(501))]]), p = principal(), g = p.grants[0];
    p.grants = [{ ...g, branches: { kind: 'IDS', ids: [branchId] }, points: { kind: 'IDS', ids: [pointId] },
      series: { kind: 'IDS', ids: [counterId] } }, { ...g, branches: { kind: 'IDS', ids: [otherBranch] } }];
    await f.repository.capture(filters({ ...query, branchId, pointId, series: 'F001', currency: 'PEN' }), p);
    expect(f.events).toEqual(['BEGIN', 'SET TRANSACTION READ ONLY', 'CLOCK', 'BUDGET', 'SELECT', 'BUDGET', 'SELECT', 'COMMIT']);
    const projections = f.projectionCalls(), budgets = f.budgetCalls();
    expect(projections).toHaveLength(2); expect(budgets).toHaveLength(2);
    for (let i = 0; i < budgets.length; i++) {
      const [sql, ...values] = budgets[i], [projected, ...projectedValues] = projections[i];
      expect(sql).toBe('SELECT COALESCE(sum(octet_length("immutableSnapshot"::text)), 0) AS "rawBytes"\nFROM (SELECT d."immutableSnapshot"\n' +
        projected.slice(projected.indexOf('FROM "Document"')) + ') bounded');
      expect(values).toEqual(projectedValues);
      expect(sql).not.toMatch(/pg_column_size|SELECT\s+\*|payableAmount|jsonb_build_object|OFFSET/i);
      expect(values.at(-1)).toBe(500);
    }
    expect(budgets[1][0]).toContain('(d."issueDate", d."id") >');
  });

  it('refuses one snapshot over 16 MiB before fetching any projected JSON', async () => {
    const f = database([[sale()]], [BigInt(billingCaptureMaxBytes) + 1n]);
    await expect(f.repository.capture(filters(), principal())).rejects.toMatchObject({ status: 422, code: 'EXPORT_TOO_LARGE' });
    expect(f.budgetCalls()).toHaveLength(1); expect(f.projectionCalls()).toHaveLength(0);
    expect(f.events).toEqual(['BEGIN', 'SET TRANSACTION READ ONLY', 'CLOCK', 'BUDGET']);
  });

  it('accumulates raw bytes across capture pages and blocks the page that crosses the budget', async () => {
    const first = Array.from({ length: 500 }, (_, i) => ({ id: idAt(i + 1), issueDate: new Date(time) }));
    const f = database([first, [sale('01', idAt(501))]], [BigInt(billingCaptureMaxBytes) - 1n, 2n]);
    await expect(f.repository.capture(filters(), principal())).rejects.toMatchObject({ status: 422, code: 'EXPORT_TOO_LARGE' });
    expect(f.budgetCalls()).toHaveLength(2); expect(f.projectionCalls()).toHaveLength(1);
    expect(f.events.at(-1)).toBe('BUDGET'); expect(f.events).not.toContain('COMMIT');
  });

  it('allows exactly 16 MiB of raw snapshots and resets the budget for the next capture', async () => {
    const f = database([[sale()], [sale()]], [BigInt(billingCaptureMaxBytes), BigInt(billingCaptureMaxBytes)]);
    expect(await f.repository.capture(filters(), principal())).toHaveLength(1);
    expect(await f.repository.capture(filters(), principal())).toHaveLength(1);
    expect(f.projectionCalls()).toHaveLength(2); expect(f.db.$transaction).toHaveBeenCalledTimes(2);
  });

  it.each([[], [{ rawBytes: -1n }], [{ rawBytes: '0' }], [{ rawBytes: 0 }], [{ rawBytes: 0n }, { rawBytes: 0n }]])
    ('fails closed for invalid size metadata without loading snapshots %#', async budget => {
      const f = database([[sale()]]); f.tx.$queryRawUnsafe.mockResolvedValueOnce(budget);
      await expect(f.repository.capture(filters(), principal())).rejects.toMatchObject({ status: 503, code: 'CONSISTENT_READ_UNAVAILABLE' });
      expect(f.projectionCalls()).toHaveLength(0);
    });

  it('binds branch, point, series and frozen currency filters; never turns transport into fiscal evidence', async () => {
    const f = database(); await f.repository.capture(filters({ ...query, branchId, pointId, series: 'F001', currency: 'USD', fiscalStatus: 'NOT_CHECKED' }), principal());
    const [sql, ...values] = f.projectionCalls()[0];
    expect(sql).toContain('e."branchId" = $5::uuid'); expect(sql).toContain('e."id" = $6::uuid');
    expect(sql).toContain('d."series" = $7'); expect(sql).toContain('d."immutableSnapshot"->>\'currencyCode\' = $8');
    expect(values).toEqual(expect.arrayContaining([branchId, pointId, 'F001', 'USD']));
    expect(sql.slice(sql.indexOf('\nWHERE'))).not.toContain('sunatStatus');
  });

  it('keeps each grant tuple together in SQL before LIMIT, excluding foreign/environment/type rules', async () => {
    const f = database(), p = principal(), g = p.grants[0];
    p.grants = [{ ...g, documentTypes: ['01'], branches: { kind: 'IDS', ids: [branchId] },
      points: { kind: 'IDS', ids: [otherPoint] }, series: { kind: 'IDS', ids: [counterId] } },
    { ...g, documentTypes: ['03'], branches: { kind: 'IDS', ids: [otherBranch] },
      points: { kind: 'IDS', ids: [pointId] }, series: { kind: 'IDS', ids: [otherCounter] } },
    { ...g, issuerRuc: otherRuc }];
    await f.repository.capture(filters(), p);
    const [sql, ...values] = f.projectionCalls()[0];
    expect(sql).toContain('((d."type"::text = ANY($5::text[]) AND e."branchId" = ANY($6::uuid[]) AND e."id" = ANY($7::uuid[]) AND s."id" = ANY($8::uuid[])) OR (d."type"::text = ANY($9::text[]) AND e."branchId" = ANY($10::uuid[]) AND e."id" = ANY($11::uuid[]) AND s."id" = ANY($12::uuid[])))');
    expect(values.slice(4, 12)).toEqual([['INVOICE'], [branchId], [otherPoint], [counterId], ['SALES_RECEIPT'], [otherBranch], [pointId], [otherCounter]]);
    expect(values).not.toContain(otherRuc); expect(sql.indexOf(' OR ')).toBeLessThan(sql.indexOf(' LIMIT '));
    expect(sql).not.toContain('20555555555');
  });

  it('uses keyset issueDate+id across multiple pages in the same read-only transaction', async () => {
    const first = Array.from({ length: 500 }, (_, i) => ({ id: idAt(i + 1), issueDate: new Date('2026-01-01T05:00:00.000Z') }));
    const f = database([first, [{ id: idAt(501), issueDate: new Date('2026-01-01T05:00:00.000Z') }]]);
    const result = await f.repository.capture(filters(), principal()); expect(result).toHaveLength(501);
    expect(f.db.$transaction).toHaveBeenCalledTimes(1); expect(f.tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, ...values] = f.projectionCalls()[1];
    expect(sql).toContain('(d."issueDate", d."id") > ($6::timestamptz, $7::uuid)');
    expect(sql).toContain('ORDER BY d."issueDate" ASC, d."id" ASC LIMIT $8::int');
    expect(values.slice(-3)).toEqual([first[499].issueDate, first[499].id, 500]);
    expect(sql).not.toContain('OFFSET');
  });

  it('returns exactly 10000 documents only after an authorized lookahead proves the cut complete', async () => {
    const rows = Array.from({ length: 10000 }, (_, i) => ({ id: idAt(i + 1), issueDate: new Date(time) }));
    const pages = Array.from({ length: 20 }, (_, i) => rows.slice(i * 500, (i + 1) * 500));
    const f = database([...pages, []]); expect(await f.repository.capture(filters(), principal())).toEqual(Object.assign(rows, { snapshotAt: new Date(time).toISOString() }));
    expect(f.tx.$queryRawUnsafe).toHaveBeenCalledTimes(42);
    expect(f.projectionCalls()).toHaveLength(21); expect(f.budgetCalls()).toHaveLength(21);
    expect(f.projectionCalls().at(-1)?.at(-1)).toBe(1);
    expect(f.db.$transaction).toHaveBeenCalledTimes(1);
  });

  it('fails rather than truncates when authorized document 10001 exists', async () => {
    const rows = Array.from({ length: 10001 }, (_, i) => ({ id: idAt(i + 1), issueDate: new Date(time) }));
    const f = database(Array.from({ length: 21 }, (_, i) => rows.slice(i * 500, (i + 1) * 500)));
    await expect(f.repository.capture(filters(), principal())).rejects.toMatchObject({ status: 422, code: 'EXPORT_TOO_LARGE' });
    expect(f.projectionCalls().at(-1)?.at(-1)).toBe(1); expect(f.events).not.toContain('COMMIT');
  });

  it('does not apply quotas to a type with no grant: the grant WHERE still precedes LIMIT', async () => {
    const f = database(), p = principal(); p.grants[0].documentTypes = ['03'];
    expect(await f.repository.capture(filters({ ...query, types: '01' }), p)).toEqual(Object.assign([], { snapshotAt: new Date(time).toISOString() }));
    const [sql, ...values] = f.projectionCalls()[0];
    expect(values[1]).toEqual(['INVOICE']); expect(values[4]).toEqual(['SALES_RECEIPT']);
    expect(sql).toContain('AND ((d."type"::text = ANY($5::text[])))');
  });

  it('restricts unsupported sales types to an empty SQL selection and rejects unsupported fiscal filters', async () => {
    const f = database(); await f.repository.capture(filters({ ...query, types: '09,31' }), principal());
    expect(f.projectionCalls()[0][2]).toEqual([]);
    f.db.$transaction.mockClear();
    await expect(f.repository.capture(filters({ ...query, fiscalStatus: 'ACCEPTED' }), principal()))
      .rejects.toMatchObject({ status: 503, code: 'CONSISTENT_READ_UNAVAILABLE' });
    expect(f.db.$transaction).not.toHaveBeenCalled();
  });

  it('reauthorizes the entire ID list in one RepeatableRead READ ONLY transaction scoped by RUC/BETA', async () => {
    const ids = Array.from({ length: 1001 }, (_, i) => idAt(i + 1)), f = database([[sale()], [], []]);
    expect(await f.repository.reauthorize(issuerRuc, ids)).toEqual([sale()]);
    expect(f.db.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'RepeatableRead' });
    expect(f.tx.$queryRawUnsafe).toHaveBeenCalledTimes(6); expect(f.tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    const chunks = f.projectionCalls().map(([sql, ruc, types, chunk]) => {
      expect(sql).toContain('c."ruc" = $1'); expect(sql).toContain('d."immutableSnapshot"->>\'environment\' = \'BETA\'');
      expect(sql).toContain('d."id" = ANY($3::uuid[])'); expect(sql).not.toMatch(/resourceVersion|SELECT\s+\*|credentials|outbox|nextNumber/i);
      expect(sql).toContain('d."status"::text IN (\'ISSUED\', \'CANCELLED\')');
      expect(ruc).toBe(issuerRuc); expect(types).toEqual(['INVOICE', 'SALES_RECEIPT', 'CREDIT_NOTE', 'DEBIT_NOTE']); return chunk as string[];
    });
    expect(chunks.map(chunk => chunk.length)).toEqual([500, 500, 1]); expect(chunks.flat()).toEqual(ids);
    expect(f.events[1]).toBe('SET TRANSACTION READ ONLY');
  });

  it('bounds reauthorization size scans to each RUC/BETA ID chunk using identical predicates before its projection', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => idAt(i + 1)), f = database([[], []]);
    await f.repository.reauthorize(issuerRuc, ids);
    expect(f.events).toEqual(['BEGIN', 'SET TRANSACTION READ ONLY', 'BUDGET', 'SELECT', 'BUDGET', 'SELECT', 'COMMIT']);
    for (let i = 0; i < 2; i++) {
      const [sql, ...values] = f.budgetCalls()[i], [projected, ...projectedValues] = f.projectionCalls()[i];
      expect(sql).toContain('SELECT COALESCE(sum(octet_length("immutableSnapshot"::text)), 0)');
      expect(sql).toContain('SELECT d."immutableSnapshot"\n' + projected.slice(projected.indexOf('FROM "Document"')));
      expect(sql).toContain('d."id" = ANY($3::uuid[])'); expect(sql).toContain('ORDER BY d."issueDate" ASC, d."id" ASC LIMIT 500');
      expect(sql).not.toMatch(/pg_column_size|payableAmount|jsonb_build_object/);
      expect(values).toEqual(projectedValues); expect((values[2] as string[]).length).toBe(i === 0 ? 500 : 1);
    }
  });

  it('refuses oversized reauthorization snapshots before its first projection', async () => {
    const f = database([[sale()]], [BigInt(billingCaptureMaxBytes) + 1n]);
    await expect(f.repository.reauthorize(issuerRuc, [documentId])).rejects.toMatchObject({ status: 422, code: 'EXPORT_TOO_LARGE' });
    expect(f.budgetCalls()).toHaveLength(1); expect(f.projectionCalls()).toHaveLength(0);
    expect(f.events).toEqual(['BEGIN', 'SET TRANSACTION READ ONLY', 'BUDGET']);
  });

  it('accumulates the reauthorization raw budget across chunks and blocks the next projection', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => idAt(i + 1)), f = database([[], []], [BigInt(billingCaptureMaxBytes), 1n]);
    await expect(f.repository.reauthorize(issuerRuc, ids)).rejects.toMatchObject({ status: 422, code: 'EXPORT_TOO_LARGE' });
    expect(f.budgetCalls()).toHaveLength(2); expect(f.projectionCalls()).toHaveLength(1);
    expect(f.events.at(-1)).toBe('BUDGET'); expect(f.events).not.toContain('COMMIT');
  });

  it('supports empty reauthorization and rejects invalid/oversized ID lists before storage', async () => {
    const f = database(); expect(await f.repository.reauthorize(issuerRuc, [])).toEqual([]);
    expect(f.tx.$queryRawUnsafe).not.toHaveBeenCalled(); f.db.$transaction.mockClear();
    await expect(f.repository.reauthorize(issuerRuc, ['not-uuid'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(f.repository.reauthorize(issuerRuc, [documentId, documentId])).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(f.repository.reauthorize(issuerRuc, Array.from({ length: 10001 }, (_, i) => idAt(i + 1))))
      .rejects.toMatchObject({ status: 422, code: 'EXPORT_TOO_LARGE' });
    expect(f.db.$transaction).not.toHaveBeenCalled();
  });
});
