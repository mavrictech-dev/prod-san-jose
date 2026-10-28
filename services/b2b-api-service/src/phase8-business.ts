import {Controller,Get,Inject,Module,Param,Patch,Post,Req,Res,UseFilters,type DynamicModule} from '@nestjs/common';
import {B2bSecurityError,validB2bBinding,b2bBindingsContain,type B2bBinding,type B2bIdentityScope} from '@factuez/contracts/b2b-security';
import {B2bOwnerReadFrame,type B2bIdentityPort} from '@factuez/service-access/dist/b2b-read-adapter';
import {b2bPrivatePeer,type B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {b2bUuid} from '@factuez/contracts/b2b-read-query';
import {correctionEvidenceFreeze} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import {B2bReadErrorFilter} from './http';
export type BusinessAction='CUSTOMERS_LIST'|'CUSTOMERS_DETAIL'|'CUSTOMERS_CREATE'|'CUSTOMERS_UPDATE'|'PRODUCTS_LIST'|'PRODUCTS_CREATE'|'PRODUCTS_UPDATE'|'SHIFTS_LIST'|'SHIFTS_OPEN'|'SHIFTS_CLOSE'|'SHIFTS_CASH'|'REPORTS_SUMMARY';
export interface Phase8BusinessPort{execute(access:{token:string;kind:'SERVICE'|'USER'},action:BusinessAction,input:any):Promise<unknown>}
export class HttpPhase8Business implements Phase8BusinessPort{
  constructor(private readonly http:Pick<B2bPrivateHttp,'post'>){}
  execute(access:{token:string;kind:'SERVICE'|'USER'},action:BusinessAction,input:unknown){return this.http.post('/internal/b2b/phase8-business',{kind:access.kind,action,input},access.token);}
}
export const businessScope:Record<BusinessAction,B2bIdentityScope>={CUSTOMERS_LIST:'b2b:customers:read',CUSTOMERS_DETAIL:'b2b:customers:read',CUSTOMERS_CREATE:'b2b:customers:write',CUSTOMERS_UPDATE:'b2b:customers:write',PRODUCTS_LIST:'b2b:products:read',PRODUCTS_CREATE:'b2b:products:write',PRODUCTS_UPDATE:'b2b:products:write',SHIFTS_LIST:'b2b:shifts:read',SHIFTS_OPEN:'b2b:shifts:write',SHIFTS_CLOSE:'b2b:shifts:write',SHIFTS_CASH:'b2b:cash:write',REPORTS_SUMMARY:'b2b:reports:read'};
export class B2bPhase8Business{
  constructor(private readonly identity:B2bIdentityPort,private readonly owner:Phase8BusinessPort){}
  async execute(access:{token:string;kind:'SERVICE'|'USER'},action:BusinessAction,input:any){
    if(!Object.hasOwn(businessScope,action))throw new B2bSecurityError(400,'INVALID_REQUEST');
    const v:any=correctionEvidenceFreeze(input),binding=v?.binding;if(!validB2bBinding(binding))throw new B2bSecurityError(400,'INVALID_BINDING');
    const required=action==='SHIFTS_CASH'?[businessScope[action],'b2b:shifts:write'] as const:action==='REPORTS_SUMMARY'?['b2b:reports:read','b2b:customers:read','b2b:products:read','b2b:shifts:read'] as const:[businessScope[action]];
    const frame=new B2bOwnerReadFrame(this.identity,access.kind),fresh=async()=>{const p=await frame.principal(access.token,[...required]);if(!b2bBindingsContain(p.bindings,binding))throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');};
    await fresh();const r:any=correctionEvidenceFreeze(await this.owner.execute(access,action,v));
    if(!r||typeof r.replayed!=='boolean'||!Object.hasOwn(r,'data')||r.operationId!==null&&!b2bUuid(r.operationId)||Object.keys(r).some(k=>!['data','operationId','replayed','nextCursor'].includes(k)))throw new B2bSecurityError(503,'INVALID_BUSINESS_RESPONSE');
    await fresh();return {schemaVersion:'factuez.b2b.business.v1',environment:'BETA',binding,candidateOnly:true,fiscalAuthority:false,...r};
  }
}
const CORE=Symbol('Phase8 business'),PEERS=Symbol('Business peers');
@Controller('b2b/v1')
@UseFilters(B2bReadErrorFilter)
export class B2bPhase8BusinessController{
  constructor(@Inject(CORE)private readonly core:B2bPhase8Business,@Inject(PEERS)private readonly peers:readonly string[]){}
  private request(req:any,res:any,list=false){
    res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');b2bPrivatePeer(req,this.peers);
    const names=(req.rawHeaders??[]).filter((_v:any,i:number)=>i%2===0).map((n:string)=>n.toLowerCase()),a=req.headers.authorization,k=req.headers['x-factuez-actor-kind'];
    if(new Set(names).size!==names.length||typeof a!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(a)||!['SERVICE','USER'].includes(k))throw new B2bSecurityError(401,'INVALID_TOKEN');
    const q=new URLSearchParams((req.originalUrl??req.url).split('?').slice(1).join('?')),keys=[...q.keys()],base=['issuerId','issuerRuc','environment','branchId','pointId','seriesId','documentType'];
    if(new Set(keys).size!==keys.length||base.some(n=>!q.has(n))||keys.some(n=>![...base,...(list?['limit','after','q']:[])].includes(n)))throw new B2bSecurityError(400,'INVALID_QUERY');
    const issuerId=q.get('issuerId')!;if(!/^[1-9][0-9]{0,9}$/.test(issuerId))throw new B2bSecurityError(400,'INVALID_QUERY');
    const binding={...Object.fromEntries(base.map(n=>[n,q.get(n)])),issuerId:Number(issuerId)} as B2bBinding;if(!validB2bBinding(binding))throw new B2bSecurityError(400,'INVALID_BINDING');
    const payload:any=correctionEvidenceFreeze(req.body??{});if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(n=>['binding','id','idempotencyKey'].includes(n)))throw new B2bSecurityError(400,'INVALID_REQUEST');
    const params:any={binding};for(const n of ['limit','after','q'])if(q.has(n)){const val=q.get(n)!;if(n==='limit'&&!/^[1-9][0-9]{0,2}$/.test(val))throw new B2bSecurityError(400,'INVALID_QUERY');params[n]=n==='limit'?Number(val):val;}
    return {access:{token:a.slice(7),kind:k as 'SERVICE'|'USER'},params,payload,key:req.headers['idempotency-key']};
  }
  private run(req:any,res:any,action:BusinessAction,id?:string){
    const list=action.endsWith('_LIST'),r=this.request(req,res,list);if(id&&!b2bUuid(id))throw new B2bSecurityError(400,'INVALID_ID');
    const write=['CREATE','UPDATE','OPEN','CLOSE','CASH'].some(a=>action.endsWith('_'+a));
    let args:any={...r.params,...(id?{id}:{})};
    if(write){
      if(typeof r.key!=='string'||!/^[A-Za-z0-9_-]{16,100}$/.test(r.key))throw new B2bSecurityError(400,'INVALID_IDEMPOTENCY_KEY');
      args.idempotencyKey=r.key;
      if(action.endsWith('_CREATE'))args.body=r.payload;
      else if(action.endsWith('_UPDATE')){if(Object.keys(r.payload).sort().join(',')!=='body,expectedRevision')throw new B2bSecurityError(400,'INVALID_REQUEST');Object.assign(args,r.payload);}
      else Object.assign(args,r.payload);
    }else if(Object.keys(r.payload).length||req.body!==undefined)throw new B2bSecurityError(400,'INVALID_REQUEST');
    return this.core.execute(r.access,action,args);
  }
  @Get('customers')customers(@Req()r:any,@Res({passthrough:true})s:any){return this.run(r,s,'CUSTOMERS_LIST');}
  @Get('customers/:id')customer(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string){return this.run(r,s,'CUSTOMERS_DETAIL',id);}
  @Post('customers')createCustomer(@Req()r:any,@Res({passthrough:true})s:any){return this.run(r,s,'CUSTOMERS_CREATE');}
  @Patch('customers/:id')updateCustomer(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string){return this.run(r,s,'CUSTOMERS_UPDATE',id);}
  @Get('business-products')products(@Req()r:any,@Res({passthrough:true})s:any){return this.run(r,s,'PRODUCTS_LIST');}
  @Post('products')createProduct(@Req()r:any,@Res({passthrough:true})s:any){return this.run(r,s,'PRODUCTS_CREATE');}
  @Patch('products/:id')updateProduct(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string){return this.run(r,s,'PRODUCTS_UPDATE',id);}
  @Get('shifts')shifts(@Req()r:any,@Res({passthrough:true})s:any){return this.run(r,s,'SHIFTS_LIST');}
  @Post('shifts')open(@Req()r:any,@Res({passthrough:true})s:any){return this.run(r,s,'SHIFTS_OPEN');}
  @Post('shifts/:id/close')close(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string){return this.run(r,s,'SHIFTS_CLOSE',id);}
  @Post('shifts/:id/cash-movements')cash(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string){return this.run(r,s,'SHIFTS_CASH',id);}
  @Get('business-summary')summary(@Req()r:any,@Res({passthrough:true})s:any){return this.run(r,s,'REPORTS_SUMMARY');}
}
@Module({})
export class B2bPhase8BusinessModule{
  static isolated(core:B2bPhase8Business,peers:readonly string[]):DynamicModule{
    if(!core||typeof core.execute!=='function'||!peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw new Error('EXPLICIT_BUSINESS_OWNER_REQUIRED');
    return {module:B2bPhase8BusinessModule,controllers:[B2bPhase8BusinessController],providers:[B2bReadErrorFilter,{provide:CORE,useValue:core},{provide:PEERS,useValue:[...peers]}]};
  }
}
