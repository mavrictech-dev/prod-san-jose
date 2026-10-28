import type { B2bBinding, B2bPrincipal, B2bIdentityScope } from './email-deliveries.security';
export type { B2bBinding, B2bPrincipal };
export interface EmailDeliveryAccess { token: string; kind: 'USER'|'SERVICE' }
export type EmailDeliveryAction = 'CREATE'|'READ';
export type EmailDeliveryProfile = 'NONE'|'LOCAL_CAPTURE'|'CORPORATE';
export type EmailDeliveryState = 'QUEUED'|'WAITING_ARTIFACTS'|'DISPATCHING'|'CAPTURED_LOCAL'|'SMTP_ACCEPTED'|'UNKNOWN';
export type EmailDeliveryActor = Pick<B2bPrincipal,'kind'|'clientId'|'revision'|'subjectId'|'userAuthRevision'>;
export interface EmailDeliveryCreate {
  binding: B2bBinding; documentId: string; recipient: string; format: 'ticket'|'a4'; idempotencyKey: string;
}
export interface EmailDeliveryRead { id: string }
export interface EmailDeliveryAttachment {
  readonly kind: 'PDF'|'XML'|'CDR'; readonly representation: 'CURRENT_GENERATED'|'IMMUTABLE_ORIGINAL';
  readonly fileName: string; readonly mediaType: 'application/pdf'|'application/xml'|'application/zip';
  readonly bytes: Uint8Array; readonly sha256: string;
  readonly documentId: string; readonly binding: B2bBinding; readonly sourceProofSha256: string;
}
export interface EmailDeliveryDocument {
  readonly binding: B2bBinding; readonly documentId: string; readonly sourceProofSha256: string;
  readonly presentationRevision: string; readonly attachments: readonly EmailDeliveryAttachment[];
}
/** Owner supplies current PDF and untouched XML/CDR with one document proof. Missing CDR stays pending.
 * This port must authorize against current document ownership, never a QA wrapper or fiscal acceptance guess. */
export interface EmailDeliveryDocumentSource {
  authorizeDocumentCurrent(p: B2bPrincipal, binding: B2bBinding, documentId: string,
    format: 'ticket'|'a4'): Promise<EmailDeliveryDocument>;
}
/** Trusted in-process owner capability, never deserialized or exposed by HTTP. No stored bearer. */
export interface EmailDeliveryExecutionAuthority {
  freshIdentity(actor: Readonly<EmailDeliveryActor>, scopes: readonly B2bIdentityScope[]): Promise<B2bPrincipal>;
}
export interface EmailDeliveryAttachmentMetadata {
  kind: 'PDF'|'XML'|'CDR'; fileName: string; mediaType: string; sha256: string; byteLength: number;
  representation: 'CURRENT_GENERATED'|'IMMUTABLE_ORIGINAL'; sourceProofSha256: string;
}
export interface EmailDeliveryJob {
  id: string; actorKey: string; actor: EmailDeliveryActor; binding: B2bBinding; documentId: string;
  recipient: string; format: 'ticket'|'a4'; profile: EmailDeliveryProfile;
  keyHash: string; requestHash: string; revision: number; state: EmailDeliveryState;
  createdAt: string; updatedAt: string; attemptId: string|null; errorCode: 'ARTIFACTS_PENDING'|'CAPTURE_OUTCOME_UNKNOWN'|'SMTP_OUTCOME_UNKNOWN'|null;
  corporate?: EmailDeliveryCorporateAuthorization & {messageId: string};
  attachments: EmailDeliveryAttachmentMetadata[];
}
export interface EmailDeliveryEvent {
  id: string; jobId: string; revision: number; actor: EmailDeliveryActor; at: string;
  type: 'CREATED'|'WAITING_ARTIFACTS'|'ATTEMPT_STARTED'|'CAPTURED_LOCAL'|'SMTP_ACCEPTED'|'UNKNOWN';
  attemptId: string|null;
}
export interface EmailDeliveryTransaction {
  job(id: string): Promise<EmailDeliveryJob|null>;
  prior(actorKey: string, keyHash: string): Promise<EmailDeliveryJob|null>;
  insert(job: EmailDeliveryJob): Promise<void>;
  save(job: EmailDeliveryJob, expectedRevision: number): Promise<void>;
  append(event: EmailDeliveryEvent): Promise<void>;
}
export interface EmailDeliveryStore {
  transaction<T>(locks: readonly string[], work: (tx: EmailDeliveryTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export interface EmailDeliveryCaptureMessage {
  readonly jobId: string; readonly attemptId: string; readonly recipient: string;
  readonly headers: Readonly<Record<string,string>>;
  readonly attachments: readonly EmailDeliveryAttachment[];
}
export interface EmailDeliveryCaptureTransport {
  readonly profile: 'LOCAL_CAPTURE';
  capture(message: EmailDeliveryCaptureMessage): Promise<{state: 'CAPTURED_LOCAL'}>;
}
/** Non-secret, immutable references. Sending and managing SMTP configuration are separate capabilities. */
export interface EmailDeliveryCorporateAuthorization {
  grantId: string; grantRevision: number; configurationRevision: number; configurationSnapshotId: string;
}
export type EmailDeliveryCorporateRequest = Pick<EmailDeliveryJob,'binding'|'documentId'|'recipient'|'format'>;
export interface EmailDeliveryCorporateTransport {
  readonly profile: 'CORPORATE';
  authorizeCurrent(p: B2bPrincipal, request: EmailDeliveryCorporateRequest, document: EmailDeliveryDocument): Promise<EmailDeliveryCorporateAuthorization>;
  send(job: Readonly<EmailDeliveryJob>, document: EmailDeliveryDocument,
    current: () => Promise<B2bPrincipal>): Promise<{state: 'SMTP_ACCEPTED'}>;
}
export interface EmailDeliveryView {
  schemaVersion: 'factuez.b2b.email-deliveries.v1'; environment: 'BETA'; candidateOnly: true;
  id: string; documentId: string; binding: B2bBinding; format: 'ticket'|'a4';
  state: EmailDeliveryState; profile: EmailDeliveryProfile; revision: number;
  createdAt: string; updatedAt: string; errorCode: EmailDeliveryJob['errorCode'];
  attachments: EmailDeliveryAttachmentMetadata[]; deliveredToClient: false; fiscalAuthority: false; replayed: boolean;
}
export interface B2bEmailDeliveriesPort {
  execute(access: EmailDeliveryAccess, action: EmailDeliveryAction, input: unknown): Promise<EmailDeliveryView>;
}

