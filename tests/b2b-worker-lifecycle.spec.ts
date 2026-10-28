import {describe,it,expect,vi} from 'vitest';import {randomUUID} from 'node:crypto';
import {corporateEmailFixture} from './b2b-email-deliveries-corporate.fixture';
import {WebhookWorker} from '../services/webhook-service/src/worker';
import {B2bCommitPublisher} from '../services/billing-service/src/b2b/webhook-publisher';
import {snapshotHash} from '../packages/service-access/src/integration';
import {B2bWorkerMaintenance} from '../packages/service-access/src/b2b-worker-maintenance';
const deferred=<T=void>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};
const tick=()=>new Promise<void>(r=>setImmediate(r));
const mailGroup=(h:ReturnType<typeof corporateEmailFixture>)=>new B2bWorkerMaintenance({enabled:true,owner:'MAILER',expected:['MAILER_DELIVERIES'],components:[{id:'MAILER_DELIVERIES',worker:h.app.engine}]});
describe('owner shutdown waits for work outside SQL and keeps durable ambiguity',()=>{
 it('mail closes admission first, waits for SMTP AND final journal, then closes the store',async()=>{
  const h=corporateEmailFixture(),entered=deferred(),finish=deferred(),closeStore=vi.spyOn(h.store,'close'),job=await h.create();
  h.sendMail.mockImplementationOnce(async(m:any)=>{entered.resolve();await finish.promise;return {messageId:m.messageId,accepted:[m.to],rejected:[],response:'250 accepted'};});
  const run=h.app.run(job.id);await entered.promise;const g=mailGroup(h);g.stop();
  try{expect((await g.wait(1)).state).toBe('STOPPING');expect(closeStore).not.toHaveBeenCalled();await expect(h.create()).rejects.toMatchObject({code:'EMAIL_DISABLED'});
   expect(h.store.disk.jobs[0].state).toBe('DISPATCHING');finish.resolve();expect(await run).toMatchObject({state:'SMTP_ACCEPTED'});
   expect((await g.wait(1000)).state).toBe('QUIESCED_LOCAL');expect(h.store.disk.events.at(-1)?.type).toBe('SMTP_ACCEPTED');expect(closeStore).toHaveBeenCalledOnce();
   const same=h.app.engine.close();expect(h.app.engine.close()).toBe(same);await same;
  }finally{finish.resolve();await run.catch(()=>{});await h.app.engine.close();}
 });
 it('an admitted request awaiting Identity finishes before shutdown closes its store',async()=>{
  const h=corporateEmailFixture(),ready=deferred(),identity=deferred<any>(),closeStore=vi.spyOn(h.store,'close');
  h.identity.authenticate.mockImplementationOnce(async()=>{ready.resolve();return identity.promise;});const creating=h.create();await ready.promise;
  const g=mailGroup(h);g.stop();try{expect((await g.wait(1)).state).toBe('STOPPING');expect(closeStore).not.toHaveBeenCalled();identity.resolve(structuredClone(h.p));
   expect(await creating).toMatchObject({state:'QUEUED'});expect((await g.wait(1000)).state).toBe('QUIESCED_LOCAL');expect(h.sendMail).not.toHaveBeenCalled();expect(h.store.disk.jobs).toHaveLength(1);
  }finally{identity.resolve(structuredClone(h.p));await creating.catch(()=>{});await h.app.engine.close();}
 });
 it('lost SMTP response persists UNKNOWN before closing; reconstruction never sends that job again',async()=>{
  const h=corporateEmailFixture(),entered=deferred(),finish=deferred(),job=await h.create();h.sendMail.mockImplementationOnce(async()=>{entered.resolve();await finish.promise;throw Error('PRIVATE_RESULT_LOST');});
  const run=h.app.run(job.id);await entered.promise;const g=mailGroup(h);g.stop();finish.resolve();expect(await run).toMatchObject({state:'UNKNOWN',errorCode:'SMTP_OUTCOME_UNKNOWN'});expect((await g.wait(1000)).state).toBe('QUIESCED_LOCAL');
  expect(await h.assemble().run(job.id)).toMatchObject({state:'UNKNOWN'});expect(h.sendMail).toHaveBeenCalledOnce();expect(JSON.stringify(g)).not.toContain('PRIVATE');
 });
 it('store-close failure is explicit and private details are not exposed',async()=>{
  const h=corporateEmailFixture();vi.spyOn(h.store,'close').mockRejectedValue(Error('PRIVATE_DB_PASSWORD'));const g=mailGroup(h);g.stop();expect((await g.wait(1000)).state).toBe('FAILED');
  await expect(h.app.engine.close()).rejects.toMatchObject({code:'EMAIL_OWNER_UNAVAILABLE'});expect(JSON.stringify(g)).not.toContain('PRIVATE');
 });
 it('webhook close waits for a running poll and stops the remainder of the batch',async()=>{
  const entered=deferred(),finish=deferred(),dispatch=vi.fn(async()=>{entered.resolve();await finish.promise;return true;}),worker=new WebhookWorker({dispatch} as any);
  const running=worker.tick();await entered.promise;let closed=false;const close=worker.close().then(()=>{closed=true;});await tick();expect(closed).toBe(false);
  await worker.tick();finish.resolve();await running;await close;expect(dispatch).toHaveBeenCalledOnce();await worker.tick();expect(dispatch).toHaveBeenCalledOnce();expect(()=>worker.start()).toThrow('NOT_STARTABLE');
 });
 it('webhook resource-close failure still closes the owned queue and sanitizes errors',async()=>{
  const worker=new WebhookWorker({dispatch:async()=>false} as any),queueClose=vi.fn(async()=>{});
  (worker as any).worker={close:()=>{throw Error('PRIVATE_REDIS_PASSWORD');}};(worker as any).queue={close:queueClose};
  const closing=worker.close();expect(worker.close()).toBe(closing);await expect(closing).rejects.toThrow(/^WEBHOOK_WORKER_CLOSE_FAILED$/);expect(queueClose).toHaveBeenCalledOnce();
 });
 it('publisher close waits through inbox acknowledgement and final owner commit, rejecting new flushes',async()=>{
  const entered=deferred(),finish=deferred(),event={id:randomUUID(),kind:'SYNTHETIC'},sql=vi.fn(async()=>1),query=vi.fn(async()=>[{id:event.id,payload:event}]);
  const db={$transaction:async(fn:any)=>fn({$queryRawUnsafe:query,$executeRawUnsafe:sql})},inbox={accept:vi.fn(async()=>{entered.resolve();await finish.promise;return {accepted:true,eventId:event.id,hash:snapshotHash(event)};})};
  const publisher=new B2bCommitPublisher(db as any,inbox),run=publisher.flush();await entered.promise;let closed=false;const closing=publisher.close().then(()=>{closed=true;});await tick();expect(closed).toBe(false);
  expect(await publisher.flush()).toBe(false);finish.resolve();expect(await run).toBe(true);await closing;expect(sql).toHaveBeenCalledTimes(2);expect(query).toHaveBeenCalledOnce();expect(sql.mock.calls.at(-1)?.[0]).toContain('fannedOutAt');
 });
 it('publisher close fails closed if an outstanding owner operation cannot settle durably',async()=>{
  const entered=deferred(),finish=deferred(),db={$transaction:async()=>{entered.resolve();await finish.promise;throw Error('PRIVATE_SQL');}},publisher=new B2bCommitPublisher(db as any,{accept:async()=>({})});
  const run=publisher.flush();void run.catch(()=>{});await entered.promise;const closing=publisher.close();finish.resolve();await expect(run).rejects.toThrow('PRIVATE_SQL');await expect(closing).rejects.toThrow(/^B2B_COMMIT_PUBLISHER_CLOSE_FAILED$/);
 });
});
