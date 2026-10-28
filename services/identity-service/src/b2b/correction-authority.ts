import { createHash, randomUUID } from 'node:crypto';
import { b2bBindingsContain, b2bCorrectionBindingKey, validB2bCorrectionBinding, validB2bPrincipal,
  type B2bCorrectionBinding, type B2bPrincipal } from '@factuez/contracts/b2b-security';
import { B2bIdentityError, fail, plain, uuid, type AdminAuthority, type RequestContext, type Transaction } from './model';
import type { B2bIdentity } from './service';
import type { QueuedUsers } from './webhook-authority';

export const correctionScopes = ['b2b:documents:read', 'b2b:documents:issue', 'b2b:corrections:write'] as const;
export interface CorrectionGrantSet { clientId: string; clientRevision: number; revision: number; bindings: B2bCorrectionBinding[] }
export interface CorrectionTransaction extends Transaction {
  correctionGrants(clientId: string): Promise<CorrectionGrantSet | null>;
  saveCorrectionGrants(value: CorrectionGrantSet, expectedRevision: number, actorId: string, at: string): Promise<void>;
}
export interface CorrectionStore {
  transaction<T>(work: (tx: CorrectionTransaction) => Promise<T>): Promise<T>;
  rate(keyHash: string, window: number, limit: number): Promise<boolean>;
}
export interface CorrectionCatalogue { validate(bindings: B2bCorrectionBinding[]): Promise<void> }
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
function pairs(value: unknown) {
  if (!Array.isArray(value) || value.length > 500 || !value.every(validB2bCorrectionBinding) ||
    new Set(value.map(b2bCorrectionBindingKey)).size !== value.length) return fail(400, 'INVALID_CORRECTION_BINDINGS');
  return structuredClone(value) as B2bCorrectionBinding[];
}
/** Candidate-only authorization. It neither reserves a fiscal number nor asserts evidence authenticity. */
export class B2bCorrectionAuthority {
  constructor(private readonly store: CorrectionStore, private readonly identity: Pick<B2bIdentity, 'authenticate'>,
    private readonly catalogue: CorrectionCatalogue, private readonly admin: AdminAuthority,
    private readonly users: QueuedUsers | null = null, private readonly now = Date.now) {}
  private async quota(ctx: RequestContext, limit: number) {
    if (!uuid(ctx.requestId) || typeof ctx.peer !== 'string' || !ctx.peer || ctx.peer.length > 256) return fail(400, 'INVALID_REQUEST');
    try { if (!await this.store.rate(digest('correction:' + ctx.peer), Math.floor(this.now() / 60000), limit)) return fail(429, 'RATE_LIMITED'); }
    catch (e) { if (e instanceof B2bIdentityError) throw e; return fail(503, 'IDENTITY_UNAVAILABLE'); }
  }
  private async tx<T>(work: (tx: CorrectionTransaction) => Promise<T>) {
    try { return await this.store.transaction(work); }
    catch (e) { if (e instanceof B2bIdentityError) throw e; return fail(503, 'CORRECTION_AUTHORITY_UNAVAILABLE'); }
  }
  private audit(tx: CorrectionTransaction, ctx: RequestContext, clientId: string, revision: number,
    action: string, outcome: string, actorId: string | null) {
    return tx.audit({ id: randomUUID(), requestId: ctx.requestId, peerHash: digest(ctx.peer), clientId,
      revision, actorId, action, outcome, at: new Date(this.now()).toISOString() });
  }
  private async administrator(token: string) {
    try { const actor = await this.admin.verify(token);
      if (!uuid(actor.id) || actor.stepUpVerified !== true) return fail(403, 'STEP_UP_REQUIRED'); return actor;
    } catch (e) { if (e instanceof B2bIdentityError) throw e; return fail(503, 'ADMIN_AUTHORITY_UNAVAILABLE'); }
  }
  async replace(token: string, id: string, body: unknown, ctx: RequestContext) {
    await this.quota(ctx, 30); const actor = await this.administrator(token);
    if (!uuid(id) || !plain(body) || Object.keys(body).sort().join(',') !== 'bindings,expectedClientRevision,expectedGrantRevision' ||
      !Number.isSafeInteger(body.expectedClientRevision) || body.expectedClientRevision < 1 ||
      !Number.isSafeInteger(body.expectedGrantRevision) || body.expectedGrantRevision < 0) return fail(400, 'INVALID_REQUEST');
    const bindings = pairs(body.bindings), clientRevision = body.expectedClientRevision, expected = body.expectedGrantRevision;
    return this.tx(async tx => {
      // Same lock order as normal client mutations. No cross-owner database join.
      const client = await tx.get(id); if (!client?.enabled) return fail(404, 'RESOURCE_NOT_FOUND');
      if (client.revision !== clientRevision) return fail(409, 'REVISION_CONFLICT');
      if (bindings.length && (correctionScopes.some(s => !client.scopes.includes(s)) ||
        bindings.some(b => !b2bBindingsContain(client.bindings, b.reference)))) return fail(400, 'INVALID_CORRECTION_BINDINGS');
      const prior = await tx.correctionGrants(id);
      if ((prior?.revision ?? 0) !== expected || expected >= 2147483647) return fail(409, 'REVISION_CONFLICT');
      if (bindings.length) await this.catalogue.validate(structuredClone(bindings));
      const grant = { clientId: id, clientRevision, revision: expected + 1, bindings };
      await tx.saveCorrectionGrants(grant, expected, actor.id, new Date(this.now()).toISOString());
      await this.audit(tx, ctx, id, clientRevision, 'REPLACE_CORRECTION_GRANTS', 'OK', actor.id);
      return { ...grant, candidateOnly: true, fiscalExecutionEnabled: false };
    });
  }
  async read(token: string, id: string, ctx: RequestContext) {
    await this.quota(ctx, 30); const actor = await this.administrator(token);
    if (!uuid(id)) return fail(400, 'INVALID_REQUEST');
    return this.tx(async tx => {
      const client = await tx.get(id); if (!client) return fail(404, 'RESOURCE_NOT_FOUND');
      const grants = await tx.correctionGrants(id);
      await this.audit(tx, ctx, id, client.revision, 'READ_CORRECTION_GRANTS', 'OK', actor.id);
      return { clientId: id, clientRevision: client.revision, revision: grants?.revision ?? 0,
        grantedClientRevision: grants?.clientRevision ?? null, bindings: grants ? pairs(grants.bindings) : [],
        current: !!client.enabled && grants?.clientRevision === client.revision, candidateOnly: true, fiscalExecutionEnabled: false };
    });
  }
  async authorize(token: string, body: unknown, ctx: RequestContext) {
    await this.quota(ctx, 300);
    if (!plain(body) || Object.keys(body).sort().join(',') !== 'binding,kind' ||
      !['SERVICE', 'USER'].includes(body.kind) || !validB2bCorrectionBinding(body.binding)) return fail(400, 'INVALID_REQUEST');
    const binding = structuredClone(body.binding) as B2bCorrectionBinding, kind = body.kind as 'SERVICE' | 'USER';
    const principal = await this.identity.authenticate(token, [...correctionScopes], ctx, kind);
    if (!validB2bPrincipal(principal) || principal.kind !== kind || correctionScopes.some(s => !principal.scopes.includes(s))) return fail(401, 'INVALID_PRINCIPAL');
    const result = await this.tx(async tx => {
      const client = await tx.get(principal.clientId), grant = client ? await tx.correctionGrants(client.id) : null;
      let allowed = !!client?.enabled && client.kind === kind && client.revision === principal.revision &&
        correctionScopes.every(s => client.scopes.includes(s)) &&
        b2bBindingsContain(client.bindings, binding.reference) && b2bBindingsContain(principal.bindings, binding.reference) &&
        grant?.clientId === principal.clientId && grant.clientRevision === principal.revision && Number.isSafeInteger(grant.revision) && grant.revision > 0 &&
        pairs(grant!.bindings).some(b => b2bCorrectionBindingKey(b) === b2bCorrectionBindingKey(binding));
      if (allowed && kind === 'USER') {
        const user = await this.users?.current(principal);
        allowed = !!user?.active && user.authVersion === principal.userAuthRevision &&
          ['document.view', 'document.issue'].every(p => user.permissions.includes(p)) &&
          (user.scope.kind === 'GLOBAL' || user.scope.kind === 'ASSIGNED' &&
            user.scope.branchIds.includes(binding.reference.branchId) && user.scope.emissionPointIds.includes(binding.reference.pointId) &&
            [binding.reference.seriesId, binding.noteSeriesId].every(id => user.scope.kind === 'ASSIGNED' && user.scope.series.includes(id)));
      }
      // Validate the *pair* with Billing again, including disabled masters/series and family.
      if (allowed) await this.catalogue.validate([structuredClone(binding)]);
      await this.audit(tx, ctx, principal.clientId, principal.revision, 'AUTHORIZE_CORRECTION_PAIR', allowed ? 'OK' : 'DENIED', principal.subjectId);
      if (!allowed) return null;
      const { clientId, revision, subjectId, userAuthRevision } = principal;
      return { schemaVersion: 'factuez.b2b.correction-authorization.v1', binding, clientRevision: revision, grantRevision: grant!.revision,
        actor: { userId: subjectId, scope: { kind: 'ASSIGNED' as const, branchIds: [binding.reference.branchId],
          emissionPointIds: [binding.reference.pointId], series: [binding.reference.seriesId, binding.noteSeriesId] },
          b2b: { kind, clientId, revision, subjectId, userAuthRevision } satisfies Pick<B2bPrincipal, 'kind' | 'clientId' | 'revision' | 'subjectId' | 'userAuthRevision'> },
        candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false };
    });
    if (!result) return fail(404, 'RESOURCE_NOT_FOUND'); return result;
  }
}
