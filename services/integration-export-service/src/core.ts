import { createHash, randomUUID } from 'node:crypto';
import { IntegrationContractVersion, IntegrationErrors, IntegrationLimits,
  parseIntegrationDocumentFilters, parseIntegrationExportRequest, integrationGrantAllows,
  type IntegrationDocumentDetailV1, type IntegrationPageV1, type IntegrationDocumentRowV1,
  type IntegrationExportJobV1, type IntegrationExportManifestV1, type IntegrationArtifactV1,
  type IntegrationScope, type IntegrationBatchV1, type IntegrationErrorCode } from '@factuez/contracts/integration';
import { deny, plain, ruc, uuid, requireIssuer, requireScopes, snapshotHash, IntegrationReadError,
  type ReadPrincipal, type ReadIdentity, type BillingReadEnvelope } from '@factuez/service-access/dist/integration';
import { ExportVault } from './vault';
import { buildExportArchive } from './archive';
import { IntegrationChanges } from './changes';
import { ExportQuotas, type Binding, type CapturedSnapshot, type ExportPayload, type ExportRecord, type ExportStore, type OwnerHttp } from './model';
const sha=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
const aad=(r:ExportRecord,kind='payload')=>`factuez.export.v1:${kind}:${r.id}:${r.clientId}:${r.contextSha256}`;
export const binding=(d:IntegrationDocumentDetailV1):Binding=>({id:d.id,branchId:d.branchId,pointId:d.pointId,
  seriesCounterId:d.seriesCounterId,type:d.type,snapshotSha256:d.snapshotSha256});
const batchIdentity=(b:IntegrationBatchV1)=>snapshotHash({id:b.id,issuerRuc:b.issuerRuc,environment:b.environment,kind:b.kind,
  identifier:b.identifier,membersComplete:b.membersComplete,members:b.members.map(({documentVersion,...member})=>member)});
const queryFrom=(filters:any)=>Object.fromEntries(Object.entries(filters).filter(([,v])=>v!==null && v!==undefined)
  .map(([k,v])=>[k,Array.isArray(v)?v.join(','):String(v)]));
const exportScopes=(operation:'create'|'read',files:boolean):IntegrationScope[]=>['integration:documents:read',
  operation==='create'?'integration:exports:create':'integration:exports:read',...(files?['integration:artifacts:read' as const]:[])];
export class IntegrationExports {
  constructor(private readonly store:ExportStore,private readonly vault:ExportVault,private readonly identity:ReadIdentity,
    private readonly billing:OwnerHttp,private readonly sunat:OwnerHttp,private readonly now=()=>Date.now(),private readonly feed:IntegrationChanges|null=null) {}
  changes(token:string,query:unknown) {if(!this.feed)return deny(503,'CHANGE_FEED_NOT_READY');return this.feed.page(token,query);}
  async changesReady(token:string,issuerRuc:string) {return this.feed?this.feed.ready(token,issuerRuc):false;}
  private async principal(token:string,scopes:IntegrationScope[],issuerRuc?:string) {
    const p=await this.identity.authenticate(token,scopes);requireScopes(p,scopes);if(issuerRuc) requireIssuer(p,issuerRuc);return p;
  }
  private payload(r:ExportRecord) {if(!r.payload) return deny(409,'CONSISTENT_READ_UNAVAILABLE');return this.vault.openJson<ExportPayload>(r.payload,aad(r));}
  private record(p:ReadPrincipal,issuerRuc:string,kind:'CUT'|'EXPORT',keyHash:string|null=null,requestSha256:string|null=null):ExportRecord {
    return {id:randomUUID(),kind,clientId:p.clientId,contextSha256:snapshotHash(p),issuerRuc,keyHash,requestSha256,
      createdAt:new Date(this.now()).toISOString(),expiresAt:new Date(this.now()+(kind==='CUT'?IntegrationLimits.cursorTtlSeconds*1000:ExportQuotas.captureTtlMs)).toISOString(),
      state:'CAPTURING',payload:null,content:null,contentSha256:null,manifestSha256:null,failureCode:null,lease:null};
  }
  private async reauthorize(token:string,r:ExportRecord,data:ExportPayload,scopes:IntegrationScope[]) {
    const p=await this.principal(token,scopes,r.issuerRuc);
    if(p.clientId!==r.clientId) return deny(404,'RESOURCE_NOT_FOUND');
    if(snapshotHash(p)!==r.contextSha256) return deny(409,'CURSOR_CONTEXT_CHANGED');
    if(data.documents.some(d=>!integrationGrantAllows(p.grants,d))) return deny(404,'RESOURCE_NOT_FOUND');
    const result=await this.billing.json<{valid:true}>('/internal/integration/reauthorize',token,{issuerRuc:r.issuerRuc,bindings:data.bindings});
    if(result.valid!==true) return deny(409,'INCOMPLETE_BINDING');
    for(const b of data.batches) {
      const current=await this.sunat.json<IntegrationBatchV1>(`/internal/integration/batches/${b.id}?issuerRuc=${r.issuerRuc}`,token);
      if(batchIdentity(current)!==b.identitySha256) return deny(409,'EVIDENCE_INCONSISTENT');
    }
    const final=await this.principal(token,scopes,r.issuerRuc);
    if(snapshotHash(final)!==r.contextSha256) return deny(401,'UNAUTHENTICATED');return final;
  }
  private async capture(token:string,p:ReadPrincipal,filters:ExportPayload['filters'],id:string):Promise<ExportPayload> {
    const sunatBarrier=this.feed?await this.feed.beforeCapture(token,p,filters.issuerRuc):null;
    const c=await this.billing.json<CapturedSnapshot>('/internal/integration/capture',token,queryFrom({...filters,limit:null,cursor:null}));
    if(!Array.isArray(c.documents) || c.documents.length>ExportQuotas.documents || !plain(c.coverage) || !Array.isArray(c.coverage.types) ||
      !Number.isFinite(Date.parse(c.snapshotAt)) || new Set(c.documents.map(d=>d.id)).size!==c.documents.length) return deny(409,'EVIDENCE_INCONSISTENT');
    for(const d of c.documents) if(!uuid(d.id) || d.issuerRuc!==filters.issuerRuc || !integrationGrantAllows(p.grants,d) ||
      !d.snapshotSha256 || !/^[a-f0-9]{64}$/.test(d.snapshotSha256) || !['01','03','07','08'].includes(d.type)) return deny(409,'INCOMPLETE_BINDING');
    const changeCheckpoint=this.feed?this.feed.finishCapture(p,filters,c.changeBarrier,sunatBarrier):null;
    return {...c,documents:structuredClone(c.documents),filters,snapshotId:id,request:null,changeCheckpoint,
      bindings:c.documents.map(binding),batches:[],artifacts:[],missingArtifacts:[]};
  }
  async documents(token:string,query:unknown):Promise<IntegrationPageV1<IntegrationDocumentRowV1>> {
    let filters;try{filters=parseIntegrationDocumentFilters(query);}catch{return deny(400,'INVALID_QUERY');}
    if(!ruc(filters.issuerRuc)) return deny(400,'INVALID_QUERY');
    const p=await this.principal(token,['integration:documents:read'],filters.issuerRuc);
    const context=snapshotHash({...filters,cursor:null});let record:ExportRecord,offset=0;
    if(filters.cursor) {
      if(filters.cursor.length>4096) return deny(400,'INVALID_QUERY');
      let cursor:any;try{cursor=this.vault.openJson(Buffer.from(filters.cursor,'base64url'),'factuez.cursor.v1');}catch{return deny(400,'INVALID_QUERY');}
      if(!plain(cursor) || !uuid(cursor.id) || !Number.isSafeInteger(cursor.offset) || cursor.offset<0 || cursor.offset>ExportQuotas.documents ||
        typeof cursor.context!=='string') return deny(400,'INVALID_QUERY');
      if(cursor.context!==context) return deny(409,'CURSOR_CONTEXT_CHANGED');
      const row=await this.store.get(cursor.id,p.clientId);if(!row || row.kind!=='CUT' || Date.parse(row.expiresAt)<=this.now()) return deny(410,'CURSOR_EXPIRED');
      record=row;offset=cursor.offset;
    } else {
      const candidate=this.record(p,filters.issuerRuc,'CUT');record=(await this.store.reserve(candidate)).record;
      try {const data=await this.capture(token,p,filters,record.id);
        await this.reauthorize(token,record,data,['integration:documents:read']);record.payload=this.vault.sealJson(data,aad(record));
        await this.store.captured(record.id,record.payload,'READY');record.state='READY';
      }catch(e){await this.store.fail(record.id,this.safeFailure(e));throw e;}
    }
    const data=this.payload(record);
    if(snapshotHash({...data.filters,cursor:null})!==context) return deny(409,'CURSOR_CONTEXT_CHANGED');
    await this.reauthorize(token,record,data,['integration:documents:read']);
    const hasMore=offset+filters.limit<data.documents.length;
    const nextCursor=hasMore?this.vault.sealJson({id:record.id,offset:offset+filters.limit,context},'factuez.cursor.v1').toString('base64url'):null;
    await this.store.audit({clientId:p.clientId,revision:p.revision,recordId:record.id,operation:'LIST',sha256:null,byteLength:null});
    return {schemaVersion:IntegrationContractVersion,items:data.documents.slice(offset,offset+filters.limit).map(({detail,...row})=>row),
      coverage:data.coverage,page:{limit:filters.limit,nextCursor,snapshotId:record.id,snapshotAt:data.snapshotAt,
        expiresAt:record.expiresAt,hasMore,changeCheckpoint:data.changeCheckpoint??null}};
  }
  async detail(token:string,id:string,snapshotId:string,issuerRuc:string) {
    if(!uuid(id)||!uuid(snapshotId)||!ruc(issuerRuc)) return deny(400,'INVALID_QUERY');
    const p=await this.principal(token,['integration:documents:read'],issuerRuc),r=await this.store.get(snapshotId.toLowerCase(),p.clientId);
    if(!r || r.issuerRuc!==issuerRuc) return deny(404,'RESOURCE_NOT_FOUND');
    if(Date.parse(r.expiresAt)<=this.now() || r.state==='EXPIRED') return deny(410,'SNAPSHOT_EXPIRED');
    const data=this.payload(r);await this.reauthorize(token,r,data,['integration:documents:read']);
    const document=data.documents.find(d=>d.id===id.toLowerCase());if(!document) return deny(404,'RESOURCE_NOT_FOUND');
    await this.store.audit({clientId:p.clientId,revision:p.revision,recordId:r.id,operation:'DETAIL',sha256:document.snapshotSha256,byteLength:null});return document;
  }
  async create(token:string,key:string,body:unknown):Promise<IntegrationExportJobV1> {
    if(typeof key!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(key)) return deny(400,'INVALID_REQUEST');
    let request;try{request=parseIntegrationExportRequest(body);}catch{return deny(400,'INVALID_REQUEST');}
    request.artifactKinds.sort();if(!ruc(request.filters.issuerRuc)) return deny(400,'INVALID_REQUEST');
    const scopes=exportScopes('create',request.artifactKinds.length>0),p=await this.principal(token,scopes,request.filters.issuerRuc);
    const keyHash=sha(Buffer.from(key)),requestSha256=snapshotHash({request,context:snapshotHash(p)});
    const previous=await this.store.byKey(p.clientId,keyHash);
    if(previous) {
      if(previous.requestSha256!==requestSha256) return deny(409,'IDEMPOTENCY_CONFLICT');
      return this.reuse(token,previous,scopes);
    }
    const reservation=await this.store.reserve(this.record(p,request.filters.issuerRuc,'EXPORT',keyHash,requestSha256)),r=reservation.record;
    if(!reservation.created) {
      if(r.requestSha256!==requestSha256) return deny(409,'IDEMPOTENCY_CONFLICT');return this.reuse(token,r,scopes);
    }
    try {
      const filters=parseIntegrationDocumentFilters(queryFrom(request.filters));
      const data=await this.capture(token,p,filters,r.id);data.request=request;
      if(!data.coverage.complete && request.missingArtifacts==='FAIL') return deny(422,'SOURCE_NOT_SUPPORTED');
      await this.captureArtifacts(token,p,data);
      await this.reauthorize(token,r,data,scopes);
      r.payload=this.vault.sealJson(data,aad(r));await this.store.captured(r.id,r.payload,'QUEUED');r.state='QUEUED';
      await this.store.audit({clientId:p.clientId,revision:p.revision,recordId:r.id,operation:'CREATE',sha256:null,byteLength:null});
      return this.job(r,data);
    }catch(e){await this.store.fail(r.id,this.safeFailure(e));throw e;}
  }
  private async reuse(token:string,r:ExportRecord,scopes:IntegrationScope[]) {
    if(Date.parse(r.expiresAt)<=this.now() || r.state==='EXPIRED') return deny(410,'EXPORT_EXPIRED');
    const data=r.payload?this.payload(r):undefined,p=data?await this.reauthorize(token,r,data,scopes):await this.principal(token,scopes,r.issuerRuc);
    if(p.clientId!==r.clientId) return deny(404,'RESOURCE_NOT_FOUND');
    if(snapshotHash(p)!==r.contextSha256) return deny(409,'CURSOR_CONTEXT_CHANGED');
    await this.store.audit({clientId:p.clientId,revision:p.revision,recordId:r.id,operation:'CREATE',sha256:null,byteLength:null});
    return this.job(r,data);
  }
  private safeFailure(error:unknown):IntegrationErrorCode {return error instanceof IntegrationReadError && IntegrationErrors.includes(error.code)?error.code:'UPSTREAM_UNAVAILABLE';}
  private async captureArtifacts(token:string,p:ReadPrincipal,data:ExportPayload) {
    const request=data.request!;if(!request.artifactKinds.length) return;
    const deadline=this.now()+240000;let size=Buffer.byteLength(JSON.stringify(data.documents));
    let associations=0;
    for(const d of data.documents) {
      if(this.now()>deadline) return deny(503,'CONSISTENT_READ_UNAVAILABLE');
      let inventory:{items:IntegrationArtifactV1[]};
      try{inventory=await this.sunat.json(`/internal/integration/documents/${d.id}/artifacts?issuerRuc=${d.issuerRuc}`,token);}
      catch(e){if(e instanceof IntegrationReadError && e.code==='ARTIFACT_UNAVAILABLE') inventory={items:[]};else throw e;}
      if(!Array.isArray(inventory.items)||inventory.items.length>100) return deny(409,'EVIDENCE_INCONSISTENT');
      for(const kind of request.artifactKinds) {
        const matches=inventory.items.filter(a=>a.kind===kind);
        if(matches.length>1) return deny(409,'EVIDENCE_INCONSISTENT');
        const a=matches[0];
        if(!a || a.availability!=='AVAILABLE') {
          const code=kind.includes('PDF')?'SOURCE_NOT_SUPPORTED':'ARTIFACT_UNAVAILABLE';
          if(request.missingArtifacts==='FAIL') return deny(code==='SOURCE_NOT_SUPPORTED'?422:409,code);
          data.missingArtifacts.push({documentId:d.id,kind,code});continue;
        }
        if(!uuid(a.id)||!uuid(a.owner?.id)||!['DOCUMENT','BATCH'].includes(a.owner.kind)||a.representation!=='ORIGINAL'||
          !a.sha256||!/^[a-f0-9]{64}$/.test(a.sha256)||!a.byteLength||a.byteLength>10*1024*1024||
          !['application/xml','application/zip'].includes(a.mediaType)) return deny(409,'EVIDENCE_INCONSISTENT');
        if(a.owner.kind==='DOCUMENT' && a.owner.id!==d.id) return deny(409,'INCOMPLETE_BINDING');
        if(a.owner.kind==='BATCH' && !data.batches.some(b=>b.id===a.owner.id)) {
          const b=await this.sunat.json<IntegrationBatchV1>(`/internal/integration/batches/${a.owner.id}?issuerRuc=${d.issuerRuc}`,token);
          if(b.id!==a.owner.id || b.issuerRuc!==d.issuerRuc||b.environment!=='BETA'||!b.membersComplete||!b.members.length||b.members.length>10000||
            !b.members.some(m=>m.documentId===d.id)||new Set(b.members.map(m=>m.documentId)).size!==b.members.length) return deny(409,'INCOMPLETE_BINDING');
          for(const member of b.members) if(!data.bindings.some(v=>v.id===member.documentId)) {
            const {document}=await this.billing.json<BillingReadEnvelope>(`/internal/integration/documents/${member.documentId}?issuerRuc=${d.issuerRuc}`,token);
            if(document.id!==member.documentId || document.issuerRuc!==d.issuerRuc || !integrationGrantAllows(p.grants,document)) return deny(404,'RESOURCE_NOT_FOUND');
            data.bindings.push(binding(document));if(data.bindings.length>10000) return deny(422,'EXPORT_TOO_LARGE');
          }
          associations+=b.members.length;
          if(associations>ExportQuotas.associations) return deny(422,'EXPORT_TOO_LARGE');
          data.batches.push({id:b.id,identitySha256:batchIdentity(b),documentIds:b.members.map(m=>m.documentId)});
        }
        const existing=data.artifacts.find(f=>f.metadata.id===a.id);
        if(existing) {
          if(snapshotHash(existing.metadata)!==snapshotHash(a)) return deny(409,'EVIDENCE_INCONSISTENT');
          if(!existing.documentIds.includes(d.id)) existing.documentIds.push(d.id);continue;
        }
        size+=a.byteLength;
        if(size>ExportQuotas.packageBytes-1024*1024 || data.artifacts.length>=10000) return deny(422,'EXPORT_TOO_LARGE');
        const response=await this.sunat.bytes(`/internal/integration/artifacts/${a.id}/content?issuerRuc=${d.issuerRuc}`,token,10*1024*1024);
        if(response.bytes.length!==a.byteLength || sha(response.bytes)!==a.sha256 || response.headers['x-content-sha256']!==a.sha256 ||
          response.headers['content-type']!==a.mediaType) return deny(409,'INTEGRITY_FAILED');
        // Re-observe inventory after bytes: never silently switch an artifact revision during capture.
        const check=await this.sunat.json<{items:IntegrationArtifactV1[]}>(`/internal/integration/documents/${d.id}/artifacts?issuerRuc=${d.issuerRuc}`,token);
        const final=check.items.find(v=>v.id===a.id);
        if(!final || snapshotHash(final)!==snapshotHash(a)) return deny(409,'EVIDENCE_INCONSISTENT');
        const documentIds=a.owner.kind==='BATCH'?data.batches.find(b=>b.id===a.owner.id)!.documentIds:[d.id];
        associations+=documentIds.length;
        if(associations>ExportQuotas.associations) return deny(422,'EXPORT_TOO_LARGE');
        data.artifacts.push({metadata:a,bytesBase64:response.bytes.toString('base64'),documentIds:[...documentIds]});
      }
    }
  }
  private job(r:ExportRecord,data?:ExportPayload):IntegrationExportJobV1 {
    return {schemaVersion:IntegrationContractVersion,id:r.id,state:r.state==='CAPTURING'?'QUEUED':r.state,
      createdAt:r.createdAt,expiresAt:r.state==='READY'?r.expiresAt:null,snapshotId:data?.snapshotId??null,
      snapshotAt:data?.snapshotAt??null,changeCheckpoint:data?.changeCheckpoint??null,documentCount:data?.documents.length??null,
      complete:r.state==='READY' && !!data?.manifest?.complete,failureCode:r.failureCode,manifestSha256:r.manifestSha256};
  }
  private async authorizedJob(token:string,id:string,issuerRuc:string,includeContent=false) {
    if(!uuid(id)||!ruc(issuerRuc)) return deny(400,'INVALID_QUERY');
    const p=await this.principal(token,exportScopes('read',false),issuerRuc),r=await this.store.get(id.toLowerCase(),p.clientId,includeContent);
    if(!r || r.kind!=='EXPORT' || r.issuerRuc!==issuerRuc) return deny(404,'RESOURCE_NOT_FOUND');
    if(Date.parse(r.expiresAt)<=this.now() || r.state==='EXPIRED') return deny(410,'EXPORT_EXPIRED');
    if(r.contextSha256!==snapshotHash(p)) return deny(409,'CURSOR_CONTEXT_CHANGED');
    const data=r.payload?this.payload(r):undefined;
    if(data) await this.reauthorize(token,r,data,exportScopes('read',!!data.request?.artifactKinds.length));
    else if(r.state==='CAPTURING') return deny(409,'CONSISTENT_READ_UNAVAILABLE');
    return {p,r,data};
  }
  async status(token:string,id:string,issuerRuc:string) {
    const {p,r,data}=await this.authorizedJob(token,id,issuerRuc);
    await this.store.audit({clientId:p.clientId,revision:p.revision,recordId:r.id,operation:'STATUS',sha256:null,byteLength:null});return this.job(r,data);
  }
  async manifest(token:string,id:string,issuerRuc:string) {
    const {p,r,data}=await this.authorizedJob(token,id,issuerRuc);
    if(r.state!=='READY'||!data?.manifest) return deny(409,'CONSISTENT_READ_UNAVAILABLE');
    const bytes=Buffer.from(JSON.stringify(data.manifest));if(sha(bytes)!==r.manifestSha256) return deny(409,'INTEGRITY_FAILED');
    await this.store.audit({clientId:p.clientId,revision:p.revision,recordId:r.id,operation:'MANIFEST',sha256:r.manifestSha256,byteLength:bytes.length});return data.manifest;
  }
  async content(token:string,id:string,issuerRuc:string) {
    const {p,r,data}=await this.authorizedJob(token,id,issuerRuc,true);
    if(r.state!=='READY'||!r.content||!data?.manifest) return deny(409,'CONSISTENT_READ_UNAVAILABLE');
    const bytes=this.vault.open(r.content,aad(r,'content'));
    if(bytes.length>ExportQuotas.packageBytes || sha(bytes)!==r.contentSha256) return deny(409,'INTEGRITY_FAILED');
    await this.reauthorize(token,r,data,exportScopes('read',!!data.request?.artifactKinds.length));
    await this.store.audit({clientId:p.clientId,revision:p.revision,recordId:r.id,operation:'DOWNLOAD',sha256:r.contentSha256,byteLength:bytes.length});
    return {bytes,sha256:r.contentSha256!,fileName:`factuez-export-${r.id}.zip`,mediaType:'application/zip'};
  }
  /** Durable database queue. Worker consumes only encrypted captured facts, NEVER a bearer or owner credentials. */
  async runOne():Promise<boolean> {
    const r=await this.store.claim(new Date(this.now()).toISOString());if(!r) return false;
    try {
      if(!r.lease) return deny(409,'CONSISTENT_READ_UNAVAILABLE');
      const data=this.payload(r),request=data.request;if(!request) return deny(409,'EVIDENCE_INCONSISTENT');
      const files=[{path:'documents.jsonl',bytes:Buffer.from(data.documents.map(d=>JSON.stringify(d)).join('\n')+(data.documents.length?'\n':''))}];
      const index:IntegrationExportManifestV1['files']=[{path:'documents.jsonl',sha256:sha(files[0].bytes),byteLength:files[0].bytes.length,
        artifactId:null,owner:null,documentIds:data.documents.map(d=>d.id)}];
      for(const f of data.artifacts) {
        const bytes=Buffer.from(f.bytesBase64,'base64'),a=f.metadata;
        if(bytes.length!==a.byteLength||sha(bytes)!==a.sha256) return deny(409,'INTEGRITY_FAILED');
        const path=`artifacts/${a.id}.${a.mediaType==='application/xml'?'xml':'zip'}`;files.push({path,bytes});
        index.push({path,sha256:a.sha256!,byteLength:bytes.length,artifactId:a.id,owner:a.owner,documentIds:f.documentIds});
      }
      const createdAt=new Date(this.now()).toISOString(),expiresAt=new Date(this.now()+IntegrationLimits.exportTtlSeconds*1000).toISOString();
      data.manifest={schemaVersion:'factuez.integration.export-manifest.v1',exportId:r.id,environment:'BETA',dataset:'ISSUED_BUSINESS',
        filters:request.filters,snapshotId:data.snapshotId,snapshotAt:data.snapshotAt,changeCheckpoint:data.changeCheckpoint??null,createdAt,expiresAt,
        documentCount:data.documents.length,requestedArtifactKinds:request.artifactKinds,missingArtifactsPolicy:request.missingArtifacts,
        complete:data.coverage.complete && !data.missingArtifacts.length,coverage:data.coverage,files:index,missingArtifacts:data.missingArtifacts};
      const manifestBytes=Buffer.from(JSON.stringify(data.manifest));files.push({path:'manifest.json',bytes:manifestBytes});
      const bytes=buildExportArchive(files,ExportQuotas.packageBytes);
      // Discard the staging copies once packaged; the frozen manifest/metadata remain encrypted with the snapshot.
      data.artifacts=data.artifacts.map(f=>({...f,bytesBase64:''}));
      await this.store.ready(r.id,r.lease,this.vault.sealJson(data,aad(r)),this.vault.seal(bytes,aad(r,'content')),sha(bytes),sha(manifestBytes),expiresAt);
    }catch(e){await this.store.fail(r.id,this.safeFailure(e),r.lease??undefined);}return true;
  }
  sweep() {return this.store.sweep(new Date(this.now()).toISOString());}
}
