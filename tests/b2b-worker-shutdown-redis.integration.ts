import {it,expect,vi} from 'vitest';import {createRequire} from 'node:module';import {randomUUID} from 'node:crypto';
import {B2bWorkerMaintenance} from '../packages/service-access/src/b2b-worker-maintenance';
import {WebhookWorker} from '../services/webhook-service/src/worker';
import {createB2bReceivedDispatchQueue} from '../services/received-documents-service/src/b2b/automation-dispatch-queue';
const require=createRequire(import.meta.url),{testCapability,createDockerConnector}=require('./helpers/b2b-received-dispatch-redis.cjs');
const service=createRequire(new URL('../services/received-documents-service/package.json',import.meta.url)),{Queue,Worker}=service('bullmq');
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
async function within<T>(promise:Promise<T>,ms=10000):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_r,reject)=>{timer=setTimeout(()=>reject(Error('OWNED_REDIS_SHUTDOWN_TIMEOUT')),ms);})]);}finally{clearTimeout(timer);}}
it('real Redis/BullMQ webhook shutdown waits for a delivery and acknowledges before closing; fresh composition processes only new work',async()=>{
 const cap=testCapability(),tunnel=createDockerConnector(cap),connection={host:'127.0.0.1',port:6379,password:cap.password,Connector:tunnel.Connector,maxRetriesPerRequest:null};
 const entered=deferred(),finish=deferred(),id=randomUUID(),nextId=randomUUID();let observer:any,first:WebhookWorker|undefined,restarted:WebhookWorker|undefined;
 const dispatch=vi.fn(async(deliveryId?:string)=>{if(deliveryId===id){entered.resolve();await finish.promise;}return !!deliveryId;});
 try{
  observer=new Queue('factuez-b2b-webhooks-v1',{connection});observer.on('error',()=>{});
  first=new WebhookWorker({dispatch} as any);first.start(connection as any);await first.wake(id);await within(entered.promise);
  const group=new B2bWorkerMaintenance({enabled:true,owner:'WEBHOOKS',expected:['WEBHOOK_DELIVERIES'],components:[{id:'WEBHOOK_DELIVERIES',worker:first}]});group.stop();
  expect((await group.wait(1)).state).toBe('STOPPING');finish.resolve();expect((await within(group.wait(10000))).state).toBe('QUIESCED_LOCAL');
  expect(await (await observer.getJob(id)).getState()).toBe('completed');expect(dispatch.mock.calls.filter(([x])=>x===id)).toHaveLength(1);
  await first.wake(nextId);expect(await observer.getJob(nextId)).toBeUndefined();
  restarted=new WebhookWorker({dispatch} as any);restarted.start(connection as any);const done=deferred();
  dispatch.mockImplementation(async(deliveryId?:string)=>{if(deliveryId===nextId)done.resolve();return !!deliveryId;});await restarted.wake(nextId);await within(done.promise);await within(restarted.close());
  expect(dispatch.mock.calls.filter(([x])=>x===id)).toHaveLength(1);expect(dispatch.mock.calls.filter(([x])=>x===nextId)).toHaveLength(1);
 }finally{finish.resolve();await within(Promise.allSettled([first?.close(),restarted?.close()]).then(()=>{}));try{await observer?.close();await tunnel.drain();}finally{await tunnel.shutdown();}}
},45000);
it('real reception transport stop preserves the running owner promise and blocks new enqueue until fresh composition',async()=>{
 const cap=testCapability(),tunnel=createDockerConnector(cap),connection={host:'127.0.0.1',port:6379,password:cap.password};
 const entered=deferred(),finish=deferred(),id=randomUUID();let transport:Awaited<ReturnType<typeof createB2bReceivedDispatchQueue>>|undefined,calls=0,commits=0;
 try{
  transport=await createB2bReceivedDispatchQueue(connection,{pending:async()=>[],run:async()=>{calls++;entered.resolve();await finish.promise;commits++;}},{enabled:true,pollIntervalMs:300000,factories:{
   queue:(name,options)=>new Queue(name,{...options,connection:{...options.connection,Connector:tunnel.Connector}}),
   worker:(name,processor,options)=>new Worker(name,processor,{...options,connection:{...options.connection,Connector:tunnel.Connector}}),
  }});
  await transport.enqueue(id);await within(entered.promise);const group=new B2bWorkerMaintenance({enabled:true,owner:'RECEPTION',expected:['RECEPTION_LOCAL'],components:[{id:'RECEPTION_LOCAL',worker:transport}]});
  group.stop();expect((await group.wait(1)).state).toBe('STOPPING');await expect(transport.enqueue(randomUUID())).rejects.toThrow('CLOSED');expect(commits).toBe(0);
  finish.resolve();expect((await within(group.wait(10000))).state).toBe('QUIESCED_LOCAL');expect(calls).toBe(1);expect(commits).toBe(1);
 }finally{finish.resolve();try{if(transport)await within(transport.close());await tunnel.drain();}finally{await tunnel.shutdown();}}
},45000);
