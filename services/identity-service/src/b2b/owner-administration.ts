import {randomUUID} from 'node:crypto';
import {B2bSecurityError,validB2bBinding} from '@factuez/contracts/b2b-security';
import {adminDigest,adminSnapshot,phase8AdminPolicy,type PrivilegedHumanAuthority,type PrivilegedHumanRequest,type Phase8LiveHumanIdentity,type Phase8AdminBindingOwner,type Phase8AdminAction} from '@factuez/service-access/dist/b2b-phase8-admin-wire';
import {currentGlobalClaims} from '@factuez/service-access/dist/b2b-owner-administration';
import type {Store,Audit} from './model';
const rejected=(status=403)=>new B2bSecurityError(status,'OWNER_ADMINISTRATION_DENIED');
export type AdministrativeOwner='billing'|'fiscal'|'mailer';
export type OwnerAdministrationPeers=Record<AdministrativeOwner,readonly string[]>;
type Dependencies={enabled?:boolean;peers:OwnerAdministrationPeers;authority:PrivilegedHumanAuthority;live:Phase8LiveHumanIdentity;bindings:Phase8AdminBindingOwner;store:Store};
const policy={billing:['MASTERS_','ISSUER_','BRANCH_','POINT_','SERIES_','PRINT_'],fiscal:['FISCAL_'],mailer:['SMTP_']} as const;
export function ownerAdministrationPeers(value:OwnerAdministrationPeers):OwnerAdministrationPeers {
 if(!value||Object.keys(value).sort().join(',')!=='billing,fiscal,mailer')throw rejected(503);
 const all:string[]=[];
 for(const owner of Object.keys(policy) as AdministrativeOwner[]){const peers=value[owner];
  if(!Array.isArray(peers)||peers.length>32||peers.some(p=>typeof p!=='string'||!/^[a-f0-9]{64}$/.test(p)))throw rejected(503);all.push(...peers);
 }if(!all.length||new Set(all).size!==all.length)throw rejected(503);
 return structuredClone(value);
}
function humanStamp(v:any){return adminDigest({sub:v.sub,authVersion:v.authVersion,roles:v.roles,permissions:v.permissions,scope:v.scope});}
/** Role-specific private relay over genuine OIDC/current-user/Billing authorities.
 * It grants no application scope and never fabricates a human from a certificate. */
export class B2bOwnerAdministration {
 #peers:OwnerAdministrationPeers;#deps:Dependencies;
 constructor(deps:Dependencies){
  this.#peers=ownerAdministrationPeers(deps.peers);
  this.#deps=deps;
 }
 peers(){return Object.values(this.#peers).flat();}
 status(peer:string){return {schemaVersion:'factuez.b2b.owner-authority.v1',environment:'BETA',owner:this.owner(peer),state:'ASSEMBLED'};}
 private owner(peer:string):AdministrativeOwner {
  if(this.#deps.enabled!==true)throw rejected(503);
  const owner=(Object.keys(policy) as AdministrativeOwner[]).find(o=>this.#peers[o].includes(peer));if(!owner)throw rejected();return owner;
 }
 private async audit(peer:string,action:string,actorId:string|null,revision:number|null,outcome='ALLOWED'){
  const event:Audit={id:randomUUID(),requestId:randomUUID(),clientId:null,actorId,action,outcome,revision,peerHash:peer,at:new Date().toISOString()};
  await this.#deps.store.transaction(tx=>tx.audit(event));
 }
 async authorize(peer:string,token:string,input:unknown){
  try{
   const owner=this.owner(peer),q=adminSnapshot(input) as Omit<PrivilegedHumanRequest,'token'>;
   if(!q||typeof q!=='object'||Array.isArray(q)||Object.keys(q).some(k=>!['kind','action','binding','payloadDigest','id'].includes(k))||q.kind!=='USER'||
    !Object.hasOwn(phase8AdminPolicy,q.action)||!policy[owner].some(prefix=>q.action.startsWith(prefix))||!validB2bBinding(q.binding)||
    typeof q.payloadDigest!=='string'||!/^[a-f0-9]{64}$/.test(q.payloadDigest)||q.id!==undefined&&(typeof q.id!=='string'||!q.id||q.id.length>80)||
    typeof token!=='string'||!/^[A-Za-z0-9._~-]{1,8192}$/.test(token))throw rejected();
   const before=adminSnapshot(await this.#deps.bindings.revalidate(q.binding)),result=adminSnapshot(await this.#deps.authority.authorize({...q,token}));
   const live=adminSnapshot(await this.#deps.live.current(result.claims.sub)),after=adminSnapshot(await this.#deps.bindings.revalidate(q.binding));
   const permission=phase8AdminPolicy[q.action as Phase8AdminAction][1];
   if(!currentGlobalClaims(result.claims)||!currentGlobalClaims(live)||humanStamp(result.claims)!==humanStamp(live)||!live.permissions.includes(permission)||
    !live.permissions.includes('setup.manage')||result.stepUpVerified!==true||!Number.isSafeInteger(result.expiresAt)||result.expiresAt<=Date.now()||result.expiresAt>Date.now()+30000||
    typeof result.policyRevision!=='string'||!/^[a-f0-9]{64}$/.test(result.policyRevision)||adminDigest(before)!==adminDigest(after)||adminDigest(after.binding)!==adminDigest(q.binding)||!after.revision)throw rejected();
   await this.audit(peer,'OWNER_ADMIN_'+owner.toUpperCase()+'_'+q.action,live.sub,live.authVersion);
   if(result.expiresAt<=Date.now())throw rejected();
   return {schemaVersion:'factuez.b2b.owner-authority.v1',requestSha256:adminDigest(q),...result};
  }catch(error){if(this.#deps.enabled===true&&this.peers().includes(peer))await this.audit(peer,'OWNER_ADMIN_DENIED',null,null,'DENIED').catch(()=>{});if(error instanceof B2bSecurityError)throw error;throw rejected(503);}
 }
 async liveHuman(peer:string,input:unknown){
  try{
   this.owner(peer);const q=adminSnapshot(input) as any;
   if(!q||Object.keys(q).join(',')!=='subjectId'||typeof q.subjectId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(q.subjectId))throw rejected(400);
   const claims=adminSnapshot(await this.#deps.live.current(q.subjectId));if(claims!==null&&(!currentGlobalClaims(claims)||claims.sub!==q.subjectId))throw rejected(503);
   await this.audit(peer,'OWNER_ADMIN_LIVE_HUMAN',claims?.sub??null,claims?.authVersion??null);
   return {schemaVersion:'factuez.b2b.owner-authority.v1',claims};
  }catch(error){if(error instanceof B2bSecurityError)throw error;throw rejected(503);}
 }
 toJSON(){return {service:'B2bOwnerAdministration',contents:'PRIVATE'};}
}
