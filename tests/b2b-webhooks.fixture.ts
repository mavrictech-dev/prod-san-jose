import {randomBytes,randomUUID} from 'node:crypto';
import {vi} from 'vitest';
import {B2bEnabledIdentityScopes} from '../packages/contracts/src/b2b-security';
import {Webhooks} from '../services/webhook-service/src/core';
import {HookVault} from '../services/webhook-service/src/crypto';
import type {HookStore,HookTx,Subscription,InboxEvent,Delivery,Attempt,Command,Audit} from '../services/webhook-service/src/model';
import {B2bWebhookAuthority} from '../services/identity-service/src/b2b/webhook-authority';
import {fixture,basic,ctx} from './b2b-identity.fixture';
import {invoiceBinding} from './b2b-read.fixture';
export class MemoryHookStore implements HookStore {
  subscriptions=new Map<string,Subscription>();events=new Map<string,InboxEvent>();rows=new Map<string,Delivery>();history=new Map<string,Attempt>();commands=new Map<string,Command>();audits:Audit[]=[];
  failAudit=false;failCommit=false;private tail:Promise<unknown>=Promise.resolve();
  transaction<T>(work:(tx:HookTx)=>Promise<T>):Promise<T>{const run=this.tail.then(async()=>{
    const subs=structuredClone(this.subscriptions),events=structuredClone(this.events),rows=structuredClone(this.rows),history=structuredClone(this.history),commands=structuredClone(this.commands),audits=structuredClone(this.audits);
    const owner=(s:Subscription)=>s.actor.clientId+':'+s.actor.kind+':'+(s.actor.subjectId??'-');
    const sorted=<T extends {id:string}>(items:T[],after?:string,limit=101)=>items.filter(x=>!after||x.id>after).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,limit);
    const tx:HookTx={sub:async id=>structuredClone(subs.get(id)??null),putSub:async s=>{subs.set(s.id,structuredClone(s));},subs:async(o,a,l)=>structuredClone(sorted([...subs.values()].filter(s=>!o||owner(s)===o),a,l)),
      event:async id=>structuredClone(events.get(id)??null),putEvent:async e=>{if(events.has(e.id))throw new Error('Duplicate event');events.set(e.id,structuredClone(e));},
      delivery:async id=>structuredClone(rows.get(id)??null),putDelivery:async d=>{rows.set(d.id,structuredClone(d));},deliveries:async(o,a,l)=>structuredClone(sorted([...rows.values()].filter(d=>owner(subs.get(d.subscriptionId)!)===o),a,l)),
      due:async(now,limit)=>structuredClone([...rows.values()].filter(d=>['PENDING','RETRY'].includes(d.state)&&d.dueAt<=now||d.state==='RUNNING'&&Number(d.leaseUntil)<=now).sort((a,b)=>a.dueAt-b.dueAt).slice(0,limit)),
      attempts:async id=>structuredClone([...history.values()].filter(a=>a.deliveryId===id)),attempt:async a=>{history.set(a.id,structuredClone(a));},
      prior:async(o,k)=>structuredClone(commands.get(o+':'+k)??null),command:async c=>{commands.set(c.owner+':'+c.keyHash,structuredClone(c));},
      audit:async a=>{if(this.failAudit)throw new Error('Synthetic audit outage');audits.push(structuredClone(a));}};
    const result=await work(tx);if(this.failCommit)throw new Error('Synthetic commit outage');this.subscriptions=subs;this.events=events;this.rows=rows;this.history=history;this.commands=commands;this.audits=audits;return result;
  });this.tail=run.catch(()=>{});return run;}
}
export const hookEvent=()=>({schemaVersion:'factuez.b2b.v1' as const,eventId:randomUUID(),eventType:'document.issued-locally.v1' as const,operationId:randomUUID(),commandId:randomUUID(),draftId:randomUUID(),documentId:randomUUID(),context:invoiceBinding,occurredAt:'2026-10-20T12:00:00.000Z',snapshotSha256:'a'.repeat(64),fiscalAcceptance:'NOT_ASSERTED' as const});
export async function hookFixture(){
  const auth=fixture(null,B2bEnabledIdentityScopes),scopes=['b2b:context:read','b2b:documents:read','b2b:webhooks:read','b2b:webhooks:manage'];
  const made=await auth.core.create('human-step-up',{label:'Synthetic webhooks',kind:'SERVICE',scopes,bindings:[invoiceBinding]},ctx());
  const token=(await auth.core.token(basic(made.client.id,made.clientSecret!),{grant_type:'client_credentials',scope:scopes.join(' ')},ctx())).access_token!;
  const identity={authenticate:vi.fn((t:string,s:any[],k:'SERVICE'|'USER')=>auth.core.authenticate(t,s,ctx(),k))};
  const authorityCore=new B2bWebhookAuthority(auth.store,{validate:async()=>{}}),authority={check:vi.fn(async(a:any,b:any)=>(await authorityCore.check({actor:a,binding:b},'f'.repeat(64))).allowed)};
  const callbacks={ids:()=>['erp_approved'],challenge:vi.fn(async()=>true),send:vi.fn(async(_id:string,_body:Buffer,_headers:Record<string,string>)=>({status:200}))};
  const store=new MemoryHookStore(),vault=new HookVault(randomBytes(32));let now=Date.now();
  const core=new Webhooks(store,identity,authority,callbacks,vault,()=>now,()=>0);
  const call=(action:string,args:any)=>core.call(token,'SERVICE',action,{issuerId:'1',...args});
  const create=(key='synthetic_hook_create_001')=>call('CREATE',{key,body:{label:'ERP ficticio',destinationId:'erp_approved',binding:invoiceBinding,events:['document.issued-locally.v1']}});
  async function verified(){const s=await create();const v=await call('VERIFY',{id:s.id,key:'synthetic_hook_verify_001',ifMatch:s.revision,body:{}});return {...v,signingSecret:s.signingSecret};}
  return {auth,made,token,identity,authority,callbacks,store,vault,core,call,create,verified,now:()=>now,advance:(ms:number)=>{now+=ms;}};
}
