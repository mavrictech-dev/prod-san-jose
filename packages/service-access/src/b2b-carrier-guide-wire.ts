/** Portable GT31 HTTP grammar. Syntactic integrity is not reference, PKI or SUNAT authority. */
import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { validB2bGuideIssueBinding, type B2bGuideIssueBinding } from '@factuez/contracts/b2b-guide-security';
import { b2bUuid } from '@factuez/contracts/b2b-read-query';
import { correctionEvidenceFreeze, correctionEvidenceHash as hash } from './b2b-correction-evidence-wire';

export type CarrierGuideWireBinding = B2bGuideIssueBinding;
type Party = { ruc: string; legalName: string };
type Location = { ubigeo: string; address: string };
type Item = { code: string; description: string; quantity: string; unitCode: string };
export type CarrierGuideWireBody = {
  issueDate: string; transferDate: string; sender: Party; recipient: Party; origin: Location; destination: Location;
  grossWeight: string; weightUnit: 'KGM' | 'TNE';
  transport: { mode: '01'; carrier: Party & { mtcRegistration: string }; vehicle: { plate: string; tuc: string };
    driver: { identityType: '1' | '4'; identityNumber: string; firstName: string; lastName: string; license: string } };
  reference09: { documentId: string; issuerRuc: string; series: string; number: string; snapshotSha256: string };
  items: Item[]; totalTransfer: true; freightPayer: 'SENDER'; subcontracted: false; regulatedGoods: false;
};
export type CarrierGuideWireReady = { binding: CarrierGuideWireBinding; draftId: string; body: CarrierGuideWireBody };
export type CarrierGuideWireIssue = { schemaVersion: 'factuez.b2b.carrier-guide-issue.v1'; binding: CarrierGuideWireBinding;
  draftId: string; expectedRevision: string; idempotencyKey: string };
export type CarrierGuideWireScope = { binding: CarrierGuideWireBinding; draftId: string; operationId: string };
export const CARRIER_GUIDE_WIRE_FLAGS = Object.freeze({ candidateOnly: true, fiscalExecutionEnabled: false,
  transmissionAuthorized: false, authorizedForTransfer: false, officialRulesValidated: false, officialCdrVerified: false, numberReserved: true } as const);
export type CarrierGuideWireSnapshot = typeof CARRIER_GUIDE_WIRE_FLAGS & {
  schemaVersion: 'factuez.carrier-issued-local.v1'; documentId: string; operationId: string; binding: CarrierGuideWireBinding;
  draftId: string; draftRevision: number; issuer: Party; series: string; number: string; fullNumber: string;
  body: CarrierGuideWireBody; bodySha256: string; contextSha256: string; at: string;
};
export type CarrierGuideWireIssuance = { schemaVersion: 'factuez.b2b.carrier-guide-issuance.v1'; operationId: string; draftId: string;
  binding: CarrierGuideWireBinding; snapshot: CarrierGuideWireSnapshot; snapshotSha256: string; replayed: boolean };
export type CarrierGuideWireReference = {
  snapshot: { schemaVersion: 'factuez.carrier-reference09-owner.v1'; documentId: string; documentType: '09'; issuer: Party;
    series: string; number: string; issueDate: string; transferDate: string; sender: Party; recipient: Party;
    origin: Location; destination: Location; carrier: Party; grossWeight: string; weightUnit: 'KGM' | 'TNE';
    items: Item[]; transportMode: '01'; regulatedGoods: false };
  acceptance: { environment: 'BETA'; documentId: string; issuerRuc: string; fullNumber: string; snapshotSha256: string;
    cdrSha256: string; responseCode: '0'; status: 'ACCEPTED' | 'ACCEPTED_WITH_OBSERVATIONS'; acceptedAt: string };
};
export type CarrierGuideWireOwned = { issuance: CarrierGuideWireIssuance; authorizationSha256: string; reference: CarrierGuideWireReference };
const SHA = /^[a-f0-9]{64}$/, SERIES09 = /^T[A-Z0-9]{3}$/, SERIES31 = /^V[A-Z0-9]{3}$/, NUMBER = /^[1-9][0-9]{0,7}$/;
export const carrierGuideWireRevision = (v: unknown): v is string => typeof v === 'string' && /^"v[1-9][0-9]{0,8}"$/.test(v);
function invalid(): never { throw new B2bSecurityError(400, 'INVALID_CARRIER_GUIDE_REQUEST'); }
export function carrierGuideWireExact(v: unknown, keys: readonly string[]): asserts v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) invalid();
}
export function boundedCarrierGuideWire<T>(v: T, maximum = 128 * 1024): T {
  try {
    const copy = correctionEvidenceFreeze(v);
    if (Buffer.byteLength(JSON.stringify(copy)) > maximum) throw new B2bSecurityError(413, 'INVALID_CARRIER_GUIDE_REQUEST');
    return copy;
  } catch (error) {
    if (error instanceof B2bSecurityError && error.status === 413) throw error;
    return invalid();
  }
}
function matches(v: unknown, re: RegExp): asserts v is string { if (typeof v !== 'string' || !re.test(v)) invalid(); }
function text(v: unknown, max: number): asserts v is string {
  if (typeof v !== 'string' || !v || v !== v.trim() || v.length > max || /[\x00-\x1f\x7f-\x9f\ud800-\udfff\ufffe\uffff]/u.test(v)) invalid();
}
function ruc(v: unknown): asserts v is string {
  matches(v, /^(?:10|15|16|17|20)\d{9}$/);
  const check = 11 - [5, 4, 3, 2, 7, 6, 5, 4, 3, 2].reduce((sum, w, i) => sum + Number(v[i]) * w, 0) % 11;
  if (Number(v[10]) !== (check === 10 ? 0 : check === 11 ? 1 : check)) invalid();
}
function party(v: unknown): asserts v is Party { carrierGuideWireExact(v, ['ruc', 'legalName']); ruc(v.ruc); text(v.legalName, 250); }
function location(v: unknown): asserts v is Location {
  carrierGuideWireExact(v, ['ubigeo', 'address']); matches(v.ubigeo, /^[0-9]{6}$/); if (v.ubigeo === '000000') invalid(); text(v.address, 500);
}
function decimal(v: unknown, scale: number) {
  matches(v, new RegExp(`^(?:0|[1-9]\\d{0,11})(?:\\.\\d{1,${scale}})?$`));
  if (!/[1-9]/.test(v)) invalid();
}
function timestamp(v: unknown): asserts v is string {
  matches(v, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  if (Number(v.slice(0, 4)) < 2000 || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) invalid();
}
/** The owner's CDR may preserve an explicit offset or omit milliseconds. Do
 * not rewrite original evidence just to force the emission timestamp syntax. */
function acceptanceTimestamp(v: unknown): asserts v is string {
  matches(v, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/);
  const m = /^(\d{4}-\d\d-\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?(Z|[+-](\d\d):(\d\d))$/.exec(v)!;
  const date = new Date(m[1] + 'T12:00:00Z');
  if (Number(m[1].slice(0, 4)) < 2000 || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== m[1] ||
    Number(m[2]) > 23 || Number(m[3]) > 59 || Number(m[4]) > 59 || !Number.isFinite(Date.parse(v)) ||
    m[5] !== 'Z' && (Number(m[6]) > 14 || Number(m[7]) > 59 || Number(m[6]) === 14 && Number(m[7]) !== 0)) invalid();
}
function dates(issue: unknown, transfer: unknown) {
  timestamp(issue); matches(transfer, /^\d{4}-\d\d-\d\d$/);
  const parsed = new Date(`${transfer}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== transfer ||
    transfer < new Date(Date.parse(issue) - 18000000).toISOString().slice(0, 10)) invalid();
}
function items(v: unknown): asserts v is Item[] {
  if (!Array.isArray(v) || !v.length || v.length > 100) invalid();
  const codes = new Set<string>();
  for (const i of v) {
    carrierGuideWireExact(i, ['code', 'description', 'quantity', 'unitCode']); text(i.code, 30); text(i.description, 500);
    decimal(i.quantity, 10); matches(i.unitCode, /^[A-Z0-9]{2,3}$/); if (codes.has(i.code)) invalid(); codes.add(i.code);
  }
}
export function carrierGuideWireBinding(v: unknown): CarrierGuideWireBinding {
  const b = boundedCarrierGuideWire(v);
  if (!validB2bGuideIssueBinding(b) || b.draft.guideType !== '31' || b.draft.anchor.environment !== 'BETA') invalid();
  ruc(b.draft.anchor.issuerRuc); return b;
}
function body(v: unknown, binding: CarrierGuideWireBinding): asserts v is CarrierGuideWireBody {
  carrierGuideWireExact(v, ['issueDate', 'transferDate', 'sender', 'recipient', 'origin', 'destination', 'grossWeight', 'weightUnit',
    'transport', 'reference09', 'items', 'totalTransfer', 'freightPayer', 'subcontracted', 'regulatedGoods']);
  dates(v.issueDate, v.transferDate); party(v.sender); party(v.recipient); location(v.origin); location(v.destination);
  if (hash(v.origin) === hash(v.destination) || !['KGM', 'TNE'].includes(String(v.weightUnit)) || v.totalTransfer !== true ||
    v.freightPayer !== 'SENDER' || v.subcontracted !== false || v.regulatedGoods !== false) invalid();
  decimal(v.grossWeight, 3); items(v.items);
  const r = v.reference09; carrierGuideWireExact(r, ['documentId', 'issuerRuc', 'series', 'number', 'snapshotSha256']);
  if (!b2bUuid(r.documentId)) invalid(); ruc(r.issuerRuc); matches(r.series, SERIES09); matches(r.number, NUMBER); matches(r.snapshotSha256, SHA);
  if (r.issuerRuc !== v.sender.ruc) invalid();
  const t = v.transport; carrierGuideWireExact(t, ['mode', 'carrier', 'vehicle', 'driver']); if (t.mode !== '01') invalid();
  carrierGuideWireExact(t.carrier, ['ruc', 'legalName', 'mtcRegistration']); ruc(t.carrier.ruc); text(t.carrier.legalName, 250);
  matches(t.carrier.mtcRegistration, /^[A-Z0-9-]{1,20}$/); if (t.carrier.ruc !== binding.draft.anchor.issuerRuc) invalid();
  carrierGuideWireExact(t.vehicle, ['plate', 'tuc']); matches(t.vehicle.plate, /^[A-Z0-9]{6,8}$/); matches(t.vehicle.tuc, /^[A-Z0-9]{1,15}$/);
  const d = t.driver; carrierGuideWireExact(d, ['identityType', 'identityNumber', 'firstName', 'lastName', 'license']);
  if (!['1', '4'].includes(String(d.identityType))) invalid();
  matches(d.identityNumber, d.identityType === '1' ? /^[0-9]{8}$/ : /^[A-Z0-9]{1,12}$/);
  text(d.firstName, 125); text(d.lastName, 125); matches(d.license, /^[A-Z0-9]{1,10}$/);
}
export function carrierGuideReadyRequest(v: unknown): CarrierGuideWireReady {
  const r = boundedCarrierGuideWire(v); carrierGuideWireExact(r, ['binding', 'draftId', 'body']);
  const binding = carrierGuideWireBinding(r.binding); if (!b2bUuid(r.draftId)) invalid(); body(r.body, binding);
  return r as CarrierGuideWireReady;
}
export function carrierGuideIssueRequest(v: unknown): CarrierGuideWireIssue {
  const r = boundedCarrierGuideWire(v); carrierGuideWireExact(r, ['schemaVersion', 'binding', 'draftId', 'expectedRevision', 'idempotencyKey']);
  carrierGuideWireBinding(r.binding);
  if (r.schemaVersion !== 'factuez.b2b.carrier-guide-issue.v1' || !b2bUuid(r.draftId) || !carrierGuideWireRevision(r.expectedRevision)) invalid();
  matches(r.idempotencyKey, /^[A-Za-z0-9_-]{16,100}$/); return r as CarrierGuideWireIssue;
}
export function carrierGuideWireScope(v: unknown): CarrierGuideWireScope {
  const s = boundedCarrierGuideWire(v); carrierGuideWireExact(s, ['binding', 'draftId', 'operationId']); carrierGuideWireBinding(s.binding);
  if (!b2bUuid(s.draftId) || !b2bUuid(s.operationId)) invalid(); return s as CarrierGuideWireScope;
}
function ownerResponse<T>(work: () => T): T {
  try { return work(); } catch { throw new B2bSecurityError(503, 'INCONSISTENT_CARRIER_GUIDE_RESPONSE'); }
}
export function carrierGuideReadyResponse(v: unknown, request: CarrierGuideWireReady): { draftId: string; revision: string; bodySha256: string } {
  return ownerResponse(() => {
    const r = boundedCarrierGuideWire(v, 4096); carrierGuideWireExact(r, ['draftId', 'revision', 'bodySha256']);
    if (r.draftId !== request.draftId || r.revision !== '"v1"' || r.bodySha256 !== hash(request.body)) invalid();
    return r as { draftId: string; revision: string; bodySha256: string };
  });
}
export function carrierGuideIssuanceResponse(v: unknown, expected: { binding: CarrierGuideWireBinding; draftId: string; operationId: string | null },
  expectedRevision?: string): CarrierGuideWireIssuance {
  return ownerResponse(() => {
    const r = boundedCarrierGuideWire(v, 256 * 1024) as CarrierGuideWireIssuance;
    carrierGuideWireBinding(expected.binding);
    if (!b2bUuid(expected.draftId) || expected.operationId !== null && !b2bUuid(expected.operationId)) invalid();
    carrierGuideWireExact(r, ['schemaVersion', 'operationId', 'draftId', 'binding', 'snapshot', 'snapshotSha256', 'replayed']);
    const s = r.snapshot;
    carrierGuideWireExact(s, ['schemaVersion', 'documentId', 'operationId', 'binding', 'draftId', 'draftRevision', 'issuer', 'series', 'number',
      'fullNumber', 'body', 'bodySha256', 'contextSha256', 'at', ...Object.keys(CARRIER_GUIDE_WIRE_FLAGS)]);
    if (r.schemaVersion !== 'factuez.b2b.carrier-guide-issuance.v1' || s.schemaVersion !== 'factuez.carrier-issued-local.v1' ||
      !b2bUuid(r.operationId) || !b2bUuid(s.documentId) || r.draftId !== expected.draftId || s.draftId !== r.draftId || s.operationId !== r.operationId ||
      expected.operationId !== null && r.operationId !== expected.operationId || hash(r.binding) !== hash(expected.binding) ||
      hash(s.binding) !== hash(expected.binding) || typeof r.replayed !== 'boolean' || !Number.isSafeInteger(s.draftRevision) ||
      s.draftRevision < 1 || s.draftRevision > 2147483647 || expectedRevision !== undefined && `"v${s.draftRevision}"` !== expectedRevision ||
      s.fullNumber !== `${s.series}-${s.number}` || s.bodySha256 !== hash(s.body) || r.snapshotSha256 !== hash(s) ||
      Object.entries(CARRIER_GUIDE_WIRE_FLAGS).some(([k, value]) => s[k as keyof typeof CARRIER_GUIDE_WIRE_FLAGS] !== value)) invalid();
    matches(s.contextSha256, SHA); matches(s.series, SERIES31); matches(s.number, NUMBER); timestamp(s.at); body(s.body, expected.binding); party(s.issuer);
    if (s.at < s.body.issueDate || s.issuer.ruc !== expected.binding.draft.anchor.issuerRuc || s.issuer.ruc !== s.body.transport.carrier.ruc ||
      s.issuer.legalName !== s.body.transport.carrier.legalName || s.body.reference09.documentId === s.documentId) invalid();
    return r;
  });
}
/** Only the pinned private owner endpoint may deliver this value. Hashes and
 * accepted flags alone are not a cryptographic capability: SUNAT rebuilds and seals it. */
export function carrierGuideArtifactOwnerResponse(v: unknown, scope: CarrierGuideWireScope): CarrierGuideWireOwned {
  return ownerResponse(() => {
    const r = boundedCarrierGuideWire(v, 512 * 1024) as CarrierGuideWireOwned;
    carrierGuideWireExact(r, ['issuance', 'authorizationSha256', 'reference']); matches(r.authorizationSha256, SHA);
    const issuance = carrierGuideIssuanceResponse(r.issuance, scope), b = issuance.snapshot.body, ref = b.reference09;
    carrierGuideWireExact(r.reference, ['snapshot', 'acceptance']); const s = r.reference.snapshot, a = r.reference.acceptance;
    carrierGuideWireExact(s, ['schemaVersion', 'documentId', 'documentType', 'issuer', 'series', 'number', 'issueDate', 'transferDate', 'sender',
      'recipient', 'origin', 'destination', 'carrier', 'grossWeight', 'weightUnit', 'items', 'transportMode', 'regulatedGoods']);
    carrierGuideWireExact(a, ['environment', 'documentId', 'issuerRuc', 'fullNumber', 'snapshotSha256', 'cdrSha256', 'responseCode', 'status', 'acceptedAt']);
    if (s.schemaVersion !== 'factuez.carrier-reference09-owner.v1' || s.documentType !== '09' || s.documentId !== ref.documentId ||
      s.issuer.ruc !== ref.issuerRuc || s.series !== ref.series || s.number !== ref.number || hash(s) !== ref.snapshotSha256 ||
      hash(s.issuer) !== hash(s.sender) || s.transportMode !== '01' || s.regulatedGoods !== false || hash(s.carrier) !== hash(issuance.snapshot.issuer) ||
      s.issueDate > b.issueDate || a.environment !== 'BETA' || a.documentId !== ref.documentId || a.issuerRuc !== ref.issuerRuc ||
      a.fullNumber !== `${ref.series}-${ref.number}` || a.snapshotSha256 !== ref.snapshotSha256 || a.responseCode !== '0' ||
      !['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS'].includes(a.status)) invalid();
    for (const key of ['sender', 'recipient', 'origin', 'destination', 'transferDate', 'grossWeight', 'weightUnit', 'items'] as const)
      if (hash(s[key]) !== hash(b[key])) invalid();
    party(s.issuer); dates(s.issueDate, s.transferDate); acceptanceTimestamp(a.acceptedAt); matches(a.cdrSha256, SHA);
    if (Date.parse(a.acceptedAt) < Date.parse(s.issueDate) || Date.parse(a.acceptedAt) > Date.parse(b.issueDate)) invalid();
    return r;
  });
}
