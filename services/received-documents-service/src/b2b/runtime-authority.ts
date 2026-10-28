import {createHash,X509Certificate} from 'node:crypto';
import {request} from 'node:https';
import {checkServerIdentity,type TLSSocket} from 'node:tls';
import {inspect} from 'node:util';
import {B2bSecurityError,type B2bPrincipal} from '@factuez/contracts/b2b-security';
import {correctionEvidenceFreeze,correctionEvidenceHash as hash} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import {receivedScope,type ReceivedScope} from '@factuez/service-access/dist/b2b-received-wire';
import type {ReceptionGrantAdministrator} from './read';
import type {ReceptionAutomationUserAdministrator} from './automation';
import type {ReceptionAutomationAction} from './automation-authority';
import type {B2bReceivedRuntimeTls} from './runtime-config';
export interface B2bReceivedStepUpEndpoint {endpoint:string;serverFingerprintSha256:string;prepareEndpoint?:string}
type Proof={schemaVersion:'factuez.b2b.received-stepup-proof.v1';purpose:'GRANT'|'AUTOMATION';requestSha256:string;adminId:string;authRevision:number;authority:'GLOBAL_ADMIN';permission:'setup.manage';expiresAt:string};
const denied=()=>new B2bSecurityError(403,'RECEIVED_STEP_UP_DENIED');
/** Pinned mTLS client to the explicit Identity authority. No request at boot.
 * The authority must verify live GLOBAL/ADMIN/setup.manage + fresh step-up and
 * bind the opaque handle to the exact actor/action/scope/digest. */
export class B2bReceivedStepUpHttp {
 #endpoint:URL;#pin:string;#tls:B2bReceivedRuntimeTls;#prepare?:{endpoint:URL;tls:B2bReceivedRuntimeTls};#disposed=false;
 #cache=new Map<string,{createdAt:number;expiresAt:number;pending:Promise<string>}>();
 readonly grantAdministrator:ReceptionGrantAdministrator;
 readonly userAdministrator:ReceptionAutomationUserAdministrator;
 constructor(config:B2bReceivedStepUpEndpoint,tls:B2bReceivedRuntimeTls,prepareTls?:B2bReceivedRuntimeTls){
  try{
   const url=new URL(config.endpoint);
   if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname==='/'||!/^[a-f0-9]{64}$/.test(config.serverFingerprintSha256))throw Error();
   this.#endpoint=url;this.#pin=config.serverFingerprintSha256;this.#tls={ca:Buffer.from(tls.ca),cert:Buffer.from(tls.cert),key:Buffer.from(tls.key)};
   if(config.prepareEndpoint!==undefined){
    const prepare=new URL(config.prepareEndpoint);if(prepare.origin!==url.origin||prepare.protocol!=='https:'||prepare.username||prepare.password||prepare.search||prepare.hash||prepare.pathname!=='/internal/b2b/received-stepup/prepare'||!prepareTls||new X509Certificate(prepareTls.cert).fingerprint256===new X509Certificate(tls.cert).fingerprint256)throw Error();
    this.#prepare={endpoint:prepare,tls:{ca:Buffer.from(prepareTls.ca),cert:Buffer.from(prepareTls.cert),key:Buffer.from(prepareTls.key)}};
   }else if(prepareTls!==undefined)throw Error();
  }catch{throw Error('B2B_RECEIVED_STEP_UP_ENDPOINT_INVALID');}
  this.grantAdministrator={authorize:async(handle,digest)=>{
   if(typeof handle!=='string'||handle.startsWith('oidc-stepup.'))throw denied();
   const p=await this.verify({purpose:'GRANT',handle,requestSha256:digest});return {adminId:p.adminId,authRevision:p.authRevision,policySha256:digest};
  }};
  this.userAdministrator={authorize:(principal,scope,action,handle,digest)=>this.automation(principal,scope,action,handle,digest)};
 }
 private async automation(principal:B2bPrincipal,scope:ReceivedScope,action:ReceptionAutomationAction,handle:string,digest:string){
  const s=receivedScope(scope);
  if(this.#disposed||principal.kind!=='USER'||!principal.subjectId||principal.userAuthRevision===null||!['CONFIG_READ','CONFIG_SAVE','SYNC_CREATE','SYNC_READ'].includes(action))throw denied();
  const actor={clientId:principal.clientId,subjectId:principal.subjectId,authRevision:principal.userAuthRevision};
  let cacheKey:string|undefined,entry:{createdAt:number;expiresAt:number;pending:Promise<string>}|undefined;
  try{
   if(typeof handle!=='string')throw denied();
   if(handle.startsWith('oidc-stepup.')){
    const token=handle.slice('oidc-stepup.'.length);
    if(!this.#prepare||handle.length>8192||!/^[A-Za-z0-9._~-]{16,8192}$/.test(token)||!/^[a-f0-9]{64}$/.test(digest))throw denied();
    cacheKey=hash({tokenSha256:createHash('sha256').update(token).digest('hex'),clientId:principal.clientId,clientRevision:principal.revision,subjectId:principal.subjectId,authRevision:principal.userAuthRevision,scope:s,action,requestSha256:digest});
    const now=Date.now();for(const [key,value] of this.#cache)if(value.expiresAt<=now||value.createdAt>now)this.#cache.delete(key);
    entry=this.#cache.get(cacheKey);
    if(!entry){
     if(this.#cache.size>=32)throw denied();
     const fresh={createdAt:now,expiresAt:now+30000,pending:undefined as unknown as Promise<string>};entry=fresh;this.#cache.set(cacheKey,fresh);
     const key=cacheKey;
     fresh.pending=(async()=>{
      const raw:any=correctionEvidenceFreeze(await this.exchange(this.#prepare!.endpoint,this.#prepare!.tls,{schemaVersion:'factuez.b2b.received-approval-prepare.v1',purpose:'AUTOMATION',action,scope:s,requestSha256:digest},'Bearer '+token));
      const expiresAt=Date.parse(raw?.expiresAt);
      if(!raw||Object.keys(raw).sort().join(',')!=='action,expiresAt,handle,purpose,requestSha256,schemaVersion,scope'||raw.schemaVersion!=='factuez.b2b.received-approval-prepared.v1'||raw.purpose!=='AUTOMATION'||raw.action!==action||hash(receivedScope(raw.scope))!==hash(s)||raw.requestSha256!==digest||typeof raw.handle!=='string'||raw.handle.length<1||raw.handle.length>8192||!/^[A-Za-z0-9_-]+$/.test(raw.handle)||!Number.isFinite(expiresAt)||expiresAt<=Date.now()||expiresAt>Date.now()+30000||this.#disposed||this.#cache.get(key)!==fresh)throw denied();
      fresh.expiresAt=Math.min(fresh.expiresAt,expiresAt);if(fresh.expiresAt<=Date.now())throw denied();return raw.handle;
     })().catch(()=>{if(this.#cache.get(key)===fresh)this.#cache.delete(key);throw denied();});
    }
    handle=await entry.pending;
    if(this.#disposed||this.#cache.get(cacheKey)!==entry||entry.expiresAt<=Date.now())throw denied();
   }
   // A cached handle is never a cached authorization: Identity verifies IdP and current owner state on EVERY call.
   const p=await this.verify({purpose:'AUTOMATION',handle,requestSha256:digest,actor,scope:s,action});
   if(p.adminId!==actor.subjectId||p.authRevision!==actor.authRevision||this.#disposed)throw denied();
   if(entry){if(this.#cache.get(cacheKey!)!==entry||entry.expiresAt<=Date.now())throw denied();entry.expiresAt=Math.min(entry.expiresAt,Date.parse(p.expiresAt));}
   return {adminId:p.adminId,authRevision:p.authRevision,scope:s,requestSha256:digest,authority:'GLOBAL_ADMIN' as const};
  }catch{if(cacheKey&&(!entry||this.#cache.get(cacheKey)===entry))this.#cache.delete(cacheKey);throw denied();}
 }
 dispose(){this.#disposed=true;this.#cache.clear();}
 private async verify(input:{purpose:Proof['purpose'];handle:string;requestSha256:string;actor?:unknown;scope?:ReceivedScope;action?:ReceptionAutomationAction}):Promise<Proof>{
  if(this.#disposed)throw denied();
  if(typeof input.handle!=='string'||input.handle.length<1||input.handle.length>8192||/[\x00-\x20\x7f]/.test(input.handle)||!/^[a-f0-9]{64}$/.test(input.requestSha256))throw denied();
  const body={schemaVersion:'factuez.b2b.received-stepup-request.v1',...input};
  const binding=hash(body);
  const raw=await this.exchange(this.#endpoint,this.#tls,body);
  try{
   const p=correctionEvidenceFreeze(raw) as Proof&{requestBindingSha256:string};
   if(!p||Object.keys(p).sort().join(',')!=='adminId,authRevision,authority,expiresAt,permission,purpose,requestBindingSha256,requestSha256,schemaVersion'||p.schemaVersion!=='factuez.b2b.received-stepup-proof.v1'||p.purpose!==input.purpose||p.requestSha256!==input.requestSha256||p.requestBindingSha256!==binding||p.authority!=='GLOBAL_ADMIN'||p.permission!=='setup.manage'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(p.adminId)||!Number.isSafeInteger(p.authRevision)||p.authRevision<0||!Number.isFinite(Date.parse(p.expiresAt))||Date.parse(p.expiresAt)<=Date.now()||Date.parse(p.expiresAt)>Date.now()+30000)throw Error();return p;
  }catch{throw denied();}
 }
 private async exchange(endpoint:URL,tls:B2bReceivedRuntimeTls,body:unknown,authorization?:string){
  if(this.#disposed)throw denied();const bytes=Buffer.from(JSON.stringify(body));if(bytes.length>32768)throw denied();
  return new Promise<unknown>((resolve,reject)=>{
   const req=request(endpoint,{...tls,method:'POST',rejectUnauthorized:true,minVersion:'TLSv1.2',agent:false,timeout:5000,
    checkServerIdentity:(hostname,cert)=>checkServerIdentity(hostname,cert)??(cert.fingerprint256?.replace(/:/g,'').toLowerCase()===this.#pin?undefined:Error('RECEIVED_STEP_UP_DENIED')),
    headers:{'Content-Type':'application/json','Content-Length':bytes.length,Accept:'application/json',...(authorization?{Authorization:authorization}:{})}},res=>{
     res.on('error',()=>reject(denied()));res.on('aborted',()=>reject(denied()));
     let fingerprint:string|undefined;try{fingerprint=(res.socket as TLSSocket).getPeerCertificate(true).fingerprint256?.replace(/:/g,'').toLowerCase();}catch{/* Missing certificate evidence is denied. */}
     if(fingerprint!==this.#pin){res.destroy();reject(denied());return;}
     const chunks:Buffer[]=[];let size=0;
     res.on('data',(b:Buffer)=>{size+=b.length;if(size>16384)req.destroy();else chunks.push(b);});
     res.on('end',()=>{if(res.statusCode!==200||!/^application\/json(?:;|$)/.test(res.headers['content-type']??''))return reject(denied());try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(denied());}});
    });req.on('error',()=>reject(denied()));req.on('timeout',()=>req.destroy());req.end(bytes);
  });
 }
 toJSON(){return {service:'B2bReceivedStepUpHttp',contents:'PRIVATE'};}[inspect.custom](){return this.toJSON();}
}
