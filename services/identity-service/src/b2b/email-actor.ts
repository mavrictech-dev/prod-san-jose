import {randomUUID} from 'node:crypto';
import {inspect} from 'node:util';
import {B2bSecurityError,validB2bPrincipal,type B2bPrincipal} from '@factuez/contracts/b2b-security';
import {adminDigest,adminSnapshot} from '@factuez/service-access/dist/b2b-phase8-admin-wire';
import {queuedEmailActor,queuedEmailScopes} from '@factuez/service-access/dist/b2b-email-actor';
import {clientView,type Store,type BindingCatalogue} from './model';
import type {QueuedUsers} from './webhook-authority';
const denied=(status=403)=>new B2bSecurityError(status,'EMAIL_ACTOR_DENIED');
/** Revalidates the persisted actor and current catalogue, not the bearer session
 * that created the job. No JWT, secret, or reusable authorization is minted. */
export class B2bQueuedEmailActor {
 #d:{enabled?:boolean;allowedScopes:readonly string[];store:Store;users:QueuedUsers;catalogue:BindingCatalogue};
 constructor(deps:{enabled?:boolean;allowedScopes:readonly string[];store:Store;users:QueuedUsers;catalogue:BindingCatalogue}){
  if(deps.enabled===true&&(!Array.isArray(deps.allowedScopes)||!['b2b:email:send','b2b:documents:read'].every(s=>deps.allowedScopes.includes(s))))throw denied(503);
  this.#d={...deps,allowedScopes:[...(deps.allowedScopes??[])]};
 }
 async check(raw:unknown,peer:string){
  if(this.#d.enabled!==true)throw denied(503);
  try{
   const q=adminSnapshot(raw) as any;
   if(!q||Object.keys(q).sort().join(',')!=='actor,requestId,requiredScopes,schemaVersion'||q.schemaVersion!=='factuez.b2b.email-actor.request.v1'||
    typeof q.requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(q.requestId)||!/^[a-f0-9]{64}$/.test(peer))throw denied(400);
   const actor=queuedEmailActor(q.actor),required=queuedEmailScopes(q.requiredScopes),d=this.#d,started=Date.now();
   if(required.some(s=>!d.allowedScopes.includes(s)))throw denied();
   const current=async()=>{
    const c=await d.store.transaction(tx=>tx.get(actor.clientId));
    if(!c||!c.enabled||c.kind!==actor.kind||c.revision!==actor.revision||required.some(s=>!c.scopes.includes(s)))throw denied();
    let selected=c.bindings,permissionsStamp:string|null=null;
    if(actor.kind==='USER'){
     const user=await d.users.current(actor);
     if(!user?.active||user.authVersion!==actor.userAuthRevision||!['document.view','document.email'].every(p=>user.permissions.includes(p)))throw denied();
     selected=selected.filter(b=>user.scope.kind==='GLOBAL'||user.scope.branchIds.includes(b.branchId)&&user.scope.emissionPointIds.includes(b.pointId)&&user.scope.series.includes(b.seriesId));
     permissionsStamp=adminDigest({permissions:[...user.permissions].sort(),scope:user.scope,revision:user.authVersion});
    }
    const principal:B2bPrincipal={...actor,environment:'BETA',scopes:required,bindings:structuredClone(selected)};
    if(!validB2bPrincipal(principal))throw denied();await d.catalogue.validate(principal.bindings);
    return {principal,stamp:adminDigest({client:clientView(c),permissionsStamp,principal})};
   };
   const before=await current(),after=await current();if(before.stamp!==after.stamp||Date.now()-started>30000)throw denied();
   await d.store.transaction(tx=>tx.audit({id:randomUUID(),requestId:q.requestId,clientId:actor.clientId,actorId:actor.subjectId,action:'AUTHORIZE_EMAIL_ACTOR',
    outcome:'ALLOWED',revision:actor.revision,peerHash:peer,at:new Date().toISOString()}));
   const final=await current();if(after.stamp!==final.stamp||Date.now()-started>30000)throw denied();
   const verifiedAt=Date.now();return {schemaVersion:'factuez.b2b.email-actor.response.v1',requestSha256:adminDigest(q),principal:final.principal,verifiedAt,expiresAt:verifiedAt+30000};
  }catch(e){if(e instanceof B2bSecurityError)throw e;throw denied(503);}
 }
 toJSON(){return {service:'B2bQueuedEmailActor',contents:'PRIVATE'};}[inspect.custom](){return this.toJSON();}
}
