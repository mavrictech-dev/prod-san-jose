import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {snapshotHash} from '../packages/service-access/src/integration';
import {B2bDeploymentMaintenance,b2bManagedServices,type B2bDeploymentInventory} from '../packages/service-access/src/b2b-deployment-maintenance';
import {B2bMaintenanceNode} from '../packages/service-access/src/b2b-maintenance-node';
import {B2bRegisteredOfflineVerifier,PostgresB2bConnectionObserver,RedisB2bConnectionObserver,type B2bContainerObservation} from '../packages/service-access/src/b2b-offline-verifier';
import {DockerB2bMetadataObserver} from '../packages/service-access/src/b2b-docker-observer';
function fixture(){
 const inventory:B2bDeploymentInventory={deploymentId:randomUUID(),revision:1,environment:'BETA',instances:Object.keys(b2bManagedServices).map(service=>({service:service as any,instanceId:randomUUID(),bootId:randomUUID()})).sort((a,b)=>a.instanceId.localeCompare(b.instanceId))};
 const startedAt=new Date(Date.now()-60000).toISOString(),runId=randomUUID(),inventorySha256=snapshotHash(inventory);
 const rows:B2bContainerObservation[]=inventory.instances.map((i,n)=>({id:(n+1).toString(16).padStart(64,'0'),deploymentId:inventory.deploymentId,instanceId:i.instanceId,project:'factuez-test',
  running:true,paused:false,restarting:false,dead:false,oomKilled:false,restartCount:0,startedAt,mounts:[]}));
 const registry={deploymentId:inventory.deploymentId,project:'factuez-test',protectedRoots:['/srv/factuez/data'],containers:rows.map(r=>({id:r.id,instanceId:r.instanceId,restartCount:r.restartCount,startedAt}))};
 const nodes=new Map(inventory.instances.map(instance=>[instance.instanceId,{status:vi.fn(async()=>({schemaVersion:'factuez.b2b.maintenance-node.v1',environment:'BETA',deploymentId:inventory.deploymentId,
  instance,runId,inventorySha256,state:'PARKED',completedPhase:'STORAGE',pending:0,storageClosed:true}))}]));
 const observers={containers:vi.fn(async()=>structuredClone(rows)),nodes,postgres:vi.fn(async()=>({connections:0})),redis:vi.fn(async()=>({connections:0}))};
 return {inventory,runId,inventorySha256,rows,registry,observers,verifier:new B2bRegisteredOfflineVerifier(registry,observers)};
}
describe('independent registered-deployment offline observations',()=>{
 it('checks all nodes, all storage clients and two stable container observations before granting a short proof',async()=>{
  const f=fixture(),proof=await f.verifier.inspect(f);expect(proof.state).toBe('REGISTERED_WRITERS_OFFLINE');expect(f.observers.containers).toHaveBeenCalledTimes(2);
  expect(f.observers.postgres).toHaveBeenCalledOnce();expect(f.observers.redis).toHaveBeenCalledOnce();expect(JSON.stringify(f.verifier)).toContain('globalUnmanagedWritersVerified":false');
 });
 it.each(['postgres','redis'] as const)('refuses even one idle/blocked %s connection',async storage=>{
  const f=fixture();f.observers[storage].mockResolvedValue({connections:1});await expect(f.verifier.inspect(f)).rejects.toThrow('NOT_OFFLINE');
 });
 it.each(['oomKilled','paused','restarting','dead'] as const)('refuses a %s container rather than forcing shutdown',async field=>{
  const f=fixture();f.rows[0][field]=true;await expect(f.verifier.inspect(f)).rejects.toThrow('NOT_OFFLINE');
 });
 it('rejects restarts, missing containers, duplicate identities and mounts changed during a capture',async()=>{
  for(const change of [(f:any)=>f.rows[0].restartCount++,(f:any)=>f.rows.pop(),(f:any)=>f.rows.push({...f.rows[0]})]){
   const f=fixture();change(f);await expect(f.verifier.inspect(f)).rejects.toThrow('NOT_OFFLINE');
  }
  const f=fixture();f.observers.containers.mockImplementation(async()=>{if(f.observers.containers.mock.calls.length===2)f.rows[0].mounts.push({source:'/srv/factuez/data/new',readOnly:false});return structuredClone(f.rows);});
  await expect(f.verifier.inspect(f)).rejects.toThrow('NOT_OFFLINE');
 });
 it('rejects undeclared writers by project, deployment or a parent/child writable bind, but ignores unrelated host services',async()=>{
  for(const extra of [{project:'factuez-test'},{deploymentId:'self'},{mounts:[{source:'/srv',readOnly:false}]},{mounts:[{source:'/srv/factuez/data/a',readOnly:false}]}]){
   const f=fixture(),row={...f.rows[0],id:'f'.repeat(64),project:'other',deploymentId:null,instanceId:null,...extra};if(row.deploymentId==='self')row.deploymentId=f.inventory.deploymentId;
   f.rows.push(row as any);await expect(f.verifier.inspect(f)).rejects.toThrow('NOT_OFFLINE');
  }
  const f=fixture();f.rows.push({...f.rows[0],id:'f'.repeat(64),project:'unrelated',deploymentId:null,instanceId:null,mounts:[{source:'/other/production',readOnly:false}]});
  expect((await f.verifier.inspect(f)).state).toBe('REGISTERED_WRITERS_OFFLINE');
 });
 it('rejects stale run, restarted boot, missing visibility and missing owner mappings without leaking underlying errors',async()=>{
  const f=fixture(),node=f.observers.nodes.values().next().value!;node.status.mockResolvedValue({...await node.status(),instance:{...f.inventory.instances[0],bootId:randomUUID()}});
  await expect(f.verifier.inspect(f)).rejects.toThrow('NOT_OFFLINE');
  const g=fixture();g.observers.containers.mockRejectedValue(Error('PRIVATE_HOST_DATA'));await expect(g.verifier.inspect(g)).rejects.toThrow(/^REGISTERED_DEPLOYMENT_NOT_OFFLINE$/);
  expect(()=>new B2bRegisteredOfflineVerifier({...g.registry,protectedRoots:['/var/lib']},g.observers)).toThrow();
 });
 it('works with the actual four-phase coordinator and refuses a new client appearing after snapshot work',async()=>{
  const f=fixture(),nodes=new Map(f.inventory.instances.map(instance=>[instance.instanceId,new B2bMaintenanceNode({enabled:true,deploymentId:f.inventory.deploymentId,instance,
   hooks:{ADMISSION:async()=>{},PRODUCERS:async()=>{},WORKERS:async()=>{},STORAGE:async()=>{}}})]));
  f.observers.nodes.clear();for(const [id,node] of nodes)f.observers.nodes.set(id,{status:async()=>node.snapshot()} as any);
  const core=new B2bDeploymentMaintenance({enabled:true,inventory:f.inventory,participants:[...nodes].map(([instanceId,port])=>({instanceId,port})),verifier:f.verifier});core.stop();await core.wait(1000);
  await expect(core.withOfflineSnapshot(async()=>{f.observers.redis.mockResolvedValue({connections:1});return true;})).rejects.toThrow('EVIDENCE_UNAVAILABLE');
  expect(core.snapshot().backupAuthorized).toBe(false);
 });
 it('bounds an unresponsive observer without cancelling work or admitting a snapshot',async()=>{
  vi.useFakeTimers();
  try{
   const f=fixture();f.observers.containers.mockImplementation(()=>new Promise(()=>{}));
   const assertion=expect(f.verifier.inspect(f)).rejects.toThrow('REGISTERED_DEPLOYMENT_NOT_OFFLINE');
   await vi.advanceTimersByTimeAsync(4001);await assertion;expect(f.observers.postgres).not.toHaveBeenCalled();
  }finally{vi.useRealTimers();}
 });
});
describe('bounded concrete read-only storage observers',()=>{
 const databases=Object.fromEntries(['IDENTITY','BILLING','SUNAT','MAILER','RECEIVED','HISTORY','EXPORTS','WEBHOOKS'].map(k=>[k,'b2b_'+k.toLowerCase()+'_beta'])) as any;
 it('requires PostgreSQL stats visibility and all configured databases and counts idle sessions too',async()=>{
  const sql={query:vi.fn(async(text:string)=>({rows:text.includes('pg_has_role')?[{visible:true}]:text.includes('pg_database')?Object.values(databases).map(datname=>({datname})):[{connections:2}]}))};
  expect(await new PostgresB2bConnectionObserver(sql,databases).inspect()).toEqual({connections:2});expect(sql.query.mock.calls.every(([query])=>query.startsWith('SELECT '))).toBe(true);
  sql.query.mockResolvedValue({rows:[{visible:false}]} as any);await expect(new PostgresB2bConnectionObserver(sql,databases).inspect()).rejects.toThrow('UNAVAILABLE');
  expect(()=>new PostgresB2bConnectionObserver(sql,{BILLING:'billing'} as any)).toThrow();
 });
 it('rejects missing PostgreSQL databases and invalid count instead of assuming zero',async()=>{
  const sql={query:vi.fn(async(text:string)=>({rows:text.includes('pg_has_role')?[{visible:true}]:[]}))};
  await expect(new PostgresB2bConnectionObserver(sql,databases).inspect()).rejects.toThrow('UNAVAILABLE');
 });
 it('counts every Redis client except its own dedicated observer and rejects incomplete/duplicate visibility',async()=>{
  const client={call:vi.fn(async(_command:string,op:string)=>op==='ID'?7:'id=7 addr=synthetic\nid=8 flags=b cmd=brpop\nid=9 flags=P cmd=subscribe\n')};
  expect(await new RedisB2bConnectionObserver(client).inspect()).toEqual({connections:2});
  for(const raw of ['id=8 addr=hidden','id=7\nid=7','id=7 id=8']){client.call.mockImplementation(async(_c,op)=>op==='ID'?7:raw);await expect(new RedisB2bConnectionObserver(client).inspect()).rejects.toThrow('UNAVAILABLE');}
 });
 it('uses only Docker metadata commands, canonicalizes bind sources, never requests env/args/logs',async()=>{
  const id='a'.repeat(64),row={id,project:null,deploymentId:null,instanceId:null,running:true,paused:false,restarting:false,dead:false,oomKilled:false,restartCount:0,startedAt:new Date().toISOString(),mounts:[{Type:'bind',Source:'/alias/data',RW:true}]};
  const io={run:vi.fn(async(args:string[])=>args[1]==='ls'?id+'\n':JSON.stringify(row)+'\n'),canonical:vi.fn(async()=>'/srv/factuez/data')};
  const result=await new DockerB2bMetadataObserver(io).inspect();expect(result[0].mounts).toEqual([{source:'/srv/factuez/data',readOnly:false}]);
  expect(io.run.mock.calls[1][0].join(' ')).not.toMatch(/Config\.Env|\.Args|logs|stop|kill|exec/);
  io.run.mockResolvedValue('malformed');await expect(new DockerB2bMetadataObserver(io).inspect()).rejects.toThrow(/^DOCKER_OFFLINE_OBSERVATION_UNAVAILABLE$/);
 });
});
