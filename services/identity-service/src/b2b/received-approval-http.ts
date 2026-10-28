import {Body,Catch,Controller,Inject,Module,Post,Req,Res,UseFilters,type ArgumentsHost,type DynamicModule} from '@nestjs/common';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {b2bPrivateContext,b2bPrivateHeaders} from './http';
import {ReceivedApprovalAuthority} from './received-approval-core';
import {denied} from './received-approval-model';
const CORE=Symbol('Received approval core'),PEERS=Symbol('Received approval peers');
export interface ReceivedApprovalPeers {prepare:readonly string[];verify:readonly string[]}
@Catch()
class ReceivedApprovalFilter {
 catch(error:unknown,host:ArgumentsHost){const s=host.switchToHttp().getResponse(),status=error instanceof B2bSecurityError&&[400,401,403,429,503].includes(error.status)?error.status:503;
  b2bPrivateHeaders(s);s.status(status).json({code:status===503?'RECEIVED_APPROVAL_UNAVAILABLE':'RECEIVED_STEP_UP_DENIED'});}
}
@Controller('internal/b2b/received-stepup')
@UseFilters(ReceivedApprovalFilter)
class ReceivedApprovalController {
 constructor(@Inject(CORE)private readonly core:ReceivedApprovalAuthority,@Inject(PEERS)private readonly peers:ReceivedApprovalPeers){}
 private request(req:any,peers:readonly string[]){const context=b2bPrivateContext(req,peers),names=(req.rawHeaders??[]).filter((_v:any,i:number)=>i%2===0).map((v:string)=>v.toLowerCase());
  if(req.url.includes('?')||new Set(names).size!==names.length||req.headers['transfer-encoding']||req.headers['content-encoding']||
   !/^application\/json(?:;|$)/.test(req.headers['content-type']??'')||!(/^[1-9][0-9]{0,4}$/).test(req.headers['content-length']??'')||Number(req.headers['content-length'])>32768)throw denied();return context;}
 @Post('prepare')async prepare(@Req()req:any,@Res()res:any,@Body()body:unknown){b2bPrivateHeaders(res);const context=this.request(req,this.peers.prepare),header=req.headers.authorization;
  if(typeof header!=='string'||!/^Bearer [A-Za-z0-9._~-]{16,8192}$/.test(header))throw denied();return res.status(200).json(await this.core.prepare(header.slice(7),body,context));}
 @Post('verify')async verify(@Req()req:any,@Res()res:any,@Body()body:unknown){b2bPrivateHeaders(res);const context=this.request(req,this.peers.verify);if(req.headers.authorization)throw denied();return res.status(200).json(await this.core.verify(body,context));}
}
@Module({})
export class ReceivedApprovalModule {
 static isolated(core:ReceivedApprovalAuthority,options:{enabled?:boolean;peers?:ReceivedApprovalPeers}={}):DynamicModule {
  if(options.enabled!==true)return {module:ReceivedApprovalModule};
  const p=options.peers;
  if(!(core instanceof ReceivedApprovalAuthority)||!p||Object.keys(p).sort().join(',')!=='prepare,verify'||Object.values(p).some(v=>!Array.isArray(v)||!v.length||v.length>32||new Set(v).size!==v.length||v.some(k=>typeof k!=='string'||!/^[a-f0-9]{64}$/.test(k)))||p.prepare.some(v=>p.verify.includes(v)))throw Error('EXPLICIT_RECEIVED_APPROVAL_PEERS_REQUIRED');
  return {module:ReceivedApprovalModule,controllers:[ReceivedApprovalController],providers:[ReceivedApprovalFilter,{provide:CORE,useValue:core},{provide:PEERS,useValue:{prepare:[...p.prepare],verify:[...p.verify]}}]};
 }
}
