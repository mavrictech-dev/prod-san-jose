import type { ReceivedScope } from './types';
export interface BusinessBinding {
  issuerId:number; issuerRuc:string; environment:'BETA'; branchId:string; pointId:string; seriesId:string; documentType:'01'|'03';
}
export interface BusinessQuery { limit?:number; after?:string; q?:string }
export interface CustomerBody { identityType:'1'|'4'|'6'|'7'|'A'; identityNumber:string; legalName:string; address:string|null; email:string|null; active:boolean }
export interface ProductBody { sku:string; description:string; category:string; unitCode:string; taxAffectationCode:string; defaultUnitPrice:string|null; active:boolean }
export interface Versioned { id:string; revision:number; createdAt:string; updatedAt:string }
export interface BusinessCustomer extends CustomerBody,Versioned { issuerId:number; issuerRuc:string; environment:'BETA' }
export interface BusinessProduct extends ProductBody,Versioned {}
export interface BusinessActor { kind:'SERVICE'|'USER'; clientId:string; revision:number; subjectId:string|null; userAuthRevision:number|null }
export interface BusinessShift extends Versioned {
  binding:BusinessBinding; actorKey:string; actor:BusinessActor; state:'OPEN'|'CLOSED'; currency:'PEN'|'USD';
  openingAmount:string; balance:string; countedAmount:string|null; difference:string|null; closedAt:string|null;
}
export interface BusinessSummary {
  customers:string; activeCustomers:string; sharedProducts:string; actorPointShifts:string; actorPointOpenShifts:string;
  cash:{currency:'PEN'|'USD';incoming:string;outgoing:string}[];
}
export interface BusinessResponse<T> {
  schemaVersion:'factuez.b2b.business.v1'; environment:'BETA'; binding:BusinessBinding; candidateOnly:true; fiscalAuthority:false;
  data:T; operationId:string|null; replayed:boolean; nextCursor?:string|null;
}
export interface WriteOptions { idempotencyKey:string }
export interface RevisionWriteOptions extends WriteOptions { expectedRevision:number }
export interface OpenShiftBody { openingAmount:string; currency:'PEN'|'USD' }
export interface CloseShiftBody { countedAmount:string; reason:string }
export interface CashMovementBody { direction:'IN'|'OUT'; amount:string; reason:string }
/** Exactly the public JSON upload; decoded bytes are bounded to 64 KiB. */
export interface ReceivedUpload { fileName:string; contentBase64:string }
export interface ReceivedAttachment { kind:'CDR'|'PROVIDER_PDF'; file:ReceivedUpload }
export interface ReceivedAssignment { targetBranchId:string; expectedXmlSha256:string }
export interface ReceivedRegistration { registeredAt:string|null; erpReference:string|null; expectedErpReference:string|null }
export interface ReceivedCommandResponse<A extends 'IMPORT'|'ATTACH'|'ASSIGN'|'REGISTER'> {
  schemaVersion:'factuez.b2b.received-command.v1'; scope:ReceivedScope; action:A;
  result:{documentId:string; fiscalAcceptance:'NOT_VERIFIED'; outcome:A extends 'IMPORT'?'IMPORTED'|'DUPLICATE':A extends 'ATTACH'?'ATTACHED':A extends 'ASSIGN'?'ASSIGNED':'REGISTERED'} & (A extends 'ASSIGN'?{branchId:string}:{});
}
export type ReportDocumentType='01'|'03'|'07'|'08'|'09'|'31'|'NV';
export interface ReportFilters {
  issuerId:number; issuerRuc?:string; environment:'BETA'; from:string; to:string; types?:ReportDocumentType[]; branchId?:string; pointId?:string; seriesId?:string;
}
export interface NormalizedReportFilters extends ReportFilters { types:ReportDocumentType[] }
export type ReportFormat='CSV'|'XLSX'|'PDF';
export interface ReportContent { sha256:string; mediaType:string; fileName:string; sizeBytes:number }
export interface ReportJob {
  id:string; state:'QUEUED'|'READY'; revision:number; format:ReportFormat; createdAt:string; capturedAt:string; captureSha256:string; count:number; content:ReportContent|null; types?:ReportDocumentType[];
}
export interface ReportDashboard {
  capturedAt:string; captureSha256:string; filters:NormalizedReportFilters; count:number;
  groups:{currency:'PEN'|'USD';type:ReportDocumentType;local:'ISSUED'|'CANCELLED'|'COMPLETED'|'CONVERTED';count:number;payableAmount:string;taxableAmount:string|null;igvAmount:string|null;missingTaxableCount:number;missingIgvCount:number}[];
  coverage?:{type:ReportDocumentType;representations:ReportFormat[];dataParity:string;financialContribution:string;authorization:string;
    metadataCapability:string;metadataProvidesReportRows:false;finalFiscalParity:false;fiscalAcceptance:'NOT_ASSERTED';authorizedForTransfer:false;
    sourceActivation:string;metadataCaptured:boolean;source:string;consistency:'OWNER_CAPTURE_NOT_A_CROSS_SOURCE_TRANSACTION'}[];
  netSales?:{currency:'PEN'|'USD';payableAmount:string}[];
  transfers?:{type:'09'|'31';id:string;grossWeight:string;weightUnit:'KGM'|'TNE';quantities:{unitCode:string;quantity:string}[]}[];
}
export interface ReportResponse<T> {
  schemaVersion:'factuez.b2b.reports.v1'; environment:'BETA'; source:'BILLING_01_03'|'BILLING_OWNER_SOURCES'; candidateOnly:true; fiscalAuthority:false; data:T;
}
export interface ReportCreated extends ReportResponse<ReportJob> { replayed:boolean }
export interface ReportDownload { report:ReportJob; bytes:Buffer }
export const AdminScopes = Object.freeze([
  'b2b:context:read','b2b:catalog:read','b2b:documents:read','b2b:artifacts:read','b2b:exports:create','b2b:exports:read','b2b:changes:read',
  'b2b:drafts:write','b2b:operations:read','b2b:documents:issue','b2b:webhooks:read','b2b:webhooks:manage','b2b:sales-notes:read','b2b:sales-notes:write',
  'b2b:corrections:read','b2b:corrections:write','b2b:guides:read','b2b:guides:write','b2b:guide-operations:read','b2b:guides:issue','b2b:batches:read','b2b:batches:write',
  'b2b:received:read','b2b:received:artifacts:read','b2b:customers:read','b2b:customers:write','b2b:products:read','b2b:products:write',
  'b2b:shifts:read','b2b:shifts:write','b2b:cash:write','b2b:received:write','b2b:received:sync','b2b:received:configure',
  'b2b:reports:read','b2b:reports:export','b2b:history:read','b2b:masters:manage','b2b:identity:manage','b2b:branding:manage',
  'b2b:fiscal-config:read','b2b:fiscal-config:write','b2b:email:send','b2b:email:read','b2b:mail-config:manage'
] as const);
export type AdminScope=typeof AdminScopes[number];
export interface ApplicationCreate { label:string; kind:'SERVICE'|'USER'; oidcClientId?:string; scopes:AdminScope[]; bindings:BusinessBinding[] }
export interface ApplicationUpdate { expectedRevision:number; label?:string; enabled?:boolean; scopes?:AdminScope[]; bindings?:BusinessBinding[] }
export interface ApplicationMetadata { id:string; label:string; kind:'SERVICE'|'USER'; enabled:boolean; revision:number; oidcClientId:string|null; scopes:AdminScope[]; bindings:BusinessBinding[] }
export interface AdminResponse { schemaVersion:'factuez.b2b.v1'; source:'SOURCE'; environment:'BETA'; candidateOnly:true; application:ApplicationMetadata }
/** Secret only occurs on an explicit SERVICE create/rotate response. The SDK never retains it. */
export interface AdminSecretResponse extends AdminResponse { clientSecret?:string }
export interface ApplicationPage { schemaVersion:'factuez.b2b.v1'; source:'SOURCE'; environment:'BETA'; candidateOnly:true; items:ApplicationMetadata[]; nextAfter:string|null }
