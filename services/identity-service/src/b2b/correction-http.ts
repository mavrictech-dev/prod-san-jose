import { Body, Controller, Get, Inject, Module, Param, Post, Req, Res, type DynamicModule } from '@nestjs/common';
import { B2bCorrectionAuthority } from './correction-authority';
import { b2bPrivateContext, b2bPrivateHeaders } from './http';
import { fail } from './model';
const CORE=Symbol('B2B paired correction authority'),PEERS=Symbol('B2B paired correction peers');
interface Peers { admin:string[]; owner:string[] }
function bearer(req:any) {
  if (typeof req.headers.authorization!=='string' || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(req.headers.authorization)) return fail(401,'INVALID_TOKEN');
  return req.headers.authorization.slice(7);
}
@Controller('internal/b2b')
export class B2bCorrectionAuthorityController {
  constructor(@Inject(CORE) private readonly core:B2bCorrectionAuthority,@Inject(PEERS) private readonly peers:Peers) {}
  @Get('clients/:id/correction-grants') async read(@Req()req:any,@Res()res:any,@Param('id')id:string) {
    b2bPrivateHeaders(res);const ctx=b2bPrivateContext(req,this.peers.admin);
    res.status(200).json(await this.core.read(bearer(req),id,ctx));
  }
  @Post('clients/:id/correction-grants') async replace(@Req()req:any,@Res()res:any,@Param('id')id:string,@Body()body:unknown) {
    b2bPrivateHeaders(res);const ctx=b2bPrivateContext(req,this.peers.admin);
    res.status(200).json(await this.core.replace(bearer(req),id,body,ctx));
  }
  @Post('authorize-correction') async authorize(@Req()req:any,@Res()res:any,@Body()body:unknown) {
    b2bPrivateHeaders(res);const ctx=b2bPrivateContext(req,this.peers.owner);
    res.status(200).json(await this.core.authorize(bearer(req),body,ctx));
  }
}
@Module({})
export class B2bCorrectionAuthorityModule {
  static isolated(core:B2bCorrectionAuthority,peers:Peers):DynamicModule {
    if (Object.keys(peers).sort().join(',')!=='admin,owner' || Object.values(peers).some((ids:string[])=>!ids.length||ids.length>100||new Set(ids).size!==ids.length||ids.some(id=>!/^[a-f0-9]{64}$/.test(id)))) throw new Error('Explicit correction authority mTLS peers required');
    if (peers.admin.some(id=>peers.owner.includes(id))) throw new Error('Separate correction enrollment and owner peers required');
    return {module:B2bCorrectionAuthorityModule,controllers:[B2bCorrectionAuthorityController],providers:[{provide:CORE,useValue:core},{provide:PEERS,useValue:peers}]};
  }
}
