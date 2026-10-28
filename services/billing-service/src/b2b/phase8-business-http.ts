import {Controller,Inject,Module,Post,Req,Res,UseFilters,type DynamicModule,Catch,type ArgumentsHost,HttpException} from '@nestjs/common';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {b2bPrivatePeer} from '@factuez/service-access/dist/b2b';
import {correctionEvidenceFreeze} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import type {BusinessExecutor} from './phase8-business/types';
const CORE=Symbol('Business owner'),PEERS=Symbol('Business owner peers');
@Catch()
export class Phase8OwnerErrorFilter{
  catch(e:unknown,h:ArgumentsHost){const n=e instanceof B2bSecurityError?e.status:e instanceof HttpException?e.getStatus():503,status=[400,401,403,404,409,413,422,429].includes(n)?n:503;const s=h.switchToHttp().getResponse();s.setHeader('Cache-Control','private, no-store');s.status(status).json({code:status===503?'OWNER_UNAVAILABLE':'OWNER_REQUEST_DENIED'});}
}
@Controller('internal/b2b')
@UseFilters(Phase8OwnerErrorFilter)
export class B2bPhase8BusinessOwnerController{
 constructor(@Inject(CORE)private readonly core:BusinessExecutor,@Inject(PEERS)private readonly peers:readonly string[]){}
 @Post('phase8-business')async execute(@Req()r:any,@Res()s:any){
  s.setHeader('Cache-Control','private, no-store');s.setHeader('X-Content-Type-Options','nosniff');b2bPrivatePeer(r,this.peers);
  const ns=(r.rawHeaders??[]).filter((_v:any,i:number)=>i%2===0).map((v:string)=>v.toLowerCase()),a=r.headers.authorization,b:any=correctionEvidenceFreeze(r.body);
  if(new Set(ns).size!==ns.length||typeof a!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(a))throw new B2bSecurityError(401,'INVALID_TOKEN');
  if(r.url.includes('?')||!b||Object.keys(b).sort().join(',')!=='action,input,kind'||!['SERVICE','USER'].includes(b.kind)||typeof b.action!=='string')throw new B2bSecurityError(400,'INVALID_REQUEST');
  return s.status(200).json(await this.core.execute({token:a.slice(7),kind:b.kind},b.action,b.input));
 }
}
@Module({})
export class B2bPhase8BusinessOwnerModule{
 static isolated(core:BusinessExecutor,peers:readonly string[]):DynamicModule{
  if(!core||typeof core.execute!=='function'||!peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw new Error('EXPLICIT_BUSINESS_OWNER_REQUIRED');
  return {module:B2bPhase8BusinessOwnerModule,controllers:[B2bPhase8BusinessOwnerController],providers:[Phase8OwnerErrorFilter,{provide:CORE,useValue:core},{provide:PEERS,useValue:[...peers]}]};
 }
}
