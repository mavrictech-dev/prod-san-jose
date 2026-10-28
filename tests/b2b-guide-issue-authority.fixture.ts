import { vi } from 'vitest';
import { B2bEnabledIdentityScopes, type B2bIdentityScope } from '../packages/contracts/src/b2b-security';
import { B2bGuideIssueAuthority, b2bGuideIssueScopes, b2bGuideIssueReadScopes,
  type GuideIssueGrantSet, type GuideIssueStore } from '../services/identity-service/src/b2b/guide-issue-authority';
import type { B2bGuideIssueAction } from '../packages/contracts/src/b2b-guide-security';
import { fail, type DelegatedUser } from '../services/identity-service/src/b2b/model';
import type { QueuedUsers } from '../services/identity-service/src/b2b/webhook-authority';
import { fixture, binding, id, basic, input, ctx } from './b2b-identity.fixture';

export const issuePair = () => ({ draft: { anchor: structuredClone(binding), guideType: '09' as const, guideSeriesId: id(70) }, fiscalSeriesId: id(71) });
export const allIssueScopes: B2bIdentityScope[] = [...new Set([...b2bGuideIssueScopes, ...b2bGuideIssueReadScopes])];
export async function guideIssueFixture(kind: 'SERVICE' | 'USER' = 'SERVICE', selectedScopes = allIssueScopes) {
  let linked: DelegatedUser;
  const f = fixture(kind === 'USER' ? { verify: async () => structuredClone(linked) } : null, B2bEnabledIdentityScopes);
  const grants = new Map<string, GuideIssueGrantSet>();
  const catalogue = { validate: vi.fn(async (_bindings: unknown[], _action: B2bGuideIssueAction) => {}) };
  const users = { current: vi.fn<QueuedUsers['current']>(async () => kind === 'USER' ? {
    active: true, authVersion: linked.authRevision, permissions: [...linked.permissions], scope: structuredClone(linked.scope),
  } : null) };
  const store: GuideIssueStore = { rate: () => f.store.rate(), transaction: work => f.store.transaction(async tx => {
    const copy = structuredClone(grants);
    const result = await work({ ...tx, guideIssueGrants: async clientId => structuredClone(copy.get(clientId) ?? null),
      saveGuideIssueGrants: async (grant, expected) => {
        if ((copy.get(grant.clientId)?.revision ?? 0) !== expected) return fail(409, 'REVISION_CONFLICT');
        copy.set(grant.clientId, structuredClone(grant));
      } });
    grants.clear(); for (const [clientId, grant] of copy) grants.set(clientId, grant); return result;
  }) };
  const core = new B2bGuideIssueAuthority(store, f.core, catalogue, f.admin, users);
  const made = await f.core.create('human-step-up', { ...input(), kind,
    ...(kind === 'USER' ? { oidcClientId: 'synthetic_oidc' } : {}), scopes: selectedScopes }, ctx());
  linked = { clientId: made.client.id, clientRevision: 1, oidcClientId: 'synthetic_oidc', userId: id(50), authRevision: 3,
    tokenScopes: [...selectedScopes], permissions: ['document.view', 'document.issue'], scope: {
      kind: 'ASSIGNED', branchIds: [binding.branchId], emissionPointIds: [binding.pointId], series: [binding.seriesId, id(70), id(71)],
    } };
  const token = kind === 'USER' ? 'synthetic-user-token' : (await f.core.token(basic(made.client.id, made.clientSecret!), {
    grant_type: 'client_credentials', scope: selectedScopes.join(' '),
  }, ctx())).access_token!;
  const replace = (bindings: unknown[] = [issuePair()], expectedGrantRevision = 0, expectedClientRevision = 1) =>
    core.replace('human-step-up', made.client.id, { bindings, expectedGrantRevision, expectedClientRevision }, ctx());
  const authorize = (binding: unknown = issuePair(), action: B2bGuideIssueAction = 'ISSUE') => core.authorize(token, { kind, binding, action }, ctx());
  return { ...f, identity: f.core, memory: f.store, store, core, grants, catalogue, users, made, linked, token, replace, authorize };
}
