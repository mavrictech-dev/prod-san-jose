/** Phase 2 contract/pure policy only. No listener, storage, token verifier or fiscal side effects. */
export const IntegrationContractVersion = 'factuez.integration.v1' as const;
export const IntegrationDocumentTypes = ['01', '03', '07', '08', '09', '31'] as const;
export type IntegrationDocumentType = typeof IntegrationDocumentTypes[number];
export const IntegrationScopes = [
  'integration:catalog:read', 'integration:documents:read', 'integration:artifacts:read',
  'integration:exports:create', 'integration:exports:read', 'integration:changes:read',
] as const;
export type IntegrationScope = typeof IntegrationScopes[number];
export const IntegrationLimits = {
  defaultPageSize: 100, maxPageSize: 500, maxPeriodDays: 366,
  cursorTtlSeconds: 900, tokenMaxTtlSeconds: 300, exportTtlSeconds: 86400,
  maxExportBytes: 2147483648, maxBatchMembers: 10000,
} as const;
export const IntegrationArtifactKinds = [
  'UNSIGNED_XML', 'SIGNED_XML', 'SUBMISSION_ZIP', 'CDR_XML', 'CDR_ZIP',
  'ORIGINAL_PDF', 'CURRENT_PDF_A4', 'CURRENT_PDF_TICKET',
] as const;
export type IntegrationArtifactKind = typeof IntegrationArtifactKinds[number];
export const IntegrationFiscalStates = [
  'NOT_CHECKED', 'PENDING', 'QUEUED', 'BUILDING', 'SIGNED', 'SUBMITTED', 'PROCESSING',
  'SUMMARY_PENDING', 'ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS', 'REJECTED',
  'RETRYABLE_ERROR', 'PERMANENT_ERROR', 'VOID_PENDING', 'VOIDED',
] as const;
export type IntegrationFiscalState = typeof IntegrationFiscalStates[number];
export const IntegrationErrors = [
  'INVALID_QUERY', 'INVALID_REQUEST', 'UNAUTHENTICATED', 'INSUFFICIENT_SCOPE',
  'RESOURCE_NOT_FOUND', 'CURSOR_CONTEXT_CHANGED', 'CURSOR_EXPIRED',
  'SNAPSHOT_EXPIRED', 'EVIDENCE_INCONSISTENT', 'INCOMPLETE_BINDING',
  'IDEMPOTENCY_CONFLICT', 'ARTIFACT_UNAVAILABLE', 'EXPORT_EXPIRED',
  'SOURCE_NOT_SUPPORTED', 'CONSISTENT_READ_UNAVAILABLE', 'CHANGE_FEED_NOT_READY',
  'EXPORT_TOO_LARGE', 'RATE_LIMITED', 'UPSTREAM_UNAVAILABLE', 'INTEGRITY_FAILED',
] as const;
export type IntegrationErrorCode = typeof IntegrationErrors[number];
export const IntegrationPatterns = {
  ruc: '^[0-9]{11}$', uuid: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
  series: '^[A-Z0-9]{4}$', number: '^[0-9]{1,20}$',
  decimal: '^-?[0-9]{1,26}(?:\\.[0-9]{1,12})?$', sha256: '^[a-f0-9]{64}$',
  opaque: '^[A-Za-z0-9_-]{16,4096}$',
} as const;

export class IntegrationContractError extends Error {
  constructor(readonly code: IntegrationErrorCode) { super(code); this.name = 'IntegrationContractError'; }
}
const matches = (pattern: string, value: unknown): value is string => typeof value === 'string' && new RegExp(pattern).test(value);
const uuid = (value: unknown): value is string => matches(IntegrationPatterns.uuid, value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const member = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === 'string' && values.includes(value as T);
function dateDay(value: unknown): number {
  if (typeof value !== 'string' || !/^20[0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(value)) throw new IntegrationContractError('INVALID_QUERY');
  const date = new Date(value + 'T00:00:00.000Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new IntegrationContractError('INVALID_QUERY');
  return date.getTime() / 86400000;
}

export interface IntegrationDocumentFiltersV1 {
  issuerRuc: string; environment: 'BETA'; dataset: 'ISSUED_BUSINESS'; from: string; to: string;
  types: IntegrationDocumentType[]; limit: number; cursor: string | null;
  branchId: string | null; pointId: string | null; series: string | null;
  currency: 'PEN' | 'USD' | null; fiscalStatus: IntegrationFiscalState | null;
}
/** Strict HTTP query parser. Required date range is inclusive in America/Lima, not UTC. */
export function parseIntegrationDocumentFilters(query: unknown): IntegrationDocumentFiltersV1 {
  const keys = ['issuerRuc', 'environment', 'dataset', 'from', 'to', 'types', 'limit', 'cursor', 'branchId', 'pointId', 'series', 'currency', 'fiscalStatus'];
  if (!record(query) || !['issuerRuc', 'from', 'to'].every(key => Object.hasOwn(query, key)) || Object.keys(query).some(key => !keys.includes(key)) || Object.values(query).some(v => typeof v !== 'string' || !v))
    throw new IntegrationContractError('INVALID_QUERY');
  if (!matches(IntegrationPatterns.ruc, query.issuerRuc) || (query.environment !== undefined && query.environment !== 'BETA') ||
      (query.dataset !== undefined && query.dataset !== 'ISSUED_BUSINESS')) throw new IntegrationContractError('INVALID_QUERY');
  const fromDay = dateDay(query.from), toDay = dateDay(query.to);
  if (toDay < fromDay || toDay - fromDay + 1 > IntegrationLimits.maxPeriodDays) throw new IntegrationContractError('INVALID_QUERY');
  const types = query.types === undefined ? [...IntegrationDocumentTypes] : (query.types as string).split(',');
  if (!types.length || types.length > 6 || new Set(types).size !== types.length || types.some(type => !member(IntegrationDocumentTypes, type)))
    throw new IntegrationContractError('INVALID_QUERY');
  const limit = query.limit === undefined ? IntegrationLimits.defaultPageSize : Number(query.limit);
  if ((query.limit !== undefined && !/^[1-9][0-9]{0,2}$/.test(query.limit as string)) || !Number.isSafeInteger(limit) || limit > IntegrationLimits.maxPageSize)
    throw new IntegrationContractError('INVALID_QUERY');
  for (const key of ['branchId', 'pointId']) if (query[key] !== undefined && !uuid(query[key])) throw new IntegrationContractError('INVALID_QUERY');
  if ((query.series !== undefined && !matches(IntegrationPatterns.series, query.series)) ||
      (query.currency !== undefined && !member(['PEN', 'USD'], query.currency)) ||
      (query.fiscalStatus !== undefined && !member(IntegrationFiscalStates, query.fiscalStatus)) ||
      (query.cursor !== undefined && !matches(IntegrationPatterns.opaque, query.cursor))) throw new IntegrationContractError('INVALID_QUERY');
  return {
    issuerRuc: query.issuerRuc as string, environment: 'BETA', dataset: 'ISSUED_BUSINESS', from: query.from as string, to: query.to as string,
    types: (types as IntegrationDocumentType[]).sort(), limit, cursor: (query.cursor as string) ?? null,
    branchId: (query.branchId as string) ?? null, pointId: (query.pointId as string) ?? null, series: (query.series as string) ?? null,
    currency: (query.currency as 'PEN' | 'USD') ?? null, fiscalStatus: (query.fiscalStatus as IntegrationFiscalState) ?? null,
  };
}

export interface IntegrationFiscalKeyV1 { issuerRuc: string; environment: 'BETA'; type: IntegrationDocumentType; series: string; number: string }
/** Exact lookup includes RUC/environment/type; a series label or fullNumber alone is not an identity. */
export function parseIntegrationFiscalKey(query: unknown): IntegrationFiscalKeyV1 {
  if (!record(query) || !['issuerRuc', 'type', 'series', 'number'].every(key => Object.hasOwn(query, key)) ||
      Object.keys(query).some(key => !['issuerRuc', 'environment', 'type', 'series', 'number'].includes(key)) ||
      !matches(IntegrationPatterns.ruc, query.issuerRuc) || !member(IntegrationDocumentTypes, query.type) ||
      !matches(IntegrationPatterns.series, query.series) || !matches(IntegrationPatterns.number, query.number) ||
      (query.environment !== undefined && query.environment !== 'BETA')) throw new IntegrationContractError('INVALID_QUERY');
  return { issuerRuc: query.issuerRuc, environment: 'BETA', type: query.type, series: query.series, number: query.number };
}

export interface IntegrationExportRequestV1 {
  filters: { issuerRuc: string; from: string; to: string; environment?: 'BETA'; dataset?: 'ISSUED_BUSINESS';
    types?: IntegrationDocumentType[]; branchId?: string; pointId?: string; series?: string; currency?: 'PEN' | 'USD'; fiscalStatus?: IntegrationFiscalState };
  artifactKinds: IntegrationArtifactKind[]; missingArtifacts: 'FAIL' | 'REPORT'; dataFormat: 'JSONL';
}
/** Strict export JSON parser; metadata-only exports use an explicit empty artifactKinds list. */
export function parseIntegrationExportRequest(value: unknown): IntegrationExportRequestV1 {
  if (!record(value) || Object.keys(value).some(k => !['filters', 'artifactKinds', 'missingArtifacts', 'dataFormat'].includes(k)) ||
      !record(value.filters) || !Array.isArray(value.artifactKinds) || value.artifactKinds.length > IntegrationArtifactKinds.length ||
      !value.artifactKinds.every(k => member(IntegrationArtifactKinds, k)) || new Set(value.artifactKinds).size !== value.artifactKinds.length ||
      !member(['FAIL', 'REPORT'], value.missingArtifacts) || value.dataFormat !== 'JSONL') throw new IntegrationContractError('INVALID_REQUEST');
  const filters = value.filters;
  if (Object.keys(filters).some(k => !['issuerRuc', 'environment', 'dataset', 'from', 'to', 'types', 'branchId', 'pointId', 'series', 'currency', 'fiscalStatus'].includes(k)) ||
      (filters.types !== undefined && (!Array.isArray(filters.types) || !filters.types.every(k => member(IntegrationDocumentTypes, k)))))
    throw new IntegrationContractError('INVALID_REQUEST');
  let parsed: IntegrationDocumentFiltersV1;
  try { parsed = parseIntegrationDocumentFilters({ ...filters, ...(filters.types === undefined ? {} : { types: (filters.types as string[]).join(',') }) }); }
  catch { throw new IntegrationContractError('INVALID_REQUEST'); }
  return { filters: { ...(filters as IntegrationExportRequestV1['filters']), environment: 'BETA', dataset: 'ISSUED_BUSINESS', types: parsed.types },
    artifactKinds: [...value.artifactKinds] as IntegrationArtifactKind[], missingArtifacts: value.missingArtifacts as 'FAIL' | 'REPORT', dataFormat: 'JSONL' };
}

export interface IntegrationResourceV1 {
  issuerRuc: string; environment: 'BETA'; dataset: 'ISSUED_BUSINESS'; type: IntegrationDocumentType;
  branchId: string | null; pointId: string | null; seriesCounterId: string | null;
}
export type IntegrationIdSelection = { kind: 'ALL' } | { kind: 'IDS'; ids: string[] };
/** Each rule is a tuple; do not combine independent RUC/branch/point/series arrays across rules. */
export interface IntegrationGrantV1 {
  issuerRuc: string; environment: 'BETA'; documentTypes: IntegrationDocumentType[];
  branches: IntegrationIdSelection; points: IntegrationIdSelection; series: IntegrationIdSelection;
}
function selectionValid(value: unknown): value is IntegrationIdSelection {
  if (!record(value)) return false;
  if (value.kind === 'ALL') return Object.keys(value).every(k => k === 'kind');
  return value.kind === 'IDS' && Object.keys(value).every(k => k === 'kind' || k === 'ids') && Array.isArray(value.ids) &&
    value.ids.length <= 10000 && value.ids.every(uuid) && new Set(value.ids).size === value.ids.length;
}
function selected(selection: IntegrationIdSelection, id: string | null) {
  return selection.kind === 'ALL' || (id !== null && selection.ids.includes(id));
}
export function validIntegrationGrant(value: unknown): value is IntegrationGrantV1 {
  return record(value) && Object.keys(value).every(k => ['issuerRuc', 'environment', 'documentTypes', 'branches', 'points', 'series'].includes(k)) &&
    matches(IntegrationPatterns.ruc, value.issuerRuc) && value.environment === 'BETA' &&
    Array.isArray(value.documentTypes) && value.documentTypes.length > 0 && value.documentTypes.length <= 6 &&
    value.documentTypes.every(type => member(IntegrationDocumentTypes, type)) && new Set(value.documentTypes).size === value.documentTypes.length &&
    selectionValid(value.branches) && selectionValid(value.points) && selectionValid(value.series);
}
export function validIntegrationResource(value: unknown): value is IntegrationResourceV1 {
  return record(value) && matches(IntegrationPatterns.ruc, value.issuerRuc) && value.environment === 'BETA' && value.dataset === 'ISSUED_BUSINESS' &&
    member(IntegrationDocumentTypes, value.type) && ['branchId', 'pointId', 'seriesCounterId'].every(k => value[k] === null || uuid(value[k]));
}
/** Pure policy evaluator, NOT authentication. Caller must validate/reload principal and grants first (phase 3). */
export function integrationGrantAllows(grants: readonly IntegrationGrantV1[], resource: IntegrationResourceV1): boolean {
  if (!Array.isArray(grants) || !validIntegrationResource(resource) || !grants.length || grants.length > 10000 || !grants.every(validIntegrationGrant)) return false;
  return grants.some(grant => grant.issuerRuc === resource.issuerRuc && grant.environment === resource.environment &&
    grant.documentTypes.includes(resource.type) && selected(grant.branches, resource.branchId) && selected(grant.points, resource.pointId) && selected(grant.series, resource.seriesCounterId));
}
export interface IntegrationArtifactBindingV1 {
  issuerRuc: string; dataset: 'ISSUED_BUSINESS'; environment: 'BETA'; kind: IntegrationArtifactKind;
  owner: { kind: 'DOCUMENT'; resource: IntegrationResourceV1 } |
    { kind: 'BATCH'; membersComplete: boolean; expectedMembers: number; members: (IntegrationResourceV1 & { documentId: string })[] };
}
/** Full shared artifact permission, never permission for just the clicked document. No byte read occurs here. */
export function integrationArtifactAllowed(scopes: readonly IntegrationScope[], grants: readonly IntegrationGrantV1[], binding: IntegrationArtifactBindingV1): boolean {
  if (!Array.isArray(scopes) || !scopes.every(scope => member(IntegrationScopes, scope)) || !scopes.includes('integration:documents:read') || !scopes.includes('integration:artifacts:read') ||
      !binding || !matches(IntegrationPatterns.ruc, binding.issuerRuc) || binding.dataset !== 'ISSUED_BUSINESS' || binding.environment !== 'BETA' || !member(IntegrationArtifactKinds, binding.kind) || !binding.owner) return false;
  if (binding.owner.kind === 'DOCUMENT') return !!binding.owner.resource && binding.owner.resource.issuerRuc === binding.issuerRuc && integrationGrantAllows(grants, binding.owner.resource);
  if (binding.owner.kind !== 'BATCH') return false;
  const owner = binding.owner;
  return owner.membersComplete === true && Number.isSafeInteger(owner.expectedMembers) && owner.expectedMembers > 0 &&
    owner.expectedMembers <= IntegrationLimits.maxBatchMembers && Array.isArray(owner.members) && owner.members.length === owner.expectedMembers &&
    owner.members.every(resource => !!resource && uuid(resource.documentId) && resource.issuerRuc === binding.issuerRuc && integrationGrantAllows(grants, resource)) &&
    new Set(owner.members.map(resource => resource.documentId)).size === owner.expectedMembers;
}
export interface IntegrationCursorContextV1 {
  version: 'factuez.integration.cursor.v1'; clientId: string; grantRevision: number; scopeHash: string; filterHash: string;
  environment: 'BETA'; dataset: 'ISSUED_BUSINESS'; snapshotId: string; expiresAt: number;
}
/** Validate only AFTER decrypting/verifying the opaque cursor. Does not create or trust an unsigned cursor. */
export function assertIntegrationCursorContext(cursor: IntegrationCursorContextV1, expected: Omit<IntegrationCursorContextV1, 'expiresAt'>, nowSeconds: number): void {
  const valid = (v: Omit<IntegrationCursorContextV1, 'expiresAt'>) => !!v && v.version === 'factuez.integration.cursor.v1' && uuid(v.clientId) &&
    Number.isSafeInteger(v.grantRevision) && v.grantRevision >= 0 && matches(IntegrationPatterns.sha256, v.scopeHash) && matches(IntegrationPatterns.sha256, v.filterHash) &&
    v.environment === 'BETA' && v.dataset === 'ISSUED_BUSINESS' && uuid(v.snapshotId);
  if (!valid(cursor) || !valid(expected) || !Number.isSafeInteger(cursor.expiresAt) || !Number.isSafeInteger(nowSeconds) || nowSeconds < 0 ||
      Object.keys(expected).some(k => cursor[k as keyof IntegrationCursorContextV1] !== expected[k as keyof typeof expected]))
    throw new IntegrationContractError('CURSOR_CONTEXT_CHANGED');
  if (cursor.expiresAt <= nowSeconds) throw new IntegrationContractError('CURSOR_EXPIRED');
}

export interface IntegrationPartyV1 {
  identityType: string | null; identityNumber: string | null; legalName: string | null; address: string | null;
  ubigeo: string | null; establishmentCode: string | null;
}
export interface IntegrationTaxV1 { schemeId: string | null; name: string | null; taxableAmount: string | null; amount: string | null; percent: string | null; affectationCode: string | null }
export interface IntegrationAllowanceV1 { charge: boolean; amount: string | null; baseAmount: string | null; percent: string | null; reasonCode: string | null; reason: string | null }
export interface IntegrationItemV1 {
  lineId: string; productCode: string | null; description: string; unitCode: string | null; quantity: string | null;
  unitValue: string | null; unitPriceWithTax: string | null; lineExtensionAmount: string | null;
  taxes: IntegrationTaxV1[]; allowances: IntegrationAllowanceV1[];
}
export interface IntegrationTotalsV1 {
  lineExtensionAmount: string | null; taxableAmount: string | null; exemptAmount: string | null; unaffectedAmount: string | null;
  freeAmount: string | null; igvAmount: string | null; iscAmount: string | null; otherTaxesAmount: string | null;
  allowanceTotalAmount: string | null; chargeTotalAmount: string | null; prepaidAmount: string | null; payableAmount: string | null;
}
export interface IntegrationDocumentRowV1 extends IntegrationResourceV1 {
  schemaVersion: typeof IntegrationContractVersion; id: string; series: string; number: string; fullNumber: string;
  resourceVersion: string; observedAt: string; snapshotSha256: string | null;
  issuerName: string | null; issueDate: string; issueTime: string | null; issuedAt: string | null; currency: 'PEN' | 'USD' | null;
  customer: IntegrationPartyV1 | null; payableAmount: string | null;
  state: { local: 'DRAFT' | 'ISSUED' | 'CANCELLED' | null; fiscal: IntegrationFiscalState; transport: IntegrationFiscalState | null;
    provenance: 'LOCAL' | 'SUNAT_BETA' | 'HISTORICAL'; verifiedAt: string | null; responseCode: string | null };
  source: { system: 'BILLING' | 'AUTHORIZED_HISTORY'; originSystem: string | null; originId: string | null };
  warnings: string[];
}
export interface IntegrationReferenceV1 { documentId: string | null; type: IntegrationDocumentType | null; fullNumber: string; kind: string; reasonCode: string | null; reason: string | null }
export interface IntegrationSalesDetailV1 {
  kind: 'SALE'; issuer: IntegrationPartyV1; customer: IntegrationPartyV1; operationTypeCode: string | null;
  items: IntegrationItemV1[]; taxes: IntegrationTaxV1[]; allowances: IntegrationAllowanceV1[]; totals: IntegrationTotalsV1;
  paymentTerms: { type: 'CONTADO' | 'CREDITO' | null; pendingAmount: string | null; installments: { amount: string; dueDate: string }[] };
  references: IntegrationReferenceV1[]; observations: string | null; additionalInformation: { name: string; value: string }[];
}
export interface IntegrationGuideDetailV1 {
  kind: 'GUIDE'; issuer: IntegrationPartyV1; sender: IntegrationPartyV1 | null; recipient: IntegrationPartyV1 | null; carrier: IntegrationPartyV1 | null;
  items: IntegrationItemV1[]; reasonCode: string | null; reason: string | null; transferDate: string | null;
  origin: IntegrationPartyV1; destination: IntegrationPartyV1; grossWeight: string | null; weightUnit: string | null; packageCount: string | null;
  modeCode: string | null; vehicles: { plate: string; authorization: string | null }[];
  drivers: { identityType: string | null; identityNumber: string | null; firstNames: string | null; lastNames: string | null; license: string | null }[];
  references: IntegrationReferenceV1[]; observations: string | null;
}
export type IntegrationDocumentDetailV1 = IntegrationDocumentRowV1 & (
  { type: '01' | '03' | '07' | '08'; detail: IntegrationSalesDetailV1 } | { type: '09' | '31'; detail: IntegrationGuideDetailV1 }
);
export interface IntegrationArtifactV1 {
  id: string; kind: IntegrationArtifactKind; owner: { kind: 'DOCUMENT' | 'BATCH'; id: string }; fileName: string; mediaType: 'application/xml' | 'application/zip' | 'application/pdf';
  byteLength: number | null; sha256: string | null; availability: 'AVAILABLE' | 'MISSING' | 'PENDING' | 'NOT_SUPPORTED' | 'INCONSISTENT';
  representation: 'ORIGINAL' | 'CURRENT'; provenance: 'LOCAL' | 'SUNAT_BETA' | 'HISTORICAL';
  verification: { integrity: 'VERIFIED' | 'UNVERIFIED' | 'FAILED'; signature: 'VERIFIED' | 'UNVERIFIED' | 'FAILED' | 'NOT_APPLICABLE';
    trust: 'VERIFIED' | 'UNVERIFIED' | 'FAILED' | 'NOT_APPLICABLE'; identity: 'MATCHED' | 'UNVERIFIED' | 'MISMATCH'; checkedAt: string | null };
  rendererVersion: string | null; profileRevision: string | null; generatedAt: string | null;
}
export interface IntegrationPageV1<T> { schemaVersion: typeof IntegrationContractVersion; items: T[];
  page: { limit: number; nextCursor: string | null; snapshotId: string; snapshotAt: string; expiresAt: string; hasMore: boolean; changeCheckpoint: string | null };
  coverage: { types: { type: IntegrationDocumentType; state: 'READY' | 'UNSUPPORTED' | 'UNAVAILABLE'; reasonCode: string | null }[]; complete: boolean };
}

export interface IntegrationIssuerV1 { issuerRuc: string; legalName: string; environment: 'BETA'; active: boolean }
export interface IntegrationBranchV1 { id: string; issuerRuc: string; code: string; name: string; active: boolean; address: string | null; establishmentCode: string | null }
export interface IntegrationPointV1 { id: string; branchId: string; issuerRuc: string; code: string; name: string; active: boolean;
  series: { id: string; type: IntegrationDocumentType; label: string; active: boolean }[] }
export interface IntegrationCapabilitiesV1 { schemaVersion: typeof IntegrationContractVersion; environment: 'BETA'; dataset: 'ISSUED_BUSINESS'; apiState: 'DISABLED' | 'ENABLED';
  types: { type: IntegrationDocumentType; readState: 'READY' | 'PREPARED_BLOCKED' | 'LAB_ONLY' | 'DIAGNOSTIC_ONLY' | 'UNSUPPORTED'; originalArtifacts: boolean; reasonCode: string | null }[];
  consistency: 'SNAPSHOT_READY' | 'NOT_READY'; changes: 'READY' | 'NOT_READY'; limits: typeof IntegrationLimits }
export interface IntegrationBatchV1 { schemaVersion: typeof IntegrationContractVersion; id: string; issuerRuc: string; environment: 'BETA'; kind: 'RC' | 'RA'; identifier: string;
  state: IntegrationDocumentRowV1['state']; membersComplete: true;
  members: { documentId: string; type: IntegrationDocumentType; fullNumber: string; conditionCode: string | null; documentVersion: string | null }[] }
export interface IntegrationExportJobV1 { schemaVersion: typeof IntegrationContractVersion; id: string; state: 'QUEUED' | 'RUNNING' | 'READY' | 'FAILED' | 'EXPIRED';
  createdAt: string; expiresAt: string | null; snapshotId: string | null; snapshotAt: string | null; changeCheckpoint: string | null;
  documentCount: number | null; complete: boolean; failureCode: IntegrationErrorCode | null; manifestSha256: string | null }
export interface IntegrationExportManifestV1 { schemaVersion: 'factuez.integration.export-manifest.v1'; exportId: string; environment: 'BETA'; dataset: 'ISSUED_BUSINESS';
  filters: IntegrationExportRequestV1['filters']; snapshotId: string; snapshotAt: string; changeCheckpoint: string | null; createdAt: string; expiresAt: string;
  documentCount: number; requestedArtifactKinds: IntegrationArtifactKind[]; missingArtifactsPolicy: 'FAIL' | 'REPORT'; complete: boolean;
  coverage: IntegrationPageV1<unknown>['coverage'];
  files: { path: string; sha256: string; byteLength: number; artifactId: string | null; owner: { kind: 'DOCUMENT' | 'BATCH'; id: string } | null; documentIds: string[] }[];
  missingArtifacts: { documentId: string; kind: IntegrationArtifactKind; code: 'ARTIFACT_UNAVAILABLE' | 'SOURCE_NOT_SUPPORTED' | 'INTEGRITY_FAILED' | 'INCOMPLETE_BINDING' }[] }
export interface IntegrationChangeV1 { eventId: string; documentId: string; type: IntegrationDocumentType; issuerRuc: string; environment: 'BETA'; sequence: string;
  kind: 'DOCUMENT_CREATED' | 'DOCUMENT_STATE_CHANGED' | 'ARTIFACT_ADDED' | 'DOCUMENT_RECONCILED'; occurredAt: string; version: string; resource: IntegrationResourceV1 }
export interface IntegrationChangePageV1 { schemaVersion: typeof IntegrationContractVersion; items: IntegrationChangeV1[]; nextCheckpoint: string; hasMore: boolean; expiresAt: string }
export interface IntegrationTokenV1 { access_token: string; token_type: 'Bearer'; expires_in: number; scope: string }
export interface IntegrationErrorV1 { schemaVersion: typeof IntegrationContractVersion; requestId: string; error: { code: IntegrationErrorCode; message: string; retryable: boolean } }
