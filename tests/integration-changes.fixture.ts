import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { exportFixture } from './integration-export.fixture';
import { issuerRuc,documentId } from './integration-read.fixture';
import { IntegrationChanges } from '../services/integration-export-service/src/changes';
import { IntegrationExports } from '../services/integration-export-service/src/core';
import type { ChangeDeliveryRecord,ChangeDeliveryStore } from '../services/integration-export-service/src/change-store';
import { deny } from '../packages/service-access/src/integration';
import type { JournalEvent } from '../packages/service-access/src/integration-journal';
export class FixtureChangeStore implements ChangeDeliveryStore {
  records=new Map<string,ChangeDeliveryRecord>();audit=vi.fn(async()=>{});
  async get(client:string,key:string) {const r=this.records.get(client+':'+key);return r?{...r,payload:Buffer.from(r.payload)}:null;}
  async put(r:ChangeDeliveryRecord) {const k=r.clientId+':'+r.checkpointKey,old=this.records.get(k);if(old)return old;
    this.records.set(k,{...r,payload:Buffer.from(r.payload)});return r;}
  async sweep(now:string) {for(const [key,r] of this.records)if(Date.parse(r.expiresAt)<=Date.parse(now))this.records.delete(key);}
}
export function changesFixture() {
  const f=exportFixture();f.p.scopes.push('integration:changes:read');const changeStore=new FixtureChangeStore();
  const journals={BILLING:{epoch:randomUUID(),head:0n,floor:0n,events:[] as JournalEvent[]},SUNAT:{epoch:randomUUID(),head:0n,floor:0n,events:[] as JournalEvent[]}};
  const append=(source:'BILLING'|'SUNAT',kind:JournalEvent['kind']='DOCUMENT_STATE_CHANGED',ownerId=documentId,ownerKind:'DOCUMENT'|'BATCH'='DOCUMENT')=>{
    const s=journals[source];const event:JournalEvent={id:source+':'+randomUUID(),sequence:(++s.head).toString(),ownerKind,ownerId,kind,
      occurredAt:new Date(f.now()).toISOString(),artifactId:kind==='ARTIFACT_ADDED'?randomUUID():null};s.events.push(event);return event;};
  const wrapper=(source:'BILLING'|'SUNAT',http:any)=>({...http,json:vi.fn(async(path:string,token:string,body?:any)=>{
    const u=new URL(path,'https://fixture.invalid'),s=journals[source];
    if(u.pathname.endsWith('/change-ready'))return {ready:true};
    if(u.pathname.endsWith('/journal')) {
      const after=u.searchParams.get('after'),epoch=u.searchParams.get('epoch');
      if(after!==null&&(epoch!==s.epoch||BigInt(after)<s.floor||BigInt(after)>s.head))return deny(410,'CURSOR_EXPIRED');
      const events=after===null?[]:s.events.filter(e=>BigInt(e.sequence)>BigInt(after)).slice(0,Number(u.searchParams.get('limit')??500));
      return {epoch:s.epoch,head:s.head.toString(),floor:s.floor.toString(),position:{epoch:s.epoch,sequence:events.at(-1)?.sequence??after??s.head.toString()},events};
    }
    const barrier={epoch:s.epoch,sequence:s.head.toString()},result=await http.json(path,token,body);
    if(source==='BILLING'&&u.pathname.endsWith('/capture')){await onCapture?.();return {...result,changeBarrier:barrier};}return result;
  })});
  let onCapture:(()=>Promise<void>)|undefined;
  const billingHttp=wrapper('BILLING',f.billingHttp),sunatHttp=wrapper('SUNAT',f.sunatHttp);
  const feed=new IntegrationChanges(changeStore,f.vault,f.identity,billingHttp as any,sunatHttp as any,f.now);
  const core=new IntegrationExports(f.store,f.vault,f.identity,billingHttp as any,sunatHttp as any,f.now,feed);
  const checkpoint=async()=>((await core.documents('fixture-token',f.query)).page.changeCheckpoint!);
  return {...f,billingHttp,sunatHttp,core,feed,changeStore,journals,append,checkpoint,setOnCapture:(cb:()=>Promise<void>)=>{onCapture=cb;},
    page:(checkpoint:string,limit='100')=>feed.page('fixture-token',{issuerRuc,checkpoint,limit})};
}
