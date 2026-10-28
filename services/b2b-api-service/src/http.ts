import { Catch,Controller,Get,HttpException,Inject,Module,Param,Query,Req,Res,type ArgumentsHost,type DynamicModule,type ExceptionFilter } from '@nestjs/common';
import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { b2bPrivatePeer,newB2bRequestId } from '@factuez/service-access/dist/b2b';
import { IntegrationReadError } from '@factuez/service-access/dist/integration';
import { B2bReads, type B2bPhase7Capabilities, type B2bPhase8Capabilities } from './read';
const CORE=Symbol('B2B API reads'),PEERS=Symbol('B2B API private peers'),DRAFTS=Symbol('Configured draft commands'),EXTRACTION=Symbol('Configured B2B extraction'),ISSUANCE=Symbol('Configured owner issuance');
const WEBHOOKS=Symbol('Configured B2B webhooks');
const COMMERCIAL=Symbol('Configured B2B commercial resources'),CONVERSION=Symbol('Configured B2B commercial conversion');
const CORRECTIONS=Symbol('Configured B2B candidate correction reservations');
const GUIDES=Symbol('Configured B2B non-fiscal guide drafts');
const PREPARATION=Symbol('Configured B2B guide preflight');
const PHASE7=Symbol('Configured B2B phase7 modules');
const RECEIVED=Symbol('Configured B2B incoming reads');
const PHASE8=Symbol('Configured B2B phase8 modules');
export function b2bReadHeaders(res:any){res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');}
@Catch()
export class B2bReadErrorFilter implements ExceptionFilter {
  catch(error:unknown,host:ArgumentsHost){const res=host.switchToHttp().getResponse();b2bReadHeaders(res);
    const status=error instanceof B2bSecurityError||error instanceof IntegrationReadError?error.status:error instanceof HttpException&&[400,404,413].includes(error.getStatus())?error.getStatus():503;
    const code=error instanceof B2bSecurityError||error instanceof IntegrationReadError?error.code:status<500?'INVALID_REQUEST':'OWNER_UNAVAILABLE';
    if(status===401)res.setHeader('WWW-Authenticate','Bearer');if(status===429)res.setHeader('Retry-After','60');
    res.status(status).json({schemaVersion:'factuez.b2b.v1',requestId:newB2bRequestId(),code,message:code,retryable:status===503||status===429});
  }
}
@Controller('b2b/v1')
export class B2bReadController {
  constructor(@Inject(CORE)private readonly core:B2bReads,@Inject(PEERS)private readonly peers:string[],@Inject(DRAFTS)private readonly drafts:boolean,@Inject(EXTRACTION)private readonly extraction:boolean,@Inject(ISSUANCE)private readonly issuance:boolean,@Inject(WEBHOOKS)private readonly webhooks:boolean,@Inject(COMMERCIAL)private readonly commercial:boolean,@Inject(CONVERSION)private readonly conversion:boolean,@Inject(CORRECTIONS)private readonly corrections:boolean,@Inject(GUIDES)private readonly guides:boolean,@Inject(PREPARATION)private readonly preparation:boolean,@Inject(PHASE7)private readonly phase7:B2bPhase7Capabilities|undefined,@Inject(RECEIVED)private readonly received:boolean,@Inject(PHASE8)private readonly phase8:B2bPhase8Capabilities|undefined){}
  private context(req:any,res:any){b2bReadHeaders(res);b2bPrivatePeer(req,this.peers);
    const authorization=req.headers.authorization,kind=req.headers['x-factuez-actor-kind']??'SERVICE';
    if(!['SERVICE','USER'].includes(kind))throw new B2bSecurityError(400,'INVALID_ACTOR_KIND');
    if(typeof authorization!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(authorization))throw new B2bSecurityError(401,'INVALID_TOKEN');
    return {token:authorization.slice(7),kind:kind as 'SERVICE'|'USER'};}
  @Get('me')me(@Req()req:any,@Res({passthrough:true})res:any,@Query()query:unknown){const c=this.context(req,res);if(!query||Object.keys(query).length)throw new B2bSecurityError(400,'INVALID_QUERY');return this.core.me(c.token,c.kind);}
  @Get('capabilities')capabilities(@Req()req:any,@Res({passthrough:true})res:any,@Query()query:unknown){const c=this.context(req,res);return this.core.capabilities(c.token,c.kind,query,this.drafts,this.extraction,this.issuance,this.webhooks,this.commercial,this.conversion,this.corrections,this.guides,this.preparation,this.phase7,this.received,this.phase8);}
  @Get('issuers')issuers(@Req()req:any,@Res({passthrough:true})res:any,@Query()query:unknown){const c=this.context(req,res);return this.core.page(c.token,c.kind,'issuers',query);}
  @Get('branches')branches(@Req()req:any,@Res({passthrough:true})res:any,@Query()query:unknown){const c=this.context(req,res);return this.core.page(c.token,c.kind,'branches',query);}
  @Get('points')points(@Req()req:any,@Res({passthrough:true})res:any,@Query()query:unknown){const c=this.context(req,res);return this.core.page(c.token,c.kind,'points',query);}
  @Get('series')series(@Req()req:any,@Res({passthrough:true})res:any,@Query()query:unknown){const c=this.context(req,res);return this.core.page(c.token,c.kind,'series',query);}
  @Get('products')products(@Req()req:any,@Res({passthrough:true})res:any,@Query()query:unknown){const c=this.context(req,res);return this.core.page(c.token,c.kind,'products',query);}
  @Get('documents/lookup')lookup(@Req()req:any,@Res({passthrough:true})res:any,@Query()query:unknown){const c=this.context(req,res);return this.core.document(c.token,c.kind,null,query);}
  @Get('documents')documents(@Req()req:any,@Res({passthrough:true})res:any,@Query()query:unknown){const c=this.context(req,res);return this.core.page(c.token,c.kind,'documents',query);}
  @Get('documents/:id/status')status(@Req()req:any,@Res({passthrough:true})res:any,@Param('id')id:string,@Query()query:unknown){const c=this.context(req,res);return this.core.document(c.token,c.kind,id,query,true);}
  @Get('documents/:id')document(@Req()req:any,@Res({passthrough:true})res:any,@Param('id')id:string,@Query()query:unknown){const c=this.context(req,res);return this.core.document(c.token,c.kind,id,query);}
  @Get('documents/:id/artifacts')artifacts(@Req()req:any,@Res({passthrough:true})res:any,@Param('id')id:string,@Query()query:unknown){const c=this.context(req,res);return this.core.artifacts(c.token,c.kind,id,query);}
  @Get('batches/:id/artifacts')batch(@Req()req:any,@Res({passthrough:true})res:any,@Param('id')id:string,@Query()query:unknown){const c=this.context(req,res);return this.core.artifacts(c.token,c.kind,id,query,true);}
  private file(res:any,file:any){if(!/^[A-Za-z0-9_-]{1,150}\.(xml|zip|pdf)$/.test(file.fileName))throw new B2bSecurityError(409,'INVALID_FILE_METADATA');res.setHeader('Content-Type',file.mediaType);res.setHeader('Content-Length',file.bytes.length);res.setHeader('X-Content-SHA256',file.sha256);res.setHeader('Content-Disposition',`attachment; filename="${file.fileName}"`);res.status(200).end(file.bytes);}
  @Get('artifacts/:id/content')async content(@Req()req:any,@Res()res:any,@Param('id')id:string,@Query()query:unknown){const c=this.context(req,res);this.file(res,await this.core.content(c.token,c.kind,id,query));}
  @Get('documents/:id/representations/:format')async representation(@Req()req:any,@Res()res:any,@Param('id')id:string,@Param('format')format:string,@Query()query:unknown){const c=this.context(req,res);this.file(res,await this.core.content(c.token,c.kind,id,query,format));}
}
@Module({})
export class B2bReadModule {
  static isolated(core:B2bReads,peers:string[],drafts=false,extraction=false,issuance=false,webhooks=false,commercial=false,conversion=false,corrections=false,guides=false,preparation=false,phase7?:B2bPhase7Capabilities,received=false,phase8?:B2bPhase8Capabilities):DynamicModule{if(!peers.length||peers.length>100||peers.some(peer=>!/^[a-f0-9]{64}$/.test(peer)))throw new Error('B2B facade peers required');
    return {module:B2bReadModule,controllers:[B2bReadController],providers:[{provide:CORE,useValue:core},{provide:PEERS,useValue:peers},{provide:DRAFTS,useValue:drafts},{provide:EXTRACTION,useValue:extraction},{provide:ISSUANCE,useValue:issuance},{provide:WEBHOOKS,useValue:webhooks},{provide:COMMERCIAL,useValue:commercial},{provide:CONVERSION,useValue:conversion},{provide:CORRECTIONS,useValue:corrections},{provide:GUIDES,useValue:guides},{provide:PREPARATION,useValue:preparation},{provide:PHASE7,useValue:phase7??null},{provide:RECEIVED,useValue:received},{provide:PHASE8,useValue:phase8??null}]};}
}
