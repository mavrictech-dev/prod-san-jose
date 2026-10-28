import {PermissionCodes,RoleCodes,type AccessTokenClaims,type PermissionCode,type RoleCode} from '@factuez/contracts';
import {B2bAudience} from '@factuez/contracts/b2b';
import {B2bSecurityError,b2bBindingsContain,validB2bBinding,type B2bBinding,type B2bIdentityScope} from '@factuez/contracts/b2b-security';
import {adminDigest,adminSnapshot,phase8AdminPolicy,type Phase8AdminAction,type PrivilegedHumanAuthority,type PrivilegedHumanRequest,type Phase8LiveHumanIdentity,type Phase8AdminBindingOwner} from '@factuez/service-access/dist/b2b-phase8-admin-wire';
import type {PrismaService} from '../infrastructure/prisma.service';
import type {UserPermissionsService} from '../application/user-permissions.service';
import {OidcDelegationVerifier,type ProviderIntrospection,type LinkedUsers} from './oidc';
import {PostgresB2bStore} from './postgres-store';
import {uuid} from './model';
const reject=(status=403):never=>{throw new B2bSecurityError(status,'ADMIN_CURRENT_IDENTITY_REQUIRED');};
const actions=['USERS_LIST','USERS_CREATE','USERS_UPDATE','ROLES_LIST','ROLES_UPDATE'];
const stamp=(c:AccessTokenClaims)=>adminDigest({sub:c.sub,authVersion:c.authVersion,roles:c.roles,permissions:c.permissions,scope:c.scope});
/** Current owner projection, never a minted/transported JWT or claims supplied by a caller. */
export class PostgresB2bLiveHumanIdentity implements Phase8LiveHumanIdentity {
 #db:Pick<PrismaService,'user'>;#permissions:Pick<UserPermissionsService,'effective'>;#issuer:string;
 constructor(db:Pick<PrismaService,'user'>,permissions:Pick<UserPermissionsService,'effective'>,issuer:string){this.#db=db;this.#permissions=permissions;this.#issuer=issuer;}
 async #read(subjectId:string){
  const u=await this.#db.user.findUnique({where:{id:subjectId},select:{id:true,username:true,fullName:true,active:true,authVersion:true,
   roles:{select:{role:{select:{code:true,active:true,permissions:{select:{permission:{select:{code:true}}}}}}}}}});
  if(!u||u.id!==subjectId||!u.active||!Number.isSafeInteger(u.authVersion)||u.authVersion<0)return null;
  const roles=[...new Set(u.roles.filter(r=>r.role.active).map(r=>r.role.code))].sort();
  const permissions=[...new Set(u.roles.filter(r=>r.role.active).flatMap(r=>r.role.permissions.map(p=>PermissionCodes[p.permission.code])))].sort();
  if(!roles.includes('ADMIN'))return null;
  if(roles.some(r=>!Object.values(RoleCodes).includes(r))||permissions.some(p=>!Object.values(PermissionCodes).includes(p)))return reject(503);
  return {id:u.id,username:u.username,fullName:u.fullName,authVersion:u.authVersion,roles,permissions};
 }
 async current(subjectId:string):Promise<AccessTokenClaims|null>{
  if(!uuid(subjectId))return null;
  try{
   const before=await this.#read(subjectId);if(!before)return null;
   const extra=await this.#permissions.effective(subjectId),after=await this.#read(subjectId);
   if(!after||adminDigest(before)!==adminDigest(after)||!Array.isArray(extra)||extra.some(p=>!Object.values(PermissionCodes).includes(p)))return reject();
   const now=Math.floor(Date.now()/1000);
   return {sub:after.id,username:after.username,fullName:after.fullName,authVersion:after.authVersion,roles:after.roles as RoleCode[],
    permissions:[...new Set([...after.permissions,...extra])].sort() as PermissionCode[],scope:{kind:'GLOBAL'},iss:this.#issuer,aud:B2bAudience,iat:now,exp:now+30};
  }catch(e){if(e instanceof B2bSecurityError)throw e;return reject(503);}
 }
}
/** Real current hierarchy validation by Billing. Revision is a structural tuple digest, not an invented row version. */
export class HttpB2bIdentityBindingOwner implements Phase8AdminBindingOwner {
 #http:{post(path:string,body:unknown):Promise<unknown>};
 constructor(http:{post(path:string,body:unknown):Promise<unknown>}){this.#http=http;}
 async revalidate(binding:B2bBinding){
  if(!validB2bBinding(binding))return reject();
  try{const result=await this.#http.post('/internal/b2b/validate-bindings',{bindings:[structuredClone(binding)]});
   if(!result||typeof result!=='object'||Object.keys(result).join(',')!=='valid'||Object.getOwnPropertyDescriptor(result,'valid')?.value!==true)return reject();
   return {binding:structuredClone(binding),revision:adminDigest({schemaVersion:'factuez.billing.validated-binding.v1',binding})};
  }catch(e){if(e instanceof B2bSecurityError)throw e;return reject(503);}
 }
}
export class OidcB2bPrivilegedHumanAuthority implements PrivilegedHumanAuthority {
 #provider:ProviderIntrospection;#users:LinkedUsers;#live:Phase8LiveHumanIdentity;#store:PostgresB2bStore;
 #issuer:string;#clientId:string;#acr:readonly string[];#revision:string;#actions:readonly string[];#scopes:readonly B2bIdentityScope[];
 constructor(options:{provider:ProviderIntrospection;users:LinkedUsers;live:Phase8LiveHumanIdentity;store:PostgresB2bStore;issuer:string;clientId:string;acceptedAcr:readonly string[];policyRevision:string;actions?:readonly Phase8AdminAction[];allowedScopes?:readonly B2bIdentityScope[]}){
  this.#provider=options.provider;this.#users=options.users;this.#live=options.live;this.#store=options.store;this.#issuer=options.issuer;this.#clientId=options.clientId;this.#acr=[...options.acceptedAcr];this.#revision=options.policyRevision;
  const enabled=options.actions??actions;if(!Array.isArray(enabled)||!enabled.length||new Set(enabled).size!==enabled.length||enabled.some(a=>!Object.hasOwn(phase8AdminPolicy,a)))throw Error('EXPLICIT_ADMINISTRATION_ACTIONS_REQUIRED');this.#actions=[...enabled];
  if(enabled.some(a=>!actions.includes(a))&&!options.allowedScopes)throw Error('EXPLICIT_ADMINISTRATION_SCOPES_REQUIRED');this.#scopes=[...(options.allowedScopes??['b2b:identity:manage'])];
 }
 #stepUp(value:any):asserts value is Record<string,any>{
  const now=Math.floor(Date.now()/1000);
  if(!value||value.active!==true||value.token_type!=='Bearer'||value.iss!==this.#issuer||value.client_id!==this.#clientId||
   !Number.isSafeInteger(value.auth_time)||value.auth_time<0||value.auth_time>now||now-value.auth_time>=300||!Number.isSafeInteger(value.iat)||value.auth_time>value.iat||
   !Array.isArray(value.amr)||value.amr.some((v:unknown)=>typeof v!=='string'||!v)||new Set(value.amr).size!==value.amr.length||!value.amr.includes('mfa')||!this.#acr.includes(value.acr))return reject();
 }
 async authorize(request:PrivilegedHumanRequest){
  try{
   const q=adminSnapshot(request);
   if(!q||q.kind!=='USER'||!this.#actions.includes(q.action)||!validB2bBinding(q.binding)||typeof q.payloadDigest!=='string'||!/^[a-f0-9]{64}$/.test(q.payloadDigest))return reject();
   const requiredScope=phase8AdminPolicy[q.action][0];if(!this.#scopes.includes(requiredScope))return reject();
   const first=adminSnapshot(await this.#provider.introspect(q.token));this.#stepUp(first);
   // Reuse only this authenticated response for delegation validation; never return an unconditional decision.
   const delegated=await new OidcDelegationVerifier(this.#issuer,{introspect:async token=>{if(token!==q.token)return reject();return adminSnapshot(first);}},this.#users).verify(q.token);
   if(!delegated.tokenScopes.includes(requiredScope))return reject();
   const readClient=()=>this.#store.transaction(async tx=>tx.get(delegated.clientId)),client=await readClient();
   if(!client||!client.enabled||client.kind!=='USER'||client.oidcClientId!==this.#clientId||client.revision!==delegated.clientRevision||
    !client.scopes.includes(requiredScope)||!b2bBindingsContain(client.bindings,q.binding))return reject();
   const human=await this.#live.current(delegated.userId),permission=phase8AdminPolicy[q.action][1];
   if(!human||human.authVersion!==delegated.authRevision||human.scope.kind!=='GLOBAL'||!human.roles.includes('ADMIN')||
    ![permission,'setup.manage',...(actions.includes(q.action)?['user.manage','role.manage']:[])].every(p=>human.permissions.includes(p as PermissionCode))||
    adminDigest([...human.permissions].sort())!==adminDigest([...delegated.permissions].sort()))return reject();
   const last=adminSnapshot(await this.#provider.introspect(q.token));this.#stepUp(last);
   const current=await this.#live.current(delegated.userId),latestClient=await readClient();
   if(adminDigest(first)!==adminDigest(last)||!current||stamp(human)!==stamp(current)||adminDigest(client)!==adminDigest(latestClient))return reject();
   const expiresAt=Math.min(first.exp*1000,(first.auth_time+300)*1000,Date.now()+30000);
   if(!Number.isSafeInteger(expiresAt)||expiresAt<=Date.now()||current.exp*1000<=Date.now())return reject();
   return {claims:current,policyRevision:adminDigest({policy:this.#revision,client,identity:stamp(current),action:q.action,binding:q.binding,payloadDigest:q.payloadDigest,id:q.id??null}),stepUpVerified:true as const,expiresAt};
  }catch(e){if(e instanceof B2bSecurityError)throw e;return reject(503);}
 }
}

