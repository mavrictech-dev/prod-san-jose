import {types} from 'node:util';
import {fiscalSnapshotSha256 as hash,fiscalTimestamp,validateFiscalOriginal,validateFiscalAcceptance} from '@factuez/sunat-core/dist/fiscal-note';
import {boundedSupplementJson} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import type {BatchMemberVerifiedEvidence} from '../application/batch-member-evidence';

const HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const BATCH_MEMBER_EVIDENCE_PATH='/internal/b2b/batch-member-evidence';
export const batchEvidenceLimits=Object.freeze({request:2048,response:256*1024,freshMs:30000});
const REQUEST='factuez.b2b.batch-member-evidence.request.v1',RESPONSE='factuez.b2b.batch-member-evidence.response.v1';
export function evidenceRequire(ok:unknown):asserts ok{if(!ok)throw Error('BATCH_EVIDENCE_PROTOCOL_INVALID');}
export function evidenceExact(value:unknown,keys:string[]):asserts value is Record<string,any>{
 evidenceRequire(!!value&&typeof value==='object'&&!Array.isArray(value)&&!types.isProxy(value)&&Object.getPrototypeOf(value)===Object.prototype);
 evidenceRequire(Reflect.ownKeys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k))&&
  Object.values(Object.getOwnPropertyDescriptors(value)).every(d=>d.enumerable&&'value'in d));
}
export function evidenceTime(value:unknown):number{
 evidenceRequire(typeof value==='string');fiscalTimestamp(value,'evidence.time');return Date.parse(value);
}
export function evidenceFresh(asOf:string,now:string){const age=evidenceTime(now)-evidenceTime(asOf);evidenceRequire(age>=0&&age<=batchEvidenceLimits.freshMs);}
export function evidenceHandle(value:unknown):asserts value is string{evidenceRequire(typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value));}
export type BatchEvidenceRequest={schemaVersion:typeof REQUEST;environment:'BETA';requestId:string;ownerHandle:string;asOf:string;requestSha256:string};
export function batchEvidenceRequest(input:unknown,now:string):BatchEvidenceRequest{
 evidenceExact(input,['schemaVersion','environment','requestId','ownerHandle','asOf','requestSha256']);
 evidenceRequire(input.schemaVersion===REQUEST&&input.environment==='BETA'&&typeof input.requestId==='string'&&UUID.test(input.requestId));
 evidenceHandle(input.ownerHandle);evidenceFresh(input.asOf,now);
 const {requestSha256,...body}=input;evidenceRequire(HASH.test(requestSha256)&&hash(body)===requestSha256&&Buffer.byteLength(JSON.stringify(input))<=batchEvidenceLimits.request);
 return boundedSupplementJson(input) as BatchEvidenceRequest;
}
export function createBatchEvidenceRequest(ownerHandle:string,asOf:string,requestId:string,now:string):BatchEvidenceRequest{
 const body={schemaVersion:REQUEST,environment:'BETA',requestId,ownerHandle,asOf};
 return batchEvidenceRequest({...body,requestSha256:hash(body)},now);
}
function exactVersion(v:unknown){
 evidenceExact(v,['documentId','version','snapshotSha256']);
 evidenceRequire(typeof v.documentId==='string'&&UUID.test(v.documentId)&&Number.isSafeInteger(v.version)&&v.version>0&&HASH.test(v.snapshotSha256));
}
export function batchEvidenceValue(input:unknown,asOf:string):BatchMemberVerifiedEvidence{
 evidenceExact(input,['binding','snapshot','acceptance','notDelivered','original','provenance']);
 evidenceRequire(Buffer.byteLength(JSON.stringify(input))<=batchEvidenceLimits.response);
 const value=boundedSupplementJson(input) as BatchMemberVerifiedEvidence,b=value.binding,s=value.snapshot,p=value.provenance;
 evidenceExact(b,['environment','issuerRuc','companyId','branchId','pointId','seriesId','series','documentType']);
 evidenceRequire(b.environment==='BETA'&&typeof b.issuerRuc==='string'&&/^\d{11}$/.test(b.issuerRuc)&&Number.isSafeInteger(b.companyId)&&b.companyId>0&&
  [b.branchId,b.pointId,b.seriesId].every(v=>typeof v==='string'&&UUID.test(v))&&typeof b.series==='string'&&/^[BF][A-Z0-9]{3}$/.test(b.series)&&['01','03','07','08'].includes(b.documentType));
 evidenceRequire(!!s&&typeof s==='object'&&typeof s.documentId==='string'&&UUID.test(s.documentId)&&s.environment===b.environment&&s.companyId===b.companyId&&s.branchId===b.branchId&&
  s.issuer?.identityNumber===b.issuerRuc&&s.series===b.series&&s.documentTypeCode===b.documentType&&evidenceTime(s.issueDate)<=evidenceTime(asOf));
 if(b.documentType==='01'||b.documentType==='03'){validateFiscalOriginal(s as Parameters<typeof validateFiscalOriginal>[0],asOf);evidenceRequire(value.original===null);}
 else{exactVersion(value.original);evidenceRequire(value.original!.documentId!==s.documentId);}
 evidenceExact(p,['verifierId','artifactId','verifiedAt','signedXmlSha256','cdrSha256','catalogueSha256']);
 evidenceRequire(p.verifierId==='sunat.batch-member-evidence.v1'&&typeof p.artifactId==='string'&&UUID.test(p.artifactId)&&
  p.verifiedAt===asOf&&HASH.test(p.signedXmlSha256)&&HASH.test(p.catalogueSha256));
 if(value.acceptance!==null){
  const a=value.acceptance;evidenceExact(a,['environment','issuerRuc','documentId','documentTypeCode','fullNumber','snapshotSha256','cdrSha256','status','responseCode','acceptedAt','source']);
  validateFiscalAcceptance(s,a,asOf);evidenceRequire(HASH.test(p.cdrSha256??'')&&a.cdrSha256===p.cdrSha256);
  if(a.source.kind==='CDR_DOCUMENT'){evidenceExact(a.source,['kind']);evidenceRequire(b.series.startsWith('F'));}
  else{evidenceExact(a.source,['kind','identifier','referenceDate','lineNumber','conditionCode']);evidenceRequire(a.source.kind==='CDR_SUMMARY'&&b.series.startsWith('B'));}
 }else evidenceRequire(p.cdrSha256===null);
 if(value.notDelivered!==null){const n=value.notDelivered;evidenceExact(n,['status','documentId','documentTypeCode','fullNumber','issuerRuc','snapshotSha256','evidenceId','assertedAt']);
  evidenceRequire(n.status==='NOT_DELIVERED'&&n.documentId===s.documentId&&n.documentTypeCode===b.documentType&&n.fullNumber===s.fullNumber&&
   n.issuerRuc===b.issuerRuc&&n.snapshotSha256===hash(s)&&typeof n.evidenceId==='string'&&UUID.test(n.evidenceId)&&evidenceTime(n.assertedAt)>=evidenceTime(s.issueDate)&&evidenceTime(n.assertedAt)<=evidenceTime(asOf));}
 if(value.original===null)evidenceRequire(p.catalogueSha256===hash([]));
 return value;
}
export function batchEvidenceResponse(request:BatchEvidenceRequest,evidence:unknown,verifiedAt:string){
 evidenceFresh(request.asOf,verifiedAt);
 const result={schemaVersion:RESPONSE,environment:'BETA',requestId:request.requestId,ownerHandle:request.ownerHandle,asOf:request.asOf,
  requestSha256:request.requestSha256,verifiedAt,evidence:batchEvidenceValue(evidence,request.asOf)};
 evidenceRequire(Buffer.byteLength(JSON.stringify(result))<=batchEvidenceLimits.response);return result;
}
export function verifyBatchEvidenceResponse(raw:unknown,request:BatchEvidenceRequest,now:string):BatchMemberVerifiedEvidence{
 evidenceExact(raw,['schemaVersion','environment','requestId','ownerHandle','asOf','requestSha256','verifiedAt','evidence']);
 evidenceRequire(raw.schemaVersion===RESPONSE&&raw.environment==='BETA'&&raw.requestId===request.requestId&&raw.ownerHandle===request.ownerHandle&&
  raw.asOf===request.asOf&&raw.requestSha256===request.requestSha256&&Buffer.byteLength(JSON.stringify(raw))<=batchEvidenceLimits.response);
 evidenceFresh(request.asOf,now);evidenceFresh(request.asOf,raw.verifiedAt);evidenceFresh(raw.verifiedAt,now);
 return batchEvidenceValue(raw.evidence,request.asOf);
}

