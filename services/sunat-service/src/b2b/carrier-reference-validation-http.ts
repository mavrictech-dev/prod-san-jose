import {Catch,Controller,Inject,Module,Post,Req,Res,UseFilters,type ArgumentsHost,type DynamicModule} from '@nestjs/common';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {b2bPrivatePeer} from '@factuez/service-access/dist/b2b';
import {CarrierReferenceValidation,carrierReferenceLimits,referenceRequire} from './carrier-reference-validation';
import {carrierReferenceRequest,carrierReferenceResponse} from './carrier-reference-validation-protocol';
const CORE=Symbol('Real SUNAT carrier reference validation'),PEERS=Symbol('Billing-only peers'),CLOCK=Symbol('Carrier validator clock');
@Catch()
export class CarrierReferenceValidationFilter {
 catch(error:unknown,host:ArgumentsHost){const status=error instanceof B2bSecurityError&&[400,401,403,413].includes(error.status)?error.status:503;
  const res=host.switchToHttp().getResponse();res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');return res.status(status).json({code:status===403?'CARRIER_REFERENCE_BILLING_PEER_REQUIRED':'CARRIER_REFERENCE_VALIDATION_UNAVAILABLE'});}
}
@Controller('internal/b2b')
@UseFilters(CarrierReferenceValidationFilter)
export class CarrierReferenceValidationController {
 constructor(@Inject(CORE)private readonly core:CarrierReferenceValidation,@Inject(PEERS)private readonly peers:readonly string[],@Inject(CLOCK)private readonly now:()=>string){}
 @Post('carrier-reference-validation')async verify(@Req()req:any,@Res()res:any){
  b2bPrivatePeer(req,this.peers);res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
  const names=(req.rawHeaders??[]).filter((_v:any,i:number)=>i%2===0).map((n:string)=>n.toLowerCase());
  if(req.url.includes('?')||new Set(names).size!==names.length||req.headers.authorization||req.headers['transfer-encoding']||req.headers['content-encoding']||
   !/^application\/json(?:;|$)/i.test(req.headers['content-type']??'')||!(/^[1-9][0-9]{0,6}$/).test(req.headers['content-length']??'')||Number(req.headers['content-length'])>carrierReferenceLimits.request)throw new B2bSecurityError(400,'INVALID_REFERENCE_VALIDATION_REQUEST');
  const before=this.now();let value;try{value=carrierReferenceRequest(req.body,before);}catch{throw new B2bSecurityError(400,'INVALID_REFERENCE_VALIDATION_REQUEST');}
  const acceptance=await this.core.verify(value.input),after=this.now();
  referenceRequire(Date.parse(after)-Date.parse(before)>=0&&Date.parse(after)-Date.parse(value.request.asOf)<=carrierReferenceLimits.freshMs);
  return res.status(200).json(carrierReferenceResponse(value.request,acceptance,after));
 }
}
@Module({})
export class CarrierReferenceValidationModule {
 static isolated(core:CarrierReferenceValidation,roles:{billing:readonly string[]},now:()=>string=()=>new Date().toISOString()):DynamicModule{
  referenceRequire(core instanceof CarrierReferenceValidation&&roles&&Object.keys(roles).join(',')==='billing'&&Array.isArray(roles.billing)&&roles.billing.length>0&&roles.billing.length<=32&&new Set(roles.billing).size===roles.billing.length&&roles.billing.every(p=>/^[a-f0-9]{64}$/.test(p))&&typeof now==='function');
  return {module:CarrierReferenceValidationModule,controllers:[CarrierReferenceValidationController],providers:[CarrierReferenceValidationFilter,{provide:CORE,useValue:core},{provide:PEERS,useValue:Object.freeze([...roles.billing])},{provide:CLOCK,useValue:now}]};
 }
}
