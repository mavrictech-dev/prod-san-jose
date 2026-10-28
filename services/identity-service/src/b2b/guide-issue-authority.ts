import { createHash, randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { b2bBindingsContain, validB2bPrincipal, type B2bPrincipal } from '@factuez/contracts/b2b-security';
import { b2bGuideIssueBindingKey, validB2bGuideIssueBinding, b2bGuideIssueScopes, b2bGuideIssueReadScopes,
  type B2bGuideIssueBinding, type B2bGuideIssueAction } from '@factuez/contracts/b2b-guide-security';
import { B2bIdentityError, fail, uuid, type AdminAuthority, type RequestContext, type Transaction } from './model';
import type { B2bIdentity } from './service';
import type { QueuedUsers } from './webhook-authority';

export { b2bGuideIssueScopes, b2bGuideIssueReadScopes };
/** Enrollment never requires a reader to receive a dormant write capability. */
export const guideIssueEnrollmentAllowed = (scopes: readonly string[]) =>
  b2bGuideIssueScopes.every(scope => scopes.includes(scope)) || b2bGuideIssueReadScopes.every(scope => scopes.includes(scope));
export interface GuideIssueGrantSet { clientId: string; clientRevision: number; revision: number; bindings: B2bGuideIssueBinding[] }
export interface GuideIssueTransaction extends Transaction {
  guideIssueGrants(clientId: string): Promise<GuideIssueGrantSet | null>;
  saveGuideIssueGrants(value: GuideIssueGrantSet, expectedRevision: number, actorId: string, at: string): Promise<void>;
}
export interface GuideIssueStore {
  transaction<T>(work: (tx: GuideIssueTransaction) => Promise<T>): Promise<T>;
  rate(keyHash: string, window: number, limit: number): Promise<boolean>;
}
export interface GuideIssueCatalogue { validate(bindings: B2bGuideIssueBinding[], action: B2bGuideIssueAction): Promise<void> }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const keys = (value: object) => Object.keys(value).sort().join(',');
const record = (value: any): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const revision = (value: unknown, min = 1) => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= 2147483647;
/** Closed LOCAL/BETA profiles. Each still requires its exact independent grant
 * and Billing-owned mapping; enrolling 09 never authorizes 31 (or conversely). */
const localGuideTypes = ['09', '31'] as const;
const localGuideType = (binding: B2bGuideIssueBinding) => localGuideTypes.some(type => type === binding.draft.guideType);

/** Bounded descriptor-only copying: never invoke user getters, proxy traps or toJSON. */
export function guideIssueJson(value: unknown, status = 400, code = 'INVALID_REQUEST'): any {
  let nodes = 0, bytes = 0;
  const seen = new WeakSet<object>();
  function copy(input: unknown, depth: number): any {
    if (++nodes > 20000 || depth > 12) return fail(status, code);
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number') { if (!Number.isFinite(input)) return fail(status, code); return input; }
    if (typeof input === 'string') { bytes += Buffer.byteLength(input); if (bytes > 1048576) return fail(status, code); return input; }
    if (typeof input !== 'object' || types.isProxy(input) || seen.has(input)) return fail(status, code);
    const array = Array.isArray(input), proto = Object.getPrototypeOf(input);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return fail(status, code);
    seen.add(input);
    const descriptors = Object.getOwnPropertyDescriptors(input), own = Reflect.ownKeys(descriptors);
    if (own.some(key => typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key))) return fail(status, code);
    const result: any = array ? [] : {};
    if (array && ((input as unknown[]).length > 500 || own.length !== (input as unknown[]).length + 1)) return fail(status, code);
    for (const key of own as string[]) {
      if (array && key === 'length') continue;
      const field = descriptors[key];
      if (!field.enumerable || !('value' in field) || array && (!/^(0|[1-9][0-9]*)$/.test(key) ||
        !Number.isSafeInteger(Number(key)) || Number(key) >= (input as unknown[]).length)) return fail(status, code);
      bytes += Buffer.byteLength(key); if (bytes > 1048576) return fail(status, code);
      result[key] = copy(field.value, depth + 1);
    }
    return result;
  }
  return copy(value, 0);
}
export function guideIssueBindings(value: unknown, status = 400): B2bGuideIssueBinding[] {
  const rows = guideIssueJson(value, status, status === 400 ? 'INVALID_GUIDE_ISSUE_BINDINGS' : 'GUIDE_ISSUE_AUTHORITY_UNAVAILABLE');
  if (!Array.isArray(rows) || rows.length > 500 || !rows.every(validB2bGuideIssueBinding) ||
    new Set(rows.map(b2bGuideIssueBindingKey)).size !== rows.length) return fail(status, status === 400 ? 'INVALID_GUIDE_ISSUE_BINDINGS' : 'GUIDE_ISSUE_AUTHORITY_UNAVAILABLE');
  return rows;
}
export function guideIssueGrantSet(value: unknown, clientId: string): GuideIssueGrantSet | null {
  if (value === null) return null;
  const row = guideIssueJson(value, 503, 'GUIDE_ISSUE_AUTHORITY_UNAVAILABLE');
  if (!record(row) || keys(row) !== 'bindings,clientId,clientRevision,revision' || row.clientId !== clientId ||
    !revision(row.clientRevision) || !revision(row.revision)) return fail(503, 'GUIDE_ISSUE_AUTHORITY_UNAVAILABLE');
  return { ...row, bindings: guideIssueBindings(row.bindings, 503) } as GuideIssueGrantSet;
}
function userFingerprint(user: any): string | null {
  const strings = (items: unknown): items is string[] => Array.isArray(items) && items.every(item => typeof item === 'string');
  if (!record(user) || typeof user.active !== 'boolean' || !revision(user.authVersion, 0) || !strings(user.permissions) || !record(user.scope)) return null;
  const scope = user.scope;
  if (scope.kind !== 'GLOBAL' && (scope.kind !== 'ASSIGNED' || !strings(scope.branchIds) || !strings(scope.emissionPointIds) || !strings(scope.series))) return null;
  return JSON.stringify([user.active, user.authVersion, [...user.permissions].sort(), scope.kind,
    ...(scope.kind === 'ASSIGNED' ? [[...scope.branchIds].sort(), [...scope.emissionPointIds].sort(), [...scope.series].sort()] : [])]);
}

/** Explicit independent third-series grant. Construction has no runtime or fiscal side effects. */
export class B2bGuideIssueAuthority {
  constructor(private readonly store: GuideIssueStore, private readonly identity: Pick<B2bIdentity, 'authenticate'>,
    private readonly catalogue: GuideIssueCatalogue, private readonly admin: AdminAuthority,
    private readonly users: QueuedUsers | null = null, private readonly now = Date.now) {}
  private async quota(ctx: RequestContext, limit: number) {
    if (!uuid(ctx.requestId) || typeof ctx.peer !== 'string' || !ctx.peer || ctx.peer.length > 256) return fail(400, 'INVALID_REQUEST');
    try { if (!await this.store.rate(digest('guide-issue:' + ctx.peer), Math.floor(this.now() / 60000), limit)) return fail(429, 'RATE_LIMITED'); }
    catch (error) { if (error instanceof B2bIdentityError) throw error; return fail(503, 'IDENTITY_UNAVAILABLE'); }
  }
  private async tx<T>(work: (tx: GuideIssueTransaction) => Promise<T>) {
    try { return await this.store.transaction(work); }
    catch (error) { if (error instanceof B2bIdentityError) throw error; return fail(503, 'GUIDE_ISSUE_AUTHORITY_UNAVAILABLE'); }
  }
  private audit(tx: GuideIssueTransaction, ctx: RequestContext, clientId: string, clientRevision: number,
    action: string, outcome: string, actorId: string | null) {
    return tx.audit({ id: randomUUID(), requestId: ctx.requestId, peerHash: digest(ctx.peer), clientId,
      revision: clientRevision, actorId, action, outcome, at: new Date(this.now()).toISOString() });
  }
  private async administrator(token: string, expectedId?: string) {
    try {
      const actor = guideIssueJson(await this.admin.verify(token), 503, 'ADMIN_AUTHORITY_UNAVAILABLE');
      if (!record(actor) || !uuid(actor.id) || actor.stepUpVerified !== true || expectedId && actor.id !== expectedId) return fail(403, 'STEP_UP_REQUIRED');
      return actor as { id: string; stepUpVerified: true };
    } catch (error) { if (error instanceof B2bIdentityError) throw error; return fail(503, 'ADMIN_AUTHORITY_UNAVAILABLE'); }
  }
  async replace(token: string, id: string, body: unknown, ctx: RequestContext) {
    await this.quota(ctx, 30);
    const actor = await this.administrator(token), input = guideIssueJson(body);
    if (!uuid(id) || !record(input) || keys(input) !== 'bindings,expectedClientRevision,expectedGrantRevision' ||
      !revision(input.expectedClientRevision) || !revision(input.expectedGrantRevision, 0) || input.expectedGrantRevision === 2147483647) return fail(400, 'INVALID_REQUEST');
    const bindings = guideIssueBindings(input.bindings), clientRevision = input.expectedClientRevision, expected = input.expectedGrantRevision;
    if (bindings.some(binding => !localGuideType(binding))) return fail(400, 'INVALID_GUIDE_ISSUE_BINDINGS');
    return this.tx(async tx => {
      const client = await tx.get(id); if (!client?.enabled) return fail(404, 'RESOURCE_NOT_FOUND');
      await this.administrator(token, actor.id);
      if (client.revision !== clientRevision) return fail(409, 'REVISION_CONFLICT');
      if (bindings.length && (!guideIssueEnrollmentAllowed(client.scopes) ||
        bindings.some(binding => !b2bBindingsContain(client.bindings, binding.draft.anchor)))) return fail(400, 'INVALID_GUIDE_ISSUE_BINDINGS');
      const prior = guideIssueGrantSet(await tx.guideIssueGrants(id), id);
      if ((prior?.revision ?? 0) !== expected) return fail(409, 'REVISION_CONFLICT');
      if (bindings.length) await this.catalogue.validate(structuredClone(bindings),
        b2bGuideIssueScopes.every(scope => client.scopes.includes(scope)) ? 'ISSUE' : 'READ');
      const grant: GuideIssueGrantSet = { clientId: id, clientRevision, revision: expected + 1, bindings };
      await tx.saveGuideIssueGrants(grant, expected, actor.id, new Date(this.now()).toISOString());
      await this.audit(tx, ctx, id, clientRevision, 'REPLACE_GUIDE_ISSUE_GRANTS', 'OK', actor.id);
      // Verify after the write and audit but before commit: revocation rolls back both.
      await this.administrator(token, actor.id);
      return { ...grant, candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false };
    });
  }
  async read(token: string, id: string, ctx: RequestContext) {
    await this.quota(ctx, 30); const actor = await this.administrator(token);
    if (!uuid(id)) return fail(400, 'INVALID_REQUEST');
    return this.tx(async tx => {
      const client = await tx.get(id); if (!client) return fail(404, 'RESOURCE_NOT_FOUND');
      await this.administrator(token, actor.id);
      const grant = guideIssueGrantSet(await tx.guideIssueGrants(id), id);
      await this.audit(tx, ctx, id, client.revision, 'READ_GUIDE_ISSUE_GRANTS', 'OK', actor.id);
      await this.administrator(token, actor.id);
      return { clientId: id, clientRevision: client.revision, revision: grant?.revision ?? 0,
        grantedClientRevision: grant?.clientRevision ?? null, bindings: grant?.bindings ?? [],
        current: !!client.enabled && grant?.clientRevision === client.revision,
        candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false };
    });
  }
  async authorize(token: string, body: unknown, ctx: RequestContext) {
    await this.quota(ctx, 300); const input = guideIssueJson(body);
    if (!record(input) || keys(input) !== 'action,binding,kind' || !['READ', 'ISSUE'].includes(input.action) ||
      !['SERVICE', 'USER'].includes(input.kind) || !validB2bGuideIssueBinding(input.binding)) return fail(400, 'INVALID_REQUEST');
    const binding = input.binding as B2bGuideIssueBinding, action = input.action as B2bGuideIssueAction, kind = input.kind as 'SERVICE' | 'USER';
    const required = action === 'ISSUE' ? b2bGuideIssueScopes : b2bGuideIssueReadScopes;
    const principal = guideIssueJson(await this.identity.authenticate(token, [...required], ctx, kind), 503, 'GUIDE_ISSUE_AUTHORITY_UNAVAILABLE');
    if (!validB2bPrincipal(principal) || principal.kind !== kind || required.some(scope => !principal.scopes.includes(scope))) return fail(401, 'INVALID_PRINCIPAL');
    const result = await this.tx(async tx => {
      const client = await tx.get(principal.clientId), grant = client ? guideIssueGrantSet(await tx.guideIssueGrants(client.id), client.id) : null;
      let allowed = !!client?.enabled && client.kind === kind && client.revision === principal.revision &&
        required.every(scope => client.scopes.includes(scope)) && b2bBindingsContain(client.bindings, binding.draft.anchor) &&
        b2bBindingsContain(principal.bindings, binding.draft.anchor) && grant?.clientRevision === principal.revision &&
        !!grant.bindings.some(pair => b2bGuideIssueBindingKey(pair) === b2bGuideIssueBindingKey(binding)) &&
        localGuideType(binding);
      let userBefore: string | null = null;
      if (allowed && kind === 'USER') {
        const user = guideIssueJson(await this.users?.current(principal) ?? null, 503, 'GUIDE_ISSUE_AUTHORITY_UNAVAILABLE');
        userBefore = userFingerprint(user);
        const permissions = action === 'ISSUE' ? ['document.view', 'document.issue'] : ['document.view'];
        allowed = userBefore !== null && user.active === true && user.authVersion === principal.userAuthRevision && Array.isArray(user.permissions) &&
          permissions.every(permission => user.permissions.includes(permission)) &&
          (user.scope?.kind === 'GLOBAL' || user.scope?.kind === 'ASSIGNED' &&
            Array.isArray(user.scope.branchIds) && user.scope.branchIds.includes(binding.draft.anchor.branchId) &&
            Array.isArray(user.scope.emissionPointIds) && user.scope.emissionPointIds.includes(binding.draft.anchor.pointId) &&
            Array.isArray(user.scope.series) && [binding.draft.anchor.seriesId, binding.draft.guideSeriesId, binding.fiscalSeriesId].every(id => user.scope.series.includes(id)));
      }
      if (allowed) {
        try { await this.catalogue.validate([structuredClone(binding)], action); }
        catch (error) {
          // Context denial is deliberately indistinguishable from an absent grant. Persist it.
          if (error instanceof B2bIdentityError && [400, 403, 404].includes(error.status)) allowed = false;
          else {
            await this.audit(tx, ctx, principal.clientId, principal.revision, 'AUTHORIZE_GUIDE_ISSUE_' + action, 'UNAVAILABLE', principal.subjectId);
            return { unavailable: true as const };
          }
        }
      }
      if (allowed && kind === 'USER') {
        const userAfter = guideIssueJson(await this.users?.current(principal) ?? null, 503, 'GUIDE_ISSUE_AUTHORITY_UNAVAILABLE');
        allowed = userBefore !== null && userFingerprint(userAfter) === userBefore;
      }
      await this.audit(tx, ctx, principal.clientId, principal.revision, 'AUTHORIZE_GUIDE_ISSUE_' + action, allowed ? 'OK' : 'DENIED', principal.subjectId);
      if (!allowed) return null;
      const { clientId, revision, subjectId, userAuthRevision } = principal;
      return { schemaVersion: 'factuez.b2b.guide-issue-authorization.v1' as const, action, capability: 'BETA_GUIDE_ISSUE_LOCAL' as const,
        binding, actor: { userId: subjectId, scope: { kind: 'ASSIGNED' as const, branchIds: [binding.draft.anchor.branchId],
          emissionPointIds: [binding.draft.anchor.pointId], series: [binding.draft.anchor.seriesId, binding.draft.guideSeriesId, binding.fiscalSeriesId] },
          b2b: { kind, clientId, revision, subjectId, userAuthRevision } satisfies Pick<B2bPrincipal, 'kind' | 'clientId' | 'revision' | 'subjectId' | 'userAuthRevision'> },
        clientRevision: revision, grantRevision: grant!.revision, candidateOnly: true as const,
        fiscalExecutionEnabled: false as const, transmissionAuthorized: false as const };
    });
    if (!result) return fail(404, 'RESOURCE_NOT_FOUND');
    if ('unavailable' in result) return fail(503, 'GUIDE_ISSUE_AUTHORITY_UNAVAILABLE');
    return result;
  }
}
