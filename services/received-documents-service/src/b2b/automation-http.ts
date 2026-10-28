import {Controller,Inject,Module,Post,Req,Res,UseFilters,type DynamicModule} from '@nestjs/common';
import {b2bPrivatePeer} from '@factuez/service-access/dist/b2b';
import {correctionEvidenceFreeze} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import {receivedFail} from '@factuez/service-access/dist/b2b-received-wire';
import {B2bReceptionHttpFilter} from './http';
import type {B2bReceptionAutomation} from './automation';
const CORE=Symbol('Automation owner'),PEERS=Symbol('Automation owner peers');
@Controller('internal/b2b')
@UseFilters(B2bReceptionHttpFilter)
export class B2bReceptionAutomationOwnerController{
 constructor(@Inject(CORE)private readonly core:B2bReceptionAutomation,@Inject(PEERS)private readonly peers:readonly string[]){}
 @Post('received-automation')async execute(@Req()r:any,@Res()s:any){
  s.setHeader('Cache-Control','private, no-store');s.setHeader('X-Content-Type-Options','nosniff');b2bPrivatePeer(r,this.peers);
  const ns=(r.rawHeaders??[]).filter((_v:any,i:number)=>i%2===0).map((n:string)=>n.toLowerCase()),a=r.headers.authorization,b:any=correctionEvidenceFreeze(r.body);
  if(new Set(ns).size!==ns.length||typeof a!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(a))receivedFail(401,'INVALID_TOKEN');
  if(r.url.includes('?')||!b||Object.keys(b).sort().join(',')!=='action,input,kind'||!['SERVICE','USER'].includes(b.kind)||!['CONFIG_READ','CONFIG_SAVE','SYNC_CREATE','SYNC_READ'].includes(b.action))receivedFail();
  return s.status(200).json(await this.core.execute({token:a.slice(7),kind:b.kind},b.action,b.input));
 }
}
@Module({})
export class B2bReceptionAutomationOwnerModule{static isolated(core:B2bReceptionAutomation,peers:readonly string[]):DynamicModule{if(!core||typeof core.execute!=='function'||!peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw new Error('EXPLICIT_AUTOMATION_OWNER_REQUIRED');return {module:B2bReceptionAutomationOwnerModule,controllers:[B2bReceptionAutomationOwnerController],providers:[B2bReceptionHttpFilter,{provide:CORE,useValue:core},{provide:PEERS,useValue:[...peers]}]};}}
