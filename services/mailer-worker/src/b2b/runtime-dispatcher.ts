import type {B2bEmailDeliveries} from './email-deliveries';
import type {EmailDeliveryPgPool} from './email-deliveries.store';
import type {EmailDeliveryExecutionAuthority} from './email-deliveries.types';
/** Explicit private job capability. It must resolve the saved actor at Identity NOW,
 * without storing/replaying a user bearer. No HTTP RUN or synthesized principal. */
export class B2bMailerDispatcher {
 #stopped=false;#timer?:ReturnType<typeof setTimeout>;#active?:Promise<void>;#started=false;#cursor:string|null=null;
 constructor(private readonly pool:EmailDeliveryPgPool,private readonly core:B2bEmailDeliveries,
  private readonly authority:EmailDeliveryExecutionAuthority,private readonly options:{intervalMs:number;batchSize:number;profile?:'LOCAL_CAPTURE'|'CORPORATE'}){
  if(options.profile!==undefined&&!['LOCAL_CAPTURE','CORPORATE'].includes(options.profile))throw Error('B2B_MAILER_DISPATCH_PROFILE_INVALID');
 }
 start(){if(this.#started||this.#stopped)throw Error('B2B_MAILER_DISPATCH_START_REJECTED');this.#started=true;this.schedule(0);}
 private schedule(delay:number){if(!this.#stopped)this.#timer=setTimeout(()=>{this.#timer=undefined;void this.tick().catch(()=>{/* No exception/recipient/token logging; next bounded poll retries eligibility only. */}).finally(()=>this.schedule(this.options.intervalMs));},delay);}
 tick():Promise<void>{
  if(this.#stopped)return Promise.reject(Error('B2B_MAILER_DISPATCH_STOPPED'));
  if(this.#active)return this.#active;
  const task=(async()=>{
   const db=await this.pool.connect();let ids:string[];
   const profile=this.options.profile??'LOCAL_CAPTURE';
   const table=profile==='CORPORATE'?'"B2bCorporateEmailDeliveryJob"':'"B2bEmailDeliveryJob"';
   try{ids=(await db.query<{id:string}>(`SELECT id FROM ${table}
    WHERE state IN ('QUEUED','WAITING_ARTIFACTS','DISPATCHING') AND payload->>'profile'=$3
     AND ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT $2`,[this.#cursor,this.options.batchSize,profile])).rows.map(j=>j.id);}
   finally{db.release();}
   this.#cursor=ids.length===this.options.batchSize?ids[ids.length-1]:null;
   for(const id of ids){if(this.#stopped)break;try{await this.core.run(id,this.authority);}catch{/* Denied jobs do not stop the batch; core owns durable ambiguity handling. */}}
  })();this.#active=task;
  void task.then(()=>{if(this.#active===task)this.#active=undefined;},()=>{if(this.#active===task)this.#active=undefined;});return task;
 }
 /** Stop producing new attempts first. WORKERS separately waits for ack AND journal. */
 pause(){this.#stopped=true;if(this.#timer)clearTimeout(this.#timer);this.#timer=undefined;}
 async drain(){await this.#active;}
}
