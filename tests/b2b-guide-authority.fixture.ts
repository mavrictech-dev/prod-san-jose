import { vi } from 'vitest';
import { B2bEnabledIdentityScopes, type B2bIdentityScope } from '../packages/contracts/src/b2b-security';
import { B2bGuideAuthority, guideReadScopes, guideWriteScopes, guideOperationScopes, type GuideAction, type GuideGrantSet, type GuideStore } from '../services/identity-service/src/b2b/guide-authority';
import { binding, id, fixture, basic, ctx, input } from './b2b-identity.fixture';
import type { DelegatedUser } from '../services/identity-service/src/b2b/model';
import type { QueuedUsers } from '../services/identity-service/src/b2b/webhook-authority';

export const guidePair = () => ({ anchor: structuredClone(binding), guideType: '09' as const, guideSeriesId: id(70) });
export const allGuideScopes = [...new Set([...guideReadScopes, ...guideWriteScopes, ...guideOperationScopes])];
export async function guideFixture(kind: 'SERVICE' | 'USER' = 'SERVICE', selectedScopes: B2bIdentityScope[] = allGuideScopes) {
  let linked: DelegatedUser;
  const f = fixture(kind === 'USER' ? { verify: async () => structuredClone(linked) } : null, B2bEnabledIdentityScopes);
  const grants = new Map<string, GuideGrantSet>();
  const catalogue = { validate: vi.fn(async (_bindings: unknown[]) => {}) };
  const users = { current: vi.fn<QueuedUsers['current']>(async () => kind === 'USER' ? {
    active: true, authVersion: linked.authRevision, permissions: [...linked.permissions], scope: structuredClone(linked.scope),
  } : null) };
  const store: GuideStore = { rate: () => f.store.rate(), transaction: work => f.store.transaction(async tx => {
    const copy = structuredClone(grants);
    const result = await work({ ...tx, guideGrants: async clientId => structuredClone(copy.get(clientId) ?? null),
      saveGuideGrants: async (grant, expected) => {
        if ((copy.get(grant.clientId)?.revision ?? 0) !== expected) throw new Error('CAS');
        copy.set(grant.clientId, structuredClone(grant));
      } });
    grants.clear(); for (const [clientId, grant] of copy) grants.set(clientId, grant); return result;
  }) };
  const core = new B2bGuideAuthority(store, f.core, catalogue, f.admin, users);
  const made = await f.core.create('human-step-up', { ...input(), kind,
    ...(kind === 'USER' ? { oidcClientId: 'synthetic_oidc' } : {}), scopes: selectedScopes }, ctx());
  linked = { clientId: made.client.id, clientRevision: 1, oidcClientId: 'synthetic_oidc', userId: id(50), authRevision: 3,
    tokenScopes: [...selectedScopes], permissions: ['document.view', 'document.issue'], scope: {
      kind: 'ASSIGNED', branchIds: [binding.branchId], emissionPointIds: [binding.pointId], series: [binding.seriesId, id(70)],
    } };
  const token = kind === 'USER' ? 'synthetic-user-token' : (await f.core.token(basic(made.client.id, made.clientSecret!), {
    grant_type: 'client_credentials', scope: selectedScopes.join(' '),
  }, ctx())).access_token!;
  const replace = (bindings: unknown[] = [guidePair()], expectedGrantRevision = 0, expectedClientRevision = 1) =>
    core.replace('human-step-up', made.client.id, { bindings, expectedGrantRevision, expectedClientRevision }, ctx());
  const authorize = (binding: unknown = guidePair(), action: GuideAction = 'READ') => core.authorize(token, { kind, binding, action }, ctx());
  return { ...f, identity: f.core, memory: f.store, store, grants, core, catalogue, users, made, token, replace, authorize, linked };
}
