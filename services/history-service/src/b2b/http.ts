import {Catch,Controller,HttpException,Inject,Module,Post,Req,Res,UseFilters,type DynamicModule,type ArgumentsHost} from '@nestjs/common';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {historyJson} from '@factuez/history-core';
import type {B2bHistoryReads} from './reader';
const CORE=Symbol('History B2B owner'),PEERS=Symbol('History B2B peers');
@Catch()export class B2bHistoryOwnerFilter{catch(e:unknown,h:ArgumentsHost){const n=e instanceof B2bSecurityError?e.status:e instanceof HttpException?e.getStatus():503,status=[400,401,403,404,409,413,422,429].includes(n)?n:503;const s=h.switchToHttp().getResponse();s.setHeader('Cache-Control','private, no-store');s.status(status).json({code:status===503?'HISTORY_UNAVAILABLE':'HISTORY_REQUEST_DENIED'});}}
@Controller('internal/b2b')
@UseFilters(B2bHistoryOwnerFilter)
export class B2bHistoryOwnerController{
 constructor(@Inject(CORE)private readonly core:B2bHistoryReads,@Inject(PEERS)private readonly peers:readonly string[]){}
 @Post('history-read')async execute(@Req()r:any,@Res()s:any){
  s.setHeader('Cache-Control','private, no-store');s.setHeader('X-Content-Type-Options','nosniff');
  const fp=r.socket.encrypted&&r.socket.authorized&&r.socket.getPeerCertificate().fingerprint256?.replace(/:/g,'').toLowerCase();if(!fp||!this.peers.includes(fp))throw new B2bSecurityError(403,'PRIVATE_PEER_REQUIRED');
  const ns=(r.rawHeaders??[]).filter((_v:any,i:number)=>i%2===0).map((n:string)=>n.toLowerCase()),a=r.headers.authorization,b:any=historyJson(r.body);
  if(new Set(ns).size!==ns.length||typeof a!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(a))throw new B2bSecurityError(401,'INVALID_TOKEN');
  if(r.url.includes('?')||!b||Object.keys(b).sort().join(',')!=='action,input,kind'||!['SERVICE','USER'].includes(b.kind)||!['LIST','DETAIL','CONTENT'].includes(b.action))throw new B2bSecurityError(400,'INVALID_REQUEST');
  const v:any=await this.core.execute({token:a.slice(7),kind:b.kind},b.action,b.input);if(b.action!=='CONTENT')return s.status(200).json(v);
  const ext=v.mediaType==='application/pdf'?'pdf':v.mediaType==='application/zip'?'zip':'xml';s.setHeader('Content-Type',v.mediaType);s.setHeader('Content-Length',String(v.bytes.length));s.setHeader('X-Content-Sha256',v.sha256);s.setHeader('Content-Disposition',`attachment; filename="history-original.${ext}"`);s.setHeader('X-FactuEz-Original-Filename',encodeURIComponent(v.fileName));return s.status(200).send(v.bytes);
 }
}
@Module({})
export class B2bHistoryOwnerModule{static isolated(core:B2bHistoryReads,peers:readonly string[]):DynamicModule{if(!core||typeof core.execute!=='function'||!peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw new Error('EXPLICIT_HISTORY_OWNER_REQUIRED');return {module:B2bHistoryOwnerModule,controllers:[B2bHistoryOwnerController],providers:[B2bHistoryOwnerFilter,{provide:CORE,useValue:core},{provide:PEERS,useValue:[...peers]}]};}}
