import { Body,Controller,Headers,Param,Post,Req,UseGuards } from '@nestjs/common';
import { PermissionCodes,RoleCodes } from '@factuez/contracts';
import type { ProductionBatchesCommand } from '@factuez/contracts/production-batches';
import { JwtPermissionGuard,RequiredPermissions,type AuthenticatedRequest } from '../auth/jwt-permission.guard';
import { ProductionBatchesOwnerService } from './production-batches-owner.service';
@Controller('api/v1/production-batches')
@UseGuards(JwtPermissionGuard)
export class ProductionBatchesOwnerController{
 constructor(private readonly owner:ProductionBatchesOwnerService){}
 private actor(r:AuthenticatedRequest){return {userId:r.user!.sub,scope:r.user!.scope,authorization:r.headers.authorization as string,administrator:r.user!.roles.includes(RoleCodes.ADMIN)};}
 @Post()
 @RequiredPermissions(PermissionCodes.DOCUMENT_ISSUE)
 issue(@Body()body:ProductionBatchesCommand,@Headers('idempotency-key')key:string,@Req()r:AuthenticatedRequest){return this.owner.issue(body,key,this.actor(r));}
 @Post('documents/:documentId/not-delivered')
 @RequiredPermissions(PermissionCodes.DOCUMENT_ISSUE)
 declare(@Param('documentId')id:string,@Body()body:{reason:string},@Req()r:AuthenticatedRequest){
  if(!body||Object.keys(body).join(',')!=='reason')throw Error('Envíe sólo motivo');
  return this.owner.declareNotDelivered(id,body.reason,this.actor(r));
 }
}
