import { Injectable } from '@nestjs/common';
import { fiscalDate,fiscalUuid,fiscalRuc } from '@factuez/sunat-core';
import { PrismaService } from '../infrastructure/prisma.service';
import type { Prisma } from '../generated/prisma/client';
/** Sole RC/RA identifier allocator for the NEW native paths. Main must replace the individual
 * MAX(FiscalBatch)+1 block with reserveWithin(tx,...), preserving its existing reserved-batch replay path.
 * Orphaned cross-owner reservations are permanent tombstones; a retry uses the same operation UUID. */
@Injectable()
export class ProductionBatchesNumberingService{
 constructor(private readonly prisma:PrismaService){}
 reserve(ownerId:string,ruc:string,kind:'RC'|'RA',issueDate:string){
  return this.prisma.$transaction(tx=>this.reserveWithin(tx,ownerId,ruc,kind,issueDate),{isolationLevel:'Serializable'});
 }
 async reserveWithin(tx:Prisma.TransactionClient,ownerId:string,ruc:string,kind:'RC'|'RA',issueDate:string){
  fiscalUuid(ownerId,'number.ownerId');fiscalRuc(ruc,'ruc');fiscalDate(issueDate,'issueDate');
  if(!['RC','RA'].includes(kind))throw Error('Tipo de lote inválido');
  // Same advisory lock as reserveSummary, plus durable registry consumed by both modes.
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',ruc+':PRODUCTION:'+kind);
  const prior=await tx.$queryRawUnsafe<{identifier:string;issuerRuc:string;kind:string;issueDate:Date}[]>('SELECT * FROM "ProductionBatchesNumber" WHERE "ownerId"=$1::uuid',ownerId);
  if(prior[0]){
   if(prior[0].issuerRuc!==ruc||prior[0].kind!==kind||prior[0].issueDate.toISOString().slice(0,10)!==issueDate)throw Error('Reserva de número incompatible');
   return prior[0].identifier;
  }
  const pattern='^'+kind+'-'+issueDate.replaceAll('-','')+'-[1-9][0-9]{0,4}$';
  const max=await tx.$queryRawUnsafe<{maximum:number|null}[]>('SELECT MAX(n) AS maximum FROM (SELECT split_part("identifier",\'-\',3)::integer AS n FROM "FiscalBatch" WHERE "issuerRuc"=$1 AND "environment"::text=\'PRODUCTION\' AND "identifier" ~ $2 UNION ALL SELECT split_part("identifier",\'-\',3)::integer FROM "ProductionBatchesNumber" WHERE "issuerRuc"=$1 AND "identifier" ~ $2) numbers',ruc,pattern);
  const next=(max[0]?.maximum??0)+1;if(next>99999)throw Error('Correlativo de lote agotado');
  const identifier=kind+'-'+issueDate.replaceAll('-','')+'-'+next;
  await tx.$executeRawUnsafe('INSERT INTO "ProductionBatchesNumber" ("ownerId","issuerRuc","kind","issueDate","identifier") VALUES ($1::uuid,$2,$3,$4::date,$5)',ownerId,ruc,kind,issueDate,identifier);
  return identifier;
 }
}
