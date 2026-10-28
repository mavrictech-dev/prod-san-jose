import {randomBytes} from 'node:crypto';
import {inspect} from 'node:util';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import type {B2bIntegrationAdmin} from './integration-admin';
import type {AdminSsoProvider,AdminSsoProfile} from './admin-bff-oidc';
import {adminBffHash,adminBffOpaque,adminBffSame,type AdminBffStore,type AdminBrowserSession} from './admin-bff-store';
const freshOpaque=()=>randomBytes(32).toString('base64url');
function denied(status=401,code='ADMIN_SESSION_REQUIRED'):never{throw new B2bSecurityError(status,code);}
type AdminFacade=Pick<B2bIntegrationAdmin,'list'|'read'|'create'|'update'|'rotate'>;
export type AdminSessionSummary={enabled:true;environment:'BETA';authenticated:false}|{enabled:true;environment:'BETA';authenticated:true;csrfToken:string;expiresAt:string};
export interface AdminBffOptions {enabled?:boolean;origin:string;provider:AdminSsoProvider;store:AdminBffStore;facade:AdminFacade;now?:()=>number}
/** Browser sessions hold only opaque cookies; access proofs stay in sealed server storage. */
export class AdminSessionBff {
 readonly origin:string;readonly callbackPath='/bff/b2b-admin/callback';private readonly now:()=>number;
 constructor(private readonly options:AdminBffOptions){
  const u=new URL(options.origin);if(u.protocol!=='https:'||u.origin!==options.origin||!options.provider||!options.store||!options.facade)throw new Error('EXPLICIT_ADMIN_BFF_CONFIGURATION_REQUIRED');
  this.origin=u.origin;this.now=options.now??Date.now;
 }
 toJSON(){return {service:'AdminSessionBff',environment:'BETA',credentials:'PRIVATE'};}
 [inspect.custom](){return 'AdminSessionBff { environment: BETA, credentials: [PRIVATE] }';}
 private enabled(){if(this.options.enabled!==true)denied(503,'ADMIN_BFF_DISABLED');}
 private profile(v:AdminSsoProfile){
  const now=this.now();if(!v||Object.keys(v).sort().join(',')!=='acr,amr,authTime,clientId,expiresAt,issuer,subject'||typeof v.issuer!=='string'||new URL(v.issuer).protocol!=='https:'||typeof v.subject!=='string'||!v.subject||v.subject.length>255||typeof v.clientId!=='string'||!v.clientId||typeof v.acr!=='string'||!v.acr||!Array.isArray(v.amr)||!v.amr.includes('mfa')||![v.expiresAt,v.authTime].every(Number.isSafeInteger)||v.expiresAt<=now||v.expiresAt>now+300000||v.authTime>now||now-v.authTime>300000)denied();
  return structuredClone(v);
 }
 private stamp(v:AdminSsoProfile){return JSON.stringify([v.issuer,v.subject,v.clientId,v.authTime,v.acr,[...v.amr].sort()]);}
 private async failure<T>(work:()=>Promise<T>):Promise<T>{try{return await work();}catch(e){if(e instanceof B2bSecurityError)throw e;return denied(503,'ADMIN_BFF_UNAVAILABLE');}}
 async rate(peer:string,group:string){this.enabled();if(!await this.options.store.admit(adminBffHash(group+':'+peer),group==='start'?30:120,60000))denied(429,'RATE_LIMITED');}
 async start(){return this.failure(async()=>{
  this.enabled();const state=freshOpaque(),browserCookie=freshOpaque(),nonce=freshOpaque(),verifier=freshOpaque();
  const authorizeUrl=this.options.provider.authorize({state,nonce,codeChallenge:Buffer.from(adminBffHash(verifier),'hex').toString('base64url')});
  const u=new URL(authorizeUrl);if(u.protocol!=='https:'||u.username||u.password||u.hash)denied(503,'ADMIN_BFF_UNAVAILABLE');
  await this.options.store.putFlow(state,{browserHash:adminBffHash(browserCookie),nonce,verifier,expiresAt:this.now()+120000});
  return {authorizeUrl,browserCookie};
 });}
 async callback(code:string,state:string,browserCookie:string,previousSession?:string){return this.failure(async()=>{
  this.enabled();if(typeof code!=='string'||!/^[A-Za-z0-9._~-]{1,4096}$/.test(code)||!adminBffOpaque(state)||!adminBffOpaque(browserCookie))denied(400,'INVALID_SSO_CALLBACK');
  const flow=await this.options.store.takeFlow(state,browserCookie);if(!flow||flow.expiresAt<=this.now())denied(400,'INVALID_SSO_CALLBACK');
  const result=await this.options.provider.exchange({code,nonce:flow.nonce,verifier:flow.verifier});
  if(typeof result.accessToken!=='string'||!/^[A-Za-z0-9._~-]{16,8192}$/.test(result.accessToken))denied();
  const profile=this.profile(result.profile),current=this.profile(await this.options.provider.verify(result.accessToken));
  if(this.stamp(profile)!==this.stamp(current))denied();
  // The existing Identity owner checks live global roles, linkage and step-up.
  // Its response is discarded here; session bootstrap cannot grant permissions.
  await this.options.facade.list(result.accessToken,{environment:'BETA',limit:1});
  const after=this.profile(await this.options.provider.verify(result.accessToken));if(this.stamp(after)!==this.stamp(profile))denied();
  const sessionCookie=freshOpaque(),expiresAt=Math.min(profile.expiresAt,current.expiresAt,after.expiresAt,this.now()+300000);
  await this.options.store.putSession(sessionCookie,{accessToken:result.accessToken,profile,csrfToken:freshOpaque(),revision:freshOpaque(),expiresAt});
  if(previousSession&&adminBffOpaque(previousSession))await this.options.store.deleteSession(previousSession);
  return {sessionCookie,expiresAt};
 });}
 private async load(cookie:string){if(!adminBffOpaque(cookie))denied();const v=await this.options.store.getSession(cookie);if(!v||v.expiresAt<=this.now())denied();this.profile(v.profile);return v;}
 private async current(cookie:string,session:AdminBrowserSession){
  const v=this.profile(await this.options.provider.verify(session.accessToken));if(this.stamp(v)!==this.stamp(session.profile))denied();
  const stored=await this.load(cookie);if(stored.revision!==session.revision||!adminBffSame(stored.csrfToken,session.csrfToken)||stored.accessToken!==session.accessToken)denied();
 }
 async summary(cookie?:string):Promise<AdminSessionSummary>{return this.failure(async()=>{
  this.enabled();if(!cookie)return {enabled:true,environment:'BETA',authenticated:false};
  const s=await this.load(cookie);await this.current(cookie,s);await this.options.facade.list(s.accessToken,{environment:'BETA',limit:1});await this.current(cookie,s);
  return {enabled:true,environment:'BETA',authenticated:true,csrfToken:s.csrfToken,expiresAt:new Date(s.expiresAt).toISOString()};
 });}
 async logout(cookie:string,csrf:string){return this.failure(async()=>{this.enabled();const s=await this.load(cookie);if(typeof csrf!=='string'||!adminBffSame(s.csrfToken,csrf))denied(403,'CSRF_REQUIRED');await this.options.store.deleteSession(cookie);return {loggedOut:true as const};});}
 /** Only the HTTP adapter's strict same-origin workspace-logout intent may use
  * this path. It cannot read data, renew access or choose another session ID. */
 async revokeFromWorkspace(cookie?:string){return this.failure(async()=>{this.enabled();if(cookie){if(!adminBffOpaque(cookie))denied();await this.options.store.deleteSession(cookie);}return {loggedOut:true as const};});}
 async operation(cookie:string,csrf:string,method:string,path:string,body?:unknown){return this.failure(async()=>{
  this.enabled();const s=await this.load(cookie);if(typeof csrf!=='string'||!adminBffSame(s.csrfToken,csrf))denied(403,'CSRF_REQUIRED');await this.current(cookie,s);
  const u=new URL(path,this.origin),q=Object.fromEntries(u.searchParams),names=[...u.searchParams.keys()];
  if(u.origin!==this.origin||new Set(names).size!==names.length||u.hash||q.environment!=='BETA')denied(400,'INVALID_ADMIN_REQUEST');
  const match=/^\/bff\/b2b-admin\/applications(?:\/([a-f0-9-]{36})(\/rotate-secret)?)?$/.exec(u.pathname);if(!match)denied(404,'RESOURCE_NOT_FOUND');
  const [,id,rotate]=match;let result:unknown;
  if(method==='GET'&&body===undefined&&!rotate)result=id?await this.options.facade.read(s.accessToken,id,q):await this.options.facade.list(s.accessToken,q);
  else if(method==='POST'&&!id)result=await this.options.facade.create(s.accessToken,q,body);
  else if(method==='POST'&&rotate)result=await this.options.facade.rotate(s.accessToken,id,q,body);
  else if(method==='PATCH'&&id&&!rotate)result=await this.options.facade.update(s.accessToken,id,q,body);
  else return denied(400,'INVALID_ADMIN_REQUEST');
  await this.current(cookie,s);return result;
 });}
}
