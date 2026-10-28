import { historicalSha256, historyInteger, historyJson, historyObject, historySha, historyText,
  historyUuid, validateHistoricalSnapshot, type HistoricalDocumentSnapshotV1 } from '@factuez/history-core';
import { inspectShadowXml, limaDay, ShadowError, shadowAssert } from './xml';
export { ShadowError } from './xml';
export const SHADOW_LIMITS=Object.freeze({cases:50,differences:200,printPages:100,printLines:200});
const policy=Object.freeze({environment:'BETA' as const,datasetClass:'SYNTHETIC' as const,mode:'SHADOW' as const,
  transmission:false as const,persisted:false as const,fiscalWrites:0 as const,outboxWrites:0 as const,countersChanged:false as const,
  fiscalAuthority:false as const,cutoverAuthorized:false as const,
  signatureVerified:false as const,cdrAuthenticityVerified:false as const,pdfBytesVerified:false as const,
  accountingApproved:false as const,productionBlocked:true as const,reviewRequired:true as const});

export type ShadowDifferenceCategory='CORRECTION_REQUIRED'|'COSMETIC'|'DATA_MISSING';
type Difference={id:string;path:string;category:ShadowDifferenceCategory;legacy:string|null;factuez:string|null};
export type ShadowPrintProjection={schemaVersion:'factuez.shadow-print.v1';provenance:'SYNTHETIC_DECLARED';format:'TICKET_80MM'|'A4';
  pageSizesMicrometers:Array<{width:number;height:number}>;textLines:string[];
  qrFields:{issuerRuc:string;documentTypeCode:string;series:string;number:string;igvAmount:string;payableAmount:string;issueDate:string;customerIdentityType:string;customerIdentityNumber:string};
  digestValue:string|null;pdfSha256:string};
export type ShadowSide={snapshot:HistoricalDocumentSnapshotV1;xml:string|null;prints:ShadowPrintProjection[]};
export type ShadowCaseV1={schemaVersion:'factuez.shadow-case.v1';environment:'BETA';datasetClass:'SYNTHETIC';mode:'SHADOW';
  caseId:string;legacy:ShadowSide;factuez:ShadowSide};
export type ShadowRunV1={schemaVersion:'factuez.shadow-run.v1';environment:'BETA';datasetClass:'SYNTHETIC';mode:'SHADOW';runId:string;cases:ShadowCaseV1[]};

function profile(value:any,schemaVersion:string){
  shadowAssert(value.schemaVersion===schemaVersion&&value.environment==='BETA'&&value.datasetClass==='SYNTHETIC'&&value.mode==='SHADOW','SHADOW_PROFILE_BLOCKED');
}
function side(value:any):ShadowSide{
  historyObject(value,['snapshot','xml','prints']);
  const snapshot=validateHistoricalSnapshot(value.snapshot);
  shadowAssert(value.xml===null||typeof value.xml==='string'&&value.xml.length>0,'SHADOW_XML_INVALID');
  shadowAssert(Array.isArray(value.prints)&&value.prints.length<=2,'SHADOW_PRINT_INVALID');
  const prints:ShadowPrintProjection[]=value.prints.map((p:any)=>{
    historyObject(p,['schemaVersion','provenance','format','pageSizesMicrometers','textLines','qrFields','digestValue','pdfSha256']);
    shadowAssert(p.schemaVersion==='factuez.shadow-print.v1'&&p.provenance==='SYNTHETIC_DECLARED'&&['TICKET_80MM','A4'].includes(p.format),'SHADOW_PRINT_PROFILE_BLOCKED');
    shadowAssert(Array.isArray(p.pageSizesMicrometers)&&p.pageSizesMicrometers.length>0&&p.pageSizesMicrometers.length<=SHADOW_LIMITS.printPages&&
      Array.isArray(p.textLines)&&p.textLines.length>0&&p.textLines.length<=SHADOW_LIMITS.printLines,'SHADOW_PRINT_INVALID');
    const pageSizesMicrometers=p.pageSizesMicrometers.map((d:any)=>{historyObject(d,['width','height']);return{width:historyInteger(d.width,2000000),height:historyInteger(d.height,2000000)};});
    const textLines=p.textLines.map((line:unknown)=>historyText(line,500));
    historyObject(p.qrFields,['issuerRuc','documentTypeCode','series','number','igvAmount','payableAmount','issueDate','customerIdentityType','customerIdentityNumber']);
    const qrFields=Object.fromEntries(Object.entries(p.qrFields).map(([k,v])=>[k,historyText(v,40)])) as ShadowPrintProjection['qrFields'];
    shadowAssert(p.digestValue===null||typeof p.digestValue==='string'&&/^[A-Za-z0-9+/]{43}=$/.test(p.digestValue)&&
      Buffer.from(p.digestValue,'base64').toString('base64')===p.digestValue,'SHADOW_DIGEST_INVALID');
    return{...p,pageSizesMicrometers,textLines,qrFields,pdfSha256:historySha(p.pdfSha256)};
  }).sort((a:ShadowPrintProjection,b:ShadowPrintProjection)=>a.format.localeCompare(b.format));
  shadowAssert(new Set(prints.map(p=>p.format)).size===prints.length,'SHADOW_PRINT_DUPLICATE');
  return {snapshot,xml:value.xml,prints};
}
function canonicalCase(input:unknown):ShadowCaseV1{
  const c=historyJson(input);historyObject(c,['schemaVersion','environment','datasetClass','mode','caseId','legacy','factuez']);profile(c,'factuez.shadow-case.v1');
  const legacy=side(c.legacy),factuez=side(c.factuez);
  shadowAssert(legacy.snapshot.ownership.companyId===factuez.snapshot.ownership.companyId&&
    legacy.snapshot.originId===factuez.snapshot.originId&&legacy.snapshot.sourceDocumentId===factuez.snapshot.sourceDocumentId,'SHADOW_PAIR_ORIGIN_MISMATCH');
  return {...c,caseId:historyUuid(c.caseId),legacy,factuez};
}
function freeze<T>(v:T):T{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
const snippet=(v:any)=>v===undefined||v===null?null:JSON.stringify(v).slice(0,250);
function category(path:string,a:any,b:any):ShadowDifferenceCategory{
  if(a===null||b===null||a===undefined||b===undefined)return 'DATA_MISSING';
  return ['snapshot.observations','snapshot.issuer.tradeName'].includes(path)?'COSMETIC':'CORRECTION_REQUIRED';
}
function business(s:HistoricalDocumentSnapshotV1){
  const{schemaVersion,environment,originSystem,originId,sourceDocumentId,sourceEvidence,artifacts,...data}=s;
  // Same instant is representation-independent; the fiscal date is still retained in XML/QR.
  return {...data,issueDate:new Date(data.issueDate).toISOString()};
}
function expectedQr(s:HistoricalDocumentSnapshotV1){return{issuerRuc:s.issuer.ruc,documentTypeCode:s.ownership.documentTypeCode,
  series:s.ownership.series,number:s.number,igvAmount:s.amounts.igvAmount,payableAmount:s.amounts.payableAmount,issueDate:limaDay(s.issueDate),
  customerIdentityType:s.customer.identityType,customerIdentityNumber:s.customer.identityNumber};}

export function compareShadowCase(input:unknown){
  const c=canonicalCase(input),differences:Difference[]=[],counts={CORRECTION_REQUIRED:0,COSMETIC:0,DATA_MISSING:0};let differenceCount=0;
  function add(path:string,a:any,b:any,kind:ShadowDifferenceCategory=category(path,a,b)){
    differenceCount++;counts[kind]++;
    if(differences.length<SHADOW_LIMITS.differences)differences.push({id:historicalSha256({caseId:c.caseId,path,legacy:a??null,factuez:b??null}),
      path,category:kind,legacy:snippet(a),factuez:snippet(b)});
  }
  function compare(a:any,b:any,path:string){
    if(a===b)return;
    if(a!==null&&b!==null&&typeof a==='object'&&typeof b==='object'&&Array.isArray(a)===Array.isArray(b)){
      const keys=[...new Set([...Object.keys(a),...Object.keys(b)])].sort();
      for(const k of keys)compare(a[k],b[k],`${path}.${k}`);
    }else add(path,a,b);
  }
  compare(business(c.legacy.snapshot),business(c.factuez.snapshot),'snapshot');
  const xml={legacy:c.legacy.xml===null?null:inspectShadowXml(c.legacy.xml,c.legacy.snapshot),
    factuez:c.factuez.xml===null?null:inspectShadowXml(c.factuez.xml,c.factuez.snapshot)};
  if(!xml.legacy||!xml.factuez)add('xml.presence',xml.legacy?'PRESENT':null,xml.factuez?'PRESENT':null,'DATA_MISSING');
  else if(xml.legacy.structuralSha256!==xml.factuez.structuralSha256)add('xml.structuralSha256',xml.legacy.structuralSha256,xml.factuez.structuralSha256);
  for(const label of ['legacy','factuez'] as const){
    const s=c[label].snapshot,x=xml[label];
    if(x){
      const wanted={fullNumber:`${s.ownership.series}-${s.number}`,issueDate:limaDay(s.issueDate),currencyCode:s.currencyCode,documentTypeCode:s.ownership.documentTypeCode};
      for(const k of Object.keys(wanted) as Array<keyof typeof wanted>)if(x.header[k]!==wanted[k])
        add(`xml.${label}.snapshotBinding.${k}`,wanted[k],x.header[k],'CORRECTION_REQUIRED');
    }
    for(const p of c[label].prints){
      const wanted=expectedQr(s);
      for(const k of Object.keys(wanted) as Array<keyof typeof wanted>)if(p.qrFields[k]!==wanted[k])
        add(`prints.${label}.${p.format}.snapshotBinding.${k}`,wanted[k],p.qrFields[k],'CORRECTION_REQUIRED');
      if(x?.digestValue&&p.digestValue!==x.digestValue)add(`prints.${label}.${p.format}.digestBinding`,x.digestValue,p.digestValue,'CORRECTION_REQUIRED');
      if(p.digestValue&&!x?.digestValue)add(`prints.${label}.${p.format}.digestEvidence`,null,p.digestValue,'DATA_MISSING');
    }
  }
  for(const format of ['TICKET_80MM','A4'] as const){
    const a=c.legacy.prints.find(p=>p.format===format),b=c.factuez.prints.find(p=>p.format===format);
    if(!a||!b)add(`prints.${format}.presence`,a?'PRESENT':null,b?'PRESENT':null,'DATA_MISSING');
    else{
      compare(a.pageSizesMicrometers,b.pageSizesMicrometers,`prints.${format}.pageSizesMicrometers`);
      compare(a.textLines,b.textLines,`prints.${format}.textLines`);
      compare(a.qrFields,b.qrFields,`prints.${format}.qrFields`);
      // PDF bytes and DigestValue can differ legitimately across renderers/signatures.
      // They remain bound in input hashes, NEVER considered cryptographically verified.
    }
  }
  return freeze({schemaVersion:'factuez.shadow-report.v1' as const,...policy,caseId:c.caseId,
    status:counts.DATA_MISSING?'INCOMPLETE':differenceCount?'DIFFERENCES_FOUND':'MATCH_WITH_UNVERIFIED_EVIDENCE',
    comparativeMatch:differenceCount===0,differenceCount,counts,differences,differencesTruncated:differenceCount>differences.length,
    inputSha256:historicalSha256(c),legacySnapshotSha256:historicalSha256(c.legacy.snapshot),factuezSnapshotSha256:historicalSha256(c.factuez.snapshot),
    xml,printEvidence:'DECLARED_PROJECTIONS_ONLY' as const,
    bindingCoverage:['XML_HEADER_ID_DATE_CURRENCY_TYPE','DECLARED_QR_FIELDS','DECLARED_DIGEST_CONSISTENCY'] as const,
    manualReviewRequired:['XML_ITEMS_ISSUER_CUSTOMER_AND_TOTAL_BINDING','SIGNATURE_CDR_PKI','PDF_BYTES_VISUAL_AND_PHYSICAL_PRINT','LEGACY_BUG_CLASSIFICATION','ACCOUNTING_APPROVAL'] as const});
}
export type ShadowCaseReport=ReturnType<typeof compareShadowCase>;

export function compareShadowRun(input:unknown){
  const r=historyJson(input);historyObject(r,['schemaVersion','environment','datasetClass','mode','runId','cases']);profile(r,'factuez.shadow-run.v1');
  shadowAssert(Array.isArray(r.cases)&&r.cases.length>0&&r.cases.length<=SHADOW_LIMITS.cases,'SHADOW_RUN_LIMIT');
  const runId=historyUuid(r.runId),seen=new Set<string>(),origins=new Set<string>(),fiscal={legacy:new Set<string>(),factuez:new Set<string>()};
  const reports:ShadowCaseReport[]=r.cases.map((value:unknown)=>{
    const c=canonicalCase(value),origin=JSON.stringify([c.legacy.snapshot.ownership.companyId,c.legacy.snapshot.originId]);
    shadowAssert(!seen.has(c.caseId)&&!origins.has(origin),'SHADOW_RUN_DUPLICATE');seen.add(c.caseId);origins.add(origin);
    for(const label of ['legacy','factuez'] as const){const s=c[label].snapshot;
      const key=JSON.stringify([s.ownership.issuerRuc,s.ownership.documentTypeCode,s.ownership.series,s.number]);
      shadowAssert(!fiscal[label].has(key),'SHADOW_RUN_DUPLICATE_FISCAL');fiscal[label].add(key);}
    return compareShadowCase(c);
  }).sort((a:ShadowCaseReport,b:ShadowCaseReport)=>a.caseId.localeCompare(b.caseId));
  return freeze({schemaVersion:'factuez.shadow-run-report.v1' as const,...policy,status:'REVIEW_REQUIRED' as const,runId,count:reports.length,
    inputSha256:historicalSha256(r),comparativeMatch:reports.every((c:ShadowCaseReport)=>c.comparativeMatch),
    matchingCount:reports.filter((c:ShadowCaseReport)=>c.comparativeMatch).length,
    differenceCount:reports.reduce((n:number,c:ShadowCaseReport)=>n+c.differenceCount,0),reports});
}
export type ShadowRunReport=ReturnType<typeof compareShadowRun>;

export type ShadowReviewCategory=ShadowDifferenceCategory|'LEGACY_BUG_PENDING_APPROVAL';
/** Synthetic review annotations, not authenticated human approval or resolution.
 * Recompute the report from the original case; a stale hash/difference cannot be reused.
 */
export function annotateShadowReview(caseInput:unknown,reviewInput:unknown){
  const report=compareShadowCase(caseInput),review=historyJson(reviewInput);
  historyObject(review,['schemaVersion','environment','datasetClass','mode','caseId','inputSha256','reviewerId','decisions']);
  profile(review,'factuez.shadow-review.v1');
  shadowAssert(historyUuid(review.caseId)===report.caseId&&historySha(review.inputSha256)===report.inputSha256,'SHADOW_REVIEW_STALE');
  const reviewerId=historyUuid(review.reviewerId);
  shadowAssert(Array.isArray(review.decisions)&&review.decisions.length<=SHADOW_LIMITS.differences,'SHADOW_REVIEW_LIMIT');
  const known=new Map(report.differences.map(d=>[d.id,d])),seen=new Set<string>();
  const annotations=review.decisions.map((value:any)=>{
    historyObject(value,['differenceId','category','reason']);
    const differenceId=historySha(value.differenceId),difference=known.get(differenceId);
    shadowAssert(difference&&!seen.has(differenceId),'SHADOW_REVIEW_DIFFERENCE_UNKNOWN');seen.add(differenceId);
    shadowAssert(['CORRECTION_REQUIRED','COSMETIC','DATA_MISSING','LEGACY_BUG_PENDING_APPROVAL'].includes(value.category),'SHADOW_REVIEW_CATEGORY_INVALID');
    return {differenceId,originalCategory:difference.category,proposedCategory:value.category as ShadowReviewCategory,reason:historyText(value.reason,500)};
  }).sort((a:{differenceId:string},b:{differenceId:string})=>a.differenceId.localeCompare(b.differenceId));
  return freeze({schemaVersion:'factuez.shadow-review-report.v1' as const,...policy,caseId:report.caseId,inputSha256:report.inputSha256,
    reviewerId,reviewerIdentityAuthenticated:false as const,annotationsOnly:true as const,annotations,
    annotatedDifferenceCount:annotations.length,unresolvedDifferenceCount:report.differenceCount,
    unannotatedDifferenceCount:report.differenceCount-annotations.length,report,reviewSha256:historicalSha256(review)});
}

/** This package is NOT an emitter. Even an explicit caller cannot turn on effects. */
export function assertShadowOperation(_operation:unknown):never{throw new ShadowError('SHADOW_OPERATION_BLOCKED');}
