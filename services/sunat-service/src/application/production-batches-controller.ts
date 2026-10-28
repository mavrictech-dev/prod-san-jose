import { Body, Controller, Headers, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import { allowsResource } from '@factuez/contracts';
import { fiscalSnapshotSha256, fiscalObject, fiscalUuid } from '@factuez/sunat-core';
import { ProductionBatchesAuthenticator } from '@factuez/sunat-core/dist/production-batches-proof';
import { FiscalIssuanceGuard } from '../auth/fiscal-issuance.guard';
import { ConfigurationGuard,type ConfigurationRequest } from '../auth/configuration.guard';
import { PRODUCTION_BATCHES_OWNER_VERIFIER } from './production-batches-repository';
import { ProductionBatchesEvidenceService } from './production-batches-evidence.service';
import { ProductionBatchesRoutingService } from './production-batches-routing.service';
import { ProductionBatchesNumberingService } from './production-batches-numbering.service';
import { ProductionBatchesPolicyService } from './production-batches-policy.service';
import { PrismaService } from '../infrastructure/prisma.service';
@Controller('api/v1/setup/sunat')
export class ProductionBatchesController{
 constructor(private readonly evidence:ProductionBatchesEvidenceService,private readonly routing:ProductionBatchesRoutingService,
 private readonly numbering:ProductionBatchesNumberingService,private readonly policy:ProductionBatchesPolicyService,private readonly prisma:PrismaService,
 @Inject(PRODUCTION_BATCHES_OWNER_VERIFIER) private readonly auth:ProductionBatchesAuthenticator){}
 @Post(':companyId/PRODUCTION/batches/authorization')
 @UseGuards(ConfigurationGuard)
 configure(@Param('companyId')companyId:string,@Body()input:Parameters<ProductionBatchesPolicyService['configure']>[1],@Req()r:ConfigurationRequest){
  return this.policy.configure(companyId,input,r.headers.authorization!,r.user!.sub);
 }
 @Post(':companyId/PRODUCTION/batches/owner')
 @UseGuards(FiscalIssuanceGuard)
 async owner(@Param('companyId')companyId:string,@Body()body:{action:string;snapshot:FiscalDocumentSnapshot;token?:string;batchId?:string;kind?:'RC'|'RA';issueDate?:string},
 @Headers('x-factuez-batches-owner')proof:string,@Req()r:ConfigurationRequest){
  fiscalObject(body,['action','snapshot','token','batchId','kind','issueDate'],'owner');
  if(typeof proof!=='string'||proof.length>1024)throw Error('HMAC propietario requerido');
  this.auth.verify(body,JSON.parse(Buffer.from(proof,'base64url').toString('utf8')));
  const s=body.snapshot;
  if(!s||String(s.companyId)!==companyId||!s.branchId||!allowsResource(r.user!.scope,s.branchId))throw Error('Original fuera del alcance');
  await this.policy.current(s.issuer.identityNumber);
  // Revalidate live exact owner + bearer before any evidence or route mutation.
  const response=await fetch((process.env.BILLING_INTERNAL_URL??'http://billing-service:3002')+'/api/v1/documents/'+s.documentId,{
   headers:{Authorization:r.headers.authorization!,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw Error('Propietario no autorizado');
  const own=await response.json() as {immutableSnapshot:unknown};
  if(fiscalSnapshotSha256(own.immutableSnapshot)!==fiscalSnapshotSha256(s))throw Error('Snapshot ajeno');
  if(body.action==='accepted')return this.evidence.current(s);
  if(body.action==='pending'){fiscalUuid(body.token,'token');await this.routing.reservePending(s,body.token!);return {reserved:true};}
  if(body.action==='number')return {identifier:await this.numbering.reserve(body.batchId!,s.issuer.identityNumber,body.kind!,body.issueDate!)};
  if(body.action==='available'){
   const locks=await this.prisma.$queryRawUnsafe<unknown[]>('SELECT 1 FROM "ProductionBatchesMember" WHERE "documentId"=$1::uuid AND "active"',s.documentId);
   if(locks.length)throw Error('Documento fiscal reservado');
   return {available:true};
  }
  throw Error('Acción propietaria inválida');
 }
}
