import type { ProductionGuidesStatusEvent } from '@factuez/contracts/production-guides';
import { ProductionGuidesStore } from './production-guides-store';
import { ProductionGuidesService } from './production-guides-service';
/** Callable from main's existing lifecycle/queue. Construction neither starts timers nor performs fiscal work. */
export class ProductionGuidesSunatRuntime {
 private timer?:ReturnType<typeof setInterval>;private running=false;private autoStart=false;
 enableLifecycle(enabled:boolean){this.autoStart=enabled;return this;}
 onApplicationBootstrap(){if(this.autoStart&&this.enabled()){this.timer=setInterval(()=>{if(this.running)return;this.running=true;void this.runOnce().catch(()=>undefined).finally(()=>{this.running=false;});},2000);this.timer.unref();}}
 onModuleDestroy(){if(this.timer)clearInterval(this.timer);}

 private busy=false;
 constructor(private readonly service:ProductionGuidesService,private readonly store:ProductionGuidesStore,private readonly sink:(event:ProductionGuidesStatusEvent)=>Promise<void>,private readonly enabled=()=>false){}
 async runOnce(limit=20){if(this.busy||!this.enabled())return;this.busy=true;try{await this.service.tick(limit);await this.store.relay(this.sink,limit);}finally{this.busy=false;}}
}
