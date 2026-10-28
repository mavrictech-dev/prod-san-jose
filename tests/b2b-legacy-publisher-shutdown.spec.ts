import 'reflect-metadata';
import {describe,it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({queues:[] as any[],live:[] as any[]}));
vi.mock('../services/billing-service/node_modules/bullmq',()=>({Queue:class{
 add=vi.fn(async()=>{});close=vi.fn(async()=>{});on=vi.fn();constructor(){state.queues.push(this);}
}}));
vi.mock('@factuez/service-access',async original=>({...await original<any>(),LivePublisher:class{changed=vi.fn(async()=>{});close=vi.fn(async()=>{});constructor(){state.live.push(this);}}}));
import {OutboxPublisher} from '../services/billing-service/src/infrastructure/outbox.publisher';
import {StatusOutboxPublisher} from '../services/sunat-service/src/infrastructure/status-outbox.publisher';
import {EventNames} from '../packages/contracts/src';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
describe('legacy queue publishers, complete publish/journal before shutdown',()=>{
 it.each(['BILLING','SUNAT'] as const)('%s waits queue acceptance and journal, closes once, never starts a new batch',async owner=>{
  const addEntered=deferred(),finish=deferred(),journal=vi.fn(async()=>{}),row={id:'00000000-0000-4000-8000-000000000001',eventType:EventNames.documentIssued,payload:{}};
  const db={outboxEvent:{findMany:vi.fn(async()=>[row]),update:journal}},publisher=owner==='BILLING'?new OutboxPublisher(db as any):new StatusOutboxPublisher(db as any),queue=state.queues.at(-1);
  queue.add.mockImplementation(async()=>{addEntered.resolve();await finish.promise;});
  const run=publisher.flush();await addEntered.promise;const closed=publisher.close();expect(publisher.close()).toBe(closed);await publisher.flush();expect(db.outboxEvent.findMany).toHaveBeenCalledOnce();expect(queue.close).not.toHaveBeenCalled();expect(journal).not.toHaveBeenCalled();
  finish.resolve();await run;await closed;expect(journal).toHaveBeenCalledOnce();expect(queue.close).toHaveBeenCalledOnce();await publisher.onModuleDestroy();expect(queue.close).toHaveBeenCalledOnce();
 });
 it.each(['BILLING','SUNAT'] as const)('%s serializes overlapping ticks and preserves a failed pending row without fake shutdown success',async owner=>{
  const entered=deferred(),finish=deferred(),db={outboxEvent:{findMany:vi.fn(async()=>{entered.resolve();await finish.promise;throw Error('PRIVATE_DATABASE_ERROR');})}};
  const publisher=owner==='BILLING'?new OutboxPublisher(db as any):new StatusOutboxPublisher(db as any),one=publisher.flush(),two=publisher.flush();
  expect(two).toBe(one);const rejection=expect(one).rejects.toThrow('PRIVATE_DATABASE_ERROR');await entered.promise;const close=publisher.close();finish.resolve();await rejection;
  await expect(close).rejects.toThrow(owner==='BILLING'?'BILLING_OUTBOX_CLOSE_FAILED':'SUNAT_STATUS_OUTBOX_CLOSE_FAILED');expect(db.outboxEvent.findMany).toHaveBeenCalledOnce();
 });
});
