import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { IntegrationContractVersion, IntegrationDocumentTypes, IntegrationLimits, integrationGrantAllows,
  type IntegrationCapabilitiesV1, type IntegrationPageV1, type IntegrationScope } from '@factuez/contracts/integration';
import { deny, readQuery, requireIssuer, requireScopes, snapshotHash, uuid, type ReadPrincipal, type ReadIdentity,
  PrivateReadHttp, type BillingReadEnvelope } from '@factuez/service-access/dist/integration';
import { changeQuery } from '@factuez/service-access/dist/integration-change-query';
export interface OwnerHttp { json<T>(path:string,token:string,body?:unknown):Promise<T>; bytes(path:string,token:string,maximum?:number,body?:unknown):Promise<{bytes:Buffer;headers:Record<string,unknown>}> }
interface Catalog {issuer:{issuerRuc:string;environment:'BETA'};branches:any[];points:any[];observedAt:string}
interface Cut {id:string;at:string;expires:number;context:string;items:any[];size:number}
const scopes:{[key:string]:IntegrationScope[]}={catalog:['integration:catalog:read'],document:['integration:documents:read'],
  artifacts:['integration:documents:read','integration:artifacts:read']};
export class IntegrationReads {
  private readonly cursors=new Map<string,{cut:Cut;offset:number}>();
  private readonly cuts=new Map<string,Cut>();
  constructor(private readonly identity:ReadIdentity,private readonly billing:OwnerHttp,private readonly sunat:OwnerHttp,
    private readonly now=()=>Date.now(),private readonly exports?:OwnerHttp) {}
  private async principal(token:string,kind:keyof typeof scopes,issuerRuc?:string) {
    const p=await this.identity.authenticate(token,scopes[kind]);requireScopes(p,scopes[kind]);if (issuerRuc) requireIssuer(p,issuerRuc);return p;
  }
  async capabilities(token:string,query:unknown):Promise<IntegrationCapabilitiesV1> {
    const q=readQuery(query,['issuerRuc','environment']);const p=await this.principal(token,'catalog',q.issuerRuc);
    await this.billing.json(`/internal/integration/catalog?issuerRuc=${q.issuerRuc}`,token);
    let consistent=false,changes=false;
    if(this.exports) {const status=await this.exports.json<{ready:true;changes?:string}>(`/internal/integration/export-capabilities?issuerRuc=${q.issuerRuc}`,token);
      consistent=status.ready===true;changes=status.changes==='READY';}
    return {schemaVersion:IntegrationContractVersion,environment:'BETA',dataset:'ISSUED_BUSINESS',apiState:'ENABLED',
      types:IntegrationDocumentTypes.map(type=>({type,readState:!['01','03','07','08'].includes(type)?'UNSUPPORTED':
        p.grants.some(g=>g.issuerRuc===q.issuerRuc && g.documentTypes.includes(type))?'READY':'PREPARED_BLOCKED',
        originalArtifacts:['01','03','07','08'].includes(type)&&p.scopes.includes('integration:artifacts:read')&&p.grants.some(g=>g.issuerRuc===q.issuerRuc&&g.documentTypes.includes(type)),
        reasonCode:!['01','03','07','08'].includes(type)?'SOURCE_NOT_SUPPORTED':p.grants.some(g=>g.issuerRuc===q.issuerRuc&&g.documentTypes.includes(type))?null:'INSUFFICIENT_SCOPE'})),
      consistency:consistent?'SNAPSHOT_READY':'NOT_READY',changes:changes?'READY':'NOT_READY',limits:IntegrationLimits};
  }
  private cleanup() {
    for (const [id,cut] of this.cuts) if (cut.expires<=this.now()) this.cuts.delete(id);
    for (const [id,cursor] of this.cursors) if (!this.cuts.has(cursor.cut.id)) this.cursors.delete(id);
  }
  async catalog(token:string,kind:'issuers'|'branches'|'points',query:unknown):Promise<IntegrationPageV1<any>> {
    const q=readQuery(query,kind==='points'?['issuerRuc','environment','branchId','limit','cursor']:
      kind==='branches'?['issuerRuc','environment','limit','cursor']:['environment','limit','cursor'],kind==='issuers'?[]:kind==='points'?['issuerRuc','branchId']:['issuerRuc']);
    if (q.branchId && !uuid(q.branchId)) return deny(400,'INVALID_QUERY');
    const limit=q.limit===undefined?IntegrationLimits.defaultPageSize:Number(q.limit);
    if ((q.limit!==undefined&&!/^[1-9]\d{0,2}$/.test(q.limit)) || !Number.isSafeInteger(limit) || limit>IntegrationLimits.maxPageSize)
      return deny(400,'INVALID_QUERY');
    const p=await this.principal(token,'catalog',q.issuerRuc);
    const context=snapshotHash({p,kind,query:{...q,cursor:null,limit:String(limit)}});this.cleanup();
    let cut:Cut,offset=0;
    if (q.cursor) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(q.cursor)) return deny(400,'INVALID_QUERY');
      const cursor=this.cursors.get(q.cursor);if (!cursor) return deny(410,'CURSOR_EXPIRED');
      if (cursor.cut.context!==context) return deny(409,'CURSOR_CONTEXT_CHANGED');
      cut=cursor.cut;offset=cursor.offset;
    } else {
      const allowed=kind==='issuers'?[...new Set(p.grants.filter(g=>[g.branches,g.points,g.series].every(s=>s.kind==='ALL'||s.ids.length)).map(g=>g.issuerRuc))].sort():[q.issuerRuc];
      const items:any[]=[];
      for (const ruc of allowed) {
        const c=await this.billing.json<Catalog>(`/internal/integration/catalog?issuerRuc=${ruc}`,token);
        if (c.issuer?.issuerRuc!==ruc || c.issuer.environment!=='BETA' || !Array.isArray(c.branches) || !Array.isArray(c.points))
          return deny(503,'UPSTREAM_UNAVAILABLE');
        items.push(...(kind==='issuers'?[c.issuer]:kind==='branches'?c.branches:c.points.filter(point=>point.branchId===q.branchId)));
      }
      if (items.length>10000) return deny(503,'CONSISTENT_READ_UNAVAILABLE');
      const size=Buffer.byteLength(JSON.stringify(items));
      if (this.cuts.size>=64 || this.cursors.size>=2048 || size>16*1024*1024 || [...this.cuts.values()].reduce((n,c)=>n+c.size,0)+size>64*1024*1024)
        return deny(429,'RATE_LIMITED');
      cut={id:randomUUID(),at:new Date(this.now()).toISOString(),expires:this.now()+IntegrationLimits.cursorTtlSeconds*1000,
        context,items:structuredClone(items),size};this.cuts.set(cut.id,cut);
    }
    const hasMore=offset+limit<cut.items.length;
    let nextCursor:string|null=null;
    if (hasMore) {
      if (this.cursors.size>=2048) return deny(429,'RATE_LIMITED');
      nextCursor=randomBytes(32).toString('base64url');this.cursors.set(nextCursor,{cut,offset:offset+limit});
    }
    return {schemaVersion:IntegrationContractVersion,items:structuredClone(cut.items.slice(offset,offset+limit)),
      page:{limit,nextCursor,snapshotId:cut.id,snapshotAt:cut.at,expiresAt:new Date(cut.expires).toISOString(),hasMore,changeCheckpoint:null},
      coverage:{complete:true,types:IntegrationDocumentTypes.map(type=>({type,state:['01','03','07','08'].includes(type)?'READY':'UNSUPPORTED',
        reasonCode:['01','03','07','08'].includes(type)?null:'SOURCE_NOT_SUPPORTED'}))}};
  }
  async document(token:string,id:string|null,query:unknown) {
    const q=readQuery(query,id?['issuerRuc','environment','snapshotId']:['issuerRuc','environment','type','series','number'],
      id?['issuerRuc']:['issuerRuc','type','series','number']);
    if (id && !uuid(id)) return deny(400,'INVALID_QUERY');
    if(id) id=id.toLowerCase();
    const p=await this.principal(token,'document',q.issuerRuc);
    if (q.snapshotId) {
      if (!uuid(q.snapshotId)) return deny(400,'INVALID_QUERY');if(!this.exports) return deny(503,'CONSISTENT_READ_UNAVAILABLE');
      return this.exports.json(`/internal/integration/documents/${id}?${new URLSearchParams(q)}`,token);
    }
    const path=id?`documents/${id}`:'documents/lookup';
    const result=await this.billing.json<BillingReadEnvelope>(`/internal/integration/${path}?${new URLSearchParams(q)}`,token);
    if (result.document?.issuerRuc!==q.issuerRuc || (id && result.document.id!==id) || !integrationGrantAllows(p.grants,result.document))
      return deny(409,'EVIDENCE_INCONSISTENT');
    return result.document;
  }
  async owner(token:string,path:string,query:unknown,kind:'document'|'artifacts') {
    const q=readQuery(query,['issuerRuc','environment']);await this.principal(token,kind,q.issuerRuc);
    if (!/^(?:documents|batches|artifacts)\/[a-f0-9-]{36}(?:\/artifacts|\/content)?$/i.test(path)) return deny(400,'INVALID_QUERY');
    path=path.toLowerCase();
    return this.sunat.json(`/internal/integration/${path}?${new URLSearchParams(q)}`,token);
  }
  async documents(token:string,query:unknown) {
    if(!this.exports) return deny(503,'CONSISTENT_READ_UNAVAILABLE');
    // Parsing and authorization also happen in the owner. Never let URLSearchParams stringify arrays/unknown shapes.
    const {parseIntegrationDocumentFilters}=await import('@factuez/contracts/integration');
    let parsed;try{parsed=parseIntegrationDocumentFilters(query);}catch{return deny(400,'INVALID_QUERY');}
    await this.principal(token,'document',parsed.issuerRuc);
    return this.exports.json(`/internal/integration/documents?${new URLSearchParams(query as Record<string,string>)}`,token);
  }
  async createExport(token:string,key:string,body:unknown) {
    if(!this.exports) return deny(503,'CONSISTENT_READ_UNAVAILABLE');
    return this.exports.json('/internal/integration/exports',token,{key,request:body});
  }
  async changes(token:string,query:unknown) {
    const q=changeQuery(query);const p=await this.identity.authenticate(token,['integration:documents:read','integration:changes:read']);
    requireScopes(p,['integration:documents:read','integration:changes:read']);requireIssuer(p,q.issuerRuc);
    if(!this.exports)return deny(503,'CHANGE_FEED_NOT_READY');
    return this.exports.json(`/internal/integration/changes?${new URLSearchParams({...q,limit:String(q.limit)})}`,token);
  }
  async exportRead(token:string,id:string,query:unknown,kind:'status'|'manifest'|'content') {
    const q=readQuery(query,['issuerRuc','environment']);if(!uuid(id)) return deny(400,'INVALID_QUERY');
    if(!this.exports) return deny(503,'CONSISTENT_READ_UNAVAILABLE');
    const path=`/internal/integration/exports/${id.toLowerCase()}${kind==='status'?'':'/'+kind}?${new URLSearchParams(q)}`;
    if(kind!=='content') return this.exports.json(path,token);
    const file=await this.exports.bytes(path,token,64*1024*1024),sha256=String(file.headers['x-content-sha256']??'');
    const fileName=`factuez-export-${id.toLowerCase()}.zip`;
    if(file.headers['content-type']!=='application/zip' || file.headers['content-length']!==String(file.bytes.length) ||
      file.headers['content-disposition']!==`attachment; filename="${fileName}"` ||
      !/^[a-f0-9]{64}$/.test(sha256) || createHash('sha256').update(file.bytes).digest('hex')!==sha256) return deny(409,'INTEGRITY_FAILED');
    // Download re-check on both sides after staging; no cached package bypasses fresh client revocation.
    await this.exports.json(`/internal/integration/exports/${id.toLowerCase()}?${new URLSearchParams(q)}`,token);
    return {bytes:file.bytes,sha256,fileName,mediaType:'application/zip'};
  }
  async content(token:string,id:string,query:unknown) {
    const q=readQuery(query,['issuerRuc','environment']);if (!uuid(id)) return deny(400,'INVALID_QUERY');
    id=id.toLowerCase();
    const p=await this.principal(token,'artifacts',q.issuerRuc);
    const {bytes,headers}=await this.sunat.bytes(`/internal/integration/artifacts/${id}/content?${new URLSearchParams(q)}`,token,10*1024*1024);
    const sha256=String(headers['x-content-sha256']??''),mediaType=String(headers['content-type']??'');
    const match=/^attachment; filename="([A-Za-z0-9_-]{1,120}\.(xml|zip))"$/.exec(String(headers['content-disposition']??''));
    if (!bytes.length || String(bytes.length)!==headers['content-length'] || !/^[a-f0-9]{64}$/.test(sha256) || !match ||
      !['application/xml','application/zip'].includes(mediaType) || createHash('sha256').update(bytes).digest('hex')!==sha256)
      return deny(409,'INTEGRITY_FAILED');
    const fresh=await this.principal(token,'artifacts',q.issuerRuc);
    if (snapshotHash(fresh)!==snapshotHash(p)) return deny(401,'UNAUTHENTICATED');
    return {bytes,sha256,mediaType,fileName:match[1]};
  }
}
