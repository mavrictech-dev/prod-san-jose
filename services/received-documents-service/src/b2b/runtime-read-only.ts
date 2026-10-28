import type {B2bIdentityPort} from '@factuez/service-access/dist/b2b-read-adapter';
import type {ReceivedDatabase} from './store';
import type {ReceptionAutomationVault} from './automation';
import type {ReceptionAutomationAuthority} from './automation-authority';
import type {ReceptionWriteAuthority} from './commands';
import type {ReadOnlyReceptionBinding} from './automation-read-only.types';
import type {ReceptionServiceTokenConfig} from './automation-read-only.token';
import type {B2bReceivedDispatchConnection,B2bReceivedDispatchTransport} from './automation-dispatch-queue';

export interface B2bReceivedReadOnlyResources {
 connection:B2bReceivedDispatchConnection;bindings:readonly ReadOnlyReceptionBinding[];token:ReceptionServiceTokenConfig;
 pollIntervalMs?:number;batchSize?:number;
}
export interface B2bReceivedReadOnlyWorker {pauseProducers():Promise<void>;close():Promise<void>}
/** Producer gate surrounds real pending/add operations. WORKERS owns queue.close,
 * which awaits active delivery + its SQL; no substitute source or fake executor. */
export class B2bReceivedProducerGate {
 #open=true;#pending=new Set<Promise<unknown>>();
 async run<T>(work:()=>Promise<T>,afterPause:()=>T):Promise<T>{
  if(!this.#open)return afterPause();
  const task=Promise.resolve().then(work);this.#pending.add(task);
  try{const result=await task;return this.#open?result:afterPause();}finally{this.#pending.delete(task);}
 }
 async pause(){this.#open=false;while(this.#pending.size)await Promise.allSettled([...this.#pending]);}
}
export async function startB2bReceivedReadOnlyWorker(d:{database:ReceivedDatabase;identity:B2bIdentityPort;automationAuthority:ReceptionAutomationAuthority;writeAuthority:ReceptionWriteAuthority;vault:ReceptionAutomationVault;resources:B2bReceivedReadOnlyResources},approval?:{enabled:boolean;approvedForReadOnlyBeta:boolean;approvalReference:string}):Promise<B2bReceivedReadOnlyWorker|null>{
 if(approval?.enabled!==true)return null;
 if(approval.approvedForReadOnlyBeta!==true||!/^TI-[A-Za-z0-9._-]{1,80}$/.test(approval.approvalReference))throw Error('B2B_RECEIVED_READ_ONLY_APPROVAL_REQUIRED');
 const {FixedReceptionReadOnlyAdmission,ServiceReceptionDispatchAuthority}=await import('./automation-read-only.authority');
 const {HttpReceptionServiceTokenProvider}=await import('./automation-read-only.token');
 const {B2bReceptionReadOnlySource}=await import('./automation-read-only.source');
 const {B2bReceptionReadOnlyDispatch}=await import('./automation-read-only');
 const {createB2bReceivedDispatchQueue}=await import('./automation-dispatch-queue');
 const {checkB2bReceivedRuntimeSchema}=await import('./runtime-schema');
 const gate=new B2bReceivedProducerGate();let transport:B2bReceivedDispatchTransport|undefined;
 try{
  await checkB2bReceivedRuntimeSchema(d.database,true);
  const resources=d.resources,admission=new FixedReceptionReadOnlyAdmission(resources.bindings);
  const provider=new HttpReceptionServiceTokenProvider({...resources.token,enabled:true});
  const executionAuthority=new ServiceReceptionDispatchAuthority(d.identity,c=>provider.credentials(c));
  const source=new B2bReceptionReadOnlySource(d.vault);
  const owner=new B2bReceptionReadOnlyDispatch(d.database,d.identity,d.automationAuthority,d.writeAuthority,source,{enabled:true,executionAuthority,admission});
  const {Queue,Worker}=await import('bullmq');
  transport=await createB2bReceivedDispatchQueue(resources.connection,{
   run:id=>owner.run(id),pending:limit=>gate.run(()=>owner.pending(limit),()=>[]),
  },{enabled:true,profile:'LIVE_READ_ONLY',pollIntervalMs:resources.pollIntervalMs,batchSize:resources.batchSize,
   factories:{
    queue:(name,options)=>{
     const queue=new Queue(name,options);
     return {on:(event,listener)=>queue.on(event,listener),close:()=>queue.close(),
      add:(job,data,options)=>gate.run(()=>queue.add(job,data,options),()=>{throw Error('B2B_RECEIVED_PRODUCERS_PAUSED');})};
    },worker:(name,processor,options)=>new Worker(name,processor,options),
   }});
  const queue=transport;
  return {pauseProducers:()=>gate.pause(),close:async()=>{await gate.pause();await queue.close();}};
 }catch{await gate.pause();await transport?.close().catch(()=>{});throw Error('B2B_RECEIVED_READ_ONLY_START_BLOCKED');}
}
