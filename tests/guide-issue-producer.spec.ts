import { describe, expect, it } from 'vitest';
import { BillingGuideIssueProducer, validateGuideIssueReceipt } from '../services/billing-service/src/b2b/guide-issue-producer';
import { fiscalSnapshotSha256 as hash } from '../packages/sunat-core/src/fiscal-note';
import { guideIssueFixture } from './helpers/guide-issue.fixture';
import { guideUuid } from './helpers/b2b-guide.fixture';

describe('guide issue owner-side local candidate', () => {
  it.each(['SERVICE', 'USER'] as const)('atomically stages a complete numbered guide for genuine %s provenance', async kind => {
    const f = guideIssueFixture(kind), r = await f.issue();
    expect(r.replayed).toBe(false); expect(r.receipt.actor.kind).toBe(kind);
    expect(r.receipt.snapshot.fullNumber).toBe('T001-1');
    expect(r.receipt.snapshot.body.items).toEqual(f.draft.body.items);
    expect(r.receipt.snapshot).toMatchObject({ candidateOnly: true, fiscalExecutionEnabled: false,
      transmissionAuthorized: false, authorizedForTransfer: false, officialRulesValidated: false,
      officialCdrVerified: false, numberReserved: true });
    expect(f.state()).toMatchObject({ next: 2, items: 1, events: 1 });
    expect(f.draft.state).toBe('READY');
    expect(r.receipt.actor.subjectId).toBe(kind === 'SERVICE' ? null : guideUuid(20));
  });
  it('recovers receipt across restarts without allocating twice', async () => {
    const f = guideIssueFixture(), a = await f.issue();
    const b = await f.restart().issue('synthetic-issue-token', 'SERVICE', f.request);
    expect(b).toEqual({ receipt: a.receipt, replayed: true });
    expect(f.state()).toMatchObject({ next: 2, items: 1, events: 1 }); expect(f.context.prepare).toHaveBeenCalledTimes(1);
  });
  it('deduplicates simultaneous same-key calls', async () => {
    const f = guideIssueFixture(), results = await Promise.all(Array.from({ length: 8 }, () => f.issue()));
    expect(results.filter(r => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map(r => r.receipt.id)).size).toBe(1); expect(f.state().next).toBe(2);
  });
  it('rejects a second key for an already numbered draft', async () => {
    const f = guideIssueFixture(); await f.issue();
    await expect(f.issue({ ...f.request, idempotencyKey: 'synthetic_issue_request_0002' })).rejects.toMatchObject({ code: 'GUIDE_ALREADY_PREPARED' });
    expect(f.state().next).toBe(2);
  });
  it('does not confuse changed revision with an idempotent retry', async () => {
    const f = guideIssueFixture(); await f.issue();
    await expect(f.issue({ ...f.request, expectedRevision: '"v3"' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it.each(['afterWrite', 'beforeCommit'] as const)('rolls back every staged write on %s failure', async hook => {
    const f = guideIssueFixture(); f.hooks[hook] = () => { throw new Error('SYNTHETIC_FAULT'); };
    await expect(f.issue()).rejects.toThrow('SYNTHETIC_FAULT');
    expect(f.state()).toEqual({ next: 1, receipts: [], documents: [], items: 0, events: 0 });
  });
  it('revocation after local writes rolls back the reservation', async () => {
    const f = guideIssueFixture(); f.hooks.afterWrite = () => { f.control.revoked = true; };
    await expect(f.issue()).rejects.toMatchObject({ status: 401 }); expect(f.state().next).toBe(1);
  });
  it('revocation after commit keeps number spent and permits authorized recovery', async () => {
    const f = guideIssueFixture(); f.hooks.afterCommit = () => { f.control.revoked = true; };
    await expect(f.issue()).rejects.toMatchObject({ status: 401 }); expect(f.state().next).toBe(2);
    delete f.hooks.afterCommit; f.control.revoked = false;
    expect((await f.issue()).replayed).toBe(true); expect(f.state().next).toBe(2);
  });
  it('rechecks a changed grant inside the transaction before touching state', async () => {
    const f = guideIssueFixture(); f.hooks.before = () => { f.proof.grantRevision++; };
    await expect(f.issue()).rejects.toMatchObject({ code: 'GUIDE_ISSUE_AUTHORIZATION_CHANGED' }); expect(f.state().next).toBe(1);
  });
  it('does not let output mutation corrupt persisted immutable history', async () => {
    const f = guideIssueFixture(), a = await f.issue(); a.receipt.snapshot.body.items[0].description = 'MUTATED';
    expect((await f.issue()).receipt.snapshot.body.items[0].description).toBe('BIEN FICTICIO');
  });
  it('requires explicit per-RUC activation even with an issue grant', async () => {
    const f = guideIssueFixture(), core = new BillingGuideIssueProducer(f.store, f.authority, f.context, { allowedRucs: [] });
    await expect(core.issue('synthetic', 'SERVICE', f.request)).rejects.toMatchObject({ code: 'GUIDE_ISSUE_ISSUER_NOT_ENABLED' });
    expect(f.store.transaction).not.toHaveBeenCalled();
  });
  it.each([null, {}, { allowedRucs: ['invalid'] }, { allowedRucs: Array(101).fill('20000000001') }])('rejects invalid constructor options %#', options => {
    const f = guideIssueFixture(); expect(() => new BillingGuideIssueProducer(f.store, f.authority, f.context, options as never)).toThrow();
  });
  it.each(['', ' ', 'a'.repeat(8193), 'line\nbreak'])('rejects malformed tokens %#', async token => {
    const f = guideIssueFixture(); await expect(f.core.issue(token, 'SERVICE', f.request)).rejects.toMatchObject({ status: 401 });
  });
  it.each([
    (v: any) => { v.number = '1'; }, (v: any) => { v.binding.draft.anchor.environment = 'PRODUCTION'; },
    (v: any) => { v.binding.fiscalSeriesId = v.binding.draft.guideSeriesId; }, (v: any) => { v.expectedRevision = 'v2'; },
    (v: any) => { v.idempotencyKey = 'short'; }, (v: any) => { v.draftId = '../other'; },
    (v: any) => { delete v.expectedRevision; }, (v: any) => { v.schemaVersion = 'future'; },
  ])('rejects malformed or caller-numbered commands %#', async mutate => {
    const f = guideIssueFixture(), v = structuredClone(f.request); mutate(v);
    await expect(f.issue(v)).rejects.toMatchObject({ status: 400 }); expect(f.authority.current).not.toHaveBeenCalled();
  });
  it.each([
    (p: any) => { delete p.capability; }, (p: any) => { p.capability = 'WRITE'; },
    (p: any) => { p.actor.scope.kind = 'GLOBAL'; }, (p: any) => { p.actor.scope.series.pop(); },
    (p: any) => { p.actor.scope.series.push(guideUuid(99)); }, (p: any) => { p.actor.userId = guideUuid(20); },
    (p: any) => { p.binding.fiscalSeriesId = guideUuid(99); }, (p: any) => { p.clientRevision++; },
    (p: any) => { p.grantRevision = 0; }, (p: any) => { p.actor.b2b.kind = 'USER'; },
  ])('rejects inherited draft grants, fabricated identity or mismatched issue scopes %#', async mutate => {
    const f = guideIssueFixture(); mutate(f.proof);
    await expect(f.issue()).rejects.toMatchObject({ status: 503 }); expect(f.store.transaction).not.toHaveBeenCalled();
  });
  it.each(['DRAFT', 'CANCELLED'] as const)('requires READY not %s', async state => {
    const f = guideIssueFixture(); f.draft.state = state;
    await expect(f.issue()).rejects.toMatchObject({ code: 'READY_GUIDE_REQUIRED' }); expect(f.state().next).toBe(1);
  });
  it.each(['clientId', 'actorKey', 'id'] as const)('hides foreign drafts with changed %s', async key => {
    const f = guideIssueFixture(); f.draft[key] = guideUuid(99);
    await expect(f.issue()).rejects.toMatchObject({ status: 404 }); expect(f.context.prepare).not.toHaveBeenCalled();
  });
  it('rejects stale revision before context reads', async () => {
    const f = guideIssueFixture(); f.draft.revision++;
    await expect(f.issue()).rejects.toMatchObject({ status: 412 }); expect(f.context.prepare).not.toHaveBeenCalled();
  });
  it.each([
    (d: any) => { d.body.regulatedGoods = true; d.bodySha256 = hash(d.body); },
    (d: any) => { d.body.reasonCode = '01'; d.bodySha256 = hash(d.body); },
    (d: any) => { d.bodySha256 = '0'.repeat(64); },
    (d: any) => { d.body.items[0].quantity = '0'; d.bodySha256 = hash(d.body); },
  ])('fails closed for invalid or unsupported body/profile %#', async mutate => {
    const f = guideIssueFixture(); mutate(f.draft);
    await expect(f.issue()).rejects.toMatchObject({ code: 'GUIDE_ISSUE_PROFILE_INVALID' }); expect(f.state().next).toBe(1);
  });
  it.each(['0', '01', '100000000', '-1'])('rejects out-of-range/noncanonical counter %s', async nextNumber => {
    const f = guideIssueFixture(), c = await f.context.prepare(); c.counter.nextNumber = nextNumber; f.context.prepare.mockResolvedValue(c);
    await expect(f.issue()).rejects.toMatchObject({ code: 'INVALID_GUIDE_ISSUE_CONTEXT' }); expect(f.state().next).toBe(1);
  });
  it('permits the final number without implicit wrap/reset', async () => {
    const f = guideIssueFixture(), c = await f.context.prepare(); c.counter.nextNumber = '99999999'; f.context.prepare.mockResolvedValue(c);
    expect((await f.issue()).receipt.snapshot.number).toBe('99999999');
  });
  it.each(['2026-10-20T00:00:00.000Z', 'not-a-date'])('does not issue with invalid/backwards clock %s', async at => {
    const f = guideIssueFixture(); f.control.at = at;
    await expect(f.issue()).rejects.toMatchObject({ code: 'INVALID_GUIDE_ISSUE_CLOCK' }); expect(f.state().next).toBe(1);
  });
  it.each(['body', 'flag', 'number', 'scope', 'actor', 'hash'] as const)('validates stored receipt against %s tampering even with recalculated digest', async change => {
    const f = guideIssueFixture(), { receipt } = await f.issue(), r = structuredClone(receipt);
    if (change === 'body') r.snapshot.body.items[0].quantity = '0';
    if (change === 'flag') (r.snapshot as any).authorizedForTransfer = true;
    if (change === 'number') r.snapshot.fullNumber = 'T001-2';
    if (change === 'scope') r.snapshot.binding.fiscalSeriesId = guideUuid(99);
    if (change === 'actor') r.actor.subjectId = guideUuid(20);
    r.snapshotSha256 = change === 'hash' ? 'a'.repeat(64) : hash(r.snapshot);
    const scope = { binding: f.binding, draftId: f.request.draftId, clientId: r.clientId, actorKey: r.actorKey, keySha256: r.keySha256 };
    expect(() => validateGuideIssueReceipt(r, scope)).toThrow('GUIDE_ISSUE_RECEIPT_INCONSISTENT');
  });
});
