import { Body, Catch, Controller, Get, HttpException, Inject, Module, Param, Patch, Post, Query, Req, Res, type ArgumentsHost, type DynamicModule, type ExceptionFilter } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import { B2bIdentity } from './service';
import { B2bIdentityError, fail, plain, scopes } from './model';
const CORE=Symbol('B2bIdentity'),PEERS=Symbol('B2b private peers');
export interface B2bPeers { token:string[]; admin:string[]; resource:string[] }
type Request={headers:Record<string,string|string[]|undefined>;socket:TLSSocket};
export function b2bPrivateContext(req:Request,peers:readonly string[]) {
  const fingerprint=req.socket.encrypted&&req.socket.authorized&&req.socket.getPeerCertificate().fingerprint256?.replace(/:/g,'').toLowerCase();
  if(!fingerprint||!peers.includes(fingerprint))return fail(403,'PRIVATE_PEER_REQUIRED');
  return {requestId:randomUUID(),peer:fingerprint+':'+req.socket.remoteAddress};
}
function bearer(req:Request) {
  const header=req.headers.authorization;
  if(typeof header!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(header))return fail(401,'INVALID_TOKEN');
  return header.slice(7);
}
export function b2bPrivateHeaders(res:any) {res.setHeader('Cache-Control','private, no-store');res.setHeader('Pragma','no-cache');res.setHeader('X-Content-Type-Options','nosniff');}
@Catch()
export class B2bErrorFilter implements ExceptionFilter {
  catch(error:unknown,host:ArgumentsHost) {
    const res=host.switchToHttp().getResponse();b2bPrivateHeaders(res);
    const status=error instanceof B2bIdentityError?error.status:error instanceof HttpException&&[400,404,413,415].includes(error.getStatus())?error.getStatus():503;
    const code=error instanceof B2bIdentityError?error.code:status<500?'INVALID_REQUEST':'IDENTITY_UNAVAILABLE';
    const tokenRoute=host.switchToHttp().getRequest().url?.split('?')[0]==='/b2b/oauth/token';
    if(status===401)res.setHeader('WWW-Authenticate',tokenRoute?'Basic realm="FactuEz B2B"':'Bearer');
    if(status===429)res.setHeader('Retry-After','60');
    const oauth:Record<string,string>={INVALID_CLIENT:'invalid_client',INVALID_SCOPE:'invalid_scope',INSUFFICIENT_SCOPE:'invalid_scope',UNSUPPORTED_GRANT:'unsupported_grant_type',RATE_LIMITED:'temporarily_unavailable'};
    res.status(status).json(tokenRoute?{error:oauth[code]??(status>=500?'temporarily_unavailable':'invalid_request')}:
      {schemaVersion:'factuez.b2b.v1',requestId:randomUUID(),code,message:code,retryable:status===503||status===429});
  }
}
@Controller('b2b/oauth')
export class B2bOAuthController {
  constructor(@Inject(CORE)private readonly core:B2bIdentity,@Inject(PEERS)private readonly peers:B2bPeers){}
  @Post('token') async token(@Req()req:Request,@Res()res:any,@Body()body:unknown){
    b2bPrivateHeaders(res);const ctx=b2bPrivateContext(req,this.peers.token);
    if(typeof req.headers['content-type']!=='string'||!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']))return fail(400,'INVALID_REQUEST');
    res.status(200).json(await this.core.token(req.headers.authorization,body,ctx));
  }
}
@Controller('internal/b2b')
export class B2bIdentityController {
  constructor(@Inject(CORE)private readonly core:B2bIdentity,@Inject(PEERS)private readonly peers:B2bPeers){}
  @Post('introspect') async introspect(@Req()req:Request,@Res()res:any,@Body()body:unknown){
    b2bPrivateHeaders(res);const ctx=b2bPrivateContext(req,this.peers.resource);
    if(!plain(body)||Object.keys(body).sort().join(',')!=='kind,requiredScopes'||!['SERVICE','USER'].includes(body.kind)||!Array.isArray(body.requiredScopes))return fail(400,'INVALID_REQUEST');
    res.status(200).json(await this.core.authenticate(bearer(req),body.requiredScopes.length?scopes(body.requiredScopes):[],ctx,body.kind));
  }
  @Get('jwks') jwks(@Req()req:Request,@Res()res:any){b2bPrivateHeaders(res);b2bPrivateContext(req,this.peers.resource);res.status(200).json(this.core.jwks());}
  @Post('clients') async create(@Req()req:Request,@Res()res:any,@Body()body:unknown){b2bPrivateHeaders(res);const ctx=b2bPrivateContext(req,this.peers.admin);res.status(201).json(await this.core.create(bearer(req),body,ctx));}
  @Get('clients') async list(@Req()req:Request,@Res()res:any,@Query()query:unknown){b2bPrivateHeaders(res);const ctx=b2bPrivateContext(req,this.peers.admin);res.status(200).json(await this.core.list(bearer(req),query,ctx));}
  /** Fixed POST-only owner RPC. Authority comes from the human bearer, never args or SERVICE claims. */
  @Post('integration-admin') async admin(@Req()req:Request,@Res()res:any,@Body()body:unknown){
    b2bPrivateHeaders(res);const ctx=b2bPrivateContext(req,this.peers.admin),token=bearer(req);
    if(!plain(body)||Object.keys(body).sort().join(',')!=='action,args'||!plain(body.args)||body.args.environment!=='BETA')return fail(400,'INVALID_REQUEST');
    const args=body.args,keys=Object.keys(args).sort().join(',');let result:unknown;
    switch(body.action){
      case 'LIST':result=await this.core.list(token,args,ctx);break;
      case 'READ':if(keys!=='environment,id')return fail(400,'INVALID_REQUEST');result=await this.core.read(token,args.id,ctx);break;
      case 'CREATE':if(keys!=='body,environment')return fail(400,'INVALID_REQUEST');result=await this.core.create(token,args.body,ctx);break;
      case 'UPDATE':case 'ROTATE':if(keys!=='body,environment,id')return fail(400,'INVALID_REQUEST');result=await this.core.change(token,args.id,args.body,ctx,body.action==='ROTATE');break;
      default:return fail(400,'INVALID_REQUEST');
    }
    res.status(200).json(result);
  }
  @Get('clients/:id') async read(@Req()req:Request,@Res()res:any,@Param('id')id:string){b2bPrivateHeaders(res);const ctx=b2bPrivateContext(req,this.peers.admin);res.status(200).json(await this.core.read(bearer(req),id,ctx));}
  @Patch('clients/:id') async update(@Req()req:Request,@Res()res:any,@Param('id')id:string,@Body()body:unknown){b2bPrivateHeaders(res);const ctx=b2bPrivateContext(req,this.peers.admin);res.status(200).json(await this.core.change(bearer(req),id,body,ctx));}
  @Post('clients/:id/rotate') async rotate(@Req()req:Request,@Res()res:any,@Param('id')id:string,@Body()body:unknown){b2bPrivateHeaders(res);const ctx=b2bPrivateContext(req,this.peers.admin);res.status(200).json(await this.core.change(bearer(req),id,body,ctx,true));}
}
@Module({})
export class B2bIdentityModule {
  static isolated(core:B2bIdentity,peers:B2bPeers):DynamicModule {
    if(Object.values(peers).some((list:string[])=>!list.length||list.length>100||new Set(list).size!==list.length||list.some(value=>!/^[a-f0-9]{64}$/.test(value))))throw new Error('Explicit B2B mTLS peers required');
    return {module:B2bIdentityModule,controllers:[B2bOAuthController,B2bIdentityController],providers:[{provide:CORE,useValue:core},{provide:PEERS,useValue:peers}]};
  }
}
