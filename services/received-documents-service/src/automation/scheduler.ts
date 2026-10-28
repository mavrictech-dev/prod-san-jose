import type { ReceptionPrisma } from '../prisma.service';
import { connectionSettings, createSyncRun } from './service';
import { hasActivation } from './authorization';
/** Owned by native reception. SQL records are the queue's durable source of truth. */
export class NativeReceptionScheduler {
  private stopping=false; private running?:Promise<void>; private timer?:ReturnType<typeof setInterval>; private last=0;
  constructor(private readonly db:ReceptionPrisma,private readonly enqueue:(id:string)=>Promise<void>) {}
  get lastTick(){return this.last;}
  tick():Promise<void> {
    if(this.stopping)return Promise.resolve(); if(this.running)return this.running;
    this.running=this.work().catch(()=>{}).finally(()=>{this.running=undefined;}); return this.running;
  }
  private async work(){
    let after:number|undefined;
    do {
      const configs=await this.db.receptionConnection.findMany({where:{enabled:true,...(after?{companyId:{gt:after}}:{})},orderBy:{companyId:'asc'},take:100});
      for(const c of configs){
        if(this.stopping)return; const s=connectionSettings(c);
        if(s.mode==='LIVE_READ_ONLY' ? process.env.RECEIVED_LIVE_READ_ALLOWED!=='true'||!await hasActivation(this.db,c) : process.env.RECEIVED_LOCAL_FIXTURE_ENABLED!=='true'||!/^00\d{9}$/.test(c.recipientRuc))continue;
        for(const source of ['MAIL','SIRE'] as const){
          if(this.stopping)return; if(!(source==='MAIL'?s.mailbox.enabled:s.sire.enabled))continue;
          const latest=await this.db.receptionSyncRun.findFirst({where:{companyId:c.companyId,recipientRuc:c.recipientRuc,revision:c.revision,source,OR:[{activeKey:null},{NOT:{activeKey:{startsWith:'b2b/'}}}]},orderBy:{createdAt:'desc'}});
          if(!latest||Date.now()-latest.createdAt.getTime()>=s.intervalMinutes*60000)await createSyncRun(this.db,c.companyId,c.recipientRuc,c.revision,source);
        }
      }
      after=configs.length===100?configs[configs.length-1].companyId:undefined;
    }while(after&&!this.stopping);
    let cursor:string|undefined;
    do {
      const pending=await this.db.receptionSyncRun.findMany({where:{status:{in:['QUEUED','RUNNING']},activeKey:{not:null},NOT:{activeKey:{startsWith:'b2b/'}},...(cursor?{id:{gt:cursor}}:{})},orderBy:{id:'asc'},take:100});
      for(const run of pending){if(this.stopping)return;await this.enqueue(run.id);}
      cursor=pending.length===100?pending[pending.length-1].id:undefined;
    }while(cursor&&!this.stopping);
    if(!this.stopping)this.last=Date.now();
  }
  async start(intervalMs=20000){if(this.stopping||this.timer)throw Error('RECEPTION_SCHEDULER_START_REJECTED');this.timer=setInterval(()=>void this.tick(),intervalMs);await this.tick();}
  async pause(){this.stopping=true;if(this.timer)clearInterval(this.timer);await this.running;}
}

export function nativeReceptionCloseOnce(d:{scheduler:NativeReceptionScheduler;closeWorker():Promise<void>;closeQueue():Promise<void>;closeLive():Promise<void>;closeHealth():Promise<void>;closeDatabase():Promise<void>}) { let closing:Promise<void>|undefined; return ()=>closing??=(async()=>{await d.scheduler.pause();await d.closeWorker();await d.closeQueue();await d.closeLive();await d.closeHealth();await d.closeDatabase();})(); }
