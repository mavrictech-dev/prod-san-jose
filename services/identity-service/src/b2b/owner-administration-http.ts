import {Body,Controller,Inject,Module,Post,Req,Res,type DynamicModule} from '@nestjs/common';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {b2bPrivatePeer} from '@factuez/service-access/dist/b2b';
import {B2bOwnerAdministration} from './owner-administration';
const CORE=Symbol('Real owner administration authority');
@Controller('internal/b2b/owner-authority')
class B2bOwnerAdministrationController {
 constructor(@Inject(CORE)private readonly core:B2bOwnerAdministration){}
 private boundary(req:any){
  const peer=b2bPrivatePeer(req,this.core.peers()),names=req.rawHeaders.filter((_v:any,i:number)=>i%2===0).map((v:string)=>v.toLowerCase());
  if(req.url.includes('?')||new Set(names).size!==names.length||req.headers['transfer-encoding']||!/^[1-9]\d{0,4}$/.test(req.headers['content-length']??'')||
   Number(req.headers['content-length'])>16384||!/^application\/json(?:;|$)/.test(req.headers['content-type']??''))throw new B2bSecurityError(400,'INVALID_OWNER_AUTHORITY_REQUEST');return peer;
 }
 @Post('authorize')async authorize(@Req()req:any,@Res()res:any,@Body()body:unknown){
  const peer=this.boundary(req),auth=req.headers.authorization;if(typeof auth!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(auth))throw new B2bSecurityError(401,'INVALID_TOKEN');
  res.setHeader('Cache-Control','private, no-store');return res.status(200).json(await this.core.authorize(peer,auth.slice(7),body));
 }
 @Post('live-human')async live(@Req()req:any,@Res()res:any,@Body()body:unknown){
  const peer=this.boundary(req);if(req.headers.authorization)throw new B2bSecurityError(400,'INVALID_OWNER_AUTHORITY_REQUEST');
  res.setHeader('Cache-Control','private, no-store');return res.status(200).json(await this.core.liveHuman(peer,body));
 }
 @Post('status')status(@Req()req:any,@Res()res:any,@Body()body:any){
  const peer=this.boundary(req);if(req.headers.authorization||!body||Object.keys(body).length)throw new B2bSecurityError(400,'INVALID_OWNER_AUTHORITY_REQUEST');
  res.setHeader('Cache-Control','private, no-store');return res.status(200).json(this.core.status(peer));
 }
}
@Module({})
export class B2bOwnerAdministrationModule {
 static isolated(core:B2bOwnerAdministration):DynamicModule {
  return {module:B2bOwnerAdministrationModule,controllers:[B2bOwnerAdministrationController],providers:[{provide:CORE,useValue:core}]};
 }
}
