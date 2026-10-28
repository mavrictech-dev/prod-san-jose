import {randomUUID} from 'node:crypto';
import {inspect} from 'node:util';
import {b2bUuid} from '@factuez/contracts/b2b-read-query';
import {correctionEvidenceFreeze,correctionEvidenceHash as hash} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import {B2bOwnerReadFrame,type B2bIdentityPort} from '@factuez/service-access/dist/b2b-read-adapter';
import {receivedAnchor,receivedScope,receivedFail} from '@factuez/service-access/dist/b2b-received-wire';
import {imapHost} from '../automation/policy';
import type {ReceptionDispatchAuthority,ReceptionDispatchContext} from './automation-dispatch';
import type {ReadOnlyReceptionAdmissionPort,ReadOnlyReceptionBinding} from './automation-read-only.types';
const integer=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2147483647;
/** An explicit, run/configuration-bound owner deployment policy. No env lookup,
 * broad RUC defaults, activation on save, or approval supplied by HTTP callers.
 * Revocation remains live through Identity and independent owner grants. */
export class FixedReceptionReadOnlyAdmission implements ReadOnlyReceptionAdmissionPort{
 #bindings:readonly ReadOnlyReceptionBinding[];
 constructor(bindings:readonly ReadOnlyReceptionBinding[]){
  const list=correctionEvidenceFreeze(bindings);
  if(!Array.isArray(list)||!list.length||list.length>100)receivedFail(503,'RECEIVED_READ_ONLY_NOT_CONFIGURED');
  const keys=new Set<string>();
  for(const b of list){
   if(!b||Object.keys(b).sort().join(',')!=='approvalId,approvalRevision,approvedImapHosts,configurationSha256,connectionRevision,scope,sources'||
    !b2bUuid(b.approvalId)||!integer(b.approvalRevision)||!integer(b.connectionRevision)||!/^[a-f0-9]{64}$/.test(b.configurationSha256)||
    !Array.isArray(b.sources)||!b.sources.length||b.sources.length>2||new Set(b.sources).size!==b.sources.length||b.sources.some((s:string)=>!['MAIL','SIRE'].includes(s))||
    !Array.isArray(b.approvedImapHosts)||b.approvedImapHosts.length>16||new Set(b.approvedImapHosts).size!==b.approvedImapHosts.length||b.approvedImapHosts.some((h:string)=>!imapHost(h)))receivedFail(503,'RECEIVED_READ_ONLY_NOT_CONFIGURED');
   receivedScope(b.scope);const key=hash(b.scope);if(keys.has(key))receivedFail(503,'RECEIVED_READ_ONLY_NOT_CONFIGURED');keys.add(key);
  }
  this.#bindings=list;
 }
 async authorize(context:ReceptionDispatchContext,configurationSha256:string){
  const c=correctionEvidenceFreeze(context),s=receivedScope(c.scope),b=this.#bindings.find(b=>hash(b.scope)===hash(s));
  if(!b||b.connectionRevision!==c.revision||b.configurationSha256!==configurationSha256||!b.sources.includes(c.source)||!b2bUuid(c.runId))receivedFail(403,'RECEIVED_READ_ONLY_APPROVAL_REQUIRED');
  return correctionEvidenceFreeze({approvalId:b.approvalId,revision:b.approvalRevision,profile:'READ_ONLY' as const,contextSha256:hash(c),configurationSha256,approvedImapHosts:b.approvedImapHosts});
 }
 toJSON(){return {profile:'READ_ONLY',configured:true};}
 [inspect.custom](){return 'FixedReceptionReadOnlyAdmission { bindings: [PRIVATE] }';}
}
/** Fresh credentials only. The provider must obtain the original application's
 * own SERVICE token from private Identity using its enrolled mTLS credentials.
 * USER cannot be converted into a background administrator. */
export class ServiceReceptionDispatchAuthority implements ReceptionDispatchAuthority{
 #leases=new Map<string,{executionId:string;expiresAt:string;contextSha256:string}>();
 #identity:B2bIdentityPort;#credentials:(context:ReceptionDispatchContext)=>Promise<{kind:'SERVICE';token:string}>;
 constructor(identity:B2bIdentityPort,credentials:(context:ReceptionDispatchContext)=>Promise<{kind:'SERVICE';token:string}>){
  if(typeof identity?.authenticate!=='function'||typeof credentials!=='function')receivedFail(503,'RECEIVED_READ_ONLY_NOT_CONFIGURED');this.#identity=identity;this.#credentials=credentials;
 }
 async authorize(input:ReceptionDispatchContext){
  const c=correctionEvidenceFreeze(input);receivedScope(c.scope);
  if(c.actor.kind!=='SERVICE'||c.actor.subjectId!==null||c.actor.userAuthRevision!==null||!b2bUuid(c.runId))receivedFail(403,'RECEIVED_SERVICE_ACTOR_REQUIRED');
  const access=correctionEvidenceFreeze(await this.#credentials(c));
  if(!access||Object.keys(access).sort().join(',')!=='kind,token'||access.kind!=='SERVICE'||typeof access.token!=='string'||!/^[A-Za-z0-9._~-]{1,8192}$/.test(access.token))receivedFail(403,'RECEIVED_SERVICE_ACTOR_REQUIRED');
  const p=await new B2bOwnerReadFrame(this.#identity,'SERVICE').principal(access.token,c.source==='MAIL'?['b2b:received:sync','b2b:received:write']:['b2b:received:sync']);
  receivedAnchor(p,c.scope);
  if(p.clientId!==c.actor.clientId||p.revision!==c.actor.clientRevision||p.subjectId!==null||p.userAuthRevision!==null)receivedFail(403,'RECEIVED_SERVICE_ACTOR_REQUIRED');
  const now=Date.now(),contextSha256=hash(c);
  for(const [key,lease]of this.#leases)if(Date.parse(lease.expiresAt)<=now)this.#leases.delete(key);
  let lease=this.#leases.get(c.runId);
  if(lease&&lease.contextSha256!==contextSha256)receivedFail(403,'RECEIVED_SERVICE_ACTOR_REQUIRED');
  if(!lease){if(this.#leases.size>=100)receivedFail(503,'RECEIVED_READ_ONLY_BUSY');lease={executionId:randomUUID(),expiresAt:new Date(now+240000).toISOString(),contextSha256};this.#leases.set(c.runId,lease);}
  return {access,...lease,administrator:null};
 }
 toJSON(){return {service:'ReceptionDispatchAuthority',credentials:'PRIVATE'};}
 [inspect.custom](){return 'ServiceReceptionDispatchAuthority { credentials: [PRIVATE] }';}
}
