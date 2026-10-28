import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {inspect} from 'node:util';
import {B2bSecurityError,validB2bBinding} from '@factuez/contracts/b2b-security';
import {OidcDelegationVerifier,type ProviderIntrospection,type LinkedUsers} from './oidc';
import type {BindingCatalogue,RequestContext} from './model';
import type {QueuedUsers} from './webhook-authority';
import type {Phase8LiveHumanIdentity} from '@factuez/service-access/dist/b2b-phase8-admin-wire';
import {b2bUuid} from '@factuez/contracts/b2b-read-query';
import {receivedScope} from '@factuez/service-access/dist/b2b-received-wire';
import {copy,hash,sha,exact,denied,unavailable,approvalContext,anchor,targetScopes,type ApprovalContext,type ApprovalRow} from './received-approval-model';
import type {ReceivedApprovalStore,ReceivedApprovalTx} from './received-approval-store';
const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
const humanStamp=(v:any)=>hash({sub:v.sub,authVersion:v.authVersion,roles:[...v.roles].sort(),permissions:[...v.permissions].sort(),scope:v.scope});
export interface ReceivedApprovalDependencies {
 store:ReceivedApprovalStore;provider:ProviderIntrospection;users:LinkedUsers;queuedUsers:QueuedUsers;live:Phase8LiveHumanIdentity;catalogue:BindingCatalogue;
 issuer:string;clientId:string;acceptedAcr:readonly string[];
}
export class ReceivedApprovalAuthority {
 #d:ReceivedApprovalDependencies;#enabled:boolean;#now:()=>number;
 constructor(dependencies:ReceivedApprovalDependencies,options:{enabled?:boolean;now?:()=>number}={}){this.#d={...dependencies,acceptedAcr:[...dependencies.acceptedAcr]};this.#enabled=options.enabled===true;this.#now=options.now??Date.now;}
 #admit(){if(!this.#enabled)throw new B2bSecurityError(503,'RECEIVED_APPROVAL_DISABLED');const t=this.#now();if(!Number.isSafeInteger(t)||t<1)throw unavailable();return t;}
 #claims(v:any){const now=this.#admit()/1000;
  if(!v||v.iss!==this.#d.issuer||v.client_id!==this.#d.clientId||!Number.isSafeInteger(v.auth_time)||v.auth_time<0||v.auth_time>now||now-v.auth_time>=300||v.auth_time>v.iat||
   !Array.isArray(v.amr)||!v.amr.every((x:unknown)=>typeof x==='string')||!v.amr.includes('mfa')||!this.#d.acceptedAcr.includes(v.acr))throw denied();
 }
 async #identity(token:string,context:ApprovalContext,tx:ReceivedApprovalTx){
  const d=this.#d,raw:any=copy(await d.provider.introspect(token));this.#claims(raw);
  const who=await new OidcDelegationVerifier(d.issuer,{introspect:async value=>{if(value!==token)throw denied();return raw;}},d.users,()=>Math.floor(this.#admit()/1000)).verify(token);
  const app=await tx.client(who.clientId),live=await d.live.current(who.userId);
  if(!app||app.kind!=='USER'||!app.enabled||app.oidcClientId!==d.clientId||app.revision!==who.clientRevision||!app.scopes.includes(context.requiredScope as any)||!who.tokenScopes.includes(context.requiredScope as any)||
   !live||!b2bUuid(live.sub)||live.sub[14]!=='4'||live.sub!==who.userId||live.authVersion!==who.authRevision||live.exp*1000<=this.#admit()||live.scope.kind!=='GLOBAL'||!live.roles.includes('ADMIN')||!live.permissions.includes('setup.manage')||
   hash([...who.permissions].sort())!==hash([...live.permissions].sort())||!app.bindings.every(validB2bBinding))throw denied();
  await d.catalogue.validate([anchor(app.bindings,context.scope)]);
  let targetSha256:string|null=null;let targetCheck:{actor:Parameters<QueuedUsers['current']>[0];stamp:string}|null=null;
  if(context.purpose==='GRANT'){
   const p=context.policy,target=await tx.client(p.subject.clientId);
   if(!target||!target.enabled||target.kind!==p.subject.kind||target.revision!==p.clientRevision||targetScopes(context).some(s=>!target.scopes.includes(s as any))||!target.bindings.every(validB2bBinding))throw denied();
   const b=anchor(target.bindings,context.scope);await d.catalogue.validate([b]);let targetUser:unknown=null;
   if(target.kind==='USER'){
    const u=await d.queuedUsers.current({kind:'USER',clientId:target.id,revision:target.revision,subjectId:p.subject.subjectId,userAuthRevision:p.userAuthRevision});
    const permissions=p.permission?['document.view','report.view',...(p.permission==='ARTIFACT'?['report.export']:[])]:['setup.manage'];
    if(!u?.active||u.authVersion!==p.userAuthRevision||permissions.some(s=>!u.permissions.includes(s))||u.scope.kind!=='GLOBAL'&&(!u.scope.branchIds.includes(b.branchId)||!u.scope.emissionPointIds.includes(b.pointId)||!u.scope.series.includes(b.seriesId)))throw denied();targetUser=u;targetCheck={actor:{kind:'USER',clientId:target.id,revision:target.revision,subjectId:p.subject.subjectId,userAuthRevision:p.userAuthRevision},stamp:hash(u)};
   }
   targetSha256=hash({target,targetUser});
  }
  const last=copy(await d.provider.introspect(token));this.#claims(last);
  if(hash(raw)!==hash(last))throw denied();
  if(targetCheck&&hash(await d.queuedUsers.current(targetCheck.actor))!==targetCheck.stamp)throw denied();
  const link=await d.users.link(d.issuer,raw.sub,d.clientId),fresh=await d.live.current(who.userId);
  if(!link?.enabled||link.clientId!==who.clientId||link.clientRevision!==who.clientRevision||link.userId!==who.userId||link.userAuthRevision!==who.authRevision||
   !fresh||humanStamp(fresh)!==humanStamp(live)||fresh.exp*1000<=this.#admit())throw denied();
  return {adminId:live.sub,authRevision:live.authVersion,clientId:app.id,clientRevision:app.revision,
   identitySha256:hash({app,identity:humanStamp(live),link:who,claims:raw}),targetSha256,
   validUntil:Math.min(raw.exp*1000,(raw.auth_time+300)*1000,fresh.exp*1000)};
 }
 #audit(tx:ReceivedApprovalTx,row:ApprovalRow,action:string,ctx:RequestContext){
  if(typeof ctx.peer!=='string'||!ctx.peer||ctx.peer.length>256)throw denied();
  return tx.audit({id:randomUUID(),requestId:row.approvalId,clientId:row.clientId,actorId:row.adminId,action,outcome:'OK',revision:row.clientRevision,peerHash:digest(ctx.peer),at:new Date(this.#admit()).toISOString()});
 }
 async prepare(token:string,input:unknown,ctx:RequestContext){
  this.#admit();try{
   const context=approvalContext(input),nonce=randomBytes(32).toString('base64url');
   const handle=Buffer.from(JSON.stringify({nonce,tokenOIDC:token})).toString('base64url');
   if(typeof token!=='string'||!/^[A-Za-z0-9._~-]{16,8192}$/.test(token)||handle.length>8192)throw denied();
   return await this.#d.store.transaction(async tx=>{
    const before=await this.#identity(token,context,tx),at=this.#admit(),expiresAt=Math.min(at+30000,before.validUntil);
    if(expiresAt<=at)throw denied();
    const row:ApprovalRow={schemaVersion:'factuez.b2b.received-approval.v1',approvalId:randomUUID(),nonceHash:digest(nonce),tokenSha256:digest(token),context,...before,createdAt:at,expiresAt};
    // validUntil is authorization-local, not part of persisted metadata.
    delete (row as any).validUntil;
    await tx.insert(row);await this.#audit(tx,row,'RECEIVED_APPROVAL_PREPARE',ctx);
    const after=await this.#identity(token,context,tx);if(hash({...before,validUntil:0})!==hash({...after,validUntil:0})||this.#admit()>=Math.min(expiresAt,after.validUntil))throw denied();
    return {schemaVersion:'factuez.b2b.received-approval-prepared.v1',purpose:context.purpose,action:context.action,scope:context.scope,requestSha256:context.requestSha256,handle,expiresAt:new Date(expiresAt).toISOString()};
   });
  }catch(e){if(e instanceof B2bSecurityError)throw e;throw unavailable();}
 }
 async verify(input:unknown,ctx:RequestContext){
  this.#admit();try{
   const v:any=copy(input);exact(v,v?.purpose==='GRANT'?['schemaVersion','purpose','handle','requestSha256']:['schemaVersion','purpose','handle','requestSha256','actor','scope','action']);
   if(v.schemaVersion!=='factuez.b2b.received-stepup-request.v1'||!['GRANT','AUTOMATION'].includes(v.purpose)||!sha(v.requestSha256)||typeof v.handle!=='string'||v.handle.length>8192||!/^[A-Za-z0-9_-]+$/.test(v.handle))throw denied();
   const bytes=Buffer.from(v.handle,'base64url');if(bytes.toString('base64url')!==v.handle)throw denied();const h=JSON.parse(bytes.toString('utf8'));exact(h,['nonce','tokenOIDC']);
   if(JSON.stringify(h)!==bytes.toString('utf8')||typeof h.nonce!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(h.nonce)||typeof h.tokenOIDC!=='string'||!/^[A-Za-z0-9._~-]{16,8192}$/.test(h.tokenOIDC))throw denied();
   return await this.#d.store.transaction(async tx=>{
    const row=await tx.get(digest(h.nonce));if(!row||!b2bUuid(row.approvalId)||row.schemaVersion!=='factuez.b2b.received-approval.v1'||row.nonceHash!==digest(h.nonce)||row.tokenSha256!==digest(h.tokenOIDC)||row.context.purpose!==v.purpose||row.context.requestSha256!==v.requestSha256||
     !Number.isSafeInteger(row.createdAt)||row.createdAt<1||!Number.isSafeInteger(row.expiresAt)||row.expiresAt<=row.createdAt||row.expiresAt>row.createdAt+30000||row.createdAt>this.#admit()||row.expiresAt<=this.#admit())throw denied();
    // Reconstruct GRANT from stored full policy: no arbitrary digest can be substituted even though verify omits context.
    if(row.context.purpose==='GRANT'&&hash(approvalContext({schemaVersion:'factuez.b2b.received-approval-prepare.v1',purpose:'GRANT',policy:row.context.policy,expectedRevision:row.context.expectedRevision}))!==hash(row.context))throw denied();
    if(v.purpose==='AUTOMATION'){
     exact(v.actor,['clientId','subjectId','authRevision']);if(hash(receivedScope(v.scope))!==hash(row.context.scope)||v.action!==row.context.action||hash(v.actor)!==hash({clientId:row.clientId,subjectId:row.adminId,authRevision:row.authRevision}))throw denied();
    }
    const current=await this.#identity(h.tokenOIDC,row.context,tx);
    const matches=(who:typeof current)=>['adminId','authRevision','clientId','clientRevision','identitySha256','targetSha256'].every(k=>(who as any)[k]===(row as any)[k]);
    if(!matches(current))throw denied();await this.#audit(tx,row,'RECEIVED_APPROVAL_VERIFY',ctx);
    const final=await this.#identity(h.tokenOIDC,row.context,tx);if(!matches(final)||this.#admit()>=row.expiresAt||this.#admit()>=final.validUntil)throw denied();
    return {schemaVersion:'factuez.b2b.received-stepup-proof.v1',purpose:v.purpose,requestSha256:v.requestSha256,requestBindingSha256:hash(v),adminId:row.adminId,authRevision:row.authRevision,
     authority:'GLOBAL_ADMIN',permission:'setup.manage',expiresAt:new Date(Math.min(row.expiresAt,final.validUntil)).toISOString()};
   });
  }catch(e){if(e instanceof B2bSecurityError)throw e;throw denied();}
 }
 toJSON(){return {service:'ReceivedApprovalAuthority',contents:'PRIVATE'};}[inspect.custom](){return this.toJSON();}
}
