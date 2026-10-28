import {randomUUID} from 'node:crypto';
import {inspect} from 'node:util';
import {B2bSecurityError,validB2bPrincipal,type B2bPrincipal,type B2bIdentityScope} from '@factuez/contracts/b2b-security';
import {adminDigest,adminSnapshot} from './b2b-phase8-admin-wire';
import type {B2bPrivateHttp} from './b2b';
export const EMAIL_ACTOR_RPC='/internal/b2b/authorize-email-actor';
export type QueuedEmailActor=Pick<B2bPrincipal,'kind'|'clientId'|'revision'|'subjectId'|'userAuthRevision'>;
export function queuedEmailActor(value:unknown):QueuedEmailActor {
 const a=adminSnapshot(value) as any;
 const uuid=(v:any)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
 if(!a||Object.keys(a).sort().join(',')!=='clientId,kind,revision,subjectId,userAuthRevision'||!uuid(a.clientId)||!Number.isSafeInteger(a.revision)||a.revision<1||
  (a.kind==='SERVICE'?a.subjectId!==null||a.userAuthRevision!==null:a.kind!=='USER'||!uuid(a.subjectId)||!Number.isSafeInteger(a.userAuthRevision)||a.userAuthRevision<0))throw new B2bSecurityError(403,'EMAIL_ACTOR_DENIED');
 return a;
}
export function queuedEmailScopes(value:readonly B2bIdentityScope[]):B2bIdentityScope[] {
 if(!Array.isArray(value)||value.length<2||value.length>3||new Set(value).size!==value.length||!value.includes('b2b:email:send')||!value.includes('b2b:documents:read')||
  value.some(v=>!['b2b:email:send','b2b:documents:read','b2b:artifacts:read'].includes(v)))throw new B2bSecurityError(403,'EMAIL_ACTOR_DENIED');
 return [...value].sort();
}
/** Metadata revalidation for an already persisted job, never a token exchange.
 * Available only to independently configured private worker certificates. */
export class HttpB2bEmailActor {
 #http:Pick<B2bPrivateHttp,'post'>;
 constructor(http:Pick<B2bPrivateHttp,'post'>){this.#http=http;}
 async freshIdentity(actor:Readonly<QueuedEmailActor>,requiredScopes:readonly B2bIdentityScope[]):Promise<B2bPrincipal>{
  try{
  const request={schemaVersion:'factuez.b2b.email-actor.request.v1',requestId:randomUUID(),actor:queuedEmailActor(actor),requiredScopes:queuedEmailScopes(requiredScopes)},started=Date.now();
  const r=adminSnapshot(await this.#http.post(EMAIL_ACTOR_RPC,request)) as any;
  if(!r||Object.keys(r).sort().join(',')!=='expiresAt,principal,requestSha256,schemaVersion,verifiedAt'||r.schemaVersion!=='factuez.b2b.email-actor.response.v1'||
   r.requestSha256!==adminDigest(request)||!Number.isSafeInteger(r.verifiedAt)||r.verifiedAt<started-2000||r.verifiedAt>Date.now()+2000||
   !Number.isSafeInteger(r.expiresAt)||r.expiresAt<=Date.now()||r.expiresAt>r.verifiedAt+30000||Date.now()-started>30000||!validB2bPrincipal(r.principal))throw new B2bSecurityError(503,'EMAIL_ACTOR_UNAVAILABLE');
  const p=r.principal as B2bPrincipal,{kind,clientId,revision,subjectId,userAuthRevision}=p;
  if(adminDigest({kind,clientId,revision,subjectId,userAuthRevision})!==adminDigest(request.actor)||adminDigest([...p.scopes].sort())!==adminDigest(request.requiredScopes))throw new B2bSecurityError(503,'EMAIL_ACTOR_UNAVAILABLE');
  return p;
  }catch(e){throw new B2bSecurityError(e instanceof B2bSecurityError&&[400,401,403,409,429].includes(e.status)?e.status:503,'EMAIL_ACTOR_UNAVAILABLE');}
 }
 toJSON(){return {service:'HttpB2bEmailActor',contents:'PRIVATE'};}[inspect.custom](){return this.toJSON();}
}
