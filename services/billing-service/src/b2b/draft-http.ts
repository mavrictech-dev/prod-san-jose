import { Body,Controller,Inject,Module,Post,Req,Res,type DynamicModule } from '@nestjs/common';
import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { b2bIssuerId } from '@factuez/contracts/b2b-read-query';
import { b2bPrivatePeer } from '@factuez/service-access/dist/b2b';
import { B2bDrafts } from './drafts';
const CORE=Symbol('B2B draft owner'),PEERS=Symbol('B2B draft peers');
@Controller('internal/b2b')
export class B2bDraftOwnerController {
  constructor(@Inject(CORE)private readonly core:B2bDrafts,@Inject(PEERS)private readonly peers:string[]){}
  @Post('drafts')async call(@Req()req:any,@Res()res:any,@Body()body:any){
    b2bPrivatePeer(req,this.peers);res.setHeader('Cache-Control','private, no-store');
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='action,args,kind'||!['SERVICE','USER'].includes(body.kind)||!body.args||typeof body.args!=='object'||Array.isArray(body.args))throw new B2bSecurityError(400,'INVALID_REQUEST');
    const token=req.headers.authorization;if(typeof token!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(token))throw new B2bSecurityError(401,'INVALID_TOKEN');
    const {action,args,kind}=body;if(!['CREATE','PATCH','VALIDATE','CANCEL','ISSUE','READ','OPERATION'].includes(action))throw new B2bSecurityError(422,'SOURCE_NOT_SUPPORTED');
    const keys=action==='READ'?['issuerId','id']:action==='OPERATION'?['issuerId','id','key']:['issuerId','id','key','ifMatch','body'];
    if(Object.keys(args).some(k=>!keys.includes(k)))throw new B2bSecurityError(400,'INVALID_REQUEST');
    const issuerId=b2bIssuerId(args.issuerId);let result;
    if(action==='READ')result=await this.core.read(token.slice(7),kind,args.id,issuerId);
    else if(action==='OPERATION')result=await this.core.operation(token.slice(7),kind,args.id,args.key,issuerId);
    else result=await this.core.command(token.slice(7),kind,action,args.id,args.key,args.ifMatch,args.body,issuerId);
    res.status(200).json(result);
  }
}
@Module({})
export class B2bDraftOwnerModule {
  static isolated(core:B2bDrafts,peers:string[]):DynamicModule{
    if(!peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw new Error('Explicit draft mTLS peers required');
    return {module:B2bDraftOwnerModule,controllers:[B2bDraftOwnerController],providers:[{provide:CORE,useValue:core},{provide:PEERS,useValue:peers}]};
  }
}
