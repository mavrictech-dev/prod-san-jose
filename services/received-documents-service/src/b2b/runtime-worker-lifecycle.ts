import type {ReceptionPrisma} from '../prisma.service';
import {connectionSettings,createSyncRun} from '../automation/service';

export interface ReceptionWorkerSchedulerDependencies {
 database:Pick<ReceptionPrisma,'receptionConnection'|'receptionSyncRun'>;
 enqueue(runId:string):Promise<void>;
 allowLocalFixture():boolean;allowLiveRead():boolean;
 createRun:typeof createSyncRun;
}
/** One owned tick promise, including all SQL and enqueue awaits. pause() fences
 * future operations and waits the tick; it never cancels an in-flight write. */
export class ReceptionWorkerScheduler {
 #stopping=false;#ticking?:Promise<void>;#timer?:ReturnType<typeof setInterval>;#lastTick=0;
 constructor(private readonly d:ReceptionWorkerSchedulerDependencies){}
 get lastTick(){return this.#lastTick;}
 tick():Promise<void>{
  if(this.#stopping)return Promise.resolve();if(this.#ticking)return this.#ticking;
  this.#ticking=(async()=>{
   try{
    const configs=await this.d.database.receptionConnection.findMany({where:{enabled:true},take:100});
    for(const c of configs){
     if(this.#stopping)return;
     const s=connectionSettings(c);
     if(s.mode==='LOCAL_FIXTURE'?!this.d.allowLocalFixture()||!c.recipientRuc.startsWith('00'):!this.d.allowLiveRead())continue;
     for(const source of ['MAIL','SIRE'] as const){
      if(this.#stopping)return;if(!(source==='MAIL'?s.mailbox.enabled:s.sire.enabled))continue;
      const latest=await this.d.database.receptionSyncRun.findFirst({where:{companyId:c.companyId,revision:c.revision,source},orderBy:{createdAt:'desc'}});
      if(this.#stopping)return;
      if(!latest||Date.now()-latest.createdAt.getTime()>=s.intervalMinutes*60000)await this.d.createRun(this.d.database as ReceptionPrisma,c.companyId,c.recipientRuc,c.revision,source);
     }
    }
    if(this.#stopping)return;
    const pending=await this.d.database.receptionSyncRun.findMany({where:{status:{in:['QUEUED','RUNNING']},NOT:{activeKey:{startsWith:'b2b/'}}},orderBy:{createdAt:'asc'},take:100});
    for(const r of pending){if(this.#stopping)return;await this.d.enqueue(r.id);}
    if(!this.#stopping)this.#lastTick=Date.now();
   }catch{/* Durable rows survive outages; no private upstream errors are emitted. */}
  })().finally(()=>{this.#ticking=undefined;});return this.#ticking;
 }
 async start(intervalMs=20000){
  if(this.#stopping||this.#timer||!Number.isInteger(intervalMs)||intervalMs<1000||intervalMs>300000)throw Error('RECEPTION_SCHEDULER_START_REJECTED');
  this.#timer=setInterval(()=>{void this.tick();},intervalMs);await this.tick();
 }
 async pause(){this.#stopping=true;if(this.#timer)clearInterval(this.#timer);this.#timer=undefined;await this.#ticking;}
}
export function receptionWorkerCloseOnce(d:{scheduler:ReceptionWorkerScheduler;closeWorker():Promise<void>;closeQueue():Promise<void>;closeLive():Promise<void>;closeHealth():Promise<void>;closeDatabase():Promise<void>}){
 let closing:Promise<void>|undefined;
 return ()=>closing??=(async()=>{
  await d.scheduler.pause();await d.closeWorker();await d.closeQueue();await d.closeLive();await d.closeHealth();await d.closeDatabase();
 })();
}
