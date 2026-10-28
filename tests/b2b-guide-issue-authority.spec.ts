import { describe, it, expect, vi } from 'vitest';
import { B2bPhase2Scopes } from '../packages/contracts/src/b2b-security';
import { B2bGuideIssueAuthority, guideIssueJson } from '../services/identity-service/src/b2b/guide-issue-authority';
import { fail } from '../services/identity-service/src/b2b/model';
import { ctx, binding, id, basic } from './b2b-identity.fixture';
import { guideIssueFixture, issuePair } from './b2b-guide-issue-authority.fixture';

describe('persistent independent ISSUE / READ Identity authority candidate', () => {
  it('has no defaults or inheritance from draft WRITE or context bindings', async () => {
    expect(B2bPhase2Scopes).toEqual(['b2b:context:read', 'b2b:catalog:read']);
    const f = await guideIssueFixture();
    await expect(f.authorize()).rejects.toMatchObject({ status: 404, code: 'RESOURCE_NOT_FOUND' });
    expect(f.memory.audits.at(-1)).toMatchObject({ action: 'AUTHORIZE_GUIDE_ISSUE_ISSUE', outcome: 'DENIED', actorId: null });
    expect(f.grants.size).toBe(0); expect(f.catalogue.validate).not.toHaveBeenCalled();
  });
  it('returns exactly the agreed keys, genuine SERVICE attribution and three exact series', async () => {
    const f = await guideIssueFixture(); await f.replace();
    const answer = await f.authorize();
    expect(Object.keys(answer).sort()).toEqual(['schemaVersion', 'action', 'capability', 'binding', 'actor', 'clientRevision', 'grantRevision',
      'candidateOnly', 'fiscalExecutionEnabled', 'transmissionAuthorized'].sort());
    expect(answer).toEqual({ schemaVersion: 'factuez.b2b.guide-issue-authorization.v1', action: 'ISSUE', capability: 'BETA_GUIDE_ISSUE_LOCAL',
      binding: issuePair(), clientRevision: 1, grantRevision: 1, candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false,
      actor: { userId: null, scope: { kind: 'ASSIGNED', branchIds: [binding.branchId], emissionPointIds: [binding.pointId],
        series: [binding.seriesId, id(70), id(71)] }, b2b: { kind: 'SERVICE', clientId: f.made.client.id, revision: 1, subjectId: null, userAuthRevision: null } } });
    expect(f.users.current).not.toHaveBeenCalled();
    expect(f.catalogue.validate.mock.calls).toEqual([[[issuePair()], 'ISSUE'], [[issuePair()], 'ISSUE']]);
    expect(JSON.stringify(answer)).not.toContain(f.token);
  });
  it('READ revalidates owner links using READ even when current ISSUE metadata is inactive or exhausted', async () => {
    const f = await guideIssueFixture(); await f.replace();
    f.catalogue.validate.mockImplementation(async (_pairs, action) => { if (action === 'ISSUE') fail(400, 'INACTIVE_SYNTHETIC_SERIES'); });
    await expect(f.authorize()).rejects.toMatchObject({ status: 404, code: 'RESOURCE_NOT_FOUND' });
    expect(f.memory.audits.at(-1)?.outcome).toBe('DENIED');
    expect(await f.authorize(issuePair(), 'READ')).toMatchObject({ action: 'READ', grantRevision: 1 });
    expect(f.catalogue.validate).toHaveBeenLastCalledWith([issuePair()], 'READ');
  });
  it.each([
    () => ({ ...issuePair(), fiscalSeriesId: id(72) }),
    () => ({ ...issuePair(), draft: { ...issuePair().draft, guideSeriesId: id(73) } }),
    () => ({ ...issuePair(), draft: { ...issuePair().draft, guideType: '31' } }),
    ...(['issuerId', 'issuerRuc', 'branchId', 'pointId', 'seriesId', 'documentType'] as const).map(key => () => ({ ...issuePair(), draft: {
      ...issuePair().draft, anchor: { ...binding, [key]: key === 'issuerId' ? 2 : key === 'issuerRuc' ? '00000000002' : key === 'documentType' ? '03' : id(80) },
    } })),
  ])('whole binding comparison denies each ungranted dimension %# with persisted denial', async change => {
    const f = await guideIssueFixture(); await f.replace(); const count = f.catalogue.validate.mock.calls.length;
    await expect(f.authorize(change())).rejects.toMatchObject({ status: 404 });
    expect(f.catalogue.validate).toHaveBeenCalledTimes(count); expect(f.memory.audits.at(-1)?.outcome).toBe('DENIED');
  });
  it('registration accepts only closed local guide types and requires action scopes plus the exact anchor', async () => {
    const f = await guideIssueFixture();
    await expect(f.replace([{ ...issuePair(), draft: { ...issuePair().draft, guideType: '32' } }])).rejects.toMatchObject({ status: 400 });
    const draftOnly = await guideIssueFixture('SERVICE', ['b2b:documents:read', 'b2b:guides:write']);
    await expect(draftOnly.replace()).rejects.toMatchObject({ status: 400 });
    await expect(f.replace([{ ...issuePair(), draft: { ...issuePair().draft, anchor: { ...binding, issuerId: 2 } } }])).rejects.toMatchObject({ status: 400 });
  });
  it.each(['SERVICE','USER'] as const)('enrolls a read-only %s without granting issue', async kind => {
    const f = await guideIssueFixture(kind, ['b2b:documents:read', 'b2b:guides:read', 'b2b:guide-operations:read']);
    f.linked.permissions = ['document.view']; await f.replace();
    expect(f.catalogue.validate).toHaveBeenLastCalledWith([issuePair()], 'READ');
    expect(await f.authorize(issuePair(), 'READ')).toMatchObject({ action: 'READ', candidateOnly: true });
    await expect(f.authorize()).rejects.toMatchObject({ status: 403 });
    expect(f.made.client.scopes).not.toContain('b2b:guides:issue');
  });
  it.each(['anchor', 'draft', 'fiscal', 'point', 'branch', 'view', 'issue', 'authRevision', 'inactive', 'link'])(
    'checks live USER %s on each invocation', async dimension => {
      const f = await guideIssueFixture('USER'); await f.replace();
      expect(await f.authorize()).toMatchObject({ actor: { userId: id(50), b2b: { subjectId: id(50), userAuthRevision: 3 } } });
      const user = (await f.users.current({} as any))!;
      if (['anchor', 'draft', 'fiscal'].includes(dimension) && user.scope.kind === 'ASSIGNED') user.scope.series = user.scope.series.filter(v => v !== ({ anchor: binding.seriesId, draft: id(70), fiscal: id(71) } as any)[dimension]);
      if (dimension === 'point' && user.scope.kind === 'ASSIGNED') user.scope.emissionPointIds = [];
      if (dimension === 'branch' && user.scope.kind === 'ASSIGNED') user.scope.branchIds = [];
      if (dimension === 'view') user.permissions = ['document.issue'];
      if (dimension === 'issue') user.permissions = ['document.view'];
      if (dimension === 'authRevision') user.authVersion++;
      if (dimension === 'inactive') user.active = false;
      f.users.current.mockResolvedValue(dimension === 'link' ? null : user);
      await expect(f.authorize()).rejects.toMatchObject({ status: 404 });
      expect(f.memory.audits.at(-1)).toMatchObject({ outcome: 'DENIED', actorId: id(50) });
      if (dimension === 'issue') expect(await f.authorize(issuePair(), 'READ')).toMatchObject({ action: 'READ' });
    });
  it('allows a live GLOBAL user but narrows the returned actor to exactly this binding', async () => {
    const f = await guideIssueFixture('USER'); await f.replace();
    f.users.current.mockResolvedValue({ active: true, authVersion: 3, permissions: ['document.view', 'document.issue'], scope: { kind: 'GLOBAL' } });
    expect((await f.authorize()).actor.scope).toEqual({ kind: 'ASSIGNED', branchIds: [binding.branchId], emissionPointIds: [binding.pointId], series: [binding.seriesId, id(70), id(71)] });
  });
  it('denies USER permission/scope or revision changes during catalogue RPC, even if both snapshots allow ISSUE', async () => {
    const f = await guideIssueFixture('USER'); await f.replace();
    const before = (await f.users.current({} as any))!;
    for (const after of [null, { ...before, active: false }, { ...before, authVersion: 4 },
      { ...before, permissions: [...before.permissions, 'document.cancel'] },
      { ...before, scope: { kind: 'GLOBAL' as const } }]) {
      f.users.current.mockResolvedValueOnce(structuredClone(before)).mockResolvedValueOnce(structuredClone(after));
      await expect(f.authorize()).rejects.toMatchObject({ status: 404 });
      expect(f.memory.audits.at(-1)).toMatchObject({ action: 'AUTHORIZE_GUIDE_ISSUE_ISSUE', outcome: 'DENIED' });
    }
    expect(f.catalogue.validate).toHaveBeenCalledTimes(6);
  });
  it('rechecks the same step-up actor after read audit before returning grant metadata', async () => {
    const f = await guideIssueFixture(); await f.replace(); const audits = f.memory.audits.length;
    f.admin.verify.mockClear(); let calls = 0;
    f.admin.verify.mockImplementation(async () => { if (++calls === 3) return fail(403, 'STEP_UP_REQUIRED'); return { id: id(9), stepUpVerified: true }; });
    await expect(f.core.read('human-step-up', f.made.client.id, ctx())).rejects.toMatchObject({ status: 403 });
    expect(f.memory.audits.length).toBe(audits);
  });
  it.each([2, 3])('revoked step-up at verification %s rolls back revision and successful audit', async when => {
    const f = await guideIssueFixture(); const before = f.memory.audits.length;
    f.admin.verify.mockClear(); let calls = 0;
    f.admin.verify.mockImplementation(async () => { if (++calls === when) return fail(403, 'STEP_UP_REQUIRED'); return { id: id(9), stepUpVerified: true }; });
    await expect(f.replace()).rejects.toMatchObject({ status: 403 });
    expect(f.grants.size).toBe(0); expect(f.memory.audits.length).toBe(before);
  });
  it('requires the same human throughout replacement and rolls back an audit failure', async () => {
    const f = await guideIssueFixture();
    f.admin.verify.mockResolvedValueOnce({ id: id(9), stepUpVerified: true }).mockResolvedValueOnce({ id: id(10), stepUpVerified: true });
    await expect(f.replace()).rejects.toMatchObject({ status: 403 }); expect(f.grants.size).toBe(0);
    f.memory.failAudit = true; await expect(f.replace()).rejects.toMatchObject({ status: 503 }); expect(f.grants.size).toBe(0);
  });
  it('appends revocation with CAS, and exactly one concurrent edit wins', async () => {
    const f = await guideIssueFixture(); await f.replace();
    const results = await Promise.allSettled([f.replace([], 1), f.replace([], 1)]);
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(row => row.status === 'rejected')).toMatchObject([{ reason: { status: 409 } }]);
    await expect(f.authorize()).rejects.toMatchObject({ status: 404 });
    expect(await f.core.read('human-step-up', f.made.client.id, ctx())).toMatchObject({ current: true, revision: 2, bindings: [] });
  });
  it('rotation invalidates prior token and requires an explicit regrant for the new client revision', async () => {
    const f = await guideIssueFixture(); await f.replace();
    const changed = await f.identity.change('human-step-up', f.made.client.id, { expectedRevision: 1 }, ctx(), true);
    await expect(f.authorize()).rejects.toMatchObject({ status: 401 });
    const token = (await f.identity.token(basic(f.made.client.id, changed.clientSecret!), { grant_type: 'client_credentials', scope: f.made.client.scopes.join(' ') }, ctx())).access_token!;
    const auth = () => f.core.authorize(token, { binding: issuePair(), kind: 'SERVICE', action: 'ISSUE' }, ctx());
    await expect(auth()).rejects.toMatchObject({ status: 404 });
    expect(await f.core.read('human-step-up', f.made.client.id, ctx())).toMatchObject({ current: false });
    await f.replace([issuePair()], 1, 2); expect(await auth()).toMatchObject({ clientRevision: 2, grantRevision: 2 });
  });
  it('persists owner outage audit without leaking owner details and refuses corrupt grants', async () => {
    const f = await guideIssueFixture(); await f.replace();
    f.catalogue.validate.mockRejectedValueOnce(new Error('PRIVATE_SYNTHETIC_OWNER_DETAIL'));
    await expect(f.authorize()).rejects.toMatchObject({ status: 503, code: 'GUIDE_ISSUE_AUTHORITY_UNAVAILABLE' });
    expect(f.memory.audits.at(-1)?.outcome).toBe('UNAVAILABLE');
    f.grants.get(f.made.client.id)!.clientRevision = NaN;
    await expect(f.authorize()).rejects.toMatchObject({ status: 503 });
  });
  it('rejects caller actor injection and malformed/deep/proxy/getter JSON without executing it', async () => {
    const f = await guideIssueFixture(), getter = vi.fn(() => issuePair());
    const hostile = Object.defineProperty({}, 'binding', { enumerable: true, get: getter });
    await expect(f.core.authorize(f.token, hostile, ctx())).rejects.toMatchObject({ status: 400 }); expect(getter).not.toHaveBeenCalled();
    const trap = vi.fn(); const proxy = new Proxy({}, { ownKeys: trap });
    expect(() => guideIssueJson(proxy)).toThrow(); expect(trap).not.toHaveBeenCalled();
    let deep: any = {}; for (let n = 0; n < 15; n++) deep = { child: deep };
    const disguisedSparse = new Array(1); Object.defineProperty(disguisedSparse, '4294967295', { enumerable: true, value: issuePair() });
    for (const bad of [deep, new Array(2), disguisedSparse, { huge: 'x'.repeat(1048577) }, { [Symbol()]: true }, { toJSON: () => ({}) }]) expect(() => guideIssueJson(bad)).toThrow();
    await expect(f.core.authorize(f.token, { binding: issuePair(), kind: 'SERVICE', action: 'ISSUE', actor: { userId: id(9) } }, ctx())).rejects.toMatchObject({ status: 400 });
    await expect(f.replace([issuePair(), issuePair()])).rejects.toMatchObject({ status: 400 });
    await expect(f.replace([{ ...issuePair(), fiscalSeriesId: binding.seriesId }])).rejects.toMatchObject({ status: 400 });
  });
  it('validates a genuine authenticated principal instead of trusting a forged identity result', async () => {
    const f = await guideIssueFixture(); await f.replace();
    const identity = { authenticate: vi.fn(async () => ({ kind: 'SERVICE', clientId: f.made.client.id, revision: 1, subjectId: id(9) })) };
    const authority = new B2bGuideIssueAuthority(f.store, identity as any, f.catalogue, f.admin);
    await expect(authority.authorize('fake', { binding: issuePair(), kind: 'SERVICE', action: 'ISSUE' }, ctx())).rejects.toMatchObject({ status: 401 });
  });
});
