import {nativeServicePrincipalId} from '@factuez/service-access/dist/native-b2b-rpc';
import { Body,Controller,ForbiddenException,Get,Header,Headers,Param,Post,Query,Req,Res,UseGuards } from '@nestjs/common';
import { PermissionCodes } from '@factuez/contracts';
import { JwtPermissionGuard,RequiredPermissions,type AuthenticatedRequest } from './auth/jwt-permission.guard';
import { ProductionGuidesOwner } from './production-guides-owner';
import type { ProductionGuidesArtifactKind } from '@factuez/contracts/production-guides';
@Controller('api/v1/production-guides')
@UseGuards(JwtPermissionGuard)
export class ProductionGuidesBillingController {
 constructor(private readonly owner:ProductionGuidesOwner){}
 private actor(r:AuthenticatedRequest){return {userId:r.user!.sub,scope:r.user!.scope};}
 private administrator(r:AuthenticatedRequest){
  const u=r.user! as typeof r.user & {kind?:string;actorKind?:string;createdByActor?:{kind?:string}};
  if(!u||u.scope.kind!=='GLOBAL'||!u.roles.includes('ADMIN')||!u.permissions.includes(PermissionCodes.SUNAT_CONFIGURE)||u.kind==='SERVICE'||u.actorKind==='SERVICE'||u.createdByActor?.kind==='SERVICE')throw new ForbiddenException('Se requiere administrador humano general activo para administrar series y concesiones GRE');
  return this.actor(r);
 }
 @Get('capabilities') @RequiredPermissions(PermissionCodes.DOCUMENT_VIEW) @Header('Cache-Control','private, no-store')
 capabilities(@Query('pointId') pointId:string,@Req() r:AuthenticatedRequest){return this.owner.capabilities(pointId,this.actor(r));}
 @Get() @RequiredPermissions(PermissionCodes.DOCUMENT_VIEW) @Header('Cache-Control','private, no-store')
 list(@Query('pointId') pointId:string,@Query('cursor') cursor:string|undefined,@Req() r:AuthenticatedRequest){return this.owner.list(pointId,cursor,this.actor(r));}
 @Get('carrier-reference') @RequiredPermissions(PermissionCodes.DOCUMENT_VIEW) @Header('Cache-Control','private, no-store')
 reference(@Query('seriesCounterId') seriesId:string,@Query('issuerRuc') issuerRuc:string,@Query('series') series:string,@Query('number') number:string,@Req() r:AuthenticatedRequest){return this.owner.carrierReference(seriesId,{issuerRuc,series,number},this.actor(r));}
 @Get('operations/:id') @RequiredPermissions(PermissionCodes.DOCUMENT_VIEW) @Header('Cache-Control','private, no-store')
 operation(@Param('id') id:string,@Req() r:AuthenticatedRequest){return this.owner.operation(id,this.actor(r));}
 @Post('series') @RequiredPermissions(PermissionCodes.SUNAT_CONFIGURE)
 createSeries(@Body() body:unknown,@Req() r:AuthenticatedRequest){return this.owner.createSeries(body,this.administrator(r));}
 @Get('series/point/:id') @RequiredPermissions(PermissionCodes.DOCUMENT_VIEW) @Header('Cache-Control','private, no-store')
 series(@Param('id') id:string,@Query('actorId') actorId:string|undefined,@Query('actorKind') kind:string|undefined,@Req() r:AuthenticatedRequest){if(kind!==undefined&&kind!=='SERVICE')throw new ForbiddenException();if((kind==='SERVICE'||actorId&&actorId!==r.user!.sub)&&!r.user!.permissions.includes(PermissionCodes.SUNAT_CONFIGURE))throw new ForbiddenException();if(kind==='SERVICE'&&(!actorId||! /^[a-f0-9-]{36}$/.test(actorId)))throw new ForbiddenException();return this.owner.series(id,this.actor(r),kind==='SERVICE'?nativeServicePrincipalId(actorId!):actorId);}
 @Post() @RequiredPermissions(PermissionCodes.DOCUMENT_ISSUE)
 issue(@Body() body:unknown,@Headers('idempotency-key') key:string,@Req() r:AuthenticatedRequest){return this.owner.issue(body,key,this.actor(r));}
 @Post('series/:id/grants') @RequiredPermissions(PermissionCodes.SUNAT_CONFIGURE)
 grant(@Param('id') id:string,@Body() body:unknown,@Req() r:AuthenticatedRequest){return this.owner.configure(id,body,this.administrator(r));}
 @Get(':id/status') @RequiredPermissions(PermissionCodes.DOCUMENT_VIEW) @Header('Cache-Control','private, no-store')
 status(@Param('id') id:string,@Req() r:AuthenticatedRequest){return this.owner.status(id,this.actor(r));}
 @Get(':id/artifacts/:kind') @RequiredPermissions(PermissionCodes.DOCUMENT_VIEW)
 async artifact(@Param('id') id:string,@Param('kind') kind:ProductionGuidesArtifactKind,@Req() r:AuthenticatedRequest,@Res() res:any){
  const a=await this.owner.artifact(id,kind,this.actor(r));res.set({'Content-Type':a.mediaType,'Content-Disposition':`attachment; filename="${a.name}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Content-SHA256':a.sha256});res.send(a.bytes);
 }
 @Get(':id/pdf') @RequiredPermissions(PermissionCodes.DOCUMENT_VIEW)
 async pdf(@Param('id') id:string,@Req() r:AuthenticatedRequest,@Res() res:any){const b=await this.owner.pdf(id,this.actor(r));res.set({'Content-Type':'application/pdf','Cache-Control':'private, no-store','Content-Disposition':`inline; filename="${id}.pdf"`,'X-Content-Type-Options':'nosniff'});res.send(b);}
}
