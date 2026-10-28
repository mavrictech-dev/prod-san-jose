import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { b2bGuideIssueBindingKey, validB2bGuideIssueBinding, type B2bGuideIssueBinding } from '@factuez/contracts/b2b-guide-security';
import { b2bUuid } from '@factuez/contracts/b2b-read-query';
import { correctionEvidenceFreeze, correctionEvidenceHash } from './b2b-correction-evidence-wire';
import { GUIDE_PREPARATION_GATES, validateGuidePreparationResponse } from './b2b-guide-preparation-wire';

export type GuideIssueWireRequest = {
  schemaVersion: 'factuez.b2b.guide-issue.v1'; binding: B2bGuideIssueBinding;
  draftId: string; expectedRevision: string; idempotencyKey: string;
};
const FLAGS = { candidateOnly: true, numberReserved: true, fiscalExecutionEnabled: false,
  transmissionAuthorized: false, authorizedForTransfer: false, officialRulesValidated: false, officialCdrVerified: false } as const;
export type GuideIssuedWireSnapshot = typeof FLAGS & {
  schemaVersion: 'factuez.guide-issued-local.v1'; documentId: string; operationId: string;
  binding: B2bGuideIssueBinding; draftId: string; draftRevision: number;
  issuer: { ruc: string; legalName: string }; series: string; number: string; fullNumber: string;
  body: ReturnType<typeof validateGuidePreparationResponse>['plan']['body'];
  bodySha256: string; contextSha256: string; at: string;
};
export type GuideIssuanceResponse = {
  schemaVersion: 'factuez.b2b.guide-issuance.v1'; operationId: string; draftId: string;
  binding: B2bGuideIssueBinding; snapshot: GuideIssuedWireSnapshot; snapshotSha256: string; replayed: boolean | null;
};
const revision = (v: unknown): v is string => typeof v === 'string' && /^"v[1-9][0-9]{0,8}"$/.test(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function ruc(value: string) {
  if (!/^(?:10|15|16|17|20)\d{9}$/.test(value)) throw new Error();
  const check = 11 - [5, 4, 3, 2, 7, 6, 5, 4, 3, 2].reduce((sum, weight, i) => sum + Number(value[i]) * weight, 0) % 11;
  if (Number(value[10]) !== (check === 10 ? 0 : check === 11 ? 1 : check)) throw new Error();
}
function exact(v: any, keys: string[]) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) throw new Error();
}
export function boundedGuideIssueRequest<T>(value: T): T {
  try {
    const copy = correctionEvidenceFreeze(value);
    if (Buffer.byteLength(JSON.stringify(copy)) > 128 * 1024) throw new B2bSecurityError(413, 'INVALID_GUIDE_ISSUE_REQUEST');
    return copy;
  } catch (e) {
    if (e instanceof B2bSecurityError && e.status === 413) throw e;
    throw new B2bSecurityError(400, 'INVALID_GUIDE_ISSUE_REQUEST');
  }
}
export function validateGuideIssueRequest(value: unknown): GuideIssueWireRequest {
  const r = boundedGuideIssueRequest(value) as GuideIssueWireRequest;
  try {
    exact(r, ['schemaVersion', 'binding', 'draftId', 'expectedRevision', 'idempotencyKey']);
    if (r.schemaVersion !== 'factuez.b2b.guide-issue.v1' || !validB2bGuideIssueBinding(r.binding) || !b2bUuid(r.draftId) ||
      !revision(r.expectedRevision) || typeof r.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(r.idempotencyKey)) throw new Error();
    return r;
  } catch { throw new B2bSecurityError(400, 'INVALID_GUIDE_ISSUE_REQUEST'); }
}

/** Integrity of a local candidate aggregate, not proof of official rules, transport or CDR.
 * The portable preparation wire checks the complete 09/private02/reason04 body profile;
 * no Billing or SUNAT engine dependency is introduced at this boundary. */
export function validateGuideIssuanceResponse(value: unknown, binding: B2bGuideIssueBinding, draftId: string,
  operationId: string | null, expectedRevision?: string): GuideIssuanceResponse {
  try {
    const r = correctionEvidenceFreeze(value) as GuideIssuanceResponse;
    const b = correctionEvidenceFreeze(binding);
    if (Buffer.byteLength(JSON.stringify(r)) > 512 * 1024 || !validB2bGuideIssueBinding(b) || b.draft.guideType !== '09' ||
      !b2bUuid(draftId) || (operationId === null ? !revision(expectedRevision) : !b2bUuid(operationId) || expectedRevision !== undefined)) throw new Error();
    ruc(b.draft.anchor.issuerRuc);
    exact(r, ['schemaVersion', 'operationId', 'draftId', 'binding', 'snapshot', 'snapshotSha256', 'replayed']);
    const sameBinding = (v: unknown) => validB2bGuideIssueBinding(v) && b2bGuideIssueBindingKey(v) === b2bGuideIssueBindingKey(b);
    if (r.schemaVersion !== 'factuez.b2b.guide-issuance.v1' || !b2bUuid(r.operationId) ||
      operationId !== null && r.operationId !== operationId || r.draftId !== draftId || !sameBinding(r.binding) ||
      (operationId === null ? typeof r.replayed !== 'boolean' : r.replayed !== null) || !sha(r.snapshotSha256)) throw new Error();
    const s = r.snapshot;
    exact(s, ['schemaVersion', 'documentId', 'operationId', 'binding', 'draftId', 'draftRevision', 'issuer', 'series', 'number',
      'fullNumber', 'body', 'bodySha256', 'contextSha256', 'at', ...Object.keys(FLAGS)]);
    if (s.schemaVersion !== 'factuez.guide-issued-local.v1' || !b2bUuid(s.documentId) || s.operationId !== r.operationId ||
      s.draftId !== draftId || !sameBinding(s.binding) || !Number.isSafeInteger(s.draftRevision) || s.draftRevision < 1 || s.draftRevision > 999999999 ||
      operationId === null && `"v${s.draftRevision}"` !== expectedRevision ||
      typeof s.series !== 'string' || !/^T[A-Z0-9]{3}$/.test(s.series) || typeof s.number !== 'string' || !/^[1-9][0-9]{0,7}$/.test(s.number) ||
      s.fullNumber !== `${s.series}-${s.number}` || !sha(s.bodySha256) || !sha(s.contextSha256) ||
      typeof s.at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s.at) ||
      !Number.isFinite(Date.parse(s.at)) || new Date(s.at).toISOString() !== s.at ||
      Object.entries(FLAGS).some(([k, v]) => s[k as keyof typeof FLAGS] !== v) || correctionEvidenceHash(s) !== r.snapshotSha256) throw new Error();
    // Adapt only for the existing pure body validator. These preparation flags
    // describe this validation input, never replace the issued snapshot flags.
    const closed = { candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false, authorizedForTransfer: false };
    const plan = { schemaVersion: 'factuez.guide09-preparation-input.v1', draftId, draftRevision: `"v${s.draftRevision}"`,
      draftBodySha256: s.bodySha256, issuer: s.issuer, body: s.body, profile: 'FACTUEZ-BETA-GRE09-PRIVATE04-PREPARATION-v1',
      ...closed, numberReserved: false, signatureVerified: false, officialRulesValidated: false, referenceVerification: 'NOT_VERIFIED' };
    validateGuidePreparationResponse({ schemaVersion: 'factuez.b2b.guide-preparation.v1', binding: b.draft,
      plan: { ...plan, planSha256: correctionEvidenceHash(plan) }, gates: [...GUIDE_PREPARATION_GATES], ...closed }, b.draft, draftId, plan.draftRevision);
    return r;
  } catch { throw new B2bSecurityError(503, 'INCONSISTENT_GUIDE_ISSUANCE'); }
}
