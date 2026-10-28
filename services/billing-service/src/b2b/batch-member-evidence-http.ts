import {request as httpsRequest} from 'node:https';
import {checkServerIdentity,type TLSSocket} from 'node:tls';
import {randomUUID} from 'node:crypto';
import {inspect,types} from 'node:util';
import {fiscalSnapshotSha256 as hash,fiscalTimestamp,validateFiscalOriginal,validateFiscalAcceptance} from '@factuez/sunat-core/dist/fiscal-note';
import {boundedSupplementJson} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import type {BatchMemberEvidencePort} from './batch-member-postgres.types';
type BatchMemberVerifiedEvidence=Awaited<ReturnType<BatchMemberEvidencePort['verifySignedVersion']>>;
// Deliberately service-local wire validation: no shared allowlist or SUNAT implementation import.

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

export interface BatchMemberEvidenceHttpOptions{
 enabled?:boolean;origin:string;sunatPeerSha256:string;tls:{ca:Buffer;cert:Buffer;key:Buffer};now?:()=>string;
}
export class BatchMemberEvidenceHttpError extends Error{
 constructor(readonly code:'BATCH_EVIDENCE_HTTP_UNAVAILABLE'|'BATCH_EVIDENCE_VERSION_MISSING'|'BATCH_EVIDENCE_CATALOGUE_HISTORY_MISSING'='BATCH_EVIDENCE_HTTP_UNAVAILABLE'){
  super(code);this.name='BatchMemberEvidenceHttpError';}
}
const unavailable=():never=>{throw new BatchMemberEvidenceHttpError();};
/** Fixed private mTLS RPC only. The owner chooses the opaque handle; no raw evidence,
 * URL, certificate path, signing material or accepted/complete flag is a method input. */
export class HttpBatchMemberEvidence implements BatchMemberEvidencePort{
 #origin:URL;#tls:BatchMemberEvidenceHttpOptions['tls'];#peer:string;#enabled:boolean;#now:()=>string;
 constructor(options:BatchMemberEvidenceHttpOptions){
  try{
   const u=new URL(options.origin);
   if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash||!/^[a-f0-9]{64}$/.test(options.sunatPeerSha256)||
    [options.tls?.ca,options.tls?.cert,options.tls?.key].some(v=>!Buffer.isBuffer(v)||types.isProxy(v)||!v.length||v.length>128*1024)||
    options.now!==undefined&&typeof options.now!=='function')unavailable();
   this.#origin=u;this.#peer=options.sunatPeerSha256;this.#tls={ca:Buffer.from(options.tls.ca),cert:Buffer.from(options.tls.cert),key:Buffer.from(options.tls.key)};
   this.#enabled=options.enabled===true;this.#now=options.now??(()=>new Date().toISOString());
  }catch{throw new BatchMemberEvidenceHttpError();}
 }
 async verifySignedVersion(ownerHandle:string,asOf:string):Promise<BatchMemberVerifiedEvidence>{
  try{
   if(!this.#enabled)unavailable();
   const body=createBatchEvidenceRequest(ownerHandle,asOf,randomUUID(),this.#now()),data=Buffer.from(JSON.stringify(body));
   const response=await this.exchange(data);
   return verifyBatchEvidenceResponse(response,body,this.#now());
  }catch(e){if(e instanceof BatchMemberEvidenceHttpError)throw new BatchMemberEvidenceHttpError(e.code);return unavailable();}
 }
 async readiness(){
  try{
   if(!this.#enabled)unavailable();
   const q={requestId:randomUUID(),asOf:this.#now()},raw=await this.exchange(Buffer.from(JSON.stringify(q)),'/internal/b2b/batch-member-evidence-status');
   evidenceExact(raw,['schemaVersion','environment','state','supportedDocumentTypes','sourceCapture','noteHistory','requestId','asOf','verifiedAt']);
   evidenceRequire(raw.schemaVersion==='factuez.b2b.batch-member-ledger-status.v1'&&raw.environment==='BETA'&&raw.state==='EXACT_LEDGER_READ_ONLY'&&
    JSON.stringify(raw.supportedDocumentTypes)===JSON.stringify(['01','03'])&&raw.sourceCapture==='NOT_ASSEMBLED'&&raw.noteHistory==='UNAVAILABLE'&&
    raw.requestId===q.requestId&&raw.asOf===q.asOf);
   evidenceFresh(q.asOf,raw.verifiedAt);evidenceFresh(raw.verifiedAt,this.#now());evidenceFresh(q.asOf,this.#now());
   return raw;
  }catch{return unavailable();}
 }
 private exchange(data:Buffer,path:typeof BATCH_MEMBER_EVIDENCE_PATH|'/internal/b2b/batch-member-evidence-status'=BATCH_MEMBER_EVIDENCE_PATH):Promise<unknown>{
  return new Promise((resolve,reject)=>{
   let settled=false;const finish=(error?:BatchMemberEvidenceHttpError,value?:unknown)=>{
    if(settled)return;settled=true;clearTimeout(deadline);
    if(error)reject(error);else resolve(value);
   };
   const req=httpsRequest(new URL(path,this.#origin),{...this.#tls,method:'POST',rejectUnauthorized:true,agent:false,
    minVersion:'TLSv1.2',timeout:15000,maxHeaderSize:8192,
    checkServerIdentity:(hostname,cert)=>checkServerIdentity(hostname,cert)??(cert.fingerprint256?.replace(/:/g,'').toLowerCase()===this.#peer?undefined:Error('SUNAT_PEER_PIN_REQUIRED')),
    headers:{'Content-Type':'application/json','Content-Length':String(data.length),Accept:'application/json'}},res=>{
    const socket=res.socket as TLSSocket,names=res.rawHeaders.filter((_v,i)=>i%2===0).map(n=>n.toLowerCase());
    if(!socket.authorized||socket.getPeerCertificate().fingerprint256?.replace(/:/g,'').toLowerCase()!==this.#peer||
     ![200,409].includes(res.statusCode??0)||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(String(res.headers['content-type']))||
     res.headers['content-encoding']||new Set(names).size!==names.length||
     res.headers['content-length']!==undefined&&(!/^[1-9][0-9]{0,6}$/.test(res.headers['content-length'])||Number(res.headers['content-length'])>batchEvidenceLimits.response)){
     res.resume();finish(new BatchMemberEvidenceHttpError());return;
    }
    let size=0;const chunks:Buffer[]=[];
    res.on('data',chunk=>{size+=chunk.length;if(size>batchEvidenceLimits.response){req.destroy();finish(new BatchMemberEvidenceHttpError());return;}chunks.push(Buffer.from(chunk));});
    res.on('error',()=>finish(new BatchMemberEvidenceHttpError()));res.on('aborted',()=>finish(new BatchMemberEvidenceHttpError()));
    res.on('end',()=>{if(settled)return;try{
     const bytes=Buffer.concat(chunks);if(!res.complete||!Buffer.from(bytes.toString('utf8')).equals(bytes))throw Error();
     const value=JSON.parse(bytes.toString('utf8'));
     if(res.statusCode===409){
      evidenceExact(value,['code']);
      if(value.code!=='BATCH_EVIDENCE_VERSION_MISSING'&&value.code!=='BATCH_EVIDENCE_CATALOGUE_HISTORY_MISSING')throw Error();
      finish(new BatchMemberEvidenceHttpError(value.code));return;
     }
     finish(undefined,value);
    }catch{finish(new BatchMemberEvidenceHttpError());}});
   });
   const deadline=setTimeout(()=>{req.destroy();finish(new BatchMemberEvidenceHttpError());},15000);
   req.on('timeout',()=>req.destroy());req.on('error',()=>finish(new BatchMemberEvidenceHttpError()));req.end(data);
  });
 }
 toJSON(){return {service:'HttpBatchMemberEvidence',enabled:this.#enabled,environment:'BETA'};}
 [inspect.custom](){return this.toJSON();}
}

