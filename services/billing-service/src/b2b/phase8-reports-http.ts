import {Catch,Controller,Inject,Module,Post,Req,Res,UseFilters,type DynamicModule,type ArgumentsHost} from '@nestjs/common';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {b2bPrivatePeer} from '@factuez/service-access/dist/b2b';
import {correctionEvidenceFreeze} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import type {B2bReports} from './phase8-reports/engine';
import {Phase8OwnerErrorFilter} from './phase8-business-http';
const CORE=Symbol('Reports owner'),PEERS=Symbol('Reports owner peers');
/** Report-only expiry; the shared business filter keeps its existing policy. */
@Catch()
export class Phase8ReportsOwnerErrorFilter extends Phase8OwnerErrorFilter {
 override catch(error:unknown,host:ArgumentsHost){
  if(error instanceof B2bSecurityError&&error.status===410&&error.code==='ARTIFACT_NOT_AVAILABLE'){
   const response=host.switchToHttp().getResponse();response.setHeader('Cache-Control','private, no-store');
   return response.status(410).json({code:'ARTIFACT_NOT_AVAILABLE'});
  }
  return super.catch(error,host);
 }
}
@Controller('internal/b2b')
@UseFilters(Phase8ReportsOwnerErrorFilter)
export class B2bPhase8ReportsOwnerController{
 constructor(@Inject(CORE)private readonly core:B2bReports,@Inject(PEERS)private readonly peers:readonly string[]){}
 @Post('phase8-reports')async execute(@Req()r:any,@Res()s:any){
  s.setHeader('Cache-Control','private, no-store');s.setHeader('X-Content-Type-Options','nosniff');b2bPrivatePeer(r,this.peers);
  const ns=(r.rawHeaders??[]).filter((_v:any,i:number)=>i%2===0).map((n:string)=>n.toLowerCase()),a=r.headers.authorization,b:any=correctionEvidenceFreeze(r.body);
  if(new Set(ns).size!==ns.length||typeof a!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(a))throw new B2bSecurityError(401,'INVALID_TOKEN');
  if(r.url.includes('?')||!b||Object.keys(b).sort().join(',')!=='action,input,kind'||!['SERVICE','USER'].includes(b.kind)||!['DASHBOARD','CREATE','READ','CONTENT'].includes(b.action))throw new B2bSecurityError(400,'INVALID_REQUEST');
  const result:any=await this.core.execute({token:a.slice(7),kind:b.kind},b.action,b.input);
  if(b.action!=='CONTENT')return s.status(200).json(result);
  s.setHeader('Content-Type',result.mediaType);s.setHeader('Content-Length',String(result.bytes.length));s.setHeader('Content-Disposition',`attachment; filename="${result.fileName}"`);s.setHeader('X-Content-Sha256',result.sha256);return s.status(200).send(result.bytes);
 }
}
@Module({})
export class B2bPhase8ReportsOwnerModule{static isolated(core:B2bReports,peers:readonly string[]):DynamicModule{if(!core||typeof core.execute!=='function'||!peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw new Error('EXPLICIT_REPORT_OWNER_REQUIRED');return {module:B2bPhase8ReportsOwnerModule,controllers:[B2bPhase8ReportsOwnerController],providers:[Phase8ReportsOwnerErrorFilter,{provide:CORE,useValue:core},{provide:PEERS,useValue:[...peers]}]};}}
