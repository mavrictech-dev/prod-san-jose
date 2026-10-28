import {historyUuid,historicalSha256,validateHistoricalSnapshot,type HistoricalDocumentSnapshotV1} from '@factuez/history-core';
import {summarizeHistoricalSelection,compareHistoricalTotals} from '@factuez/history-core/dist/reconciliation';
import {EVIDENCE_POLICY,EvidenceError,evidenceAssert,bindSyntheticBusinessXml,compareEvidenceValues} from './xml';
import {isProxy} from 'node:util/types';
import {createHash} from 'node:crypto';
type Entry={snapshot:HistoricalDocumentSnapshotV1;xml:string|null};
const identity=(s:HistoricalDocumentSnapshotV1)=>JSON.stringify([s.issuer.ruc,s.ownership.documentTypeCode,s.ownership.series,s.number]);
const business=(s:HistoricalDocumentSnapshotV1)=>{const{artifacts,sourceEvidence,...rest}=s;return rest;};
/** Read-only selection comparison; notes remain positive, separated by type. No ledger/net-sales inference. */
export function reconcileSyntheticEvidence(input:unknown) {
  function detachedRecord(value:unknown,keys:string[]){evidenceAssert(value&&typeof value==='object'&&!isProxy(value)&&
    [Object.prototype,null].includes(Object.getPrototypeOf(value)),'INVALID_RECORD');
    evidenceAssert(Reflect.ownKeys(value).length===keys.length,'INVALID_FIELDS');const result:Record<string,any>=Object.create(null);
    for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);evidenceAssert(d?.enumerable&&'value' in d,'INVALID_FIELDS');result[key]=d.value;}return result;}
  const data=detachedRecord(input,['schemaVersion','environment','datasetClass','runId','legacy','factuez']);
  evidenceAssert(data.schemaVersion==='factuez.evidence-reconciliation-input.v1'&&data.environment==='BETA'&&data.datasetClass==='SYNTHETIC','PROFILE_BLOCKED');
  const runId=historyUuid(data.runId);
  let xmlBytes=0;
  function entries(values:unknown):Entry[]{evidenceAssert(Array.isArray(values)&&!isProxy(values)&&Object.getPrototypeOf(values)===Array.prototype&&values.length<=2000,'RECONCILIATION_LIMIT');
    const results:Entry[]=[];evidenceAssert(Reflect.ownKeys(values).length===values.length+1,'INVALID_ARRAY');
    for(let index=0;index<values.length;index++){const d=Object.getOwnPropertyDescriptor(values,String(index));evidenceAssert(d?.enumerable&&'value' in d,'INVALID_ARRAY');
      const v=detachedRecord(d.value,['snapshot','xml']);evidenceAssert(v.xml===null||typeof v.xml==='string'&&Buffer.byteLength(v.xml)<=1024*1024,'XML_INPUT');
      xmlBytes+=v.xml===null?0:Buffer.byteLength(v.xml);evidenceAssert(xmlBytes<=32*1024*1024,'XML_BATCH_LIMIT');results.push({snapshot:validateHistoricalSnapshot(v.snapshot),xml:v.xml});}
    return results;}
  const legacy=entries(data.legacy),factuez=entries(data.factuez),legacySummary=summarizeHistoricalSelection(legacy.map(e=>e.snapshot)),factuezSummary=summarizeHistoricalSelection(factuez.map(e=>e.snapshot));
  const totals=compareHistoricalTotals(factuez.map(e=>e.snapshot),{schemaVersion:'factuez.history-expected-totals.v1',environment:'BETA',datasetClass:'SYNTHETIC',groups:legacySummary.groups});
  const a=new Map(legacy.map(e=>[identity(e.snapshot),e])),b=new Map(factuez.map(e=>[identity(e.snapshot),e]));
  type Issue={id:string;documentIdentity:string;side:'LEGACY'|'FACTUEZ'|'BOTH';code:string;path:string;expected:unknown;observed:unknown};
  const issues:Issue[]=[];let issueCount=0,documentsMatched=0,xmlBindingsMatched=0,xmlMissing=0,xmlInvalid=0;
  const documentResults:Array<{documentIdentity:string;presentInLegacy:boolean;presentInFactuez:boolean;businessMatch:boolean;xmlBindingsMatch:boolean}> = [];
  function issue(documentIdentity:string,side:Issue['side'],code:string,path:string,expected:unknown,observed:unknown){
    issueCount++;if(issues.length<200)issues.push({id:historicalSha256({documentIdentity,side,code,path,expected,observed}),documentIdentity,side,code,path,expected,observed});}
  for(const key of [...new Set([...a.keys(),...b.keys()])].sort()){
    const left=a.get(key),right=b.get(key);let businessMatch=false,xmlBindingsMatch=true;
    if(!left||!right)issue(key,'BOTH','DOCUMENT_MISSING','presence',left?'PRESENT':null,right?'PRESENT':null);
    else {const comparison=compareEvidenceValues(business(left.snapshot),business(right.snapshot));businessMatch=comparison.match;
      if(businessMatch)documentsMatched++;for(const d of comparison.differences)issue(key,'BOTH','BUSINESS_DIFFERENCE',d.path,d.expected,d.observed);
      // Preserve full count even where examples are bounded.
      issueCount+=comparison.differenceCount-comparison.differences.length;}
    for(const [side,e] of [['LEGACY',left],['FACTUEZ',right]] as const){if(!e)continue;
      if(e.xml===null){xmlMissing++;xmlBindingsMatch=false;issue(key,side,'XML_MISSING','xml','REQUIRED',null);continue;}
      try{const bound=bindSyntheticBusinessXml(e.xml,e.snapshot);if(bound.binding.match)xmlBindingsMatched++;else xmlBindingsMatch=false;
        for(const d of bound.binding.differences)issue(key,side,'XML_BINDING_DIFFERENCE',d.path,d.expected,d.observed);
        issueCount+=bound.binding.differenceCount-bound.binding.differences.length;}
      catch(error){xmlInvalid++;xmlBindingsMatch=false;issue(key,side,'XML_UNREADABLE','xml',null,error instanceof EvidenceError?error.code:'INVALID_XML_EVIDENCE');}}
    documentResults.push({documentIdentity:key,presentInLegacy:!!left,presentInFactuez:!!right,businessMatch,xmlBindingsMatch});
  }
  const entryHash=(values:Entry[])=>historicalSha256(values.map(e=>({snapshot:e.snapshot,xmlSha256:e.xml===null?null:createHash('sha256').update(e.xml).digest('hex')})));
  return {schemaVersion:'factuez.evidence-reconciliation-report.v1' as const,...EVIDENCE_POLICY,runId,inputSha256:historicalSha256({runId,...EVIDENCE_POLICY,legacySha256:entryHash(legacy),factuezSha256:entryHash(factuez)}),
    status:issueCount||!totals.match?'DIFFERENCES_REQUIRE_REVIEW':'MATCH_REQUIRES_ACCOUNTING_REVIEW',
    legacySummary,factuezSummary,totals,documentResults,documentsMatched,xmlBindingsMatched,xmlMissing,xmlInvalid,
    issueCount,issues,issuesTruncated:issueCount>issues.length,
    remainingEvidence:['SIGNATURE_CDR_PKI_PER_DOCUMENT','PDF_QR_PER_DOCUMENT','AUTHORIZED_REAL_CAPTURE','ACCOUNTING_APPROVAL','CUTOVER_APPROVAL'],
    allFiscalGatesRemainBlocked:true as const};
}
export type EvidenceReconciliationReport=ReturnType<typeof reconcileSyntheticEvidence>;
/** CSV is neutralized against spreadsheet formula injection, even for a synthetic description. */
export function reconciliationIssuesCsv(report:EvidenceReconciliationReport) {
  const value=(v:unknown)=>{let s=typeof v==='string'?v:JSON.stringify(v);s=s??'';if(/^[\s]*[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  const fields=['id','documentIdentity','side','code','path','expected','observed'] as const;
  return [fields.map(value).join(','),...report.issues.map(i=>fields.map(f=>value(i[f])).join(','))].join('\r\n')+'\r\n';
}
