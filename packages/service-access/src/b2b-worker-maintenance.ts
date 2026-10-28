import {randomUUID} from 'node:crypto';
import {inspect,types} from 'node:util';

const componentsByOwner={
 BILLING:['BILLING_WEBHOOK_PUBLISHER','BILLING_REPORT_RETENTION'],RECEPTION:['RECEPTION_LOCAL','RECEPTION_READ_ONLY'],
 MAILER:['MAILER_DELIVERIES'],WEBHOOKS:['WEBHOOK_DELIVERIES'],
} as const;
export type B2bWorkerOwner=keyof typeof componentsByOwner;
export type B2bWorkerComponent=typeof componentsByOwner[B2bWorkerOwner][number];
export interface B2bClosableWorker {close():Promise<void>}
type Entry={id:B2bWorkerComponent;state:'REGISTERED'|'STOPPING'|'STOPPED'|'FAILED';code:null|'WORKER_STOP_FAILED'};
export interface B2bWorkerMaintenanceOptions{
 enabled?:boolean;owner:B2bWorkerOwner;expected:readonly B2bWorkerComponent[];
 components:readonly {id:B2bWorkerComponent;worker:B2bClosableWorker}[];
}
function dataList(value:unknown):value is unknown[]{
 if(!Array.isArray(value)||types.isProxy(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>2||Reflect.ownKeys(value).length!==value.length+1)return false;
 for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!('value'in d))return false;}return true;
}

/** One owner/process only, for trusted explicit deployment composition. No
 * public endpoint, credentials, Redis/DB connection, signals or auto-start.
 * A local stop receipt is NEVER proof of a global write fence or empty queues. */
export class B2bWorkerMaintenance{
 #enabled:boolean;#owner:B2bWorkerOwner;#workers:B2bWorkerMaintenanceOptions['components'];
 #entries:Entry[];#id:string|null=null;#state:'REGISTERED'|'STOPPING'|'QUIESCED_LOCAL'|'FAILED'='REGISTERED';#done?:Promise<void>;
 constructor(options:B2bWorkerMaintenanceOptions){
  if(!options||types.isProxy(options)||Object.getPrototypeOf(options)!==Object.prototype||Reflect.ownKeys(options).some(k=>typeof k!=='string'||!['enabled','owner','expected','components'].includes(k))||
   Object.values(Object.getOwnPropertyDescriptors(options)).some(d=>!('value'in d))||typeof options.owner!=='string'||!Object.hasOwn(componentsByOwner,options.owner)||options.enabled!==undefined&&typeof options.enabled!=='boolean'||
   !dataList(options.expected)||!dataList(options.components)||options.expected.length<1||options.expected.length>2||
   options.components.length!==options.expected.length||new Set(options.expected).size!==options.expected.length||
   options.expected.some(id=>!(componentsByOwner[options.owner] as readonly string[]).includes(id))||
   options.components.some(c=>!c||types.isProxy(c)||Object.getPrototypeOf(c)!==Object.prototype||Reflect.ownKeys(c).length!==2||
    !Object.hasOwn(c,'id')||!Object.hasOwn(c,'worker')||Object.values(Object.getOwnPropertyDescriptors(c)).some(d=>!('value'in d))||!options.expected.includes(c.id)||typeof c.worker?.close!=='function')||new Set(options.components.map(c=>c.id)).size!==options.components.length)
   throw new Error('EXPLICIT_OWNER_WORKER_SET_REQUIRED');
  this.#enabled=options.enabled===true;this.#owner=options.owner;
  this.#workers=options.components.map(c=>({id:c.id,worker:c.worker}));this.#entries=this.#workers.map(c=>({id:c.id,state:'REGISTERED',code:null}));
 }
 stop(){
  if(!this.#enabled)throw new Error('B2B_WORKER_MAINTENANCE_DISABLED');
  if(this.#state!=='REGISTERED')return this.snapshot();
  this.#id=randomUUID();this.#state='STOPPING';
  const closing=this.#workers.map((c,index)=>{
   const entry=this.#entries[index];entry.state='STOPPING';
   try{
    // Invoke synchronously so each owner closes admission before stop returns.
    const promise=c.worker.close();if(!(promise instanceof Promise))throw new Error();
    return promise.then(()=>{entry.state='STOPPED';},()=>{entry.state='FAILED';entry.code='WORKER_STOP_FAILED';});
   }catch{entry.state='FAILED';entry.code='WORKER_STOP_FAILED';return Promise.resolve();}
  });
  this.#done=Promise.all(closing).then(()=>{this.#state=this.#entries.some(e=>e.state==='FAILED')?'FAILED':'QUIESCED_LOCAL';});
  return this.snapshot();
 }
 async wait(timeoutMs=30000){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<0||timeoutMs>60000)throw new Error('INVALID_WORKER_MAINTENANCE_TIMEOUT');
  if(!this.#done)throw new Error('B2B_WORKER_MAINTENANCE_NOT_STARTED');
  if(timeoutMs){let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([this.#done,new Promise<void>(r=>{timer=setTimeout(r,timeoutMs);})]);}finally{clearTimeout(timer);}}
  return this.snapshot();
 }
 snapshot(){return {schemaVersion:'factuez.b2b.worker-maintenance.v1',environment:'BETA' as const,owner:this.#owner,
  state:this.#enabled?this.#state:'DISABLED',maintenanceId:this.#id,localProcessOnly:true,globalWriteFenceVerified:false,
  backupAuthorized:false,durablePendingWork:'NOT_INSPECTED' as const,components:this.#entries.map(e=>({...e}))};}
 toJSON(){return this.snapshot();}
 [inspect.custom](){return this.snapshot();}
}
