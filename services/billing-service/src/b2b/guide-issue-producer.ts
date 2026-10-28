import { createHash, randomUUID } from 'node:crypto';
import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { validB2bGuideBinding, validB2bGuideIssueBinding, type B2bGuideIssueAction } from '@factuez/contracts/b2b-guide-security';
import { boundedSupplementJson } from '@factuez/sunat-core/dist/fiscal-supplement-command';
import { fiscalRuc, fiscalSnapshotSha256 as hash } from '@factuez/sunat-core/dist/fiscal-note';
import { prepareGuide09 } from '@factuez/sunat-core/dist/fiscal-guide-preparation';
import { supplementActor } from '../application/supplement-actor';
import { parseGuideBody, type GuideDraft } from './guide-model';
import type { GuideIssueAuthority, GuideIssueBinding, GuideIssueContext, GuideIssueContextResolver,
  GuideIssueProof, GuideIssueReceipt, GuideIssueRequest, GuideIssueScope, GuideIssueStore } from './guide-issue-model';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const flags = { candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false,
  authorizedForTransfer: false, officialRulesValidated: false, officialCdrVerified: false, numberReserved: true } as const;
function fail(status: number, code: string): never { throw new B2bSecurityError(status, code); }
function detached<T>(v: T): T {
  try { return boundedSupplementJson(v) as T; } catch { return fail(400, 'INVALID_GUIDE_ISSUE_REQUEST'); }
}
function exact(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) &&
    Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
}
const int = (v: unknown, min = 1): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= 2147483647;
const uuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const sha = (v: unknown): v is string => typeof v === 'string' && SHA.test(v);
const iso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
export function validGuideIssueBinding(v: unknown): v is GuideIssueBinding {
  return validB2bGuideIssueBinding(v);
}
function parsed(input: unknown): GuideIssueRequest {
  const v = detached(input);
  if (!exact(v, ['schemaVersion', 'binding', 'draftId', 'expectedRevision', 'idempotencyKey']) ||
    v.schemaVersion !== 'factuez.b2b.guide-issue.v1' || !validGuideIssueBinding(v.binding) || !uuid(v.draftId) ||
    typeof v.expectedRevision !== 'string' || !/^"v[1-9][0-9]{0,8}"$/.test(v.expectedRevision) ||
    typeof v.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(v.idempotencyKey))
    fail(400, 'INVALID_GUIDE_ISSUE_REQUEST');
  return v as GuideIssueRequest;
}
function profile(d: GuideDraft, issuer: GuideIssueContext['issuer']): void {
  try {
    if (!same(parseGuideBody(d.body, d.binding), d.body) || hash(d.body) !== d.bodySha256) throw new Error();
    prepareGuide09({ schemaVersion: 'factuez.guide09-preparation-input.v1', draftId: d.id,
      draftRevision: `"v${d.revision}"`, draftBodySha256: d.bodySha256, body: d.body, issuer });
  } catch { fail(409, 'GUIDE_ISSUE_PROFILE_INVALID'); }
}
function checkedContext(v: GuideIssueContext, b: GuideIssueBinding): GuideIssueContext {
  if (!exact(v, ['issuer', 'counter', 'contextSha256']) || !exact(v.issuer, ['ruc', 'legalName']) ||
    v.issuer.ruc !== b.draft.anchor.issuerRuc || typeof v.issuer.legalName !== 'string' ||
    !v.issuer.legalName.trim() || v.issuer.legalName.length > 200 || !sha(v.contextSha256) ||
    !exact(v.counter, ['id', 'series', 'nextNumber', 'masterRevision']) || v.counter.id !== b.fiscalSeriesId ||
    typeof v.counter.series !== 'string' || !/^T[A-Z0-9]{3}$/.test(v.counter.series) ||
    typeof v.counter.nextNumber !== 'string' || !/^[1-9][0-9]{0,7}$/.test(v.counter.nextNumber) ||
    !int(v.counter.masterRevision, 0)) fail(503, 'INVALID_GUIDE_ISSUE_CONTEXT');
  return detached(v);
}

/** Validates the complete immutable local receipt, including ordered item body,
 * fiscal identity and candidate flags. It is NOT signature or CDR validation. */
export function validateGuideIssueReceipt(input: GuideIssueReceipt, scope: GuideIssueScope,
  expectedRequestSha256?: string): GuideIssueReceipt {
  try {
    const r = boundedSupplementJson(input) as GuideIssueReceipt, s = r.snapshot;
    if (!exact(r, ['id', 'clientId', 'actorKey', 'keySha256', 'requestSha256', 'grantRevision', 'actor', 'snapshot', 'snapshotSha256']) ||
      !uuid(r.id) || r.clientId !== scope.clientId || r.actorKey !== scope.actorKey || r.keySha256 !== scope.keySha256 ||
      !sha(r.keySha256) || !sha(r.requestSha256) || !sha(r.snapshotSha256) || !int(r.grantRevision) ||
      expectedRequestSha256 !== undefined && r.requestSha256 !== expectedRequestSha256 ||
      !exact(r.actor, ['kind', 'clientId', 'revision', 'subjectId', 'userAuthRevision']) ||
      r.actor.clientId !== r.clientId || !int(r.actor.revision) ||
      !['SERVICE', 'USER'].includes(r.actor.kind) ||
      r.actorKey !== r.actor.kind + ':' + (r.actor.subjectId ?? '-') ||
      r.actor.kind === 'SERVICE' && (r.actor.subjectId !== null || r.actor.userAuthRevision !== null) ||
      r.actor.kind === 'USER' && (!uuid(r.actor.subjectId) || !int(r.actor.userAuthRevision, 0)) ||
      !exact(s, ['schemaVersion', 'documentId', 'operationId', 'binding', 'draftId', 'draftRevision', 'issuer',
        'series', 'number', 'fullNumber', 'body', 'bodySha256', 'contextSha256', 'at', ...Object.keys(flags)]) ||
      s.schemaVersion !== 'factuez.guide-issued-local.v1' || !uuid(s.documentId) || s.operationId !== r.id ||
      s.draftId !== scope.draftId || !validGuideIssueBinding(s.binding) || !same(s.binding, scope.binding) ||
      s.binding.draft.guideType !== '09' || !int(s.draftRevision) || s.draftRevision > 999999999 ||
      !exact(s.issuer, ['ruc', 'legalName']) || s.issuer.ruc !== s.binding.draft.anchor.issuerRuc ||
      typeof s.series !== 'string' || !/^T[A-Z0-9]{3}$/.test(s.series) ||
      typeof s.number !== 'string' || !/^[1-9][0-9]{0,7}$/.test(s.number) || s.fullNumber !== `${s.series}-${s.number}` ||
      !sha(s.bodySha256) || !sha(s.contextSha256) || !iso(s.at) ||
      Object.entries(flags).some(([k, value]) => s[k as keyof typeof flags] !== value) || hash(s) !== r.snapshotSha256)
      throw new Error();
    profile({ id: s.draftId, binding: s.binding.draft, body: s.body, bodySha256: s.bodySha256,
      revision: s.draftRevision } as GuideDraft, s.issuer);
    return r;
  } catch { return fail(409, 'GUIDE_ISSUE_RECEIPT_INCONSISTENT'); }
}

/** Candidate owner-side producer. No controller, credentials, XML signing,
 * official transport or legacy fiscal Outbox is wired by constructing it.
 * The allowlist is explicit and defaults to no issuer. */
export class BillingGuideIssueProducer {
  private readonly allowed: ReadonlySet<string>;
  constructor(private readonly store: GuideIssueStore, private readonly authority: GuideIssueAuthority,
    private readonly context: GuideIssueContextResolver,
    options: { allowedRucs: readonly string[]; now?: () => string }) {
    if (!options || !Array.isArray(options.allowedRucs) || options.allowedRucs.length > 100) fail(503, 'INVALID_GUIDE_ISSUE_OPTIONS');
    for (const ruc of options.allowedRucs) try { fiscalRuc(ruc, 'issuerRuc'); } catch { fail(503, 'INVALID_GUIDE_ISSUE_OPTIONS'); }
    this.allowed = new Set(options.allowedRucs); this.now = options.now ?? (() => new Date().toISOString());
  }
  private readonly now: () => string;
  private async access(token: string, kind: 'SERVICE' | 'USER', binding: GuideIssueBinding, action: B2bGuideIssueAction) {
    if (!['SERVICE', 'USER'].includes(kind) || typeof token !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token))
      fail(401, 'INVALID_TOKEN');
    let p: GuideIssueProof;
    try { p = detached(await this.authority.current(token, kind, detached(binding), action)); }
    catch (e) { if (e instanceof B2bSecurityError) throw e; return fail(503, 'GUIDE_ISSUE_AUTHORITY_UNAVAILABLE'); }
    let actor;
    try { actor = supplementActor(p.actor); } catch { return fail(503, 'INVALID_GUIDE_ISSUE_AUTHORITY'); }
    const a = actor.b2b, s = actor.scope, b = binding.draft;
    if (!exact(p, ['capability', 'binding', 'actor', 'clientRevision', 'grantRevision']) ||
      p.capability !== 'BETA_GUIDE_ISSUE_LOCAL' || !validGuideIssueBinding(p.binding) || !same(p.binding, binding) ||
      !a || a.kind !== kind || !uuid(a.clientId) || !int(p.clientRevision) || a.revision !== p.clientRevision ||
      !int(p.grantRevision) || s.kind !== 'ASSIGNED' || s.branchIds.length !== 1 || s.branchIds[0] !== b.anchor.branchId ||
      s.emissionPointIds.length !== 1 || s.emissionPointIds[0] !== b.anchor.pointId || s.series.length !== 3 ||
      new Set(s.series).size !== 3 || ![b.anchor.seriesId, b.guideSeriesId, binding.fiscalSeriesId].every(id => s.series.includes(id)))
      fail(503, 'INVALID_GUIDE_ISSUE_AUTHORITY');
    return { proof: p, actor, clientId: a.clientId, actorKey: `${a.kind}:${a.subjectId ?? '-'}`, stamp: hash(p) };
  }
  async issue(token: string, kind: 'SERVICE' | 'USER', input: unknown) {
    const request = parsed(input), binding = request.binding;
    const access = await this.access(token, kind, binding, 'ISSUE');
    const fresh = async () => {
      if ((await this.access(token, kind, binding, 'ISSUE')).stamp !== access.stamp) fail(409, 'GUIDE_ISSUE_AUTHORIZATION_CHANGED');
    };
    if (!this.allowed.has(binding.draft.anchor.issuerRuc)) fail(403, 'GUIDE_ISSUE_ISSUER_NOT_ENABLED');
    if (binding.draft.guideType !== '09') fail(409, 'GUIDE_ISSUE_PROFILE_NOT_ENABLED');
    const { idempotencyKey, ...payload } = request;
    const scope: GuideIssueScope = { binding, draftId: request.draftId, clientId: access.clientId,
      actorKey: access.actorKey, keySha256: createHash('sha256').update(idempotencyKey).digest('hex') };
    const requestSha256 = hash(payload);
    const result = await this.store.transaction(detached(scope), async tx => {
      await fresh();
      const prior = await tx.prior();
      if (prior) {
        if (prior.requestSha256 !== requestSha256) fail(409, 'IDEMPOTENCY_CONFLICT');
        const receipt = validateGuideIssueReceipt(prior, scope, requestSha256);
        if (`"v${receipt.snapshot.draftRevision}"` !== request.expectedRevision) fail(409, 'GUIDE_ISSUE_RECEIPT_INCONSISTENT');
        await fresh(); return { receipt, replayed: true };
      }
      const d = await tx.draft();
      if (!d || d.id !== request.draftId || d.clientId !== scope.clientId || d.actorKey !== scope.actorKey ||
        !validB2bGuideBinding(d.binding) || !same(d.binding, binding.draft)) fail(404, 'GUIDE_DRAFT_NOT_FOUND');
      if (`"v${d.revision}"` !== request.expectedRevision) fail(412, 'REVISION_CONFLICT');
      if (d.state !== 'READY') fail(409, 'READY_GUIDE_REQUIRED');
      if (await tx.issuedForDraft()) fail(409, 'GUIDE_ALREADY_PREPARED');
      const context = checkedContext(await this.context.prepare(tx.sql, detached(binding), detached(d)), binding);
      profile(d, context.issuer);
      const at = this.now();
      if (!iso(at) || !iso(d.updatedAt) || Date.parse(at) < Date.parse(d.updatedAt)) fail(503, 'INVALID_GUIDE_ISSUE_CLOCK');
      const id = randomUUID(), snapshot = { schemaVersion: 'factuez.guide-issued-local.v1' as const,
        documentId: randomUUID(), operationId: id, binding, draftId: d.id, draftRevision: d.revision,
        issuer: context.issuer, series: context.counter.series, number: context.counter.nextNumber,
        fullNumber: `${context.counter.series}-${context.counter.nextNumber}`, body: d.body,
        bodySha256: d.bodySha256, contextSha256: context.contextSha256, at, ...flags };
      const receipt: GuideIssueReceipt = { id, clientId: scope.clientId, actorKey: scope.actorKey,
        keySha256: scope.keySha256, requestSha256, grantRevision: access.proof.grantRevision,
        actor: access.actor.b2b!, snapshot, snapshotSha256: hash(snapshot) };
      validateGuideIssueReceipt(receipt, scope, requestSha256);
      await fresh(); await tx.commit(detached(receipt), detached(context)); await fresh();
      return { receipt, replayed: false };
    });
    // Authorization can expire after COMMIT. Do not undo/reuse the number: a
    // retry with current permission recovers the immutable idempotent receipt.
    await fresh();
    return detached(result);
  }
  /** Read the immutable aggregate by operation under a live READ grant. This
   * never prepares a new context, allocates a number or exposes key digests. */
  async read(token: string, kind: 'SERVICE' | 'USER', bindingInput: unknown, draftId: string, operationId: string) {
    const binding = detached(bindingInput);
    if (!validGuideIssueBinding(binding) || !uuid(draftId) || !uuid(operationId)) fail(400, 'INVALID_GUIDE_ISSUE_REQUEST');
    const access = await this.access(token, kind, binding, 'READ');
    if (!this.allowed.has(binding.draft.anchor.issuerRuc)) fail(403, 'GUIDE_ISSUE_ISSUER_NOT_ENABLED');
    const fresh = async () => {
      if ((await this.access(token, kind, binding, 'READ')).stamp !== access.stamp) fail(409, 'GUIDE_ISSUE_AUTHORIZATION_CHANGED');
    };
    const scope: GuideIssueScope = { binding, draftId, clientId: access.clientId, actorKey: access.actorKey,
      keySha256: createHash('sha256').update('guide-issued-operation:' + operationId).digest('hex') };
    const result = await this.store.transaction(scope, async tx => {
      await fresh(); const found = await tx.operation(operationId);
      if (!found) fail(404, 'GUIDE_ISSUANCE_NOT_FOUND');
      const receipt = validateGuideIssueReceipt(found, { ...scope, keySha256: found.keySha256 });
      if (receipt.id !== operationId) fail(409, 'GUIDE_ISSUE_RECEIPT_INCONSISTENT');
      await fresh(); return receipt;
    });
    await fresh(); return detached(result);
  }
}
