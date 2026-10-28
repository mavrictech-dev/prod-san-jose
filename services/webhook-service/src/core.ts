import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {B2bSecurityError,b2bBindingsContain,validB2bBinding,type B2bPrincipal,type B2bIdentityScope} from '@factuez/contracts/b2b-security';
import {b2bIssuerId,b2bUuid} from '@factuez/contracts/b2b-read-query';
import {B2bOwnerReadFrame,type B2bIdentityPort} from '@factuez/service-access/dist/b2b-read-adapter';
import {snapshotHash} from '@factuez/service-access/dist/integration';
import {HookVault,newSigningSecret,signWebhook} from './crypto';
import {actorKey,ownerKey,type Actor,type HookStore,type HookTx,type Subscription,type LocalEvent,type InboxEvent,type Delivery,type CallbackTransport,type DeliveryAuthority,type Attempt} from './model';
const schemaVersion='factuez.b2b.v1',localEvent='document.issued-locally.v1';
const ref=(p:B2bPrincipal):Actor=>({kind:p.kind,clientId:p.clientId,revision:p.revision,subjectId:p.subjectId,userAuthRevision:p.userAuthRevision});
const version=(s:Subscription)=>'"v'+s.revision+'"';
const subView=(s:Subscription)=>({id:s.id,context:s.binding,label:s.label,destinationId:s.destinationId,revision:version(s),enabled:s.enabled,
  verified:s.verifiedRevision===s.revision,events:[localEvent],createdAt:new Date(s.createdAt).toISOString()});
const deliveryView=(d:Delivery)=>({id:d.id,subscriptionId:d.subscriptionId,eventId:d.eventId,state:d.state,attempts:d.attempts,round:d.round,
  nextAttemptAt:['PENDING','RETRY'].includes(d.state)?new Date(d.dueAt).toISOString():null,lastCode:d.lastCode,statusCode:d.statusCode});
function object(v:unknown,keys:string[]){return !!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));}
function requireSub(s:Subscription|null,p:B2bPrincipal,issuer:number){if(!s||ownerKey(s.actor)!==ownerKey(p)||s.binding.issuerId!==issuer||!b2bBindingsContain(p.bindings,s.binding))throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');return s;}
function assertVersion(s:Subscription,etag:unknown){if(typeof etag!=='string'||!/^"v[1-9][0-9]{0,8}"$/.test(etag))throw new B2bSecurityError(428,'PRECONDITION_REQUIRED');if(version(s)!==etag)throw new B2bSecurityError(412,'REVISION_CONFLICT');}
export function localCommit(value:unknown):LocalEvent {
  const keys=['schemaVersion','eventId','eventType','operationId','commandId','draftId','documentId','context','occurredAt','snapshotSha256','fiscalAcceptance'];const e=value as LocalEvent;
  if(!object(e,keys)||Object.keys(e).length!==keys.length||e.schemaVersion!==schemaVersion||e.eventType!==localEvent||e.fiscalAcceptance!=='NOT_ASSERTED'||
    ![e.eventId,e.operationId,e.commandId,e.draftId,e.documentId].every(b2bUuid)||!validB2bBinding(e.context)||typeof e.occurredAt!=='string'||!Number.isFinite(Date.parse(e.occurredAt))||
    !/^[a-f0-9]{64}$/.test(e.snapshotSha256))throw new B2bSecurityError(422,'UNSUPPORTED_OR_UNVERIFIED_EVENT');return e;
}
export class Webhooks {
  constructor(private readonly store:HookStore,private readonly identity:B2bIdentityPort,private readonly authority:DeliveryAuthority,
    private readonly callbacks:CallbackTransport,private readonly vault:HookVault,private readonly now=Date.now,private readonly jitter=Math.random){}
  private audit(tx:HookTx,owner:string,action:string,resourceId:string){return tx.audit({id:randomUUID(),owner,action,resourceId,at:this.now()});}
  async call(token:string,kind:'SERVICE'|'USER',action:string,args:any):Promise<any>{
    const read=['LIST','GET','DELIVERIES','DELIVERY'].includes(action);
    if(!['LIST','GET','CREATE','PATCH','VERIFY','ROTATE','DELIVERIES','DELIVERY','REPLAY'].includes(action)||!object(args,['issuerId','id','body','key','ifMatch','after'])||
      args.id!==undefined&&!b2bUuid(args.id)||args.after!==undefined&&!b2bUuid(args.after))throw new B2bSecurityError(400,'INVALID_REQUEST');
    const issuer=b2bIssuerId(args.issuerId),frame=new B2bOwnerReadFrame(this.identity,kind);
    if(['GET','DELIVERY'].includes(action)&&!b2bUuid(args.id))throw new B2bSecurityError(400,'INVALID_REQUEST');
    const required:B2bIdentityScope[]=['b2b:documents:read',read?'b2b:webhooks:read':'b2b:webhooks:manage'];
    const p=await frame.principal(token,required),owner=ownerKey(p);if(!p.bindings.some(b=>b.issuerId===issuer))throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');
    if(read)return this.store.transaction(async tx=>{
      let result:unknown;
      if(action==='LIST'||action==='DELIVERIES'){
        const raw=action==='LIST'?await tx.subs(owner,args.after):await tx.deliveries(owner,args.after),more=raw.length>100,items=[];
        for(const item of raw.slice(0,100)){const sub=action==='LIST'?item as Subscription:await tx.sub((item as Delivery).subscriptionId);if(sub&&sub.binding.issuerId===issuer&&b2bBindingsContain(p.bindings,sub.binding))items.push(action==='LIST'?subView(sub):{...deliveryView(item as Delivery),context:sub.binding});}
        result={schemaVersion,items,page:{hasMore:more,nextCursor:more?raw[99].id:null}};
      }else if(action==='GET')result={schemaVersion,...subView(requireSub(await tx.sub(args.id),p,issuer))};
      else{const d=await tx.delivery(args.id);if(!d)throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');const s=requireSub(await tx.sub(d.subscriptionId),p,issuer);result={schemaVersion,...deliveryView(d),context:s.binding,history:await tx.attempts(d.id)};}
      await this.audit(tx,owner,'READ_'+action,args.id??p.clientId);await frame.principal(token,required);return result;
    });
    if(typeof args.key!=='string'||!/^[A-Za-z0-9_-]{16,100}$/.test(args.key)||!object(args.body,action==='CREATE'?['binding','label','destinationId','events']:action==='PATCH'?['label','destinationId','enabled']:[]))throw new B2bSecurityError(400,'INVALID_REQUEST');
    if(['VERIFY','ROTATE','REPLAY'].includes(action)&&Object.keys(args.body).length)throw new B2bSecurityError(400,'EMPTY_COMMAND_REQUIRED');
    if(action!=='CREATE'&&!b2bUuid(args.id))throw new B2bSecurityError(400,'INVALID_REQUEST');
    const keyHash=createHash('sha256').update(args.key).digest('hex'),bodyHash=snapshotHash({action,args:{...args,key:null}});
    const prior=async(tx:HookTx)=>{const old=await tx.prior(owner,keyHash);if(old&&old.bodyHash!==bodyHash)throw new B2bSecurityError(409,'IDEMPOTENCY_CONFLICT');return old;};
    if(action==='VERIFY'){
      const prepared=await this.store.transaction(async tx=>{const old=await prior(tx);if(old){const s=requireSub(await tx.sub((old.response as any).id),p,issuer);return {old,s};}
        const s=requireSub(await tx.sub(args.id),p,issuer);assertVersion(s,args.ifMatch);return {old:null,s};});
      if(prepared.old){await frame.principal(token,required);return prepared.old.response;}
      const challenge=randomBytes(32).toString('base64url');if(!await this.callbacks.challenge(prepared.s.destinationId,challenge))throw new B2bSecurityError(422,'DESTINATION_VERIFICATION_FAILED');
    }
    return this.store.transaction(async tx=>{
      const old=await prior(tx);if(old){const r=old.response as any;
        const d=action==='REPLAY'?await tx.delivery(r.id):null;if(action==='REPLAY'&&!d)throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');const sub=await tx.sub(d?.subscriptionId??r.id);requireSub(sub,p,issuer);await frame.principal(token,required);return r;}
      let result:any,secret:string|undefined;
      if(action==='CREATE'){
        const b=args.body;if(!validB2bBinding(b.binding)||b.binding.issuerId!==issuer||!b2bBindingsContain(p.bindings,b.binding)||!this.callbacks.ids().includes(b.destinationId)||
          typeof b.label!=='string'||!b.label.trim()||b.label.length>120||/[\x00-\x1f\x7f]/.test(b.label)||JSON.stringify(b.events)!==JSON.stringify([localEvent]))throw new B2bSecurityError(400,'INVALID_SUBSCRIPTION');
        if((await tx.subs(undefined,undefined,101)).length>=100)throw new B2bSecurityError(429,'SUBSCRIPTION_LIMIT');
        const id=randomUUID();secret=newSigningSecret();const s:Subscription={id,actor:ref(p),binding:structuredClone(b.binding),label:b.label,destinationId:b.destinationId,enabled:true,revision:1,verifiedRevision:null,
          secret:this.vault.seal(secret,id),previousSecret:null,previousUntil:null,createdAt:this.now()};await tx.putSub(s);result={schemaVersion,...subView(s),secretAlreadyShown:true};
      }else if(action==='REPLAY'){
        const d=await tx.delivery(args.id);if(!d)throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');const s=requireSub(await tx.sub(d.subscriptionId),p,issuer);assertVersion(s,args.ifMatch);
        if(!['DEAD_LETTER','CANCELLED'].includes(d.state)||d.round>=5||!s.enabled||s.verifiedRevision!==s.revision)throw new B2bSecurityError(409,'REPLAY_NOT_ALLOWED');
        if(!await this.authority.check(s.actor,s.binding))throw new B2bSecurityError(403,'DELIVERY_GRANT_REVOKED');
        const updated:Delivery={...d,destinationId:s.destinationId,state:'PENDING',attempts:0,round:d.round+1,dueAt:this.now(),deadline:this.now()+86400000,lease:null,leaseUntil:null,lastCode:null,statusCode:null};await tx.putDelivery(updated);result={schemaVersion,...deliveryView(updated),context:s.binding};
      }else{
        const s=requireSub(await tx.sub(args.id),p,issuer);assertVersion(s,args.ifMatch);
        const updated={...s,actor:ref(p),revision:s.revision+1};
        if(action==='PATCH'){
          const b=args.body;if(!Object.keys(b).length||b.label!==undefined&&(typeof b.label!=='string'||!b.label.trim()||b.label.length>120||/[\x00-\x1f\x7f]/.test(b.label))||
            b.destinationId!==undefined&&!this.callbacks.ids().includes(b.destinationId)||b.enabled!==undefined&&typeof b.enabled!=='boolean')throw new B2bSecurityError(400,'INVALID_SUBSCRIPTION');
          Object.assign(updated,b,{verifiedRevision:null});
        }else if(action==='VERIFY'){if(!s.enabled)throw new B2bSecurityError(409,'SUBSCRIPTION_DISABLED');updated.verifiedRevision=updated.revision;}
        else{if(s.previousSecret&&Number(s.previousUntil)>this.now())throw new B2bSecurityError(409,'ROTATION_OVERLAP_ACTIVE');secret=newSigningSecret();updated.previousSecret=s.secret;updated.previousUntil=this.now()+300000;updated.secret=this.vault.seal(secret,s.id);updated.verifiedRevision=s.verifiedRevision===s.revision?updated.revision:null;}
        await tx.putSub(updated);result={schemaVersion,...subView(updated),...(action==='ROTATE'?{secretAlreadyShown:true}:{})};
      }
      await this.audit(tx,owner,action,result.id);await tx.command({owner,keyHash,bodyHash,response:result,at:this.now()});await frame.principal(token,required);
      return secret?{...result,secretAlreadyShown:false,signingSecret:secret}:result;
    });
  }
  /** Called exclusively by a Billing publisher peer, not by bearer consumers. */
  async ingest(value:unknown){
    const source=localCommit(value),hash=snapshotHash(source);
    return this.store.transaction(async tx=>{
      const old=await tx.event(source.eventId);if(old){if(old.hash!==hash)throw new B2bSecurityError(409,'EVENT_CONTENT_CONFLICT');return {eventId:source.eventId,hash,accepted:true};}
      const body=JSON.stringify({schemaVersion:'factuez.webhook.v1',eventId:source.eventId,eventName:localEvent,occurredAt:source.occurredAt,
        issuerId:source.context.issuerId,environment:'BETA',correlationId:source.commandId,payload:{resource:{kind:'DOCUMENT',id:source.documentId,version:'sha256:'+source.snapshotSha256},provenance:'LOCAL'}});
      await tx.putEvent({id:source.eventId,hash,source:structuredClone(source),body,at:this.now()});
      const subs=await tx.subs(undefined,undefined,101);if(subs.length>100)throw new B2bSecurityError(503,'SUBSCRIPTION_LIMIT');
      for(const s of subs){if(s.enabled&&s.verifiedRevision===s.revision&&b2bBindingsContain([s.binding],source.context)){
        const d:Delivery={id:randomUUID(),subscriptionId:s.id,eventId:source.eventId,destinationId:s.destinationId,state:'PENDING',attempts:0,round:0,dueAt:this.now(),createdAt:this.now(),deadline:this.now()+86400000,lease:null,leaseUntil:null,lastCode:null,statusCode:null};await tx.putDelivery(d);}}
      await this.audit(tx,'billing-publisher','INGEST',source.eventId);return {eventId:source.eventId,hash,accepted:true};
    });
  }
  async dispatch(id?:string){
    const ticket=await this.store.transaction(async tx=>{
      const d=id?await tx.delivery(id):(await tx.due(this.now(),1))[0];if(!d||!(['PENDING','RETRY'].includes(d.state)&&d.dueAt<=this.now()||d.state==='RUNNING'&&Number(d.leaseUntil)<=this.now()))return null;
      if(d.attempts>=8||this.now()>=d.deadline){await tx.putDelivery({...d,state:'DEAD_LETTER',lease:null,leaseUntil:null,lastCode:'RETRY_BUDGET_EXHAUSTED'});await this.audit(tx,'dispatcher','DEAD_LETTER',d.id);return null;}
      const claimed:Delivery={...d,state:'RUNNING',attempts:d.attempts+1,lease:randomUUID(),leaseUntil:this.now()+60000};
      if(d.state==='RUNNING')for(const a of await tx.attempts(d.id))if(a.code==='STARTED')await tx.attempt({...a,code:'UNKNOWN_DELIVERY_OUTCOME'});
      const attempt:Attempt={id:randomUUID(),deliveryId:d.id,number:claimed.attempts,round:d.round,at:this.now(),code:'STARTED',status:null};
      await tx.putDelivery(claimed);await tx.attempt(attempt);await this.audit(tx,'dispatcher','CLAIM',d.id);return {d:claimed,attempt,s:await tx.sub(d.subscriptionId),e:await tx.event(d.eventId)};
    });if(!ticket)return false;
    const {d,attempt,s,e}=ticket;let code='CALLBACK_UNAVAILABLE',status:number|null=null,retryAfter=0,terminal:Delivery['state']|null=null;
    try{
      if(!s||!e||!s.enabled||s.verifiedRevision!==s.revision||s.destinationId!==d.destinationId){terminal='CANCELLED';code='SUBSCRIPTION_DISABLED_OR_UNVERIFIED';}
      else if(!await this.authority.check(s.actor,s.binding)){terminal='CANCELLED';code='DELIVERY_GRANT_REVOKED';}
      else{
        const authorized=await this.store.transaction(async tx=>{const live=await tx.sub(s.id),row=await tx.delivery(d.id);return live?.revision===s.revision&&live.enabled&&live.destinationId===d.destinationId&&live.verifiedRevision===live.revision&&row?.lease===d.lease&&Number(row.leaseUntil)>this.now();});
        if(!authorized){terminal='CANCELLED';code='SUBSCRIPTION_CHANGED';}
        else{const bytes=Buffer.from(e.body),ts=Math.floor(this.now()/1000),keys=[s.secret,...(s.previousSecret&&Number(s.previousUntil)>this.now()?[s.previousSecret]:[])];
          const signature=keys.map(k=>signWebhook(this.vault.open(k,s.id),d.id,ts,bytes)).join(' ');
          const r=await this.callbacks.send(s.destinationId,bytes,{'webhook-id':d.id,'webhook-timestamp':String(ts),'webhook-signature':signature,'X-FactuEz-Attempt-Id':attempt.id});status=r.status;retryAfter=r.retryAfterSeconds??0;
          if(status>=200&&status<300){terminal='DELIVERED';code='DELIVERED';}else if(status>=300&&status<500&&![408,429].includes(status)){terminal='DEAD_LETTER';code='CALLBACK_PERMANENT_ERROR';}else code='CALLBACK_RETRYABLE_ERROR';
        }
      }
    }catch(err){code=err instanceof B2bSecurityError?'AUTHORITY_OR_KEY_UNAVAILABLE':'CALLBACK_UNAVAILABLE';}
    await this.store.transaction(async tx=>{const current=await tx.delivery(d.id);if(current?.lease!==d.lease)return;
      const delay=Math.max(Math.min(retryAfter,3600)*1000,Math.ceil(Math.min(3600000,30000*2**(d.attempts-1))*(1+Math.max(0,Math.min(1,this.jitter()))*.2)));
      const state=terminal??(d.attempts>=8||this.now()+delay>=d.deadline?'DEAD_LETTER':'RETRY');await tx.putDelivery({...current,state,dueAt:this.now()+delay,lease:null,leaseUntil:null,lastCode:code,statusCode:status});
      await tx.attempt({...attempt,code,status});await this.audit(tx,'dispatcher',state,d.id);});return true;
  }
}
