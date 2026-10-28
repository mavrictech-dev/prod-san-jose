import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { b2bGuideBindingKey, validB2bGuideBinding } from '@factuez/contracts/b2b-guide-security';
import { B2bPhase2Scopes } from '../packages/contracts/src/b2b-security';
import { B2bGuideAuthority, guideReadScopes, guideWriteScopes, guideOperationScopes } from '../services/identity-service/src/b2b/guide-authority';
import { B2bGuideAuthorityController, B2bGuideAuthorityModule } from '../services/identity-service/src/b2b/guide-http';
import { PostgresB2bGuideStore } from '../services/identity-service/src/b2b/guide-store';
import { binding, ctx, id } from './b2b-identity.fixture';
import { guideFixture, guidePair } from './b2b-guide-authority.fixture';

describe('B2B07 explicit independent guide authority; no fiscal activation', () => {
  it('keeps default scopes unchanged and separates 09/31 from actual invoice/boleta anchors', () => {
    expect(B2bPhase2Scopes).toEqual(['b2b:context:read', 'b2b:catalog:read']);
    expect(validB2bGuideBinding(guidePair())).toBe(true);
    expect(validB2bGuideBinding({ ...guidePair(), guideType: '31' })).toBe(true);
    expect(b2bGuideBindingKey(guidePair())).not.toBe(b2bGuideBindingKey({ ...guidePair(), guideType: '31' }));
    expect(guideReadScopes).toEqual(['b2b:guides:read', 'b2b:documents:read']);
    expect(guideWriteScopes).toEqual(['b2b:guides:write', 'b2b:documents:read']);
    expect(guideOperationScopes).toEqual(['b2b:guides:read', 'b2b:documents:read', 'b2b:guide-operations:read']);
  });
  it('base context and guide scope do not imply an explicit guide grant', async () => {
    const f = await guideFixture();
    await expect(f.authorize()).rejects.toMatchObject({ status: 404 });
    expect(f.grants.size).toBe(0); expect(f.catalogue.validate).not.toHaveBeenCalled();
    expect(f.memory.audits.at(-1)).toMatchObject({ action: 'AUTHORIZE_GUIDE_READ', outcome: 'DENIED', actorId: null });
  });
  it.each(['09', '31'] as const)('grants explicit %s registry pair, never a fabricated human or extra series', async guideType => {
    const f = await guideFixture(), pair = { ...guidePair(), guideType };
    const saved = await f.replace([pair]), answer = await f.authorize(pair, 'WRITE');
    expect(saved).toMatchObject({ revision: 1, clientRevision: 1, candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false });
    expect(Object.keys(answer).sort()).toEqual(['action', 'actor', 'binding', 'candidateOnly', 'clientRevision', 'fiscalExecutionEnabled', 'grantRevision', 'schemaVersion', 'transmissionAuthorized'].sort());
    expect(answer).toMatchObject({ schemaVersion: 'factuez.b2b.guide-authorization.v1', action: 'WRITE', binding: pair, grantRevision: 1,
      actor: { userId: null, b2b: { kind: 'SERVICE', subjectId: null, userAuthRevision: null }, scope: {
        kind: 'ASSIGNED', branchIds: [binding.branchId], emissionPointIds: [binding.pointId], series: [binding.seriesId, pair.guideSeriesId],
      } }, candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false });
    expect(f.catalogue.validate).toHaveBeenCalledTimes(2);
    expect(f.store).not.toHaveProperty('reserve'); expect(f.store).not.toHaveProperty('issue');
  });
  it.each([
    () => ({ ...guidePair(), guideType: '31' }),
    () => ({ ...guidePair(), guideSeriesId: id(71) }),
    () => ({ ...guidePair(), anchor: { ...binding, issuerId: 2 } }),
    () => ({ ...guidePair(), anchor: { ...binding, issuerRuc: '00000000002' } }),
    () => ({ ...guidePair(), anchor: { ...binding, branchId: id(80) } }),
    () => ({ ...guidePair(), anchor: { ...binding, pointId: id(81) } }),
    () => ({ ...guidePair(), anchor: { ...binding, seriesId: id(82) } }),
    () => ({ ...guidePair(), anchor: { ...binding, documentType: '03' } }),
  ])('denies cross-product or ungranted pair %#', async change => {
    const f = await guideFixture(); await f.replace();
    await expect(f.authorize(change())).rejects.toMatchObject({ status: 404 });
    expect(f.catalogue.validate).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['READ', [...guideReadScopes]], ['WRITE', [...guideWriteScopes]], ['OPERATION', [...guideOperationScopes]],
  ] as const)('allows exactly scoped %s client enrollment and authorization', async (action, scopes) => {
    const f = await guideFixture('SERVICE', [...scopes]); await f.replace();
    expect(await f.authorize(guidePair(), action)).toMatchObject({ action, grantRevision: 1 });
  });
  it.each([
    ['READ', [...guideWriteScopes]], ['WRITE', [...guideReadScopes]], ['OPERATION', [...guideReadScopes]],
  ] as const)('denies %s with insufficient action scopes', async (action, scopes) => {
    const f = await guideFixture('SERVICE', [...scopes]); await f.replace();
    await expect(f.authorize(guidePair(), action)).rejects.toMatchObject({ status: 403 });
  });
  it.each([
    { scopes: ['b2b:documents:read'] }, { scopes: ['b2b:guides:read'] }, { scopes: ['b2b:guides:write'] },
    { scopes: ['b2b:documents:read', 'b2b:documents:issue', 'b2b:corrections:write'] },
  ] as const)('does not infer enrollment from incomplete or correction scopes %#', async ({ scopes }) => {
    const f = await guideFixture('SERVICE', [...scopes]);
    await expect(f.replace()).rejects.toMatchObject({ status: 400, code: 'INVALID_GUIDE_BINDINGS' });
    expect(f.grants.size).toBe(0);
  });
  it('correction grants or lookalike labels cannot supply missing guide grants', async () => {
    const f = await guideFixture();
    (f.store as any).correctionGrants = vi.fn(async () => ({ bindings: [guidePair()] }));
    await expect(f.authorize()).rejects.toMatchObject({ status: 404 });
    expect((f.store as any).correctionGrants).not.toHaveBeenCalled();
  });
  it('requires step-up for read as well as replacement', async () => {
    const f = await guideFixture();
    await expect(f.core.read('password-only', f.made.client.id, ctx())).rejects.toMatchObject({ status: 403 });
    await expect(f.core.replace('password-only', f.made.client.id, { bindings: [], expectedClientRevision: 1, expectedGrantRevision: 0 }, ctx())).rejects.toMatchObject({ status: 403 });
  });
  it.each(['step-up', 'id', 'down'])('rejects malformed/outage administrator: %s', async mode => {
    const f = await guideFixture();
    if (mode === 'down') f.admin.verify.mockRejectedValueOnce(new Error('down'));
    else f.admin.verify.mockResolvedValueOnce({ id: mode === 'id' ? 'not-uuid' : id(9), stepUpVerified: mode !== 'step-up' } as any);
    await expect(f.core.read('human-step-up', f.made.client.id, ctx())).rejects.toMatchObject({ status: mode === 'down' ? 503 : 403 });
  });
  it('reads current, stale and revoked grant revisions without auto-renewal', async () => {
    const f = await guideFixture();
    expect(await f.core.read('human-step-up', f.made.client.id, ctx())).toMatchObject({ revision: 0, grantedClientRevision: null, bindings: [], current: false });
    await f.replace();
    expect(await f.core.read('human-step-up', f.made.client.id, ctx())).toMatchObject({ revision: 1, current: true });
    await f.identity.change('human-step-up', f.made.client.id, { expectedRevision: 1 }, ctx(), true);
    expect(await f.core.read('human-step-up', f.made.client.id, ctx())).toMatchObject({ revision: 1, current: false, clientRevision: 2, grantedClientRevision: 1 });
    await expect(f.authorize()).rejects.toMatchObject({ status: 401 });
  });
  it('serializes enrollment CAS and persists revocation as a new empty immutable revision', async () => {
    const f = await guideFixture(), results = await Promise.allSettled([f.replace(), f.replace()]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')[0]).toMatchObject({ reason: { status: 409 } });
    await f.replace([], 1);
    expect(f.grants.get(f.made.client.id)).toMatchObject({ revision: 2, bindings: [] });
    await expect(f.authorize()).rejects.toMatchObject({ status: 404 });
  });
  it('audits enrollment/read/denial transactionally without recording token or client secret', async () => {
    const f = await guideFixture(); await f.replace(); await f.core.read('human-step-up', f.made.client.id, ctx());
    await f.authorize(); await f.authorize(guidePair(), 'WRITE'); await f.authorize(guidePair(), 'OPERATION');
    expect(f.memory.audits.filter(row => row.action.includes('GUIDE')).map(row => row.action)).toEqual(['REPLACE_GUIDE_GRANTS', 'READ_GUIDE_GRANTS', 'AUTHORIZE_GUIDE_READ', 'AUTHORIZE_GUIDE_WRITE', 'AUTHORIZE_GUIDE_OPERATION']);
    const serialized = JSON.stringify(f.memory.audits);
    expect(serialized).not.toContain(f.token); expect(serialized).not.toContain(f.made.clientSecret);
    expect(f.memory.audits.at(-1)?.peerHash).toMatch(/^[a-f0-9]{64}$/);
    f.memory.failAudit = true;
    await expect(f.replace([], 1)).rejects.toMatchObject({ status: 503 });
    expect(f.grants.get(f.made.client.id)?.revision).toBe(1);
    await expect(f.authorize()).rejects.toMatchObject({ status: 503 });
  });
  it.each(['enroll', 'read', 'authorize'])('database or quota failure is closed for %s', async action => {
    const f = await guideFixture(); f.memory.down = true;
    const work = action === 'enroll' ? f.replace() : action === 'read' ? f.core.read('human-step-up', f.made.client.id, ctx()) : f.authorize();
    await expect(work).rejects.toMatchObject({ status: 503 });
  });
  it('enforces per-peer quotas and validates request context before authentication', async () => {
    const f = await guideFixture(); f.memory.limited = true;
    await expect(f.authorize()).rejects.toMatchObject({ status: 429 });
    f.memory.limited = false;
    for (const context of [{ ...ctx(), requestId: 'bad' }, { ...ctx(), peer: '' }, { ...ctx(), peer: 'a'.repeat(257) }])
      await expect(f.core.authorize(f.token, { binding: guidePair(), kind: 'SERVICE', action: 'READ' }, context)).rejects.toMatchObject({ status: 400 });
  });
  it('catalogue cross-owner/disabled registry denial prevents saving or successful authorization', async () => {
    const f = await guideFixture(); f.catalogue.validate.mockRejectedValueOnce(new Error('owner unavailable'));
    await expect(f.replace()).rejects.toMatchObject({ status: 503 }); expect(f.grants.size).toBe(0);
    await f.replace(); f.catalogue.validate.mockRejectedValueOnce(new Error('registry disabled'));
    await expect(f.authorize()).rejects.toMatchObject({ status: 503 });
    expect(f.grants.get(f.made.client.id)?.revision).toBe(1);
  });
  it('defends against catalogue mutation of caller data and returned detached bindings', async () => {
    const f = await guideFixture(), pair = guidePair();
    f.catalogue.validate.mockImplementationOnce(async rows => { (rows[0] as any).guideSeriesId = id(99); });
    const saved = await f.replace([pair]); saved.bindings[0].guideSeriesId = id(98); pair.guideSeriesId = id(97);
    const answer = await f.authorize(); expect(answer.binding.guideSeriesId).toBe(id(70));
    answer.binding.guideSeriesId = id(96);
    expect((await f.authorize()).binding.guideSeriesId).toBe(id(70));
  });
  it.each(['disabled', 'kind', 'revision', 'anchor', 'scope'])('rechecks live client after introspection: %s', async mode => {
    const f = await guideFixture(); await f.replace();
    const identity = { authenticate: async (...args: Parameters<typeof f.identity.authenticate>) => {
      const p = await f.identity.authenticate(...args), c = f.memory.clients.get(f.made.client.id)!;
      if (mode === 'disabled') c.enabled = false;
      if (mode === 'kind') c.kind = 'USER';
      if (mode === 'revision') c.revision++;
      if (mode === 'anchor') c.bindings = [{ ...binding, pointId: id(90) }];
      if (mode === 'scope') c.scopes = ['b2b:documents:read'];
      return p;
    } };
    const authority = new B2bGuideAuthority(f.store, identity, f.catalogue, f.admin, f.users);
    await expect(authority.authorize(f.token, { binding: guidePair(), kind: 'SERVICE', action: 'READ' }, ctx())).rejects.toMatchObject({ status: 404 });
  });
  it.each(['subject', 'kind', 'environment', 'scope', 'binding', 'extra'])('rejects malformed authenticated principal: %s', async mode => {
    const f = await guideFixture(); await f.replace();
    const p: any = await f.identity.authenticate(f.token, [...guideReadScopes], ctx(), 'SERVICE');
    if (mode === 'subject') p.subjectId = id(50);
    if (mode === 'kind') p.kind = 'USER';
    if (mode === 'environment') p.environment = 'PRODUCTION';
    if (mode === 'scope') p.scopes = ['b2b:documents:read'];
    if (mode === 'binding') p.bindings = [];
    if (mode === 'extra') p.guideBindings = [guidePair()];
    const authority = new B2bGuideAuthority(f.store, { authenticate: async () => p }, f.catalogue, f.admin);
    await expect(authority.authorize(f.token, { binding: guidePair(), kind: 'SERVICE', action: 'READ' }, ctx())).rejects.toMatchObject({ status: 401 });
  });
  it.each(['client', 'revision', 'clientRevision', 'bindings', 'environment'])('denies corrupt stored grants rather than borrowing base grants: %s', async mode => {
    const f = await guideFixture(); await f.replace(); const g: any = f.grants.get(f.made.client.id)!;
    if (mode === 'client') g.clientId = id(99);
    if (mode === 'revision') g.revision = 0;
    if (mode === 'clientRevision') g.clientRevision = 0;
    if (mode === 'bindings') g.bindings = [{ ...guidePair(), guideType: '01' }];
    if (mode === 'environment') g.environment = 'PRODUCTION';
    await expect(f.authorize()).rejects.toMatchObject({ status: 503 });
  });
  it('stale client revision in explicit grants does not inherit a current principal', async () => {
    const f = await guideFixture(); await f.replace(); f.grants.get(f.made.client.id)!.clientRevision = 2;
    await expect(f.authorize()).rejects.toMatchObject({ status: 404 });
  });
  it.each(['READ', 'WRITE', 'OPERATION'] as const)('USER %s stays narrowed even when linked user is global', async action => {
    const f = await guideFixture('USER'); await f.replace(); f.users.current.mockResolvedValueOnce({ active: true, authVersion: 3,
      permissions: ['document.view', 'document.issue'], scope: { kind: 'GLOBAL' } });
    const answer = await f.authorize(guidePair(), action);
    expect(answer.actor).toMatchObject({ userId: id(50), b2b: { kind: 'USER', subjectId: id(50), userAuthRevision: 3 },
      scope: { kind: 'ASSIGNED', branchIds: [binding.branchId], emissionPointIds: [binding.pointId], series: [binding.seriesId, id(70)] } });
  });
  it.each(['READ', 'OPERATION'] as const)('USER %s needs document.view but not document.issue', async action => {
    const f = await guideFixture('USER'); await f.replace(); f.linked.permissions = ['document.view'];
    expect(await f.authorize(guidePair(), action)).toMatchObject({ action });
  });
  it('real Identity lets a view-only USER read guide operations but never grants legacy operations:read', async () => {
    // Both scopes are explicitly enrolled and present in the upstream token so this
    // proves the legacy denial is the real human rule, not merely an absent grant.
    const f = await guideFixture('USER', [...guideOperationScopes, 'b2b:operations:read']);
    await f.replace(); f.linked.permissions = ['document.view'];
    const principal = await f.identity.authenticate(f.token, [...guideOperationScopes], ctx(), 'USER');
    expect(principal.scopes).toContain('b2b:guide-operations:read');
    expect(principal.scopes).not.toContain('b2b:operations:read');
    expect(principal.scopes).not.toContain('b2b:guides:write');
    const response = await f.authorize(guidePair(), 'OPERATION');
    expect(response).toMatchObject({ action: 'OPERATION', actor: { userId: id(50), b2b: { kind: 'USER' } },
      candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false });
    await expect(f.identity.authenticate(f.token, ['b2b:operations:read'], ctx(), 'USER'))
      .rejects.toMatchObject({ status: 403, code: 'INSUFFICIENT_SCOPE' });
  });
  it.each(['SERVICE', 'USER'] as const)('legacy operations:read cannot substitute for the dedicated guide scope: %s', async kind => {
    const f = await guideFixture(kind, [...guideReadScopes, 'b2b:operations:read']); await f.replace();
    await expect(f.authorize(guidePair(), 'OPERATION')).rejects.toMatchObject({ status: 403, code: 'INSUFFICIENT_SCOPE' });
  });
  it('real Identity excludes guide write for view-only USER, and the guide authority never authorizes WRITE', async () => {
    const f = await guideFixture('USER'); await f.replace(); f.linked.permissions = ['document.view'];
    const principal = await f.identity.authenticate(f.token, [...guideReadScopes], ctx(), 'USER');
    expect(principal.scopes).not.toContain('b2b:guides:write');
    await expect(f.identity.authenticate(f.token, [...guideWriteScopes], ctx(), 'USER'))
      .rejects.toMatchObject({ status: 403, code: 'INSUFFICIENT_SCOPE' });
    await expect(f.authorize(guidePair(), 'WRITE')).rejects.toMatchObject({ status: 403, code: 'INSUFFICIENT_SCOPE' });
  });
  it.each(['link', 'active', 'version', 'view', 'issue', 'branch', 'point', 'anchor', 'guide'])('USER live %s revocation denies WRITE', async mode => {
    const f = await guideFixture('USER'); await f.replace();
    const user: any = { active: mode !== 'active', authVersion: mode === 'version' ? 4 : 3,
      permissions: ['document.view', 'document.issue'].filter(p => p !== (mode === 'view' ? 'document.view' : mode === 'issue' ? 'document.issue' : '')),
      scope: { kind: 'ASSIGNED', branchIds: [mode === 'branch' ? id(98) : binding.branchId], emissionPointIds: [mode === 'point' ? id(98) : binding.pointId],
        series: [mode === 'anchor' ? id(98) : binding.seriesId, mode === 'guide' ? id(98) : id(70)] } };
    f.users.current.mockResolvedValueOnce(mode === 'link' ? null : user);
    await expect(f.authorize(guidePair(), 'WRITE')).rejects.toMatchObject({ status: 404 });
    expect(f.memory.audits.at(-1)).toMatchObject({ outcome: 'DENIED', actorId: id(50) });
  });
  it('USER linkage outage fails closed; SERVICE never calls the human resolver', async () => {
    const f = await guideFixture('USER'); await f.replace(); f.users.current.mockRejectedValueOnce(new Error('link down'));
    await expect(f.authorize()).rejects.toMatchObject({ status: 503 });
    const s = await guideFixture(); await s.replace(); await s.authorize(); expect(s.users.current).not.toHaveBeenCalled();
  });
  it.each([
    null, [], {}, { binding: guidePair(), kind: 'SERVICE' }, { binding: guidePair(), kind: 'SERVICE', action: 'ISSUE' },
    { binding: guidePair(), kind: 'ADMIN', action: 'READ' }, { binding: guidePair(), kind: 'SERVICE', action: 'READ', production: true },
    { binding: { ...guidePair(), guideType: '01' }, kind: 'SERVICE', action: 'READ' },
    { binding: { ...guidePair(), guideSeriesId: binding.seriesId }, kind: 'SERVICE', action: 'READ' },
    { binding: { ...guidePair(), anchor: { ...binding, environment: 'PRODUCTION' } }, kind: 'SERVICE', action: 'READ' },
  ])('rejects invalid exact request shape %#', async body => {
    const f = await guideFixture(); await expect(f.core.authorize(f.token, body, ctx())).rejects.toMatchObject({ status: 400 });
  });
  it('rejects duplicate, oversized or unowned enrollment and preserves the 500-pair ceiling', async () => {
    const f = await guideFixture();
    for (const rows of [[guidePair(), guidePair()], Array.from({ length: 501 }, (_, n) => ({ ...guidePair(), guideSeriesId: id(100 + n) })),
      [{ ...guidePair(), anchor: { ...binding, pointId: id(99) } }]]) await expect(f.replace(rows)).rejects.toMatchObject({ status: 400 });
    const pairs = Array.from({ length: 500 }, (_, n) => ({ ...guidePair(), guideSeriesId: id(100 + n) }));
    expect((await f.replace(pairs)).bindings).toHaveLength(500);
  });
  it.each([-1, 0, 1.5, 2147483648, NaN, Infinity, '1'])('rejects invalid expectedClientRevision %s', async expectedClientRevision => {
    const f = await guideFixture();
    await expect(f.core.replace('human-step-up', f.made.client.id, { bindings: [], expectedClientRevision, expectedGrantRevision: 0 }, ctx())).rejects.toMatchObject({ status: 400 });
  });
  it.each([-1, 1.5, 2147483647, NaN, Infinity, '0'])('rejects invalid expectedGrantRevision %s', async expectedGrantRevision => {
    const f = await guideFixture();
    await expect(f.core.replace('human-step-up', f.made.client.id, { bindings: [], expectedClientRevision: 1, expectedGrantRevision }, ctx())).rejects.toMatchObject({ status: 400 });
  });
  it('denies stale client/grant revisions and unknown clients', async () => {
    const f = await guideFixture(); await f.replace();
    await expect(f.replace([], 1, 2)).rejects.toMatchObject({ status: 409 });
    await expect(f.replace([], 0)).rejects.toMatchObject({ status: 409 });
    await expect(f.core.read('human-step-up', id(99), ctx())).rejects.toMatchObject({ status: 404 });
    await expect(f.core.replace('human-step-up', id(99), { bindings: [], expectedClientRevision: 1, expectedGrantRevision: 0 }, ctx())).rejects.toMatchObject({ status: 404 });
  });
  it('validates bounded JSON without evaluating getters or proxy traps', async () => {
    const f = await guideFixture(), getter = vi.fn(() => guidePair()), trap = vi.fn(() => { throw new Error('must not run'); });
    const accessor = { kind: 'SERVICE', action: 'READ', get binding() { return getter(); } };
    const proxy = new Proxy({}, { ownKeys: trap, getPrototypeOf: trap, get: trap });
    const cycle: any = {}; cycle.self = cycle;
    const symbol: any = { binding: guidePair(), kind: 'SERVICE', action: 'READ', [Symbol('hidden')]: 1 };
    const polluted = JSON.parse('{"__proto__":{"polluted":true}}');
    let deep: any = {}; for (let n = 0; n < 20; n++) deep = { nested: deep };
    for (const body of [accessor, proxy, cycle, symbol, polluted, deep, { giant: 'a'.repeat(1048577) }, new Date(), { value: undefined }])
      await expect(f.core.authorize(f.token, body, ctx())).rejects.toMatchObject({ status: 400 });
    expect(getter).not.toHaveBeenCalled(); expect(trap).not.toHaveBeenCalled();
    const sparse = new Array(2); sparse[1] = guidePair(); await expect(f.replace(sparse)).rejects.toMatchObject({ status: 400 });
  });
});

describe('B2B07 candidate PostgreSQL adapter and private HTTP boundary', () => {
  function database() {
    const sql = { $queryRawUnsafe: vi.fn(async (_query: string, ..._params: unknown[]): Promise<any[]> => []),
      $executeRawUnsafe: vi.fn(async (_query: string, ..._params: unknown[]) => 1) };
    const db = { ...sql, $transaction: vi.fn(async (work: any, _options: any) => work(sql)) };
    return { sql, db, store: new PostgresB2bGuideStore(db) };
  }
  it('locks BETA guide heads and uses parameterized, same-owner SQL', async () => {
    const f = database();
    f.sql.$queryRawUnsafe.mockResolvedValueOnce([{ clientId: id(8), clientRevision: 1, revision: 2, bindings: [guidePair()] }]);
    expect(await f.store.transaction(tx => tx.guideGrants(id(8)))).toMatchObject({ revision: 2 });
    const [query, value] = f.sql.$queryRawUnsafe.mock.calls[0];
    expect(query).toContain('FOR UPDATE OF h'); expect(query).toContain(`r."environment"='BETA'`); expect(query).not.toContain(id(8)); expect(value).toBe(id(8));
    expect(f.db.$transaction.mock.calls[0][1]).toEqual({ timeout: 15000, maxWait: 3000 });
  });
  it.each([0, 1])('inserts immutable revision then CAS head for expected %i', async expected => {
    const f = database(), row = { clientId: id(8), clientRevision: 1, revision: expected + 1, bindings: [guidePair()] };
    await f.store.transaction(tx => tx.saveGuideGrants(row, expected, id(9), '2026-10-21T12:00:00.000Z'));
    expect(f.sql.$executeRawUnsafe.mock.calls[0][0]).toContain('INSERT INTO "B2bGuideGrantRevision"');
    expect(f.sql.$executeRawUnsafe.mock.calls[0][4]).toBe(JSON.stringify([guidePair()]));
    expect(f.sql.$executeRawUnsafe.mock.calls[1][0]).toContain(expected === 0 ? 'ON CONFLICT DO NOTHING' : '"revision"=$3');
  });
  it('rejects lost CAS and nonconsecutive revision, never silently overwrites a head', async () => {
    const f = database(), row = { clientId: id(8), clientRevision: 1, revision: 2, bindings: [] };
    await expect(f.store.transaction(tx => tx.saveGuideGrants(row, 0, id(9), '2026-10-21T12:00:00.000Z'))).rejects.toMatchObject({ status: 409 });
    expect(f.sql.$executeRawUnsafe).not.toHaveBeenCalled();
    f.sql.$executeRawUnsafe.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    await expect(f.store.transaction(tx => tx.saveGuideGrants(row, 1, id(9), '2026-10-21T12:00:00.000Z'))).rejects.toMatchObject({ status: 409 });
  });
  it('construction has no SQL, grant seed, DB migration or rate side effect', () => {
    const f = database(); expect(f.sql.$executeRawUnsafe).not.toHaveBeenCalled(); expect(f.db.$transaction).not.toHaveBeenCalled();
  });
  it('rate limiter delegates only hashed peer buckets', async () => {
    const f = database(); f.db.$queryRawUnsafe.mockResolvedValueOnce([{ count: 1 }]);
    expect(await f.store.rate('a'.repeat(64), 123, 30)).toBe(true);
    expect(f.db.$queryRawUnsafe.mock.calls[0].slice(1)).toEqual(['a'.repeat(64), 123, 30]);
  });
  const adminPeer = 'a'.repeat(64), ownerPeer = 'b'.repeat(64);
  function http() {
    const core = { read: vi.fn(async () => ({ ok: true })), replace: vi.fn(async () => ({ ok: true })), authorize: vi.fn(async () => ({ ok: true })) };
    const controller = new B2bGuideAuthorityController(core as any, { admin: [adminPeer], owner: [ownerPeer] });
    const req = (fingerprint: string) => ({ headers: { authorization: 'Bearer synthetic.token' }, socket: {
      encrypted: true, authorized: true, remoteAddress: '127.0.0.1', getPeerCertificate: () => ({ fingerprint256: fingerprint }),
    } });
    const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() }; res.status.mockReturnValue(res);
    return { core, controller, req, res };
  }
  it.each(['read', 'replace', 'authorize'] as const)('private %s checks peer before reaching domain and prevents caching', async action => {
    const f = http(), request = f.req(action === 'authorize' ? ownerPeer : adminPeer), body = { binding: guidePair(), action: 'READ', kind: 'SERVICE' };
    if (action === 'read') await f.controller.read(request, f.res, id(8));
    else if (action === 'replace') await f.controller.replace(request, f.res, id(8), body);
    else await f.controller.authorize(request, f.res, body);
    expect(f.core[action]).toHaveBeenCalledTimes(1);
    expect(f.core[action].mock.calls[0][0]).toBe('synthetic.token');
    expect(f.res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(f.res.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
  });
  it.each(['unencrypted', 'unauthorized', 'unknown-peer', 'enrollment-peer'])('owner rejects %s before domain call', async mode => {
    const f = http(), req = f.req(mode === 'enrollment-peer' ? adminPeer : mode === 'unknown-peer' ? 'c'.repeat(64) : ownerPeer);
    if (mode === 'unencrypted') req.socket.encrypted = false;
    if (mode === 'unauthorized') req.socket.authorized = false;
    await expect(f.controller.authorize(req, f.res, {})).rejects.toMatchObject({ status: 403 }); expect(f.core.authorize).not.toHaveBeenCalled();
  });
  it('owner peer cannot enroll or inspect grants', async () => {
    const f = http();
    await expect(f.controller.read(f.req(ownerPeer), f.res, id(8))).rejects.toMatchObject({ status: 403 });
    await expect(f.controller.replace(f.req(ownerPeer), f.res, id(8), {})).rejects.toMatchObject({ status: 403 });
    expect(f.core.read).not.toHaveBeenCalled(); expect(f.core.replace).not.toHaveBeenCalled();
  });
  it.each([undefined, '', 'Basic abc', 'Bearer with space', ['Bearer token'], 'Bearer ' + 'x'.repeat(8193)])('rejects malformed bearer %#', async header => {
    const f = http(), req: any = f.req(ownerPeer); req.headers.authorization = header;
    await expect(f.controller.authorize(req, f.res, {})).rejects.toMatchObject({ status: 401 }); expect(f.core.authorize).not.toHaveBeenCalled();
  });
  it.each([
    null, {}, { admin: [], owner: [ownerPeer] }, { admin: [adminPeer], owner: [] }, { admin: [adminPeer], owner: [adminPeer] },
    { admin: [adminPeer, adminPeer], owner: [ownerPeer] }, { admin: ['bad'], owner: [ownerPeer] },
    { admin: [adminPeer], owner: [ownerPeer], public: [ownerPeer] }, { admin: 'bad', owner: [ownerPeer] },
  ])('rejects ambiguous/private peer configuration %#', async peers => {
    expect(() => B2bGuideAuthorityModule.isolated({} as any, peers as any)).toThrow();
  });
  it('freezes detached mTLS enrollment and owner lists without registering a main application', () => {
    const peers = { admin: [adminPeer], owner: [ownerPeer] }, module = B2bGuideAuthorityModule.isolated({} as any, peers);
    peers.owner[0] = adminPeer;
    const configured = (module.providers![1] as any).useValue;
    expect(configured).toEqual({ admin: [adminPeer], owner: [ownerPeer] }); expect(Object.isFrozen(configured.owner)).toBe(true);
    for (const file of ['app.module.ts', 'main.ts']) expect(readFileSync(`services/identity-service/src/${file}`, 'utf8')).not.toContain('B2bGuide');
  });
  it('candidate SQL keeps revisions immutable and heads monotonic without inferred grants', () => {
    const sql = readFileSync('services/identity-service/b2b-guide-grants-schema.candidate.sql', 'utf8');
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON "B2bGuideGrantRevision"');
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON "B2bGuideGrantHead"');
    expect(sql).toContain('OLD."revision"+1'); expect(sql).toContain('GUIDE_GRANT_HEAD_CAS_REQUIRED');
    expect(sql).toContain(`CHECK ("environment"='BETA')`); expect(sql).toContain('jsonb_array_length("bindings")<=500');
    expect(sql).not.toMatch(/INSERT\s+INTO/i); expect(sql).not.toContain('SeriesCounter');
  });
});
