import { Injectable,OnApplicationBootstrap,OnModuleDestroy } from '@nestjs/common';
import { Queue,Worker } from 'bullmq';
import { redisConnection } from '@factuez/service-access';
import { PRODUCTION_BATCHES_REQUEST_QUEUE,PRODUCTION_BATCHES_STATUS_QUEUE } from '@factuez/contracts/production-batches';
import { PrismaService } from '../infrastructure/prisma.service';
import { ProductionBatchesRepository } from './production-batches-repository';
import { ProductionBatchesDispatchService } from './production-batches-dispatch.service';
import { productionBatchesEnabled } from './production-batches-policy.service';
@Injectable()
export class ProductionBatchesSunatRuntime implements OnApplicationBootstrap,OnModuleDestroy{
 private queue?:Queue;private worker?:Worker;private timer?:NodeJS.Timeout;private active?:Promise<void>;private closing=false;
 constructor(private readonly prisma:PrismaService,private readonly repository:ProductionBatchesRepository,private readonly dispatch:ProductionBatchesDispatchService){}
 async flush(){
  if(this.closing||!this.queue)return;
  await this.repository.recover();
  const due=await this.prisma.$queryRawUnsafe<{batchId:string}[]>('SELECT "batchId" FROM "ProductionBatchesDispatch" WHERE "state" IN (\'QUEUED\',\'PREPARED\',\'SUBMITTED\') ORDER BY "updatedAt" LIMIT 30');
  for(const r of due){if(this.closing)return;try{await this.dispatch.process(r.batchId);}catch{/* Durable blocker remains pending; no secret/error payload logging. */}}
  const rows=await this.prisma.$queryRawUnsafe<{id:string;payload:unknown}[]>('SELECT * FROM "ProductionBatchesStatusOutbox" WHERE "publishedAt" IS NULL ORDER BY "createdAt" LIMIT 30');
  for(const r of rows){if(this.closing)return;await this.queue.add('production-batches-status',r.payload,{jobId:r.id,attempts:8,backoff:{type:'exponential',delay:2000},removeOnComplete:{age:86400},removeOnFail:{age:604800}});
   await this.prisma.$executeRawUnsafe('UPDATE "ProductionBatchesStatusOutbox" SET "publishedAt"=now() WHERE "id"=$1::uuid',r.id);}
 }
 onApplicationBootstrap(){
  if(!productionBatchesEnabled())return;
  this.queue=new Queue(PRODUCTION_BATCHES_STATUS_QUEUE,{connection:redisConnection()});this.queue.on('error',()=>{});
  this.worker=new Worker(PRODUCTION_BATCHES_REQUEST_QUEUE,j=>this.repository.stage(j.data),{connection:redisConnection(),concurrency:1});this.worker.on('error',()=>{});
  this.timer=setInterval(()=>{if(!this.active&&!this.closing)this.active=this.flush().catch(()=>{}).finally(()=>{this.active=undefined;});},2000);
 }
 async onModuleDestroy(){this.closing=true;if(this.timer)clearInterval(this.timer);await this.worker?.close();await this.active;await this.queue?.close();}
}
