import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { B2bSecurityError } from '../packages/contracts/src/b2b-security';
import type { B2bGuideIssueBinding } from '../packages/contracts/src/b2b-guide-security';
import { BillingB2bCarrierGuideAuthority } from '../services/billing-service/src/b2b/carrier-guide-authority';
import { BillingB2bGuideIssueAuthorization } from '../services/billing-service/src/b2b/guide-issue-authorization';
import { BillingGuideIssueCatalogue } from '../services/billing-service/src/b2b/guide-issue-catalogue';
import { fail } from '../services/identity-service/src/b2b/model';
import { ctx, id } from './b2b-identity.fixture';
import { guideIssueFixture, issuePair } from './b2b-guide-issue-authority.fixture';

const carrierPair = (): B2bGuideIssueBinding => ({ draft: { ...issuePair().draft, guideType: '31', guideSeriesId: id(78) }, fiscalSeriesId: id(79) });

/** Runs the real Identity authority, Billing authorization and GT31 adapter.
 * Storage, private transport and metadata SQL are explicit in-process doubles;
 * no HTTP listener, database, QA, certificate or external service is used. */
async function fixture(kind: 'SERVICE' | 'USER' = 'SERVICE', scopes?: Parameters<typeof guideIssueFixture>[1]) {
  const f = await guideIssueFixture(kind, scopes), pair = carrierPair();
  if (f.linked.scope.kind === 'ASSIGNED') f.linked.scope.series.push(pair.draft.guideSeriesId, pair.fiscalSeriesId);
  const query = vi.fn(async (_sql: string, ..._values: unknown[]) => [{ valid: true }]);
  const catalogue = new BillingGuideIssueCatalogue({ $queryRawUnsafe: query as any });
  f.catalogue.validate.mockImplementation((pairs, action) => catalogue.validate(pairs as B2bGuideIssueBinding[], action));
  const identity = { authenticate: vi.fn((token, required, selectedKind) => f.identity.authenticate(token, required, ctx(), selectedKind)) };
  const owner = { post: vi.fn(async (path: string, body: unknown, token: string) => {
    expect(path).toBe('/internal/b2b/authorize-guide-issue');
    try { return await f.core.authorize(token, body, ctx()); }
    // Mirrors the existing private RPC client's finite status mapping, without a server.
    catch (error: any) { throw new B2bSecurityError(error.status ?? 503, 'SYNTHETIC_PRIVATE_RPC_FAILURE'); }
  }) };
  const base = new BillingB2bGuideIssueAuthorization(identity, owner);
  const adapter = new BillingB2bCarrierGuideAuthority(base);
  const current = (action: 'ISSUE' | 'READ' = 'ISSUE', binding = pair) => adapter.current(f.token, kind, binding, action);
  return { ...f, pair, query, owner, base, adapter, current, contextIdentity: identity };
}

describe('concrete GT31 Identity authority, LOCAL/BETA only', () => {
  it.each(['SERVICE', 'USER'] as const)('requires a separately enrolled 31 grant for %s, not the 09 grant or anchor', async kind => {
    const f = await fixture(kind);
    await f.replace();
    await expect(f.current()).rejects.toMatchObject({ status: 404, code: 'CARRIER_GUIDE_AUTHORIZATION_DENIED' });
    expect(f.memory.audits.at(-1)).toMatchObject({ outcome: 'DENIED' });
    await f.replace([f.pair], 1);
    const proof = await f.current();
    expect(proof).toEqual({ capability: 'BETA_CARRIER_GUIDE_ISSUE_LOCAL', action: 'ISSUE', binding: f.pair,
      clientRevision: 1, grantRevision: 2, actor: { userId: kind === 'USER' ? id(50) : null,
        scope: { kind: 'ASSIGNED', branchIds: [f.pair.draft.anchor.branchId], emissionPointIds: [f.pair.draft.anchor.pointId],
          series: [f.pair.draft.anchor.seriesId, f.pair.draft.guideSeriesId, f.pair.fiscalSeriesId] },
        b2b: { kind, clientId: f.made.client.id, revision: 1, subjectId: kind === 'USER' ? id(50) : null, userAuthRevision: kind === 'USER' ? 3 : null } } });
    await expect(f.authorize()).rejects.toMatchObject({ status: 404 });
    expect(f.query.mock.calls.at(-1)![0]).toContain('FROM "CarrierGuideSeries" m');
    expect(JSON.stringify(proof)).not.toContain(f.token);
  });

  it('co-enrollment retains separate whole tuples and revoking 31 does not revoke 09', async () => {
    const f = await fixture(); await f.replace([issuePair(), f.pair]);
    expect(await f.authorize()).toMatchObject({ binding: issuePair(), grantRevision: 1 });
    expect(await f.current()).toMatchObject({ binding: f.pair, grantRevision: 1 });
    await f.replace([issuePair()], 1);
    await expect(f.current()).rejects.toMatchObject({ status: 404 });
    expect(await f.authorize()).toMatchObject({ grantRevision: 2 });
  });

  it.each(['SERVICE', 'USER'] as const)('read-only %s enrollment never gains ISSUE', async kind => {
    const f = await fixture(kind, ['b2b:documents:read', 'b2b:guides:read', 'b2b:guide-operations:read']);
    f.linked.permissions = ['document.view']; await f.replace([f.pair]);
    expect(await f.current('READ')).toMatchObject({ action: 'READ', grantRevision: 1 });
    expect(f.contextIdentity.authenticate).toHaveBeenLastCalledWith(f.token,
      ['b2b:documents:read', 'b2b:guides:read', 'b2b:guide-operations:read'], kind);
    await expect(f.current()).rejects.toMatchObject({ status: 403 });
  });

  it('draft WRITE cannot enroll or acquire GT31 ISSUE', async () => {
    const f = await fixture('SERVICE', ['b2b:documents:read', 'b2b:guides:write']);
    await expect(f.replace([f.pair])).rejects.toMatchObject({ status: 400 });
    await expect(f.current()).rejects.toMatchObject({ status: 403 });
    expect(f.grants.size).toBe(0); expect(f.owner.post).not.toHaveBeenCalled();
  });

  it.each(['issuerId', 'issuerRuc', 'branchId', 'pointId', 'seriesId', 'documentType', 'guideSeriesId', 'fiscalSeriesId'] as const)(
    'does not widen a 31 grant across %s', async dimension => {
      const f = await fixture(); await f.replace([f.pair]); const pair = structuredClone(f.pair);
      if (dimension === 'fiscalSeriesId') pair.fiscalSeriesId = id(82);
      else if (dimension === 'guideSeriesId') pair.draft.guideSeriesId = id(82);
      else Object.assign(pair.draft.anchor, { [dimension]: dimension === 'issuerId' ? 2 : dimension === 'issuerRuc' ? '00000000002' : dimension === 'documentType' ? '03' : id(82) });
      const calls = f.query.mock.calls.length;
      await expect(f.current('ISSUE', pair)).rejects.toMatchObject({ status: ['guideSeriesId', 'fiscalSeriesId'].includes(dimension) ? 404 : 401 });
      expect(f.query).toHaveBeenCalledTimes(calls);
    });

  it('rechecks live 31 metadata on each use, permits historical READ, and propagates revocation', async () => {
    const f = await fixture(); await f.replace([f.pair]);
    expect(await f.current()).toMatchObject({ grantRevision: 1 });
    f.query.mockImplementation(async (_sql, ...values) => values[9] === true ? [] : [{ valid: true }]);
    await expect(f.current()).rejects.toMatchObject({ status: 404 });
    expect(await f.current('READ')).toMatchObject({ action: 'READ' });
    await f.replace([], 1);
    await expect(f.current('READ')).rejects.toMatchObject({ status: 404 });
  });

  it.each(['anchor', 'draft', 'fiscal', 'issue', 'authRevision', 'inactive'] as const)('rechecks live USER %s', async dimension => {
    const f = await fixture('USER'); await f.replace([f.pair]); await f.current();
    const user = (await f.users.current({} as any))!;
    if (user.scope.kind === 'ASSIGNED' && ['anchor', 'draft', 'fiscal'].includes(dimension)) {
      const removed = dimension === 'anchor' ? f.pair.draft.anchor.seriesId : dimension === 'draft' ? f.pair.draft.guideSeriesId : f.pair.fiscalSeriesId;
      user.scope.series = user.scope.series.filter(value => value !== removed);
    }
    if (dimension === 'issue') user.permissions = ['document.view'];
    if (dimension === 'authRevision') user.authVersion++;
    if (dimension === 'inactive') user.active = false;
    f.users.current.mockResolvedValue(user);
    await expect(f.current()).rejects.toMatchObject({ status: 404 });
    expect(f.memory.audits.at(-1)).toMatchObject({ outcome: 'DENIED', actorId: id(50) });
  });

  it('refuses revocation during the USER catalogue check', async () => {
    const f = await fixture('USER'); await f.replace([f.pair]);
    const before = (await f.users.current({} as any))!;
    f.users.current.mockResolvedValueOnce(before).mockResolvedValueOnce({ ...before, authVersion: before.authVersion + 1 });
    await expect(f.current()).rejects.toMatchObject({ status: 404 });
  });

  it('retains step-up/CAS/rollback safeguards for 31 enrollment', async () => {
    const f = await fixture(); await f.replace([f.pair]);
    await expect(f.replace([], 0)).rejects.toMatchObject({ status: 409 });
    f.admin.verify.mockClear(); let calls = 0;
    f.admin.verify.mockImplementation(async () => { if (++calls === 3) return fail(403, 'STEP_UP_REQUIRED'); return { id: id(9), stepUpVerified: true }; });
    const audits = f.memory.audits.length;
    await expect(f.replace([], 1)).rejects.toMatchObject({ status: 403 });
    expect(f.grants.get(f.made.client.id)).toMatchObject({ revision: 1, bindings: [f.pair] });
    expect(f.memory.audits).toHaveLength(audits);
  });

  it('rejects 09, production, unsupported kinds/actions and hostile input before Identity', async () => {
    const f = await fixture(), getter = vi.fn();
    const hostile = Object.defineProperty({}, 'draft', { enumerable: true, get: getter });
    for (const input of [issuePair(), hostile, { ...f.pair, draft: { ...f.pair.draft, anchor: { ...f.pair.draft.anchor, environment: 'PRODUCTION' } } }])
      await expect(f.adapter.current(f.token, 'SERVICE', input as any, 'ISSUE')).rejects.toMatchObject({ status: 400 });
    await expect(f.adapter.current(f.token, 'ADMIN' as any, f.pair, 'ISSUE')).rejects.toMatchObject({ status: 400 });
    await expect(f.adapter.current(f.token, 'SERVICE', f.pair, 'SEND' as any)).rejects.toMatchObject({ status: 400 });
    expect(getter).not.toHaveBeenCalled(); expect(f.contextIdentity.authenticate).not.toHaveBeenCalled();
  });

  it.each([
    (r: any) => { r.actor.userId = id(9); }, (r: any) => { r.actor.b2b.clientId = id(90); },
    (r: any) => { r.actor.scope.series.pop(); }, (r: any) => { r.clientRevision++; },
    (r: any) => { r.grantRevision = 0; }, (r: any) => { r.binding.draft.guideType = '09'; },
    (r: any) => { r.transmissionAuthorized = true; }, (r: any) => { r.capability = 'BETA_CARRIER_GUIDE_ISSUE_LOCAL'; },
  ])('does not translate a forged or widened Identity response %#', async mutate => {
    const f = await fixture(); await f.replace([f.pair]); const raw = await f.authorize(f.pair);
    mutate(raw); f.owner.post.mockResolvedValueOnce(raw);
    await expect(f.current()).rejects.toMatchObject({ status: 503, code: 'CARRIER_GUIDE_AUTHORITY_UNAVAILABLE' });
  });

  it('sanitizes unavailable metadata/transport errors without reflecting secrets', async () => {
    const f = await fixture(); await f.replace([f.pair]);
    f.query.mockRejectedValueOnce(new Error('PRIVATE_METADATA_SECRET'));
    await expect(f.current()).rejects.toMatchObject({ status: 503, code: 'CARRIER_GUIDE_AUTHORITY_UNAVAILABLE' });
    f.owner.post.mockRejectedValueOnce(new Error('PRIVATE_TRANSPORT_SECRET'));
    await expect(f.current()).rejects.toMatchObject({ status: 503, code: 'CARRIER_GUIDE_AUTHORITY_UNAVAILABLE' });
  });
});

describe('closed metadata routing for 09 and 31', () => {
  it.each(['09', '31'] as const)('selects only the fixed %s table, type and prefix with parameterized whole tuple', async type => {
    const pair = type === '31' ? carrierPair() : issuePair(), query = vi.fn(async () => [{ valid: true }]);
    const catalogue = new BillingGuideIssueCatalogue({ $queryRawUnsafe: query as any });
    for (const action of ['ISSUE', 'READ'] as const) {
      await catalogue.validate([pair], action);
      const [sql, ...values] = query.mock.calls.at(-1) as unknown as [string, ...unknown[]];
      expect(sql).toContain(`FROM "${type === '31' ? 'CarrierGuideSeries' : 'B2bGuideIssueSeries'}" m`);
      expect(sql).not.toContain(`FROM "${type === '31' ? 'B2bGuideIssueSeries' : 'CarrierGuideSeries'}" m`);
      expect(sql).toContain(`g."guideType"='${type}'`);
      expect(sql).toContain(`f."series" ~ '^${type === '31' ? 'V' : 'T'}[A-Z0-9]{3}$'`);
      expect(sql).toContain('f."series"=g."label"');
      expect(sql).toContain('c."environment"=\'BETA\'');
      expect(sql).toContain('m."purpose"=\'LOCAL_CANDIDATE\'');
      expect(sql).toContain('g."purpose"=\'DRAFT_ONLY\'');
      expect(sql).toContain('c."active" AND z."active" AND p."active" AND s."active" AND m."active" AND g."active" AND f."active"');
      const a = pair.draft.anchor;
      expect(values).toEqual([a.issuerId, a.issuerRuc, a.branchId, a.pointId, a.seriesId, 'INVOICE', pair.draft.guideSeriesId, type, pair.fiscalSeriesId, action === 'ISSUE']);
      expect(sql).not.toMatch(/SELECT \*|nextNumber|INSERT|UPDATE|DELETE|password|certificate|PRODUCTION/i);
    }
  });

  it('rejects missing, ambiguous or non-true real mapping results for 31', async () => {
    for (const rows of [[], [{ valid: false }], [{ valid: true }, { valid: true }], [{ valid: 'true' }]]) {
      const catalogue = new BillingGuideIssueCatalogue({ $queryRawUnsafe: vi.fn(async () => rows) as any });
      await expect(catalogue.validate([carrierPair()], 'ISSUE')).rejects.toMatchObject({ status: 404 });
    }
  });

  it('rejects malformed types, duplicate series and injected identifiers before SQL', async () => {
    const pair = carrierPair(), query = vi.fn(async () => []), catalogue = new BillingGuideIssueCatalogue({ $queryRawUnsafe: query as any });
    for (const input of [[{ ...pair, draft: { ...pair.draft, guideType: '31; DROP TABLE' } }],
      [{ ...pair, draft: { ...pair.draft, guideType: '32' } }], [pair, pair], [{ ...pair, fiscalSeriesId: pair.draft.guideSeriesId }]])
      await expect(catalogue.validate(input as any, 'ISSUE')).rejects.toMatchObject({ status: 400 });
    expect(query).not.toHaveBeenCalled();
  });

  it('keeps the candidate DDL closed to 09/31 and BETA, with independent revision/audit safeguards', () => {
    const sql = readFileSync(new URL('../services/identity-service/b2b-guide-issue-grants-schema.candidate.sql', import.meta.url), 'utf8');
    expect(sql).toContain("draft->>'guideType' IN ('09','31')");
    expect(sql).toContain("anchor->>'environment'='BETA'");
    for (const guard of ['GUIDE_ISSUE_CLIENT_REVISION_REQUIRED', 'GUIDE_ISSUE_SCOPE_REQUIRED', 'GUIDE_ISSUE_ANCHOR_REQUIRED',
      'GUIDE_ISSUE_HEAD_CAS_REQUIRED', 'GUIDE_ISSUE_HISTORY_IMMUTABLE', 'GUIDE_ISSUE_AUDIT_IMMUTABLE', 'GUIDE_ISSUE_HEAD_INCOMPLETE'])
      expect(sql).toContain(guard);
    expect(sql).not.toMatch(/ALTER TABLE|DROP |DISABLE TRIGGER|PRODUCTION|GRANT ALL/i);
  });
});
