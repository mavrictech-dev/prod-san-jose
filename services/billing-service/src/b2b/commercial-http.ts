import {Body,Controller,Inject,Module,Post,Req,Res,type DynamicModule} from '@nestjs/common';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {b2bIssuerId} from '@factuez/contracts/b2b-read-query';
import {b2bPrivatePeer} from '@factuez/service-access/dist/b2b';
import {B2bCommercial} from './commercial';
const CORE=Symbol('B2B commercial owner'),PEERS=Symbol('B2B commercial peers');
@Controller('internal/b2b')
export class B2bCommercialOwnerController {
  constructor(@Inject(CORE)private readonly core:B2bCommercial,@Inject(PEERS)private readonly peers:string[]){}
  @Post('commercial')async call(@Req()req:any,@Res()res:any,@Body()body:any){
    b2bPrivatePeer(req,this.peers);res.setHeader('Cache-Control','private, no-store');
    const token=req.headers.authorization;
    if(typeof token!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(token))throw new B2bSecurityError(401,'INVALID_TOKEN');
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='action,args,kind,resourceKind'||!['SERVICE','USER'].includes(body.kind)||!['SALES_NOTE','CORRECTION_REQUEST'].includes(body.resourceKind)||!body.args||typeof body.args!=='object'||Array.isArray(body.args))throw new B2bSecurityError(400,'INVALID_REQUEST');
    const {action,args,kind,resourceKind}=body;
    if(!['CREATE','PATCH','COMPLETE','CONVERT','CANCEL','READ','LIST','OPERATION','READINESS'].includes(action))throw new B2bSecurityError(422,'SOURCE_NOT_SUPPORTED');
    if(action==='READINESS'&&resourceKind!=='CORRECTION_REQUEST')throw new B2bSecurityError(400,'INVALID_REQUEST');
    const allowed=action==='LIST'?['issuerId','limit','after']:['READ','OPERATION','READINESS'].includes(action)?['issuerId','id']:['issuerId','id','key','ifMatch','body'];
    if(Object.keys(args).some(k=>!allowed.includes(k)))throw new B2bSecurityError(400,'INVALID_REQUEST');
    const issuerId=b2bIssuerId(args.issuerId);let result;
    if(action==='LIST')result=await this.core.list(token.slice(7),kind,resourceKind,issuerId,args.limit,args.after);
    else if(action==='READ')result=await this.core.read(token.slice(7),kind,resourceKind,issuerId,args.id);
    else if(action==='OPERATION')result=await this.core.operation(token.slice(7),kind,issuerId,args.id);
    else if(action==='READINESS')result=await this.core.readiness(token.slice(7),kind,issuerId,args.id);
    else result=await this.core.command(token.slice(7),kind,resourceKind,action,issuerId,args.id,args.key,args.ifMatch,args.body);
    res.status(200).json(result);
  }
}
@Module({})
export class B2bCommercialOwnerModule {
  static isolated(core:B2bCommercial,peers:string[]):DynamicModule {
    if(!peers.length||peers.length>100||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw new Error('Explicit commercial mTLS peers required');
    return {module:B2bCommercialOwnerModule,controllers:[B2bCommercialOwnerController],providers:[{provide:CORE,useValue:core},{provide:PEERS,useValue:peers}]};
  }
}
