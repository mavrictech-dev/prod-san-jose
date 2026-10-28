import { createHash } from 'node:crypto';
import { B2bSecurityError, b2bBindingsContain, validB2bBinding, validB2bCorrectionBinding, type B2bBinding } from '@factuez/contracts/b2b-security';
import { validB2bGuideIssueBinding } from '@factuez/contracts/b2b-guide-security';
import { b2bUuid } from '@factuez/contracts/b2b-read-query';
import { snapshotHash } from '@factuez/service-access/dist/integration';
import type { ReportRow, ReportsCapture, ReportsFilters } from './types';
import type { ReportsAccess } from './source-types';
import { reportTypeCapability } from './capabilities';
import { guideArtifactWireScope } from '@factuez/service-access/dist/b2b-guide-artifact-wire';
export const limits = {rows:10000,captureBytes:16*1024*1024,contentBytes:24*1024*1024} as const;
export function fail(status:number,code:string):never {throw new B2bSecurityError(status,code);}
export function object(v:unknown):Record<string,any> {
  if (!v || typeof v!=='object' || Array.isArray(v) || ![Object.prototype,null].includes(Object.getPrototypeOf(v))) fail(400,'INVALID_REQUEST');
  return v as Record<string,any>;
}
export function keys(v:Record<string,unknown>,allowed:string[],required=allowed) {
  if(Object.keys(v).some(k=>!allowed.includes(k))||required.some(k=>!Object.hasOwn(v,k))) fail(400,'INVALID_REQUEST');
}
const scale=10n**12n;
export function decimal(value:unknown):bigint {
  if(typeof value!=='string'||!/^\d{1,30}(?:\.\d{1,12})?$/.test(value)) fail(409,'REPORT_DECIMAL_INVALID');
  const [a,b='']=value.split('.');return BigInt(a)*scale+BigInt(b.padEnd(12,'0'));
}
export function decimalText(value:bigint):string {
  const magnitude=value<0n?-value:value;
  const fraction=(magnitude%scale).toString().padStart(12,'0').replace(/0+$/,'').padEnd(2,'0');
  return `${value<0n?'-':''}${magnitude/scale}.${fraction}`;
}
export const hashBytes=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const extended=(f:ReportsFilters)=>f.types.some(t=>!['01','03'].includes(t));
export function matches(b:B2bBinding,f:ReportsFilters):boolean {
  return b.issuerId===f.issuerId&&b.environment===f.environment&&(!f.issuerRuc||b.issuerRuc===f.issuerRuc)&&
    (extended(f)||f.types.includes(b.documentType))&&(!f.branchId||b.branchId===f.branchId)&&(!f.pointId||b.pointId===f.pointId)&&
    (extended(f)||!f.seriesId||b.seriesId===f.seriesId);
}
export const accessKey=(a:Pick<ReportsAccess,'kind'|'binding'>)=>snapshotHash({kind:a.kind,binding:a.binding});
export const accessAnchor=(a:ReportsAccess):B2bBinding=>a.kind==='CORRECTION'?a.binding.reference:a.kind==='GUIDE'?a.binding.draft.anchor:a.binding;
export const accessType=(a:ReportsAccess)=>a.kind==='CORRECTION'?a.binding.noteType:a.kind==='GUIDE'?a.binding.draft.guideType:'NV';
export const accessSeries=(a:ReportsAccess)=>a.kind==='CORRECTION'?a.binding.noteSeriesId:a.kind==='GUIDE'?a.binding.fiscalSeriesId:a.binding.seriesId;
export function validAccess(a:ReportsAccess):boolean {
  return !!a&&(a.kind==='CORRECTION'?validB2bCorrectionBinding(a.binding):a.kind==='GUIDE'?validB2bGuideIssueBinding(a.binding):a.kind==='SALES_NOTE'&&validB2bBinding(a.binding))&&
    (a.kind==='SALES_NOTE'?a.grantRevision===null:Number.isSafeInteger(a.grantRevision)&&Number(a.grantRevision)>0);
}
export function sealCapture(body:Omit<ReportsCapture,'sha256'>):ReportsCapture {
  body.rows.sort((a,b)=>a.issuedAt.localeCompare(b.issuedAt)||a.type.localeCompare(b.type)||a.id.localeCompare(b.id));
  const c={...body,sha256:snapshotHash(body)};verifyCapture(c);return c;
}
export function captureResult(value:unknown,filters:ReportsFilters,bindings:B2bBinding[]):ReportsCapture {
  const v=object(value);
  if(!Array.isArray(v.items)||v.items.length>limits.rows||Buffer.byteLength(JSON.stringify(v))>limits.captureBytes) fail(413,'NARROW_QUERY');
  if(typeof v.capturedAt!=='string'||!Number.isFinite(Date.parse(v.capturedAt))) fail(409,'REPORT_CAPTURE_INVALID');
  const rows:ReportRow[]=v.items.map((item:unknown)=>{
    const x=object(item),b=x.context,d=object(x.document),state=object(d.state),totals=object(object(d.detail).totals);
    if(!validB2bBinding(b)||!b2bBindingsContain(bindings,b)||!matches(b,filters)) fail(404,'RESOURCE_NOT_FOUND');
    if(!b2bUuid(d.id)||!sha(x.snapshotSha256)||x.snapshotSha256!==d.snapshotSha256||!sha(d.resourceVersion)||
      d.environment!=='BETA'||d.dataset!=='ISSUED_BUSINESS'||d.issuerRuc!==b.issuerRuc||d.branchId!==b.branchId||
      d.pointId!==b.pointId||d.seriesCounterId!==b.seriesId||d.type!==b.documentType||
      !['PEN','USD'].includes(d.currency)||!['ISSUED','CANCELLED'].includes(state.local)||
      typeof d.issuedAt!=='string'||!Number.isFinite(Date.parse(d.issuedAt))||
      typeof d.issueDate!=='string'||d.issueDate<filters.from||d.issueDate>filters.to||
      new Date(Date.parse(d.issuedAt)-5*3600000).toISOString().slice(0,10)!==d.issueDate||
      typeof d.fullNumber!=='string'||!/^[FB][A-Z0-9]{3}-[0-9]{1,20}$/.test(d.fullNumber)) fail(409,'REPORT_CAPTURE_INVALID');
    const payable=decimalText(decimal(d.payableAmount));
    if(decimal(totals.payableAmount)!==decimal(payable)) fail(409,'REPORT_CAPTURE_INVALID');
    const amount=(v:unknown)=>v===null?null:decimalText(decimal(v));
    return {id:d.id,context:structuredClone(b),snapshotSha256:x.snapshotSha256,resourceVersion:d.resourceVersion,
      issuedAt:d.issuedAt,issueDate:d.issueDate,type:d.type,fullNumber:d.fullNumber,currency:d.currency,local:state.local,
      payableAmount:payable,taxableAmount:amount(totals.taxableAmount),igvAmount:amount(totals.igvAmount)};
  });
  if(new Set(rows.map(r=>r.id)).size!==rows.length) fail(409,'REPORT_CAPTURE_INVALID');
  return sealCapture({capturedAt:v.capturedAt,filters:structuredClone(filters),bindings:structuredClone(bindings),rows});
}
export function assertReportFinancialSeparation(r:ReportRow):void {
  const guide=r.type==='09'||r.type==='31';
  if(guide&&(r.currency!==null||r.payableAmount!==null||r.taxableAmount!==null||r.igvAmount!==null))
    fail(409,'REPORT_GUIDE_FINANCIAL_CONTAMINATION');
  if(!guide&&(r.transfer!==undefined||r.guideMetadata!==undefined))fail(409,'REPORT_SOURCE_KIND_MISMATCH');
}

export function verifyCapture(c:ReportsCapture):void {
  if(!c||typeof c!=='object') fail(409,'REPORT_CAPTURE_INTEGRITY');
  const {sha256,...body}=c;
  if(!sha(sha256)||snapshotHash(body)!==sha256||!Array.isArray(c.rows)||c.rows.length>limits.rows||
    Buffer.byteLength(JSON.stringify(c))>limits.captureBytes||!Array.isArray(c.bindings)||!c.bindings.length||
    !c.filters||c.filters.environment!=='BETA'||!Array.isArray(c.filters.types)||!c.filters.types.length||
    new Set(c.filters.types).size!==c.filters.types.length||c.filters.types.some(t=>!['01','03','07','08','09','31','NV'].includes(t))||
    !Number.isFinite(Date.parse(c.capturedAt))||c.bindings.some(b=>!validB2bBinding(b)||!matches(b,c.filters))) fail(409,'REPORT_CAPTURE_INTEGRITY');
  const access=c.access??[];
  if(!Array.isArray(access)||access.length>500||access.some(a=>!validAccess(a)||!b2bBindingsContain(c.bindings,accessAnchor(a))||
    !c.filters.types.includes(accessType(a))||!!c.filters.seriesId&&accessSeries(a)!==c.filters.seriesId)||
    new Set(access.map(accessKey)).size!==access.length||
    c.filters.types.some(t=>!['01','03'].includes(t)&&!access.some(a=>accessType(a)===t))) fail(409,'REPORT_CAPTURE_INTEGRITY');
  if(new Set(c.rows.map(r=>r.type+':'+r.id)).size!==c.rows.length) fail(409,'REPORT_CAPTURE_INVALID');
  for(const r of c.rows){
    assertReportFinancialSeparation(r);
    const a=access.find(a=>accessKey(a)===r.accessKey),guide=['09','31'].includes(r.type);
    if(!b2bUuid(r.id)||!sha(r.snapshotSha256)||!sha(r.resourceVersion)||!b2bBindingsContain(c.bindings,r.context)||!matches(r.context,c.filters)||
      !c.filters.types.includes(r.type)||!Number.isFinite(Date.parse(r.issuedAt))||!/^20\d\d-\d\d-\d\d$/.test(r.issueDate)||
      r.issueDate<c.filters.from||r.issueDate>c.filters.to||new Date(Date.parse(r.issuedAt)-5*3600000).toISOString().slice(0,10)!==r.issueDate||
      !['ISSUED','CANCELLED','LOCAL_NUMBERED','COMPLETED','CONVERTED'].includes(r.local)||
      typeof r.fullNumber!=='string'||!/^(?:[FBTV][A-Z0-9]{3}-[0-9]{1,20}|NV-[0-9]{8})$/.test(r.fullNumber)||
      (['01','03'].includes(r.type)?r.type!==r.context.documentType||r.accessKey!==undefined||!!c.filters.seriesId&&r.context.seriesId!==c.filters.seriesId:
        !a||accessType(a)!==r.type||snapshotHash(accessAnchor(a))!==snapshotHash(r.context))) fail(409,'REPORT_CAPTURE_INTEGRITY');
    if(['01','03','07','08'].includes(r.type)&&!['ISSUED','CANCELLED'].includes(r.local))fail(409,'REPORT_CAPTURE_INTEGRITY');
    if(guide){
      if(r.currency!==null||r.payableAmount!==null||r.taxableAmount!==null||r.igvAmount!==null||r.local!=='LOCAL_NUMBERED'||!r.transfer||
        !['KGM','TNE'].includes(r.transfer.weightUnit)||!Array.isArray(r.transfer.quantities)) fail(409,'REPORT_CAPTURE_INTEGRITY');
      if(r.guideMetadata){
        const m=r.guideMetadata;guideArtifactWireScope(m.scope);
        if(m.source!=='SUNAT_PRIVATE_GUIDE_METADATA'||m.documentId!==r.id||m.fullNumber!==r.fullNumber||m.snapshotSha256!==r.snapshotSha256||
          !sha(m.metadataSha256)||!Number.isSafeInteger(m.ownerRevision)||m.ownerRevision<1||snapshotHash(m.scope.binding)!==snapshotHash(a!.binding))fail(409,'REPORT_CAPTURE_INTEGRITY');
      }
      decimal(r.transfer.grossWeight);for(const q of r.transfer.quantities){if(!/^[A-Z0-9]{1,10}$/.test(q.unitCode)) fail(409,'REPORT_CAPTURE_INTEGRITY');decimal(q.quantity);}
    }else{
      if(!['PEN','USD'].includes(r.currency??'')||r.payableAmount===null||r.transfer!==undefined) fail(409,'REPORT_CAPTURE_INTEGRITY');
      decimal(r.payableAmount);if(r.taxableAmount!==null)decimal(r.taxableAmount);if(r.igvAmount!==null)decimal(r.igvAmount);
      if(['07','08'].includes(r.type)&&(!b2bUuid(r.referenceDocumentId)||!['ISSUED','CANCELLED'].includes(r.local))) fail(409,'REPORT_CAPTURE_INTEGRITY');
      if(r.type==='NV'&&(!['COMPLETED','CONVERTED','CANCELLED'].includes(r.local)||r.local==='CONVERTED'&&!b2bUuid(r.convertedDocumentId))) fail(409,'REPORT_CAPTURE_INTEGRITY');
    }
  }
}
export const signedAmount=(r:ReportRow,v:string|null)=>v===null?null:decimalText(decimal(v)*(r.type==='07'?-1n:1n));
export function summary(c:ReportsCapture) {
  for(const row of c.rows)assertReportFinancialSeparation(row);
  const groups=new Map<string,{currency:string;type:string;local:string;count:number;payable:bigint;taxable:bigint;igv:bigint;taxableMissing:number;igvMissing:number}>();
  for(const r of c.rows.filter(r=>!r.transfer)) {
    const key=[r.currency,r.type,r.local].join(':'),sign=r.type==='07'?-1n:1n;
    const g=groups.get(key)??{currency:r.currency!,type:r.type,local:r.local,count:0,payable:0n,taxable:0n,igv:0n,taxableMissing:0,igvMissing:0};
    g.count++;g.payable+=decimal(r.payableAmount)*sign;
    if(r.taxableAmount===null) g.taxableMissing++;else g.taxable+=decimal(r.taxableAmount)*sign;
    if(r.igvAmount===null) g.igvMissing++;else g.igv+=decimal(r.igvAmount)*sign;
    groups.set(key,g);
  }
  const result={capturedAt:c.capturedAt,captureSha256:c.sha256,filters:c.filters,count:c.rows.length,
    groups:[...groups.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,g])=>({currency:g.currency,type:g.type,local:g.local,count:g.count,
      payableAmount:decimalText(g.payable),taxableAmount:g.taxableMissing?null:decimalText(g.taxable),
      igvAmount:g.igvMissing?null:decimalText(g.igv),missingTaxableCount:g.taxableMissing,missingIgvCount:g.igvMissing}))};
  if(!extended(c.filters))return result;
  const net=new Map<string,bigint>();
  for(const r of c.rows)if(['01','03','07','08'].includes(r.type)&&r.local==='ISSUED')net.set(r.currency!, (net.get(r.currency!)??0n)+decimal(r.payableAmount)*(r.type==='07'?-1n:1n));
  return {...result,coverage:c.filters.types.map(type=>({...reportTypeCapability(type),metadataCaptured:c.rows.some(r=>r.type===type&&!!r.guideMetadata),source:['09','31'].includes(type)?'BILLING_LOCAL_NUMBERED_GUIDE':type==='NV'?'BILLING_COMMERCIAL':'BILLING_DOCUMENT_LATEST',
    fiscalAcceptance:'NOT_ASSERTED',consistency:'OWNER_CAPTURE_NOT_A_CROSS_SOURCE_TRANSACTION'})),
    netSales:[...net].sort(([a],[b])=>a.localeCompare(b)).map(([currency,payable])=>({currency,payableAmount:decimalText(payable)})),
    transfers:c.rows.filter(r=>r.transfer).map(r=>({type:r.type,id:r.id,...r.transfer!}))};
}



