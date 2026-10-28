import { describe, expect, it, vi } from 'vitest';
import { BillingB2bGuideIssueAuthorization } from '../services/billing-service/src/b2b/guide-issue-authorization';
import { BillingGuideIssueCatalogue } from '../services/billing-service/src/b2b/guide-issue-catalogue';
import { B2bSecurityError } from '../packages/contracts/src/b2b-security';
import { guideIssueFixture } from './helpers/guide-issue.fixture';
import { guideUuid } from './helpers/b2b-guide.fixture';

function fixture(kind: 'SERVICE' | 'USER' = 'SERVICE') {
  const f = guideIssueFixture(kind), actor = f.proof.actor.b2b!;
  const principal = { ...actor, bindings: [f.binding.draft.anchor], environment: 'BETA' as const,
    scopes: ['b2b:documents:read', 'b2b:guides:issue', 'b2b:guides:read', 'b2b:guide-operations:read'] as const };
  const identity = { authenticate: vi.fn(async () => structuredClone(principal) as any) };
  const result = { ...structuredClone(f.proof), schemaVersion: 'factuez.b2b.guide-issue-authorization.v1', action: 'ISSUE',
    candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false };
  const http = { post: vi.fn(async () => structuredClone(result)) };
  return { ...f, principal, identity, http, result, adapter: new BillingB2bGuideIssueAuthorization(identity, http) };
}
describe('Billing independently verifies three-series issue authority', () => {
  it.each(['SERVICE', 'USER'] as const)('verifies exact %s provenance and fixed private RPC', async kind => {
    const f = fixture(kind), proof = await f.adapter.current('synthetic', kind, f.binding, 'ISSUE');
    expect(proof).toEqual(f.proof);
    expect(f.http.post).toHaveBeenCalledWith('/internal/b2b/authorize-guide-issue', { kind, binding: f.binding, action: 'ISSUE' }, 'synthetic');
    expect(f.identity.authenticate).toHaveBeenCalledWith('synthetic', ['b2b:documents:read', 'b2b:guides:issue'], kind);
  });
  it('READ has distinct scopes; write alone is never enough', async () => {
    const f = fixture(); f.result.action = 'READ';
    await f.adapter.current('synthetic', 'SERVICE', f.binding, 'READ');
    expect(f.identity.authenticate).toHaveBeenCalledWith('synthetic', ['b2b:documents:read', 'b2b:guides:read', 'b2b:guide-operations:read'], 'SERVICE');
  });
  it.each([
    (r: any) => { r.capability = 'WRITE'; }, (r: any) => { r.action = 'READ'; },
    (r: any) => { r.transmissionAuthorized = true; }, (r: any) => { r.grantRevision = 0; },
    (r: any) => { r.clientRevision++; }, (r: any) => { r.actor.scope.series.pop(); },
    (r: any) => { r.actor.scope.kind = 'GLOBAL'; }, (r: any) => { r.actor.userId = guideUuid(90); },
    (r: any) => { r.actor.b2b.clientId = guideUuid(91); }, (r: any) => { r.binding.fiscalSeriesId = guideUuid(92); },
    (r: any) => { r.secret = 'DO_NOT_REFLECT'; },
  ])('rejects forged, activated or mismatched owner response %#', async mutate => {
    const f = fixture(); mutate(f.result);
    await expect(f.adapter.current('synthetic', 'SERVICE', f.binding, 'ISSUE')).rejects.toMatchObject({ status: 503, code: 'INVALID_GUIDE_ISSUE_AUTHORITY_RESPONSE' });
  });
  it('requires the complete anchor tuple before asking for a paired grant', async () => {
    const f = fixture(); f.principal.bindings[0] = { ...f.principal.bindings[0], pointId: guideUuid(99) };
    await expect(f.adapter.current('synthetic', 'SERVICE', f.binding, 'ISSUE')).rejects.toMatchObject({ status: 401 });
    expect(f.http.post).not.toHaveBeenCalled();
  });
  it('preserves denial status but does not reflect private error text', async () => {
    const f = fixture(); f.http.post.mockRejectedValue(new B2bSecurityError(404, 'PRIVATE_DETAIL'));
    await expect(f.adapter.current('synthetic', 'SERVICE', f.binding, 'ISSUE')).rejects.toMatchObject({ status: 404, code: 'GUIDE_ISSUE_AUTHORIZATION_DENIED' });
  });
  it('sanitizes transport failures', async () => {
    const f = fixture(); f.http.post.mockRejectedValue(new Error('PRIVATE_DETAIL'));
    await expect(f.adapter.current('synthetic', 'SERVICE', f.binding, 'ISSUE')).rejects.toMatchObject({ status: 503, code: 'GUIDE_ISSUE_AUTHORITY_UNAVAILABLE' });
  });
});
describe('guide issue owner catalogue metadata', () => {
  it.each(['ISSUE', 'READ'] as const)('validates explicit pairs for %s without selecting secrets or allocating', async action => {
    const f = guideIssueFixture(), query = vi.fn(async () => [{ valid: true }]);
    await new BillingGuideIssueCatalogue({ $queryRawUnsafe: query as any }).validate([f.binding], action);
    const [sql, ...values] = query.mock.calls[0] as unknown as [string, ...unknown[]];
    expect(values).toEqual([1, f.binding.draft.anchor.issuerRuc, f.binding.draft.anchor.branchId, f.binding.draft.anchor.pointId,
      f.binding.draft.anchor.seriesId, 'INVOICE', f.binding.draft.guideSeriesId, '09', f.binding.fiscalSeriesId, action === 'ISSUE']);
    expect(sql).not.toMatch(/SELECT \*|password|certificate|INSERT|UPDATE|DELETE|PRODUCTION/i);
    expect(sql).toContain('f."series"=g."label"'); expect(sql).not.toContain('"nextNumber"');
  });
  it('rejects invalid/duplicate pairs before SQL', async () => {
    const f = guideIssueFixture(), query = vi.fn(async () => []), core = new BillingGuideIssueCatalogue({ $queryRawUnsafe: query as any });
    for (const value of [[], [f.binding, f.binding], [{ ...f.binding, fiscalSeriesId: f.binding.draft.guideSeriesId }]])
      await expect(core.validate(value as any, 'ISSUE')).rejects.toMatchObject({ status: 400 });
    expect(query).not.toHaveBeenCalled();
  });
  it('does not infer a link from a series label or disclose another RUC', async () => {
    const f = guideIssueFixture(), query = vi.fn(async () => []);
    await expect(new BillingGuideIssueCatalogue({ $queryRawUnsafe: query as any }).validate([f.binding], 'ISSUE'))
      .rejects.toMatchObject({ status: 404, code: 'GUIDE_ISSUE_CONTEXT_NOT_FOUND' });
  });
});
