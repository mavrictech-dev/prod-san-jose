import type { ProductionGuidesIssued,ProductionGuidesStatusEvent } from '@factuez/contracts/production-guides';
import type { ProductionGuidesBillingDb } from './production-guides-owner';
import { ProductionGuidesOwner } from './production-guides-owner';
/** Host-owned scheduling. Explicit protected in-process/mTLS capabilities, never public HTTP URLs or payload bearer tokens. */
export class ProductionGuidesBillingRuntime {
 private timer?:ReturnType<typeof setInterval>;private running=false;private autoStart=false;
 enableLifecycle(enabled:boolean){this.autoStart=enabled;return this;}
 onApplicationBootstrap(){if(this.autoStart&&this.enabled()){this.timer=setInterval(()=>{if(this.running)return;this.running=true;void this.flush().catch(()=>undefined).finally(()=>{this.running=false;});},2000);this.timer.unref();}}
 onModuleDestroy(){if(this.timer)clearInterval(this.timer);}

 constructor(private readonly db:ProductionGuidesBillingDb,private readonly owner:ProductionGuidesOwner,private readonly receiver:{ingest(e:ProductionGuidesIssued):Promise<unknown>},private readonly enabled=()=>false){}
 async flush(limit=20){if(!this.enabled())return 0;return this.db.$transaction(async tx=>{
  const rows=await tx.$queryRawUnsafe<{id:string;payload:ProductionGuidesIssued}[]>('SELECT "id","payload" FROM "OutboxEvent" WHERE "eventType"=\'billing.production-guides.issued.v1\' AND "publishedAt" IS NULL ORDER BY "occurredAt" LIMIT $1 FOR UPDATE SKIP LOCKED',Math.max(1,Math.min(100,limit)));
  for(const row of rows){await this.owner.current(row.payload);await this.receiver.ingest(row.payload);await tx.$executeRawUnsafe('UPDATE "OutboxEvent" SET "publishedAt"=now() WHERE "id"=$1::uuid',row.id);}return rows.length;
 },{timeout:60000});}
 async receive(event:ProductionGuidesStatusEvent){if(!this.enabled())throw Error('GRE_OWNER_RUNTIME_DISABLED');return this.owner.applyStatus(event);}
}
