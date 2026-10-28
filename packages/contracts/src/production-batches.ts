import type { FiscalDocumentSnapshot } from './events';
/** Independent production profile. Public commands contain owner IDs, never evidence/hashes. */
export const PRODUCTION_BATCHES_PROFILE = 'RC03-RA01-PEN-IGV18-v1';
export const PRODUCTION_BATCHES_REQUEST_QUEUE = 'billing-production-batches-v1';
export const PRODUCTION_BATCHES_STATUS_QUEUE = 'sunat-production-batches-status-v1';
export type ProductionBatchesCondition = '1' | '2' | '3';
export type ProductionBatchesCommand = { kind: 'RC' | 'RA'; entries: {
  documentId: string; conditionCode?: ProductionBatchesCondition; declarationId?: string;
}[] };
export type ProductionBatchesDeclaration = {
  id: string; documentId: string; snapshotSha256: string; issuerRuc: string;
  actorId: string; assertedAt: string; reason: string; status: 'NOT_DELIVERED';
};
export type ProductionBatchesAcceptance = {
  documentId: string; snapshotSha256: string; issuerRuc: string; acceptedAt: string;
  cdrZipSha256: string; cdrXmlSha256: string; requestXmlSha256: string;
  reference: string; source: 'INDIVIDUAL_RC' | 'BATCH_RC' | 'DOCUMENT';
};
export type ProductionBatchesEntry = {
  snapshot: FiscalDocumentSnapshot; conditionCode?: ProductionBatchesCondition;
  previous?: { snapshot: FiscalDocumentSnapshot; acceptance: ProductionBatchesAcceptance };
  acceptance?: ProductionBatchesAcceptance; declaration?: ProductionBatchesDeclaration;
  pendingRoute?: { documentId: string; token: string; transmissionStarted: false };
};
export type ProductionBatchesSnapshot = {
  environment: 'PRODUCTION'; profile: typeof PRODUCTION_BATCHES_PROFILE;
  batchId: string; identifier: string; kind: 'RC' | 'RA'; companyId: number;
  issuerRuc: string; currencyCode: 'PEN'; issueDate: string; referenceDate: string;
  entries: ProductionBatchesEntry[];
};
export type ProductionBatchesProof = { bodySha256: string; signature: string };
export type ProductionBatchesIssued = {
  eventId: string; eventName: 'billing.production.batches.issued.v1'; occurredAt: string;
  actorId: string; operationId: string; snapshot: ProductionBatchesSnapshot; ownerProof: ProductionBatchesProof;
};
export type ProductionBatchesState = 'QUEUED' | 'PREPARED' | 'SENDING' | 'SUBMITTED' | 'ACCEPTED' | 'REJECTED' | 'UNKNOWN' | 'BLOCKED';
export type ProductionBatchesStatus = {
  eventId: string; eventName: 'sunat.production.batches.status.v1'; batchId: string;
  snapshotSha256: string; issuerRuc: string; status: ProductionBatchesState;
  responseCode?: string; cdrZipSha256?: string;
  members: { documentId: string; snapshotSha256: string; conditionCode?: ProductionBatchesCondition }[];
  ownerProof: ProductionBatchesProof;
};
