import type { IntegrationDocumentDetailV1, IntegrationDocumentFiltersV1, IntegrationPageV1,
  IntegrationExportRequestV1, IntegrationExportManifestV1, IntegrationArtifactV1, IntegrationErrorCode } from '@factuez/contracts/integration';
export const ExportQuotas = { documents: 10000, captureBytes: 16*1024*1024, packageBytes: 64*1024*1024,
  encryptedBytes: 96*1024*1024, totalBytes: 256*1024*1024, activeClientExports: 2, activeClientCuts: 8,
  activeRecords: 64, associations: 100000, captureTtlMs: 300000, leaseMs: 60000 } as const;
export type Coverage = IntegrationPageV1<unknown>['coverage'];
export interface Binding {id:string;branchId:string|null;pointId:string|null;seriesCounterId:string|null;type:string;snapshotSha256:string|null}
export interface CapturedSnapshot {documents:IntegrationDocumentDetailV1[];snapshotAt:string;coverage:Coverage;changeBarrier?:{epoch:string;sequence:string}}
export interface ExportPayload extends CapturedSnapshot {
  filters:IntegrationDocumentFiltersV1; request:IntegrationExportRequestV1|null; snapshotId:string;
  changeCheckpoint?:string|null;
  bindings:Binding[]; batches:{id:string;identitySha256:string;documentIds:string[]}[];
  artifacts:{metadata:IntegrationArtifactV1;bytesBase64:string;documentIds:string[]}[];
  missingArtifacts:IntegrationExportManifestV1['missingArtifacts']; manifest?:IntegrationExportManifestV1;
}
export interface ExportRecord {
  id:string;kind:'CUT'|'EXPORT';clientId:string;contextSha256:string;issuerRuc:string;
  keyHash:string|null;requestSha256:string|null;createdAt:string;expiresAt:string;
  state:'CAPTURING'|'QUEUED'|'RUNNING'|'READY'|'FAILED'|'EXPIRED';
  payload:Buffer|null;content:Buffer|null;contentSha256:string|null;manifestSha256:string|null;
  failureCode:IntegrationErrorCode|null;lease:string|null;
}
/** Own technical database only. All business snapshots and package bytes are encrypted. */
export interface ExportStore {
  reserve(record:ExportRecord):Promise<{record:ExportRecord;created:boolean}>;
  get(id:string,clientId:string,includeContent?:boolean):Promise<ExportRecord|null>;
  byKey(clientId:string,keyHash:string):Promise<ExportRecord|null>;
  captured(id:string,payload:Buffer,state:'QUEUED'|'READY'):Promise<void>;
  fail(id:string,code:IntegrationErrorCode,lease?:string):Promise<void>;
  claim(now:string):Promise<ExportRecord|null>;
  ready(id:string,lease:string,payload:Buffer,content:Buffer,contentSha256:string,manifestSha256:string,expiresAt:string):Promise<void>;
  audit(event:{clientId:string;revision:number;recordId:string;operation:string;sha256:string|null;byteLength:number|null}):Promise<void>;
  sweep(now:string):Promise<void>;
}
export interface OwnerHttp {
  json<T>(path:string,token:string,body?:unknown):Promise<T>;
  bytes(path:string,token:string,maximum?:number,body?:unknown):Promise<{bytes:Buffer;headers:Record<string,unknown>}>;
}
