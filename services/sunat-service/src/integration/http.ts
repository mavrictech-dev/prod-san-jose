import { Controller, Get, Inject, Module, Param, Query, Req, Res, type DynamicModule } from '@nestjs/common';
import { deny, privateRequest, readQuery } from '@factuez/service-access/dist/integration';
import { OwnerChanges } from '@factuez/service-access/dist/integration-owner-changes';
import { privateHeaders, artifactResponse } from '@factuez/service-access/dist/integration-http';
import { SunatRead } from './read';
const CORE=Symbol('SUNAT private reads'),PEERS=Symbol('SUNAT read peers');
const CHANGES=Symbol('SUNAT private change journal');
@Controller('internal/integration')
export class SunatReadController {
  constructor(@Inject(CORE) private readonly core:SunatRead,@Inject(PEERS) private readonly peers:string[],@Inject(CHANGES) private readonly changes:OwnerChanges|null) {}
  private context(req:any,res:any,q:unknown) {privateHeaders(res);const token=privateRequest(req,this.peers).token;
    return {token,issuerRuc:readQuery(q,['issuerRuc','environment']).issuerRuc};}
  @Get('journal') journal(@Req() req:any,@Res({passthrough:true}) res:any,@Query() q:unknown) {
    privateHeaders(res);const token=privateRequest(req,this.peers).token;if(!this.changes)return deny(503,'CHANGE_FEED_NOT_READY');return this.changes.read(token,q);
  }
  @Get('change-ready') changesReady(@Req() req:any,@Res({passthrough:true}) res:any,@Query() q:unknown) {
    privateHeaders(res);const token=privateRequest(req,this.peers).token;if(!this.changes)return deny(503,'CHANGE_FEED_NOT_READY');return this.changes.ready(token,q);
  }
  @Get('batches/:id') batch(@Req() req:any,@Res({passthrough:true}) res:any,@Query() q:unknown,@Param('id') id:string) {
    const c=this.context(req,res,q);return this.core.batch(c.token,c.issuerRuc,id);}
  @Get('documents/:id/artifacts') documents(@Req() req:any,@Res({passthrough:true}) res:any,@Query() q:unknown,@Param('id') id:string) {
    const c=this.context(req,res,q);return this.core.artifacts(c.token,c.issuerRuc,id,'DOCUMENT');}
  @Get('batches/:id/artifacts') batches(@Req() req:any,@Res({passthrough:true}) res:any,@Query() q:unknown,@Param('id') id:string) {
    const c=this.context(req,res,q);return this.core.artifacts(c.token,c.issuerRuc,id,'BATCH');}
  @Get('artifacts/:id/content') async content(@Req() req:any,@Res() res:any,@Query() q:unknown,@Param('id') id:string) {
    const c=this.context(req,res,q);artifactResponse(res,await this.core.content(c.token,c.issuerRuc,id));}
}
@Module({})
export class SunatReadModule {
  static isolated(core:SunatRead,peers:string[],changes:OwnerChanges|null=null):DynamicModule {return {module:SunatReadModule,controllers:[SunatReadController],
    providers:[{provide:CORE,useValue:core},{provide:PEERS,useValue:peers},{provide:CHANGES,useValue:changes}]};}
}
