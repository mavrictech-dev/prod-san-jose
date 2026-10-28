import {randomUUID} from 'node:crypto';
import {inspect,types} from 'node:util';
import {performance} from 'node:perf_hooks';
import {snapshotHash} from './integration';

export const b2bManagedServices={
 KONG:'INGRESS',WEB_PWA:'INGRESS',B2B_API:'INGRESS',INTEGRATION_API:'INGRESS',
 RECEIVED_SYNC:'WORKERS',WEBHOOKS:'WORKERS',SUNAT:'WORKERS',MAILER:'WORKERS',
 BILLING:'OWNERS',IDENTITY:'OWNERS',RECEIVED:'OWNERS',HISTORY:'OWNERS',REALTIME:'OWNERS',EXPORTS:'OWNERS',
} as const;
export type B2bManagedService=keyof typeof b2bManagedServices;
export type B2bMaintenancePhase='ADMISSION'|'PRODUCERS'|'WORKERS'|'STORAGE';
export interface B2bManagedInstance {service:B2bManagedService;instanceId:string;bootId:string}
export interface B2bDeploymentInventory {deploymentId:string;revision:number;environment:'BETA';instances:B2bManagedInstance[]}
export interface B2bQuiesceRequest {runId:string;deploymentId:string;inventorySha256:string;instance:B2bManagedInstance}
export interface B2bQuiesceReceipt extends B2bQuiesceRequest {phase:B2bMaintenancePhase;state:'QUIESCED_PHASE';pending:0;storageClosed:boolean}
/** Owned implementation must stop admission and await complete work, then close
 * storage. A timeout, SIGKILL or a local worker receipt alone cannot satisfy it. */
export interface B2bQuiescePort {advance(phase:B2bMaintenancePhase,request:B2bQuiesceRequest):Promise<B2bQuiesceReceipt>}
export interface B2bOfflineEvidence {
 runId:string;deploymentId:string;inventorySha256:string;environment:'BETA';
 instances:B2bManagedInstance[];observedAt:string;expiresAt:string;
 state:'REGISTERED_WRITERS_OFFLINE';unlistedWriters:0;activeApplicationConnections:0;forcedStops:0;
}
export interface B2bOfflineVerifier {inspect(request:{runId:string;inventory:B2bDeploymentInventory;inventorySha256:string}):Promise<B2bOfflineEvidence>}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const integer=(v:unknown,min:number,max:number)=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=max;
function record(v:any,keys:string[]){return !!v&&typeof v==='object'&&!types.isProxy(v)&&Object.getPrototypeOf(v)===Object.prototype&&
 Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k))&&Object.values(Object.getOwnPropertyDescriptors(v)).every(d=>d.enumerable&&'value'in d);}
function list(v:any,max:number){if(!Array.isArray(v)||types.isProxy(v)||Object.getPrototypeOf(v)!==Array.prototype||!v.length||v.length>max||Reflect.ownKeys(v).length!==v.length+1)return false;
 for(let i=0;i<v.length;i++){const d=Object.getOwnPropertyDescriptor(v,String(i));if(!d?.enumerable||!('value'in d))return false;}return true;}
function inventory(value:unknown):B2bDeploymentInventory {
 const v=value as B2bDeploymentInventory;
 if(!record(v,['deploymentId','revision','environment','instances'])||!uuid(v.deploymentId)||!integer(v.revision,1,2147483647)||v.environment!=='BETA'||!list(v.instances,64)||
  v.instances.some(i=>!record(i,['service','instanceId','bootId'])||typeof i.service!=='string'||!Object.hasOwn(b2bManagedServices,i.service)||!uuid(i.instanceId)||!uuid(i.bootId))||
  new Set(v.instances.map(i=>i.instanceId)).size!==v.instances.length||new Set(v.instances.map(i=>i.bootId)).size!==v.instances.length||
  Object.keys(b2bManagedServices).some(s=>!v.instances.some(i=>i.service===s)))throw Error('COMPLETE_EXPLICIT_B2B_WRITER_INVENTORY_REQUIRED');
 return {...structuredClone(v),instances:structuredClone(v.instances).sort((a,b)=>a.instanceId.localeCompare(b.instanceId))};
}
type Entry=B2bManagedInstance&{phase:'REGISTERED'|B2bMaintenancePhase;state:'REGISTERED'|'STOPPING'|'STOPPED_CLEAN'|'FAILED';code:null|'WRITER_STOP_FAILED'};
/** Ordered coordinator for an explicitly owned deployment. No discovery, HTTP
 * routes, Docker commands, signals, DDL, connection configuration or auto-start.
 * Offline evidence is supplied by the deployment adapter, NOT a B2B client. */
export class B2bDeploymentMaintenance {
 #inventory:B2bDeploymentInventory;#sha:string;#enabled:boolean;#verifier:B2bOfflineVerifier;
 #ports:Map<string,B2bQuiescePort>;#entries:Entry[];#runId:string|null=null;
 #state:'REGISTERED'|'STOPPING'|'STOPPED_CLEAN'|'FAILED'='REGISTERED';#closing?:Promise<void>;#backup=false;
 constructor(options:{enabled?:boolean;inventory:B2bDeploymentInventory;participants:{instanceId:string;port:B2bQuiescePort}[];verifier:B2bOfflineVerifier}){
  if(!options||types.isProxy(options)||Object.getPrototypeOf(options)!==Object.prototype||Object.values(Object.getOwnPropertyDescriptors(options)).some(d=>!('value'in d))||
   Reflect.ownKeys(options).some(k=>typeof k!=='string'||!['enabled','inventory','participants','verifier'].includes(k))||options.enabled!==undefined&&typeof options.enabled!=='boolean')throw Error('INVALID_B2B_DEPLOYMENT_MAINTENANCE');
  this.#inventory=inventory(options.inventory);this.#sha=snapshotHash(this.#inventory);this.#enabled=options.enabled===true;this.#verifier=options.verifier;
  if(!list(options.participants,64)||options.participants.length!==this.#inventory.instances.length||options.participants.some(p=>!record(p,['instanceId','port'])||
   !this.#inventory.instances.some(i=>i.instanceId===p.instanceId)||typeof p.port?.advance!=='function')||new Set(options.participants.map(p=>p.instanceId)).size!==options.participants.length||typeof this.#verifier?.inspect!=='function')throw Error('EXACT_B2B_WRITER_PARTICIPANTS_REQUIRED');
  this.#ports=new Map(options.participants.map(p=>[p.instanceId,p.port]));this.#entries=this.#inventory.instances.map(i=>({...i,phase:'REGISTERED',state:'REGISTERED',code:null}));
 }
 stop(){
  if(!this.#enabled)throw Error('B2B_DEPLOYMENT_MAINTENANCE_DISABLED');if(this.#closing)return this.snapshot();
  this.#runId=randomUUID();this.#state='STOPPING';
  this.#closing=(async()=>{
   for(const phase of ['ADMISSION','PRODUCERS','WORKERS','STORAGE'] as const){
    await Promise.all(this.#entries.map(async entry=>{
     entry.phase=phase;entry.state='STOPPING';const instance={service:entry.service,instanceId:entry.instanceId,bootId:entry.bootId};
     const request={runId:this.#runId!,deploymentId:this.#inventory.deploymentId,inventorySha256:this.#sha,instance};
     try{
      const response=this.#ports.get(entry.instanceId)!.advance(phase,structuredClone(request));if(!(response instanceof Promise))throw Error();const receipt=await response;
      if(!record(receipt,['runId','deploymentId','inventorySha256','instance','phase','state','pending','storageClosed'])||!record(receipt.instance,['service','instanceId','bootId'])||
       snapshotHash(receipt)!==snapshotHash({...request,phase,state:'QUIESCED_PHASE',pending:0,storageClosed:phase==='STORAGE'}))throw Error();
      entry.state=phase==='STORAGE'?'STOPPED_CLEAN':'STOPPING';
     }catch{entry.state='FAILED';entry.code='WRITER_STOP_FAILED';}
    }));
    // Keep storage available for journals if an earlier phase cannot stop.
    if(this.#entries.some(e=>e.state==='FAILED')){this.#state='FAILED';return;}
   }
   this.#state='STOPPED_CLEAN';
  })();return this.snapshot();
 }
 async wait(timeoutMs=30000){
  if(!integer(timeoutMs,0,60000))throw Error('INVALID_B2B_MAINTENANCE_TIMEOUT');if(!this.#closing)throw Error('B2B_MAINTENANCE_NOT_STARTED');
  let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([this.#closing,new Promise<void>(r=>{timer=setTimeout(r,timeoutMs);})]);}finally{clearTimeout(timer);}
  return this.snapshot();
 }
 private async verifyOffline(){
  if(this.#state!=='STOPPED_CLEAN'||!this.#runId)throw Error('B2B_DEPLOYMENT_NOT_QUIESCED');const started=performance.now(),now=Date.now();
  let evidence:B2bOfflineEvidence;try{evidence=await this.#verifier.inspect({runId:this.#runId,inventory:structuredClone(this.#inventory),inventorySha256:this.#sha});}catch{throw Error('B2B_OFFLINE_EVIDENCE_UNAVAILABLE');}
  const keys=['runId','deploymentId','inventorySha256','environment','instances','observedAt','expiresAt','state','unlistedWriters','activeApplicationConnections','forcedStops'];
  if(!record(evidence,keys)||evidence.runId!==this.#runId||evidence.deploymentId!==this.#inventory.deploymentId||evidence.inventorySha256!==this.#sha||evidence.environment!=='BETA'||
   evidence.state!=='REGISTERED_WRITERS_OFFLINE'||evidence.unlistedWriters!==0||evidence.activeApplicationConnections!==0||evidence.forcedStops!==0||
   !list(evidence.instances,64)||snapshotHash(inventory({...this.#inventory,instances:evidence.instances}))!==this.#sha||
   typeof evidence.observedAt!=='string'||typeof evidence.expiresAt!=='string'||!Number.isFinite(Date.parse(evidence.observedAt))||!Number.isFinite(Date.parse(evidence.expiresAt))||
   Date.parse(evidence.observedAt)<now-1000||Date.parse(evidence.observedAt)>Date.now()||Date.parse(evidence.expiresAt)<=Date.now()||
   Date.parse(evidence.expiresAt)-Date.parse(evidence.observedAt)>5000||performance.now()-started>5000)throw Error('B2B_OFFLINE_EVIDENCE_INVALID');
 }
 /** The backup adapter must additionally compare all data/file/sequence inventories
  * before/after its snapshot. This method alone cannot certify a whole backup. */
 async withOfflineSnapshot<T>(work:()=>Promise<T>):Promise<T>{
  if(!this.#enabled||this.#backup)throw Error('B2B_BACKUP_NOT_ADMITTED');this.#backup=true;
  try{await this.verifyOffline();const result=await work();await this.verifyOffline();return result;}finally{this.#backup=false;}
 }
 snapshot(){return {schemaVersion:'factuez.b2b.deployment-maintenance.v1',environment:'BETA',deploymentId:this.#inventory.deploymentId,
  inventoryRevision:this.#inventory.revision,inventorySha256:this.#sha,runId:this.#runId,state:this.#enabled?this.#state:'DISABLED',
  scope:'EXPLICIT_REGISTERED_DEPLOYMENT',backupAuthorized:false,globalUnmanagedWritersVerified:false,backupInProgress:this.#backup,instances:structuredClone(this.#entries)};}
 toJSON(){return this.snapshot();}[inspect.custom](){return this.snapshot();}
}
