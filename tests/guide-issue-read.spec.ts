import { describe, expect, it } from 'vitest';
import { guideIssueFixture } from './helpers/guide-issue.fixture';
import { guideUuid } from './helpers/b2b-guide.fixture';

describe('guide immutable result with live READ permission', () => {
  it.each(['SERVICE', 'USER'] as const)('reads %s receipt without preparing or reserving again', async kind => {
    const f = guideIssueFixture(kind), result = await f.issue(), before = structuredClone(f.state());
    f.context.prepare.mockRejectedValue(new Error('CONTEXT_MUST_NOT_RUN_FOR_READ'));
    const read = await f.core.read('synthetic', kind, f.binding, f.draft.id, result.receipt.id);
    expect(read).toEqual(result.receipt); expect(f.state()).toEqual(before);
    expect(f.authority.current.mock.calls.at(-1)?.[3]).toBe('READ');
  });
  it.each(['draft', 'operation', 'binding'] as const)('returns no result for foreign %s', async target => {
    const f = guideIssueFixture(), result = await f.issue(), b = structuredClone(f.binding);
    if (target === 'binding') { b.fiscalSeriesId = guideUuid(99); f.proof.binding = b;
      if (f.proof.actor.scope.kind === 'ASSIGNED') f.proof.actor.scope.series[2] = b.fiscalSeriesId; }
    await expect(f.core.read('synthetic', 'SERVICE', b, target === 'draft' ? guideUuid(99) : f.draft.id,
      target === 'operation' ? guideUuid(98) : result.receipt.id)).rejects.toMatchObject({ code: 'GUIDE_ISSUANCE_NOT_FOUND' });
  });
  it('revocation prevents an immutable result from being delivered', async () => {
    const f = guideIssueFixture(), result = await f.issue(); f.control.revoked = true;
    await expect(f.core.read('synthetic', 'SERVICE', f.binding, f.draft.id, result.receipt.id)).rejects.toMatchObject({ status: 401 });
  });
  it('revision change inside read is rejected without side effects', async () => {
    const f = guideIssueFixture(), result = await f.issue(), before = structuredClone(f.state());
    f.hooks.before = () => { f.proof.grantRevision++; };
    await expect(f.core.read('synthetic', 'SERVICE', f.binding, f.draft.id, result.receipt.id)).rejects.toMatchObject({ code: 'GUIDE_ISSUE_AUTHORIZATION_CHANGED' });
    expect(f.state()).toEqual(before);
  });
});
