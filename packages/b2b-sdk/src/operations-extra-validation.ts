import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
import * as w from './validation';
import * as p from './phase8-validation';
import {HistoricalArtifactKinds,type HistoricalArtifactKind,type HistoryQuery,type HistoryPage,type HistoricalDocument,type ReceptionConfiguration,type ReceptionSyncCreated,type ReceptionSyncResponse,type EmailDelivery} from './operations-extra-types';
import type {BusinessBinding} from './phase8-types';
import type {ReceivedScope} from './types';
import {input,data,equal,fields,id,key,integer,binding,bindingQuery} from './phase8-validation';
export {input,data,equal,fields,id,key,integer,binding,bindingQuery};
export function fail(code:Parameters<typeof p.fail>[0]='INVALID_RESPONSE'):never{return p.fail(code);}
function exact(v:unknown,keys:readonly string[]):asserts v is Record<string,any>{p.fields(v,keys);}
const choice=(v:unknown,values:readonly unknown[])=>{if(!values.includes(v))fail();};
const bool=(v:unknown)=>{if(typeof v!=='boolean')fail();};
export function hash(v:unknown):asserts v is string {if(!p.hash(v))fail();}
function text(v:unknown,max:number,empty=false):asserts v is string {
  if(typeof v!=='string'||v.length>max||!empty&&!v.length||/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v))fail();
}
function nullable(v:unknown,max:number){if(v!==null)text(v,max);}
function array(v:unknown,max:number,min=0):asserts v is any[]{if(!Array.isArray(v)||v.length<min||v.length>max)fail();}
function int(v:unknown,min=0,max=2147483647):asserts v is number {if(!integer(v,min,max))fail();}
function instant(v:unknown){text(v,35);if(!/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(v)||!w.date(v.slice(0,10))||!Number.isFinite(Date.parse(v))||/[+-]14:(?!00)/.test(v))fail();}
function optionalInstant(v:unknown){if(v!==null)instant(v);}
export function response<T>(run:()=>T):T {try{return run();}catch{fail();}}
export function options(v:unknown,write=false,proof=false){
  fields(v,[...(write?['idempotencyKey']:[]),'stepUpHandle'],[...(write?['idempotencyKey']:[]),...(proof?['stepUpHandle']:[])]);
  if(write)key(v.idempotencyKey);
  if(Object.hasOwn(v,'stepUpHandle')&&(typeof v.stepUpHandle!=='string'||!/^[-A-Za-z0-9._~]{1,8192}$/.test(v.stepUpHandle)))fail();
  return v.stepUpHandle===undefined?{}:{stepUpHandle:v.stepUpHandle as string};
}
export function settings(v:unknown,ruc:string){
  exact(v,['enabled','mode','intervalMinutes','mailbox','sire']);bool(v.enabled);choice(v.mode,['LOCAL_FIXTURE','LIVE_READ_ONLY']);int(v.intervalMinutes,5,1440);
  if(v.mode==='LOCAL_FIXTURE'&&!/^00\d{9}$/.test(ruc))fail();
  const m=v.mailbox,s=v.sire;exact(m,['enabled','host','port','folder','username']);exact(s,['enabled','startPeriod','clientId','solUsername']);
  bool(m.enabled);if(m.port!==993)fail();text(m.host,253,true);text(m.folder,150);text(m.username,254,true);bool(s.enabled);text(s.clientId,150,true);text(s.solUsername,64,true);
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Lima',year:'numeric',month:'2-digit'}).formatToParts(new Date());
  const now=parts.find(p=>p.type==='year')!.value+parts.find(p=>p.type==='month')!.value;
  if(typeof s.startPeriod!=='string'||!/^20\d{2}(0[1-9]|1[0-2])$/.test(s.startPeriod)||s.startPeriod>now)fail();
  if(v.mode==='LIVE_READ_ONLY'){
    if(m.enabled&&(!m.username||isIP(m.host)||!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(m.host)||/(^|\.)(localhost|local|internal|invalid|test|onion|lan|home)$/.test(m.host)))fail();
    if(s.enabled&&(!/^[A-Za-z0-9-]{1,128}$/.test(s.clientId)||! /^[A-Za-z0-9]{1,32}$/.test(s.solUsername)||/^\d{11}/.test(s.solUsername)))fail();
  }
  if(v.enabled&&!m.enabled&&!s.enabled)fail();
}
export function save(v:unknown,ruc:string){fields(v,['expectedRevision','settings','credentials'],['expectedRevision','settings']);int(v.expectedRevision,0,2147483646);settings(v.settings,ruc);
  if(Object.hasOwn(v,'credentials')){fields(v.credentials,['mailPassword','sireClientSecret','solPassword'],[]);for(const s of Object.values(v.credentials))text(s,1024,true);}
}
export function sync(v:unknown){exact(v,['source','expectedRevision']);choice(v.source,['MAIL','SIRE','ALL']);int(v.expectedRevision,1);}
function reception(v:unknown,s:ReceivedScope,action:string,keys:string[]){
  exact(v,['schemaVersion','action','scope','runtimeEnabled','fiscalAcceptance',...keys]);
  if(v.schemaVersion!=='factuez.b2b.received-automation.v1'||v.action!==action||!equal(w.scope(v.scope),s)||v.runtimeEnabled!==false||v.fiscalAcceptance!=='NOT_VERIFIED')fail();return v;
}
export function configuration(value:unknown,s:ReceivedScope,expected?:{expectedRevision:number;settings:unknown}):ReceptionConfiguration {
  const v=reception(value,s,expected?'CONFIG_SAVE':'CONFIG_READ',['revision','updatedAt','settings','credentialPresence','state','networkProfile']);
  int(v.revision);optionalInstant(v.updatedAt);if((v.revision===0)!==(v.updatedAt===null))fail();settings(v.settings,s.recipientRuc);
  exact(v.credentialPresence,['mailPassword','sireClientSecret','solPassword']);Object.values(v.credentialPresence).forEach(bool);
  choice(v.state,['DISABLED','STAGED_LOCAL','STAGED_READ_ONLY','WAITING_TI']);choice(v.networkProfile,['LOCAL_ONLY','LIVE_READ_ONLY']);
  if((!v.settings.enabled)!==(v.state==='DISABLED')||v.state==='STAGED_LOCAL'&&v.settings.mode!=='LOCAL_FIXTURE'||v.state==='STAGED_READ_ONLY'&&(v.settings.mode!=='LIVE_READ_ONLY'||v.networkProfile!=='LIVE_READ_ONLY'))fail();
  if(expected&&(v.revision!==expected.expectedRevision+1||!equal(v.settings,expected.settings)))fail();return v as ReceptionConfiguration;
}
export function syncCreated(value:unknown,s:ReceivedScope,b:{source:string;expectedRevision:number}):ReceptionSyncCreated {
  const v=reception(value,s,'SYNC_CREATE',['items','mode','networkProfile']);choice(v.mode,['LOCAL_FIXTURE','LIVE_READ_ONLY']);choice(v.networkProfile,['LOCAL_ONLY','LIVE_READ_ONLY']);
  if(v.mode==='LOCAL_FIXTURE'&&!/^00\d{9}$/.test(s.recipientRuc)||v.mode==='LIVE_READ_ONLY'&&v.networkProfile!=='LIVE_READ_ONLY')fail();
  array(v.items,2,1);const seen=new Set<string>();for(const j of v.items){exact(j,['runId','source','status','revision','dispatch']);id(j.runId);choice(j.source,['MAIL','SIRE']);
    if(j.status!=='QUEUED'||j.dispatch!=='NOT_DISPATCHED'||j.revision!==b.expectedRevision||b.source!=='ALL'&&j.source!==b.source||seen.has(j.source)||v.items.some((x:any)=>x!==j&&x.runId===j.runId))fail();seen.add(j.source);}
  return v as ReceptionSyncCreated;
}
export function syncRead(value:unknown,s:ReceivedScope,runId:string):ReceptionSyncResponse {
  const v=reception(value,s,'SYNC_READ',['run']),r=v.run;exact(r,['runId','source','status','revision','startedAt','finishedAt','counters','errorCode']);
  if(r.runId!==runId)fail();id(r.runId);choice(r.source,['MAIL','SIRE']);choice(r.status,['QUEUED','RUNNING','COMPLETED','FAILED','BLOCKED']);int(r.revision,1);
  optionalInstant(r.startedAt);optionalInstant(r.finishedAt);if(r.startedAt!==null&&r.finishedAt!==null&&Date.parse(r.finishedAt)<Date.parse(r.startedAt))fail();
  exact(r.counters,['detected','imported','duplicate','rejected','xmlPending','matches','mismatches']);Object.values(r.counters).forEach(x=>int(x));
  choice(r.errorCode,[null,'CONFIGURATION_CHANGED','CONNECTION_NOT_READY','CONNECTION_OR_SCOPE_CHANGED','CONNECTOR_UNAVAILABLE','SYNC_FAILED']);return v as ReceptionSyncResponse;
}
export function historyQuery(v:unknown):Required<Pick<HistoryQuery,'take'>>&HistoryQuery {fields(v,['take','afterRecordId'],[]);if(v.take!==undefined)int(v.take,1,100);if(v.afterRecordId!==undefined)hash(v.afterRecordId);return {take:25,...v};}
const policyKeys=['candidateOnly','fiscalAuthority','cdrAuthenticityVerified','transmission','countersChanged','disposition'];
function policy(v:any){if(v.candidateOnly!==true||v.fiscalAuthority!==false||v.cdrAuthenticityVerified!==false||v.transmission!==false||v.countersChanged!==false||v.disposition!=='QUARANTINED')fail();}
function history(value:unknown){exact(value,['schemaVersion','environment','datasetClass','candidateOnly','readOnly','fiscalAuthority','cdrAuthenticityVerified','data']);
  if(value.schemaVersion!=='factuez.b2b.history.v1'||value.environment!=='BETA'||value.datasetClass!=='SYNTHETIC'||value.candidateOnly!==true||value.readOnly!==true||value.fiscalAuthority!==false||value.cdrAuthenticityVerified!==false)fail();return value;
}
export function canonical(v:any):string{return Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v);}
export const digest=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
function decimal(v:unknown,scale=2,positive=false){if(typeof v!=='string'||!new RegExp('^(0|[1-9][0-9]{0,'+(scale===2?15:11)+'})\\.[0-9]{'+scale+'}$').test(v)||positive&&!/[1-9]/.test(v))fail();}
const amountKeys=['taxableAmount','exemptAmount','unaffectedAmount','freeAmount','discountTotal','igvAmount','iscAmount','otherTaxesAmount','payableAmount'];
const cents=(v:string)=>BigInt(v.replace('.',''));
function amounts(v:any){exact(v,amountKeys);Object.values(v).forEach(x=>decimal(x));if(['taxableAmount','exemptAmount','unaffectedAmount','igvAmount','iscAmount','otherTaxesAmount'].reduce((n,k)=>n+cents(v[k]),0n)!==cents(v.payableAmount))fail();}
export function fileName(v:unknown,max=255){text(v,max);if(v!==v.trim()||/[\\/:*?"<>|]/.test(v)||/[. ]$/.test(v)||/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(v)||/(secret|password|credential|certificate|certificado|\.p12\b|Bearer\s)/i.test(v))fail();}
export function artifactKind(v:unknown):asserts v is HistoricalArtifactKind {choice(v,HistoricalArtifactKinds);}
export const mediaType=(kind:HistoricalArtifactKind)=>kind.endsWith('_XML')?'application/xml':kind.startsWith('PDF_')?'application/pdf':'application/zip';
function artifact(v:any){exact(v,['kind','originalName','sha256','sizeBytes']);artifactKind(v.kind);fileName(v.originalName);hash(v.sha256);int(v.sizeBytes,1,16*1024*1024);
  if(!v.originalName.toLowerCase().endsWith(v.kind.endsWith('_XML')?'.xml':v.kind.startsWith('PDF_')?'.pdf':'.zip'))fail();
}
function historicalSnapshot(s:any,b:BusinessBinding){
  exact(s,['schemaVersion','environment','ownership','sourceDocumentId','originSystem','originId','number','issueDate','currencyCode','operationTypeCode','issuer','customer','items','tax','amounts','paymentTerms','reference','vehiclePlate','amountInWords','observations','sourceEvidence','artifacts']);
  if(s.schemaVersion!=='factuez.history-document.v1'||s.environment!=='BETA'||s.originSystem!=='RESTOAPP'||s.reference!==null)fail();
  const m=s.ownership;exact(m,['mappingId','issuerRuc','companyId','branchId','emissionPointId','seriesCounterId','documentTypeCode','series']);id(m.mappingId);
  if(!equal(binding({issuerId:m.companyId,issuerRuc:m.issuerRuc,environment:'BETA',branchId:m.branchId,pointId:m.emissionPointId,seriesId:m.seriesCounterId,documentType:m.documentTypeCode}),b)||!/^00000000\d{3}$/.test(m.issuerRuc)||typeof m.series!=='string'||!(b.documentType==='01'?/^F[A-Z0-9]{3}$/:/^B[A-Z0-9]{3}$/).test(m.series))fail();
  id(s.sourceDocumentId);text(s.originId,120);if(s.originId!==s.originId.trim()||typeof s.number!=='string'||! /^[1-9][0-9]{0,7}$/.test(s.number)||typeof s.operationTypeCode!=='string'||! /^\d{4}$/.test(s.operationTypeCode))fail();
  instant(s.issueDate);choice(s.currencyCode,['PEN','USD']);const i=s.issuer,c=s.customer;
  exact(i,['ruc','legalName','tradeName','address','ubigeo','establishmentCode']);if(i.ruc!==b.issuerRuc||typeof i.ubigeo!=='string'||!/^\d{6}$/.test(i.ubigeo)||typeof i.establishmentCode!=='string'||!/^\d{4}$/.test(i.establishmentCode))fail();text(i.legalName,200);nullable(i.tradeName,200);text(i.address,300);
  exact(c,['identityType','identityNumber','legalName','address','email']);choice(c.identityType,['0','1','4','6','7','A','B']);text(c.identityNumber,15);if(!/^[A-Z0-9-]+$/.test(c.identityNumber))fail();text(c.legalName,250);nullable(c.address,300);nullable(c.email,254);if(c.email!==null&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email))fail();
  array(s.items,100,1);for(const [n,j] of s.items.entries()){
    exact(j,['lineNumber','productCode','description','unitCode','quantity','unitValue','unitPriceWithTax','taxAffectationCode','igvRate','amounts']);if(j.lineNumber!==n+1||typeof j.unitCode!=='string'||! /^[A-Z0-9]{2,3}$/.test(j.unitCode)||typeof j.taxAffectationCode!=='string'||! /^\d{2}$/.test(j.taxAffectationCode))fail();nullable(j.productCode,40);text(j.description,250);decimal(j.quantity,6,true);decimal(j.unitValue,6);decimal(j.unitPriceWithTax,6);decimal(j.igvRate);amounts(j.amounts);
  }
  amounts(s.amounts);for(const k of amountKeys)if(s.items.reduce((n:bigint,j:any)=>n+cents(j.amounts[k]),0n)!==cents(s.amounts[k]))fail();
  array(s.tax,16);const taxes=new Set();for(const t of s.tax){exact(t,['taxSchemeId','taxName','taxableAmount','taxAmount']);if(typeof t.taxSchemeId!=='string'||! /^\d{4}$/.test(t.taxSchemeId)||taxes.has(t.taxSchemeId))fail();taxes.add(t.taxSchemeId);text(t.taxName,20);decimal(t.taxableAmount);decimal(t.taxAmount);}
  if(s.tax.reduce((n:bigint,t:any)=>n+cents(t.taxAmount),0n)!==cents(s.amounts.igvAmount)+cents(s.amounts.iscAmount)+cents(s.amounts.otherTaxesAmount))fail();
  const t=s.paymentTerms;if(t?.type==='CONTADO')exact(t,['type']);else{exact(t,['type','currencyCode','pendingAmount','installments']);if(t.type!=='CREDITO'||t.currencyCode!==s.currencyCode)fail();decimal(t.pendingAmount,2,true);if(cents(t.pendingAmount)>cents(s.amounts.payableAmount))fail();array(t.installments,100,1);for(const j of t.installments){exact(j,['amount','dueDate']);decimal(j.amount,2,true);if(!w.date(j.dueDate))fail();}if(t.installments.reduce((n:bigint,j:any)=>n+cents(j.amount),0n)!==cents(t.pendingAmount))fail();}
  nullable(s.vehiclePlate,15);nullable(s.amountInWords,500);nullable(s.observations,2000);exact(s.sourceEvidence,['declaredStatus','responseCode','description','authenticity']);choice(s.sourceEvidence.declaredStatus,['NOT_DECLARED','DECLARED_ACCEPTED','DECLARED_REJECTED','DECLARED_VOIDED']);if(s.sourceEvidence.authenticity!=='NOT_VERIFIED')fail();nullable(s.sourceEvidence.responseCode,20);nullable(s.sourceEvidence.description,1000);
  array(s.artifacts,8);const kinds=new Set();for(const a of s.artifacts){artifact(a);if(kinds.has(a.kind))fail();kinds.add(a.kind);}
}
export function historyDetail(value:unknown,b:BusinessBinding,recordId:string):HistoricalDocument {
  const v=history(value),d=v.data;exact(d,['recordId','snapshotSha256','snapshot',...policyKeys]);policy(d);hash(d.recordId);hash(d.snapshotSha256);if(d.recordId!==recordId)fail();historicalSnapshot(d.snapshot,b);
  const s=d.snapshot,m=s.ownership;
  if(d.snapshotSha256!==digest(s)||d.recordId!==digest({fiscalKey:JSON.stringify([m.issuerRuc,m.documentTypeCode,m.series,s.number]),originKey:JSON.stringify([m.companyId,s.originSystem,s.originId])}))fail();
  return v as HistoricalDocument;
}
export function historyList(value:unknown,b:BusinessBinding,q:ReturnType<typeof historyQuery>):HistoryPage {
  const v=history(value);exact(v.data,['items','nextCursor']);array(v.data.items,q.take);let previous=q.afterRecordId??'';
  for(const r of v.data.items){exact(r,['recordId','snapshotSha256','issuerRuc','companyId','branchId','fullNumber','customer','issueDate','currencyCode','payableAmount',...policyKeys]);policy(r);hash(r.recordId);hash(r.snapshotSha256);
    if(r.recordId<=previous||r.issuerRuc!==b.issuerRuc||r.companyId!==b.issuerId||r.branchId!==b.branchId||!/^00000000\d{3}$/.test(r.issuerRuc)||typeof r.fullNumber!=='string'||!(b.documentType==='01'?/^F[A-Z0-9]{3}-[1-9]\d{0,7}$/:/^B[A-Z0-9]{3}-[1-9]\d{0,7}$/).test(r.fullNumber))fail();previous=r.recordId;text(r.customer,250);instant(r.issueDate);choice(r.currencyCode,['PEN','USD']);decimal(r.payableAmount);
  }
  if(v.data.nextCursor!==null&&(v.data.items.length!==q.take||!v.data.items.length||v.data.nextCursor!==previous))fail();return v as HistoryPage;
}
export function emailRequest(v:unknown){exact(v,['recipient','format']);text(v.recipient,254);if(v.recipient!==v.recipient.trim()||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.recipient))fail();choice(v.format,['ticket','a4']);}
export function email(value:unknown,expected:{id?:string;documentId?:string;binding?:BusinessBinding;format?:string}):EmailDelivery {
  exact(value,['schemaVersion','environment','candidateOnly','id','documentId','binding','format','state','profile','revision','createdAt','updatedAt','errorCode','attachments','deliveredToClient','fiscalAuthority','replayed']);const v=value;
  if(v.schemaVersion!=='factuez.b2b.email-deliveries.v1'||v.environment!=='BETA'||v.candidateOnly!==true||v.deliveredToClient!==false||v.fiscalAuthority!==false||typeof v.replayed!=='boolean')fail();
  id(v.id);id(v.documentId);binding(v.binding);int(v.revision,1);instant(v.createdAt);instant(v.updatedAt);if(Date.parse(v.updatedAt)<Date.parse(v.createdAt)||expected.id&&v.id!==expected.id||expected.documentId&&v.documentId!==expected.documentId||expected.binding&&!equal(v.binding,expected.binding)||expected.format&&v.format!==expected.format)fail();
  choice(v.format,['ticket','a4']);choice(v.state,['QUEUED','WAITING_ARTIFACTS','DISPATCHING','CAPTURED_LOCAL','SMTP_ACCEPTED','UNKNOWN']);choice(v.profile,['NONE','LOCAL_CAPTURE','CORPORATE']);
  const validOutcome=v.state==='QUEUED'?v.errorCode===null:
    v.state==='WAITING_ARTIFACTS'?v.errorCode==='ARTIFACTS_PENDING':v.profile==='NONE'?false:
    v.state==='DISPATCHING'?v.errorCode===null:
    v.state==='UNKNOWN'?v.errorCode===(v.profile==='CORPORATE'?'SMTP_OUTCOME_UNKNOWN':'CAPTURE_OUTCOME_UNKNOWN'):
    v.errorCode===null&&(v.profile==='CORPORATE'?v.state==='SMTP_ACCEPTED':v.state==='CAPTURED_LOCAL');
  if(!validOutcome)fail();
  array(v.attachments,3);const seen=new Set();for(const a of v.attachments){exact(a,['kind','fileName','mediaType','sha256','byteLength','representation','sourceProofSha256']);choice(a.kind,['PDF','XML','CDR']);if(seen.has(a.kind))fail();seen.add(a.kind);fileName(a.fileName,150);hash(a.sha256);hash(a.sourceProofSha256);int(a.byteLength,1,Number.MAX_SAFE_INTEGER);
    choice(a.mediaType,a.kind==='PDF'?['application/pdf']:a.kind==='XML'?['application/xml']:['application/xml','application/zip']);if(a.representation!==(a.kind==='PDF'?'CURRENT_GENERATED':'IMMUTABLE_ORIGINAL')||!a.fileName.toLowerCase().endsWith(a.mediaType==='application/pdf'?'.pdf':a.mediaType==='application/zip'?'.zip':'.xml'))fail();
  }
  return v as EmailDelivery;
}


