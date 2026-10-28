import {Catch,Controller,HttpException,Inject,Module,Post,Req,Res,UseFilters,type ArgumentsHost,type DynamicModule} from '@nestjs/common';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {b2bPrivatePeer} from '@factuez/service-access/dist/b2b';
import {correctionEvidenceFreeze} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import {B2bReceptionReads} from './read';
const CORE=Symbol('Reception B2B owner'),PEERS=Symbol('Reception B2B peers');
@Catch()
export class B2bReceptionHttpFilter{
  catch(error:unknown,host:ArgumentsHost){
    const status=error instanceof B2bSecurityError&&[400,401,403,404,409,413,429].includes(error.status)?error.status:error instanceof HttpException&&[400,404,413,415].includes(error.getStatus())?error.getStatus():503;
    const codes:Record<number,string>={400:'INVALID_RECEIVED_REQUEST',401:'INVALID_TOKEN',403:'RECEIVED_ACCESS_DENIED',404:'RESOURCE_NOT_FOUND',409:'RECEIVED_INTEGRITY_CONFLICT',413:'NARROW_QUERY',429:'RATE_LIMITED',503:'RECEIVED_OWNER_UNAVAILABLE'};
    const res=host.switchToHttp().getResponse();res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');return res.status(status).json({code:codes[status]??'INVALID_RECEIVED_REQUEST'});
  }
}
@Controller('internal/b2b')
@UseFilters(B2bReceptionHttpFilter)
export class B2bReceptionReadController{
  constructor(@Inject(CORE)private readonly core:B2bReceptionReads,@Inject(PEERS)private readonly peers:readonly string[]){}
  @Post('received-read')
  async read(@Req()req:any,@Res()res:any){
    res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');b2bPrivatePeer(req,this.peers);
    const names:string[]=(req.rawHeaders??[]).filter((_v:string,i:number)=>i%2===0).map((n:string)=>n.toLowerCase()),auth=req.headers.authorization;
    if(typeof auth!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(auth)||names.filter(n=>n==='authorization').length!==1)throw new B2bSecurityError(401,'INVALID_TOKEN');
    if(new Set(names).size!==names.length||req.url.includes('?')||Object.keys(req.query??{}).length)throw new B2bSecurityError(400,'INVALID_RECEIVED_REQUEST');
    const b:any=correctionEvidenceFreeze(req.body);
    if(!b||Object.keys(b).sort().join(',')!=='action,args,kind'||Buffer.byteLength(JSON.stringify(b))>16384||!['SERVICE','USER'].includes(b.kind)||!['LIST','DETAIL','ARTIFACTS','CONTENT'].includes(b.action))throw new B2bSecurityError(400,'INVALID_RECEIVED_REQUEST');
    const result:any=await this.core.execute({token:auth.slice(7),kind:b.kind},b.action,b.args);
    if(b.action!=='CONTENT')return res.status(200).json(result);
    const extension=result.mediaType==='application/pdf'?'pdf':result.mediaType==='application/zip'?'zip':'xml';
    res.setHeader('Content-Type',result.mediaType);res.setHeader('Content-Length',String(result.bytes.length));res.setHeader('X-Content-Sha256',result.sha256);
    res.setHeader('Content-Disposition',`attachment; filename="received-original.${extension}"`);
    res.setHeader('X-FactuEz-Original-Filename',encodeURIComponent(result.fileName));res.setHeader('X-FactuEz-Source','RECEIVED_ORIGINAL');return res.status(200).send(result.bytes);
  }
}
@Module({})
export class B2bReceptionReadModule{
  static isolated(core:B2bReceptionReads,peers:readonly string[]):DynamicModule{
    if(!core||typeof core.execute!=='function'||!Array.isArray(peers)||!peers.length||peers.length>100||new Set(peers).size!==peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw new Error('EXPLICIT_RECEIVED_OWNER_AND_PEERS_REQUIRED');
    return {module:B2bReceptionReadModule,controllers:[B2bReceptionReadController],providers:[B2bReceptionHttpFilter,{provide:CORE,useValue:core},{provide:PEERS,useValue:Object.freeze([...peers])}]};
  }
}
