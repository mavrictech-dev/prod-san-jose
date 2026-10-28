import { createHash, randomUUID } from 'node:crypto';
import { fiscalRuc, fiscalSnapshotSha256 as hash, fiscalTimestamp } from '@factuez/sunat-core/dist/fiscal-note';
import { createCarrierGuide31Profile, type CarrierGuideBody, type CarrierReference09Evidence } from '@factuez/sunat-core/dist/carrier-guide-profile';
import { carrierActorKey, carrierBinding, carrierExact, carrierFail, carrierGuideClosedFlags, carrierJson, carrierProfileInput,
  carrierUuid, validateCarrierIssuance, validateCarrierProof, type CarrierGuideAuthority, type CarrierGuideBinding,
  type CarrierGuideIssuance, type CarrierGuideProof, type CarrierGuideReceipt, type CarrierGuideRequest, type CarrierGuideScope,
  type CarrierIssuedSnapshot } from './carrier-guide-model';
import { PostgresCarrierGuideStore, type CarrierGuideDraftRecord, type PostgresCarrierGuideTransaction } from './carrier-guide-store';
import { PostgresCarrierReference09Owner, type CarrierReferenceSignatureCdrValidator } from './carrier-guide-reference';

type Access = { token: string; kind: 'SERVICE' | 'USER' };
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
/** Persistent local owner only. No signing keys, SUNAT execution, existing sales
 * Document, fiscal OutboxEvent, controller registration or external transport. */
export class CarrierGuideOwner {
  private readonly allowed: ReadonlySet<string>;
  constructor(private readonly store: PostgresCarrierGuideStore, private readonly authority: CarrierGuideAuthority,
    private readonly referenceValidator: CarrierReferenceSignatureCdrValidator, allowedRucs: readonly string[],
    private readonly now: () => string = () => new Date().toISOString()) {
    if (!authority || typeof authority.current !== 'function' || !referenceValidator || typeof referenceValidator.verify !== 'function' ||
      !Array.isArray(allowedRucs) || !allowedRucs.length || allowedRucs.length > 20 || new Set(allowedRucs).size !== allowedRucs.length)
      carrierFail('CARRIER_GUIDE_DEPENDENCIES_REQUIRED', 503);
    for (const ruc of allowedRucs) fiscalRuc(ruc, 'allowedRuc');
    this.allowed = new Set(allowedRucs);
  }
  private async proof(token: string, kind: 'SERVICE' | 'USER', binding: CarrierGuideBinding, action: 'ISSUE' | 'READ'): Promise<CarrierGuideProof> {
    carrierBinding(binding);
    if (!this.allowed.has(binding.draft.anchor.issuerRuc)) carrierFail('CARRIER_GUIDE_ISSUER_NOT_ENABLED', 403);
    if (!['SERVICE', 'USER'].includes(kind) || typeof token !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token)) carrierFail('CARRIER_GUIDE_ACCESS_DENIED', 401);
    return validateCarrierProof(await this.authority.current(token, kind, carrierJson(binding), action), kind, binding, action);
  }
  private async fresh(before: CarrierGuideProof, access: Access): Promise<void> {
    if (hash(await this.proof(access.token, access.kind, before.binding, before.action)) !== hash(before)) carrierFail('CARRIER_GUIDE_AUTHORITY_CHANGED');
  }
  private async xml(tx: PostgresCarrierGuideTransaction, s: CarrierIssuedSnapshot) {
    return createCarrierGuide31Profile(new PostgresCarrierReference09Owner(tx.sql, this.referenceValidator, this.now)).buildXml(carrierProfileInput(s));
  }
  /** Dedicated complete31 ready snapshot, immutable from first persistence.
   * This owner method authenticates ISSUE itself; state/approved flags are not inputs.
   * Existing GuideBody v1 is intentionally not adapted or re-labelled. */
  async persistReadyDraft(token: string, kind: 'SERVICE' | 'USER', raw: {
    binding: CarrierGuideBinding; draftId: string; body: CarrierGuideBody;
  }): Promise<{ draftId: string; revision: string; bodySha256: string }> {
    const v = carrierJson<typeof raw>(raw);
    carrierExact(v, ['binding', 'draftId', 'body']); carrierBinding(v.binding);
    if (!carrierUuid(v.draftId)) carrierFail('INVALID_CARRIER_GUIDE_DRAFT', 400);
    const p = await this.proof(token, kind, v.binding, 'ISSUE'), access = { token, kind }, clientId = p.actor.b2b!.clientId, actorKey = carrierActorKey(p);
    return this.store.transaction(async tx => {
      await tx.lock(`carrier-draft:${v.draftId}`); await this.fresh(p, access);
      const prior = await tx.draft(v.draftId, clientId, actorKey, v.binding);
      if (prior) {
        if (hash(prior.body) !== hash(v.body)) carrierFail('CARRIER_GUIDE_DRAFT_IMMUTABLE');
        await this.fresh(p, access); return { draftId: prior.id, revision: `"v${prior.revision}"`, bodySha256: prior.bodySha256 };
      }
      const context = await tx.context(v.binding, v.body), at = this.now(); fiscalTimestamp(at, 'at');
      const provisional: CarrierIssuedSnapshot = { schemaVersion: 'factuez.carrier-issued-local.v1', documentId: randomUUID(), operationId: randomUUID(),
        binding: v.binding, draftId: v.draftId, draftRevision: 1, issuer: context.issuer, series: context.series,
        number: context.nextNumber, fullNumber: `${context.series}-${context.nextNumber}`, body: v.body, bodySha256: hash(v.body),
        contextSha256: context.contextSha256, at, ...carrierGuideClosedFlags };
      const rendered = await this.xml(tx, provisional);
      if (at < v.body.issueDate || hash(await this.xml(tx, provisional)) !== hash(rendered)) carrierFail('CARRIER_GUIDE_REFERENCE_CHANGED');
      const draft: CarrierGuideDraftRecord = { id: v.draftId, revision: 1, binding: v.binding, clientId, actorKey, body: v.body, bodySha256: hash(v.body), at };
      await tx.sql.$executeRawUnsafe(`INSERT INTO "CarrierGuideDraft" ("id","clientId","actorKey","binding","payload") VALUES ($1::uuid,$2::uuid,$3,$4::jsonb,$5::jsonb)`,
      v.draftId, clientId, actorKey, JSON.stringify(v.binding), JSON.stringify(draft));
      await this.fresh(p, access);
      return { draftId: v.draftId, revision: '"v1"', bodySha256: draft.bodySha256 };
    });
  }
  async issue(token: string, kind: 'SERVICE' | 'USER', raw: unknown): Promise<CarrierGuideIssuance> {
    const request = carrierJson<CarrierGuideRequest>(raw);
    carrierExact(request, ['schemaVersion', 'binding', 'draftId', 'expectedRevision', 'idempotencyKey']);
    carrierBinding(request.binding);
    if (request.schemaVersion !== 'factuez.b2b.carrier-guide-issue.v1' || !carrierUuid(request.draftId) ||
      typeof request.expectedRevision !== 'string' || !/^"v[1-9][0-9]{0,8}"$/.test(request.expectedRevision) ||
      typeof request.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(request.idempotencyKey)) carrierFail('INVALID_CARRIER_GUIDE_REQUEST', 400);
    const p = await this.proof(token, kind, request.binding, 'ISSUE'), access = { token, kind };
    const clientId = p.actor.b2b!.clientId, actorKey = carrierActorKey(p), keySha256 = digest(request.idempotencyKey), requestSha256 = hash(request);
    return this.store.transaction(async tx => {
      await tx.lock(JSON.stringify(['carrier-key', clientId, actorKey, keySha256]));
      await tx.lock(`carrier-draft:${request.draftId}`); await this.fresh(p, access);
      const prior = await tx.receipt(clientId, actorKey, { keySha256 });
      if (prior) {
        if (prior.requestSha256 !== requestSha256 || hash(prior.response.binding) !== hash(request.binding) || prior.response.draftId !== request.draftId) carrierFail('IDEMPOTENCY_CONFLICT');
        await this.xml(tx, prior.response.snapshot); await this.fresh(p, access);
        return { ...prior.response, replayed: true };
      }
      const d = await tx.draft(request.draftId, clientId, actorKey, request.binding);
      if (!d) carrierFail('CARRIER_GUIDE_DRAFT_NOT_FOUND', 404);
      const draft = d!;
      if (request.expectedRevision !== `"v${draft.revision}"`) carrierFail('CARRIER_GUIDE_DRAFT_REVISION_CONFLICT');
      const existing = await tx.sql.$queryRawUnsafe<{ documentId: string }[]>('SELECT "documentId" FROM "CarrierGuideDocument" WHERE "draftId"=$1::uuid', request.draftId);
      if (existing.length) carrierFail('CARRIER_GUIDE_ALREADY_PREPARED');
      const context = await tx.context(request.binding, draft.body), at = this.now();
      const s: CarrierIssuedSnapshot = { schemaVersion: 'factuez.carrier-issued-local.v1', documentId: randomUUID(), operationId: randomUUID(),
        binding: request.binding, draftId: draft.id, draftRevision: draft.revision, issuer: context.issuer, series: context.series,
        number: context.nextNumber, fullNumber: `${context.series}-${context.nextNumber}`, body: draft.body,
        bodySha256: draft.bodySha256, contextSha256: context.contextSha256, at, ...carrierGuideClosedFlags };
      const response = validateCarrierIssuance({ schemaVersion: 'factuez.b2b.carrier-guide-issuance.v1', operationId: s.operationId,
        draftId: s.draftId, binding: s.binding, snapshot: s, snapshotSha256: hash(s), replayed: false });
      const rendered = await this.xml(tx, s);
      if (hash(await tx.context(request.binding, draft.body)) !== hash(context)) carrierFail('CARRIER_GUIDE_CONTEXT_CHANGED');
      const receipt: CarrierGuideReceipt = { clientId, actorKey, keySha256, requestSha256, actor: p.actor.b2b!,
        clientRevision: p.clientRevision, grantRevision: p.grantRevision, response };
      await this.fresh(p, access);
      if (hash(await this.xml(tx, s)) !== hash(rendered)) carrierFail('CARRIER_GUIDE_REFERENCE_CHANGED');
      await tx.commit(receipt, context);
      // A revocation/crypto failure at the final fence rolls back counter AND all children.
      if (hash(await this.xml(tx, s)) !== hash(rendered)) carrierFail('CARRIER_GUIDE_REFERENCE_CHANGED');
      await this.fresh(p, access);
      return response;
    });
  }
  private scope(raw: unknown): CarrierGuideScope {
    const s = carrierJson<CarrierGuideScope>(raw);
    carrierExact(s, ['binding', 'draftId', 'operationId']); carrierBinding(s.binding);
    if (!carrierUuid(s.draftId) || !carrierUuid(s.operationId)) carrierFail('INVALID_CARRIER_GUIDE_SCOPE', 400);
    return s;
  }
  /** Direct structural match for the private SUNAT owner adapter. The selected
   * action remains independent; a READ grant never authorizes artifact ISSUE. */
  async current(raw: CarrierGuideScope, access: Access, action: 'ISSUE' | 'READ') {
    const scope = this.scope(raw);
    if (!['ISSUE', 'READ'].includes(action)) carrierFail('CARRIER_GUIDE_ACCESS_DENIED', 403);
    const p = await this.proof(access.token, access.kind, scope.binding, action);
    return this.store.transaction(async tx => {
      await this.fresh(p, access);
      const receipt = await tx.receipt(p.actor.b2b!.clientId, carrierActorKey(p), { operationId: scope.operationId });
      if (!receipt || receipt.response.draftId !== scope.draftId || hash(receipt.response.binding) !== hash(scope.binding)) carrierFail('CARRIER_GUIDE_OPERATION_NOT_FOUND', 404);
      const issuance = receipt!.response;
      await this.xml(tx, issuance.snapshot); await this.fresh(p, access);
      return { issuance, authorizationSha256: hash(p) };
    });
  }
  async read(token: string, kind: 'SERVICE' | 'USER', scope: CarrierGuideScope): Promise<CarrierGuideIssuance> {
    return (await this.current(scope, { token, kind }, 'READ')).issuance;
  }
  /** PRIVATE SUNAT source. Both the reference projection and acceptance come
   * from the actual transaction-bound PG owner, revalidated against stored
   * original bytes by the injected crypto validator. No public evidence input. */
  async artifactCurrent(raw: CarrierGuideScope, access: Access, action: 'ISSUE' | 'READ'):
    Promise<{ issuance: CarrierGuideIssuance; authorizationSha256: string; reference: CarrierReference09Evidence }> {
    const scope = this.scope(raw);
    if (!['ISSUE', 'READ'].includes(action)) carrierFail('CARRIER_GUIDE_ACCESS_DENIED', 403);
    const p = await this.proof(access.token, access.kind, scope.binding, action);
    return this.store.transaction(async tx => {
      await this.fresh(p, access);
      const r = await tx.receipt(p.actor.b2b!.clientId, carrierActorKey(p), { operationId: scope.operationId });
      if (!r || r.response.draftId !== scope.draftId || hash(r.response.binding) !== hash(scope.binding)) carrierFail('CARRIER_GUIDE_OPERATION_NOT_FOUND', 404);
      const issuance = r!.response, owner = new PostgresCarrierReference09Owner(tx.sql, this.referenceValidator, this.now);
      let reference: CarrierReference09Evidence | undefined;
      const profile = createCarrierGuide31Profile({ loadAcceptedReference09: async q => {
        const loaded = await owner.loadAcceptedReference09(q); reference = loaded; return loaded;
      } });
      const xml = await profile.buildXml(carrierProfileInput(issuance.snapshot)), first = hash(reference);
      if (hash(await profile.buildXml(carrierProfileInput(issuance.snapshot))) !== hash(xml) || hash(reference) !== first)
        carrierFail('CARRIER_GUIDE_REFERENCE_CHANGED');
      await this.fresh(p, access);
      return { issuance, authorizationSha256: hash(p), reference: carrierJson<CarrierReference09Evidence>(reference) };
    });
  }
  async buildXml(token: string, kind: 'SERVICE' | 'USER', raw: CarrierGuideScope, action: 'ISSUE' | 'READ' = 'READ') {
    const scope = this.scope(raw), access = { token, kind };
    if (!['ISSUE', 'READ'].includes(action)) carrierFail('CARRIER_GUIDE_ACCESS_DENIED', 403);
    const p = await this.proof(token, kind, scope.binding, action);
    return this.store.transaction(async tx => {
      await this.fresh(p, access);
      const receipt = await tx.receipt(p.actor.b2b!.clientId, carrierActorKey(p), { operationId: scope.operationId });
      if (!receipt || receipt.response.draftId !== scope.draftId || hash(receipt.response.binding) !== hash(scope.binding)) carrierFail('CARRIER_GUIDE_OPERATION_NOT_FOUND', 404);
      const xml = await this.xml(tx, receipt!.response.snapshot);
      if (hash(await this.xml(tx, receipt!.response.snapshot)) !== hash(xml)) carrierFail('CARRIER_GUIDE_REFERENCE_CHANGED');
      await this.fresh(p, access); return xml;
    });
  }
}
