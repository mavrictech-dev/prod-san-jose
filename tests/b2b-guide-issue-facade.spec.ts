import { beforeEach, describe, expect, it, vi } from 'vitest';
import { B2bSecurityError, type B2bPrincipal } from '../packages/contracts/src/b2b-security';
import { b2bGuideIssueScopes, b2bGuideIssueReadScopes } from '../packages/contracts/src/b2b-guide-security';
import { B2bGuideIssuances, HttpB2bGuideIssueOwner } from '../services/b2b-api-service/src/guide-issue';
import { guideIssueFixture } from './helpers/guide-issue.fixture';

const TOKEN = 'synthetic-issue-token';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
describe('guide issuance facade with real identity frame and real synthetic producer validation', () => {
  let fixture: ReturnType<typeof guideIssueFixture>, core: B2bGuideIssuances, issued: any;
  const principal = (kind: 'SERVICE' | 'USER'): B2bPrincipal => ({ kind, clientId: id(90), revision: 1,
    subjectId: kind === 'USER' ? id(91) : null, userAuthRevision: kind === 'USER' ? 2 : null,
    environment: 'BETA', scopes: [...new Set([...b2bGuideIssueScopes, ...b2bGuideIssueReadScopes])], bindings: [structuredClone(fixture.binding.draft.anchor)] });
  const identity = { authenticate: vi.fn(async (_token: string, _scopes: any, kind: 'SERVICE' | 'USER') => principal(kind)) };
  const owner = { issue: vi.fn(), read: vi.fn() };
  beforeEach(async () => {
    fixture = guideIssueFixture();
    const result = await fixture.issue();
    issued = { schemaVersion: 'factuez.b2b.guide-issuance.v1', operationId: result.receipt.id, draftId: fixture.request.draftId,
      binding: fixture.binding, snapshot: result.receipt.snapshot, snapshotSha256: result.receipt.snapshotSha256, replayed: result.replayed };
    identity.authenticate.mockReset().mockImplementation(async (_token, _scopes, kind) => principal(kind));
    owner.issue.mockReset().mockImplementation(async () => structuredClone(issued));
    owner.read.mockReset().mockImplementation(async () => ({ ...structuredClone(issued), replayed: null }));
    core = new B2bGuideIssuances(identity, owner);
  });
  it.each(['SERVICE', 'USER'] as const)('issues and reads for explicit %s, with separate scopes and two introspections', async kind => {
    const r = await core.issue(TOKEN, kind, fixture.request); expect(r).toEqual(issued); expect(Object.isFrozen(r.snapshot.body)).toBe(true);
    expect(owner.issue).toHaveBeenCalledExactlyOnceWith(TOKEN, kind, fixture.request);
    expect(identity.authenticate.mock.calls).toEqual([[TOKEN, [...b2bGuideIssueScopes], kind], [TOKEN, [...b2bGuideIssueScopes], kind]]);
    identity.authenticate.mockClear();
    const read = await core.read(TOKEN, kind, fixture.binding, fixture.request.draftId, issued.operationId);
    expect(read.replayed).toBeNull(); expect(owner.read).toHaveBeenCalledExactlyOnceWith(TOKEN, kind, fixture.binding, fixture.request.draftId, issued.operationId);
    expect(identity.authenticate.mock.calls).toEqual([[TOKEN, [...b2bGuideIssueReadScopes], kind], [TOKEN, [...b2bGuideIssueReadScopes], kind]]);
    expect(r).not.toHaveProperty('receipt'); expect(r).not.toHaveProperty('keySha256'); expect(r).not.toHaveProperty('actor');
  });
  it('uses only the two fixed RPC paths and exact private envelopes', async () => {
    const transport = { post: vi.fn(async () => issued) }, rpc = new HttpB2bGuideIssueOwner(transport);
    await rpc.issue(TOKEN, 'SERVICE', fixture.request); await rpc.read(TOKEN, 'USER', fixture.binding, fixture.request.draftId, issued.operationId);
    expect(transport.post.mock.calls).toEqual([
      ['/internal/b2b/issue-guide', { kind: 'SERVICE', request: fixture.request }, TOKEN],
      ['/internal/b2b/read-guide-issuance', { kind: 'USER', binding: fixture.binding, draftId: fixture.request.draftId, operationId: issued.operationId }, TOKEN],
    ]);
  });
  it('does not infer issue permission from write or document issue', async () => {
    identity.authenticate.mockImplementation(async () => ({ ...principal('SERVICE'), scopes: ['b2b:documents:read', 'b2b:guides:write', 'b2b:documents:issue'] }));
    await expect(core.issue(TOKEN, 'SERVICE', fixture.request)).rejects.toMatchObject({ status: 401 }); expect(owner.issue).not.toHaveBeenCalled();
  });
  it.each(b2bGuideIssueReadScopes)('requires read scope %s', async missing => {
    identity.authenticate.mockImplementation(async () => ({ ...principal('SERVICE'), scopes: principal('SERVICE').scopes.filter(s => s !== missing) }));
    await expect(core.read(TOKEN, 'SERVICE', fixture.binding, fixture.request.draftId, issued.operationId)).rejects.toMatchObject({ status: 401 });
    expect(owner.read).not.toHaveBeenCalled();
  });
  it('requires an exact anchor tuple, never Cartesian grants', async () => {
    identity.authenticate.mockImplementation(async () => ({ ...principal('SERVICE'), bindings: [
      { ...fixture.binding.draft.anchor, pointId: id(71) }, { ...fixture.binding.draft.anchor, branchId: id(72) },
      { ...fixture.binding.draft.anchor, seriesId: id(73) },
    ] }));
    await expect(core.issue(TOKEN, 'SERVICE', fixture.request)).rejects.toMatchObject({ status: 404 }); expect(owner.issue).not.toHaveBeenCalled();
  });
  it.each(['revision', 'client', 'subject', 'kind', 'scope', 'anchor', 'revoked'])('withholds valid output after %s changes', async change => {
    identity.authenticate.mockImplementationOnce(async () => principal('USER')).mockImplementationOnce(async () => {
      const p = principal('USER');
      if (change === 'revision') p.revision++;
      if (change === 'client') p.clientId = id(70);
      if (change === 'subject') p.userAuthRevision!++;
      if (change === 'kind') { p.kind = 'SERVICE'; p.subjectId = null; p.userAuthRevision = null; }
      if (change === 'scope') p.scopes = ['b2b:documents:read'];
      if (change === 'anchor') p.bindings[0].seriesId = id(70);
      if (change === 'revoked') throw new B2bSecurityError(401, 'SYNTHETIC_REVOKED');
      return p;
    });
    await expect(core.issue(TOKEN, 'USER', fixture.request)).rejects.toMatchObject({ status: 401 });
    expect(owner.issue).toHaveBeenCalledTimes(1); expect(identity.authenticate).toHaveBeenCalledTimes(2);
  });
  it.each(['token', 'kind', 'draft', 'revision', 'binding', 'key', 'extra'])('rejects invalid %s before introspection and owner access', async field => {
    const r: any = structuredClone(fixture.request); let token = TOKEN, kind: any = 'SERVICE';
    if (field === 'token') token = 'invalid token'; if (field === 'kind') kind = 'ADMIN';
    if (field === 'draft') r.draftId = 'invalid'; if (field === 'revision') r.expectedRevision = '*';
    if (field === 'binding') r.binding.fiscalSeriesId = r.binding.draft.guideSeriesId;
    if (field === 'key') r.idempotencyKey = 'short'; if (field === 'extra') r.extra = true;
    await expect(core.issue(token, kind, r)).rejects.toBeInstanceOf(B2bSecurityError);
    expect(owner.issue).not.toHaveBeenCalled(); expect(identity.authenticate).not.toHaveBeenCalled();
  });
  it.each(['read replay', 'issue replay', 'receipt', 'revision', 'snapshot hash', 'operation'])('uses the real wire boundary for malformed owner %s', async field => {
    const r = structuredClone(issued);
    if (field === 'read replay') owner.read.mockResolvedValue(r);
    if (field === 'issue replay') r.replayed = null;
    if (field === 'receipt') r.receipt = { keySha256: 'SYNTHETIC_PRIVATE' };
    if (field === 'revision') r.snapshot.draftRevision++;
    if (field === 'snapshot hash') r.snapshotSha256 = '0'.repeat(64);
    if (field === 'operation') { r.operationId = id(75); owner.read.mockResolvedValue({ ...r, replayed: null }); }
    owner.issue.mockResolvedValue(r);
    const call = field === 'read replay' || field === 'operation'
      ? core.read(TOKEN, 'SERVICE', fixture.binding, fixture.request.draftId, issued.operationId) : core.issue(TOKEN, 'SERVICE', fixture.request);
    await expect(call).rejects.toMatchObject({ status: 503, code: 'INCONSISTENT_GUIDE_ISSUANCE' });
  });
  it('isolates identity frames between concurrent requests and detaches mutable request state', async () => {
    const input = structuredClone(fixture.request);
    owner.issue.mockImplementation(async (_token, _kind, request) => { expect(Object.isFrozen(request.binding.draft.anchor)).toBe(true); return structuredClone(issued); });
    const result = core.issue(TOKEN, 'SERVICE', input); input.expectedRevision = '"v99"';
    const [a, b] = await Promise.all([result, core.issue(TOKEN, 'USER', fixture.request)]);
    expect(a).toEqual(b); expect(identity.authenticate).toHaveBeenCalledTimes(4);
  });
  it('normalizes the known request wire 413 into the facade class before any dependency call', async () => {
    await expect(core.issue(TOKEN, 'SERVICE', { ...fixture.request, extra: 'x'.repeat(128 * 1024) }))
      .rejects.toThrow(expect.objectContaining({ status: 413, code: 'INVALID_GUIDE_ISSUE_REQUEST' }));
    try { await core.issue(TOKEN, 'SERVICE', { ...fixture.request, extra: 'x'.repeat(128 * 1024) }); }
    catch (error) { expect(error).toBeInstanceOf(B2bSecurityError); }
    expect(identity.authenticate).not.toHaveBeenCalled(); expect(owner.issue).not.toHaveBeenCalled();
  });
});
