import { B2bSecurityError, b2bBindingsContain, validB2bCorrectionBinding, type B2bCorrectionBinding, type B2bIdentityScope, type B2bPrincipal } from '@factuez/contracts/b2b-security';
import { validB2bGuideIssueBinding, type B2bGuideIssueBinding } from '@factuez/contracts/b2b-guide-security';
import { snapshotHash } from '@factuez/service-access/dist/integration';
import { mapBillingDocument } from '../../integration/read';
import { calculateDocumentTotals } from '../../application/totals';
import { draftBody } from '../draft-validation';
import { validateGuideIssueReceipt } from '../guide-issue-producer';
import { validateCarrierIssuance } from '../carrier-guide-model';
import type { ReportsAccess, ReportsOwnerSourceStore, ReportsSupplementalSources, ReportsCorrectionReadAuthority, ReportsGuideReadAuthority } from './source-types';
import { reportActor } from './source-types';
import type { ReportsGuideMetadataReadPort } from './guide-metadata-http';
import type { ReportRow, ReportsAuth, ReportsCapture, ReportsFilters } from './types';
import { accessAnchor, accessKey, accessSeries, accessType, decimal, decimalText, fail, limits, matches, sha, validAccess } from './validation';
export function reportsSourceScopes(f:ReportsFilters):B2bIdentityScope[] {
  return [...new Set<B2bIdentityScope>([
    ...(f.types.some(t=>['07','08'].includes(t))?['b2b:corrections:read' as const]:[]),
    ...(f.types.some(t=>['09','31'].includes(t))?['b2b:guides:read' as const,'b2b:guide-operations:read' as const]:[]),
    ...(f.types.includes('NV')?['b2b:sales-notes:read' as const]:[]),
  ])];
}
type Configuration={
  corrections?:{bindings:readonly B2bCorrectionBinding[];authority:ReportsCorrectionReadAuthority};
  guides?:{bindings:readonly B2bGuideIssueBinding[];authority09?:ReportsGuideReadAuthority;authority31?:ReportsGuideReadAuthority;metadata?:ReportsGuideMetadataReadPort};
  salesNotes?:boolean;
};
const actorKey=(p:B2bPrincipal)=>p.kind+':'+(p.subjectId??'-');
const same=(a:unknown,b:unknown)=>{try{return snapshotHash(a)===snapshotHash(b);}catch{return false;}};
const amount=(v:unknown)=>v==null?null:decimalText(decimal(v));
/** Explicit local Billing source adapter. It makes no acceptance claim.
 * Configuration enumerates candidate bindings, never permission grants. */
export class BillingOwnerReportSources implements ReportsSupplementalSources {
  private readonly configuration:Configuration;
  constructor(private readonly store:ReportsOwnerSourceStore,configuration:Configuration){
    this.configuration={...configuration,
      ...(configuration.corrections?{corrections:{...configuration.corrections,bindings:structuredClone([...configuration.corrections.bindings])}}:{}),
      ...(configuration.guides?{guides:{...configuration.guides,bindings:structuredClone([...configuration.guides.bindings])}}:{})};
    if((configuration.corrections?.bindings.length??0)+(configuration.guides?.bindings.length??0)>500||
      this.configuration.corrections?.bindings.some(b=>!validB2bCorrectionBinding(b))||
      this.configuration.guides?.bindings.some(b=>!validB2bGuideIssueBinding(b)))fail(400,'INVALID_REPORT_SOURCE_CONFIGURATION');
  }
  private async check(auth:ReportsAuth,p:B2bPrincipal,a:ReportsAccess):Promise<ReportsAccess>{
    if(!validAccess(a)||!b2bBindingsContain(p.bindings,accessAnchor(a)))fail(404,'RESOURCE_NOT_FOUND');
    if(a.kind==='SALES_NOTE'){if(this.configuration.salesNotes!==true)fail(422,'SOURCE_NOT_SUPPORTED');return structuredClone(a);}
    let proof:any;
    if(a.kind==='CORRECTION'){
      const config=this.configuration.corrections;
      if(!config?.bindings.some(b=>same(b,a.binding)))fail(404,'RESOURCE_NOT_FOUND');
      if(!config.authority?.current)fail(503,'REPORT_CORRECTION_READ_AUTHORITY_REQUIRED');
      try{proof=await config.authority.current(auth.token,auth.kind,structuredClone(a.binding));}
      catch(error){if(error instanceof B2bSecurityError)throw error;fail(503,'REPORT_SOURCE_AUTHORITY_UNAVAILABLE');}
      if(proof?.action!=='READ'||!same(proof.actor,reportActor(p)))fail(503,'INVALID_REPORT_SOURCE_AUTHORIZATION');
    }else{
      const config=this.configuration.guides;
      if(!config?.bindings.some(b=>same(b,a.binding)))fail(404,'RESOURCE_NOT_FOUND');
      const authority=a.binding.draft.guideType==='09'?config.authority09:config.authority31;
      if(!authority?.current)fail(503,'REPORT_GUIDE_READ_AUTHORITY_REQUIRED');
      try{proof=await authority.current(auth.token,auth.kind,structuredClone(a.binding),'READ');}
      catch(error){if(error instanceof B2bSecurityError)throw error;fail(503,'REPORT_SOURCE_AUTHORITY_UNAVAILABLE');}
      if(!proof?.actor?.b2b||!same(proof.actor.b2b,reportActor(p)))fail(503,'INVALID_REPORT_SOURCE_AUTHORIZATION');
    }
    if(!proof||!same(proof.binding,a.binding)||proof.clientRevision!==p.revision||
      !Number.isSafeInteger(proof.grantRevision)||proof.grantRevision<1)fail(503,'INVALID_REPORT_SOURCE_AUTHORIZATION');
    return {...structuredClone(a),grantRevision:proof.grantRevision} as ReportsAccess;
  }
  private scopes(p:B2bPrincipal,f:ReportsFilters){if(reportsSourceScopes(f).some(s=>!p.scopes.includes(s)))fail(403,'SCOPE_REQUIRED');}
  async authorize(auth:ReportsAuth,p:B2bPrincipal,c:ReportsCapture){
    this.scopes(p,c.filters);
    for(const a of c.access??[]){
      const current=await this.check(auth,p,a);
      if(current.grantRevision!==a.grantRevision)fail(401,'ACCESS_CHANGED');
    }
    for(const row of c.rows??[])if(row.guideMetadata){
      if(!this.configuration.guides?.metadata)fail(503,'REPORT_GUIDE_METADATA_NOT_CONFIGURED');
      await this.configuration.guides.metadata.recheck(auth,p,row.guideMetadata);
    }
  }
  async capture(auth:ReportsAuth,p:B2bPrincipal,f:ReportsFilters){
    this.scopes(p,f);const candidates:ReportsAccess[]=[
      ...(this.configuration.corrections?.bindings??[]).map(binding=>({kind:'CORRECTION' as const,binding,grantRevision:1})),
      ...(this.configuration.guides?.bindings??[]).map(binding=>({kind:'GUIDE' as const,binding,grantRevision:1})),
      ...(this.configuration.salesNotes?p.bindings.map(binding=>({kind:'SALES_NOTE' as const,binding,grantRevision:null})):[]),
    ];
    const selected=candidates.filter(a=>f.types.includes(accessType(a))&&matches(accessAnchor(a),f)&&b2bBindingsContain(p.bindings,accessAnchor(a))&&
      (!f.seriesId||accessSeries(a)===f.seriesId));
    for(const type of f.types.filter(t=>!['01','03'].includes(t)))if(!selected.some(a=>accessType(a)===type))fail(422,'REPORT_SOURCE_NOT_CONFIGURED');
    if(selected.length>500||new Set(selected.map(accessKey)).size!==selected.length)fail(400,'INVALID_REPORT_SOURCE_CONFIGURATION');
    const access:ReportsAccess[]=[];for(const a of selected)access.push(await this.check(auth,p,a));
    const result=await this.store.capture(p,f,structuredClone(access));
    if(!Array.isArray(result.records)||result.records.length>limits.rows||Buffer.byteLength(JSON.stringify(result))>limits.captureBytes)fail(413,'NARROW_QUERY');
    const rows:ReportRow[]=[];
    for(const record of result.records){
      const a=access.find(a=>same(a,record.access));
      if(!a)fail(409,'REPORT_CAPTURE_INVALID');
      const row=this.project(p,f,a,record.value);
      if(a.kind==='GUIDE'&&this.configuration.guides?.metadata){
        row.guideMetadata=await this.configuration.guides.metadata.read(auth,p,{
          binding:structuredClone(a.binding),draftId:record.value.header.draftId,operationId:record.value.header.operationId
        },{documentId:row.id,fullNumber:row.fullNumber,snapshotSha256:row.snapshotSha256});
      }
      rows.push(row);
    }
    // Empty captures retain paired permissions too.
    await this.authorize(auth,p,{filters:f,access,rows} as ReportsCapture);
    return {capturedAt:result.capturedAt,rows,access};
  }
  private project(p:B2bPrincipal,f:ReportsFilters,a:ReportsAccess,value:any):ReportRow {
    const binding=accessAnchor(a),common={context:structuredClone(binding),accessKey:accessKey(a)};
    if(a.kind==='CORRECTION'){
      const readPrincipal={clientId:p.clientId,revision:p.revision,environment:'BETA' as const,scopes:['integration:documents:read' as const],grants:[{
        issuerRuc:binding.issuerRuc,environment:'BETA' as const,documentTypes:[binding.documentType,a.binding.noteType],
        branches:{kind:'IDS' as const,ids:[binding.branchId]},points:{kind:'IDS' as const,ids:[binding.pointId]},
        series:{kind:'IDS' as const,ids:[binding.seriesId,a.binding.noteSeriesId]}}]};
      const d=mapBillingDocument(value.document,readPrincipal,binding.issuerRuc).document;
      const original=mapBillingDocument(value.original,readPrincipal,binding.issuerRuc).document;
      if(!sha(d.snapshotSha256)||!sha(d.resourceVersion)||d.detail.kind!=='SALE'||typeof d.issuedAt!=='string'||typeof d.issueDate!=='string'||typeof d.fullNumber!=='string')fail(409,'REPORT_CAPTURE_INVALID');
      const ref=value.document.immutableSnapshot.reference,totals=d.detail.totals;
      if(d.type!==a.binding.noteType||d.seriesCounterId!==a.binding.noteSeriesId||original.type!==binding.documentType||
        original.seriesCounterId!==binding.seriesId||ref.documentId!==original.id||ref.documentTypeCode!==original.type||ref.fullNumber!==original.fullNumber||
        d.currency!==original.currency||!['PEN','USD'].includes(d.currency??'')||!['ISSUED','CANCELLED'].includes(d.state.local??'')||
        d.issueDate<f.from||d.issueDate>f.to)fail(409,'REPORT_CAPTURE_INVALID');
      return {...common,id:d.id,type:a.binding.noteType,snapshotSha256:d.snapshotSha256,resourceVersion:d.resourceVersion,
        issuedAt:d.issuedAt,issueDate:d.issueDate,fullNumber:d.fullNumber,currency:d.currency as 'PEN'|'USD',local:d.state.local as 'ISSUED'|'CANCELLED',
        payableAmount:decimalText(decimal(d.payableAmount)),taxableAmount:amount(totals.taxableAmount),igvAmount:amount(totals.igvAmount),referenceDocumentId:original.id};
    }
    if(a.kind==='SALES_NOTE'){
      const r=value.resource,b=draftBody(r.body);
      if(r.kind!=='SALES_NOTE'||r.environment!=='BETA'||r.clientId!==p.clientId||r.actorKey!==actorKey(p)||!same(r.binding,binding)||
        b.issuerId!==binding.issuerId||b.branchId!==binding.branchId||b.pointId!==binding.pointId||b.seriesId!==binding.seriesId||b.documentType!==binding.documentType||
        !['COMPLETED','CONVERTED','CANCELLED'].includes(r.state)||!sha(r.completedSha256)||snapshotHash(r.body)!==r.completedSha256||
        !Number.isSafeInteger(r.revision)||r.revision<1||b.issueDate<f.from||b.issueDate>f.to||
        r.state==='CONVERTED'&&typeof r.convertedDocumentId!=='string')fail(409,'REPORT_CAPTURE_INVALID');
      const totals=calculateDocumentTotals(b.lines).totals;
      return {...common,id:r.id,type:'NV',snapshotSha256:r.completedSha256,
        resourceVersion:snapshotHash({id:r.id,revision:r.revision,state:r.state,body:r.completedSha256,convertedDocumentId:r.convertedDocumentId}),
        issuedAt:b.issueDate+'T00:00:00-05:00',issueDate:b.issueDate,fullNumber:r.commercialNumber,currency:b.currency,
        local:r.state,payableAmount:decimalText(decimal(totals.payableAmount)),taxableAmount:amount(totals.taxableAmount),igvAmount:amount(totals.igvAmount),
        convertedDocumentId:r.convertedDocumentId};
    }
    const carrier=a.binding.draft.guideType==='31',h=value.header,r=value.receipt;
    let s:any,hash:string;
    if(carrier){
      const response=validateCarrierIssuance(r.response);s=response.snapshot;hash=response.snapshotSha256;
      if(r.clientId!==p.clientId||r.actorKey!==actorKey(p))fail(404,'RESOURCE_NOT_FOUND');
    }else{
      const receipt=validateGuideIssueReceipt(r,{binding:a.binding,draftId:h.draftId,clientId:p.clientId,actorKey:actorKey(p),keySha256:r.keySha256});
      s=receipt.snapshot;hash=receipt.snapshotSha256;
    }
    if(!same(s.binding,a.binding)||!same(h.binding,s.binding)||h.companyId!==binding.issuerId||h.issuerRuc!==binding.issuerRuc||
      (carrier?h.documentId:h.id)!==s.documentId||h.operationId!==s.operationId||h.draftId!==s.draftId||
      h.draftSeriesId!==a.binding.draft.guideSeriesId||h.fiscalSeriesId!==a.binding.fiscalSeriesId||
      h.series!==s.series||String(h.number)!==s.number||h.snapshotSha256!==hash||!same(h.snapshot,s)||
      !same(value.items,s.body.items)||!Array.isArray(value.events)||value.events.length!==1||
      value.events[0].operationId!==s.operationId||value.events[0].eventType!==(carrier?'carrier.guide.issue.prepared.local.v1':'guide.issue.prepared.local.v1')||
      !same(value.events[0].payload,s))fail(409,'REPORT_CAPTURE_INVALID');
    const issueDay=new Date(Date.parse(s.body.issueDate)-5*3600000).toISOString().slice(0,10);
    if(issueDay<f.from||issueDay>f.to)fail(409,'REPORT_CAPTURE_INVALID');
    const quantities=new Map<string,bigint>();
    for(const item of s.body.items)quantities.set(item.unitCode,(quantities.get(item.unitCode)??0n)+decimal(item.quantity));
    return {...common,id:s.documentId,type:a.binding.draft.guideType,snapshotSha256:hash,resourceVersion:snapshotHash({snapshot:hash,local:'LOCAL_NUMBERED'}),
      issuedAt:s.body.issueDate,issueDate:issueDay,fullNumber:s.fullNumber,currency:null,local:'LOCAL_NUMBERED',
      payableAmount:null,taxableAmount:null,igvAmount:null,transfer:{grossWeight:decimalText(decimal(s.body.grossWeight)),weightUnit:s.body.weightUnit,
        quantities:[...quantities].sort(([a],[b])=>a.localeCompare(b)).map(([unitCode,quantity])=>({unitCode,quantity:decimalText(quantity)}))}};
  }
}








