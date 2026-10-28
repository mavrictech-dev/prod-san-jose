import { Body,Controller,Inject,Module,Post,Req,Res,type DynamicModule } from '@nestjs/common';
import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { b2bPrivatePeer } from '@factuez/service-access/dist/b2b';
import { B2bSunatReads } from './read';
const CORE=Symbol('SUNAT B2B reads'),PEERS=Symbol('SUNAT B2B read peers');
@Controller('internal/b2b')
export class B2bSunatReadController {
  constructor(@Inject(CORE)private readonly core:B2bSunatReads,@Inject(PEERS)private readonly peers:string[]){}
  @Post('fiscal-read')async read(@Req()req:any,@Res()res:any,@Body()body:unknown){
    b2bPrivatePeer(req,this.peers);res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='action,args,kind'||!['SERVICE','USER'].includes((body as any).kind))throw new B2bSecurityError(400,'INVALID_REQUEST');
    const authorization=req.headers.authorization;if(typeof authorization!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(authorization))throw new B2bSecurityError(401,'INVALID_TOKEN');
    const {action,args,kind}=body as any,result=await this.core.execute(authorization.slice(7),kind,action,args);
    if(action==='content'||action==='pdf'){
      const file=result as any;if(!/^[A-Za-z0-9_-]{1,150}\.(xml|zip|pdf)$/.test(file.fileName))throw new B2bSecurityError(409,'INVALID_FILE_METADATA');
      res.setHeader('Content-Type',file.mediaType);res.setHeader('Content-Length',file.bytes.length);res.setHeader('X-Content-SHA256',file.sha256);
      res.setHeader('Content-Disposition',`attachment; filename="${file.fileName}"`);res.status(200).end(file.bytes);
    }else res.status(200).json(result);
  }
}
@Module({})
export class B2bSunatReadModule {
  static isolated(core:B2bSunatReads,peers:string[]):DynamicModule{
    if(!peers.length||peers.some(peer=>!/^[a-f0-9]{64}$/.test(peer)))throw new Error('SUNAT B2B peers required');
    return {module:B2bSunatReadModule,controllers:[B2bSunatReadController],providers:[{provide:CORE,useValue:core},{provide:PEERS,useValue:peers}]};
  }
}
