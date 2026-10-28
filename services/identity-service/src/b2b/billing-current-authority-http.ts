import {Catch,Controller,Inject,Module,Post,Req,Res,UseFilters,type ArgumentsHost,type DynamicModule} from '@nestjs/common';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {b2bPrivatePeer} from '@factuez/service-access/dist/b2b';
import {B2bBillingCurrentAuthority} from './billing-current-authority';
const CORE=Symbol('Billing current authority'),PEERS=Symbol('Dedicated Billing permission peers');
@Catch()
class BillingCurrentAuthorityFilter {
 catch(e:unknown,h:ArgumentsHost){const status=e instanceof B2bSecurityError&&[400,401,403,429].includes(e.status)?e.status:503,res=h.switchToHttp().getResponse();
  res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');res.status(status).json({code:'BILLING_CURRENT_AUTHORITY_REQUIRED'});}
}
@Controller('internal/b2b')
@UseFilters(BillingCurrentAuthorityFilter)
export class B2bBillingCurrentAuthorityController {
 constructor(@Inject(CORE)private readonly core:B2bBillingCurrentAuthority,@Inject(PEERS)private readonly peers:readonly string[]){}
 @Post('billing-authority')async execute(@Req()req:any,@Res()res:any){
  const peer=b2bPrivatePeer(req,this.peers),names=(req.rawHeaders??[]).filter((_v:any,i:number)=>i%2===0).map((v:string)=>v.toLowerCase()),header=req.headers.authorization;
  if(new Set(names).size!==names.length||req.url.includes('?')||req.headers['transfer-encoding']||req.headers['content-encoding']||
   !/^application\/json(?:;|$)/i.test(req.headers['content-type']??'')||!(/^[1-9][0-9]{0,4}$/).test(req.headers['content-length']??'')||Number(req.headers['content-length'])>16384||
   header!==undefined&&(typeof header!=='string'||!/^Bearer [A-Za-z0-9._~-]{16,8192}$/.test(header)))throw new B2bSecurityError(400,'INVALID_REQUEST');
  res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');return res.status(200).json(await this.core.execute(req.body,header?.slice(7),peer));
 }
}
@Module({})
export class B2bBillingCurrentAuthorityModule {
 static isolated(core:B2bBillingCurrentAuthority,peers:readonly string[]):DynamicModule{
  if(!(core instanceof B2bBillingCurrentAuthority)||!Array.isArray(peers)||!peers.length||peers.length>32||new Set(peers).size!==peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw Error('EXPLICIT_BILLING_AUTHORITY_PEERS_REQUIRED');
  return {module:B2bBillingCurrentAuthorityModule,controllers:[B2bBillingCurrentAuthorityController],providers:[BillingCurrentAuthorityFilter,{provide:CORE,useValue:core},{provide:PEERS,useValue:Object.freeze([...peers])}]};
 }
}
