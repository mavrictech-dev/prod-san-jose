import {beforeAll,describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {request as httpsRequest} from 'node:https';
import {B2bMaintenanceNode,HttpsB2bMaintenancePort} from '../packages/service-access/src/b2b-maintenance-node';
import {B2bDeploymentMaintenance,b2bManagedServices,type B2bMaintenancePhase} from '../packages/service-access/src/b2b-deployment-maintenance';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
let tls:ReturnType<typeof b2bCertificates>;beforeAll(()=>{tls=b2bCertificates();},30000);
const phases=['ADMISSION','PRODUCERS','WORKERS','STORAGE'] as const;
function fixture(){
 const instance={service:'BILLING' as const,instanceId:randomUUID(),bootId:randomUUID()},deploymentId=randomUUID();
 const hooks=Object.fromEntries(phases.map(p=>[p,vi.fn(async()=>{})])) as Record<B2bMaintenancePhase,ReturnType<typeof vi.fn>>;
 const node=new B2bMaintenanceNode({enabled:true,deploymentId,instance,hooks});
 const request={runId:randomUUID(),deploymentId,inventorySha256:'a'.repeat(64),instance};return {node,hooks,request};
}
describe('private maintenance node, terminal lifecycle and actual operator mTLS',()=>{
 it('requires ordered, matching-instance phases and replays without repeating effects',async()=>{
  const f=fixture();await expect(f.node.advance('STORAGE',f.request)).rejects.toThrow('PHASE_ORDER');
  await expect(f.node.advance('ADMISSION',{...f.request,instance:{...f.request.instance,bootId:randomUUID()}})).rejects.toThrow('INSTANCE_MISMATCH');
  for(const phase of phases){const r=await f.node.advance(phase,f.request);expect(await f.node.advance(phase,f.request)).toEqual(r);expect(f.hooks[phase]).toHaveBeenCalledOnce();}
  expect(f.node.snapshot()).toMatchObject({state:'PARKED',storageClosed:true,pending:0});
  await expect(f.node.advance('ADMISSION',{...f.request,runId:randomUUID()})).rejects.toThrow('RUN_CONFLICT');
 });
 it('a disconnected/duplicate caller cannot free pending work or invoke a later phase',async()=>{
  const f=fixture();let release!:()=>void;f.hooks.ADMISSION.mockImplementation(()=>new Promise<void>(r=>{release=r;}));
  const one=f.node.advance('ADMISSION',f.request),two=f.node.advance('ADMISSION',f.request);await Promise.resolve();
  expect(f.node.snapshot()).toMatchObject({state:'STOPPING',pending:1});await expect(f.node.advance('PRODUCERS',f.request)).rejects.toThrow('IN_PROGRESS');
  await expect(f.node.closeListener()).rejects.toThrow('WORK_ACTIVE');release();expect(await one).toEqual(await two);expect(f.hooks.ADMISSION).toHaveBeenCalledOnce();
 });
 it('failed hooks are terminal and never expose their private exception',async()=>{
  const f=fixture();f.hooks.ADMISSION.mockRejectedValue(Error('PRIVATE_DB_PASSWORD'));await expect(f.node.advance('ADMISSION',f.request)).rejects.toThrow('HOOK_FAILED');
  expect(f.node.snapshot().state).toBe('FAILED');expect(JSON.stringify(f.node)).not.toContain('PRIVATE_DB_PASSWORD');await expect(f.node.advance('PRODUCERS',f.request)).rejects.toThrow('NOT_ADMITTED');
 });
 it('only the pinned operator can control a separate listener that survives business shutdown',async()=>{
  const f=fixture(),address:any=await f.node.listen({host:'127.0.0.1',port:0,tls:{ca:tls.ca,cert:tls.server,key:tls.key},operatorPeers:[fingerprint(tls.edge)]});
  const origin='https://127.0.0.1:'+address.port,port=new HttpsB2bMaintenancePort(origin,{ca:tls.ca,cert:tls.edge,key:tls.key},fingerprint(tls.server));
  try{
   const forbidden=new HttpsB2bMaintenancePort(origin,{ca:tls.ca,cert:tls.resource,key:tls.key},fingerprint(tls.server));await expect(forbidden.status()).rejects.toThrow('DENIED');
   const wrongServer=new HttpsB2bMaintenancePort(origin,{ca:tls.ca,cert:tls.edge,key:tls.key},'0'.repeat(64));await expect(wrongServer.status()).rejects.toThrow();
   for(const phase of phases)expect((await port.advance(phase,f.request)).storageClosed).toBe(phase==='STORAGE');
   expect(await port.status()).toMatchObject({state:'PARKED',storageClosed:true,instance:f.request.instance});
   const extra=await new Promise<number>((resolve,reject)=>{const req=httpsRequest(origin+'/internal/maintenance/status',{ca:tls.ca,cert:tls.edge,key:tls.key,headers:{Authorization:'Bearer synthetic-client-token'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));});req.on('error',reject);req.end();});expect(extra).toBe(400);
  }finally{await f.node.closeListener();}
 });
 it('coordinates all registered services over real mTLS; authorization/DB verification is a separate port',async()=>{
  const deploymentId=randomUUID(),instances=Object.keys(b2bManagedServices).map(service=>({service:service as keyof typeof b2bManagedServices,instanceId:randomUUID(),bootId:randomUUID()}));
  const nodes:B2bMaintenanceNode[]=[],ports:HttpsB2bMaintenancePort[]=[],calls:string[]=[];
  try{
   for(const instance of instances){
    const hooks=Object.fromEntries(phases.map(p=>[p,async()=>{calls.push(p+':'+instance.service);}])) as any;
    const node=new B2bMaintenanceNode({enabled:true,deploymentId,instance,hooks}),address:any=await node.listen({host:'127.0.0.1',port:0,tls:{ca:tls.ca,cert:tls.server,key:tls.key},operatorPeers:[fingerprint(tls.edge)]});nodes.push(node);
    ports.push(new HttpsB2bMaintenancePort('https://127.0.0.1:'+address.port,{ca:tls.ca,cert:tls.edge,key:tls.key},fingerprint(tls.server)));
   }
   const inventory={deploymentId,revision:1,environment:'BETA' as const,instances};
   const verifier={inspect:async(r:any)=>{
    const states=await Promise.all(ports.map(p=>p.status()));expect(states.every(s=>s.state==='PARKED'&&s.storageClosed&&s.pending===0)).toBe(true);
    return {runId:r.runId,deploymentId,inventorySha256:r.inventorySha256,environment:'BETA' as const,instances:states.map(s=>s.instance),observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+1000).toISOString(),state:'REGISTERED_WRITERS_OFFLINE' as const,unlistedWriters:0 as const,activeApplicationConnections:0 as const,forcedStops:0 as const};
   }};
   const coordinator=new B2bDeploymentMaintenance({enabled:true,inventory,verifier,participants:instances.map((i,index)=>({instanceId:i.instanceId,port:ports[index]}))});
   coordinator.stop();expect((await coordinator.wait(30000)).state).toBe('STOPPED_CLEAN');
   const order=calls.map(c=>c.split(':')[0]);expect(order).toEqual(phases.flatMap(p=>instances.map(()=>p)));
   expect(await coordinator.withOfflineSnapshot(async()=>({fictitious:true}))).toEqual({fictitious:true});expect(coordinator.snapshot().backupAuthorized).toBe(false);
  }finally{await Promise.all(nodes.map(n=>n.closeListener()));}
 });
});
