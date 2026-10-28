import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {request} from 'node:https';
import {isIP} from 'node:net';
import {checkServerIdentity} from 'node:tls';
import {inspect} from 'node:util';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {b2bUuid} from '@factuez/contracts/b2b-read-query';
import {correctionEvidenceFreeze} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import {receivedScope} from '@factuez/service-access/dist/b2b-received-wire';
import type {ReceptionDispatchContext} from './automation-dispatch';

export type ReceptionServiceTokenConfig={origin:string;
 tls:{ca:string|Uint8Array;cert:string|Uint8Array;key:string|Uint8Array;serverFingerprintSha256:string};
 credentials:(context:ReceptionDispatchContext)=>Promise<{clientId:string;revision:number;clientSecret:string}>;
 enabled?:boolean};
type CachedToken={token:string;expiresAt:number};
const MAX_BODY=32768,TIMEOUT=5000,MAX_CACHE=100;
const integer=(v:unknown,min=1,max=2147483647)=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=max;
const unavailable=()=>new B2bSecurityError(503,'RECEIVED_SERVICE_TOKEN_UNAVAILABLE');
const invalid=()=>new B2bSecurityError(503,'RECEIVED_SERVICE_TOKEN_INVALID_RESPONSE');
function exact(value:unknown,keys:readonly string[]):boolean{
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
}
function pem(value:string|Uint8Array):Buffer{
 if(!(typeof value==='string'||value instanceof Uint8Array)||!value.length||value.length>262144)throw unavailable();
 return Buffer.from(value);
}

/** Fixed private Identity OAuth transport. No environment, enrollment, SUNAT,
 * redirects, shared transport allowlist changes, or persistent token storage.
 * The dispatch authority still authenticates the principal on every action. */
export class HttpReceptionServiceTokenProvider{
 #endpoint:URL;
 #tls:{ca:Buffer;cert:Buffer;key:Buffer;serverFingerprintSha256:string};
 #credentials:ReceptionServiceTokenConfig['credentials'];
 #enabled:boolean;
 #hmac=randomBytes(32);
 #cache=new Map<string,CachedToken>();
 #pending=new Map<string,Promise<CachedToken>>();
 constructor(config:ReceptionServiceTokenConfig){
  try{
   if(!config||typeof config.origin!=='string'||typeof config.credentials!=='function'||
    config.enabled!==undefined&&typeof config.enabled!=='boolean')throw unavailable();
   const origin=new URL(config.origin);
   if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||
    ![origin.origin,origin.origin+'/'].includes(config.origin))throw unavailable();
   if(!config.tls||typeof config.tls.serverFingerprintSha256!=='string'||!/^[a-f0-9]{64}$/.test(config.tls.serverFingerprintSha256))throw unavailable();
   this.#endpoint=new URL('/b2b/oauth/token',origin);
   this.#tls={ca:pem(config.tls.ca),cert:pem(config.tls.cert),key:pem(config.tls.key),serverFingerprintSha256:config.tls.serverFingerprintSha256};
   this.#credentials=config.credentials;this.#enabled=config.enabled===true;
  }catch{throw unavailable();}
 }
 async credentials(input:ReceptionDispatchContext):Promise<{kind:'SERVICE';token:string}>{
  if(!this.#enabled)throw new B2bSecurityError(403,'RECEIVED_SERVICE_TOKEN_DISABLED');
  let context:ReceptionDispatchContext;
  try{
   context=correctionEvidenceFreeze(input);
   if(!exact(context,['runId','scope','source','revision','actor'])||!exact(context.actor,['kind','clientId','subjectId','clientRevision','userAuthRevision'])||
    context.actor.kind!=='SERVICE'||context.actor.subjectId!==null||context.actor.userAuthRevision!==null||
    !b2bUuid(context.actor.clientId)||!integer(context.actor.clientRevision)||!b2bUuid(context.runId)||
    !integer(context.revision)||!['MAIL','SIRE'].includes(context.source))throw new Error();
   receivedScope(context.scope);
  }catch{throw new B2bSecurityError(403,'RECEIVED_SERVICE_ACTOR_REQUIRED');}
  let credentials:Awaited<ReturnType<ReceptionServiceTokenConfig['credentials']>>;
  try{credentials=correctionEvidenceFreeze(await this.#credentials(context));}catch{throw unavailable();}
  if(!exact(credentials,['clientId','revision','clientSecret'])||!b2bUuid(credentials.clientId)||!integer(credentials.revision)||
   credentials.clientId!==context.actor.clientId||credentials.revision!==context.actor.clientRevision||
   typeof credentials.clientSecret!=='string'||!/^[A-Za-z0-9_-]{32,256}$/.test(credentials.clientSecret))
   throw new B2bSecurityError(403,'RECEIVED_SERVICE_ACTOR_REQUIRED');
  const scopes=context.source==='MAIL'?['b2b:received:sync','b2b:received:write']:['b2b:received:sync'];
  // Resolve the current owner secret even on a cache hit. Rotation/revision and
  // scope changes select a new token without retaining a raw secret as a key.
  const key=createHmac('sha256',this.#hmac).update(JSON.stringify([credentials.clientId,credentials.revision,scopes,credentials.clientSecret])).digest('hex');
  const now=Date.now();
  for(const [key,entry]of this.#cache)if(entry.expiresAt<=now)this.#cache.delete(key);
  const cached=this.#cache.get(key);if(cached)return {kind:'SERVICE',token:cached.token};
  const pending=this.#pending.get(key);if(pending)return {kind:'SERVICE',token:(await pending).token};
  if(this.#pending.size>=MAX_CACHE)throw new B2bSecurityError(503,'RECEIVED_SERVICE_TOKEN_BUSY');
  const mint=this.#mint(credentials.clientId,credentials.clientSecret,scopes);
  this.#pending.set(key,mint);
  try{
   const entry=await mint;
   if(entry.expiresAt>Date.now()){
    while(this.#cache.size>=MAX_CACHE)this.#cache.delete(this.#cache.keys().next().value!);
    this.#cache.set(key,entry);
   }
   return {kind:'SERVICE',token:entry.token};
  }finally{this.#pending.delete(key);}
 }
 async #mint(clientId:string,clientSecret:string,scopes:string[]):Promise<CachedToken>{
  const started=Date.now(),body=new URLSearchParams({grant_type:'client_credentials',scope:scopes.join(' ')}).toString();
  const bytes=await new Promise<Buffer>((resolve,reject)=>{
   let settled=false;
   const finish=(error?:B2bSecurityError,value?:Buffer)=>{
    if(settled)return;settled=true;clearTimeout(deadline);if(error)reject(error);else resolve(value!);
   };
   const deadline=setTimeout(()=>{finish(unavailable());req.destroy();},TIMEOUT);
   let req:ReturnType<typeof request>;
   try{
    req=request(this.#endpoint,{method:'POST',agent:false,minVersion:'TLSv1.2',rejectUnauthorized:true,
     ca:this.#tls.ca,cert:this.#tls.cert,key:this.#tls.key,
     ...(isIP(this.#endpoint.hostname)?{}:{servername:this.#endpoint.hostname}),
     checkServerIdentity:(hostname,certificate)=>{
      const error=checkServerIdentity(hostname,certificate);if(error)return error;
      const actual=certificate.fingerprint256?.replace(/:/g,'').toLowerCase();
      if(!actual||!/^[a-f0-9]{64}$/.test(actual)||!timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(this.#tls.serverFingerprintSha256,'hex')))
       return new Error('PRIVATE_IDENTITY_PIN_MISMATCH');
      return undefined;
     },
     headers:{Authorization:`Basic ${Buffer.from(`${clientId}:${clientSecret}`,'ascii').toString('base64')}`,
      'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json','Content-Length':Buffer.byteLength(body),
      'Cache-Control':'no-store'}},response=>{
     const fail=(error=invalid())=>{finish(error);response.destroy();req.destroy();};
     if(response.statusCode!==200){fail([401,403].includes(response.statusCode??0)?new B2bSecurityError(403,'RECEIVED_SERVICE_TOKEN_DENIED'):unavailable());return;}
     const declared=response.headers['content-length'];
     if(declared!==undefined&&(!/^\d+$/.test(declared)||Number(declared)>MAX_BODY)||
      response.headers['content-encoding']!==undefined&&response.headers['content-encoding']!=='identity'||
      !/^application\/json(?:\s*;|$)/i.test(response.headers['content-type']??'')){fail();return;}
     const chunks:Buffer[]=[];let length=0;
     response.on('data',(chunk:Buffer)=>{length+=chunk.length;if(length>MAX_BODY){fail();return;}chunks.push(chunk);});
     response.on('error',()=>finish(unavailable()));response.on('aborted',()=>finish(unavailable()));
     response.on('end',()=>{if(!response.complete){fail();return;}finish(undefined,Buffer.concat(chunks,length));});
    });
    req.on('error',()=>finish(unavailable()));req.end(body);
   }catch{finish(unavailable());}
  });
  let response:any;
  try{response=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw invalid();}
  if(!exact(response,['access_token','token_type','expires_in','scope'])||response.token_type!=='Bearer'||
   typeof response.access_token!=='string'||!/^[A-Za-z0-9._~-]{1,8192}$/.test(response.access_token)||
   !integer(response.expires_in,1,300)||typeof response.scope!=='string')throw invalid();
  const selected=response.scope.split(' ');
  if(selected.length!==scopes.length||new Set(selected).size!==selected.length||selected.some((scope:string)=>!scopes.includes(scope)))throw invalid();
  return {token:response.access_token,expiresAt:started+Math.max(0,response.expires_in-5)*1000};
 }
 toJSON(){return {provider:'HttpReceptionServiceTokenProvider',enabled:this.#enabled,credentials:'PRIVATE'};}
 [inspect.custom](){return 'HttpReceptionServiceTokenProvider { credentials: [PRIVATE], tokens: [PRIVATE] }';}
}
