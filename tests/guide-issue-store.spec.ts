import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { B2bSecurityError } from '../packages/contracts/src/b2b-security';
import { PostgresGuideIssueStore } from '../services/billing-service/src/b2b/guide-issue-store';
import type { GuideEstablishmentDatabase, GuideEstablishmentSql } from '../services/billing-service/src/b2b/guide-establishment-store';
import type { GuideIssueReceipt, GuideIssueScope } from '../services/billing-service/src/b2b/guide-issue-model';
import { guideIssueFixture } from './helpers/guide-issue.fixture';

// Only SQL/transaction boundaries are doubled. Receipts come from the actual
// producer and pass its complete profile, canonical-hash and provenance checks.
async function fixture() {
  const f = guideIssueFixture(), { receipt } = await f.issue(), s = receipt.snapshot;
  const context = await f.context.prepare.mock.results[0].value;
  const scope: GuideIssueScope = { binding: f.binding, draftId: s.draftId,
    clientId: receipt.clientId, actorKey: receipt.actorKey, keySha256: receipt.keySha256 };
  const header = { id: s.documentId, operationId: s.operationId, companyId: f.binding.draft.anchor.issuerId,
    issuerRuc: s.issuer.ruc, type: '09', draftSeriesId: f.binding.draft.guideSeriesId,
    fiscalSeriesId: f.binding.fiscalSeriesId, draftId: s.draftId, draftRevision: s.draftRevision,
    clientId: receipt.clientId, actorKey: receipt.actorKey, binding: s.binding, series: s.series,
    number: s.number, fullNumber: s.fullNumber, itemCount: s.body.items.length, snapshot: s, snapshotSha256: receipt.snapshotSha256 };
  const row = { id: receipt.id, documentId: s.documentId, clientId: receipt.clientId,
    actorKey: receipt.actorKey, keySha256: receipt.keySha256, requestSha256: receipt.requestSha256,
    payload: receipt, header };
  const state = { conflict: false, prior: [row] as unknown[], draft: [{ ...f.draft,
    guideSeriesId: f.binding.draft.guideSeriesId, companyId: f.binding.draft.anchor.issuerId,
    issuerRuc: s.issuer.ruc }] as unknown[], items: s.body.items.map((payload, i) => ({ position: i + 1, payload })),
    events: [{ operationId: receipt.id, eventType: 'guide.issue.prepared.local.v1', payload: s }],
    issued: [] as unknown[], collision: [] as unknown[], cas: 1 };
  type Call = { text: string; values: unknown[]; write: boolean };
  const calls: Call[] = [], committed: Call[] = [], commitErrors: unknown[] = [];
  const hooks: { sql?: (call: Call) => void } = {};
  const sql: GuideEstablishmentSql = {
    $queryRawUnsafe: async <T>(text: string, ...values: unknown[]) => {
      const call = { text, values, write: false }; calls.push(call); hooks.sql?.(call);
      let result: unknown;
      if (text.includes('pg_advisory_xact_lock')) result = [];
      else if (text.includes('SELECT EXISTS')) result = [{ conflict: state.conflict }];
      else if (text.includes('to_jsonb(h)')) result = state.prior;
      else if (text.includes('FROM "B2bGuideIssueItem"')) result = state.items;
      else if (text.includes('FROM "B2bGuideIssueLocalOutbox"')) result = state.events;
      else if (text.includes('FROM "B2bGuideDraft"')) result = state.draft;
      else if (text.includes('FROM "B2bGuideIssueDocument"')) result = state.issued;
      else if (text.includes('FROM "Document"')) result = state.collision;
      else throw new Error('UNEXPECTED_TEST_SQL');
      return structuredClone(result) as T;
    },
    $executeRawUnsafe: async (text, ...values) => {
      const call = { text, values, write: true }; calls.push(call); hooks.sql?.(call);
      return text.includes('UPDATE "SeriesCounter"') ? state.cas : 1;
    },
  };
  const transaction = vi.fn(async <T>(work: (sql: GuideEstablishmentSql) => Promise<T>, _options: Parameters<GuideEstablishmentDatabase['$transaction']>[1]) => {
    const start = calls.length, result = await work(sql);
    if (commitErrors.length) throw commitErrors.shift();
    committed.push(...calls.slice(start).filter(c => c.write)); return result;
  });
  const db: GuideEstablishmentDatabase = { $transaction: transaction };
  return { f, receipt, context, scope, header, row, state, calls, committed, commitErrors, transaction, hooks,
    store: new PostgresGuideIssueStore(db),
    commit: () => new PostgresGuideIssueStore(db).transaction(scope, tx => tx.commit(receipt, context)) };
}
const inconsistent = { status: 409, code: 'GUIDE_ISSUE_RECEIPT_INCONSISTENT' };

describe('candidate GuideIssue PostgreSQL adapter', () => {
  it('constructs without I/O and never applies schema', () => {
    const db = { $transaction: vi.fn() }; new PostgresGuideIssueStore(db); expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('validates scope before opening a transaction', async () => {
    const t = await fixture();
    await expect(t.store.transaction({ ...t.scope, actorKey: 'USER:bad' }, async () => {})).rejects.toMatchObject(inconsistent);
    expect(t.transaction).not.toHaveBeenCalled();
  });
  it('locks key namespace before scoped draft and uses serializable isolation', async () => {
    const t = await fixture(); await t.store.transaction(t.scope, async () => 42);
    expect(t.calls.map(c => JSON.parse(c.values[0] as string)[0])).toEqual(['guide-issue-key', 'guide-issue-draft']);
    expect(t.transaction.mock.calls[0][1]).toMatchObject({ isolationLevel: 'Serializable' });
  });
  it('replays only a complete, physically matching receipt and ordered items', async () => {
    const t = await fixture(); expect(await t.store.transaction(t.scope, tx => tx.prior())).toEqual(t.receipt);
    expect(t.committed).toEqual([]);
    for (const c of t.calls.filter(c => !c.text.includes('pg_advisory'))) {
      expect(c.values.slice(0, 6)).toEqual([t.scope.binding.draft.anchor.issuerId,
        t.scope.binding.draft.anchor.issuerRuc, t.scope.clientId, t.scope.actorKey, JSON.stringify(t.scope.binding), t.scope.draftId]);
    }
  });
  it.each(['draft', 'binding'])('same owner/key with changed %s returns a typed metadata-only conflict', async field => {
    const t = await fixture(); t.state.conflict = true;
    const scope = structuredClone(t.scope);
    if (field === 'draft') scope.draftId = '10000000-0000-4000-8000-000000000099';
    else scope.binding.draft.anchor.pointId = '10000000-0000-4000-8000-000000000099';
    await expect(t.store.transaction(scope, tx => tx.prior())).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    expect(t.calls).toHaveLength(3); expect(t.committed).toEqual([]);
    expect(t.calls[2].text).not.toMatch(/SELECT\s+r\."payload"/);
  });
  it.each(['header', 'receipt', 'items', 'event'])('rejects persisted %s corruption', async target => {
    const t = await fixture();
    if (target === 'header') t.header.fullNumber = 'T999-3';
    if (target === 'receipt') (t.row.payload as GuideIssueReceipt).snapshotSha256 = 'f'.repeat(64);
    if (target === 'items') t.state.items[0].position = 2;
    if (target === 'event') t.state.events[0].eventType = 'document.issued.v1';
    await expect(t.store.transaction(t.scope, tx => tx.prior())).rejects.toMatchObject(inconsistent);
    expect(t.committed).toEqual([]);
  });
  it('checks draft physical ownership, series, payload hash and binding under FOR UPDATE', async () => {
    const t = await fixture(); expect(await t.store.transaction(t.scope, tx => tx.draft())).toEqual(t.f.draft);
    expect(t.calls.at(-1)?.text).toContain('FOR UPDATE OF d');
    (t.state.draft[0] as { guideSeriesId: string }).guideSeriesId = t.scope.binding.fiscalSeriesId;
    await expect(t.store.transaction(t.scope, tx => tx.draft())).rejects.toMatchObject(inconsistent);
  });
  it('atomically writes only counter and candidate aggregate with stable positions', async () => {
    const t = await fixture(); await t.commit();
    expect(t.committed.map(c => /(?:UPDATE|INSERT INTO) "([^"]+)"/.exec(c.text)?.[1])).toEqual([
      'SeriesCounter', 'B2bGuideIssueDocument', 'B2bGuideIssueItem', 'B2bGuideIssueReceipt', 'B2bGuideIssueLocalOutbox']);
    expect(t.committed[0].values.slice(0, 6)).toEqual([t.context.counter.id, t.scope.binding.draft.anchor.issuerId,
      t.scope.binding.draft.anchor.pointId, t.context.counter.masterRevision, t.receipt.snapshot.number, t.receipt.snapshot.series]);
    expect(t.committed[2].values[1]).toBe(1);
    for (const c of t.calls) {
      const slots = [...new Set([...c.text.matchAll(/\$(\d+)\b/g)].map(m => Number(m[1])))].sort((a, b) => a - b);
      expect(slots).toEqual(c.values.map((_, i) => i + 1));
      expect(c.text).not.toMatch(/\b(?:CREATE|ALTER|DROP|TRUNCATE)\b/);
    }
  });
  it.each(['counter', 'issuer', 'stamp', 'draft'])('rejects divergent %s before counter writes', async target => {
    const t = await fixture();
    if (target === 'counter') t.context.counter.nextNumber = '2';
    if (target === 'issuer') t.context.issuer.legalName = 'OTHER';
    if (target === 'stamp') t.context.contextSha256 = 'd'.repeat(64);
    if (target === 'draft') (t.state.draft[0] as { revision: number }).revision++;
    await expect(t.commit()).rejects.toMatchObject(inconsistent); expect(t.committed).toEqual([]);
    expect(t.calls.some(c => c.write)).toBe(false);
  });
  it('rejects a stale counter CAS without append or automatic renumber', async () => {
    const t = await fixture(); t.state.cas = 0;
    await expect(t.commit()).rejects.toMatchObject({ code: 'GUIDE_ISSUE_COUNTER_CONFLICT' });
    expect(t.transaction).toHaveBeenCalledTimes(1); expect(t.committed).toEqual([]);
  });
  it('rejects legacy fiscal collision across companies sharing a RUC without retry', async () => {
    const t = await fixture(); t.state.collision = [{ id: 'legacy' }];
    await expect(t.commit()).rejects.toMatchObject({ code: 'GUIDE_ISSUE_FISCAL_COLLISION' });
    expect(t.calls.some(c => c.write)).toBe(false); expect(t.transaction).toHaveBeenCalledTimes(1);
    const c = t.calls.find(c => c.text.includes('FROM "Document"'))!;
    expect(c.values).toEqual([t.receipt.snapshot.issuer.ruc, 'T001', '1']); expect(c.text).not.toMatch(/c\."id"\s*=\s*\$/);
  });
  it.each(['B2bGuideIssueDocument', 'B2bGuideIssueItem', 'B2bGuideIssueReceipt', 'B2bGuideIssueLocalOutbox'])('poisons swallowed append failure at %s', async table => {
    const t = await fixture(); t.hooks.sql = c => { if (c.text.includes(`INSERT INTO "${table}"`)) throw new Error('SYNTHETIC_DRIVER_PRIVATE'); };
    await expect(t.store.transaction(t.scope, async tx => { await tx.commit(t.receipt, t.context).catch(() => {}); })).rejects.toMatchObject({ status: 503, code: 'GUIDE_ISSUE_STORE_UNAVAILABLE' });
    expect(t.committed).toEqual([]);
  });
  it('also poisons swallowed errors through the context SQL port', async () => {
    const t = await fixture(); t.hooks.sql = c => { if (c.text.includes('context_probe')) throw new Error('SYNTHETIC_DRIVER_PRIVATE'); };
    await expect(t.store.transaction(t.scope, async tx => { await tx.sql.$queryRawUnsafe('SELECT context_probe').catch(() => {}); })).rejects.toMatchObject({ code: 'GUIDE_ISSUE_STORE_UNAVAILABLE' });
    expect(t.committed).toEqual([]);
  });
  it.each([{ code: '40001' }, { code: '40P01' }, { code: 'P2034' },
    { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '40P01' } } } }])('retries serialization/deadlock only, bounded to three attempts: %j', async error => {
    const t = await fixture(); t.commitErrors.push(error, error, error);
    await expect(t.store.transaction(t.scope, async () => 42)).rejects.toMatchObject({ code: 'GUIDE_ISSUE_STORE_UNAVAILABLE' });
    expect(t.transaction).toHaveBeenCalledTimes(3); expect(t.committed).toEqual([]);
  });
  it.each([{ code: '23505' }, { code: '42501' }, { code: '08006' }])('does not retry unique, permission or connection failures: %j', async error => {
    const t = await fixture(); t.commitErrors.push(error);
    const e = await t.commit().catch(e => e); expect(e).toBeInstanceOf(B2bSecurityError);
    expect(t.transaction).toHaveBeenCalledTimes(1); expect(t.committed).toEqual([]);
  });
  it('candidate DDL contains fiscal RUC uniqueness, relational membership, deferred completeness, freeze and truncate guards', () => {
    const ddl = readFileSync('services/billing-service/b2b-guide-issue-schema.candidate.sql', 'utf8');
    expect(ddl).toContain('UNIQUE ("issuerRuc","type","series","number")');
    expect(ddl.match(/DEFERRABLE INITIALLY DEFERRED FOR EACH ROW/g)).toHaveLength(4);
    expect(ddl).toContain('REFERENCES "B2bGuideIssueDocument"("id","operationId","clientId","actorKey")');
    expect(ddl).toContain('BEFORE UPDATE OR DELETE ON "B2bGuideDraft"');
    expect(ddl.match(/BEFORE TRUNCATE/g)).toHaveLength(6);
    expect(ddl).not.toMatch(/DISABLE TRIGGER|session_replication_role|CREATE EXTENSION/);
  });
});
