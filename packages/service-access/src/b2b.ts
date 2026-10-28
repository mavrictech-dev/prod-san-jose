/** Private B2B transport, deliberately separate from integration readonly tokens. */
import { request } from 'node:https';
import { randomUUID,createHash } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import {inspect} from 'node:util';
import { B2bSecurityError, validB2bPrincipal, type B2bBinding, type B2bIdentityScope, type B2bCorrectionBinding } from '@factuez/contracts/b2b-security';
export function b2bPrivatePeer(req:{socket:TLSSocket},peers:readonly string[]) {
  const fingerprint=req.socket.encrypted&&req.socket.authorized&&req.socket.getPeerCertificate().fingerprint256?.replace(/:/g,'').toLowerCase();
  if(!fingerprint||!peers.includes(fingerprint))throw new B2bSecurityError(403,'PRIVATE_PEER_REQUIRED');
  return fingerprint;
}
export class B2bPrivateHttp {
  private readonly origin:URL;
  #tls:{ca:Buffer;cert:Buffer;key:Buffer};
  constructor(origin:string,tls:{ca:Buffer;cert:Buffer;key:Buffer}) {
    this.#tls={ca:Buffer.from(tls.ca),cert:Buffer.from(tls.cert),key:Buffer.from(tls.key)};
    this.origin=new URL(origin);
    if(this.origin.protocol!=='https:'||this.origin.pathname!=='/'||this.origin.username||this.origin.password||this.origin.search||this.origin.hash)throw new Error('Fixed private B2B HTTPS origin required');
  }
  private async exchange(path:string,body:unknown,token:string|undefined,maximum:number):Promise<{bytes:Buffer;headers:Record<string,unknown>}>{
    const fixedPaths=[
      '/internal/b2b/owner-authority/authorize','/internal/b2b/owner-authority/live-human','/internal/b2b/owner-authority/status','/internal/b2b/authorize-email-actor',
      '/internal/b2b/runtime-status','/internal/b2b/introspect','/internal/b2b/context','/internal/b2b/validate-bindings','/internal/b2b/validate-correction-bindings','/internal/b2b/authorize-correction',
      '/internal/b2b/read','/internal/b2b/fiscal-read','/internal/b2b/drafts','/internal/b2b/exports','/internal/b2b/webhooks','/internal/b2b/webhook-events',
      '/internal/b2b/authorize-webhook','/internal/b2b/commercial','/internal/b2b/correction-evidence','/internal/b2b/correction-evidence-authorize','/internal/b2b/correction-producer',
      '/internal/b2b/authorize-guide','/internal/b2b/validate-guide-bindings','/internal/b2b/guides','/internal/b2b/prepare-guide','/internal/b2b/authorize-guide-issue',
      '/internal/b2b/validate-guide-issue-bindings','/internal/b2b/issue-guide','/internal/b2b/read-guide-issuance','/internal/b2b/guide-artifacts','/internal/b2b/carrier-guides',
      '/internal/b2b/batch-operations','/internal/b2b/batch-artifacts','/internal/b2b/received-read','/internal/b2b/received-command','/internal/b2b/integration-admin',
      '/internal/b2b/phase8-business','/internal/b2b/phase8-reports','/internal/b2b/history-read','/internal/b2b/received-automation','/internal/b2b/owner-admin','/internal/b2b/email-deliveries',
    ];
    if(!fixedPaths.includes(path)||
      (token!==undefined&&!/^[A-Za-z0-9._~-]{1,8192}$/.test(token)))throw new B2bSecurityError(400,'INVALID_REQUEST');
    const evidence=['/internal/b2b/correction-evidence','/internal/b2b/correction-evidence-authorize'].includes(path);
    const action=(body as any)?.action,maxRequest=evidence?2*1024*1024:path==='/internal/b2b/owner-admin'?1024*1024:path==='/internal/b2b/read'&&action==='extract:reauthorize'?4*1024*1024:256*1024;
    const bytes=Buffer.from(JSON.stringify(body));if(bytes.length>maxRequest)throw new B2bSecurityError(400,'INVALID_REQUEST');
    const timeout=['/internal/b2b/received-read','/internal/b2b/received-command','/internal/b2b/integration-admin','/internal/b2b/phase8-business','/internal/b2b/phase8-reports','/internal/b2b/history-read','/internal/b2b/received-automation','/internal/b2b/owner-admin','/internal/b2b/email-deliveries'].includes(path)?60000:evidence?30000:['/internal/b2b/issue-guide','/internal/b2b/guide-artifacts','/internal/b2b/carrier-guides','/internal/b2b/batch-operations','/internal/b2b/batch-artifacts'].includes(path)?120000:['/internal/b2b/prepare-guide','/internal/b2b/read-guide-issuance'].includes(path)?30000:path==='/internal/b2b/validate-guide-issue-bindings'?20000:path==='/internal/b2b/authorize-guide-issue'?20000:path==='/internal/b2b/correction-producer'?120000:path==='/internal/b2b/webhooks'&&action==='VERIFY'?20000:path==='/internal/b2b/exports'?(action==='create'?240000:action==='changes'?60000:20000):['extract:capture','extract:reauthorize'].includes(action)?20000:5000;
    const authorityTimeout=['/internal/b2b/owner-authority/authorize','/internal/b2b/owner-authority/live-human','/internal/b2b/authorize-email-actor'].includes(path)?30000:timeout;
    return new Promise((resolve,reject)=>{
      const req=request(new URL(path,this.origin),{...this.#tls,method:'POST',rejectUnauthorized:true,timeout:authorityTimeout,
        headers:{Accept:['content','pdf'].includes(action)?'*/*':'application/json','Content-Type':'application/json','Content-Length':bytes.length,...(token?{Authorization:'Bearer '+token}:{})}},res=>{
        let size=0;const chunks:Buffer[]=[];
        res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>maximum)req.destroy(new Error('Private B2B response limit'));else chunks.push(chunk);});
        res.on('error',reject);res.on('aborted',()=>reject(new Error('Incomplete private B2B response')));
        res.on('end',()=>{if(res.statusCode!==200)return reject(new B2bSecurityError([400,401,403,404,409,410,412,413,422,428,429,501].includes(res.statusCode??0)?res.statusCode!:503,'OWNER_REQUEST_DENIED'));
          resolve({bytes:Buffer.concat(chunks),headers:res.headers});});
      });req.on('timeout',()=>req.destroy(new Error('Private B2B timeout')));req.on('error',()=>reject(new B2bSecurityError(503,'OWNER_UNAVAILABLE')));req.end(bytes);
    });
  }
  async post(path:string,body:unknown,token?:string):Promise<unknown>{
    // Only this fixed owner RPC returns an entire bounded persisted batch
    // command. Public operation/metadata projections remain <=32 KiB.
    const maximum=['/internal/b2b/correction-evidence','/internal/b2b/correction-evidence-authorize','/internal/b2b/batch-operations','/internal/b2b/received-read','/internal/b2b/phase8-business','/internal/b2b/phase8-reports','/internal/b2b/owner-admin','/internal/b2b/history-read','/internal/b2b/received-automation'].includes(path)?2*1024*1024:['/internal/b2b/prepare-guide','/internal/b2b/issue-guide','/internal/b2b/read-guide-issuance','/internal/b2b/carrier-guides'].includes(path)?512*1024:['/internal/b2b/read','/internal/b2b/fiscal-read','/internal/b2b/exports','/internal/b2b/commercial','/internal/b2b/guides','/internal/b2b/integration-admin'].includes(path)?16*1024*1024:256*1024;
    const response=await this.exchange(path,body,token,maximum);
    if(!/^application\/json(?:;|$)/.test(String(response.headers['content-type']??'')))throw new B2bSecurityError(503,'OWNER_UNAVAILABLE');
    try{return JSON.parse(response.bytes.toString('utf8'));}catch{throw new B2bSecurityError(503,'OWNER_UNAVAILABLE');}
  }
  async file(body:unknown,token:string){
    return this.download('/internal/b2b/fiscal-read',body,token,10*1024*1024);
  }
  async exportFile(body:unknown,token:string){return this.download('/internal/b2b/exports',body,token,64*1024*1024);}
  async guideArtifactFile(body:unknown,token:string){return this.download('/internal/b2b/guide-artifacts',body,token,4*1024*1024);}
  async batchArtifactFile(body:unknown,token:string){return this.download('/internal/b2b/batch-artifacts',body,token,4*1024*1024);}
  async reportFile(body:unknown,token:string){
    const r=await this.exchange('/internal/b2b/phase8-reports',body,token,24*1024*1024),h=r.headers;
    const m=/^attachment; filename="(b2b-report-[a-f0-9-]{36}\.(csv|xlsx|pdf))"$/.exec(String(h['content-disposition']??'')),sha256=String(h['x-content-sha256']??''),mediaType=String(h['content-type']??'');
    const types:Record<string,string>={csv:'text/csv; charset=utf-8',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',pdf:'application/pdf'};
    if(!m||types[m[2]]!==mediaType||!r.bytes.length||h['content-length']!==String(r.bytes.length)||!/^[a-f0-9]{64}$/.test(sha256)||createHash('sha256').update(r.bytes).digest('hex')!==sha256)throw new B2bSecurityError(409,'REPORT_INTEGRITY_FAILED');
    return {bytes:r.bytes,fileName:m[1],sha256,mediaType};
  }
  async historyFile(body:unknown,token:string){
    const r=await this.exchange('/internal/b2b/history-read',body,token,10*1024*1024),h=r.headers;
    let fileName:string;try{fileName=decodeURIComponent(String(h['x-factuez-original-filename']??''));}catch{throw new B2bSecurityError(409,'HISTORY_INTEGRITY_FAILED');}
    const mediaType=String(h['content-type']??''),sha256=String(h['x-content-sha256']??'');
    if(!fileName||fileName.length>150||/[\\/:\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(fileName)||!/^attachment; filename="history-original\.(xml|zip|pdf)"$/.test(String(h['content-disposition']??''))||!['application/xml','application/zip','application/pdf'].includes(mediaType)||!r.bytes.length||h['content-length']!==String(r.bytes.length)||!/^[a-f0-9]{64}$/.test(sha256)||createHash('sha256').update(r.bytes).digest('hex')!==sha256)throw new B2bSecurityError(409,'HISTORY_INTEGRITY_FAILED');
    return {bytes:r.bytes,fileName,mediaType,sha256};
  }
  /** Dedicated incoming-original transport; preserve Unicode provider names
   * without relaxing the legacy downloader's closed ASCII header grammar. */
  async receivedFile(body:unknown,token:string){
    const response=await this.exchange('/internal/b2b/received-read',body,token,10*1024*1024);
    const h=response.headers,mime=String(h['content-type']??''),sha256=String(h['x-content-sha256']??'');
    let fileName:string;try{fileName=decodeURIComponent(String(h['x-factuez-original-filename']??''));}catch{throw new B2bSecurityError(409,'INTEGRITY_FAILED');}
    if(!fileName||fileName.length>150||/[\\/:*?"<>|\x00-\x1f\x7f]/.test(fileName)||fileName.startsWith('.')||fileName.includes('..')||
      !/^attachment; filename="received-original\.(?:xml|zip|pdf)"$/.test(String(h['content-disposition']??''))||h['x-factuez-source']!=='RECEIVED_ORIGINAL'||
      !['application/xml','application/zip','application/pdf'].includes(mime)||!response.bytes.length||h['content-length']!==String(response.bytes.length)||
      !/^[a-f0-9]{64}$/.test(sha256)||createHash('sha256').update(response.bytes).digest('hex')!==sha256)throw new B2bSecurityError(409,'INTEGRITY_FAILED');
    return {bytes:response.bytes,sha256,fileName,mediaType:mime};
  }
  private async download(path:string,body:unknown,token:string,maximum:number){
    const response=await this.exchange(path,body,token,maximum);
    const mediaType=String(response.headers['content-type']??''),sha256=String(response.headers['x-content-sha256']??'');
    const match=/^attachment; filename="([A-Za-z0-9_-]{1,150}\.(xml|zip|pdf))"$/.exec(String(response.headers['content-disposition']??''));
    if(!match||!['application/xml','application/zip','application/pdf'].includes(mediaType)||!response.bytes.length||
      response.headers['content-length']!==String(response.bytes.length)||!/^[a-f0-9]{64}$/.test(sha256)||createHash('sha256').update(response.bytes).digest('hex')!==sha256)throw new B2bSecurityError(409,'INTEGRITY_FAILED');
    return {bytes:response.bytes,sha256,fileName:match[1],mediaType};
  }
  toJSON(){return {service:'B2bPrivateHttp',credentials:'PRIVATE'};}
  [inspect.custom](){return this.toJSON();}
}
export class B2bIdentityHttp {
  constructor(private readonly http:B2bPrivateHttp){}
  async authenticate(token:string,required:B2bIdentityScope[],kind:'SERVICE'|'USER'){
    const value=await this.http.post('/internal/b2b/introspect',{requiredScopes:required,kind},token);
    if(!validB2bPrincipal(value)||value.kind!==kind||required.some(scope=>!value.scopes.includes(scope)))throw new B2bSecurityError(503,'INVALID_IDENTITY_RESPONSE');
    return value;
  }
}
export class B2bBindingCatalogueHttp {
  constructor(private readonly http:B2bPrivateHttp){}
  async validate(bindings:B2bBinding[]){
    const response=await this.http.post('/internal/b2b/validate-bindings',{bindings});
    if(!response||typeof response!=='object'||(response as any).valid!==true)throw new B2bSecurityError(400,'INVALID_BINDINGS');
  }
}
export class B2bCorrectionCatalogueHttp {
  constructor(private readonly http:B2bPrivateHttp){}
  async validate(bindings:B2bCorrectionBinding[]) {
    const response=await this.http.post('/internal/b2b/validate-correction-bindings',{bindings});
    if (!response||typeof response!=='object'||Array.isArray(response)||Object.keys(response).join(',')!=='valid'||(response as any).valid!==true) throw new B2bSecurityError(503,'INVALID_CATALOGUE_RESPONSE');
  }
}
/** Guide metadata grants stay separate from 01/03 and correction pairs. */
export class B2bGuideCatalogueHttp {
  constructor(private readonly http:Pick<B2bPrivateHttp,'post'>){}
  async validate(bindings:unknown[]){
    const response=await this.http.post('/internal/b2b/validate-guide-bindings',{bindings});
    if(!response||typeof response!=='object'||Array.isArray(response)||Object.keys(response).join(',')!=='valid'||(response as any).valid!==true)throw new B2bSecurityError(400,'INVALID_GUIDE_BINDINGS');
  }
}
export const newB2bRequestId=()=>randomUUID();
