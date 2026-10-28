import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {B2bDeploymentMaintenance,b2bManagedServices,type B2bManagedService,type B2bQuiescePort} from '../packages/service-access/src/b2b-deployment-maintenance';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
function fixture(enabled=true){
 const roster={deploymentId:randomUUID(),revision:1,environment:'BETA' as const,instances:Object.keys(b2bManagedServices).map(service=>({service:service as B2bManagedService,instanceId:randomUUID(),bootId:randomUUID()}))};
 const calls:string[]=[],ports=new Map<string,B2bQuiescePort>();
 const participants=roster.instances.map(instance=>{
  const port={advance:vi.fn(async(phase:any,request:any)=>{calls.push(phase+':'+instance.service);return {...request,phase,state:'QUIESCED_PHASE' as const,pending:0 as const,storageClosed:phase==='STORAGE'};})};
  ports.set(instance.instanceId,port);return {instanceId:instance.instanceId,port};
 });
 const verifier={inspect:vi.fn(async(r:any)=>({runId:r.runId,deploymentId:r.inventory.deploymentId,inventorySha256:r.inventorySha256,environment:'BETA' as const,
  instances:structuredClone(r.inventory.instances),observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+1000).toISOString(),state:'REGISTERED_WRITERS_OFFLINE' as const,unlistedWriters:0 as const,activeApplicationConnections:0 as const,forcedStops:0 as const}))};
 const options={enabled,inventory:roster,participants,verifier};return {roster,calls,ports,participants,verifier,options,core:new B2bDeploymentMaintenance(options)};
}
describe('deployment-wide B2B maintenance, inventory bound and no implicit backup approval',()=>{
 it('is off by default and requires an exact complete inventory and participants',()=>{
  const f=fixture(false);expect(f.core.snapshot().state).toBe('DISABLED');expect(()=>f.core.stop()).toThrow('DISABLED');expect(f.calls).toEqual([]);
  for(const bad of [{...f.options,inventory:{...f.roster,environment:'PRODUCTION'}},{...f.options,participants:[]},
   {...f.options,inventory:{...f.roster,instances:f.roster.instances.slice(1)}},{...f.options,participants:[...f.participants,f.participants[0]]},
   {...f.options,inventory:{...f.roster,instances:[...f.roster.instances,{...f.roster.instances[0]}]}}])expect(()=>new B2bDeploymentMaintenance(bad as any)).toThrow();
 });
 it('runs every admission before any producer, all producers before workers, and storage last',async()=>{
  const f=fixture();f.core.stop();const status=await f.core.wait(1000);expect(status.state).toBe('STOPPED_CLEAN');
  const phases=f.calls.map(c=>c.split(':')[0]),size=f.roster.instances.length;
  expect(phases).toEqual(['ADMISSION','PRODUCERS','WORKERS','STORAGE'].flatMap(p=>Array(size).fill(p)));
  expect(status.backupAuthorized).toBe(false);expect(status.globalUnmanagedWritersVerified).toBe(false);expect(f.verifier.inspect).not.toHaveBeenCalled();
  f.core.stop();await f.core.wait(1);expect(f.calls).toHaveLength(size*4);
 });
 it('a timeout cannot cancel work, close storage early or produce offline proof',async()=>{
  const f=fixture(),gate=deferred(),port=f.participants[0].port,original=port.advance.getMockImplementation()!;
  port.advance.mockImplementation(async(p,r)=>{if(p==='WORKERS')await gate.promise;return original(p,r);});
  f.core.stop();expect((await f.core.wait(5)).state).toBe('STOPPING');expect(f.calls.some(c=>c.startsWith('STORAGE'))).toBe(false);
  await expect(f.core.withOfflineSnapshot(async()=>true)).rejects.toThrow('NOT_QUIESCED');gate.resolve();expect((await f.core.wait(1000)).state).toBe('STOPPED_CLEAN');
 });
 it('failure prevents later phases and keeps journals available, with sanitized errors',async()=>{
  const f=fixture();f.participants[0].port.advance.mockImplementation(async()=>{throw Error('PRIVATE_CREDENTIAL');});
  f.core.stop();const view=await f.core.wait(1000);expect(view.state).toBe('FAILED');expect(f.calls.some(c=>c.startsWith('PRODUCERS'))).toBe(false);
  expect(JSON.stringify(f.core)).not.toContain('PRIVATE_CREDENTIAL');expect(view.instances.some(e=>e.code==='WRITER_STOP_FAILED')).toBe(true);
 });
 it('rejects receipts from another run, instance or boot and incomplete storage closure',async()=>{
  for(const change of [(r:any)=>{r.runId=randomUUID();},(r:any)=>{r.instance.bootId=randomUUID();},(r:any)=>{r.pending=1;},(r:any)=>{r.storageClosed=true;}]){
   const f=fixture(),port=f.participants[0].port,original=port.advance.getMockImplementation()!;
   port.advance.mockImplementation(async(p,r)=>{const v=await original(p,r);change(v);return v;});f.core.stop();expect((await f.core.wait(1000)).state).toBe('FAILED');
  }
 });
 it('revalidates offline evidence before and after snapshot and never grants an unrestricted backup flag',async()=>{
  const f=fixture();f.core.stop();await f.core.wait(1000);const result=await f.core.withOfflineSnapshot(async()=>({inventorySha256:'synthetic'}));
  expect(result).toEqual({inventorySha256:'synthetic'});expect(f.verifier.inspect).toHaveBeenCalledTimes(2);expect(f.core.snapshot().backupAuthorized).toBe(false);
 });
 it.each(['forcedStops','unlistedWriters','activeApplicationConnections'])('blocks snapshot when %s is nonzero',async field=>{
  const f=fixture(),read=f.verifier.inspect.getMockImplementation()!;f.verifier.inspect.mockImplementation(async r=>({...await read(r),[field]:1}) as any);
  f.core.stop();await f.core.wait(1000);const snapshot=vi.fn(async()=>true);await expect(f.core.withOfflineSnapshot(snapshot)).rejects.toThrow('EVIDENCE_INVALID');expect(snapshot).not.toHaveBeenCalled();
 });
 it('rejects restarted or missing instances after capture rather than publishing a false stable result',async()=>{
  const f=fixture(),read=f.verifier.inspect.getMockImplementation()!;f.core.stop();await f.core.wait(1000);
  f.verifier.inspect.mockImplementation(async r=>{const e=await read(r);if(f.verifier.inspect.mock.calls.length>1)e.instances[0].bootId=randomUUID();return e;});
  await expect(f.core.withOfflineSnapshot(async()=>true)).rejects.toThrow('EVIDENCE_INVALID');expect(f.core.snapshot().backupInProgress).toBe(false);
 });
 it('refuses parallel backups, expired evidence, bad wait limits and unstarted waits',async()=>{
  const f=fixture();await expect(f.core.wait(0)).rejects.toThrow('NOT_STARTED');f.core.stop();await f.core.wait(1000);
  for(const limit of [-1,60001,NaN])await expect(f.core.wait(limit)).rejects.toThrow('TIMEOUT');
  const gate=deferred(),pending=f.core.withOfflineSnapshot(async()=>{await gate.promise;return true;});
  await expect(f.core.withOfflineSnapshot(async()=>true)).rejects.toThrow('NOT_ADMITTED');gate.resolve();await pending;
  const read=f.verifier.inspect.getMockImplementation()!;f.verifier.inspect.mockImplementation(async r=>({...await read(r),expiresAt:new Date(Date.now()-1).toISOString()}));
  await expect(f.core.withOfflineSnapshot(async()=>true)).rejects.toThrow('EVIDENCE_INVALID');
 });
 it('snapshots/configuration are detached and accessor-based inventories are rejected before hooks execute',()=>{
  const f=fixture(),view=f.core.snapshot();view.instances[0].bootId=randomUUID();f.roster.revision=99;expect(f.core.snapshot().inventoryRevision).toBe(1);
  let called=0;const malformed=Object.defineProperty({...f.options},'inventory',{get(){called++;throw Error();}});
  expect(()=>new B2bDeploymentMaintenance(malformed as any)).toThrow();expect(called).toBe(0);
 });
});
