import type {ReceivedScope} from './types';
import type {BusinessBinding,WriteOptions} from './phase8-types';

export type HistoryBinding = BusinessBinding;
export interface ReceptionOptions { stepUpHandle?:string }
export interface ReceptionConfigurationOptions { stepUpHandle:string }
export interface ReceptionWriteOptions extends WriteOptions,ReceptionOptions {}
export interface ReceptionConfigurationWriteOptions extends WriteOptions,ReceptionConfigurationOptions {}
export interface ReceptionSettings {
  enabled:boolean; mode:'LOCAL_FIXTURE'|'LIVE_READ_ONLY'; intervalMinutes:number;
  mailbox:{enabled:boolean;host:string;port:993;folder:string;username:string};
  sire:{enabled:boolean;startPeriod:string;clientId:string;solUsername:string};
}
export interface ReceptionConfigurationSave {
  expectedRevision:number; settings:ReceptionSettings;
  credentials?:{mailPassword?:string;sireClientSecret?:string;solPassword?:string};
}
interface ReceptionEnvelope {
  schemaVersion:'factuez.b2b.received-automation.v1';scope:ReceivedScope;
  runtimeEnabled:false;fiscalAcceptance:'NOT_VERIFIED';
}
export interface ReceptionConfiguration extends ReceptionEnvelope {
  action:'CONFIG_READ'|'CONFIG_SAVE';revision:number;updatedAt:string|null;settings:ReceptionSettings;
  credentialPresence:{mailPassword:boolean;sireClientSecret:boolean;solPassword:boolean};
  state:'DISABLED'|'STAGED_LOCAL'|'STAGED_READ_ONLY'|'WAITING_TI';networkProfile:'LOCAL_ONLY'|'LIVE_READ_ONLY';
}
export interface ReceptionSyncCreate {source:'MAIL'|'SIRE'|'ALL';expectedRevision:number}
export interface ReceptionSyncCreated extends ReceptionEnvelope {
  action:'SYNC_CREATE';mode:ReceptionSettings['mode'];networkProfile:'LOCAL_ONLY'|'LIVE_READ_ONLY';
  items:{runId:string;source:'MAIL'|'SIRE';status:'QUEUED';revision:number;dispatch:'NOT_DISPATCHED'}[];
}
export interface ReceptionSyncResponse extends ReceptionEnvelope {
  action:'SYNC_READ';run:{runId:string;source:'MAIL'|'SIRE';status:'QUEUED'|'RUNNING'|'COMPLETED'|'FAILED'|'BLOCKED';
    revision:number;startedAt:string|null;finishedAt:string|null;
    counters:{detected:number;imported:number;duplicate:number;rejected:number;xmlPending:number;matches:number;mismatches:number};
    errorCode:'CONFIGURATION_CHANGED'|'CONNECTION_NOT_READY'|'CONNECTION_OR_SCOPE_CHANGED'|'CONNECTOR_UNAVAILABLE'|'SYNC_FAILED'|null};
}
export const HistoricalArtifactKinds=Object.freeze(['UNSIGNED_XML','SIGNED_XML','SUBMISSION_ZIP','CDR_XML','CDR_ZIP','PDF_TICKET_80MM','PDF_A4','DELIVERY_ZIP'] as const);
export type HistoricalArtifactKind=typeof HistoricalArtifactKinds[number];
export interface HistoricalArtifact {kind:HistoricalArtifactKind;originalName:string;sha256:string;sizeBytes:number}
export interface HistoryQuery {take?:number;afterRecordId?:string}
export interface HistoryPolicy {
  candidateOnly:true;fiscalAuthority:false;cdrAuthenticityVerified:false;
  transmission:false;countersChanged:false;disposition:'QUARANTINED';
}
export interface HistoryResponse<T> {
  schemaVersion:'factuez.b2b.history.v1';environment:'BETA';datasetClass:'SYNTHETIC';
  candidateOnly:true;readOnly:true;fiscalAuthority:false;cdrAuthenticityVerified:false;data:T;
}
export interface HistoricalRow extends HistoryPolicy {
  recordId:string;snapshotSha256:string;issuerRuc:string;companyId:number;branchId:string;
  fullNumber:string;customer:string;issueDate:string;currencyCode:'PEN'|'USD';payableAmount:string;
}
export type HistoricalAmounts=Record<'taxableAmount'|'exemptAmount'|'unaffectedAmount'|'freeAmount'|'discountTotal'|'igvAmount'|'iscAmount'|'otherTaxesAmount'|'payableAmount',string>;
export interface HistoricalDocumentSnapshot {
  schemaVersion:'factuez.history-document.v1';environment:'BETA';originSystem:'RESTOAPP';originId:string;sourceDocumentId:string;
  ownership:{mappingId:string;issuerRuc:string;companyId:number;branchId:string;emissionPointId:string;seriesCounterId:string;documentTypeCode:'01'|'03';series:string};
  number:string;issueDate:string;currencyCode:'PEN'|'USD';operationTypeCode:string;
  issuer:{ruc:string;legalName:string;tradeName:string|null;address:string;ubigeo:string;establishmentCode:string};
  customer:{identityType:string;identityNumber:string;legalName:string;address:string|null;email:string|null};
  items:{lineNumber:number;productCode:string|null;description:string;unitCode:string;quantity:string;unitValue:string;unitPriceWithTax:string;taxAffectationCode:string;igvRate:string;amounts:HistoricalAmounts}[];
  tax:{taxSchemeId:string;taxName:string;taxableAmount:string;taxAmount:string}[];amounts:HistoricalAmounts;
  paymentTerms:{type:'CONTADO'}|{type:'CREDITO';currencyCode:'PEN'|'USD';pendingAmount:string;installments:{amount:string;dueDate:string}[]};
  reference:null;vehiclePlate:string|null;amountInWords:string|null;observations:string|null;
  sourceEvidence:{declaredStatus:'NOT_DECLARED'|'DECLARED_ACCEPTED'|'DECLARED_REJECTED'|'DECLARED_VOIDED';responseCode:string|null;description:string|null;authenticity:'NOT_VERIFIED'};
  artifacts:HistoricalArtifact[];
}
export interface HistoricalDetail extends HistoryPolicy {recordId:string;snapshotSha256:string;snapshot:HistoricalDocumentSnapshot}
export type HistoryPage=HistoryResponse<{items:HistoricalRow[];nextCursor:string|null}>;
export type HistoricalDocument=HistoryResponse<HistoricalDetail>;
export interface HistoricalDownload {artifact:HistoricalArtifact;bytes:Buffer}
export interface DocumentEmailRequest {recipient:string;format:'ticket'|'a4'}
export interface EmailAttachmentMetadata {
  kind:'PDF'|'XML'|'CDR';fileName:string;mediaType:'application/pdf'|'application/xml'|'application/zip';
  sha256:string;byteLength:number;representation:'CURRENT_GENERATED'|'IMMUTABLE_ORIGINAL';sourceProofSha256:string;
}
interface EmailDeliveryEnvelope {
  schemaVersion:'factuez.b2b.email-deliveries.v1';environment:'BETA';candidateOnly:true;
  id:string;documentId:string;binding:BusinessBinding;format:'ticket'|'a4';
  revision:number;createdAt:string;updatedAt:string;
  attachments:EmailAttachmentMetadata[];deliveredToClient:false;fiscalAuthority:false;replayed:boolean;
}
/** SMTP acceptance is not proof of delivery. NONE has no dispatch or terminal outcome. */
export type EmailDelivery = EmailDeliveryEnvelope & (
  | {profile:'NONE'|'LOCAL_CAPTURE'|'CORPORATE';state:'QUEUED';errorCode:null}
  | {profile:'NONE'|'LOCAL_CAPTURE'|'CORPORATE';state:'WAITING_ARTIFACTS';errorCode:'ARTIFACTS_PENDING'}
  | {profile:'LOCAL_CAPTURE'|'CORPORATE';state:'DISPATCHING';errorCode:null}
  | {profile:'LOCAL_CAPTURE';state:'CAPTURED_LOCAL';errorCode:null}
  | {profile:'LOCAL_CAPTURE';state:'UNKNOWN';errorCode:'CAPTURE_OUTCOME_UNKNOWN'}
  | {profile:'CORPORATE';state:'SMTP_ACCEPTED';errorCode:null}
  | {profile:'CORPORATE';state:'UNKNOWN';errorCode:'SMTP_OUTCOME_UNKNOWN'}
);
