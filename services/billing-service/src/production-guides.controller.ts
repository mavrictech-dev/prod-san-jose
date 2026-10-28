import { Body,Controller,Get,Header,Headers,Param,Post,Req,Res,UseGuards } from '@nestjs/common';
import { PermissionCodes } from '@factuez/contracts';
import { JwtPermissionGuard,RequiredPermissions,type AuthenticatedRequest } from './auth/jwt-permission.guard';
import { ProductionGuidesOwner } from './production-guides-owner';
import type { ProductionGuidesArtifactKind } from '@factuez/contracts/production-guides';
@Controller('api/v1/production-guides')
@UseGuards(JwtPermissionGuard)
export class ProductionGuidesBillingController {
 constructor(private readonly owner:ProductionGuidesOwner){}
 private actor(r:AuthenticatedRequest){return {userId:r.user!.sub,scope:r.user!.scope};}
 @Post('series') @RequiredPermissions(PermissionCodes.SUNAT_CONFIGURE)
 createSeries(@Body() body:unknown,@Req() r:AuthenticatedRequest){return this.owner.createSeries(body,this.actor(r));}
 @Get('series/point/:id') @RequiredPermissions(PermissionCodes.DOCUMENT_VIEW) @Header('Cache-Control','private, no-store')
 series(@Param('id') id:string,@Req() r:AuthenticatedRequest){return this.owner.series(id,this.actor(r));}
 @Post() @RequiredPermissions(PermissionCodes.DOCUMENT_ISSUE)
 issue(@Body() body:unknown,@Headers('idempotency-key') key:string,@Req() r:AuthenticatedRequest){return this.owner.issue(body,key,this.actor(r));}
 @Post('series/:id/grants') @RequiredPermissions(PermissionCodes.SUNAT_CONFIGURE)
 grant(@Param('id') id:string,@Body() body:unknown,@Req() r:AuthenticatedRequest){return this.owner.configure(id,body,this.actor(r));}
 @Get(':id/status') @RequiredPermissions(PermissionCodes.DOCUMENT_VIEW) @Header('Cache-Control','private, no-store')
 status(@Param('id') id:string,@Req() r:AuthenticatedRequest){return this.owner.status(id,this.actor(r));}
 @Get(':id/artifacts/:kind') @RequiredPermissions(PermissionCodes.DOCUMENT_VIEW)
 async artifact(@Param('id') id:string,@Param('kind') kind:ProductionGuidesArtifactKind,@Req() r:AuthenticatedRequest,@Res() res:any){
  const a=await this.owner.artifact(id,kind,this.actor(r));res.set({'Content-Type':a.mediaType,'Content-Disposition':`attachment; filename="${a.name}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Content-SHA256':a.sha256});res.send(a.bytes);
 }
 @Get(':id/pdf') @RequiredPermissions(PermissionCodes.DOCUMENT_VIEW)
 async pdf(@Param('id') id:string,@Req() r:AuthenticatedRequest,@Res() res:any){const b=await this.owner.pdf(id,this.actor(r));res.set({'Content-Type':'application/pdf','Cache-Control':'private, no-store','Content-Disposition':`inline; filename="${id}.pdf"`,'X-Content-Type-Options':'nosniff'});res.send(b);}
}
