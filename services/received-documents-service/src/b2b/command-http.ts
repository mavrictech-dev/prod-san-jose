import {Controller,Inject,Module,Post,Req,Res,UseFilters,type DynamicModule} from '@nestjs/common';
import {b2bPrivatePeer} from '@factuez/service-access/dist/b2b';
import {correctionEvidenceFreeze} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import {receivedFail} from '@factuez/service-access/dist/b2b-received-wire';
import type {B2bReceptionCommands} from './commands';
import {B2bReceptionHttpFilter} from './http';
const CORE=Symbol('Reception command owner'),PEERS=Symbol('Command peers');
@Controller('internal/b2b')
@UseFilters(B2bReceptionHttpFilter)
export class B2bReceptionCommandController{
  constructor(@Inject(CORE)private readonly core:B2bReceptionCommands,@Inject(PEERS)private readonly peers:readonly string[]){}
  @Post('received-command')async execute(@Req()req:any,@Res()res:any){
    res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');b2bPrivatePeer(req,this.peers);
    const names=(req.rawHeaders??[]).filter((_v:any,i:number)=>i%2===0).map((n:string)=>n.toLowerCase()),a=req.headers.authorization;
    if(new Set(names).size!==names.length||typeof a!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(a)||names.filter((n:string)=>n==='authorization').length!==1)receivedFail(401,'INVALID_TOKEN');
    if(req.url.includes('?'))receivedFail();const b:any=correctionEvidenceFreeze(req.body);
    if(!b||Object.keys(b).sort().join(',')!=='action,input,kind'||!['SERVICE','USER'].includes(b.kind)||!['IMPORT','ATTACH','ASSIGN','REGISTER'].includes(b.action))receivedFail();
    return res.status(200).json(await this.core.execute({token:a.slice(7),kind:b.kind},b.action,b.input));
  }
}
@Module({})
export class B2bReceptionCommandModule{
  static isolated(core:B2bReceptionCommands,peers:readonly string[]):DynamicModule{
    if(!core||typeof core.execute!=='function'||!peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw new Error('EXPLICIT_RECEPTION_COMMANDS_REQUIRED');
    return {module:B2bReceptionCommandModule,controllers:[B2bReceptionCommandController],providers:[B2bReceptionHttpFilter,{provide:CORE,useValue:core},{provide:PEERS,useValue:[...peers]}]};
  }
}
