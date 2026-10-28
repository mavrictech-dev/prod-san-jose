import { Body,Controller,Headers,Inject,Post } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import { fiscalSnapshotSha256,fiscalUuid,fiscalTimestamp,fiscalObject } from '@factuez/sunat-core';
import { ProductionBatchesAuthenticator } from '@factuez/sunat-core/dist/production-batches-proof';
import { PrismaService } from '../infrastructure/prisma.service';
import { PRODUCTION_BATCHES_OWNER_AUTH } from './production-batches-owner.service';
/** Service-to-service read only; HMAC required. Never accepts a public route override.
 * Used by DocumentIssuedConsumer before staging an individual RC, so queue ordering cannot
 * turn a BATCH_PENDING document into an individual submission. No human bearer is archived. */
@Controller('api/v1/internal/production-batches')
export class ProductionBatchesRouteController{
 constructor(private readonly prisma:PrismaService,@Inject(PRODUCTION_BATCHES_OWNER_AUTH)private readonly auth:ProductionBatchesAuthenticator){}
 @Post('route')
 async route(@Body()body:{action:'route';snapshot:FiscalDocumentSnapshot;nonce:string;issuedAt:string},@Headers('x-factuez-batches-owner')proof:string){
  fiscalObject(body,['action','snapshot','nonce','issuedAt'],'route');
  if(typeof proof!=='string'||proof.length>1024)throw Error('HMAC interno requerido');
  this.auth.verify(body,JSON.parse(Buffer.from(proof,'base64url').toString('utf8')));
  fiscalUuid(body.nonce,'nonce');fiscalTimestamp(body.issuedAt,'issuedAt');
  if(body.action!=='route'||Math.abs(Date.now()-Date.parse(body.issuedAt))>300000)throw Error('Solicitud interna vencida');
  const s=body.snapshot,d=await this.prisma.document.findUnique({where:{id:s.documentId},include:{emissionPoint:{include:{company:true}}}});
  if(!d||s.environment!=='PRODUCTION'||s.documentTypeCode!=='03'||d.status!=='ISSUED'||d.companyId!==s.companyId||d.emissionPoint?.company.ruc!==s.issuer.identityNumber||
     fiscalSnapshotSha256(d.immutableSnapshot)!==fiscalSnapshotSha256(s))throw Error('Ruta de original ajeno');
  const rows=await this.prisma.$queryRawUnsafe<{mode:string;token:string;issuerRuc:string}[]>('SELECT * FROM "ProductionBatchesRoute" WHERE "documentId"=$1::uuid',s.documentId),row=rows[0];
  if(row&&row.issuerRuc!==s.issuer.identityNumber)throw Error('Ruta inconsistente');
  const result={action:'route',nonce:body.nonce,issuedAt:body.issuedAt,documentId:s.documentId,issuerRuc:s.issuer.identityNumber,snapshotSha256:fiscalSnapshotSha256(s),
   mode:row?.mode??'INDIVIDUAL',token:row?.token??s.documentId};
  return {...result,ownerProof:this.auth.sign(result)};
 }
}
