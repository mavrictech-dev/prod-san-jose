import { Body,Controller,Inject,Module,Post,Req,Res,type DynamicModule } from '@nestjs/common';
import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { b2bPrivatePeer } from '@factuez/service-access/dist/b2b';
import { B2bExtraction } from './core';
const CORE=Symbol('B2B extraction'),PEERS=Symbol('B2B extraction peers');
@Controller('internal/b2b')
export class B2bExtractionOwnerController {
  constructor(@Inject(CORE)private readonly core:B2bExtraction,@Inject(PEERS)private readonly peers:string[]){}
  @Post('exports')async call(@Req()req:any,@Res()res:any,@Body()b:any){
    b2bPrivatePeer(req,this.peers);res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
    if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).sort().join(',')!=='action,args,kind'||!['SERVICE','USER'].includes(b.kind))throw new B2bSecurityError(400,'INVALID_REQUEST');
    const auth=req.headers.authorization;if(typeof auth!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(auth))throw new B2bSecurityError(401,'INVALID_TOKEN');
    const result=await this.core.execute(auth.slice(7),b.kind,b.action,b.args);
    if(b.action==='content'){
      const f=result as any;if(!/^factuez-export-[a-f0-9-]{36}\.zip$/.test(f.fileName)||f.mediaType!=='application/zip')throw new B2bSecurityError(409,'INTEGRITY_FAILED');
      res.setHeader('Content-Type',f.mediaType);res.setHeader('Content-Length',f.bytes.length);res.setHeader('X-Content-SHA256',f.sha256);res.setHeader('Content-Disposition',`attachment; filename="${f.fileName}"`);res.status(200).end(f.bytes);
    }else res.status(200).json(result);
  }
}
@Module({})
export class B2bExtractionOwnerModule {
  static isolated(core:B2bExtraction,peers:string[]):DynamicModule{if(!peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw new Error('Explicit extraction peers required');
    return {module:B2bExtractionOwnerModule,controllers:[B2bExtractionOwnerController],providers:[{provide:CORE,useValue:core},{provide:PEERS,useValue:peers}]};}
}
