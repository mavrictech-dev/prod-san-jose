/** Portable wire DTOs, not the PWA or the internal service's domain objects. */
export interface ReceivedScope { environment: 'BETA'; companyId: number; recipientRuc: string; branchId: string }
export type ReceivedDocumentType = '01'|'03'|'07'|'08'|'09'|'20'|'31'|'40';
export interface ReceivedSelection {
  scope: ReceivedScope; from: string; to: string; limit?: number; after?: string; type?: ReceivedDocumentType;
}
export interface ReceivedParty { identityNumber: string|null; identityType: string|null; legalName: string|null; address: string|null }
export interface ReceivedTax { schemeId: string|null; name: string|null; amount: string|null; taxableAmount: string|null; percent: string|null; affectationCode: string|null }
export interface ReceivedItem {
  lineId: string; supplierCode: string|null; sunatCode: string|null; description: string;
  unitCode: string|null; quantity: string|null; unitValue: string|null; unitPrice: string|null; lineExtensionAmount: string|null;
  allowances: { charge: boolean; amount: string|null; reason: string|null }[]; taxes: ReceivedTax[];
}
export interface ReceivedProjection {
  schemaVersion: 'factuez.received-document.v1'; documentType: string; fullNumber: string; series: string; number: string;
  issueDate: string; issueTime: string|null; dueDate: string|null; currencyCode: string|null;
  supplier: ReceivedParty; recipient: ReceivedParty; items: ReceivedItem[];
  totals: { lineExtensionAmount: string|null; taxExclusiveAmount: string|null; taxInclusiveAmount: string|null;
    allowanceTotalAmount: string|null; chargeTotalAmount: string|null; prepaidAmount: string|null; payableAmount: string|null };
  taxes: ReceivedTax[]; paymentTerms: { id: string|null; means: string|null; amount: string|null; dueDate: string|null }[];
  references: { kind: string; number: string|null; documentType: string|null }[]; notes: string[]; warnings: string[];
  xmlSha256: string; signature: { status: 'MISSING'|'PRESENT_UNVERIFIED'; officialTrust: false };
}
export interface ReceivedRow {
  id: string; companyId: number; recipientRuc: string; branchId: string; supplierRuc: string; supplierName: string|null;
  documentType: string; fullNumber: string; issueDate: string; currencyCode: string|null; payableAmount: string|null;
  receivedAt: string; itemCount: number; sunatStatus: 'NOT_CHECKED'; lastVerifiedAt: null;
  registeredAt: string|null; erpReference: string|null; warnings: string[];
}
export type ReceivedArtifactKind = 'XML'|'CDR'|'PROVIDER_PDF';
export interface ReceivedArtifact {
  id: string; kind: ReceivedArtifactKind; fileName: string; mediaType: 'application/xml'|'application/zip'|'application/pdf';
  sha256: string; byteLength: number; representation: 'PROVIDER_ORIGINAL'; signatureTrust: 'NOT_VERIFIED';
}
export interface ReceivedManifest {
  schemaVersion: 'factuez.b2b.received-artifacts.v1'; scope: ReceivedScope; documentId: string;
  items: ReceivedArtifact[]; fiscalAcceptance: 'NOT_VERIFIED';
}
export interface ReceivedDetail {
  schemaVersion: 'factuez.b2b.received-detail.v1'; scope: ReceivedScope; document: ReceivedRow;
  projection: ReceivedProjection; artifacts: ReceivedArtifact[]; fiscalAcceptance: 'NOT_VERIFIED'; source: 'RECEIVED_XML';
}
export interface ReceivedPage {
  schemaVersion: 'factuez.b2b.received-page.v1'; scope: ReceivedScope; items: ReceivedRow[];
  page: { limit: number; hasMore: boolean; nextAfter: string|null; consistency: 'LIVE_KEYSET_NOT_SNAPSHOT' };
  fiscalAcceptance: 'NOT_VERIFIED'; source: 'RECEIVED_XML';
}
export interface B2bCapabilities {
  schemaVersion: 'factuez.b2b.v1'; environment: 'BETA'; fiscalActivation: false; executionReadiness: 'NOT_PROBED';
  features: { id: string; state: 'ENABLED'|'DISABLED'|'NOT_IMPLEMENTED'; reason: string }[];
  receivedCoverage?: { source: 'RECEIVED_XML_ONLY'; unassigned: false; sireOnlyFindings: false; officialTrust: false };
  coverage: { type: string; state: 'SUPPORTED'|'SOURCE_NOT_SUPPORTED' }[];
  originalArtifacts: string[]; localRepresentations: string[];
  limits: { pageSize: number; cutRows: number; cutTtlSeconds: number; dateRangeDays: number };
  legacyExtraction: { separateAudience: true; forwarded: false };
}
export interface ReceivedDownload { artifact: ReceivedArtifact; bytes: Buffer }
export type B2bSdkErrorCode = 'INVALID_CONFIGURATION'|'INVALID_REQUEST'|'TOKEN_UNAVAILABLE'|'TLS_OR_NETWORK_ERROR'|
  'REQUEST_TIMEOUT'|'RESPONSE_TOO_LARGE'|'INVALID_RESPONSE'|'REDIRECT_REFUSED'|'REMOTE_REQUEST_FAILED'|
  'ARTIFACT_NOT_FOUND'|'ARTIFACT_AMBIGUOUS'|'ARTIFACT_CHANGED'|'ARTIFACT_INTEGRITY_FAILED';
/** No remote message, request URL, bearer, response body, PII or error cause is retained. */
export class B2bSdkError extends Error {
  constructor(readonly code: B2bSdkErrorCode, readonly status?: number) { super(code); this.name = 'B2bSdkError'; }
  toJSON() { return { name: this.name, code: this.code, ...(this.status === undefined ? {} : { status: this.status }) }; }
}
