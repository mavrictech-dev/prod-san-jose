import { createHash, randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { b2bBindingsContain, validB2bPrincipal, type B2bPrincipal } from '@factuez/contracts/b2b-security';
import { b2bGuideBindingKey, validB2bGuideBinding, type B2bGuideBinding } from '@factuez/contracts/b2b-guide-security';
import { B2bIdentityError, fail, uuid, type AdminAuthority, type RequestContext, type Transaction } from './model';
import type { B2bIdentity } from './service';
import type { QueuedUsers } from './webhook-authority';

export const guideReadScopes = ['b2b:guides:read', 'b2b:documents:read'] as const;
export const guideWriteScopes = ['b2b:guides:write', 'b2b:documents:read'] as const;
export const guideOperationScopes = ['b2b:guides:read', 'b2b:documents:read', 'b2b:guide-operations:read'] as const;
export type GuideAction = 'READ' | 'WRITE' | 'OPERATION';
export interface GuideGrantSet { clientId: string; clientRevision: number; revision: number; bindings: B2bGuideBinding[] }
export interface GuideTransaction extends Transaction {
  guideGrants(clientId: string): Promise<GuideGrantSet | null>;
  saveGuideGrants(value: GuideGrantSet, expectedRevision: number, actorId: string, at: string): Promise<void>;
}
export interface GuideStore {
  transaction<T>(work: (tx: GuideTransaction) => Promise<T>): Promise<T>;
  rate(keyHash: string, window: number, limit: number): Promise<boolean>;
}
/** Billing validates the actual 01/03 anchor and DRAFT_ONLY guide registry under the same active RUC/branch/point. */
export interface GuideCatalogue { validate(bindings: B2bGuideBinding[]): Promise<void> }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const keys = (value: object) => Object.keys(value).sort().join(',');
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Detach bounded JSON before inspecting it. No getters, proxies, sparse arrays or prototype payloads. */
function json(value: unknown, code = 'INVALID_REQUEST'): any {
  let nodes = 0, bytes = 0;
  const seen = new WeakSet<object>();
  function copy(input: unknown, depth: number): any {
    if (++nodes > 20000 || depth > 12) return fail(400, code);
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number') { if (!Number.isFinite(input)) return fail(400, code); return input; }
    if (typeof input === 'string') { bytes += Buffer.byteLength(input); if (bytes > 1048576) return fail(400, code); return input; }
    if (typeof input !== 'object' || types.isProxy(input) || seen.has(input)) return fail(400, code);
    const array = Array.isArray(input);
    if (Object.getPrototypeOf(input) !== (array ? Array.prototype : Object.prototype)) return fail(400, code);
    seen.add(input);
    const descriptors = Object.getOwnPropertyDescriptors(input), own = Reflect.ownKeys(descriptors);
    if (own.some(key => typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key))) return fail(400, code);
    const result: any = array ? [] : {};
    if (array && ((input as unknown[]).length > 500 || own.length !== (input as unknown[]).length + 1)) return fail(400, code);
    for (const key of own as string[]) {
      if (array && key === 'length') continue;
      const field = descriptors[key];
      if (!field.enumerable || !('value' in field) || array && !/^(0|[1-9][0-9]*)$/.test(key)) return fail(400, code);
      bytes += Buffer.byteLength(key); if (bytes > 1048576) return fail(400, code);
      result[key] = copy(field.value, depth + 1);
    }
    return result;
  }
  return copy(value, 0);
}
function pairs(value: unknown): B2bGuideBinding[] {
  const detached = json(value, 'INVALID_GUIDE_BINDINGS');
  if (!Array.isArray(detached) || detached.length > 500 || !detached.every(validB2bGuideBinding) ||
    new Set(detached.map(b2bGuideBindingKey)).size !== detached.length) return fail(400, 'INVALID_GUIDE_BINDINGS');
  return detached;
}
function grantSet(value: GuideGrantSet | null, clientId: string): GuideGrantSet | null {
  if (value === null) return null;
  let row: any;
  try { row = json(value); } catch { return fail(503, 'GUIDE_AUTHORITY_UNAVAILABLE'); }
  if (!record(row) || keys(row) !== 'bindings,clientId,clientRevision,revision' || row.clientId !== clientId ||
    !Number.isSafeInteger(row.clientRevision) || row.clientRevision < 1 || row.clientRevision > 2147483647 ||
    !Number.isSafeInteger(row.revision) || row.revision < 1 || row.revision > 2147483647) return fail(503, 'GUIDE_AUTHORITY_UNAVAILABLE');
  try { return { ...row, bindings: pairs(row.bindings) } as GuideGrantSet; }
  catch { return fail(503, 'GUIDE_AUTHORITY_UNAVAILABLE'); }
}

/** Explicit, revisioned paired permission only. Never creates a guide, a number or a fiscal authorization. */
export class B2bGuideAuthority {
  constructor(private readonly store: GuideStore, private readonly identity: Pick<B2bIdentity, 'authenticate'>,
    private readonly catalogue: GuideCatalogue, private readonly admin: AdminAuthority,
    private readonly users: QueuedUsers | null = null, private readonly now = Date.now) {}

  private async quota(ctx: RequestContext, limit: number) {
    if (!uuid(ctx.requestId) || typeof ctx.peer !== 'string' || !ctx.peer || ctx.peer.length > 256) return fail(400, 'INVALID_REQUEST');
    try { if (!await this.store.rate(digest('guide:' + ctx.peer), Math.floor(this.now() / 60000), limit)) return fail(429, 'RATE_LIMITED'); }
    catch (error) { if (error instanceof B2bIdentityError) throw error; return fail(503, 'IDENTITY_UNAVAILABLE'); }
  }
  private async tx<T>(work: (tx: GuideTransaction) => Promise<T>) {
    try { return await this.store.transaction(work); }
    catch (error) { if (error instanceof B2bIdentityError) throw error; return fail(503, 'GUIDE_AUTHORITY_UNAVAILABLE'); }
  }
  private audit(tx: GuideTransaction, ctx: RequestContext, clientId: string, revision: number,
    action: string, outcome: string, actorId: string | null) {
    return tx.audit({ id: randomUUID(), requestId: ctx.requestId, peerHash: digest(ctx.peer), clientId,
      revision, actorId, action, outcome, at: new Date(this.now()).toISOString() });
  }
  private async administrator(token: string) {
    try {
      const actor = await this.admin.verify(token);
      if (!uuid(actor.id) || actor.stepUpVerified !== true) return fail(403, 'STEP_UP_REQUIRED');
      return actor;
    } catch (error) { if (error instanceof B2bIdentityError) throw error; return fail(503, 'ADMIN_AUTHORITY_UNAVAILABLE'); }
  }
  async replace(token: string, id: string, body: unknown, ctx: RequestContext) {
    await this.quota(ctx, 30); const actor = await this.administrator(token), input = json(body);
    if (!uuid(id) || !record(input) || keys(input) !== 'bindings,expectedClientRevision,expectedGrantRevision' ||
      !Number.isSafeInteger(input.expectedClientRevision) || input.expectedClientRevision < 1 || input.expectedClientRevision > 2147483647 ||
      !Number.isSafeInteger(input.expectedGrantRevision) || input.expectedGrantRevision < 0 || input.expectedGrantRevision >= 2147483647) return fail(400, 'INVALID_REQUEST');
    const bindings = pairs(input.bindings), clientRevision = input.expectedClientRevision, expected = input.expectedGrantRevision;
    return this.tx(async tx => {
      // Same lock order as client mutations; Billing catalogue stays behind an explicit port.
      const client = await tx.get(id); if (!client?.enabled) return fail(404, 'RESOURCE_NOT_FOUND');
      if (client.revision !== clientRevision) return fail(409, 'REVISION_CONFLICT');
      const hasGuideScope = client.scopes.some(scope => scope === 'b2b:guides:read' || scope === 'b2b:guides:write');
      if (bindings.length && (!hasGuideScope || !client.scopes.includes('b2b:documents:read') ||
        bindings.some(binding => !b2bBindingsContain(client.bindings, binding.anchor)))) return fail(400, 'INVALID_GUIDE_BINDINGS');
      const prior = grantSet(await tx.guideGrants(id), id);
      if ((prior?.revision ?? 0) !== expected) return fail(409, 'REVISION_CONFLICT');
      if (bindings.length) await this.catalogue.validate(structuredClone(bindings));
      const grant = { clientId: id, clientRevision, revision: expected + 1, bindings };
      await tx.saveGuideGrants(grant, expected, actor.id, new Date(this.now()).toISOString());
      await this.audit(tx, ctx, id, clientRevision, 'REPLACE_GUIDE_GRANTS', 'OK', actor.id);
      return { ...grant, candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false };
    });
  }
  async read(token: string, id: string, ctx: RequestContext) {
    await this.quota(ctx, 30); const actor = await this.administrator(token);
    if (!uuid(id)) return fail(400, 'INVALID_REQUEST');
    return this.tx(async tx => {
      const client = await tx.get(id); if (!client) return fail(404, 'RESOURCE_NOT_FOUND');
      const grant = grantSet(await tx.guideGrants(id), id);
      await this.audit(tx, ctx, id, client.revision, 'READ_GUIDE_GRANTS', 'OK', actor.id);
      return { clientId: id, clientRevision: client.revision, revision: grant?.revision ?? 0,
        grantedClientRevision: grant?.clientRevision ?? null, bindings: grant?.bindings ?? [],
        current: !!client.enabled && grant?.clientRevision === client.revision,
        candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false };
    });
  }
  async authorize(token: string, body: unknown, ctx: RequestContext) {
    await this.quota(ctx, 300); const input = json(body);
    if (!record(input) || keys(input) !== 'action,binding,kind' || !['READ', 'WRITE', 'OPERATION'].includes(input.action) ||
      !['SERVICE', 'USER'].includes(input.kind) || !validB2bGuideBinding(input.binding)) return fail(400, 'INVALID_REQUEST');
    const binding = input.binding as B2bGuideBinding, action = input.action as GuideAction, kind = input.kind as 'SERVICE' | 'USER';
    const required = action === 'READ' ? guideReadScopes : action === 'WRITE' ? guideWriteScopes : guideOperationScopes;
    const principal = json(await this.identity.authenticate(token, [...required], ctx, kind));
    if (!validB2bPrincipal(principal) || principal.kind !== kind || required.some(scope => !principal.scopes.includes(scope))) return fail(401, 'INVALID_PRINCIPAL');
    const result = await this.tx(async tx => {
      const client = await tx.get(principal.clientId), grant = client ? grantSet(await tx.guideGrants(client.id), client.id) : null;
      let allowed = !!client?.enabled && client.kind === kind && client.revision === principal.revision &&
        required.every(scope => client.scopes.includes(scope)) &&
        b2bBindingsContain(client.bindings, binding.anchor) && b2bBindingsContain(principal.bindings, binding.anchor) &&
        grant?.clientRevision === principal.revision &&
        !!grant.bindings.some(pair => b2bGuideBindingKey(pair) === b2bGuideBindingKey(binding));
      if (allowed && kind === 'USER') {
        const user = await this.users?.current(principal);
        const permissions = action === 'WRITE' ? ['document.view', 'document.issue'] : ['document.view'];
        allowed = !!user?.active && user.authVersion === principal.userAuthRevision && permissions.every(permission => user.permissions.includes(permission)) &&
          (user.scope.kind === 'GLOBAL' || user.scope.kind === 'ASSIGNED' &&
            user.scope.branchIds.includes(binding.anchor.branchId) && user.scope.emissionPointIds.includes(binding.anchor.pointId) &&
            [binding.anchor.seriesId, binding.guideSeriesId].every(id => user.scope.kind === 'ASSIGNED' && user.scope.series.includes(id)));
      }
      if (allowed) await this.catalogue.validate([structuredClone(binding)]);
      await this.audit(tx, ctx, principal.clientId, principal.revision, 'AUTHORIZE_GUIDE_' + action, allowed ? 'OK' : 'DENIED', principal.subjectId);
      if (!allowed) return null;
      const { clientId, revision, subjectId, userAuthRevision } = principal;
      return { schemaVersion: 'factuez.b2b.guide-authorization.v1', binding, action, clientRevision: revision, grantRevision: grant!.revision,
        actor: { userId: subjectId, scope: { kind: 'ASSIGNED' as const, branchIds: [binding.anchor.branchId],
          emissionPointIds: [binding.anchor.pointId], series: [binding.anchor.seriesId, binding.guideSeriesId] },
          b2b: { kind, clientId, revision, subjectId, userAuthRevision } satisfies Pick<B2bPrincipal, 'kind' | 'clientId' | 'revision' | 'subjectId' | 'userAuthRevision'> },
        candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false };
    });
    if (!result) return fail(404, 'RESOURCE_NOT_FOUND'); return result;
  }
}
