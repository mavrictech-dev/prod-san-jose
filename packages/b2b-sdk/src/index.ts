import {createHash} from 'node:crypto';
import {inspect} from 'node:util';
import {B2bSdkError,type ReceivedScope,type ReceivedSelection,type ReceivedArtifactKind,type ReceivedDownload,type ReceivedArtifact} from './types';
import {BoundedTransport,snapshot,type FactuEzB2bOptions} from './transport';
import {Phase8Methods} from './phase8';
import * as wire from './validation';
export * from './types';
export * from './phase8-types';
export * from './operations-extra-types';
export * from './owner-admin-types';
export type {FactuEzB2bOptions,FactuEzB2bAdminOptions} from './transport';
export {FactuEzB2bAdminClient} from './admin';
export {FactuEzB2bOwnerAdminClient} from './owner-admin';
const FILE_LIMIT=10*1024*1024;
function input<T>(run:()=>T):T {try{return run();}catch{throw new B2bSdkError('INVALID_REQUEST');}}
function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
  return JSON.stringify(value);
}
/** Node BETA client. Every request uses explicitly configured pinned mTLS. */
export class FactuEzB2bClient extends Phase8Methods {
  #transport:BoundedTransport;
  constructor(options:FactuEzB2bOptions){const t=new BoundedTransport(options,false);super(t);this.#transport=t;}
  toJSON(){return {sdk:'FactuEzB2bClient',environment:'BETA'};}
  [inspect.custom](){return 'FactuEzB2bClient { environment: BETA, credentials: [PRIVATE] }';}
  #scopeQuery(s:ReceivedScope):Record<string,string>{return {environment:'BETA',companyId:String(s.companyId),recipientRuc:s.recipientRuc,branchId:s.branchId};}
  async capabilities(){return wire.capabilities(await this.#transport.json('capabilities',[],{environment:'BETA'}));}
  async listReceived(value:ReceivedSelection){
    const q=input(()=>wire.selection(snapshot(value)));
    const query={...this.#scopeQuery(q.scope),from:q.from,to:q.to,limit:String(q.limit),...(q.type?{type:q.type}:{}),...(q.after?{after:q.after}:{})};
    return wire.page(await this.#transport.json('receivedList',[],query),q);
  }
  async detail(value:ReceivedScope,id:string){
    const s=input(()=>wire.scope(snapshot(value)));input(()=>{if(!wire.uuid(id))wire.fail();});
    return wire.detail(await this.#transport.json('receivedDetail',[id],this.#scopeQuery(s)),s,id);
  }
  async artifactManifest(value:ReceivedScope,id:string){
    const s=input(()=>wire.scope(snapshot(value)));input(()=>{if(!wire.uuid(id))wire.fail();});
    return wire.manifest(await this.#transport.json('receivedManifest',[id],this.#scopeQuery(s)),s,id);
  }
  async downloadArtifact(value:ReceivedScope,id:string,artifactId:string):Promise<ReceivedDownload>{
    input(()=>{if(!wire.uuid(artifactId))wire.fail();});
    return this.#download(value,id,undefined,artifactId);
  }
  downloadXML(value:ReceivedScope,id:string,artifactId?:string){return this.#download(value,id,'XML',artifactId);}
  downloadCDR(value:ReceivedScope,id:string,artifactId?:string){return this.#download(value,id,'CDR',artifactId);}
  downloadProviderPDF(value:ReceivedScope,id:string,artifactId?:string){return this.#download(value,id,'PROVIDER_PDF',artifactId);}
  async #download(value:ReceivedScope,id:string,kind:ReceivedArtifactKind|undefined,artifactId?:string):Promise<ReceivedDownload>{
    const s=input(()=>wire.scope(snapshot(value)));input(()=>{if(!wire.uuid(id)||artifactId!==undefined&&!wire.uuid(artifactId))wire.fail();});
    const before=await this.artifactManifest(s,id);
    const matches=before.items.filter(a=>(kind===undefined||a.kind===kind)&&(artifactId===undefined||a.id===artifactId));
    if(!matches.length)throw new B2bSdkError('ARTIFACT_NOT_FOUND');
    if(matches.length!==1)throw new B2bSdkError('ARTIFACT_AMBIGUOUS');
    const a:ReceivedArtifact=matches[0];
    const reply=await this.#transport.file('receivedContent',[id,a.id],this.#scopeQuery(s),Math.min(FILE_LIMIT,a.byteLength));
    let name:string;
    try {
      const disposition=reply.headers['content-disposition'];
      const m=typeof disposition==='string'?/^attachment; filename="documento\.(xml|zip|pdf)"; filename\*=UTF-8''([^;\s]+)$/.exec(disposition):null;
      if(!m)throw 0;name=decodeURIComponent(m[2]);
      if(m[1]!==a.fileName.split('.').at(-1)?.toLowerCase())throw 0;
    }catch{throw new B2bSdkError('ARTIFACT_INTEGRITY_FAILED');}
    if(reply.bytes.length!==a.byteLength||reply.headers['content-length']!==String(a.byteLength)||
      reply.headers['content-type']!==a.mediaType||reply.headers['x-content-sha256']!==a.sha256||
      reply.headers['x-factuez-source']!=='RECEIVED_ORIGINAL'||name!==a.fileName||
      createHash('sha256').update(reply.bytes).digest('hex')!==a.sha256)throw new B2bSdkError('ARTIFACT_INTEGRITY_FAILED');
    const after=await this.artifactManifest(s,id);
    if(canonical(before)!==canonical(after))throw new B2bSdkError('ARTIFACT_CHANGED');
    return {artifact:structuredClone(a),bytes:Buffer.from(reply.bytes)};
  }
}
