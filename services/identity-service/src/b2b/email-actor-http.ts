import {Catch,Controller,Inject,Module,Post,Req,Res,UseFilters,type ArgumentsHost,type DynamicModule} from '@nestjs/common';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {b2bPrivatePeer} from '@factuez/service-access/dist/b2b';
import {B2bQueuedEmailActor} from './email-actor';
const CORE=Symbol('Queued mail actor'),PEERS=Symbol('Dedicated mail worker peers');
@Catch()
class EmailActorFilter {
 catch(e:unknown,h:ArgumentsHost){const status=e instanceof B2bSecurityError&&[400,401,403].includes(e.status)?e.status:503,s=h.switchToHttp().getResponse();
  s.setHeader('Cache-Control','private, no-store');s.setHeader('X-Content-Type-Options','nosniff');s.status(status).json({code:'EMAIL_ACTOR_DENIED'});}
}
@Controller('internal/b2b')
@UseFilters(EmailActorFilter)
export class B2bQueuedEmailActorController {
 constructor(@Inject(CORE)private readonly core:B2bQueuedEmailActor,@Inject(PEERS)private readonly peers:readonly string[]){}
 @Post('authorize-email-actor')async check(@Req()req:any,@Res()res:any){
  const peer=b2bPrivatePeer(req,this.peers),names=(req.rawHeaders??[]).filter((_v:any,i:number)=>i%2===0).map((v:string)=>v.toLowerCase());
  if(new Set(names).size!==names.length||req.url.includes('?')||req.headers.authorization||req.headers['transfer-encoding']||req.headers['content-encoding']||
   !/^application\/json(?:;|$)/i.test(req.headers['content-type']??'')||!(/^[1-9][0-9]{0,4}$/).test(req.headers['content-length']??'')||Number(req.headers['content-length'])>16384)throw new B2bSecurityError(400,'INVALID_REQUEST');
  res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');return res.status(200).json(await this.core.check(req.body,peer));
 }
}
@Module({})
export class B2bQueuedEmailActorModule {
 static isolated(core:B2bQueuedEmailActor,peers:readonly string[]):DynamicModule {
  if(!(core instanceof B2bQueuedEmailActor)||!Array.isArray(peers)||!peers.length||peers.length>32||new Set(peers).size!==peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw Error('EXPLICIT_EMAIL_WORKER_PEERS_REQUIRED');
  return {module:B2bQueuedEmailActorModule,controllers:[B2bQueuedEmailActorController],providers:[EmailActorFilter,{provide:CORE,useValue:core},{provide:PEERS,useValue:Object.freeze([...peers])}]};
 }
}
