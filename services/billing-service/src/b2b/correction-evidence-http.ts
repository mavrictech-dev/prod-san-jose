import {Body,Controller,Inject,Module,Post,Req,Res,type DynamicModule} from '@nestjs/common';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {b2bPrivatePeer} from '@factuez/service-access/dist/b2b';
import {BillingCorrectionEvidenceAuthority} from './correction-evidence-authority';
const CORE=Symbol('Billing correction evidence authority'),PEERS=Symbol('SUNAT evidence callback peers');
@Controller('internal/b2b')
export class BillingCorrectionEvidenceController {
  constructor(@Inject(CORE)private readonly core:BillingCorrectionEvidenceAuthority,@Inject(PEERS)private readonly peers:string[]){}
  @Post('correction-evidence-authorize')async authorize(@Req()req:any,@Res()res:any,@Body()body:unknown){
    b2bPrivatePeer(req,this.peers);res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
    const header=req.headers.authorization;
    if(typeof header!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(header))throw new B2bSecurityError(401,'INVALID_TOKEN');
    res.status(200).json(await this.core.authorize(header.slice(7),body));
  }
}
@Module({})
export class BillingCorrectionEvidenceModule {
  static isolated(core:BillingCorrectionEvidenceAuthority,peers:string[]):DynamicModule{
    if(!peers.length||peers.length>100||new Set(peers).size!==peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw new Error('Explicit SUNAT evidence peers required');
    return{module:BillingCorrectionEvidenceModule,controllers:[BillingCorrectionEvidenceController],providers:[{provide:CORE,useValue:core},{provide:PEERS,useValue:Object.freeze([...peers])}]};
  }
}
