import {Controller,Inject,Module,Post,Req,Res,UseFilters,type DynamicModule} from '@nestjs/common';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {b2bPrivatePeer} from '@factuez/service-access/dist/b2b';
import {correctionEvidenceFreeze} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import {BillingBatchHttpErrorFilter} from './batch-member-http';
import type {BatchCreditHistoryVersionBridge} from './batch-credit-history-version-bridge';
const CORE=Symbol('Credit history owner'),PEERS=Symbol('Credit history peers');
@Controller('internal/b2b')
@UseFilters(BillingBatchHttpErrorFilter)
class BillingCreditHistoryController {
 constructor(@Inject(CORE)private readonly core:Pick<BatchCreditHistoryVersionBridge,'read'>,@Inject(PEERS)private readonly peers:readonly string[]){}
 @Post('batch-credit-history')
 async read(@Req()req:any,@Res()res:any){
  res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
  b2bPrivatePeer(req,this.peers);
  const names:string[]=(req.rawHeaders??[]).filter((_v:string,i:number)=>i%2===0).map((v:string)=>v.toLowerCase()),header=req.headers.authorization;
  if(typeof header!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(header)||names.filter(v=>v==='authorization').length!==1)throw new B2bSecurityError(401,'INVALID_TOKEN');
  if(new Set(names).size!==names.length||names.some(v=>v.replace(/[-_]/g,'')==='authorization'&&v!=='authorization')||req.url.includes('?')||Object.keys(req.query??{}).length)throw new B2bSecurityError(400,'INVALID_BATCH_REQUEST');
  let body:any;
  try{body=correctionEvidenceFreeze(req.body);if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='kind,request'||
   !['SERVICE','USER'].includes(body.kind)||Buffer.byteLength(JSON.stringify(body))>16384)throw Error();}
  catch{throw new B2bSecurityError(400,'INVALID_BATCH_REQUEST');}
  return res.status(200).json(await this.core.read(header.slice(7),body.kind,body.request));
 }
}
@Module({})
export class BillingCreditHistoryModule {
 static isolated(core:Pick<BatchCreditHistoryVersionBridge,'read'>,peers:readonly string[]):DynamicModule{
  if(!core||typeof core.read!=='function'||!Array.isArray(peers)||!peers.length||peers.length>100||new Set(peers).size!==peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw Error('EXPLICIT_CREDIT_HISTORY_OWNER_AND_PEERS_REQUIRED');
  return {module:BillingCreditHistoryModule,controllers:[BillingCreditHistoryController],providers:[BillingBatchHttpErrorFilter,{provide:CORE,useValue:core},{provide:PEERS,useValue:Object.freeze([...peers])}]};
 }
}
