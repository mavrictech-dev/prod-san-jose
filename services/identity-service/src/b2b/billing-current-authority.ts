import {randomUUID} from 'node:crypto';
import {inspect} from 'node:util';
import {B2bSecurityError,b2bBindingsContain,validB2bBinding,validB2bPrincipal,type B2bPrincipal} from '@factuez/contracts/b2b-security';
import {currentGlobalClaims} from '@factuez/service-access/dist/b2b-owner-administration';
import {billingAuthoritySchema,billingDigest,billingSnapshot,billingPolicy,billingAdminAction,billingPermissionFailure,
 type BillingAuthorityRequest,type BillingAuthorityReceipt} from '@factuez/service-access/dist/b2b-billing-authority-wire';
import type {Phase8LiveHumanIdentity} from '@factuez/service-access/dist/b2b-phase8-admin-wire';
import type {B2bIdentity} from './service';
import {OidcDelegationVerifier,type ProviderIntrospection,type LinkedUsers} from './oidc';
import {clientView,type Store,type BindingCatalogue} from './model';
export interface BillingCurrentAuthorityDependencies {
 enabled?:boolean;identity:Pick<B2bIdentity,'authenticate'>;provider:ProviderIntrospection;users:LinkedUsers;
 live:Phase8LiveHumanIdentity;store:Store;catalogue:BindingCatalogue;issuer:string;clientId:string;acceptedAcr:readonly string[];
}
/** Current operational permissions. SERVICE has no implicit owner policy here.
 * Uses the SAME Identity.authenticate as ordinary private introspection, including
 * scope filtering; a global catalogue mutation additionally requires current MFA. */
export class B2bBillingCurrentAuthority {
 #d:BillingCurrentAuthorityDependencies;
 constructor(deps:BillingCurrentAuthorityDependencies){this.#d={...deps,acceptedAcr:[...deps.acceptedAcr]};}
 async execute(raw:unknown,token:string|undefined,peer:string):Promise<BillingAuthorityReceipt|{schemaVersion:string;environment:'BETA';state:'ASSEMBLED'}>{
  if(this.#d.enabled!==true)return billingPermissionFailure();
  try{
   const q=billingSnapshot(raw) as BillingAuthorityRequest;
   if(q&&Object.keys(q).join(',')==='action'&&String(q.action)==='STATUS'){
    if(token!==undefined)return billingPermissionFailure(400);return {schemaVersion:billingAuthoritySchema,environment:'BETA',state:'ASSEMBLED'};
   }
   if(!q||Object.keys(q).sort().join(',')!=='action,binding,operation,requestId'||q.action!=='AUTHORIZE'||!validB2bBinding(q.binding)||
    typeof q.requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(q.requestId)||
    typeof token!=='string'||!/^[A-Za-z0-9._~-]{16,8192}$/.test(token)||!/^[a-f0-9]{64}$/.test(peer))return billingPermissionFailure(400);
   const [scopes,permissions]=billingPolicy(q.operation),d=this.#d,started=Date.now(),ctx={requestId:q.requestId,peer};
   const current=async()=>{
    const principal=billingSnapshot(await d.identity.authenticate(token,[...scopes],ctx,'USER')) as B2bPrincipal;
    if(!validB2bPrincipal(principal)||principal.kind!=='USER'||!b2bBindingsContain(principal.bindings,q.binding))return billingPermissionFailure(403);
    const client=await d.store.transaction(tx=>tx.get(principal.clientId)),user=await d.users.current(principal.subjectId!);
    if(!client?.enabled||client.kind!=='USER'||client.revision!==principal.revision||!user.active||user.authVersion!==principal.userAuthRevision||
     scopes.some(s=>!client.scopes.includes(s))||permissions.some(p=>!user.permissions.includes(p)))return billingPermissionFailure(403);
    await d.catalogue.validate([q.binding]);
    let administrator=null,stepUpExpires=started+30000;
    if(billingAdminAction(q.operation)){
     const raw=billingSnapshot(await d.provider.introspect(token)) as any,now=Math.floor(Date.now()/1000);
     if(!raw||raw.active!==true||raw.token_type!=='Bearer'||raw.iss!==d.issuer||raw.client_id!==d.clientId||client.oidcClientId!==d.clientId||
      !Number.isSafeInteger(raw.auth_time)||raw.auth_time<0||raw.auth_time>now||now-raw.auth_time>=300||!Number.isSafeInteger(raw.iat)||raw.auth_time>raw.iat||
      !Number.isSafeInteger(raw.exp)||raw.exp<=now||!Array.isArray(raw.amr)||!raw.amr.includes('mfa')||new Set(raw.amr).size!==raw.amr.length||!d.acceptedAcr.includes(raw.acr))return billingPermissionFailure(403);
     const delegated=await new OidcDelegationVerifier(d.issuer,{introspect:async value=>{if(value!==token)return billingPermissionFailure(403);return raw;}},d.users).verify(token);
     if(delegated.clientId!==principal.clientId||delegated.clientRevision!==principal.revision||delegated.userId!==principal.subjectId||
      delegated.authRevision!==principal.userAuthRevision||scopes.some(s=>!delegated.tokenScopes.includes(s)))return billingPermissionFailure(403);
     administrator=billingSnapshot(await d.live.current(principal.subjectId!));
     if(!currentGlobalClaims(administrator)||administrator.sub!==principal.subjectId||administrator.authVersion!==principal.userAuthRevision||
      billingDigest([...administrator.permissions].sort())!==billingDigest([...user.permissions].sort()))return billingPermissionFailure(403);
     stepUpExpires=Math.min(stepUpExpires,raw.exp*1000,(raw.auth_time+300)*1000);
    }
    const revision=billingDigest({principal,client:clientView(client),permissions:[...user.permissions].sort(),scope:user.scope,
     human:administrator?{sub:administrator.sub,authVersion:administrator.authVersion,roles:administrator.roles,permissions:administrator.permissions,scope:administrator.scope}:null,
     operation:q.operation,binding:q.binding});
    return {principal,permissions:[...user.permissions].sort(),administrator,revision,stepUpExpires};
   };
   const before=await current(),after=await current();if(before.revision!==after.revision)return billingPermissionFailure(401);
   await d.store.transaction(tx=>tx.audit({id:randomUUID(),requestId:q.requestId,clientId:after.principal.clientId,actorId:after.principal.subjectId,
    action:'BILLING_OWNER_'+q.operation,outcome:'ALLOWED',revision:after.principal.revision,peerHash:peer,at:new Date().toISOString()}));
   const final=await current(),expiresAt=Math.min(final.stepUpExpires,Date.now()+30000);
   if(final.revision!==before.revision||Date.now()-started>=30000||expiresAt<=Date.now())return billingPermissionFailure(401);
   return {schemaVersion:billingAuthoritySchema,requestSha256:billingDigest(q),principal:final.principal,permissions:final.permissions,
    administrator:final.administrator,stepUpVerified:billingAdminAction(q.operation),revision:final.revision,expiresAt};
  }catch(e){return billingPermissionFailure(e instanceof B2bSecurityError&&[400,401,403,429].includes(e.status)?e.status:503);}
 }
 toJSON(){return {service:'B2bBillingCurrentAuthority',contents:'PRIVATE'};}[inspect.custom](){return this.toJSON();}
}
