import { Body, Controller, Get, HttpCode, Inject, Module, Param, Post, Query, Req, Res, type DynamicModule } from '@nestjs/common';
import { privateRequest, readQuery } from '@factuez/service-access/dist/integration';
import { privateHeaders } from '@factuez/service-access/dist/integration-http';
import { BillingRead } from './read';
import { BillingCapture } from './capture';
import { deny } from '@factuez/service-access/dist/integration';
import { OwnerChanges } from '@factuez/service-access/dist/integration-owner-changes';
const CORE=Symbol('Billing private reads'), PEERS=Symbol('Billing read peers');
const CAPTURE=Symbol('Billing consistent capture');
const CHANGES=Symbol('Billing private change journal');
export const billingCapturePostPaths={'/internal/integration/capture':8192,'/internal/integration/reauthorize':4*1024*1024};
@Controller('internal/integration')
export class BillingReadController {
  constructor(@Inject(CORE) private readonly core: BillingRead,@Inject(PEERS) private readonly peers:string[],
    @Inject(CAPTURE) private readonly capture:BillingCapture|null,@Inject(CHANGES) private readonly changes:OwnerChanges|null) {}
  private token(req:any,res:any) {privateHeaders(res); return privateRequest(req,this.peers).token;}
  @Get('catalog') catalog(@Req() req:any,@Res({passthrough:true}) res:any,@Query() query:unknown) {
    const token=this.token(req,res), q=readQuery(query,['issuerRuc','environment']); return this.core.catalog(token,q.issuerRuc);
  }
  @Get('documents/lookup') lookup(@Req() req:any,@Res({passthrough:true}) res:any,@Query() query:unknown) {
    const token=this.token(req,res), q=readQuery(query,['issuerRuc','environment','type','series','number'],['issuerRuc','type','series','number']);
    return this.core.lookup(token,q);
  }
  @Get('documents/:id') document(@Req() req:any,@Res({passthrough:true}) res:any,@Query() query:unknown,@Param('id') id:string) {
    const token=this.token(req,res), q=readQuery(query,['issuerRuc','environment']); return this.core.document(token,q.issuerRuc,id);
  }
  @Get('batches/:id') batch(@Req() req:any,@Res({passthrough:true}) res:any,@Query() query:unknown,@Param('id') id:string) {
    const token=this.token(req,res), q=readQuery(query,['issuerRuc','environment']); return this.core.batch(token,q.issuerRuc,id);
  }
  @Get('capture-ready') async ready(@Req() req:any,@Res({passthrough:true}) res:any,@Query() query:unknown) {
    const token=this.token(req,res),q=readQuery(query,['issuerRuc','environment']);
    if(!this.capture)return deny(503,'CONSISTENT_READ_UNAVAILABLE');await this.core.catalog(token,q.issuerRuc);return {ready:true};
  }
  @Get('journal') journal(@Req() req:any,@Res({passthrough:true}) res:any,@Query() query:unknown) {
    const token=this.token(req,res);if(!this.changes)return deny(503,'CHANGE_FEED_NOT_READY');return this.changes.read(token,query);
  }
  @Get('change-ready') changesReady(@Req() req:any,@Res({passthrough:true}) res:any,@Query() query:unknown) {
    const token=this.token(req,res);if(!this.changes)return deny(503,'CHANGE_FEED_NOT_READY');return this.changes.ready(token,query);
  }
  @Post('capture') @HttpCode(200) materialize(@Req() req:any,@Res({passthrough:true}) res:any,@Body() body:unknown) {
    const token=this.token(req,res);if(!this.capture)return deny(503,'CONSISTENT_READ_UNAVAILABLE');return this.capture.capture(token,body);
  }
  @Post('reauthorize') @HttpCode(200) authorize(@Req() req:any,@Res({passthrough:true}) res:any,@Body() body:unknown) {
    const token=this.token(req,res);if(!this.capture)return deny(503,'CONSISTENT_READ_UNAVAILABLE');return this.capture.reauthorize(token,body);
  }
}
@Module({})
export class BillingReadModule {
  static isolated(core:BillingRead,peers:string[],capture:BillingCapture|null=null,changes:OwnerChanges|null=null):DynamicModule {return {module:BillingReadModule,controllers:[BillingReadController],
    providers:[{provide:CORE,useValue:core},{provide:PEERS,useValue:peers},{provide:CAPTURE,useValue:capture},{provide:CHANGES,useValue:changes}]};}
}
