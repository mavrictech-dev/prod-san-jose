import { randomUUID } from 'node:crypto';
import { ProductionBatchesAuthenticator } from '@factuez/sunat-core/dist/production-batches-proof';
import { PRODUCTION_BATCHES_OWNER_VERIFIER } from './production-batches-repository';
import { Inject, Injectable } from '@nestjs/common';
import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import { fiscalSnapshotSha256 } from '@factuez/sunat-core';
import { PrismaService } from '../infrastructure/prisma.service';
import type { Prisma } from '../generated/prisma/client';
/** Mandatory shared gate: main calls individualClaim inside the existing stage/claim transaction,
 * before allocating its RC identifier or signing. No absent-route fallback after batch reservation. */
@Injectable()
export class ProductionBatchesRoutingService {
  constructor(private readonly prisma:PrismaService,@Inject(PRODUCTION_BATCHES_OWNER_VERIFIER)private readonly auth:ProductionBatchesAuthenticator){}
  async synchronize(snapshot:FiscalDocumentSnapshot){
    const request={action:'route',snapshot,nonce:randomUUID(),issuedAt:new Date().toISOString()};
    const response=await fetch((process.env.BILLING_INTERNAL_URL??'http://billing-service:3002')+'/api/v1/internal/production-batches/route',{method:'POST',headers:{'Content-Type':'application/json','X-Factuez-Batches-Owner':Buffer.from(JSON.stringify(this.auth.sign(request))).toString('base64url')},body:JSON.stringify(request),redirect:'error',signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw Error('Ruta propietaria no disponible; no elegir individual por defecto');
    const result=await response.json() as {action:string;nonce:string;issuedAt:string;documentId:string;issuerRuc:string;snapshotSha256:string;mode:'INDIVIDUAL'|'BATCH_PENDING';token:string;ownerProof:ReturnType<ProductionBatchesAuthenticator['sign']>};
    const {ownerProof,...body}=result;this.auth.verify(body,ownerProof);
    if(body.action!=='route'||body.nonce!==request.nonce||body.issuedAt!==request.issuedAt||body.documentId!==snapshot.documentId||body.issuerRuc!==snapshot.issuer.identityNumber||body.snapshotSha256!==fiscalSnapshotSha256(snapshot)||!['INDIVIDUAL','BATCH_PENDING'].includes(body.mode))throw Error('Ruta propietaria no exacta');
    await this.prisma.$transaction(async tx=>{
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','production-batches:document:'+snapshot.documentId);
      const rows=await tx.$queryRawUnsafe<{mode:string;token:string;issuerRuc:string}[]>('SELECT * FROM "ProductionBatchesRoute" WHERE "documentId"=$1::uuid FOR UPDATE',snapshot.documentId);
      if(rows[0]){if(rows[0].mode!==body.mode||rows[0].token!==body.token||rows[0].issuerRuc!==body.issuerRuc)throw Error('Ruta fiscal ya fijada');return;}
      await tx.$executeRawUnsafe('INSERT INTO "ProductionBatchesRoute" ("documentId","issuerRuc","token","mode") VALUES ($1::uuid,$2,$3::uuid,$4)',body.documentId,body.issuerRuc,body.token,body.mode);
    },{isolationLevel:'Serializable'});
    return body.mode;
  }
  async reservePending(snapshot:FiscalDocumentSnapshot, token:string){
    if(snapshot.environment!=='PRODUCTION'||snapshot.documentTypeCode!=='03')throw Error('Sólo boleta productiva pendiente');
    return this.prisma.$transaction(async tx=>{
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','production-batches:document:'+snapshot.documentId);
      const doc=await tx.fiscalDocument.findUnique({where:{documentId:snapshot.documentId},include:{submissions:true}});
      if(!doc||doc.environment!=='PRODUCTION'||doc.documentType!=='03'||fiscalSnapshotSha256(doc.immutablePayload)!==fiscalSnapshotSha256(snapshot))throw Error('Original SUNAT no disponible');
      const routes=await tx.$queryRawUnsafe<{mode:string;token:string;transmissionStarted:boolean}[]>('SELECT * FROM "ProductionBatchesRoute" WHERE "documentId"=$1::uuid FOR UPDATE',snapshot.documentId);
      if(routes[0]){
        if(routes[0].mode!=='BATCH_PENDING'||routes[0].token!==token||routes[0].transmissionStarted)throw Error('Ruta ya utilizada');
        return;
      }
      if(!['QUEUED','BUILDING'].includes(doc.status)||doc.submissions.some(s=>s.ticket||s.startedAt||!['AWAITING_AUTHORIZATION','BLOCKED'].includes(s.errorCode??'')))throw Error('RC individual ya iniciado; requiere RC2/3 aceptado');
      await tx.$executeRawUnsafe('INSERT INTO "ProductionBatchesRoute" ("documentId","issuerRuc","token","mode") VALUES ($1::uuid,$2,$3::uuid,\'BATCH_PENDING\')',snapshot.documentId,snapshot.issuer.identityNumber,token);
    },{isolationLevel:'Serializable'});
  }
  async individualClaim(tx:Prisma.TransactionClient,documentId:string,ruc:string){
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','production-batches:document:'+documentId);
    const rows=await tx.$queryRawUnsafe<{mode:string;issuerRuc:string}[]>('SELECT * FROM "ProductionBatchesRoute" WHERE "documentId"=$1::uuid FOR UPDATE',documentId);
    if(!rows[0]||rows[0].mode!=='INDIVIDUAL'||rows[0].issuerRuc!==ruc)throw Error('Documento reservado para RC múltiple');
    await tx.$executeRawUnsafe('INSERT INTO "ProductionBatchesRoute" ("documentId","issuerRuc","token","mode","transmissionStarted") VALUES ($1::uuid,$2,gen_random_uuid(),\'INDIVIDUAL\',true) ON CONFLICT ("documentId") DO UPDATE SET "transmissionStarted"=true',documentId,ruc);
  }
  async assertIndividualAllowed(documentId:string){
    const rows=await this.prisma.$queryRawUnsafe<{mode:string}[]>('SELECT "mode" FROM "ProductionBatchesRoute" WHERE "documentId"=$1::uuid',documentId);
    if(rows[0]?.mode==='BATCH_PENDING')throw Error('RC individual bloqueado por reserva múltiple');
  }
}
