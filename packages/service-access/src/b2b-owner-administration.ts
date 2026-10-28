import {PermissionCodes,RoleCodes,type AccessTokenClaims} from '@factuez/contracts';
import {B2bSecurityError,validB2bBinding,type B2bBinding} from '@factuez/contracts/b2b-security';
import {adminDigest,adminSnapshot,type PrivilegedHumanAuthority,type PrivilegedHumanRequest,type Phase8LiveHumanIdentity,type Phase8AdminBindingOwner} from './b2b-phase8-admin-wire';
import type {B2bPrivateHttp} from './b2b';
import {inspect} from 'node:util';
const unavailable=()=>new B2bSecurityError(503,'OWNER_ADMINISTRATION_UNAVAILABLE');
/** Actual private Identity clients. No public payload becomes claims/approval;
 * no token cache, synthetic administrator or cross-service database access. */
export class HttpB2bOwnerAdministration implements PrivilegedHumanAuthority,Phase8LiveHumanIdentity {
 constructor(private readonly http:Pick<B2bPrivateHttp,'post'>,private readonly expectedOwner?:'billing'|'fiscal'|'mailer'){}
 async readiness(){
  const result=adminSnapshot(await this.http.post('/internal/b2b/owner-authority/status',{})) as any;
  if(!result||Object.keys(result).sort().join(',')!=='environment,owner,schemaVersion,state'||result.schemaVersion!=='factuez.b2b.owner-authority.v1'||
   result.environment!=='BETA'||result.state!=='ASSEMBLED'||!['billing','fiscal','mailer'].includes(result.owner)||this.expectedOwner!==undefined&&result.owner!==this.expectedOwner)throw unavailable();
  return result;
 }
 async authorize(request:PrivilegedHumanRequest){
  const {token,...input}=adminSnapshot(request);
  const raw=adminSnapshot(await this.http.post('/internal/b2b/owner-authority/authorize',input,token)) as any;
  if(!raw||Object.keys(raw).sort().join(',')!=='claims,expiresAt,policyRevision,requestSha256,schemaVersion,stepUpVerified'||
   raw.schemaVersion!=='factuez.b2b.owner-authority.v1'||raw.requestSha256!==adminDigest(input)||raw.stepUpVerified!==true||
   !Number.isSafeInteger(raw.expiresAt)||raw.expiresAt<=Date.now()||raw.expiresAt>Date.now()+30000||typeof raw.policyRevision!=='string'||!/^[a-f0-9]{64}$/.test(raw.policyRevision)||
   !currentGlobalClaims(raw.claims))throw unavailable();
  return {claims:raw.claims as AccessTokenClaims,expiresAt:raw.expiresAt as number,policyRevision:raw.policyRevision as string,stepUpVerified:true as const};
 }
 async current(subjectId:string):Promise<AccessTokenClaims|null>{
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(subjectId))throw unavailable();
  const raw=adminSnapshot(await this.http.post('/internal/b2b/owner-authority/live-human',{subjectId})) as any;
  if(!raw||Object.keys(raw).sort().join(',')!=='claims,schemaVersion'||raw.schemaVersion!=='factuez.b2b.owner-authority.v1')throw unavailable();
  if(raw.claims===null)return null;if(!currentGlobalClaims(raw.claims)||raw.claims.sub!==subjectId)throw unavailable();return raw.claims;
 }
 toJSON(){return {service:'HttpB2bOwnerAdministration',contents:'PRIVATE'};}
 [inspect.custom](){return this.toJSON();}
}
/** Catalogue validation remains in Billing, with current active hierarchy. */
export class HttpB2bOwnerBinding implements Phase8AdminBindingOwner {
 constructor(private readonly http:Pick<B2bPrivateHttp,'post'>){}
 async revalidate(binding:B2bBinding){
  if(!validB2bBinding(binding))throw unavailable();
  const result=adminSnapshot(await this.http.post('/internal/b2b/validate-bindings',{bindings:[structuredClone(binding)]})) as any;
  if(!result||Object.keys(result).join(',')!=='valid'||result.valid!==true)throw unavailable();
  return {binding:structuredClone(binding),revision:adminDigest({schemaVersion:'factuez.billing.validated-binding.v1',binding})};
 }
 toJSON(){return {service:'HttpB2bOwnerBinding',contents:'PRIVATE'};}[inspect.custom](){return this.toJSON();}
}
export function currentGlobalClaims(value:any):value is AccessTokenClaims {
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&typeof value.sub==='string'&&
  Object.keys(value).every(k=>['sub','username','fullName','authVersion','roles','permissions','scope','iss','aud','iat','exp'].includes(k))&&typeof value.username==='string'&&value.username.length<=200&&
  (value.fullName===undefined||typeof value.fullName==='string'&&value.fullName.length<=300)&&typeof value.iss==='string'&&value.iss.startsWith('https://')&&
  value.aud==='factuez-b2b-v1'&&Number.isSafeInteger(value.iat)&&value.iat*1000<=Date.now()&&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.sub)&&Number.isSafeInteger(value.authVersion)&&value.authVersion>=0&&
  value.scope?.kind==='GLOBAL'&&Object.keys(value.scope).length===1&&Array.isArray(value.roles)&&value.roles.includes('ADMIN')&&
  value.roles.length<=Object.keys(RoleCodes).length&&new Set(value.roles).size===value.roles.length&&value.roles.every((r:any)=>Object.values(RoleCodes).includes(r))&&
  Array.isArray(value.permissions)&&value.permissions.length<=Object.keys(PermissionCodes).length&&new Set(value.permissions).size===value.permissions.length&&
  value.permissions.every((p:any)=>Object.values(PermissionCodes).includes(p))&&Number.isSafeInteger(value.exp)&&value.exp>value.iat&&value.exp*1000>Date.now()&&value.exp*1000<=Date.now()+30000;
}
