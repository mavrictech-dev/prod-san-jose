import { Inject,Injectable,OnApplicationBootstrap,OnModuleDestroy } from '@nestjs/common';
import { Queue,Worker } from 'bullmq';
import { redisConnection } from '@factuez/service-access';
import { fiscalSnapshotSha256 } from '@factuez/sunat-core';
import { ProductionBatchesAuthenticator } from '@factuez/sunat-core/dist/production-batches-proof';
import { PRODUCTION_BATCHES_REQUEST_QUEUE,PRODUCTION_BATCHES_STATUS_QUEUE,type ProductionBatchesStatus,type ProductionBatchesIssued } from '@factuez/contracts/production-batches';
import { PrismaService } from '../infrastructure/prisma.service';
export const PRODUCTION_BATCHES_STATUS_VERIFIER=Symbol('production-batches-status-verifier');
@Injectable()
export class ProductionBatchesOwnerRuntime implements OnApplicationBootstrap,OnModuleDestroy{
 private queue?:Queue;private worker?:Worker;private timer?:NodeJS.Timeout;private active?:Promise<void>;private closing=false;
 constructor(private readonly prisma:PrismaService,@Inject(PRODUCTION_BATCHES_STATUS_VERIFIER)private readonly auth:ProductionBatchesAuthenticator){}
 async project(event:ProductionBatchesStatus){
  const {ownerProof,...body}=event;this.auth.verify(body,ownerProof);
  const final=['ACCEPTED','REJECTED'].includes(event.status);
  if(event.eventName!=='sunat.production.batches.status.v1'||!['SUBMITTED','ACCEPTED','REJECTED','UNKNOWN','BLOCKED'].includes(event.status)||
     final&&(!/^[a-f0-9]{64}$/.test(event.cdrZipSha256??'')||!/^[0-9]{1,5}$/.test(event.responseCode??'')||(event.status==='ACCEPTED'&&event.responseCode!=='0')))throw Error('Resultado de lote incompleto');
  return this.prisma.$transaction(async tx=>{
   const prior=await tx.$queryRawUnsafe<{payloadSha256:string}[]>('SELECT "payloadSha256" FROM "ProductionBatchesInbox" WHERE "id"=$1::uuid',event.eventId);
   if(prior[0]){if(prior[0].payloadSha256!==fiscalSnapshotSha256(event))throw Error('Replay de estado alterado');return;}
   const rows=await tx.$queryRawUnsafe<{payload:ProductionBatchesIssued;snapshotSha256:string;state:string;outcome:ProductionBatchesStatus|null}[]>('SELECT * FROM "ProductionBatchesReservation" WHERE "batchId"=$1::uuid FOR UPDATE',event.batchId),r=rows[0];
   if(!r||r.snapshotSha256!==event.snapshotSha256||r.payload.snapshot.issuerRuc!==event.issuerRuc)throw Error('Lote propietario ajeno');
   const expected=r.payload.snapshot.entries.map(e=>({documentId:e.snapshot.documentId,snapshotSha256:fiscalSnapshotSha256(e.snapshot),...(e.conditionCode?{conditionCode:e.conditionCode}:{})}));
   if(fiscalSnapshotSha256(expected)!==fiscalSnapshotSha256(event.members))throw Error('Miembros propietarios no exactos');
   const isFinal=['ACCEPTED','REJECTED'].includes(r.state);
   if(isFinal){
    if(final&&(r.outcome?.status!==event.status||r.outcome?.cdrZipSha256!==event.cdrZipSha256||r.outcome?.responseCode!==event.responseCode))throw Error('No se reemplaza resultado final');
   }else{
    for(const e of r.payload.snapshot.entries){
     const d=await tx.document.findUnique({where:{id:e.snapshot.documentId}});
     if(!d||fiscalSnapshotSha256(d.immutableSnapshot)!==fiscalSnapshotSha256(e.snapshot))throw Error('Original propietario alterado');
     const isVoid=r.payload.snapshot.kind==='RA'||e.conditionCode==='3';
     // Corrections never degrade the original document acceptance on pending/rejected/unknown batch.
     if(event.status==='ACCEPTED'){
      await tx.document.update({where:{id:d.id},data:{sunatStatus:isVoid?'VOIDED':'ACCEPTED'}});
      if(!isVoid)await tx.$executeRawUnsafe('UPDATE "ProductionBatchesMember" SET "active"=false WHERE "batchId"=$1::uuid AND "documentId"=$2::uuid',event.batchId,d.id);
     }else if(e.conditionCode==='1'){
      await tx.document.update({where:{id:d.id},data:{sunatStatus:event.status==='SUBMITTED'?'PROCESSING':event.status==='REJECTED'?'REJECTED':event.status==='UNKNOWN'?'RETRYABLE_ERROR':'PERMANENT_ERROR'}});
     }
    }
    await tx.$executeRawUnsafe('UPDATE "ProductionBatchesReservation" SET "state"=$2,"outcome"=$3::jsonb WHERE "batchId"=$1::uuid',event.batchId,event.status,JSON.stringify(event));
   }
   await tx.$executeRawUnsafe('INSERT INTO "ProductionBatchesInbox" ("id","payloadSha256") VALUES ($1::uuid,$2)',event.eventId,fiscalSnapshotSha256(event));
  });
 }
 async flush(){
  if(this.closing||!this.queue)return;
  const rows=await this.prisma.$queryRawUnsafe<{id:string;payload:unknown}[]>('SELECT * FROM "ProductionBatchesOutbox" WHERE "publishedAt" IS NULL ORDER BY "createdAt" LIMIT 30');
  for(const r of rows){if(this.closing)return;await this.queue.add('production-batches',r.payload,{jobId:r.id,attempts:8,backoff:{type:'exponential',delay:2000},removeOnComplete:{age:86400},removeOnFail:{age:604800}});
   await this.prisma.$executeRawUnsafe('UPDATE "ProductionBatchesOutbox" SET "publishedAt"=now() WHERE "id"=$1::uuid',r.id);}
 }
 onApplicationBootstrap(){
  if(process.env.BILLING_PRODUCTION_BATCHES_ENABLED!=='true')return;
  this.queue=new Queue(PRODUCTION_BATCHES_REQUEST_QUEUE,{connection:redisConnection()});this.queue.on('error',()=>{});
  this.worker=new Worker(PRODUCTION_BATCHES_STATUS_QUEUE,j=>this.project(j.data),{connection:redisConnection(),concurrency:1});this.worker.on('error',()=>{});
  this.timer=setInterval(()=>{if(!this.active&&!this.closing)this.active=this.flush().catch(()=>{}).finally(()=>{this.active=undefined;});},1000);
 }
 async onModuleDestroy(){this.closing=true;if(this.timer)clearInterval(this.timer);await this.worker?.close();await this.active;await this.queue?.close();}
}
