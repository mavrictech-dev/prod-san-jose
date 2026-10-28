import { Body, Controller, Get, Inject, Module, Param, Post, Query, Req, Res, type DynamicModule } from '@nestjs/common';
import { privateRequest } from '@factuez/service-access/dist/integration';
import { privateHeaders, artifactResponse } from '@factuez/service-access/dist/integration-http';
import { IntegrationReads } from './read';
const CORE=Symbol('Private extraction'),PEERS=Symbol('Private extraction peers');
@Controller('integration/v1')
export class IntegrationReadController {
  constructor(@Inject(CORE) private readonly core:IntegrationReads,@Inject(PEERS) private readonly peers:string[]) {}
  private token(req:any,res:any) {privateHeaders(res);return privateRequest(req,this.peers).token;}
  @Get('capabilities') capabilities(@Req() req:any,@Res({passthrough:true}) res:any,@Query() q:unknown) {return this.core.capabilities(this.token(req,res),q);}
  @Get('issuers') issuers(@Req() req:any,@Res({passthrough:true}) res:any,@Query() q:unknown) {return this.core.catalog(this.token(req,res),'issuers',q);}
  @Get('branches') branches(@Req() req:any,@Res({passthrough:true}) res:any,@Query() q:unknown) {return this.core.catalog(this.token(req,res),'branches',q);}
  @Get('points') points(@Req() req:any,@Res({passthrough:true}) res:any,@Query() q:unknown) {return this.core.catalog(this.token(req,res),'points',q);}
  @Get('documents/lookup') lookup(@Req() req:any,@Res({passthrough:true}) res:any,@Query() q:unknown) {return this.core.document(this.token(req,res),null,q);}
  @Get('documents') list(@Req() req:any,@Res({passthrough:true}) res:any,@Query() q:unknown) {return this.core.documents(this.token(req,res),q);}
  @Get('changes') changes(@Req() req:any,@Res({passthrough:true}) res:any,@Query() q:unknown) {return this.core.changes(this.token(req,res),q);}
  @Get('documents/:id') document(@Req() req:any,@Res({passthrough:true}) res:any,@Query() q:unknown,@Param('id') id:string) {return this.core.document(this.token(req,res),id,q);}
  @Get('documents/:id/artifacts') documents(@Req() req:any,@Res({passthrough:true}) res:any,@Query() q:unknown,@Param('id') id:string) {return this.core.owner(this.token(req,res),`documents/${id}/artifacts`,q,'artifacts');}
  @Get('batches/:id') batch(@Req() req:any,@Res({passthrough:true}) res:any,@Query() q:unknown,@Param('id') id:string) {return this.core.owner(this.token(req,res),`batches/${id}`,q,'document');}
  @Get('batches/:id/artifacts') batches(@Req() req:any,@Res({passthrough:true}) res:any,@Query() q:unknown,@Param('id') id:string) {return this.core.owner(this.token(req,res),`batches/${id}/artifacts`,q,'artifacts');}
  @Get('artifacts/:id/content') async content(@Req() req:any,@Res() res:any,@Query() q:unknown,@Param('id') id:string) {artifactResponse(res,await this.core.content(this.token(req,res),id,q));}
  @Post('exports') create(@Req() req:any,@Res({passthrough:true}) res:any,@Body() body:unknown) {
    res.status(202);return this.core.createExport(this.token(req,res),req.headers['idempotency-key'],body);
  }
  @Get('exports/:id') exportStatus(@Req() req:any,@Res({passthrough:true}) res:any,@Query() q:unknown,@Param('id') id:string) {return this.core.exportRead(this.token(req,res),id,q,'status');}
  @Get('exports/:id/manifest') exportManifest(@Req() req:any,@Res({passthrough:true}) res:any,@Query() q:unknown,@Param('id') id:string) {return this.core.exportRead(this.token(req,res),id,q,'manifest');}
  @Get('exports/:id/content') async exportContent(@Req() req:any,@Res() res:any,@Query() q:unknown,@Param('id') id:string) {artifactResponse(res,await this.core.exportRead(this.token(req,res),id,q,'content') as any);}
}
@Module({})
export class IntegrationReadModule {
  static isolated(core:IntegrationReads,peers:string[]):DynamicModule {return {module:IntegrationReadModule,controllers:[IntegrationReadController],
    providers:[{provide:CORE,useValue:core},{provide:PEERS,useValue:peers}]};}
}
