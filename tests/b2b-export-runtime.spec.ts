import 'reflect-metadata';
import {beforeAll,describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {inspect} from 'node:util';
import {bootstrapB2bExports,b2bExportRuntimeMetadata} from '../services/integration-export-service/src/b2b/main';
import {createB2bExportRuntime} from '../services/integration-export-service/src/b2b/runtime';
import {B2bExtractionWorker} from '../services/integration-export-service/src/b2b/worker';
import {ExportVault} from '../services/integration-export-service/src/vault';
import {B2bPrivateHttp} from '../packages/service-access/src/b2b';
import {HttpsB2bMaintenancePort} from '../packages/service-access/src/b2b-maintenance-node';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
async function freePort(){const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const n=(s.address() as any).port;await new Promise<void>(r=>s.close(()=>r()));return n as number;}
describe('owned export worker lifetime and vault custody',()=>{
 it('serializes ticks, waits in-flight expiration before close, and never starts packaging afterward',async()=>{
  const entered=deferred(),finish=deferred(),core={sweep:vi.fn(async()=>{entered.resolve();await finish.promise;}),runOne:vi.fn(async()=>true)},worker=new B2bExtractionWorker(core);
  const pending=worker.tick();expect(worker.tick()).toBe(pending);await entered.promise;const close=worker.close();expect(worker.close()).toBe(close);
  let ended=false;void close.then(()=>{ended=true;});await Promise.resolve();expect(ended).toBe(false);finish.resolve();await pending;await close;expect(core.runOne).not.toHaveBeenCalled();
  await worker.tick();expect(core.sweep).toHaveBeenCalledOnce();expect(()=>worker.start()).toThrow('NOT_STARTABLE');
 });
 it('waits packaging including its journal, and reports failure instead of successful close',async()=>{
  const entered=deferred(),finish=deferred(),worker=new B2bExtractionWorker({sweep:async()=>{},runOne:async()=>{entered.resolve();await finish.promise;throw Error('PRIVATE_STORE_FAILURE');}});
  const pending=worker.tick(),failed=expect(pending).rejects.toThrow('PRIVATE_STORE_FAILURE');await entered.promise;
  const closed=expect(worker.close()).rejects.toThrow('EXPORT_WORKER_CLOSE_FAILED');finish.resolve();await failed;await closed;
 });
 it('hides vault keys from JSON, property enumeration and inspect without changing encrypted-envelope compatibility',()=>{
  const source=Buffer.alloc(32,9),expected=source.toString('hex'),vault=new ExportVault(source);source.fill(0);
  const envelope=vault.sealJson({synthetic:true},'owned-export');expect(vault.openJson(envelope,'owned-export')).toEqual({synthetic:true});
  expect(Object.keys(vault)).toEqual([]);expect(JSON.stringify(vault)).toBe('{}');expect(inspect(vault,{showHidden:true})).not.toContain(expected);
  expect(()=>new ExportVault(Buffer.alloc(31))).toThrow();expect(()=>vault.open(envelope,'other-export')).toThrow();
 });
});
describe('persistent B2B export owner assembly',()=>{
 let cert:ReturnType<typeof b2bCertificates>;beforeAll(()=>{cert=b2bCertificates();},30000);
 it('does no work without explicit activation and rejects legacy database/environment configuration',async()=>{
  expect(await bootstrapB2bExports({})).toBeNull();expect(await createB2bExportRuntime({enabled:false} as any)).toBeNull();
  const c={schemaVersion:'factuez.b2b.export-runtime.v1',environment:'BETA',approvedForPrivateBeta:true,deploymentId:randomUUID(),instanceId:randomUUID(),host:'127.0.0.1',port:9100,maintenancePort:9101,
   peers:['a'.repeat(64)],operatorPeers:['b'.repeat(64)],origins:{identity:'https://identity.internal',billing:'https://billing.internal',fiscal:'https://fiscal.internal'},database:{host:'postgres',name:'b2b_exports_beta',user:'export_owner'},workerEnabled:false};
  expect(b2bExportRuntimeMetadata(c)).toMatchObject({environment:'BETA'});
  for(const bad of [{environment:'PRODUCTION'},{database:{...c.database,name:'integration_exports_beta'}},{origins:{...c.origins,billing:'http://billing.internal'}},{approvedForPrivateBeta:false}])expect(()=>b2bExportRuntimeMetadata({...c,...bad})).toThrow();
 });
 it('serves actual owner modules over mTLS and parks without running workers or mutating schema',async()=>{
  const pool={query:vi.fn(async(sql:string)=>({rows:sql.includes('current_database')?[{name:'b2b_exports_beta'}]:sql.includes('pg_constraint')?[{total:1}]:[],rowCount:0})),connect:vi.fn(),end:vi.fn(async()=>{})};
  const port=await freePort();let control=await freePort();while(control===port)control=await freePort();
  const runtime=await createB2bExportRuntime({enabled:true,deploymentId:randomUUID(),instanceId:randomUUID(),pool,vaultKey:Buffer.alloc(32,7),identity:{authenticate:vi.fn()} as any,
   billing:{execute:vi.fn()},fiscal:{execute:vi.fn()},peers:[fingerprint(cert.resource)],operatorPeers:[fingerprint(cert.edge)],tls:{ca:cert.ca,cert:cert.server,key:cert.key},host:'127.0.0.1',port,maintenancePort:control,workerEnabled:false});
  const r=runtime!;
  try{
   await r.start();const client=new B2bPrivateHttp('https://127.0.0.1:'+port,{ca:cert.ca,cert:cert.resource,key:cert.key});
   expect(await client.post('/internal/b2b/runtime-status',{})).toMatchObject({owner:'exports',capabilities:['CHANGES','EXTRACTION'],bootId:r.maintenance.snapshot().instance.bootId});
   const operator=new HttpsB2bMaintenancePort('https://127.0.0.1:'+control,{ca:cert.ca,cert:cert.edge,key:cert.key},fingerprint(cert.server)),state=r.maintenance.snapshot();
   const request={runId:randomUUID(),deploymentId:state.deploymentId,instance:state.instance,inventorySha256:'b'.repeat(64)};
   for(const phase of ['ADMISSION','PRODUCERS','WORKERS'] as const){await operator.advance(phase,request);expect(pool.end).not.toHaveBeenCalled();}
   await expect(client.post('/internal/b2b/exports',{kind:'SERVICE',action:'status',args:{}},'synthetic')).rejects.toMatchObject({status:503});
   await operator.advance('STORAGE',request);expect(pool.end).toHaveBeenCalledOnce();expect(await operator.status()).toMatchObject({state:'PARKED'});
   expect(pool.query.mock.calls.every(([sql])=>sql.startsWith('SELECT '))).toBe(true);expect(pool.connect).not.toHaveBeenCalled();
  }finally{await r.worker.close();await r.app.close();await r.maintenance.closeListener();}
 });
});
