import 'reflect-metadata';
import {describe,it,expect,vi,afterEach} from 'vitest';
const state=vi.hoisted(()=>({queues:[] as any[],workers:[] as any[],live:[] as any[]}));
vi.mock('../services/mailer-worker/node_modules/bullmq',()=>({
 Queue:class {add=vi.fn(async()=>{});close=vi.fn(async()=>{});on=vi.fn();constructor(){state.queues.push(this);}},
 Worker:class {close=vi.fn(async()=>{});on=vi.fn();constructor(){state.workers.push(this);}},
}));
vi.mock('@factuez/service-access',async original=>({...await original<any>(),LivePublisher:class {changed=vi.fn();close=vi.fn(async()=>{});constructor(){state.live.push(this);}}}));
import {LocalMail} from '../services/mailer-worker/src/local-mail';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
afterEach(()=>vi.unstubAllEnvs());
describe('local mail producer drains before queues and storage close',()=>{
 it('waits a pending query, stops publishing the remainder, closes once and cannot restart',async()=>{
  vi.stubEnv('LOCAL_MAIL_QA_ENABLED','true');const entered=deferred(),finish=deferred();
  const db={localQaMail:{updateMany:vi.fn(async()=>{entered.resolve();await finish.promise;}),findMany:vi.fn(async()=>[{id:'synthetic',attempt:0}])}};
  const mail=new LocalMail(db as any,{} as any);mail.onApplicationBootstrap();const queue=state.queues.at(-1),worker=state.workers.at(-1);
  const dispatch=(mail as any).dispatch();await entered.promise;expect((mail as any).dispatch()).toBe(dispatch);
  const close=mail.close();expect(mail.close()).toBe(close);expect(worker.close).not.toHaveBeenCalled();expect(queue.close).not.toHaveBeenCalled();
  finish.resolve();await dispatch;await close;expect(queue.add).not.toHaveBeenCalled();expect(worker.close).toHaveBeenCalledOnce();expect(queue.close).toHaveBeenCalledOnce();
  const count=state.workers.length;mail.onApplicationBootstrap();await mail.onModuleDestroy();expect(state.workers.length).toBe(count);expect(queue.close).toHaveBeenCalledOnce();
 });
 it('waits acknowledgement of an already published wake-up before closing the queue',async()=>{
  vi.stubEnv('LOCAL_MAIL_QA_ENABLED','true');const entered=deferred(),finish=deferred();
  const db={localQaMail:{updateMany:vi.fn(async()=>{}),findMany:vi.fn(async()=>[{id:'one',attempt:0},{id:'two',attempt:0}])}};
  const mail=new LocalMail(db as any,{} as any);mail.onApplicationBootstrap();const queue=state.queues.at(-1);
  queue.add.mockImplementation(async()=>{entered.resolve();await finish.promise;});const run=(mail as any).dispatch();await entered.promise;
  const close=mail.close();expect(queue.close).not.toHaveBeenCalled();finish.resolve();await run;await close;expect(queue.add).toHaveBeenCalledOnce();
 });
 it('still closes remaining resources after a worker failure, without claiming successful shutdown',async()=>{
  const mail=new LocalMail({} as any,{} as any),worker={close:vi.fn(async()=>{throw Error('PRIVATE_QUEUE_ERROR');})},queue={close:vi.fn(async()=>{})};
  Object.assign(mail,{worker,queue});const close=mail.close();await expect(close).rejects.toThrow('LOCAL_MAIL_CLOSE_FAILED');expect(queue.close).toHaveBeenCalledOnce();
  expect(state.live.at(-1).close).toHaveBeenCalledOnce();expect(mail.close()).toBe(close);
 });
});
