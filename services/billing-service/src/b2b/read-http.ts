import { Body,Controller,Inject,Module,Post,Req,Res,type DynamicModule } from '@nestjs/common';
import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { b2bPrivatePeer } from '@factuez/service-access/dist/b2b';
import { B2bBillingReads } from './read';
const CORE=Symbol('Billing B2B reads'),PEERS=Symbol('Billing B2B read peers');
@Controller('internal/b2b')
export class B2bBillingReadController {
  constructor(@Inject(CORE)private readonly core:B2bBillingReads,@Inject(PEERS)private readonly peers:string[]){}
  @Post('read')async read(@Req()req:any,@Res()res:any,@Body()body:unknown){
    b2bPrivatePeer(req,this.peers);res.setHeader('Cache-Control','private, no-store');
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='action,args,kind'||!['SERVICE','USER'].includes((body as any).kind))throw new B2bSecurityError(400,'INVALID_REQUEST');
    const authorization=req.headers.authorization;
    if(typeof authorization!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(authorization))throw new B2bSecurityError(401,'INVALID_TOKEN');
    const {kind,action,args}=body as any;res.status(200).json(await this.core.execute(authorization.slice(7),kind,action,args));
  }
}
@Module({})
export class B2bBillingReadModule {
  static isolated(core:B2bBillingReads,peers:string[]):DynamicModule{
    if(!peers.length||peers.some(peer=>!/^[a-f0-9]{64}$/.test(peer)))throw new Error('B2B read peers required');
    return {module:B2bBillingReadModule,controllers:[B2bBillingReadController],providers:[{provide:CORE,useValue:core},{provide:PEERS,useValue:peers}]};
  }
}
