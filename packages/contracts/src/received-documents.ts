/** Incoming documents are not sales and never authorize fiscal emission. */
export type ReceivedParty = { identityNumber: string | null; identityType: string | null; legalName: string | null; address: string | null };
export type ReceivedTax = { schemeId: string | null; name: string | null; amount: string | null; taxableAmount: string | null; percent: string | null; affectationCode: string | null };
export type ReceivedItem = {
  lineId: string; supplierCode: string | null; sunatCode: string | null; description: string;
  unitCode: string | null; quantity: string | null; unitValue: string | null; unitPrice: string | null;
  lineExtensionAmount: string | null; allowances: { charge: boolean; amount: string | null; reason: string | null }[];
  taxes: ReceivedTax[];
};
export interface ReceivedDocumentProjectionV1 {
  schemaVersion: 'factuez.received-document.v1';
  documentType: string; fullNumber: string; series: string; number: string; issueDate: string; issueTime: string | null;
  dueDate: string | null; currencyCode: string | null; supplier: ReceivedParty; recipient: ReceivedParty;
  items: ReceivedItem[]; totals: { lineExtensionAmount: string | null; taxExclusiveAmount: string | null; taxInclusiveAmount: string | null;
    allowanceTotalAmount: string | null; chargeTotalAmount: string | null; prepaidAmount: string | null; payableAmount: string | null };
  taxes: ReceivedTax[]; paymentTerms: { id: string | null; means: string | null; amount: string | null; dueDate: string | null }[];
  references: { kind: string; number: string | null; documentType: string | null }[]; notes: string[];
  warnings: string[]; xmlSha256: string;
  signature: { status: 'MISSING' | 'PRESENT_UNVERIFIED'; officialTrust: false };
}
export interface ReceivedDocumentRow {
  id: string; companyId: number; recipientRuc: string; branchId: string | null; supplierRuc: string; supplierName: string | null;
  documentType: string; fullNumber: string; issueDate: string; currencyCode: string | null; payableAmount: string | null;
  receivedAt: string; itemCount: number; sunatStatus: 'NOT_CHECKED'; lastVerifiedAt: null;
  registeredAt: string | null; erpReference: string | null; warnings: string[];
}
export interface ReceivedDocumentDetail extends ReceivedDocumentRow {
  projection: ReceivedDocumentProjectionV1;
  artifacts: { id: string; kind: 'XML' | 'PROVIDER_PDF' | 'CDR'; fileName: string; sha256: string; byteLength: number }[];
}
export interface ReceivedDocumentPage { items: ReceivedDocumentRow[]; page: number; pageSize: number; total: number }
export interface ReceivedUploadResult { results: { fileName: string; outcome: 'IMPORTED' | 'DUPLICATE' | 'REJECTED'; id?: string; message: string }[] }
export interface ReceivedUploadCommand {
  companyId: number; branchId?: string;
  files: { fileName: string; contentBase64: string }[];
}
