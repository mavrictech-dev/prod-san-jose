import type { ReportGuideMetadata } from './guide-metadata-http';
import type { B2bBinding, B2bPrincipal } from '@factuez/contracts/b2b-security';
import type { ReportsAccess } from './source-types';
export type ReportsDocumentType='01'|'03'|'07'|'08'|'09'|'31'|'NV';
export interface ReportsFilters {issuerId:number;issuerRuc?:string;environment:'BETA';from:string;to:string;types:ReportsDocumentType[];branchId?:string;pointId?:string;seriesId?:string}
export type ReportsAction = 'DASHBOARD'|'CREATE'|'READ'|'CONTENT';
export type ReportsFormat = 'CSV'|'XLSX'|'PDF';
export type ReportsAuth = {token:string;kind:'SERVICE'|'USER'};
export interface ReportsFiltersInput {
  issuerId:string;environment:'BETA';from:string;to:string;types?:string;issuerRuc?:string;
  branchId?:string;pointId?:string;seriesId?:string;
}
export interface ReportsInputMap {
  DASHBOARD:{filters:ReportsFiltersInput};
  CREATE:{filters:ReportsFiltersInput;format:ReportsFormat;idempotencyKey:string};
  READ:{id:string};
  CONTENT:{id:string};
}
export interface ReportsCapturePort {execute(token:string,kind:'SERVICE'|'USER',action:string,input:unknown):Promise<unknown>}
export interface ReportRow {
  id:string;context:B2bBinding;snapshotSha256:string;resourceVersion:string;issuedAt:string;issueDate:string;
  type:ReportsDocumentType;fullNumber:string;currency:'PEN'|'USD'|null;local:'ISSUED'|'CANCELLED'|'LOCAL_NUMBERED'|'COMPLETED'|'CONVERTED';
  payableAmount:string|null;taxableAmount:string|null;igvAmount:string|null;
  guideMetadata?:ReportGuideMetadata;accessKey?:string;referenceDocumentId?:string;convertedDocumentId?:string|null;
  transfer?:{grossWeight:string;weightUnit:'KGM'|'TNE';quantities:{unitCode:string;quantity:string}[]};
}
export interface ReportsCapture {capturedAt:string;filters:ReportsFilters;bindings:B2bBinding[];rows:ReportRow[];sha256:string;access?:ReportsAccess[]}
export interface ReportFileMetadata {sha256:string;mediaType:string;fileName:string;sizeBytes:number}
export interface ReportFile extends ReportFileMetadata {bytes:Buffer}
export interface ReportJob {
  id:string;ownerKey:string;keyHash:string;requestHash:string;actor:Pick<B2bPrincipal,'kind'|'clientId'|'subjectId'|'revision'|'userAuthRevision'>;
  state:'QUEUED'|'READY';revision:number;format:ReportsFormat;createdAt:string;capture:ReportsCapture;content:ReportFileMetadata|null;
  /** Private retention tombstone; never exposed before current authorization. */
  contentPurgedAt?:string;
}
export interface ReportsTransaction {
  prior(ownerKey:string,keyHash:string):Promise<ReportJob|null>;
  get(ownerKey:string,id:string):Promise<ReportJob|null>;
  insert(job:ReportJob):Promise<void>;
  complete(ownerKey:string,id:string,expectedRevision:number,content:ReportFile):Promise<boolean>;
  content(ownerKey:string,id:string):Promise<ReportFile|null>;
}
export interface ReportsStore {transaction<T>(lockKey:string,work:(tx:ReportsTransaction)=>Promise<T>):Promise<T>}
export type ReportRenderer = (capture:ReportsCapture)=>Promise<{bytes:Buffer;mediaType:string}>;
export type ReportsRenderers = Partial<Record<ReportsFormat,ReportRenderer>>;
export interface ReportsPgConnection {
  query<T=Record<string,unknown>>(sql:string,values?:unknown[]):Promise<{rows:T[];rowCount:number|null}>;
  release(error?:Error):void;
}
export interface ReportsPgPool {connect():Promise<ReportsPgConnection>}

