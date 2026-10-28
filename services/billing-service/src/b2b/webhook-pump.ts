import type {B2bCommitPublisher} from './webhook-publisher';
/** Explicit post-commit worker assembly; not registered in existing Billing AppModule. */
export class B2bCommitPump {
  private timer?:ReturnType<typeof setInterval>;private pending:Promise<void>|null=null;
  constructor(private readonly publisher:B2bCommitPublisher){}
  tick(){if(this.pending)return this.pending;this.pending=(async()=>{try{for(let i=0;i<25;i++)if(!await this.publisher.flush())break;}finally{this.pending=null;}})();return this.pending;}
  start(){if(this.timer)throw new Error('Publisher already started');this.timer=setInterval(()=>{void this.tick().catch(()=>{});},2000);this.timer.unref();}
  async close(){clearInterval(this.timer);this.timer=undefined;await this.pending;}
}
