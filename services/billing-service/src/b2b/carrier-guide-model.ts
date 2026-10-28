import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { validB2bGuideIssueBinding, type B2bGuideIssueBinding } from '@factuez/contracts/b2b-guide-security';
import { boundedSupplementJson } from '@factuez/sunat-core/dist/fiscal-supplement-command';
import { fiscalSnapshotSha256 as hash, fiscalTimestamp } from '@factuez/sunat-core/dist/fiscal-note';
import { validateCarrierGuideInput, type CarrierGuideBody, type CarrierGuideInput } from '@factuez/sunat-core/dist/carrier-guide-profile';
import { supplementActor, type SupplementActor } from '../application/supplement-actor';

export type CarrierGuideBinding = B2bGuideIssueBinding;
export type CarrierGuideScope = { binding: CarrierGuideBinding; draftId: string; operationId: string };
export type CarrierGuideProof = {
  capability: 'BETA_CARRIER_GUIDE_ISSUE_LOCAL'; action: 'ISSUE' | 'READ'; binding: CarrierGuideBinding;
  actor: SupplementActor; clientRevision: number; grantRevision: number;
};
/** Private authenticated authority. ISSUE and READ must be independently enrolled;
 * implementation must authenticate the token and all three series, never trust a request proof. */
export interface CarrierGuideAuthority {
  current(token: string, kind: 'SERVICE' | 'USER', binding: CarrierGuideBinding, action: 'ISSUE' | 'READ'): Promise<CarrierGuideProof>;
}
export type CarrierGuideRequest = {
  schemaVersion: 'factuez.b2b.carrier-guide-issue.v1'; binding: CarrierGuideBinding;
  draftId: string; expectedRevision: string; idempotencyKey: string;
};
export const carrierGuideClosedFlags = Object.freeze({ candidateOnly: true as const, fiscalExecutionEnabled: false as const,
  transmissionAuthorized: false as const, authorizedForTransfer: false as const, officialRulesValidated: false as const,
  officialCdrVerified: false as const, numberReserved: true as const });
export type CarrierIssuedSnapshot = {
  schemaVersion: 'factuez.carrier-issued-local.v1'; documentId: string; operationId: string;
  binding: CarrierGuideBinding; draftId: string; draftRevision: number;
  issuer: { ruc: string; legalName: string }; series: string; number: string; fullNumber: string;
  body: CarrierGuideBody; bodySha256: string; contextSha256: string; at: string;
} & typeof carrierGuideClosedFlags;
export type CarrierGuideIssuance = {
  schemaVersion: 'factuez.b2b.carrier-guide-issuance.v1'; operationId: string; draftId: string;
  binding: CarrierGuideBinding; snapshot: CarrierIssuedSnapshot; snapshotSha256: string; replayed: boolean;
};
export type CarrierGuideReceipt = {
  clientId: string; actorKey: string; keySha256: string; requestSha256: string;
  actor: NonNullable<SupplementActor['b2b']>; clientRevision: number; grantRevision: number;
  response: CarrierGuideIssuance;
};
export const carrierUuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.exec(v)?.[0] === v;
export const carrierHash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.exec(v)?.[0] === v;
export const carrierInteger = (v: unknown, min = 1): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= 2147483647;
export const carrierFail = (code: string, status = 409): never => { throw new B2bSecurityError(status, code); };
export function carrierJson<T>(v: unknown, max = 256 * 1024): T {
  try { const result = boundedSupplementJson(v); if (Buffer.byteLength(JSON.stringify(result)) > max) throw new Error(); return result as T; }
  catch { return carrierFail('INVALID_CARRIER_GUIDE_JSON', 400); }
}
export function carrierExact(v: unknown, keys: string[]): void {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== [...keys].sort().join(',')) carrierFail('INVALID_CARRIER_GUIDE_CONTRACT', 400);
}
/** Canonical key order for receipt bytes; JSONB is free to reorder object keys. */
export function carrierCanonicalJson(v: unknown): string {
  const copy = carrierJson<unknown>(v);
  const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered((value as Record<string, unknown>)[key])])) : value;
  return JSON.stringify(ordered(copy));
}
export function carrierBinding(v: unknown): asserts v is CarrierGuideBinding {
  if (!validB2bGuideIssueBinding(v) || v.draft.guideType !== '31' || v.draft.anchor.environment !== 'BETA') carrierFail('INVALID_CARRIER_GUIDE_BINDING', 400);
}
export const carrierActorKey = (p: CarrierGuideProof) => `${p.actor.b2b!.kind}:${p.actor.b2b!.subjectId ?? '-'}`;
export function validateCarrierProof(raw: unknown, kind: 'SERVICE' | 'USER', binding: CarrierGuideBinding, action: 'ISSUE' | 'READ'): CarrierGuideProof {
  const p = carrierJson<CarrierGuideProof>(raw);
  carrierExact(p, ['capability', 'action', 'binding', 'actor', 'clientRevision', 'grantRevision']);
  const actor = supplementActor(p.actor), a = actor.b2b, s = actor.scope, b = binding.draft;
  if (p.capability !== 'BETA_CARRIER_GUIDE_ISSUE_LOCAL' || p.action !== action || hash(p.binding) !== hash(binding) ||
    !a || a.kind !== kind || !carrierInteger(p.clientRevision) || p.clientRevision !== a.revision || !carrierInteger(p.grantRevision) ||
    s.kind !== 'ASSIGNED' || s.branchIds.length !== 1 || s.branchIds[0] !== b.anchor.branchId ||
    s.emissionPointIds.length !== 1 || s.emissionPointIds[0] !== b.anchor.pointId || s.series.length !== 3 ||
    new Set(s.series).size !== 3 || ![b.anchor.seriesId, b.guideSeriesId, binding.fiscalSeriesId].every(id => s.series.includes(id)))
    carrierFail('CARRIER_GUIDE_AUTHORIZATION_DENIED', 403);
  return { ...p, actor };
}
export function carrierProfileInput(s: CarrierIssuedSnapshot, snapshotSha256 = hash(s)): CarrierGuideInput {
  const a = s.binding.draft.anchor;
  return validateCarrierGuideInput({ schemaVersion: 'factuez.carrier-guide-input.v1', companyId: a.issuerId,
    branchId: a.branchId, documentId: s.documentId, operationId: s.operationId, issuer: s.issuer,
    documentType: '31', series: s.series, number: s.number, body: s.body, snapshotSha256 });
}
export function validateCarrierIssuance(raw: unknown): CarrierGuideIssuance {
  const r = carrierJson<CarrierGuideIssuance>(raw);
  carrierExact(r, ['schemaVersion', 'operationId', 'draftId', 'binding', 'snapshot', 'snapshotSha256', 'replayed']);
  carrierBinding(r.binding);
  const s = r.snapshot;
  carrierExact(s, ['schemaVersion', 'documentId', 'operationId', 'binding', 'draftId', 'draftRevision', 'issuer', 'series',
    'number', 'fullNumber', 'body', 'bodySha256', 'contextSha256', 'at', ...Object.keys(carrierGuideClosedFlags)]);
  if (r.schemaVersion !== 'factuez.b2b.carrier-guide-issuance.v1' || s.schemaVersion !== 'factuez.carrier-issued-local.v1' ||
    !carrierUuid(r.operationId) || !carrierUuid(r.draftId) || r.operationId !== s.operationId || r.draftId !== s.draftId ||
    hash(r.binding) !== hash(s.binding) || !carrierInteger(s.draftRevision) || s.fullNumber !== `${s.series}-${s.number}` ||
    typeof r.replayed !== 'boolean' || !carrierHash(r.snapshotSha256) || hash(s) !== r.snapshotSha256 ||
    !carrierHash(s.contextSha256) || hash(s.body) !== s.bodySha256 ||
    Object.entries(carrierGuideClosedFlags).some(([k, v]) => s[k as keyof CarrierIssuedSnapshot] !== v)) carrierFail('CARRIER_GUIDE_RECEIPT_INCONSISTENT');
  fiscalTimestamp(s.at, 'at');
  if (new Date(s.at).toISOString() !== s.at || s.at < s.body.issueDate) carrierFail('CARRIER_GUIDE_RECEIPT_INCONSISTENT');
  carrierProfileInput(s, r.snapshotSha256);
  return JSON.parse(carrierCanonicalJson(r)) as CarrierGuideIssuance;
}
