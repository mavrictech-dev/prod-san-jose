import { Body, Catch, Controller, Inject, Module, Post, Req, Res, type ArgumentsHost, type DynamicModule, type ExceptionFilter, HttpException } from '@nestjs/common';
import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { b2bPrivatePeer,newB2bRequestId } from '@factuez/service-access/dist/b2b';
import { B2bContextService } from './context';
const CORE=Symbol('Billing B2B context'),PEERS=Symbol('Billing B2B peers');
interface Peers { context:string[]; registrar:string[] }
@Catch()
export class B2bContextFilter implements ExceptionFilter {
  catch(error:unknown,host:ArgumentsHost){const res=host.switchToHttp().getResponse();
    const status=error instanceof B2bSecurityError?error.status:error instanceof HttpException&&[400,404,413].includes(error.getStatus())?error.getStatus():503;
    const code=error instanceof B2bSecurityError?error.code:status<500?'INVALID_REQUEST':'OWNER_UNAVAILABLE';
    res.setHeader('Cache-Control','private, no-store');res.status(status).json({schemaVersion:'factuez.b2b.v1',requestId:newB2bRequestId(),code,message:code,retryable:status===503||status===429});}
}
@Controller('internal/b2b')
export class B2bContextController {
  constructor(@Inject(CORE)private readonly core:B2bContextService,@Inject(PEERS)private readonly peers:Peers){}
  @Post('context')async context(@Req()req:any,@Res()res:any,@Body()body:unknown){
    b2bPrivatePeer(req,this.peers.context);res.setHeader('Cache-Control','private, no-store');
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='binding,kind')throw new B2bSecurityError(400,'INVALID_REQUEST');
    const header=req.headers.authorization;if(typeof header!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(header))throw new B2bSecurityError(401,'INVALID_TOKEN');
    res.status(200).json(await this.core.resolve(header.slice(7),(body as any).binding,(body as any).kind));
  }
  @Post('validate-bindings')async validate(@Req()req:any,@Res()res:any,@Body()body:unknown){
    b2bPrivatePeer(req,this.peers.registrar);res.setHeader('Cache-Control','private, no-store');
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).join(',')!=='bindings')throw new B2bSecurityError(400,'INVALID_REQUEST');
    res.status(200).json(await this.core.validate((body as any).bindings));
  }
}
@Module({})
export class B2bContextModule {
  static isolated(core:B2bContextService,peers:Peers):DynamicModule{
    if(Object.values(peers).some((list:string[])=>!list.length||list.length>100||list.some(value=>!/^[a-f0-9]{64}$/.test(value))))throw new Error('Explicit Billing B2B peers required');
    return {module:B2bContextModule,controllers:[B2bContextController],providers:[{provide:CORE,useValue:core},{provide:PEERS,useValue:peers}]};
  }
}
