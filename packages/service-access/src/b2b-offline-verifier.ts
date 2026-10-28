import {performance} from 'node:perf_hooks';
import {posix} from 'node:path';
import {snapshotHash} from './integration';
import type {B2bDeploymentInventory,B2bOfflineEvidence,B2bOfflineVerifier} from './b2b-deployment-maintenance';

export interface B2bContainerObservation {
 id:string;deploymentId:string|null;instanceId:string|null;project:string|null;
 running:boolean;paused:boolean;restarting:boolean;dead:boolean;oomKilled:boolean;
 restartCount:number;startedAt:string;mounts:{source:string;readOnly:boolean}[];
}
export interface B2bOfflineRegistry {
 deploymentId:string;project:string;protectedRoots:string[];
 containers:{id:string;instanceId:string|null;restartCount:number;startedAt:string}[];
}
export interface B2bOfflineObservers {
 /** Complete host container metadata, including stopped containers; no env or command payloads. */
 containers():Promise<B2bContainerObservation[]>;
 nodes:ReadonlyMap<string,{status():Promise<unknown>}>;
 /** Reject missing visibility. Count all client sessions to the owned databases, not just 'active' SQL. */
 postgres():Promise<{connections:number}>;
 /** All Redis clients except this dedicated observer, including pub/sub and blocked clients. */
 redis():Promise<{connections:number}>;
}
const uuid=(s:unknown):s is string=>typeof s==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(s);
const hex=(s:unknown):s is string=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const absolute=(s:unknown):s is string=>typeof s==='string'&&s.startsWith('/')&&s!=='/'&&posix.normalize(s)===s&&!s.includes('\0')&&!s.startsWith('/var/')&&s!=='/var';
const related=(a:string,b:string)=>a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
const validTime=(s:unknown)=>typeof s==='string'&&Number.isFinite(Date.parse(s));
const count=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0;
/** Independent read-only evidence for a registered deployment. Does not send
 * signals, kill connections, mutate Redis, or claim unmanaged host writers are
 * globally absent. Host metadata and SQL visibility are mandatory, never a
 * caller-supplied 'offline:true'. No discovery of credentials or automatic I/O. */
export class B2bRegisteredOfflineVerifier implements B2bOfflineVerifier {
 #registry:B2bOfflineRegistry;#observers:B2bOfflineObservers;
 constructor(registry:B2bOfflineRegistry,observers:B2bOfflineObservers){
  if(!registry||!uuid(registry.deploymentId)||!/^[a-z][a-z0-9-]{0,62}$/.test(registry.project)||
   !Array.isArray(registry.protectedRoots)||!registry.protectedRoots.length||registry.protectedRoots.length>32||registry.protectedRoots.some(p=>!absolute(p))||
   !Array.isArray(registry.containers)||!registry.containers.length||registry.containers.length>96||registry.containers.some(c=>!hex(c.id)||c.instanceId!==null&&!uuid(c.instanceId)||!count(c.restartCount)||!validTime(c.startedAt))||
   new Set(registry.containers.map(c=>c.id)).size!==registry.containers.length||new Set(registry.containers.filter(c=>c.instanceId).map(c=>c.instanceId)).size!==registry.containers.filter(c=>c.instanceId).length||
   typeof observers?.containers!=='function'||typeof observers.postgres!=='function'||typeof observers.redis!=='function'||!(observers.nodes instanceof Map))throw Error('EXPLICIT_OFFLINE_OBSERVERS_REQUIRED');
  this.#registry=structuredClone(registry);this.#observers=observers;
 }
 private async inspectContainers(inventory:B2bDeploymentInventory){
  const expected=this.#registry.containers,rows=await this.#observers.containers();
  if(!Array.isArray(rows)||rows.length>512||new Set(rows.map(c=>c.id)).size!==rows.length||expected.some(c=>!rows.some(r=>r.id===c.id)))throw Error();
  for(const row of rows){
   if(!hex(row.id)||!Array.isArray(row.mounts)||row.mounts.length>256||row.mounts.some(m=>typeof m.source!=='string'||!m.source.startsWith('/')||posix.normalize(m.source)!==m.source||typeof m.readOnly!=='boolean')||
    [row.running,row.paused,row.restarting,row.dead,row.oomKilled].some(v=>typeof v!=='boolean')||!count(row.restartCount)||!validTime(row.startedAt))throw Error();
   const registered=expected.find(c=>c.id===row.id);
   if(!registered){
    if(row.deploymentId===inventory.deploymentId||row.project===this.#registry.project||row.mounts.some(m=>!m.readOnly&&this.#registry.protectedRoots.some(p=>related(p,m.source))))throw Error();
    continue;
   }
   if(row.deploymentId!==inventory.deploymentId||row.project!==this.#registry.project||row.instanceId!==registered.instanceId||
    !row.running||row.paused||row.restarting||row.dead||row.oomKilled||row.restartCount!==registered.restartCount||row.startedAt!==registered.startedAt)throw Error();
  }
  return snapshotHash(rows.filter(r=>expected.some(e=>e.id===r.id)).sort((a,b)=>a.id.localeCompare(b.id)));
 }
 async inspect(request:{runId:string;inventory:B2bDeploymentInventory;inventorySha256:string}):Promise<B2bOfflineEvidence>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([this.observe(request),new Promise<never>((_resolve,reject)=>{
   timer=setTimeout(()=>reject(Error('REGISTERED_DEPLOYMENT_NOT_OFFLINE')),4000);
  })]);}finally{clearTimeout(timer);}
 }
 private async observe(request:{runId:string;inventory:B2bDeploymentInventory;inventorySha256:string}):Promise<B2bOfflineEvidence>{
  const started=performance.now();
  try{
   const {inventory}=request;
   if(!uuid(request.runId)||!hex(request.inventorySha256)||inventory.environment!=='BETA'||inventory.deploymentId!==this.#registry.deploymentId||snapshotHash(inventory)!==request.inventorySha256||
    this.#observers.nodes.size!==inventory.instances.length||this.#registry.containers.filter(c=>c.instanceId).length!==inventory.instances.length||
    inventory.instances.some(i=>!this.#registry.containers.some(c=>c.instanceId===i.instanceId)||!this.#observers.nodes.has(i.instanceId)))throw Error();
   const before=await this.inspectContainers(inventory);
   await Promise.all(inventory.instances.map(async instance=>{
    const status=await this.#observers.nodes.get(instance.instanceId)!.status() as any;
    if(!status||Object.keys(status).sort().join(',')!==['schemaVersion','environment','deploymentId','instance','runId','inventorySha256','state','completedPhase','pending','storageClosed'].sort().join(',')||
     status.schemaVersion!=='factuez.b2b.maintenance-node.v1'||status.environment!=='BETA'||status.deploymentId!==inventory.deploymentId||
     snapshotHash(status.instance)!==snapshotHash(instance)||status.runId!==request.runId||status.inventorySha256!==request.inventorySha256||
     status.state!=='PARKED'||status.completedPhase!=='STORAGE'||status.pending!==0||status.storageClosed!==true)throw Error();
   }));
   const [pg,redis]=await Promise.all([this.#observers.postgres(),this.#observers.redis()]);
   if(!pg||!redis||pg.connections!==0||redis.connections!==0)throw Error();
   if(before!==await this.inspectContainers(inventory)||performance.now()-started>4000)throw Error();
   const observedAt=new Date().toISOString();return {runId:request.runId,deploymentId:inventory.deploymentId,inventorySha256:request.inventorySha256,environment:'BETA',
    instances:structuredClone(inventory.instances),observedAt,expiresAt:new Date(Date.parse(observedAt)+1000).toISOString(),state:'REGISTERED_WRITERS_OFFLINE',
    unlistedWriters:0,activeApplicationConnections:0,forcedStops:0};
  }catch{throw Error('REGISTERED_DEPLOYMENT_NOT_OFFLINE');}
 }
 toJSON(){return {schemaVersion:'factuez.b2b.offline-verifier.v1',scope:'EXPLICIT_REGISTERED_DEPLOYMENT',globalUnmanagedWritersVerified:false};}
}

export interface OfflineSql {query(text:string,values?:unknown[]):Promise<{rows:Record<string,unknown>[]}>}
const databaseOwners=['IDENTITY','BILLING','SUNAT','MAILER','RECEIVED','HISTORY','EXPORTS','WEBHOOKS'] as const;
/** Dedicated observer connection with pg_read_all_stats. Never terminates or
 * filters away idle sessions. Does not log role, database, IP or query text. */
export class PostgresB2bConnectionObserver {
 #databases:string[];
 constructor(private readonly sql:OfflineSql,databases:Record<typeof databaseOwners[number],string>){
  if(!databases||Object.keys(databases).sort().join(',')!==[...databaseOwners].sort().join(',')||Object.values(databases).some(d=>!/^[a-z][a-z0-9_]{0,62}$/.test(d)))throw Error('COMPLETE_OWNED_DATABASE_MAP_REQUIRED');
  this.#databases=[...new Set(Object.values(databases))].sort();
 }
 async inspect(){
  try{
   const rights=await this.sql.query("SELECT pg_has_role(current_user,'pg_read_all_stats','MEMBER') AS visible");
   if(rights.rows.length!==1||rights.rows[0].visible!==true)throw Error();
   const available=await this.sql.query('SELECT datname FROM pg_database WHERE datname=ANY($1::text[]) AND datallowconn=true',[this.#databases]);
   if(available.rows.length!==this.#databases.length||available.rows.map(r=>r.datname).sort().join(',')!==this.#databases.join(','))throw Error();
   const result=await this.sql.query("SELECT count(*)::int AS connections FROM pg_stat_activity WHERE datname=ANY($1::text[]) AND backend_type='client backend' AND pid<>pg_backend_pid()",[this.#databases]);
   const n=result.rows[0]?.connections;if(result.rows.length!==1||!count(n))throw Error();return {connections:Number(n)};
  }catch{throw Error('POSTGRES_OFFLINE_OBSERVATION_UNAVAILABLE');}
 }
}
export interface OfflineRedis {call(command:string,...args:string[]):Promise<unknown>}
export class RedisB2bConnectionObserver {
 constructor(private readonly client:OfflineRedis){}
 async inspect(){
  try{
   const id=await this.client.call('CLIENT','ID'),raw=await this.client.call('CLIENT','LIST');
   if(!count(Number(id))||typeof raw!=='string'||Buffer.byteLength(raw)>1024*1024)throw Error();
   const rows=raw.trim().split('\n').filter(Boolean),ids=rows.map(line=>{
    const matches=line.split(' ').filter(s=>s.startsWith('id='));if(matches.length!==1||!/^id=[1-9]\d*$/.test(matches[0]))throw Error();return matches[0].slice(3);
   });if(ids.length>4096||new Set(ids).size!==ids.length||!ids.includes(String(id)))throw Error();return {connections:ids.filter(v=>v!==String(id)).length};
  }catch{throw Error('REDIS_OFFLINE_OBSERVATION_UNAVAILABLE');}
 }
}
