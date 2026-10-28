import { vi } from 'vitest';
import { B2bSecurityError } from '../../packages/contracts/src/b2b-security';
import { fiscalSnapshotSha256 as hash } from '../../packages/sunat-core/src/fiscal-note';
import { BillingGuideIssueProducer } from '../../services/billing-service/src/b2b/guide-issue-producer';
import type { GuideIssueProof, GuideIssueReceipt, GuideIssueRequest, GuideIssueScope,
  GuideIssueStore, GuideIssueTransaction } from '../../services/billing-service/src/b2b/guide-issue-model';
import type { GuideDraft } from '../../services/billing-service/src/b2b/guide-model';
import { guideBinding, guideUuid, GUIDE_RUC } from './b2b-guide.fixture';
import { guidePreparationBody } from './guide-preparation.fixture';

/** In-memory transactional double; not a persistence implementation. Physical
 * constraints and SQL locking are verified by the separate PostgreSQL runner. */
export function guideIssueFixture(kind: 'SERVICE' | 'USER' = 'SERVICE') {
  const binding = { draft: guideBinding(), fiscalSeriesId: guideUuid(5) };
  const request: GuideIssueRequest = { schemaVersion: 'factuez.b2b.guide-issue.v1', binding,
    draftId: guideUuid(10), expectedRevision: '"v2"', idempotencyKey: 'synthetic_issue_request_0001' };
  const body = guidePreparationBody();
  const draft: GuideDraft = { id: request.draftId, clientId: guideUuid(21), actorKey: `${kind}:${kind === 'USER' ? guideUuid(20) : '-'}`,
    binding: binding.draft, body, bodySha256: hash(body), revision: 2, state: 'READY',
    createdAt: '2026-10-21T15:00:00.000Z', updatedAt: '2026-10-21T16:00:00.000Z' };
  const proof: GuideIssueProof = { capability: 'BETA_GUIDE_ISSUE_LOCAL', binding,
    actor: { userId: kind === 'USER' ? guideUuid(20) : null,
      scope: { kind: 'ASSIGNED', branchIds: [binding.draft.anchor.branchId], emissionPointIds: [binding.draft.anchor.pointId],
        series: [binding.draft.anchor.seriesId, binding.draft.guideSeriesId, binding.fiscalSeriesId] },
      b2b: { kind, clientId: draft.clientId, revision: 1, subjectId: kind === 'USER' ? guideUuid(20) : null,
        userAuthRevision: kind === 'USER' ? 1 : null } }, clientRevision: 1, grantRevision: 1 };
  const control = { revoked: false, at: '2026-10-22T15:00:00.000Z' };
  let state = { next: 1, receipts: [] as GuideIssueReceipt[], documents: [] as string[], items: 0, events: 0 };
  let queue = Promise.resolve();
  const hooks: { before?: () => void; afterWrite?: () => void; beforeCommit?: () => void; afterCommit?: () => void } = {};
  const authority = { current: vi.fn(async () => {
    if (control.revoked) throw new B2bSecurityError(401, 'SYNTHETIC_REVOKED');
    return structuredClone(proof);
  }) };
  const context = { prepare: vi.fn(async () => ({ issuer: { ...body.sender },
    counter: { id: binding.fiscalSeriesId, series: 'T001', nextNumber: String(state.next), masterRevision: 0 },
    contextSha256: hash({ synthetic: true, binding, next: state.next }) })) };
  const store: GuideIssueStore = { transaction: vi.fn(async <T>(scope: GuideIssueScope, work: (tx: GuideIssueTransaction) => Promise<T>): Promise<T> => {
    const prev = queue; let release!: () => void; queue = new Promise<void>(r => { release = r; }); await prev;
    const staged = structuredClone(state);
    const sql = { $queryRawUnsafe: async <T>() => { throw new Error('SQL_NOT_AVAILABLE_IN_MEMORY'); return null as T; },
      $executeRawUnsafe: async () => { throw new Error('SQL_NOT_AVAILABLE_IN_MEMORY'); } };
    try {
      hooks.before?.();
      const result = await work({ sql, prior: async () => structuredClone(staged.receipts.find(r =>
        r.clientId === scope.clientId && r.actorKey === scope.actorKey && r.keySha256 === scope.keySha256) ?? null),
      operation: async id => structuredClone(staged.receipts.find(r => r.id === id && r.clientId === scope.clientId &&
        r.actorKey === scope.actorKey && r.snapshot.draftId === scope.draftId && hash(r.snapshot.binding) === hash(scope.binding)) ?? null),
      draft: async () => structuredClone(draft), issuedForDraft: async () => staged.receipts.some(r => r.snapshot.draftId === scope.draftId),
      commit: async receipt => {
        hooks.beforeCommit?.(); staged.next++; staged.receipts.push(structuredClone(receipt));
        staged.documents.push(receipt.snapshot.documentId); staged.items += receipt.snapshot.body.items.length; staged.events++;
        hooks.afterWrite?.();
      } });
      state = staged; hooks.afterCommit?.(); return result;
    } finally { release(); }
  }) };
  const options = { allowedRucs: [GUIDE_RUC], now: () => control.at };
  const core = new BillingGuideIssueProducer(store, authority, context, options);
  return { binding, request, draft, proof, control, hooks, authority, context, store, core, options,
    state: () => state, issue: (input: unknown = request) => core.issue('synthetic-issue-token', kind, input),
    restart: () => new BillingGuideIssueProducer(store, authority, context, options) };
}
