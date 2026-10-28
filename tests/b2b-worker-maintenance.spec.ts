import {describe,it,expect,vi} from 'vitest';import {inspect} from 'node:util';
import {B2bWorkerMaintenance} from '../packages/service-access/src/b2b-worker-maintenance';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
const make=(close=vi.fn(async()=>{}),enabled=true)=>new B2bWorkerMaintenance({owner:'MAILER',expected:['MAILER_DELIVERIES'],components:[{id:'MAILER_DELIVERIES',worker:{close}}],enabled});
describe('per-owner worker maintenance, explicit local proof only',()=>{
 it('is disabled unless explicitly enabled and performs no work during construction',()=>{
  const close=vi.fn(async()=>{}),g=make(close,false);expect(g.snapshot().state).toBe('DISABLED');expect(()=>g.stop()).toThrow('DISABLED');expect(close).not.toHaveBeenCalled();
 });
 it('requires the exact nonempty configured set in one owner and rejects mixed/global groups',()=>{
  const good={owner:'MAILER',expected:['MAILER_DELIVERIES'],components:[{id:'MAILER_DELIVERIES',worker:{close:async()=>{}}}]};
  for(const bad of [{...good,owner:'ALL'},{...good,components:[]},{...good,expected:[]},{...good,expected:['MAILER_DELIVERIES','MAILER_DELIVERIES']},
   {...good,owner:'RECEPTION'},{...good,components:[...good.components,...good.components]},{...good,components:[{id:'MAILER_DELIVERIES',worker:{}}]},
   {...good,publicRun:true}])expect(()=>new B2bWorkerMaintenance(bad as any)).toThrow('EXPLICIT_OWNER');
 });
 it('starts each close synchronously once and a timeout does not cancel work or claim quiescence',async()=>{
  const done=deferred(),close=vi.fn(()=>done.promise),g=make(close);g.stop();g.stop();expect(close).toHaveBeenCalledOnce();
  expect(await g.wait(1)).toMatchObject({state:'STOPPING',components:[{state:'STOPPING'}],backupAuthorized:false,globalWriteFenceVerified:false});
  done.resolve();expect(await g.wait(1000)).toMatchObject({state:'QUIESCED_LOCAL',durablePendingWork:'NOT_INSPECTED',localProcessOnly:true});
  g.stop();expect(close).toHaveBeenCalledOnce();
 });
 it('a failed component cannot prevent another component stopping and never produces backup approval',async()=>{
  const other=deferred(),g=new B2bWorkerMaintenance({owner:'RECEPTION',enabled:true,expected:['RECEPTION_LOCAL','RECEPTION_READ_ONLY'],components:[
   {id:'RECEPTION_LOCAL',worker:{close:()=>{throw Error('PRIVATE_TOKEN');}}},{id:'RECEPTION_READ_ONLY',worker:{close:()=>other.promise}},
  ]});g.stop();expect((await g.wait(1)).state).toBe('STOPPING');other.resolve();const view=await g.wait(1000);expect(view.state).toBe('FAILED');expect(view.components[0].code).toBe('WORKER_STOP_FAILED');expect(view.components[1].state).toBe('STOPPED');expect(view.backupAuthorized).toBe(false);
  expect(JSON.stringify(g)).not.toContain('PRIVATE');expect(inspect(g)).not.toContain('PRIVATE');
 });
 it('rejects synchronous void masquerading as confirmed async close and sanitizes rejected promises',async()=>{
  for(const close of [()=>undefined,()=>Promise.reject(Error('PRIVATE_SMTP_CREDENTIAL'))]){const g=make(close as any);g.stop();const v=await g.wait(1000);expect(v.state).toBe('FAILED');expect(JSON.stringify(v)).not.toContain('PRIVATE');}
 });
 it('snapshots are detached and wait alone cannot stop a worker',async()=>{
  const g=make();await expect(g.wait(0)).rejects.toThrow('NOT_STARTED');const copy=g.snapshot();copy.components[0].state='FAILED';expect(g.snapshot().components[0].state).toBe('REGISTERED');
  for(const ms of [-1,60001,NaN])await expect(g.wait(ms)).rejects.toThrow('TIMEOUT');
 });
 it('cannot confirm an omitted sparse worker or invoke configuration hooks',()=>{
  const c={id:'MAILER_DELIVERIES',worker:{close:async()=>{}}},base={enabled:true,owner:'MAILER',expected:['MAILER_DELIVERIES'],components:[c]};let called=0;
  for(const value of [{...base,expected:Array(1),components:Array(1)},{...base,components:[new Proxy(c,{get(){called++;throw Error('PRIVATE');}})]},
   Object.defineProperty({...base},'owner',{enumerable:true,get(){called++;throw Error('PRIVATE');}})])expect(()=>new B2bWorkerMaintenance(value as any)).toThrow();
  const bad={...base,components:[c]};(bad.components as any)[Symbol.iterator]=()=>{called++;throw Error('PRIVATE');};expect(()=>new B2bWorkerMaintenance(bad as any)).toThrow();expect(called).toBe(0);
 });
});
