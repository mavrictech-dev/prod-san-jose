import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { B2bContractVersion } from '@factuez/contracts/b2b';
import { B2bSecurityError,b2bBindingsContain,validB2bBinding,type B2bIdentityScope,type B2bPrincipal } from '@factuez/contracts/b2b-security';
import { b2bDocumentFilters,b2bIssuerId,b2bQuery,b2bUuid } from '@factuez/contracts/b2b-read-query';
import { B2bOwnerReadFrame,type B2bIdentityPort } from '@factuez/service-access/dist/b2b-read-adapter';
import { B2bPrivateHttp } from '@factuez/service-access/dist/b2b';
import { snapshotHash } from '@factuez/service-access/dist/integration';
export interface B2bReadOwner {execute(token:string,kind:'SERVICE'|'USER',action:string,args:unknown):Promise<any>}
export interface B2bFileOwner extends B2bReadOwner {file(token:string,kind:'SERVICE'|'USER',action:string,args:unknown):Promise<{bytes:Buffer;sha256:string;fileName:string;mediaType:string}>}
export class HttpB2bReadOwner implements B2bFileOwner {
  constructor(private readonly http:B2bPrivateHttp,private readonly fiscal=false){}
  execute(token:string,kind:'SERVICE'|'USER',action:string,args:unknown){return this.http.post(this.fiscal?'/internal/b2b/fiscal-read':'/internal/b2b/read',{kind,action,args},token);}
  file(token:string,kind:'SERVICE'|'USER',action:string,args:unknown){if(!this.fiscal)throw new B2bSecurityError(400,'INVALID_OWNER');return this.http.file({kind,action,args},token);}
}
interface Cut {id:string;at:string;expires:number;context:string;items:any[];size:number}
export type B2bPhase7Capabilities = { guideIssuance:boolean; guideArtifacts:boolean; carrier:boolean; batches:boolean };
export type B2bPhase8Capabilities = {admin:boolean;business:boolean;receivedCommands:boolean;reports:boolean;history?:boolean;privileged?:boolean;automation?:boolean;email?:boolean};
export class B2bReads {
  private readonly cuts=new Map<string,Cut>();private readonly cursors=new Map<string,{cut:Cut;offset:number}>();
  constructor(private readonly identity:B2bIdentityPort,private readonly billing:B2bReadOwner,private readonly fiscal:B2bFileOwner,private readonly now=Date.now){}
  private frame(kind:'SERVICE'|'USER'){if(!['SERVICE','USER'].includes(kind))throw new B2bSecurityError(400,'INVALID_ACTOR_KIND');return new B2bOwnerReadFrame(this.identity,kind);}
  async me(token:string,kind:'SERVICE'|'USER'){
    const p=await this.frame(kind).principal(token,['b2b:context:read']);
    return {schemaVersion:B2bContractVersion,clientId:p.clientId,actor:p.kind==='SERVICE'?{kind:p.kind}:{kind:p.kind,subjectId:p.subjectId},effectiveScopes:p.scopes,grantRevision:String(p.revision),environment:'BETA'};
  }
  async capabilities(token:string,kind:'SERVICE'|'USER',query:unknown,draftCommandsConfigured=false,extractionConfigured=false,issuanceConfigured=false,webhooksConfigured=false,commercialConfigured=false,conversionConfigured=false,correctionsConfigured=false,guidesConfigured=false,preparationConfigured=false,phase7?:B2bPhase7Capabilities,receivedConfigured=false,phase8?:B2bPhase8Capabilities){
    b2bQuery(query,['environment'],['environment']);const p=await this.frame(kind).principal(token,['b2b:context:read']);
    return {schemaVersion:B2bContractVersion,environment:'BETA',fiscalActivation:false,executionReadiness:'NOT_PROBED',
      features:[...(['catalog','documents','artifacts'] as const).map(id=>({id,state:p.scopes.includes(`b2b:${id==='catalog'?'catalog':id}:read`)?'ENABLED':'DISABLED',reason:'Owner authorization and per-document availability still required'})),
        ...['document-drafts','operations'].map(id=>({id,state:!draftCommandsConfigured?'NOT_IMPLEMENTED':p.scopes.includes(id==='operations'?'b2b:operations:read':'b2b:drafts:write')?'ENABLED':'DISABLED',reason:'Versioned drafts consume no numbers; operations report local commits, never fiscal acceptance'})),
        ...['exports','changes'].map(id=>({id,state:!extractionConfigured?'NOT_IMPLEMENTED':p.scopes.includes(id==='changes'?'b2b:changes:read':'b2b:exports:read')||(id==='exports'&&p.scopes.includes('b2b:exports:create'))?'ENABLED':'DISABLED',reason:'Dedicated B2B persistence and owner journals required; no legacy token forwarding'})),
        {id:'issue',state:!issuanceConfigured?'DISABLED':p.scopes.includes('b2b:documents:issue')&&p.scopes.includes('b2b:drafts:write')?'ENABLED':'DISABLED',reason:'Explicit owner BETA profile, allowlisted issuer and validated revision required; commit is not SUNAT acceptance'},
        {id:'webhooks',state:!webhooksConfigured?'DISABLED':p.scopes.includes('b2b:webhooks:read')||p.scopes.includes('b2b:webhooks:manage')?'ENABLED':'DISABLED',reason:'Verified TI-approved destinations; only local 01/03 issuance events, never verified fiscal acceptance'},
        {id:'sales-notes',state:!commercialConfigured?'NOT_IMPLEMENTED':p.scopes.includes('b2b:sales-notes:read')||p.scopes.includes('b2b:sales-notes:write')?'ENABLED':'DISABLED',reason:'Independent non-fiscal aggregate and commercial numbering; no SUNAT document or financial ledger effect'},
        {id:'sales-note-conversion',state:commercialConfigured&&conversionConfigured&&p.scopes.includes('b2b:sales-notes:write')&&p.scopes.includes('b2b:documents:issue')?'ENABLED':'DISABLED',reason:'One atomic owner-local conversion to BETA 01/03; explicit issuer allowlist required'},
        {id:'correction-requests',state:!commercialConfigured?'NOT_IMPLEMENTED':p.scopes.includes('b2b:documents:read')&&(p.scopes.includes('b2b:corrections:read')||p.scopes.includes('b2b:corrections:write'))?'ENABLED':'DISABLED',reason:'Intent registry only; NC/ND/void fiscal execution remains blocked'},
        {id:'fiscal-corrections',state:'DISABLED',reason:'Official fiscal activation and rollout not enabled; candidate reservations do not authorize SUNAT transmission'},
        ...(correctionsConfigured?[{id:'correction-notes',state:p.scopes.includes('b2b:corrections:write')&&p.scopes.includes('b2b:documents:read')&&p.scopes.includes('b2b:documents:issue')?'ENABLED':'DISABLED',reason:'Candidate F07/F08 reservations and owner-verified journal; explicit paired grant and issuer profile required. No official transmission.'}]:[]),
        ...(guidesConfigured?[{id:'guide-drafts',state:p.scopes.includes('b2b:documents:read')&&(p.scopes.includes('b2b:guides:read')||p.scopes.includes('b2b:guides:write'))?'ENABLED':'DISABLED',reason:'Non-fiscal 09/31 draft planning only; explicit guide grants/metadata required. READY does not allocate numbers, verify references or authorize transport.'}]:[]),
        ...(preparationConfigured?[{id:'guide-preparation',state:p.scopes.includes('b2b:documents:read')&&p.scopes.includes('b2b:guides:read')?'ENABLED':'DISABLED',reason:'Read-only preflight of READY 09/private/04 drafts. Numbering, establishment/catalogue verification, signed XSD, PKI and transport remain blocked; 31 is not enabled.'}]:[]),
        ...([
          ['guide-numbered-local',phase7?.guideIssuance,['b2b:documents:read','b2b:guides:issue'],'Owned 09/private/04 numbering; three independent series grants and complete catalogues required. No official dispatch.'],
          ['carrier-guide-numbered-local',phase7?.carrier,['b2b:documents:read','b2b:guides:issue'],'Independent complete 31 contract and authenticated public 09 reference; not a relabelled private guide. No authorized transfer.'],
          ['guide-originals-local',phase7?.guideArtifacts,['b2b:documents:read','b2b:guides:read','b2b:guide-operations:read'],'Immutable original XML/ZIP and captured CDR for dedicated 09/31 operations. Missing CDR is not generated; official acceptance is not asserted.'],
          ['batch-operations-local',phase7?.batches,['b2b:batches:read'],'Durable RC1/2/3 and RA; every member and historical dependency must be authorized independently. No official transmission.'],
          ['batch-originals-local',phase7?.batches,['b2b:batches:read','b2b:artifacts:read'],'Owned RC/RA signed originals and captured local CDR; missing originals are never fabricated or labelled official.'],
        ] as const).map(([id,configured,required,reason])=>({id,state:!configured?'NOT_IMPLEMENTED':required.every(scope=>p.scopes.includes(scope as B2bIdentityScope))?'ENABLED':'DISABLED',reason})),
        {id:'received-documents',state:!receivedConfigured?'NOT_IMPLEMENTED':p.scopes.includes('b2b:received:read')?'ENABLED':'DISABLED',reason:'Independent incoming originals and per-item XML projection; recipient/branch grants required. No SIRE-only lines invented and no unassigned purchases exposed.'},
        {id:'received-originals',state:receivedConfigured&&p.scopes.includes('b2b:received:read')&&p.scopes.includes('b2b:received:artifacts:read')?'ENABLED':'DISABLED',reason:'Independent original downloads, not the emitted-document artifacts API. No SUNAT trust assertion.'},
        ...([
          ['customers',phase8?.business,['b2b:customers:read','b2b:customers:write']],
          ['business-products',phase8?.business,['b2b:products:read','b2b:products:write']],
          ['shifts-cash',phase8?.business,['b2b:shifts:read','b2b:shifts:write']],
          ['received-commands',phase8?.receivedCommands,['b2b:received:write']],
          ['reports',phase8?.reports,['b2b:reports:read']],
          ['history',phase8?.history,['b2b:history:read']],
          ['received-automation',phase8?.automation,['b2b:received:configure','b2b:received:sync']],
          ['email-deliveries',phase8?.email,['b2b:email:read','b2b:email:send']],
          ['privileged-administration',phase8?.privileged,['b2b:masters:manage','b2b:identity:manage','b2b:branding:manage','b2b:fiscal-config:read','b2b:fiscal-config:write','b2b:mail-config:manage']],
        ] as const).map(([id,configured,needed])=>({id,state:!configured?'NOT_IMPLEMENTED':id==='privileged-administration'&&p.kind!=='USER'?'DISABLED':needed.some(s=>p.scopes.includes(s))?'ENABLED':'DISABLED',reason:'Explicit owner enrollment and current resource permissions required; execution has not been probed.'})),
        {id:'integration-admin',state:!phase8?.admin?'NOT_IMPLEMENTED':p.kind==='USER'?'ENABLED':'DISABLED',reason:'Separate live human administrator and step-up authority; SERVICE has no administrative elevation.'}],
      ...(receivedConfigured?{receivedCoverage:{source:'RECEIVED_XML_ONLY',unassigned:false,sireOnlyFindings:false,officialTrust:false}}:{}),
      coverage:['01','03','07','08','09','31'].map(type=>({type,state:['01','03'].includes(type)?'SUPPORTED':'SOURCE_NOT_SUPPORTED'})),
      originalArtifacts:['UNSIGNED_XML','SIGNED_XML','SUBMISSION_ZIP','CDR_XML','CDR_ZIP'],localRepresentations:['a4','ticket'],
      limits:{pageSize:100,cutRows:10000,cutTtlSeconds:300,dateRangeDays:366},legacyExtraction:{separateAudience:true,forwarded:false}};
  }
  private cleanup(){for(const [id,cut]of this.cuts)if(cut.expires<=this.now())this.cuts.delete(id);for(const [id,cursor]of this.cursors)if(!this.cuts.has(cursor.cut.id))this.cursors.delete(id);}
  private externalDocument(value:any,p:B2bPrincipal){
    const b=value?.context,d=value?.document;
    if(!validB2bBinding(b)||!b2bBindingsContain(p.bindings,b)||!d||!b2bUuid(d.id)||d.environment!=='BETA'||d.issuerRuc!==b.issuerRuc||d.type!==b.documentType||d.branchId!==b.branchId||d.pointId!==b.pointId||d.seriesCounterId!==b.seriesId||d.snapshotSha256!==value.snapshotSha256)throw new B2bSecurityError(409,'INCONSISTENT_OWNER_RESPONSE');
    return {schemaVersion:B2bContractVersion,id:d.id,context:b,documentType:d.type,series:d.series,number:d.number,fullNumber:d.fullNumber,
      resourceVersion:d.resourceVersion,snapshotSha256:d.snapshotSha256,issuerName:d.issuerName,issueDate:d.issueDate,issueTime:d.issueTime,currency:d.currency,
      customer:d.customer,payableAmount:d.payableAmount,detail:d.detail,state:{local:d.state.local,transport:d.state.transport,fiscal:'NOT_VERIFIED',provenance:d.state.provenance},
      source:d.source,warnings:d.warnings};
  }
  async page(token:string,kind:'SERVICE'|'USER',resource:'issuers'|'branches'|'points'|'series'|'products'|'documents',query:unknown){
    const document=resource==='documents',keys=document?['issuerId','environment','from','to','types','branchId','pointId','seriesId','limit','cursor']:
      resource==='products'?['environment','limit','cursor']:['issuerId','environment','branchId','pointId','limit','cursor'];
    const q=b2bQuery(query,keys,document?['issuerId','environment','from','to']:resource==='issuers'||resource==='products'?['environment']:['issuerId','environment']);
    for(const key of ['branchId','pointId'])if(q[key]&&!b2bUuid(q[key]))throw new B2bSecurityError(400,'INVALID_QUERY');
    const issuer=q.issuerId?b2bIssuerId(q.issuerId):null;
    const limit=q.limit===undefined?50:Number(q.limit);if((q.limit!==undefined&&!/^[1-9][0-9]{0,2}$/.test(q.limit))||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new B2bSecurityError(400,'INVALID_QUERY');
    const frame=this.frame(kind),required:B2bIdentityScope[]=document?['b2b:documents:read']:['b2b:catalog:read'];
    const p=await frame.principal(token,required);if(issuer&&!p.bindings.some(binding=>binding.issuerId===issuer))throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');
    const context=snapshotHash({p,resource,query:{...q,cursor:null,limit:String(limit)}});this.cleanup();
    let cut:Cut,offset=0;
    if(q.cursor){
      if(!/^[A-Za-z0-9_-]{43}$/.test(q.cursor))throw new B2bSecurityError(400,'INVALID_CURSOR');
      const cursor=this.cursors.get(q.cursor);if(!cursor)throw new B2bSecurityError(410,'CURSOR_EXPIRED');
      if(cursor.cut.context!==context)throw new B2bSecurityError(409,'CURSOR_CONTEXT_CHANGED');cut=cursor.cut;offset=cursor.offset;
    }else{
      let items:any[];
      if(document){const {limit:_limit,cursor:_cursor,...filters}=q;const validated=b2bDocumentFilters(filters);const result=await this.billing.execute(token,kind,'capture',filters);if(!Array.isArray(result?.items))throw new B2bSecurityError(503,'OWNER_UNAVAILABLE');items=result.items.map((row:any)=>this.externalDocument(row,p));
        if(items.some(d=>d.context.issuerId!==validated.issuerId||!validated.types.includes(d.documentType)||d.issueDate<validated.from||d.issueDate>validated.to||(validated.branchId&&d.context.branchId!==validated.branchId)||(validated.pointId&&d.context.pointId!==validated.pointId)||(validated.seriesId&&d.context.seriesId!==validated.seriesId)))throw new B2bSecurityError(409,'INCONSISTENT_OWNER_RESPONSE');
      }
      else if(resource==='products'){const result=await this.billing.execute(token,kind,'products',{environment:'BETA'});if(!Array.isArray(result?.items))throw new B2bSecurityError(503,'OWNER_UNAVAILABLE');items=result.items.map((row:any)=>({id:row.id,sku:row.sku,description:row.description,unitCode:row.unitCode,taxAffectationCode:row.taxAffectationCode,defaultUnitPrice:row.defaultUnitPrice}));}
      else{
        const result=await this.billing.execute(token,kind,'catalog',{environment:'BETA'});if(!Array.isArray(result?.items))throw new B2bSecurityError(503,'OWNER_UNAVAILABLE');
        const selected=result.items.filter((row:any)=>{
          if(!validB2bBinding(row?.binding)||!b2bBindingsContain(p.bindings,row.binding))throw new B2bSecurityError(409,'INCONSISTENT_OWNER_RESPONSE');
          return (!issuer||row.binding.issuerId===issuer)&&(!q.branchId||row.binding.branchId===q.branchId)&&(!q.pointId||row.binding.pointId===q.pointId);
        });
        const mapped=selected.map((row:any)=>resource==='issuers'?{id:row.binding.issuerId,ruc:row.binding.issuerRuc,legalName:row.issuer.legalName,environment:'BETA'}:
          resource==='branches'?{id:row.binding.branchId,code:row.branch.code,name:row.branch.name,issuerId:row.binding.issuerId}:resource==='points'?{id:row.binding.pointId,code:row.point.code,name:row.point.name,issuerId:row.binding.issuerId,branchId:row.binding.branchId}:
            {id:row.binding.seriesId,label:row.series.label,type:row.binding.documentType,issuerId:row.binding.issuerId,branchId:row.binding.branchId,pointId:row.binding.pointId});
        const unique=new Map<string,any>();for(const row of mapped){const key=String(row.id);if(unique.has(key)&&snapshotHash(unique.get(key))!==snapshotHash(row))throw new B2bSecurityError(409,'INCONSISTENT_OWNER_RESPONSE');unique.set(key,row);}items=[...unique.values()];
      }
      const size=Buffer.byteLength(JSON.stringify(items));
      if(items.length>10000||size>16*1024*1024)throw new B2bSecurityError(413,'NARROW_QUERY');
      if(this.cuts.size>=64||this.cursors.size>=4096||[...this.cuts.values()].reduce((n,item)=>n+item.size,0)+size>64*1024*1024)throw new B2bSecurityError(429,'RATE_LIMITED');
      cut={id:randomUUID(),at:new Date(this.now()).toISOString(),expires:this.now()+300000,context,items:structuredClone(items),size};this.cuts.set(cut.id,cut);
    }
    await frame.principal(token,required);
    const hasMore=offset+limit<cut.items.length;let nextCursor:string|null=null;
    if(hasMore){if(this.cursors.size>=4096)throw new B2bSecurityError(429,'RATE_LIMITED');nextCursor=randomBytes(32).toString('base64url');this.cursors.set(nextCursor,{cut,offset:offset+limit});}
    return {schemaVersion:B2bContractVersion,items:structuredClone(cut.items.slice(offset,offset+limit)),page:{limit,nextCursor,snapshotId:cut.id,snapshotAt:cut.at,expiresAt:new Date(cut.expires).toISOString(),hasMore,complete:!hasMore},
      coverage:{documentTypes:['01','03'],unsupported:['07','08','09','31'],scope:'AUTHORIZED_FILTERED_CUT',fiscalAcceptance:'NOT_ASSERTED'}};
  }
  async document(token:string,kind:'SERVICE'|'USER',id:string|null,query:unknown,status=false){
    const q=b2bQuery(query,id?['issuerId','environment']:['issuerId','environment','type','series','number'],id?['issuerId','environment']:['issuerId','environment','type','series','number']);
    b2bIssuerId(q.issuerId);if(id&&!b2bUuid(id))throw new B2bSecurityError(400,'INVALID_ID');
    const frame=this.frame(kind),p=await frame.principal(token,['b2b:documents:read']);
    const result=await this.billing.execute(token,kind,id?'document':'lookup',{...q,...(id?{id}:{})}),document=this.externalDocument(result,p);
    if(document.context.issuerId!==Number(q.issuerId)||(id&&document.id!==id))throw new B2bSecurityError(409,'INCONSISTENT_OWNER_RESPONSE');await frame.principal(token,['b2b:documents:read']);
    return status?{schemaVersion:B2bContractVersion,documentId:document.id,...document.state}:document;
  }
  async artifacts(token:string,kind:'SERVICE'|'USER',id:string,query:unknown,batch=false){
    const q=b2bQuery(query,['issuerId','environment'],['issuerId','environment']);b2bIssuerId(q.issuerId);if(!b2bUuid(id))throw new B2bSecurityError(400,'INVALID_ID');
    const frame=this.frame(kind);await frame.principal(token,['b2b:documents:read','b2b:artifacts:read']);
    const value=await this.fiscal.execute(token,kind,batch?'batch-artifacts':'artifacts',{...q,id});
    if(!Array.isArray(value?.items)||value.items.length>32)throw new B2bSecurityError(503,'OWNER_UNAVAILABLE');
    // Closed projection: storage paths/keys and internal snapshot bodies never cross the facade.
    const items=value.items.map((item:any)=>{
      if(!b2bUuid(item.id)||!['UNSIGNED_XML','SIGNED_XML','SUBMISSION_ZIP','CDR_XML','CDR_ZIP'].includes(item.kind)||item.representation!=='ORIGINAL'||!Number.isSafeInteger(item.byteLength)||item.byteLength<1||item.byteLength>10*1024*1024||!/^[a-f0-9]{64}$/.test(item.sha256))throw new B2bSecurityError(409,'INCONSISTENT_OWNER_RESPONSE');
      if(!item.owner||!['DOCUMENT','BATCH'].includes(item.owner.kind)||!b2bUuid(item.owner.id)||(!batch&&item.owner.kind==='DOCUMENT'&&item.owner.id!==id)||(batch&&(item.owner.kind!=='BATCH'||item.owner.id!==id))||!safeFile(item.fileName,item.mediaType)||item.availability!=='AVAILABLE')throw new B2bSecurityError(409,'INCONSISTENT_OWNER_RESPONSE');
      return {id:item.id,kind:item.kind,owner:{kind:item.owner.kind,id:item.owner.id},fileName:item.fileName,mediaType:item.mediaType,byteLength:item.byteLength,sha256:item.sha256,availability:'AVAILABLE',representation:'ORIGINAL',provenance:'LOCAL',verification:{integrity:'UNVERIFIED',signature:'UNVERIFIED',trust:'UNVERIFIED',identity:'UNVERIFIED',checkedAt:null}};
    });
    await frame.principal(token,['b2b:documents:read','b2b:artifacts:read']);return {schemaVersion:B2bContractVersion,items,warnings:['SIGNATURE_TRUST_AND_FISCAL_ACCEPTANCE_UNVERIFIED']};
  }
  async content(token:string,kind:'SERVICE'|'USER',id:string,query:unknown,format?:string){
    const q=b2bQuery(query,['issuerId','environment'],['issuerId','environment']);b2bIssuerId(q.issuerId);if(!b2bUuid(id)||(format!==undefined&&!['a4','ticket'].includes(format)))throw new B2bSecurityError(400,'INVALID_QUERY');
    const frame=this.frame(kind);await frame.principal(token,['b2b:documents:read','b2b:artifacts:read']);
    const file=await this.fiscal.file(token,kind,format?'pdf':'content',{...q,id,...(format?{format}:{})});
    if(!Buffer.isBuffer(file.bytes)||file.bytes.length<1||file.bytes.length>10*1024*1024||!safeFile(file.fileName,file.mediaType)||createHash('sha256').update(file.bytes).digest('hex')!==file.sha256||(format!==undefined&&file.mediaType!=='application/pdf')||(format===undefined&&file.mediaType==='application/pdf'))throw new B2bSecurityError(409,'INTEGRITY_FAILED');
    await frame.principal(token,['b2b:documents:read','b2b:artifacts:read']);return file;
  }
}
function safeFile(name:unknown,mime:unknown){
  if(typeof name!=='string'||!/^[A-Za-z0-9_-]{1,150}\.(xml|zip|pdf)$/.test(name))return false;
  return mime===({'xml':'application/xml','zip':'application/zip','pdf':'application/pdf'} as Record<string,string>)[name.split('.').at(-1)!];
}
