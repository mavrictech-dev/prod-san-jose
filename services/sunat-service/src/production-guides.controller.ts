import { Body,Controller,Post,Req,Res,UseGuards,ForbiddenException,BadRequestException } from '@nestjs/common';
import { allowsResource } from '@factuez/contracts';
import type { ProductionGuidesIssued,ProductionGuidesArtifactKind } from '@factuez/contracts/production-guides';
import { FiscalIssuanceGuard,type ConfigurationRequest } from './auth/fiscal-issuance.guard';
import { ProductionGuidesService } from './production-guides-service';
/** Protected module adapter. No worker/dispatch endpoint and no client-supplied trust/grant flags. */
@Controller('api/v1/production-guides-owner') @UseGuards(FiscalIssuanceGuard)
export class ProductionGuidesSunatController {
 constructor(private readonly service:ProductionGuidesService){}
 private own(e:ProductionGuidesIssued,r:ConfigurationRequest){const s=e?.snapshot;if(!s||!allowsResource(r.user?.scope,s.scope.branchId,s.scope.pointId,s.scope.seriesCounterId))throw new ForbiddenException('Guía fuera de alcance');}
 @Post('status') async status(@Body() e:ProductionGuidesIssued,@Req() r:ConfigurationRequest){this.own(e,r);return this.service.status(e);}
 @Post('artifact') async artifact(@Body() body:{event:ProductionGuidesIssued;kind:ProductionGuidesArtifactKind},@Req() r:ConfigurationRequest,@Res() res:any){
  if(!body||Object.keys(body).sort().join(',')!=='event,kind')throw new BadRequestException();this.own(body.event,r);const a=await this.service.artifact(body.event,body.kind);res.set({'Content-Type':a.mediaType,'Content-Disposition':`attachment; filename="${a.name}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Content-SHA256':a.sha256});res.send(a.bytes);
 }
 @Post('pdf') async pdf(@Body() e:ProductionGuidesIssued,@Req() r:ConfigurationRequest,@Res() res:any){this.own(e,r);const b=await this.service.pdf(e);res.set({'Content-Type':'application/pdf','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});res.send(b);}
}
