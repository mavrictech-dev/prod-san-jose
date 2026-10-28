import { describe, expect, it, vi } from 'vitest';
import { B2bGuides } from '../services/billing-service/src/b2b/guide-drafts';
import type { B2bGuideBinding } from '../packages/contracts/src/b2b-guide-security';
import type { GuideDraft } from '../services/billing-service/src/b2b/guide-model';
import { guideFixture, guideBody, guideKey, guideUuid, type MemoryGuideStore } from './helpers/b2b-guide.fixture';

const capabilities = { candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false,
  authorizedForTransfer: false, referenceVerification: 'NOT_VERIFIED' };
async function created(kind: 'SERVICE' | 'USER' = 'SERVICE', type: '09' | '31' = '09') {
  const f = guideFixture(kind, type), made = await f.command();
  return { ...f, made, id: made.response.id };
}
const snapshot = (store: MemoryGuideStore) => structuredClone(store.state);
function allowBinding(f: ReturnType<typeof guideFixture>, b: B2bGuideBinding) {
  f.catalogueValue.binding = structuredClone(b);
  f.access.actor.scope = { kind: 'ASSIGNED', branchIds: [b.anchor.branchId], emissionPointIds: [b.anchor.pointId],
    series: [b.anchor.seriesId, b.guideSeriesId] };
}

describe('guide draft aggregate: candidate only, independently owned and audited', () => {
  it.each([['SERVICE', '09'], ['SERVICE', '31'], ['USER', '09'], ['USER', '31']] as const)
    ('runs CREATE/PATCH/READY/CANCEL/read/operation for %s/%s without fiscal identity', async (kind, type) => {
      const f = await created(kind, type);
      expect(f.made).toMatchObject({ replayed: false, response: { ...capabilities, binding: f.binding,
        state: 'DRAFT', revision: '"v1"', body: guideBody() }, operation: { action: 'CREATE', state: 'SUCCEEDED_LOCAL' } });
      expect(f.made.response.bodySha256).toMatch(/^[a-f0-9]{64}$/);
      expect(f.made.response.id).toMatch(/^[a-f0-9-]{36}$/);
      const patched = await f.command('PATCH', f.id, guideKey + '_patch', '"v1"', { grossWeight: '2.500' });
      expect(patched.response).toMatchObject({ state: 'DRAFT', revision: '"v2"', body: { grossWeight: '2.500' }, ...capabilities });
      expect(patched.response.bodySha256).not.toBe(f.made.response.bodySha256);
      const ready = await f.command('READY', f.id, guideKey + '_ready', '"v2"');
      expect(ready.response).toMatchObject({ state: 'READY', revision: '"v3"', ...capabilities });
      expect(ready.response.bodySha256).toBe(patched.response.bodySha256);
      const cancelled = await f.command('CANCEL', f.id, guideKey + '_cancel', '"v3"');
      expect(cancelled.response).toMatchObject({ state: 'CANCELLED', revision: '"v4"', ...capabilities });
      expect(cancelled.response.body).toEqual(ready.response.body);
      expect(cancelled.response.bodySha256).toBe(ready.response.bodySha256);
      expect(await f.read(f.id)).toEqual(cancelled.response);
      expect(await f.operation(cancelled.operation.operationId)).toEqual(cancelled.operation);
      expect(f.store.rows.size).toBe(1); expect(f.store.ops.size).toBe(4);
      for (const field of ['number', 'fullNumber', 'xml', 'cdr', 'ticket', 'fiscalDocumentId', 'commercialNumber'])
        expect(cancelled.response).not.toHaveProperty(field);
      expect(Object.keys(f.store.rows.get(f.id)!)).not.toContain('fiscalNumber');
    });

  it.each(['SERVICE', 'USER'] as const)('persists immutable %s actor provenance without token or fabricated human', async kind => {
    const f = await created(kind), op = f.store.ops.get(f.made.operation.operationId)!;
    expect(op.actor).toEqual(f.access.actor.b2b);
    expect(op.grantRevision).toBe(1);
    expect(op.actor.subjectId).toBe(kind === 'SERVICE' ? null : guideUuid(20));
    expect(op.actor.userAuthRevision).toBe(kind === 'SERVICE' ? null : 1);
    expect(op.actorKey).toBe(kind === 'SERVICE' ? 'SERVICE:-' : `USER:${guideUuid(20)}`);
    expect(op.requestId).not.toBe(op.id);
    expect(op.keySha256).toMatch(/^[a-f0-9]{64}$/); expect(op.requestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(op)).not.toContain(f.token); expect(JSON.stringify(op)).not.toContain(guideKey);
    const saved = structuredClone(op.actor); f.access.actor.b2b!.revision = 2; f.access.clientRevision = 2;
    expect(f.store.ops.get(op.id)?.actor).toEqual(saved);
  });
  it('asks distinct READ, WRITE and OPERATION permissions at every owner boundary', async () => {
    const f = await created();
    expect(f.authorization.current.mock.calls.map(call => call[3])).toEqual(['WRITE', 'WRITE', 'WRITE']);
    f.authorization.current.mockClear(); await f.read(f.id);
    expect(f.authorization.current.mock.calls.map(call => call[3])).toEqual(['READ', 'READ', 'READ']);
    f.authorization.current.mockClear(); await f.operation(f.made.operation.operationId);
    expect(f.authorization.current.mock.calls.map(call => call[3])).toEqual(['OPERATION', 'OPERATION', 'OPERATION']);
    expect(f.authorization.current.mock.calls.every(([token, kind, b]) => token === f.token && kind === f.kind &&
      JSON.stringify(b) === JSON.stringify(f.binding))).toBe(true);
  });
  it('uses the injected clock and preserves creation time on later writes', async () => {
    const f = await created(); f.control.at = '2026-10-21T16:01:00.000Z';
    const patch = await f.command('PATCH', f.id, guideKey + '_p', '"v1"', { grossWeight: '3' });
    expect(patch.response.createdAt).toBe(f.made.response.createdAt);
    expect(patch.response.updatedAt).toBe(f.control.at);
    expect(f.store.ops.get(patch.operation.operationId)?.at).toBe(f.control.at);
  });
  it('detaches requests, responses, audit receipts and committed state', async () => {
    const f = guideFixture(), input = guideBody(), made = await f.command('CREATE', null, guideKey, undefined, input);
    input.items[0].description = 'MUTATED INPUT'; made.response.body.items[0].description = 'MUTATED OUTPUT';
    expect((await f.read(made.response.id)).body.items[0].description).toBe('ARTICULO FICTICIO');
    const receipt = f.store.ops.get(made.operation.operationId)!;
    expect((receipt.response as any).body.items[0].description).toBe('ARTICULO FICTICIO');
  });
  it('31 sender and recipient are not substituted with the carrier/issuer', async () => {
    const f = guideFixture('SERVICE', '31'), input = guideBody();
    input.sender = { ruc: '20000000010', legalName: 'OTRO REMITENTE FICTICIO' };
    const made = await f.command('CREATE', null, guideKey, undefined, input);
    expect(made.response.body.sender).toEqual(input.sender);
    expect(made.response.binding.anchor.issuerRuc).not.toBe(input.sender.ruc);
    expect(made.response.body.transport).toEqual(input.transport);
  });
});

describe('durable guide idempotency, concurrency and restarts', () => {
  it.each(['SERVICE', 'USER'] as const)('replays %s CREATE after cancellation and service restart without rewinding the draft', async kind => {
    const f = await created(kind);
    await f.command('CANCEL', f.id, guideKey + '_cancel', '"v1"'); const before = snapshot(f.store);
    const restarted = f.restart();
    const replay = await restarted.command(f.token, kind, f.binding, 'CREATE', null, guideKey, undefined, guideBody());
    expect(replay).toEqual({ ...f.made, replayed: true }); expect(f.store.state).toEqual(before);
    expect((await restarted.read(f.token, kind, f.binding, f.id)).state).toBe('CANCELLED');
    expect(await restarted.operation(f.token, kind, f.binding, f.made.operation.operationId)).toEqual(f.made.operation);
  });
  it('replays historical PATCH, READY and CANCEL receipts after later transitions', async () => {
    const f = await created();
    const patch = await f.command('PATCH', f.id, guideKey + '_p', '"v1"', { grossWeight: '2' });
    const ready = await f.command('READY', f.id, guideKey + '_r', '"v2"');
    const cancel = await f.command('CANCEL', f.id, guideKey + '_c', '"v3"'); const before = snapshot(f.store);
    expect(await f.command('PATCH', f.id, guideKey + '_p', '"v1"', { grossWeight: '2' })).toEqual({ ...patch, replayed: true });
    expect(await f.command('READY', f.id, guideKey + '_r', '"v2"')).toEqual({ ...ready, replayed: true });
    expect(await f.command('CANCEL', f.id, guideKey + '_c', '"v3"')).toEqual({ ...cancel, replayed: true });
    expect(f.store.state).toEqual(before);
  });
  it('serializes simultaneous same-key requests into one draft and one receipt', async () => {
    const f = guideFixture(); const results = await Promise.all(Array.from({ length: 12 }, () => f.command()));
    expect(new Set(results.map(r => r.response.id)).size).toBe(1);
    expect(new Set(results.map(r => r.operation.operationId)).size).toBe(1);
    expect(results.filter(r => !r.replayed)).toHaveLength(1);
    expect(f.store.rows.size).toBe(1); expect(f.store.ops.size).toBe(1);
  });
  it('racing different patches with one ETag allow exactly one commit', async () => {
    const f = await created(); const results = await Promise.allSettled([
      f.command('PATCH', f.id, guideKey + '_one', '"v1"', { grossWeight: '2' }),
      f.command('PATCH', f.id, guideKey + '_two', '"v1"', { grossWeight: '3' }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 412, code: 'REVISION_CONFLICT' });
    expect(f.store.rows.get(f.id)?.revision).toBe(2); expect(f.store.ops.size).toBe(2);
  });
  it.each(['body', 'action', 'etag', 'id', 'binding'] as const)('rejects key reuse with changed %s', async part => {
    const f = await created(), before = snapshot(f.store);
    const args: Parameters<B2bGuides['command']> = [f.token, f.kind, f.binding, 'CREATE', null, guideKey, undefined, guideBody()];
    if (part === 'body') args[7] = { ...guideBody(), grossWeight: '2' };
    if (part === 'action') { args[3] = 'READY'; args[4] = f.id; args[6] = '"v1"'; args[7] = {}; }
    if (part === 'etag' || part === 'id') {
      await f.command('PATCH', f.id, guideKey + '_patch', '"v1"', { grossWeight: '2' });
      args[3] = 'PATCH'; args[4] = part === 'id' ? guideUuid(999) : f.id;
      args[5] = guideKey + '_patch'; args[6] = part === 'etag' ? '"v2"' : '"v1"'; args[7] = { grossWeight: '2' };
    }
    if (part === 'binding') {
      const changed = structuredClone(f.binding); changed.guideSeriesId = guideUuid(99); allowBinding(f, changed); args[2] = changed;
    }
    const immediatelyBefore = snapshot(f.store);
    await expect(f.core.command(...args)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(f.store.state).toEqual(immediatelyBefore);
    if (!['id', 'etag'].includes(part)) expect(f.store.state).toEqual(before);
  });
  it('the same key is independently scoped by client and actual USER subject', async () => {
    const f = await created('USER');
    f.access.actor.userId = guideUuid(25); f.access.actor.b2b!.subjectId = guideUuid(25);
    const otherUser = await f.command(); expect(otherUser.replayed).toBe(false);
    f.access.actor.b2b!.clientId = guideUuid(26);
    const otherClient = await f.command(); expect(otherClient.replayed).toBe(false);
    expect(new Set([f.id, otherUser.response.id, otherClient.response.id]).size).toBe(3);
    expect(f.store.ops.size).toBe(3);
  });
});

describe('guide ETags, frozen payloads and revision ceilings', () => {
  it.each([undefined, '', 'v1', 'W/"v1"', '"v0"', '"v01"', '"v1000000000"', '*'])
    ('rejects missing/malformed mutation ETag %j', async etag => {
      const f = await created(), before = snapshot(f.store);
      await expect(f.command('PATCH', f.id, guideKey + '_p', etag, { grossWeight: '2' })).rejects.toMatchObject({ status: 428 });
      expect(f.store.state).toEqual(before);
    });
  it.each(['PATCH', 'READY', 'CANCEL'] as const)('requires the exact current ETag for %s', async action => {
    const f = await created(), before = snapshot(f.store);
    await expect(f.command(action, f.id, guideKey + '_x', '"v2"', action === 'PATCH' ? { grossWeight: '2' } : {}))
      .rejects.toMatchObject({ status: 412 }); expect(f.store.state).toEqual(before);
  });
  it.each(['PATCH', 'READY'] as const)('READY freezes %s but permits cancellation without body changes', async action => {
    const f = await created(); const ready = await f.command('READY', f.id, guideKey + '_r', '"v1"');
    await expect(f.command(action, f.id, guideKey + '_x', '"v2"', action === 'PATCH' ? { grossWeight: '2' } : {}))
      .rejects.toMatchObject({ code: 'GUIDE_DRAFT_IMMUTABLE' });
    const cancelled = await f.command('CANCEL', f.id, guideKey + '_c', '"v2"');
    expect(cancelled.response.body).toEqual(ready.response.body);
    expect(cancelled.response.bodySha256).toBe(ready.response.bodySha256);
  });
  it.each(['PATCH', 'READY', 'CANCEL'] as const)('CANCELLED blocks another %s and keeps the original receipt', async action => {
    const f = await created(); await f.command('CANCEL', f.id, guideKey + '_c', '"v1"'); const before = snapshot(f.store);
    await expect(f.command(action, f.id, guideKey + '_x', '"v2"', action === 'PATCH' ? { grossWeight: '2' } : {}))
      .rejects.toMatchObject({ code: 'GUIDE_DRAFT_IMMUTABLE' }); expect(f.store.state).toEqual(before);
  });
  it('revalidates a merged PATCH, not just each independent field', async () => {
    const f = await created(), before = snapshot(f.store);
    await expect(f.command('PATCH', f.id, guideKey + '_p', '"v1"', { transferDate: '2026-10-20' })).rejects.toThrow();
    expect(f.store.state).toEqual(before);
    await expect(f.command('PATCH', f.id, guideKey + '_p', '"v1"', { sender: { legalName: 'ONLY PARTIAL' } })).rejects.toThrow();
  });
  it('permits the last legal revision and blocks all further changes without overflow', async () => {
    const f = await created(), row = f.store.rows.get(f.id)!; row.revision = 999999998;
    const last = await f.command('PATCH', f.id, guideKey + '_last', '"v999999998"', { grossWeight: '2' });
    expect(last.response.revision).toBe('"v999999999"'); const before = snapshot(f.store);
    for (const action of ['PATCH', 'READY', 'CANCEL'] as const)
      await expect(f.command(action, f.id, guideKey + '_' + action, '"v999999999"', action === 'PATCH' ? { grossWeight: '3' } : {}))
        .rejects.toMatchObject({ code: 'GUIDE_REVISION_EXHAUSTED' });
    expect(f.store.state).toEqual(before);
  });
});

describe('guide ownership and tuple isolation never leak a foreign aggregate', () => {
  it.each(['client', 'subject', 'issuer', 'ruc', 'branch', 'point', 'anchorSeries', 'guideSeries', 'documentType', 'guideType'] as const)
    ('hides known draft and operation IDs across %s', async part => {
      const f = await created('USER'), other = structuredClone(f.binding);
      switch (part) {
        case 'client': f.access.actor.b2b!.clientId = guideUuid(70); break;
        case 'subject': f.access.actor.userId = guideUuid(71); f.access.actor.b2b!.subjectId = guideUuid(71); break;
        case 'issuer': other.anchor.issuerId = 2; break;
        case 'ruc': other.anchor.issuerRuc = '20000000010'; break;
        case 'branch': other.anchor.branchId = guideUuid(72); break;
        case 'point': other.anchor.pointId = guideUuid(73); break;
        case 'anchorSeries': other.anchor.seriesId = guideUuid(74); break;
        case 'guideSeries': other.guideSeriesId = guideUuid(75); break;
        case 'documentType': other.anchor.documentType = '03'; break;
        case 'guideType': other.guideType = '31'; break;
      }
      allowBinding(f, other); const before = snapshot(f.store);
      await expect(f.core.read(f.token, f.kind, other, f.id)).rejects.toMatchObject({ status: 404 });
      await expect(f.core.operation(f.token, f.kind, other, f.made.operation.operationId)).rejects.toMatchObject({ status: 404 });
      await expect(f.core.command(f.token, f.kind, other, 'PATCH', f.id, guideKey + '_foreign', '"v1"', { grossWeight: '2' }))
        .rejects.toMatchObject({ status: 404 }); expect(f.store.state).toEqual(before);
    });
  it('does not invent grants from an unpaired point or series', async () => {
    const f = await created(); const b = structuredClone(f.binding); b.anchor.pointId = guideUuid(91);
    await expect(f.core.read(f.token, f.kind, b, f.id)).rejects.toMatchObject({ code: 'INVALID_GUIDE_AUTHORITY_RESPONSE' });
  });
  it.each(['read', 'operation', 'patch'] as const)('hides nonexistent IDs for %s', async method => {
    const f = await created();
    const request = method === 'read' ? f.read(guideUuid(999)) : method === 'operation' ? f.operation(guideUuid(999))
      : f.command('PATCH', guideUuid(999), guideKey + '_missing', '"v1"', { grossWeight: '2' });
    await expect(request).rejects.toMatchObject({ status: 404 });
  });
  it('catalogue disappearance blocks reads and replays', async () => {
    const f = await created(); f.catalogue.resolve.mockResolvedValue(null); const before = snapshot(f.store);
    await expect(f.read(f.id)).rejects.toMatchObject({ code: 'GUIDE_CONTEXT_NOT_FOUND' });
    await expect(f.command()).rejects.toMatchObject({ code: 'GUIDE_CONTEXT_NOT_FOUND' });
    expect(f.store.state).toEqual(before);
  });
});

describe('guide transactions roll back the draft AND immutable operation when owner authority changes', () => {
  it.each(['create', 'append'] as const)('CREATE failure after %s rolls back all writes; same key can retry', async phase => {
    const f = guideFixture(); f.store.onWrite = action => { if (action === phase) throw new Error('SYNTHETIC_WRITE_FAILURE'); };
    await expect(f.command()).rejects.toThrow('SYNTHETIC_WRITE_FAILURE');
    expect(f.store.rows.size).toBe(0); expect(f.store.ops.size).toBe(0);
    f.store.onWrite = undefined; expect((await f.command()).replayed).toBe(false);
    expect(f.store.rows.size).toBe(1); expect(f.store.ops.size).toBe(1);
  });
  it.each(['PATCH', 'READY', 'CANCEL'] as const)('failed audit rolls back %s and permits exact retry', async action => {
    const f = await created(), before = snapshot(f.store);
    f.store.onWrite = phase => { if (phase === 'append') throw new Error('SYNTHETIC_AUDIT_FAILURE'); };
    const input = action === 'PATCH' ? { grossWeight: '2' } : {};
    await expect(f.command(action, f.id, guideKey + '_retry', '"v1"', input)).rejects.toThrow('SYNTHETIC_AUDIT_FAILURE');
    expect(f.store.state).toEqual(before); f.store.onWrite = undefined;
    expect((await f.command(action, f.id, guideKey + '_retry', '"v1"', input)).response.revision).toBe('"v2"');
  });
  it.each(['revocation', 'grant', 'clientRevision', 'catalogue'] as const)
    ('change to %s after receipt write rolls back CREATE and receipt', async change => {
      const f = guideFixture(); f.store.onWrite = phase => {
        if (phase !== 'append') return;
        if (change === 'revocation') f.control.revoked = true;
        if (change === 'grant') f.access.grantRevision++;
        if (change === 'clientRevision') { f.access.clientRevision++; f.access.actor.b2b!.revision++; }
        if (change === 'catalogue') f.catalogueValue.metadataSha256 = 'b'.repeat(64);
      };
      await expect(f.command()).rejects.toMatchObject({ code: change === 'revocation' ? 'SYNTHETIC_REVOKED' : 'GUIDE_AUTHORITY_CHANGED' });
      expect(f.store.rows.size).toBe(0); expect(f.store.ops.size).toBe(0);
    });
  it.each(['revocation', 'grant', 'catalogue'] as const)('change to %s after aggregate save rolls back PATCH and receipt', async change => {
    const f = await created(), before = snapshot(f.store); f.store.onWrite = phase => {
      if (phase !== 'save') return;
      if (change === 'revocation') f.control.revoked = true;
      if (change === 'grant') f.access.grantRevision++;
      if (change === 'catalogue') f.catalogueValue.metadataSha256 = 'c'.repeat(64);
    };
    await expect(f.command('PATCH', f.id, guideKey + '_p', '"v1"', { grossWeight: '2' })).rejects.toThrow();
    expect(f.store.state).toEqual(before);
  });
  it('revocation at transaction entry prevents any write', async () => {
    const f = guideFixture(), original = f.authorization.current.getMockImplementation()!; let calls = 0;
    f.authorization.current.mockImplementation(async (...args) => {
      if (++calls === 2) f.control.revoked = true;
      return original(...args);
    });
    await expect(f.command()).rejects.toMatchObject({ code: 'SYNTHETIC_REVOKED' });
    expect(f.store.writeCalls).toEqual([]); expect(f.store.rows.size).toBe(0);
  });
  it.each(['replay', 'read', 'list', 'operation'] as const)('revoked authorization blocks %s with no new receipt', async method => {
    const f = await created(), before = snapshot(f.store); f.control.revoked = true;
    const request = method === 'replay' ? f.command() : method === 'read' ? f.read(f.id)
      : method === 'list' ? f.list() : f.operation(f.made.operation.operationId);
    await expect(request).rejects.toMatchObject({ status: 401 }); expect(f.store.state).toEqual(before);
  });
  it.each(['read', 'list', 'operation', 'replay'] as const)('rechecks %s authority after the owner read', async method => {
    const f = await created(), before = snapshot(f.store);
    f.store.onRead = () => { f.access.grantRevision++; };
    const request = method === 'read' ? f.read(f.id) : method === 'list' ? f.list()
      : method === 'operation' ? f.operation(f.made.operation.operationId) : f.command();
    await expect(request).rejects.toMatchObject({ code: 'GUIDE_AUTHORITY_CHANGED' }); expect(f.store.state).toEqual(before);
  });
});

describe('guide corruption and normalization regression checks', () => {
  it.each(['hash', 'content', 'whitespace', 'offset', 'invalidBody', 'revision', 'state', 'dates'] as const)
    ('rejects persisted %s tampering on reads and mutations without repairing it silently', async variant => {
      const f = await created(), row = f.store.rows.get(f.id)!;
      if (variant === 'hash') row.bodySha256 = 'f'.repeat(64);
      if (variant === 'content') row.body.grossWeight = '3';
      if (variant === 'whitespace') row.body.sender.legalName = '  REMITENTE FICTICIO  ';
      if (variant === 'offset') row.body.issueDate = '2026-10-21T10:30:00-05:00';
      if (variant === 'invalidBody') row.body.grossWeight = '-1';
      if (variant === 'revision') row.revision = Number.MAX_SAFE_INTEGER;
      if (variant === 'state') (row as any).state = 'ACCEPTED';
      if (variant === 'dates') row.updatedAt = '2020-01-01T00:00:00.000Z';
      const before = snapshot(f.store);
      await expect(f.read(f.id)).rejects.toMatchObject({ status: 409, code: 'GUIDE_DRAFT_INCONSISTENT' });
      await expect(f.command()).rejects.toMatchObject({ status: 409, code: 'GUIDE_DRAFT_INCONSISTENT' });
      expect(f.store.state).toEqual(before);
    });
  it.each(['hash', 'content', 'whitespace', 'offset', 'invalidBody', 'capability', 'binding'] as const)
    ('rejects corrupt historical response %s on replay', async variant => {
      const f = await created(), response = f.store.ops.get(f.made.operation.operationId)!.response as any;
      if (variant === 'hash') response.bodySha256 = 'f'.repeat(64);
      if (variant === 'content') response.body.grossWeight = '3';
      if (variant === 'whitespace') response.body.sender.legalName = ' REMITENTE FICTICIO ';
      if (variant === 'offset') response.body.issueDate = '2026-10-21T10:30:00-05:00';
      if (variant === 'invalidBody') response.body.grossWeight = '-1';
      if (variant === 'capability') response.transmissionAuthorized = true;
      if (variant === 'binding') response.binding.guideSeriesId = guideUuid(90);
      const before = snapshot(f.store);
      await expect(f.command()).rejects.toMatchObject({ status: 409, code: 'GUIDE_OPERATION_INCONSISTENT' });
      expect(f.store.state).toEqual(before);
    });
});

describe('guide lists filter owner tuples before keyset limits', () => {
  it('filters foreign rows before limiting and traverses each authorized row once', async () => {
    const f = await created('USER'), template = structuredClone(f.store.rows.get(f.id)!); f.store.rows.clear();
    for (let i = 1; i <= 12; i++) {
      const row: GuideDraft = { ...structuredClone(template), id: guideUuid(100 + i) };
      if (i === 1 || i === 4) row.clientId = guideUuid(800);
      if (i === 2 || i === 5) row.actorKey = `USER:${guideUuid(801)}`;
      if (i === 3 || i === 6) row.binding.anchor.pointId = guideUuid(802);
      f.store.rows.set(row.id, row);
    }
    const seen: string[] = []; let cursor: string | null = null;
    for (let page = 0; page < 4; page++) {
      const result = await f.list(2, cursor);
      expect(result.items).toHaveLength(2);
      expect(result.page.consistency).toBe('LIVE_KEYSET_NOT_A_SNAPSHOT');
      seen.push(...result.items.map(item => item.id));
      if (!result.page.hasMore) { expect(result.page.nextAfter).toBeNull(); break; }
      expect(result.page.nextAfter).toBe(result.items.at(-1)!.id); cursor = result.page.nextAfter;
    }
    expect(seen).toEqual(Array.from({ length: 6 }, (_, i) => guideUuid(107 + i)));
    expect(new Set(seen).size).toBe(6);
    expect(f.store.listCalls.every(call => call.clientId === template.clientId && call.actorKey === template.actorKey &&
      call.limit === 3 && JSON.stringify(call.bindings) === JSON.stringify([f.binding]))).toBe(true);
  });
  it('returns no cursor for empty or final pages and never fabricates items', async () => {
    const f = guideFixture(); expect(await f.list()).toMatchObject({ items: [], page: { hasMore: false, nextAfter: null } });
    const made = await f.command(); const result = await f.list(1);
    expect(result.items.map(row => row.id)).toEqual([made.response.id]);
    expect(result.page).toMatchObject({ hasMore: false, nextAfter: null });
  });
  it('defaults to 10 and accepts the maximum 10 with a single bounded lookahead', async () => {
    const f = await created(), template = structuredClone(f.store.rows.get(f.id)!); f.store.rows.clear();
    for (let i = 0; i < 11; i++) {
      const row = { ...structuredClone(template), id: guideUuid(200 + i) }; f.store.rows.set(row.id, row);
    }
    const result = await f.core.list(f.token, f.kind, f.binding);
    expect(result.items).toHaveLength(10);
    expect(result.page).toMatchObject({ limit: 10, hasMore: true, nextAfter: guideUuid(209) });
    expect(f.store.listCalls.at(-1)?.limit).toBe(11);
    const final = await f.list(10, result.page.nextAfter);
    expect(final.items.map(item => item.id)).toEqual([guideUuid(210)]);
    expect(final.page).toMatchObject({ hasMore: false, nextAfter: null });
  });
  it.each(['duplicate', 'reverse', 'overflow', 'cursorLoop'] as const)('rejects corrupt owner pagination: %s', async variant => {
    const f = await created(), template = f.store.rows.get(f.id)!;
    const first = { ...structuredClone(template), id: guideUuid(101) }, second = { ...structuredClone(template), id: guideUuid(102) };
    f.store.listOverride = () => variant === 'duplicate' ? [first, first] : variant === 'reverse' ? [second, first]
      : variant === 'overflow' ? [first, second, { ...first, id: guideUuid(103) }, { ...first, id: guideUuid(104) }] : [first];
    await expect(f.list(2, variant === 'cursorLoop' ? first.id : null)).rejects.toMatchObject({ code: 'GUIDE_PAGE_INCONSISTENT' });
  });
  it('rejects a foreign visible row even if a faulty owner adapter returns it', async () => {
    const f = await created(); f.store.listOverride = rows => rows.map(row => ({ ...row, clientId: guideUuid(888) }));
    await expect(f.list(1)).rejects.toMatchObject({ status: 404 });
  });
  it.each([0, -1, 11, 51, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])('rejects bad page limit %s before storage', async limit => {
    const f = guideFixture(); await expect(f.list(limit)).rejects.toMatchObject({ code: 'INVALID_GUIDE_PAGE' });
    expect(f.store.transactions).toBe(0);
  });
  it.each(['', 'bad', '"v1"', '../cursor'])('rejects malformed cursor %j', async cursor => {
    const f = guideFixture(); await expect(f.list(1, cursor)).rejects.toMatchObject({ code: 'INVALID_GUIDE_PAGE' });
    expect(f.store.transactions).toBe(0);
  });
});

describe('guide persisted operation metadata integrity',()=>{
  it.each([
    (op:any)=>op.response.schemaVersion='unknown',
    (op:any)=>op.response.state='READY',
    (op:any)=>op.response.revision='"v500"',
    (op:any)=>op.action='CANCEL',
    (op:any)=>op.response.createdAt='2026-10-20T16:00:00.000Z',
    (op:any)=>op.response.updatedAt='2026-10-22T16:00:00.000Z',
    (op:any)=>op.at='2026-10-20T16:00:00.000Z',
    (op:any)=>op.actor.subjectId=guideUuid(1000),
    (op:any)=>op.actor.revision=0,
    (op:any)=>op.grantRevision=0,
    (op:any)=>op.response.extra='unexpected',
  ])('rejects altered receipt metadata on replay and operation read %#',async change=>{
    const f=guideFixture(),made=await f.command(),op=f.store.ops.get(made.operation.operationId)!;change(op);
    const before=snapshot(f.store);
    await expect(f.command()).rejects.toMatchObject({code:'GUIDE_OPERATION_INCONSISTENT'});
    await expect(f.operation(made.operation.operationId)).rejects.toMatchObject({code:'GUIDE_OPERATION_INCONSISTENT'});
    expect(f.store.state).toEqual(before);
  });
});

describe('guide hostile public input fails before any draft/audit write', () => {
  it.each(['read', 'operation', 'patch'] as const)('rejects malformed IDs for %s before storage', async method => {
    const f = guideFixture();
    const request = method === 'read' ? f.read('../other') : method === 'operation' ? f.operation('invalid')
      : f.command('PATCH', 'invalid', guideKey, '"v1"', {});
    await expect(request).rejects.toMatchObject({ status: 400 }); expect(f.store.transactions).toBe(0);
  });
  it('CREATE cannot take an existing ID or a mutation ETag', async () => {
    const f = guideFixture();
    await expect(f.command('CREATE', guideUuid(100))).rejects.toMatchObject({ code: 'INVALID_GUIDE_COMMAND' });
    await expect(f.command('CREATE', null, guideKey, '"v1"')).rejects.toMatchObject({ code: 'INVALID_GUIDE_COMMAND' });
    expect(f.store.transactions).toBe(0);
  });
  it.each(['globalScope', 'extraPoint', 'missingGuide', 'duplicateSeries', 'revisionMismatch', 'zeroGrant'] as const)
    ('rejects malformed owner authority: %s', async variant => {
      const f = guideFixture(), scope = f.access.actor.scope;
      if (scope.kind !== 'ASSIGNED') throw new Error('Fixture scope');
      if (variant === 'globalScope') f.access.actor.scope = { kind: 'GLOBAL' };
      if (variant === 'extraPoint') scope.emissionPointIds.push(guideUuid(890));
      if (variant === 'missingGuide') scope.series = [f.binding.anchor.seriesId];
      if (variant === 'duplicateSeries') scope.series = [f.binding.anchor.seriesId, f.binding.anchor.seriesId];
      if (variant === 'revisionMismatch') f.access.clientRevision = 2;
      if (variant === 'zeroGrant') f.access.grantRevision = 0;
      await expect(f.command()).rejects.toThrow(); expect(f.store.transactions).toBe(0);
    });
  it.each(['binding', 'hash', 'absence'] as const)('rejects invalid owner catalogue %s', async variant => {
    const f = guideFixture();
    if (variant === 'binding') f.catalogueValue.binding.guideSeriesId = guideUuid(900);
    if (variant === 'hash') f.catalogueValue.metadataSha256 = 'not-a-sha';
    if (variant === 'absence') f.catalogue.resolve.mockResolvedValue(null);
    await expect(f.command()).rejects.toMatchObject({ code: 'GUIDE_CONTEXT_NOT_FOUND' });
    expect(f.store.transactions).toBe(0);
  });
  it.each(['number', 'series', 'accepted', 'certificate', 'xml', 'cdr', 'actor', 'grantRevision', 'transmissionAuthorized'])
    ('rejects caller-supplied %s without fiscal side effects', async field => {
      const f = guideFixture();
      await expect(f.command('CREATE', null, guideKey, undefined, { ...guideBody(), [field]: true }))
        .rejects.toMatchObject({ status: 400, code: 'INVALID_GUIDE_BODY' });
      expect(f.store.rows.size).toBe(0); expect(f.store.ops.size).toBe(0);
    });
  it('never executes getters or proxy traps in input, nested data or binding', async () => {
    const f = guideFixture(), getter = vi.fn(() => 'injected'), trap = vi.fn(() => { throw new Error('EXECUTED'); });
    const root = Object.defineProperty(guideBody(), 'issueDate', { enumerable: true, get: getter });
    const nested = guideBody(); Object.defineProperty(nested.sender, 'ruc', { enumerable: true, get: getter });
    const proxy = new Proxy(guideBody(), { get: trap, ownKeys: trap });
    for (const input of [root, nested, proxy]) await expect(f.command('CREATE', null, guideKey, undefined, input)).rejects.toThrow();
    const b = Object.defineProperty(structuredClone(f.binding), 'guideType', { enumerable: true, get: getter });
    await expect(f.core.command(f.token, f.kind, b, 'CREATE', null, guideKey, undefined, guideBody())).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(trap).not.toHaveBeenCalled();
    expect(f.store.transactions).toBe(0); expect(f.store.rows.size).toBe(0); expect(f.store.ops.size).toBe(0);
  });
  it('rejects cyclic bodies without traversing forever', async () => {
    const f = guideFixture(), cyclic: any = guideBody(); cyclic.origin = cyclic;
    await expect(f.command('CREATE', null, guideKey, undefined, cyclic)).rejects.toThrow();
    expect(f.store.transactions).toBe(0);
  });
  it.each(['short', 'a'.repeat(101), 'invalid:key:000000000', 'invalid key 000000000'])('rejects unsafe idempotency key %j', async key => {
    const f = guideFixture(); await expect(f.command('CREATE', null, key)).rejects.toMatchObject({ code: 'INVALID_GUIDE_COMMAND' });
    expect(f.store.transactions).toBe(0);
  });
  it.each(['READY', 'CANCEL'] as const)('requires an empty command body for %s', async action => {
    const f = await created(), before = snapshot(f.store);
    for (const input of [null, [], 'anything', { accepted: true }, { reason: 'FICTICIO' }])
      await expect(f.command(action, f.id, guideKey + '_x', '"v1"', input)).rejects.toMatchObject({ code: 'EMPTY_COMMAND_REQUIRED' });
    expect(f.store.state).toEqual(before);
  });
  it.each(['', 'contains space', 'line\nbreak', 'x'.repeat(8193)])('rejects invalid token %j', async token => {
    const f = guideFixture();
    await expect(f.core.command(token, f.kind, f.binding, 'CREATE', null, guideKey, undefined, guideBody()))
      .rejects.toMatchObject({ status: 401 }); expect(f.store.transactions).toBe(0);
  });
  it('rejects linked-human mismatches instead of fabricating a SERVICE user', async () => {
    const f = guideFixture('USER'); f.access.actor.userId = guideUuid(900);
    await expect(f.command()).rejects.toThrow(); expect(f.store.rows.size).toBe(0);
    const service = guideFixture(); service.access.actor.userId = guideUuid(901);
    await expect(service.command()).rejects.toThrow(); expect(service.store.ops.size).toBe(0);
  });
});
