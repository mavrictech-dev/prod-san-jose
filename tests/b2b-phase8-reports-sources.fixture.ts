import { B2bSecurityError } from '../packages/contracts/src/b2b-security';
import { guideIssueFixture } from './helpers/guide-issue.fixture';
import { carrierGuideHttpFixture } from './helpers/carrier-guide-http.fixture';
import { vi } from 'vitest';
import { B2bReports, BillingOwnerReportSources } from '../services/billing-service/src/b2b/phase8-reports';
import type { ReportsAccess, ReportsSourceRecord, ReportsRenderers } from '../services/billing-service/src/b2b/phase8-reports';
import { snapshotHash } from '../packages/service-access/src/integration';
import { reportActor } from '../services/billing-service/src/b2b/phase8-reports/source-types';
import { accessKey } from '../services/billing-service/src/b2b/phase8-reports/validation';
import { reportsFixture,binding } from './b2b-phase8-reports.fixture';
import { sale } from './integration-read.fixture';
import { draftInput } from './b2b-drafts.fixture';
export const sourceId=(n:number)=>`90000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export function reportsSourcesFixture(renderers?:ReportsRenderers){
  const f=reportsFixture(),original=sale(),records:ReportsSourceRecord[]=[];
  const control={grantRevision:1,revoked:false};
  f.p.scopes.push('b2b:corrections:read','b2b:sales-notes:read','b2b:guides:read','b2b:guide-operations:read');
  const pairs=(['07','08'] as const).map((noteType,i)=>({reference:structuredClone(binding),noteSeriesId:sourceId(i+1),noteType}));
  original.id=sourceId(10);original.immutableSnapshot.documentId=original.id;
  for(const [i,pair] of pairs.entries()){
    const d=sale(pair.noteType,sourceId(i+20));d.seriesCounter.id=pair.noteSeriesId;
    d.immutableSnapshot.reference.documentId=original.id;d.immutableSnapshot.reference.fullNumber=original.fullNumber;
    records.push({access:{kind:'CORRECTION',binding:pair,grantRevision:1},value:{document:d,original:structuredClone(original)}});
  }
  const body={...draftInput(),issuerId:binding.issuerId,branchId:binding.branchId,pointId:binding.pointId,seriesId:binding.seriesId,issueDate:'2026-01-01'};
  const nv={id:sourceId(30),environment:'BETA',kind:'SALES_NOTE',clientId:f.p.clientId,actorKey:'SERVICE:-',binding:structuredClone(binding),
    body,state:'COMPLETED',revision:2,commercialNumber:'NV-00000001',completedSha256:snapshotHash(body),convertedDocumentId:null};
  records.push({access:{kind:'SALES_NOTE',binding:structuredClone(binding),grantRevision:null},value:{resource:nv}});
  const store={capture:vi.fn(async(_p:any,_filters:any,access:ReportsAccess[])=>({
    capturedAt:'2026-10-25T20:00:00.000Z',records:records.filter(r=>access.some(a=>accessKey(a)===accessKey(r.access))).map(r=>{
      const copy=JSON.parse(JSON.stringify(r,(_key,value)=>typeof value==='bigint'?value.toString():value));copy.access=structuredClone(access.find(a=>accessKey(a)===accessKey(r.access))!);return copy;
    }),
  }))};
  const correctionAuthority={current:vi.fn(async(_t:any,_k:any,b:any)=>{
    if(control.revoked)throw new B2bSecurityError(403,'TEST_REVOKED');
    return {action:'READ' as const,binding:structuredClone(b),actor:reportActor(f.p),clientRevision:f.p.revision,grantRevision:control.grantRevision};
  })};
  const guideBindings:any[]=[];
  const guideAuthority={current:vi.fn(async(_t:any,_k:any,b:any,_a:any)=>{
    if(control.revoked)throw new B2bSecurityError(403,'TEST_REVOKED');
    return {binding:structuredClone(b),actor:{b2b:reportActor(f.p)},clientRevision:f.p.revision,grantRevision:control.grantRevision};
  })};
  const config=()=>({corrections:{bindings:pairs,authority:correctionAuthority},
    guides:{bindings:guideBindings,authority09:guideAuthority,authority31:guideAuthority},salesNotes:true});
  const sources=()=>new BillingOwnerReportSources(store,config());
  const core=()=>new B2bReports(f.store,f.identity,f.port,{enabled:true,sources:sources(),renderers});
  const filters=(types='07,08,NV')=>({issuerId:'1',environment:'BETA',from:'2026-01-01',to:'2026-01-02',types});
  const input=(types='07,08,NV',format='CSV')=>({filters:filters(types),format,idempotencyKey:'synthetic_report_sources_001'});
  return {...f,core,sources,configuration:config,sourceStore:store,records,pairs,nv,original,control,correctionAuthority,guideAuthority,guideBindings,filters,input};
}



export async function reportsGuideSourcesFixture(type:'09'|'31',renderers?:any){
  const f=reportsSourcesFixture(renderers);let s:any,receipt:any,hash:string;
  if(type==='09'){
    const g=guideIssueFixture();await g.issue();receipt=structuredClone(g.state().receipts[0]);s=receipt.snapshot;hash=receipt.snapshotSha256;
    f.p.clientId=receipt.clientId;
  }else{
    const g=carrierGuideHttpFixture();s=g.issuance.snapshot;hash=g.issuance.snapshotSha256;
    receipt={clientId:f.p.clientId,actorKey:'SERVICE:-',response:g.issuance};
  }
  f.p.bindings=[structuredClone(s.binding.draft.anchor)];f.guideBindings.push(s.binding);
  const header={id:s.documentId,documentId:s.documentId,operationId:s.operationId,draftId:s.draftId,
    companyId:s.binding.draft.anchor.issuerId,issuerRuc:s.issuer.ruc,draftSeriesId:s.binding.draft.guideSeriesId,
    fiscalSeriesId:s.binding.fiscalSeriesId,binding:s.binding,series:s.series,number:s.number,snapshot:s,snapshotSha256:hash};
  f.records.splice(0,f.records.length,{access:{kind:'GUIDE',binding:s.binding,grantRevision:1},value:{header,receipt,items:s.body.items,
    events:[{operationId:s.operationId,eventType:type==='09'?'guide.issue.prepared.local.v1':'carrier.guide.issue.prepared.local.v1',payload:s}]}});
  const day=type==='09'?'2026-10-21':'2026-10-23';
  const filters={...f.filters(type),from:day,to:day};
  const input={...f.input(type),filters};return {...f,input,guideSnapshot:s};
}



