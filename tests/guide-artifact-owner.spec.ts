import { describe, expect, it, vi } from 'vitest';
import { PrivateGuideArtifactOwner, validateGuideArtifactScope } from '../services/sunat-service/src/application/guide-artifact-owner';
import { guideIssueFixture } from './helpers/guide-issue.fixture';
import { fiscalSnapshotSha256 as hash } from '../packages/sunat-core/src/fiscal-note';

async function fixture(kind: 'SERVICE' | 'USER' = 'SERVICE') {
  const f = guideIssueFixture(kind), result = await f.issue(), actor = f.proof.actor.b2b!;
  const scope = { binding: f.binding, draftId: f.request.draftId, operationId: result.receipt.id };
  const principal = { ...actor, environment: 'BETA' as const, bindings: [f.binding.draft.anchor],
    scopes: ['b2b:documents:read', 'b2b:guides:issue', 'b2b:guides:read', 'b2b:guide-operations:read'] as const };
  const identity = { authenticate: vi.fn(async () => structuredClone(principal) as any) };
  const proof = { ...f.proof, schemaVersion: 'factuez.b2b.guide-issue-authorization.v1', action: 'ISSUE',
    candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false };
  const auth = { post: vi.fn(async (_path: string, body: any) => ({ ...structuredClone(proof), action: body.action })) };
  const issuance = { schemaVersion: 'factuez.b2b.guide-issuance.v1', operationId: result.receipt.id, draftId: scope.draftId,
    binding: f.binding, snapshot: result.receipt.snapshot, snapshotSha256: result.receipt.snapshotSha256, replayed: null };
  const billing = { post: vi.fn(async () => structuredClone(issuance)) };
  const access = { token: 'synthetic-local-artifact', kind };
  return { f, scope, principal, identity, proof, auth, issuance, billing, access,
    owner: new PrivateGuideArtifactOwner(identity, auth, billing) };
}
describe('SUNAT guide artifact private owner composition', () => {
  it.each(['SERVICE','USER'] as const)('binds exact %s provenance to issued original through existing mTLS RPCs', async kind => {
    const f = await fixture(kind), r = await f.owner.current(f.scope, f.access, 'ISSUE');
    expect(r.issuance).toEqual(f.issuance); expect(r.authorizationSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(f.billing.post).toHaveBeenCalledWith('/internal/b2b/read-guide-issuance', { ...f.scope, kind }, f.access.token);
    expect(f.auth.post).toHaveBeenCalledTimes(2);
    expect(f.identity.authenticate).toHaveBeenCalledWith(f.access.token, ['b2b:documents:read','b2b:guides:issue'], kind);
  });
  it('uses READ scopes independently; it never falls back to ISSUE or draft write', async () => {
    const f = await fixture(); await f.owner.current(f.scope, f.access, 'READ');
    expect(f.identity.authenticate).toHaveBeenCalledWith(f.access.token,
      ['b2b:documents:read','b2b:guides:read','b2b:guide-operations:read'], 'SERVICE');
  });
  it.each(['client','subject','revision','scope','action','flags','grant','extra'] as const)('rejects forged %s proof before Billing lookup', async change => {
    const f = await fixture('USER');
    f.auth.post.mockImplementation(async () => {
      const p: any = structuredClone(f.proof);
      if (change === 'client') p.actor.b2b.clientId = '00000000-0000-4000-8000-000000000099';
      if (change === 'subject') p.actor.userId = null;
      if (change === 'revision') p.clientRevision++;
      if (change === 'scope') p.actor.scope.series.pop();
      if (change === 'action') p.action = 'READ';
      if (change === 'flags') p.fiscalExecutionEnabled = true;
      if (change === 'grant') p.grantRevision = 0;
      if (change === 'extra') p.admin = true;
      return p;
    });
    await expect(f.owner.current(f.scope, f.access, 'ISSUE')).rejects.toMatchObject({ code: 'GUIDE_ARTIFACT_OWNER_UNAVAILABLE_OR_DENIED' });
    expect(f.billing.post).not.toHaveBeenCalled();
  });
  it('rejects regrant during private lookup', async () => {
    const f = await fixture(); f.billing.post.mockImplementation(async () => { f.proof.grantRevision++; return f.issuance; });
    await expect(f.owner.current(f.scope, f.access, 'ISSUE')).rejects.toMatchObject({ code: 'GUIDE_ARTIFACT_OWNER_CHANGED' });
  });
  it('rejects a recomputed but differently numbered owner aggregate', async () => {
    const f = await fixture(); f.issuance.snapshot.operationId = '00000000-0000-4000-8000-000000000099';
    f.issuance.snapshotSha256 = hash(f.issuance.snapshot);
    await expect(f.owner.current(f.scope, f.access, 'READ')).rejects.toMatchObject({ code: 'GUIDE_ARTIFACT_OWNER_UNAVAILABLE_OR_DENIED' });
  });
  it('does not reflect private error details', async () => {
    const f = await fixture(); f.billing.post.mockRejectedValue(new Error('SYNTHETIC_PRIVATE_DETAIL'));
    await expect(f.owner.current(f.scope, f.access, 'READ')).rejects.toThrow(/^GUIDE_ARTIFACT_OWNER_UNAVAILABLE_OR_DENIED$/);
  });
  it.each([null, {}, { schemaVersion: 'prod' }, { binding: {}, draftId: '1', operationId: '1' }])('rejects malformed scope', input => {
    expect(() => validateGuideArtifactScope(input)).toThrow('INVALID_GUIDE_ARTIFACT_SCOPE');
  });
  it('does not invoke getters in untrusted input', () => {
    const read = vi.fn(); expect(() => validateGuideArtifactScope({ get binding() { read(); return {}; } })).toThrow();
    expect(read).not.toHaveBeenCalled();
  });
});
