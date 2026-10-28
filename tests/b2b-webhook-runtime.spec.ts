import 'reflect-metadata';
import {beforeAll,describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {createWebhookOwnerRuntime} from '../services/webhook-service/src/runtime';
import {bootstrapWebhooks} from '../services/webhook-service/src/main';
import {HookVault} from '../services/webhook-service/src/crypto';
import {B2bPrivateHttp} from '../packages/service-access/src/b2b';
import {HttpsB2bMaintenancePort} from '../packages/service-access/src/b2b-maintenance-node';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
async function freePort(){const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as any).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port as number;}
describe('concrete webhook owner HTTP assembly and private maintenance',()=>{
 let cert:ReturnType<typeof b2bCertificates>;beforeAll(()=>{cert=b2bCertificates();},30000);
 it('remains inert by default, without reading config, schema, network or mounted secrets',async()=>{
  expect(await bootstrapWebhooks({})).toBeNull();expect(await createWebhookOwnerRuntime({enabled:false} as any)).toBeNull();
 });
 it('uses actual owner controllers and mTLS, verifies schema without DDL, closes storage only after four phases',async()=>{
  const database={query:vi.fn(async(sql:string)=>({rows:sql.includes('current_database')?[{name:'b2b_webhooks_beta'}]:[],rowCount:0})),connect:vi.fn(),end:vi.fn(async()=>{})};
  const callbacks={send:vi.fn(),challenge:vi.fn(),ids:()=>['synthetic']},identity={authenticate:vi.fn()},authority={authorizeCurrent:vi.fn()};
  const port=await freePort();let maintenancePort=await freePort();while(maintenancePort===port)maintenancePort=await freePort();
  const runtime=await createWebhookOwnerRuntime({enabled:true,deploymentId:randomUUID(),instanceId:randomUUID(),database,identity:identity as any,authority:authority as any,
   callbacks:callbacks as any,vault:new HookVault(Buffer.alloc(32,7)),peers:{facade:[fingerprint(cert.resource)],billingPublisher:[fingerprint(cert.other)]},
   operatorPeers:[fingerprint(cert.edge)],tls:{ca:cert.ca,cert:cert.server,key:cert.key},host:'127.0.0.1',port,maintenancePort,dispatchEnabled:false});
  expect(runtime).not.toBeNull();const r=runtime!;
  try{
   await r.start();const client=new B2bPrivateHttp('https://127.0.0.1:'+port,{ca:cert.ca,cert:cert.resource,key:cert.key});
   expect(await client.post('/internal/b2b/runtime-status',{})).toMatchObject({owner:'webhooks',capabilities:['DELIVERIES','INGEST','SUBSCRIPTIONS'],bootId:r.maintenance.snapshot().instance.bootId});
   const operator=new HttpsB2bMaintenancePort('https://127.0.0.1:'+maintenancePort,{ca:cert.ca,cert:cert.edge,key:cert.key},fingerprint(cert.server));
   const state=r.maintenance.snapshot(),request={runId:randomUUID(),deploymentId:state.deploymentId,instance:state.instance,inventorySha256:'a'.repeat(64)};
   for(const phase of ['ADMISSION','PRODUCERS','WORKERS'] as const){await operator.advance(phase,request);expect(database.end).not.toHaveBeenCalled();}
   await expect(client.post('/internal/b2b/webhooks',{kind:'SERVICE',action:'LIST',args:{}},'synthetic')).rejects.toMatchObject({status:503});
   await operator.advance('STORAGE',request);expect(database.end).toHaveBeenCalledOnce();expect(await operator.status()).toMatchObject({state:'PARKED',storageClosed:true});
   await operator.advance('STORAGE',request);expect(database.end).toHaveBeenCalledOnce();await expect(r.start()).rejects.toThrow('ALREADY_STARTED');
   expect(database.query.mock.calls.every(([sql])=>sql.startsWith('SELECT '))).toBe(true);expect(callbacks.send).not.toHaveBeenCalled();expect(callbacks.challenge).not.toHaveBeenCalled();
  }finally{await r.worker.close();await r.app.close();await r.maintenance.closeListener();}
 });
 it('refuses an unrelated database without creating tables or starting workers',async()=>{
  const database={query:vi.fn(async()=>({rows:[{name:'other_database'}],rowCount:1})),end:vi.fn(),connect:vi.fn()};
  await expect(createWebhookOwnerRuntime({enabled:true,database,dispatchEnabled:false,port:9100,maintenancePort:9101,operatorPeers:[],peers:{facade:[],billingPublisher:[]}} as any)).rejects.toThrow('Dedicated');
  expect(database.query).toHaveBeenCalledOnce();
 });
});
