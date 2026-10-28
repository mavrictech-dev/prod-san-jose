import type { B2bGuideIssueBinding, B2bGuideIssueAction } from '@factuez/contracts/b2b-guide-security';
import type { SupplementActor } from '../application/supplement-actor';
import type { GuideBody, GuideDraft } from './guide-model';
import type { GuideEstablishmentSql } from './guide-establishment-store';

/** Deliberately separate from draft WRITE. Neither draft permission nor an
 * anchor invoice series authorizes consumption of a DESPATCH_ADVICE counter. */
export type GuideIssueBinding = B2bGuideIssueBinding;
export type GuideIssueRequest = {
  schemaVersion: 'factuez.b2b.guide-issue.v1'; binding: GuideIssueBinding;
  draftId: string; expectedRevision: string; idempotencyKey: string;
};
export type GuideIssueProof = {
  capability: 'BETA_GUIDE_ISSUE_LOCAL'; binding: GuideIssueBinding;
  actor: SupplementActor; clientRevision: number; grantRevision: number;
};
export interface GuideIssueAuthority {
  current(token: string, kind: 'SERVICE' | 'USER', binding: GuideIssueBinding, action: B2bGuideIssueAction): Promise<GuideIssueProof>;
}
export type GuideIssueContext = {
  issuer: { ruc: string; legalName: string };
  counter: { id: string; series: string; nextNumber: string; masterRevision: number };
  contextSha256: string;
};
/** Called within the SAME database transaction that reserves the number.
 * Implementations must lock/validate issuer, point, explicit series mapping,
 * establishments and goods. No independent database transaction is acceptable. */
export interface GuideIssueContextResolver {
  prepare(sql: GuideEstablishmentSql, binding: GuideIssueBinding, draft: GuideDraft): Promise<GuideIssueContext>;
}
export type GuideIssuedSnapshot = {
  schemaVersion: 'factuez.guide-issued-local.v1'; documentId: string; operationId: string;
  binding: GuideIssueBinding; draftId: string; draftRevision: number;
  issuer: { ruc: string; legalName: string }; series: string; number: string; fullNumber: string;
  body: GuideBody; bodySha256: string; contextSha256: string; at: string;
  candidateOnly: true; fiscalExecutionEnabled: false; transmissionAuthorized: false;
  authorizedForTransfer: false; officialRulesValidated: false; officialCdrVerified: false;
  numberReserved: true;
};
export type GuideIssueReceipt = {
  id: string; clientId: string; actorKey: string; keySha256: string; requestSha256: string;
  grantRevision: number; actor: NonNullable<SupplementActor['b2b']>;
  snapshot: GuideIssuedSnapshot; snapshotSha256: string;
};
export type GuideIssueScope = {
  binding: GuideIssueBinding; draftId: string; clientId: string; actorKey: string; keySha256: string;
};
export interface GuideIssueTransaction {
  readonly sql: GuideEstablishmentSql;
  prior(): Promise<GuideIssueReceipt | null>;
  operation(id: string): Promise<GuideIssueReceipt | null>;
  draft(): Promise<GuideDraft | null>;
  issuedForDraft(): Promise<boolean>;
  /** Counter CAS + immutable header + ordered items + receipt + dedicated
   * local event. No existing fiscal OutboxEvent is used. */
  commit(receipt: GuideIssueReceipt, context: GuideIssueContext): Promise<void>;
}
export interface GuideIssueStore {
  transaction<T>(scope: GuideIssueScope, work: (tx: GuideIssueTransaction) => Promise<T>): Promise<T>;
}
