import { describe, expect, it, vi } from 'vitest';
import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { buildFiscalBatchSnapshot, buildFiscalBatchUbl } from '../packages/sunat-core/src/fiscal-batch';
import { buildFiscalNoteSnapshot, fiscalSnapshotSha256, type FiscalNoteSnapshot } from '../packages/sunat-core/src/fiscal-note';
import { buildFiscalSupplementCommand, validateFiscalSupplementCommand } from '../packages/sunat-core/src/fiscal-supplement-command';
import {
  B2bBatchMemberAuthority, type BatchMemberGrant, type BatchMemberOwnerPort, type BatchMemberPlan,
  type BatchMemberRequest, type BatchOwnerMember, type BatchPrepared, type BatchSubject,
} from '../services/billing-service/src/b2b/batch-member-authority';
import { createBillingBatchMemberProducer } from '../services/billing-service/src/b2b/batch-member-producer-assembly';
import { acceptance, actor, asOf, fixture as ownerFixture, uuid } from './b2b-batch-member-authority.fixture';

type Fixture = ReturnType<typeof fixture>;
const user: BatchSubject = { kind: 'USER', clientId: actor.clientId, subjectId: uuid(6000) };
const key = (row: BatchOwnerMember) => `${row.member.documentId}/${row.member.version}`;
const clone = <T>(v: T): T => structuredClone(v);
function fixture(kind: 'RC' | 'RA' = 'RC', count = 2) {
  const f = ownerFixture(kind, count), previous = f.previous;
  // Complete the interrupted fixture locally: originals must be accepted BEFORE
  // notes issue, and optional tax fields must be serialized as persisted JSON.
  f.previous = (...args) => {
    const result = previous(...args);
    result.current.snapshot = JSON.parse(JSON.stringify(result.current.snapshot));
    result.current.member.snapshotSha256 = fiscalSnapshotSha256(result.current.snapshot);
    result.current.notDelivered!.snapshotSha256 = result.current.member.snapshotSha256;
    return result;
  };
  f.note = (n = 100, history = []) => {
    const originalId = uuid(90000), originalSnapshot = clone(f.roots[0].snapshot);
    Object.assign(originalSnapshot, { documentId: originalId, number: '90000', fullNumber: `${originalSnapshot.series}-90000` });
    const proof = acceptance(originalSnapshot); proof.acceptedAt = '2026-10-02T16:10:00Z';
    const original = f.rows.get(`${originalId}/1`) ?? f.add(originalSnapshot, 1, { reporting: 'REPORTED', acceptance: proof });
    const context = { original: original.snapshot, acceptance: original.acceptance!, asOf,
      creditHistory: { complete: true as const, entries: history.map(h => ({ state: 'RESERVED' as const, note: h.snapshot as FiscalNoteSnapshot })) } };
    const snapshot = buildFiscalNoteSnapshot(context, { documentTypeCode: '07', reasonCode: '07', reasonDescription: 'DEVOLUCION SINTETICA',
      lines: [{ originalLineNumber: 1, quantity: '0.5' }] },
    { documentId: uuid(n), series: kind === 'RC' ? 'BC01' : 'FC01', number: String(n), issueDate: '2026-10-02T17:00:00Z' });
    return f.add(snapshot, 1, { note: { original: original.member, historyRevision: 1,
      creditHistory: history.map(h => ({ member: h.member, state: 'RESERVED' })) } });
  };
  return f;
}
function untouched(f: Fixture) {
  expect(f.state).toEqual({ writes: [], numbers: 0, commits: 0 }); expect(f.journals.size).toBe(0);
}
function reservations(f: Fixture) {
  const reserve = vi.fn(), append = vi.fn();
  const transaction = f.transaction.getMockImplementation()!;
  f.transaction.mockImplementation((plan, work) => transaction(plan, async tx => {
    const original = tx.reserveIdentity.bind(tx), journal = tx.appendJournal.bind(tx);
    tx.reserveIdentity = async p => { reserve(p); return original(p); };
    tx.appendJournal = async j => { append(j); return journal(j); };
    return work(tx);
  }));
  return { reserve, append };
}
function grants(f: Fixture, transform: (g: BatchMemberGrant, row: BatchOwnerMember) => void) {
  const authorize = f.authorize.getMockImplementation()!;
  f.authorize.mockImplementation(async (s, row, p) => {
    const grant = await authorize(s, row, p); transform(grant, row); return grant;
  });
}
function noteBatch(kind: 'RC' | 'RA') {
  const f = fixture(kind, 1), accepted = f.note(100), reserved = f.note(101, [accepted]);
  accepted.reporting = 'REPORTED'; accepted.acceptance = acceptance(accepted.snapshot);
  reserved.reporting = 'UNREPORTED'; reserved.acceptance = null;
  reserved.note!.creditHistory[0].state = 'ACCEPTED';
  const current = f.note(102, [accepted, reserved]); current.note!.creditHistory[0].state = 'ACCEPTED';
  f.request.entries = (kind === 'RC' ? [{ member: current.member, conditionCode: '1' }]
    : [{ member: current.member, reasonDescription: 'NO ENTREGADO SINTETICO' }]) as typeof f.request.entries;
  return { ...f, accepted, reserved, current, original: f.rows.get(`${uuid(90000)}/1`)! };
}
const write = vi.fn(async (tx: { write(label: string): void }, prepared: BatchPrepared, checkpoint: () => Promise<void>) => {
  await checkpoint(); tx.write(prepared.command.payload.operationKind); return { stored: prepared.command.payload.operationId };
});

describe('Whole-member RC/RA authority with real fiscal core, synthetic owner only', () => {
  it.each(['RC', 'RA'] as const)('%s validates every member before its single atomic producer callback', async kind => {
    const f = fixture(kind, 3), { reserve, append } = reservations(f), callback = vi.fn(write.getMockImplementation()!);
    const plan = await f.adapter.plan(f.request, actor);
    expect(f.authorize).toHaveBeenCalledWith(actor, expect.anything(), 'WRITE', kind);
    expect(f.transaction).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
    expect(plan.members).toHaveLength(3); expect(Object.isFrozen(plan.members[0].record.snapshot)).toBe(true);
    const result = await f.adapter.coordinate(plan, 'CREATE', callback);
    expect(callback).toHaveBeenCalledTimes(1); expect(reserve).toHaveBeenCalledTimes(1); expect(append).toHaveBeenCalledTimes(1);
    expect(f.state).toEqual({ writes: [kind], numbers: 1, commits: 1 });
    const prepared = callback.mock.calls[0][1], envelope = prepared.command.payload.envelope;
    expect(envelope.kind).toBe('BATCH'); if (envelope.kind !== 'BATCH') throw new Error('batch required');
    expect(envelope.batch.input).toEqual(plan.input);
    const { documentId, identifier, issueDate, referenceDate } = envelope.batch;
    expect(buildFiscalBatchSnapshot(envelope.batch.input, { documentId, identifier, issueDate, referenceDate }, asOf)).toEqual(envelope.batch);
    expect(buildFiscalBatchUbl(envelope.batch, asOf)).toBe(prepared.ubl);
    expect(prepared.ubl).toContain(kind === 'RC' ? 'SummaryDocumentsLine' : 'VoidedDocumentsLine');
    expect(validateFiscalSupplementCommand(prepared.command)).toEqual(prepared.command);
    expect(result).toMatchObject({ reused: false, candidateOnly: true, localOnly: true,
      fiscalExecutionEnabled: false, transmissionAuthorized: false, officialAcceptance: false });
    for (const row of f.roots) {
      expect(f.authorize.mock.calls.filter(c => c[1].member.documentId === row.member.documentId).length).toBeGreaterThan(2);
    }
  });

  it('RC mixed 1/2/3 binds exact historical versions and owner acceptance without copying caller proofs', async () => {
    const f = fixture('RC', 3); const modified = f.previous(1, '2'), voided = f.previous(2, '3');
    const plan = await f.adapter.plan(f.request, user);
    expect(plan.members).toHaveLength(5);
    if (plan.input.kind !== 'RC') throw new Error('RC required');
    expect(plan.input.entries.map(e => e.conditionCode)).toEqual(['1', '2', '3']);
    const second = plan.input.entries[1], third = plan.input.entries[2];
    if (second.conditionCode !== '2' || third.conditionCode !== '3') throw new Error('previous required');
    expect(second.previous.acceptance).toEqual(modified.old.acceptance);
    expect(second.document.snapshot.totals.payableAmount).not.toBe(second.previous.document.snapshot.totals.payableAmount);
    expect(third.previous.acceptance).toEqual(voided.old.acceptance);
    expect(third.document.snapshot).toEqual(third.previous.document.snapshot);
    const result = await f.adapter.coordinate(plan, 'CREATE', write.getMockImplementation());
    expect(result.journal.command.payload.operationKind).toBe('RC');
    expect(f.authorize.mock.calls.every(c => c[2] === 'WRITE')).toBe(true);
  });

  it.each(['RC', 'RA'] as const)('%s authorizes original plus all accepted/reserved history and uses owner proofs', async kind => {
    const f = noteBatch(kind), plan = await f.adapter.plan(f.request, user);
    expect(new Set(plan.members.map(m => key(m.record)))).toEqual(new Set([f.current, f.accepted, f.reserved, f.original].map(key)));
    const context = plan.input.entries[0].document.noteContext!;
    expect(context.original).toEqual(f.original.snapshot); expect(context.acceptance).toEqual(f.original.acceptance);
    expect(context.creditHistory).toEqual({ complete: true, entries: [
      { state: 'ACCEPTED', note: f.accepted.snapshot }, { state: 'RESERVED', note: f.reserved.snapshot },
    ] });
    await f.adapter.coordinate(plan, 'CREATE', write.getMockImplementation());
    for (const row of [f.current, f.accepted, f.reserved, f.original]) {
      expect(f.authorize.mock.calls.some(c => key(c[1]) === key(row) && c[2] === 'WRITE')).toBe(true);
    }
  });

  it.each(['RC', 'RA'] as const)('%s rejects a denied last member before transaction or allocation', async kind => {
    const f = fixture(kind, 3); f.deny(f.roots[2].member);
    await expect(f.adapter.plan(f.request, actor)).rejects.toMatchObject({ code: 'BATCH_MEMBER_DENIED' });
    expect(f.transaction).not.toHaveBeenCalled(); untouched(f);
  });

  it.each(['original', 'accepted', 'reserved'] as const)('cannot skip WRITE permission for the %s dependency', async dependency => {
    const f = noteBatch('RC'); f.deny(f[dependency].member);
    await expect(f.adapter.plan(f.request, user)).rejects.toMatchObject({ code: 'BATCH_MEMBER_DENIED' }); untouched(f);
  });

  it('cannot skip the historical previous-version grant', async () => {
    const f = fixture('RC'); const { old } = f.previous(1, '2'); f.deny(old.member);
    await expect(f.adapter.plan(f.request, actor)).rejects.toMatchObject({ code: 'BATCH_MEMBER_DENIED' }); untouched(f);
  });

  it.each(['missing', 'hash', 'rejected', 'source', 'future'] as const)('accepted history needs owner acceptance: %s', async scenario => {
    const f = noteBatch('RC'), proof = f.accepted.acceptance!;
    if (scenario === 'missing') f.accepted.acceptance = null;
    if (scenario === 'hash') proof.snapshotSha256 = 'b'.repeat(64);
    if (scenario === 'rejected') (proof as unknown as { status: string }).status = 'REJECTED';
    if (scenario === 'source') proof.source = { kind: 'CDR_DOCUMENT' };
    if (scenario === 'future') proof.acceptedAt = '2026-10-04T18:00:00Z';
    await expect(f.adapter.plan(f.request, actor)).rejects.toMatchObject({ code: scenario === 'missing' ? 'INVALID_BATCH_OWNER' : 'BATCH_CORE_REJECTED' }); untouched(f);
  });

  it.each(['missing', 'hash', 'source'] as const)('RC previous-version accepted proof is mandatory and bound: %s', async scenario => {
    const f = fixture('RC'); const { old } = f.previous(1, '2');
    if (scenario === 'missing') old.acceptance = null;
    if (scenario === 'hash') old.acceptance!.snapshotSha256 = 'f'.repeat(64);
    if (scenario === 'source') old.acceptance!.source = { kind: 'CDR_DOCUMENT' };
    await expect(f.adapter.plan(f.request, actor)).rejects.toBeInstanceOf(B2bSecurityError); untouched(f);
  });

  it.each(['missing', 'hash', 'future', 'delivered'] as const)('RA validates actual owner acceptance and non-delivery: %s', async scenario => {
    const f = fixture('RA'), row = f.roots[1];
    if (scenario === 'missing') row.acceptance = null;
    if (scenario === 'hash') row.acceptance!.snapshotSha256 = 'f'.repeat(64);
    if (scenario === 'future') row.notDelivered!.assertedAt = '2026-10-04T18:00:00Z';
    if (scenario === 'delivered') (row.notDelivered as unknown as { status: string }).status = 'DELIVERED';
    await expect(f.adapter.plan(f.request, user)).rejects.toBeInstanceOf(B2bSecurityError); untouched(f);
  });

  it.each(['omitted', 'cycle', 'wrong-original', 'over-capacity'] as const)('rebuilds complete ordered fiscal history: %s', async scenario => {
    const f = noteBatch('RC');
    if (scenario === 'omitted') f.current.note!.creditHistory.pop();
    if (scenario === 'cycle') f.reserved.note!.creditHistory.push({ member: f.current.member, state: 'RESERVED' });
    if (scenario === 'wrong-original') f.current.note!.original = f.current.member;
    if (scenario === 'over-capacity') {
      const third = f.note(103, [f.accepted, f.reserved]), fourth = f.note(104, [f.accepted, f.reserved, third]);
      // Independently valid snapshots together exceed the same original's capacity.
      f.request = { ...f.request, kind: 'RC', entries: [f.current, third, fourth].map(r => ({ member: r.member, conditionCode: '1' })) };
    }
    await expect(f.adapter.plan(f.request, actor)).rejects.toBeInstanceOf(B2bSecurityError); untouched(f);
  });

  it.each(['environment', 'issuerRuc', 'companyId', 'branchId', 'pointId', 'seriesId', 'series', 'documentType', 'client', 'user', 'permission'] as const)(
    'grant must match the complete concrete member tuple and actor: %s', async field => {
      const f = fixture();
      grants(f, (g, row) => {
        if (row.member.documentId !== f.roots[1].member.documentId) return;
        if (field === 'client') g.subject.clientId = uuid(6999);
        else if (field === 'user') g.subject.subjectId = uuid(6999);
        else if (field === 'permission') g.permission = 'READ';
        else Object.assign(g.binding, { [field]: field === 'companyId' ? 101 : field === 'environment' ? 'PROD' : 'wrong' });
      });
      await expect(f.adapter.plan(f.request, user)).rejects.toMatchObject({ code: 'BATCH_MEMBER_DENIED' }); untouched(f);
    });

  it.each(['environment', 'issuerRuc', 'companyId', 'branchId'] as const)('owner member cannot escape batch %s', async field => {
    const f = fixture(); Object.assign(f.roots[1].binding, { [field]: field === 'companyId' ? 2 : field === 'environment' ? 'PROD' : field === 'branchId' ? uuid(9) : '20131312955' });
    await expect(f.adapter.plan(f.request, actor)).rejects.toBeInstanceOf(B2bSecurityError); untouched(f);
  });

  it.each(['read', 'clone', 'other-instance'] as const)('plans are private write capabilities: %s', async scenario => {
    const f = fixture(), plan = await f.adapter.plan(f.request, actor, scenario === 'read' ? 'READ' : 'WRITE');
    const adapter = scenario === 'other-instance' ? new B2bBatchMemberAuthority(f.owner, () => asOf) : f.adapter;
    await expect(adapter.coordinate(scenario === 'clone' ? clone(plan) : plan, 'CREATE', write.getMockImplementation()))
      .rejects.toMatchObject({ code: 'BATCH_PLAN_REQUIRED' }); untouched(f);
  });

  it('READ grants cannot be promoted to a WRITE plan', async () => {
    const f = fixture(); f.readOnly();
    await expect(f.adapter.plan(f.request, user, 'READ')).resolves.toMatchObject({ permission: 'READ' });
    await expect(f.adapter.plan(f.request, user, 'WRITE')).rejects.toMatchObject({ code: 'BATCH_MEMBER_DENIED' }); untouched(f);
  });

  it.each(['accepted', 'acceptance', 'complete', 'grant', 'officialAcceptance'] as const)('caller %s flags cannot authorize a batch', async flag => {
    const f = fixture();
    await expect(f.adapter.plan({ ...f.request, [flag]: true }, actor)).rejects.toMatchObject({ code: 'INVALID_BATCH_REQUEST' });
    const request = clone(f.request); Object.assign(request.entries[0], { [flag]: true });
    await expect(f.adapter.plan(request, actor)).rejects.toMatchObject({ code: 'INVALID_BATCH_REQUEST' }); untouched(f);
  });

  it.each(['duplicate', 'empty', 'too-many', 'date', 'previous-id', 'version', 'hash'] as const)('rejects malformed bounded requests: %s', async scenario => {
    const f = fixture(); const request = clone(f.request) as BatchMemberRequest & { kind: 'RC' };
    if (scenario === 'duplicate') request.entries.push(clone(request.entries[0]));
    if (scenario === 'empty') request.entries = [];
    if (scenario === 'too-many') request.entries = Array.from({ length: 101 }, () => clone(request.entries[0]));
    if (scenario === 'date') request.issueDate = '2026-02-30';
    if (scenario === 'previous-id') request.entries[0] = { conditionCode: '2', member: request.entries[0].member, previous: f.roots[1].member };
    if (scenario === 'version') request.entries[0].member.version = 0;
    if (scenario === 'hash') request.entries[0].member.snapshotSha256 = 'caller-hash';
    await expect(f.adapter.plan(request, actor)).rejects.toMatchObject({ code: 'INVALID_BATCH_REQUEST' }); untouched(f);
  });

  it('bounds the full dependency closure, not just selected entries', async () => {
    const f = fixture('RC', 100), note = f.note(1000);
    if (f.request.kind !== 'RC') throw new Error('RC required');
    f.request.entries[99] = { member: note.member, conditionCode: '1' };
    await expect(f.adapter.plan(f.request, actor)).rejects.toMatchObject({ code: 'INVALID_BATCH_OWNER' }); untouched(f);
  });

  it.each(['member', 'client', 'grant', 'user'] as const)('double-read preflight detects changing %s revisions', async field => {
    const f = fixture(); let calls = 0;
    grants(f, (g, row) => {
      if (++calls <= f.roots.length) return;
      if (field === 'member') f.roots[0].revision++;
      if (field === 'client') g.clientRevision++;
      if (field === 'grant') g.grantRevision++;
      if (field === 'user') g.userAuthRevision = 2;
    });
    // Trigger member mutation before the second owner's read, not after it.
    if (field === 'member') { let reads = 0; f.onMember(() => { if (++reads === 3) f.roots[0].revision++; }); }
    await expect(f.adapter.plan(f.request, user)).rejects.toBeInstanceOf(B2bSecurityError); untouched(f);
  });

  it.each(['RC', 'RA'] as const)('%s rechecks a revocation between preflight and allocation', async kind => {
    const f = fixture(kind), { reserve } = reservations(f), callback = vi.fn();
    const plan = await f.adapter.plan(f.request, user); f.onJournal(() => f.revoke());
    await expect(f.adapter.coordinate(plan, 'CREATE', callback)).rejects.toMatchObject({ code: 'BATCH_AUTHORITY_CHANGED' });
    expect(reserve).not.toHaveBeenCalled(); expect(callback).not.toHaveBeenCalled(); untouched(f);
  });

  it.each(['client', 'user', 'deny', 'read-only'] as const)('rejects %s authority changes before allocating any identity', async field => {
    const f = fixture('RA'), { reserve } = reservations(f), callback = vi.fn(), plan = await f.adapter.plan(f.request, user);
    f.onJournal(() => {
      if (field === 'client') f.changeClient();
      if (field === 'user') grants(f, g => { g.userAuthRevision = 2; });
      if (field === 'deny') f.deny(f.roots[1].member);
      if (field === 'read-only') f.readOnly();
    });
    await expect(f.adapter.coordinate(plan, 'CREATE', callback)).rejects.toMatchObject({
      code: field === 'deny' || field === 'read-only' ? 'BATCH_MEMBER_DENIED' : 'BATCH_AUTHORITY_CHANGED',
    });
    expect(reserve).not.toHaveBeenCalled(); expect(callback).not.toHaveBeenCalled(); untouched(f);
  });

  it('rejects a stale or nonhistorical RC2 predecessor and a newer RC3 predecessor', async () => {
    for (const scenario of ['nonhistorical', 'equal-version', 'newer-void']) {
      const f = fixture('RC'), { old, current } = f.previous(1, scenario === 'newer-void' ? '3' : '2');
      if (scenario === 'nonhistorical') old.lifecycle = 'CURRENT';
      if (scenario === 'equal-version') current.member.version = old.member.version;
      if (scenario === 'newer-void') old.member.version = current.member.version + 1;
      await expect(f.adapter.plan(f.request, user)).rejects.toBeInstanceOf(B2bSecurityError); untouched(f);
    }
  });

  it.each(['snapshot', 'version', 'ownerRevision', 'historyRevision', 'history', 'acceptance', 'delivery', 'point', 'series'] as const)(
    'transaction fences reject changed %s before allocation', async field => {
      const f = noteBatch('RA'), { reserve } = reservations(f), plan = await f.adapter.plan(f.request, user);
      if (field === 'snapshot') f.current.snapshot.customer.legalName = 'OWNER CHANGED';
      if (field === 'version') f.current.member.version++;
      if (field === 'ownerRevision') f.current.revision++;
      if (field === 'historyRevision') f.current.note!.historyRevision++;
      if (field === 'history') f.current.note!.creditHistory.pop();
      if (field === 'acceptance') f.original.acceptance!.cdrSha256 = 'b'.repeat(64);
      if (field === 'delivery') f.current.notDelivered!.evidenceId = uuid(8000);
      if (field === 'point') f.current.binding.pointId = uuid(8000);
      if (field === 'series') f.current.binding.seriesId = uuid(8000);
      await expect(f.adapter.coordinate(plan, 'CREATE', write.getMockImplementation())).rejects.toBeInstanceOf(B2bSecurityError);
      expect(reserve).not.toHaveBeenCalled(); untouched(f);
    });

  it.each(['client', 'grant', 'user', 'deny', 'read-only'] as const)('live authority %s changes roll back producer writes, number and journal', async field => {
    const f = fixture('RA'), plan = await f.adapter.plan(f.request, user);
    await expect(f.adapter.coordinate(plan, 'CREATE', async tx => {
      tx.write('STAGED');
      if (field === 'client') f.changeClient();
      if (field === 'grant') f.revoke();
      if (field === 'user') grants(f, g => { g.userAuthRevision = 2; });
      if (field === 'deny') f.deny(f.roots[1].member);
      if (field === 'read-only') f.readOnly();
      return { attempted: true };
    })).rejects.toBeInstanceOf(B2bSecurityError); untouched(f);
  });

  it('history phantom appearing inside the atomic callback rolls back every staged write', async () => {
    const f = noteBatch('RC'), plan = await f.adapter.plan(f.request, user);
    await expect(f.adapter.coordinate(plan, 'CREATE', async tx => {
      tx.write('FIRST'); tx.write('LAST'); f.current.note!.historyRevision++; return null;
    })).rejects.toMatchObject({ code: 'BATCH_MEMBER_CHANGED' }); untouched(f);
  });

  it('runs a live compare-and-lock fence, including after journal append', async () => {
    const f = fixture(), { append } = reservations(f), plan = await f.adapter.plan(f.request, actor);
    f.onFence(() => { if (append.mock.calls.length) f.roots[1].revision++; });
    await expect(f.adapter.coordinate(plan, 'CREATE', write.getMockImplementation())).rejects.toMatchObject({ code: 'BATCH_OWNER_UNAVAILABLE' });
    expect(append).toHaveBeenCalledTimes(1); untouched(f);
  });

  it.each(['expired', 'future', 'stale-grant'] as const)('keeps freshness fences live: %s', async scenario => {
    const f = fixture();
    if (scenario === 'future') f.request.asOf = '2026-10-03T18:00:01Z';
    if (scenario === 'stale-grant') grants(f, g => { g.checkedAt = '2026-10-03T17:59:29Z'; });
    if (scenario === 'expired') {
      const plan = await f.adapter.plan(f.request, actor); f.setTime('2026-10-03T18:00:31Z');
      await expect(f.adapter.coordinate(plan, 'CREATE', write.getMockImplementation())).rejects.toMatchObject({ code: 'BATCH_EXPIRED' });
    } else await expect(f.adapter.plan(f.request, actor)).rejects.toMatchObject({ code: 'BATCH_EXPIRED' });
    untouched(f);
  });

  it('callback expiration and thrown private errors roll back and expose only finite codes', async () => {
    for (const expire of [false, true]) {
      const f = fixture(), plan = await f.adapter.plan(f.request, actor);
      await expect(f.adapter.coordinate(plan, 'CREATE', async tx => {
        tx.write('STAGED'); if (expire) { f.setTime('2026-10-03T18:00:31Z'); return null; }
        throw new Error('PRIVATE SQL/credential detail');
      })).rejects.toMatchObject({ message: expire ? 'BATCH_EXPIRED' : 'BATCH_OWNER_UNAVAILABLE' }); untouched(f);
    }
  });

  it('rejects escaped and overlapping checkpoints even when callback catches the rejection', async () => {
    const f = fixture(); let escaped!: () => Promise<void>;
    await f.adapter.coordinate(await f.adapter.plan(f.request, actor), 'CREATE', async (_tx, _p, checkpoint) => { escaped = checkpoint; return null; });
    await expect(escaped()).rejects.toMatchObject({ code: 'BATCH_CALLBACK_CLOSED' });
    const other = fixture();
    await expect(other.adapter.coordinate(await other.adapter.plan(other.request, actor), 'CREATE', async (tx, _p, checkpoint) => {
      tx.write('STAGED'); await Promise.allSettled([checkpoint(), checkpoint()]); return null;
    })).rejects.toMatchObject({ code: 'BATCH_CALLBACK_REENTRY' }); untouched(other);
  });

  it('rejects owner callback retries and closes a callback retained beyond transaction return', async () => {
    const f = fixture(); f.doubleCallback();
    await expect(f.adapter.coordinate(await f.adapter.plan(f.request, actor), 'CREATE', write.getMockImplementation()))
      .rejects.toMatchObject({ code: 'BATCH_CALLBACK_REENTRY' }); untouched(f);
    const other = fixture(), plan = await other.adapter.plan(other.request, actor);
    let delayed!: (tx: never) => Promise<unknown>;
    other.owner.transaction = async (_p, callback) => { delayed = callback as typeof delayed; return undefined as never; };
    await expect(other.adapter.coordinate(plan, 'CREATE', write.getMockImplementation())).rejects.toMatchObject({ code: 'BATCH_CALLBACK_CLOSED' });
    await expect(delayed({} as never)).rejects.toMatchObject({ code: 'BATCH_CALLBACK_CLOSED' }); untouched(other);
  });

  it.each(['RC', 'RA'] as const)('%s ambiguous commit reply requires journal reuse with zero producer resends', async kind => {
    const f = noteBatch(kind), { reserve } = reservations(f), callback = vi.fn(write.getMockImplementation()!);
    f.loseReply();
    await expect(f.adapter.coordinate(await f.adapter.plan(f.request, user), 'CREATE', callback)).rejects.toMatchObject({ code: 'BATCH_OWNER_UNAVAILABLE' });
    const command = clone(f.journals.get(f.request.idempotencyKey)!.command);
    expect(f.state.numbers).toBe(1); expect(callback).toHaveBeenCalledTimes(1);
    await expect(f.adapter.coordinate(await f.adapter.plan(f.request, user), 'CREATE', callback)).rejects.toMatchObject({ code: 'BATCH_REUSE_REQUIRED' });
    // Recovery after a fresh challenge must also work for noteContext.asOf.
    const later = '2026-10-03T18:01:00Z'; f.setTime(later); f.request.asOf = later;
    const reused = await f.adapter.coordinate(await f.adapter.plan(f.request, user), 'REUSE_JOURNAL');
    expect(reused.reused).toBe(true); expect(reused.journal.command).toEqual(command);
    expect(reserve).toHaveBeenCalledTimes(1); expect(callback).toHaveBeenCalledTimes(1); expect(f.state.writes).toHaveLength(1);
  });

  it('failed/consumed plans cannot run again; absent journal recovery never allocates or produces', async () => {
    const f = fixture(), { reserve } = reservations(f), plan = await f.adapter.plan(f.request, actor);
    await expect(f.adapter.coordinate(plan, 'REUSE_JOURNAL')).rejects.toMatchObject({ code: 'BATCH_JOURNAL_MISSING' });
    await expect(f.adapter.coordinate(plan, 'CREATE', write.getMockImplementation())).rejects.toMatchObject({ code: 'BATCH_PLAN_REQUIRED' });
    expect(reserve).not.toHaveBeenCalled(); untouched(f);
  });

  it('never retries a transaction after a serialization failure following producer work', async () => {
    const f = fixture(), callback = vi.fn(write.getMockImplementation()!);
    const original = f.owner.transaction.bind(f.owner);
    const transaction = vi.fn(async <T>(plan: BatchMemberPlan, work: Parameters<typeof f.owner.transaction<T>>[1]) => original(plan, async tx => {
      await work(tx); throw Object.assign(new Error('PRIVATE SERIALIZATION DETAIL'), { code: 'P2034' });
    }));
    f.owner.transaction = transaction;
    await expect(f.adapter.coordinate(await f.adapter.plan(f.request, user), 'CREATE', callback)).rejects.toMatchObject({ code: 'BATCH_OWNER_UNAVAILABLE' });
    expect(transaction).toHaveBeenCalledTimes(1); expect(callback).toHaveBeenCalledTimes(1); untouched(f);
  });

  it.each(['UNKNOWN', 'COMPLETED', 'PREPARED'] as const)('journal state %s is returned without producing again', async state => {
    const f = fixture(); await f.adapter.coordinate(await f.adapter.plan(f.request, actor), 'CREATE', write.getMockImplementation());
    f.journals.get(f.request.idempotencyKey)!.state = state;
    const result = await f.adapter.coordinate(await f.adapter.plan(f.request, actor), 'REUSE_JOURNAL');
    expect(result.journal.state).toBe(state); expect(result.reused).toBe(true); expect(f.state.numbers).toBe(1);
  });

  it.each(['subject', 'scope', 'key', 'request', 'members', 'command', 'state', 'payload'] as const)('rejects journal %s conflicts without resending', async field => {
    const f = fixture(); await f.adapter.coordinate(await f.adapter.plan(f.request, actor), 'CREATE', write.getMockImplementation());
    const row = f.journals.get(f.request.idempotencyKey)!;
    if (field === 'subject') row.subject.clientId = uuid(9999);
    if (field === 'scope') row.scope.branchId = uuid(9999);
    if (field === 'key') row.idempotencyKey += '-changed';
    if (field === 'request') row.requestSha256 = 'a'.repeat(64);
    if (field === 'members') row.membersSha256 = 'b'.repeat(64);
    if (field === 'command') row.commandSha256 = 'c'.repeat(64);
    if (field === 'state') (row as unknown as { state: string }).state = 'RETRY_AND_SEND';
    if (field === 'payload') row.command.payload.operationId = uuid(9999);
    await expect(f.adapter.coordinate(await f.adapter.plan(f.request, actor), 'REUSE_JOURNAL')).rejects.toMatchObject({ code: 'BATCH_JOURNAL_CONFLICT' });
    expect(f.state.numbers).toBe(1); expect(f.state.writes).toHaveLength(1);
  });

  it('changed valid request, member revision or grant revision cannot reuse a prior journal', async () => {
    for (const field of ['request', 'member', 'grant']) {
      const f = fixture('RA'); await f.adapter.coordinate(await f.adapter.plan(f.request, user), 'CREATE', write.getMockImplementation());
      if (field === 'request' && f.request.kind === 'RA') f.request.entries[0].reasonDescription += ' CHANGED';
      if (field === 'member') f.roots[0].revision++;
      if (field === 'grant') f.revoke();
      await expect(f.adapter.coordinate(await f.adapter.plan(f.request, user), 'REUSE_JOURNAL')).rejects.toMatchObject({ code: 'BATCH_JOURNAL_CONFLICT' });
      expect(f.state.numbers).toBe(1);
    }
  });

  it('a different valid command with recomputed hashes cannot replace the journal input', async () => {
    const f = fixture('RA'); await f.adapter.coordinate(await f.adapter.plan(f.request, user), 'CREATE', write.getMockImplementation());
    const row = f.journals.get(f.request.idempotencyKey)!, envelope = row.command.payload.envelope;
    if (envelope.kind !== 'BATCH' || envelope.batch.input.kind !== 'RA') throw new Error('RA required');
    envelope.batch.input.entries[0].reasonDescription = 'DIFFERENT VALID REASON';
    row.command = buildFiscalSupplementCommand(envelope, { eventId: row.command.eventId, correlationId: row.command.correlationId, occurredAt: asOf });
    row.commandSha256 = fiscalSnapshotSha256(row.command);
    await expect(f.adapter.coordinate(await f.adapter.plan(f.request, user), 'REUSE_JOURNAL')).rejects.toMatchObject({ code: 'BATCH_JOURNAL_CONFLICT' });
    expect(f.state.numbers).toBe(1); expect(f.state.writes).toHaveLength(1);
  });

  it('concurrent creates serialize on the journal; only one callback allocates and writes', async () => {
    const f = fixture(), { reserve } = reservations(f), callback = vi.fn(write.getMockImplementation()!);
    const plans = await Promise.all([f.adapter.plan(f.request, actor), f.adapter.plan(f.request, actor)]);
    const results = await Promise.allSettled(plans.map(p => f.adapter.coordinate(p, 'CREATE', callback)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'BATCH_REUSE_REQUIRED' } });
    expect(reserve).toHaveBeenCalledTimes(1); expect(callback).toHaveBeenCalledTimes(1); expect(f.state.numbers).toBe(1);
  });
});

/** Executes the real existing repository against local Prisma-shaped methods.
 * SQL locks are recorded only. No DB, network, credentials or runtime activation.
 * The fixture transaction stages all repository writes with the authority journal. */
function producerFixture(kind: 'RC' | 'RA') {
  const f = fixture(kind), calls = { summary: vi.fn(), outbox: vi.fn(), locks: vi.fn() },
    nested = vi.fn(async () => { throw new Error('NESTED TRANSACTION FORBIDDEN'); });
  const transaction = f.transaction.getMockImplementation()!;
  let afterOutbox: (() => void) | undefined;
  const owner: BatchMemberOwnerPort<never> = { ...f.owner, transaction: (plan, work) => transaction(plan, async tx => {
    const types = { '01': 'INVOICE', '03': 'SALES_RECEIPT', '07': 'CREDIT_NOTE', '08': 'DEBIT_NOTE' };
    const prismaTx = {
      $executeRaw: calls.locks,
      companySettings: { findUnique: async () => ({ id: f.request.scope.companyId, ruc: f.request.scope.issuerRuc, environment: 'BETA', active: true }) },
      branch: { findUnique: async () => ({ id: f.request.scope.branchId, companyId: f.request.scope.companyId, active: true }) },
      document: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          const row = f.roots.find(r => r.member.documentId === where.id)!; const s = row.snapshot;
          return { id: s.documentId, companyId: s.companyId, seriesCounterId: row.binding.seriesId, emissionPointId: row.binding.pointId,
            type: types[row.binding.documentType], status: 'ISSUED', sunatStatus: kind === 'RA' ? 'ACCEPTED' : 'QUEUED',
            series: s.series, number: BigInt(s.number), fullNumber: s.fullNumber, issueDate: new Date(s.issueDate),
            currencyCode: s.currencyCode, operationTypeCode: s.operationTypeCode, customerIdentityType: s.customer.identityType,
            customerIdentityNumber: s.customer.identityNumber, customerLegalName: s.customer.legalName,
            ...s.totals, unaffectedAmount: '0.00', immutableSnapshot: clone(s) };
        }, findMany: async () => [],
      },
      emissionPoint: { findUnique: async () => ({ id: f.roots[0].binding.pointId, companyId: f.request.scope.companyId,
        branchId: f.request.scope.branchId, code: f.roots[0].snapshot.issuer.establishmentCode, active: true }) },
      seriesCounter: { findUnique: async () => ({ id: f.roots[0].binding.seriesId, companyId: f.request.scope.companyId,
        emissionPointId: f.roots[0].binding.pointId, documentType: types[f.roots[0].binding.documentType], series: f.roots[0].binding.series, active: true }) },
      dailySummary: { findMany: async () => [], create: async (args: unknown) => { calls.summary(args); tx.owner.write('SUMMARY'); return {}; } },
      dailySummaryItem: { findMany: async () => [] },
      outboxEvent: { findMany: async () => [], create: async (args: unknown) => { calls.outbox(args); tx.owner.write('OUTBOX'); afterOutbox?.(); return {}; } },
    };
    return work({ ...tx, owner: prismaTx as never });
  }) };
  const producer = createBillingBatchMemberProducer(owner, { $transaction: nested } as never, () => asOf);
  return { ...f, producer, calls, nested, afterOutbox: (fn: () => void) => { afterOutbox = fn; } };
}

describe('Explicit batch member bridge into the existing Billing repository transaction', () => {
  it.each(['RC', 'RA'] as const)('%s executes real repository logic with whole-batch authority and the same transaction', async kind => {
    const f = producerFixture(kind), plan = await f.producer.plan(f.request, user);
    const result = await f.producer.coordinate(plan, 'CREATE');
    expect(result.journal.result).toMatchObject({ operationKind: kind, deduplicated: false });
    expect(f.state.writes).toEqual(['SUMMARY', 'OUTBOX']); expect(f.journals.size).toBe(1);
    expect(f.calls.summary).toHaveBeenCalledTimes(1); expect(f.calls.outbox).toHaveBeenCalledTimes(1);
    expect(f.calls.summary.mock.calls[0][0].data.createdByUserId).toBe(user.subjectId);
    expect(f.calls.summary.mock.calls[0][0].data.items.create).toHaveLength(2);
    expect(f.nested).not.toHaveBeenCalled(); expect(f.calls.locks).toHaveBeenCalled();
    const reused = await f.producer.coordinate(await f.producer.plan(f.request, user), 'REUSE_JOURNAL');
    expect(reused.journal.command).toEqual(result.journal.command); expect(f.calls.outbox).toHaveBeenCalledTimes(1);
  });

  it('repository writes, allocated identity and journal roll back together on a late revoke', async () => {
    const f = producerFixture('RA'); f.afterOutbox(() => f.revoke());
    await expect(f.producer.coordinate(await f.producer.plan(f.request, user), 'CREATE')).rejects.toMatchObject({ code: 'BATCH_AUTHORITY_CHANGED' });
    expect(f.calls.outbox).toHaveBeenCalledTimes(1); untouched(f); expect(f.nested).not.toHaveBeenCalled();
  });

  it.each(['SERVICE', 'RC2', 'multiple-points'] as const)('keeps existing persistence limit %s explicit before allocation', async scenario => {
    const f = producerFixture('RC');
    if (scenario === 'RC2') f.previous(1, '2');
    if (scenario === 'multiple-points') f.roots[1].binding.pointId = uuid(8999);
    await expect(f.producer.plan(f.request, scenario === 'SERVICE' ? actor : user)).rejects.toMatchObject({ code: 'BATCH_PRODUCER_UNSUPPORTED' });
    untouched(f); expect(f.transaction).not.toHaveBeenCalled(); expect(f.calls.outbox).not.toHaveBeenCalled();
  });
});
