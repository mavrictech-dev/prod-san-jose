import { Body, Controller, Get, Inject, Module, Param, Post, Query, Req, Res, type DynamicModule } from '@nestjs/common';
import { deny, plain, privateRequest, readQuery, type ReadIdentity } from '@factuez/service-access/dist/integration';
import { privateHeaders, artifactResponse } from '@factuez/service-access/dist/integration-http';
import { IntegrationExports } from './core';
import { ExportQuotas, type OwnerHttp } from './model';
const CORE=Symbol('Export owner'),PEERS=Symbol('Export peers'),IDENTITY=Symbol('Export identity'),BILLING=Symbol('Billing cut owner');
export const exportPostPaths={'/internal/integration/exports':16384};
@Controller('internal/integration')
export class IntegrationExportController {
  constructor(@Inject(CORE) private readonly core:IntegrationExports,@Inject(PEERS) private readonly peers:string[],
    @Inject(IDENTITY) private readonly identity:ReadIdentity,@Inject(BILLING) private readonly billing:OwnerHttp) {}
  private token(req:any,res:any) {privateHeaders(res);return privateRequest(req,this.peers).token;}
  @Get('export-capabilities') async capabilities(@Req() req:any,@Res({passthrough:true}) res:any,@Query() query:unknown) {
    const token=this.token(req,res),q=readQuery(query,['issuerRuc','environment']);
    await this.identity.authenticate(token,['integration:catalog:read']);
    const upstream=await this.billing.json<{ready:true}>(`/internal/integration/capture-ready?issuerRuc=${q.issuerRuc}`,token);
    if(upstream.ready!==true) return deny(503,'CONSISTENT_READ_UNAVAILABLE');
    return {ready:true,serverQuotas:ExportQuotas,changes:await this.core.changesReady(token,q.issuerRuc)?'READY':'NOT_READY'};
  }
  @Get('documents') documents(@Req() req:any,@Res({passthrough:true}) res:any,@Query() query:unknown) {return this.core.documents(this.token(req,res),query);}
  @Get('changes') changes(@Req() req:any,@Res({passthrough:true}) res:any,@Query() query:unknown) {return this.core.changes(this.token(req,res),query);}
  @Get('documents/:id') detail(@Req() req:any,@Res({passthrough:true}) res:any,@Param('id') id:string,@Query() query:unknown) {
    const token=this.token(req,res),q=readQuery(query,['issuerRuc','environment','snapshotId'],['issuerRuc','snapshotId']);
    return this.core.detail(token,id,q.snapshotId,q.issuerRuc);
  }
  @Post('exports') create(@Req() req:any,@Res({passthrough:true}) res:any,@Body() body:unknown) {
    const token=this.token(req,res);
    if(!plain(body)||Object.keys(body).length!==2||!Object.hasOwn(body,'key')||!Object.hasOwn(body,'request')) return deny(400,'INVALID_REQUEST');
    res.status(202);return this.core.create(token,body.key,body.request);
  }
  @Get('exports/:id') status(@Req() req:any,@Res({passthrough:true}) res:any,@Param('id') id:string,@Query() query:unknown) {
    const token=this.token(req,res),q=readQuery(query,['issuerRuc','environment']);return this.core.status(token,id,q.issuerRuc);
  }
  @Get('exports/:id/manifest') manifest(@Req() req:any,@Res({passthrough:true}) res:any,@Param('id') id:string,@Query() query:unknown) {
    const token=this.token(req,res),q=readQuery(query,['issuerRuc','environment']);return this.core.manifest(token,id,q.issuerRuc);
  }
  @Get('exports/:id/content') async content(@Req() req:any,@Res() res:any,@Param('id') id:string,@Query() query:unknown) {
    const token=this.token(req,res),q=readQuery(query,['issuerRuc','environment']);artifactResponse(res,await this.core.content(token,id,q.issuerRuc));
  }
}
@Module({})
export class IntegrationExportModule {
  static isolated(core:IntegrationExports,identity:ReadIdentity,billing:OwnerHttp,peers:string[]):DynamicModule {
    return {module:IntegrationExportModule,controllers:[IntegrationExportController],providers:[{provide:CORE,useValue:core},
      {provide:IDENTITY,useValue:identity},{provide:BILLING,useValue:billing},{provide:PEERS,useValue:peers}]};
  }
}
