import {Controller,Get,Inject,Module,Param,Patch,Post,Req,Res,UseFilters,type DynamicModule} from '@nestjs/common';
import {B2bSecurityError,validB2bBinding,b2bBindingsContain,type B2bBinding} from '@factuez/contracts/b2b-security';
import {B2bOwnerReadFrame,type B2bIdentityPort} from '@factuez/service-access/dist/b2b-read-adapter';
import {b2bPrivatePeer,type B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {adminSnapshot,phase8AdminPolicy,type Phase8AdminAccess,type Phase8AdminAction} from '@factuez/service-access/dist/b2b-phase8-admin-wire';
import {B2bReadErrorFilter} from './http';
export interface PrivilegedOwnerPort{execute(access:Phase8AdminAccess,action:Phase8AdminAction,input:unknown):Promise<unknown>}
export class HttpPrivilegedOwner implements PrivilegedOwnerPort{
 constructor(private readonly http:Pick<B2bPrivateHttp,'post'>){}
 execute(access:Phase8AdminAccess,action:Phase8AdminAction,input:unknown){return this.http.post('/internal/b2b/owner-admin',{kind:access.kind,action,input},access.token);}
}
export type PrivilegedOwnerPorts={billing:PrivilegedOwnerPort;identity:PrivilegedOwnerPort;fiscal:PrivilegedOwnerPort;smtp:PrivilegedOwnerPort};
export class B2bPhase8Admin{
 constructor(private readonly identity:B2bIdentityPort,private readonly owners:PrivilegedOwnerPorts){}
 async execute(access:Phase8AdminAccess,action:Phase8AdminAction,input:unknown){
  if(access.kind!=='USER'||!Object.hasOwn(phase8AdminPolicy,action))throw new B2bSecurityError(403,'DELEGATED_HUMAN_REQUIRED');const v:any=adminSnapshot(input);if(!validB2bBinding(v?.binding))throw new B2bSecurityError(400,'INVALID_BINDING');
  const scope=phase8AdminPolicy[action][0],frame=new B2bOwnerReadFrame(this.identity,'USER'),fresh=async()=>{const p=await frame.principal(access.token,[scope]);if(!b2bBindingsContain(p.bindings,v.binding))throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');};await fresh();
  const owner=action.startsWith('FISCAL_')?this.owners.fiscal:action.startsWith('SMTP_')?this.owners.smtp:action.startsWith('USERS_')||action.startsWith('ROLES_')?this.owners.identity:this.owners.billing;
  const r:any=adminSnapshot(await owner.execute(access,action,v));if(!r||Object.keys(r).sort().join(',')!=='candidateOnly,data,environment,fiscalExecutionEnabled'||r.candidateOnly!==true||r.environment!=='BETA'||r.fiscalExecutionEnabled!==false)throw new B2bSecurityError(503,'INVALID_ADMIN_OWNER_RESPONSE');
  await fresh();return {schemaVersion:'factuez.b2b.owner-admin.v1',action,binding:v.binding,...r};
 }
}
const CORE=Symbol('Phase8 privileged administration'),PEERS=Symbol('Privileged edge peers');
@Controller('b2b/v1/admin')
@UseFilters(B2bReadErrorFilter)
export class B2bPhase8AdminController{
 constructor(@Inject(CORE)private readonly core:B2bPhase8Admin,@Inject(PEERS)private readonly peers:readonly string[]){}
 private run(r:any,s:any,action:Phase8AdminAction,id?:string){
  s.setHeader('Cache-Control','private, no-store');s.setHeader('X-Content-Type-Options','nosniff');b2bPrivatePeer(r,this.peers);
  const ns=(r.rawHeaders??[]).filter((_v:any,i:number)=>i%2===0).map((n:string)=>n.toLowerCase()),a=r.headers.authorization;if(new Set(ns).size!==ns.length||typeof a!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(a)||r.headers['x-factuez-actor-kind']!=='USER')throw new B2bSecurityError(403,'DELEGATED_HUMAN_REQUIRED');
  const q=new URLSearchParams((r.originalUrl??r.url).split('?').slice(1).join('?')),keys=[...q.keys()],base=['issuerId','issuerRuc','environment','branchId','pointId','seriesId','documentType'];
  if(new Set(keys).size!==keys.length||base.some(k=>!q.has(k))||keys.some(k=>![...base,...(action==='FISCAL_AUDIT'?['page']:[])].includes(k))||!/^[1-9][0-9]{0,9}$/.test(q.get('issuerId')??''))throw new B2bSecurityError(400,'INVALID_QUERY');
  const binding={...Object.fromEntries(base.map(k=>[k,q.get(k)])),issuerId:Number(q.get('issuerId'))} as B2bBinding;if(!validB2bBinding(binding))throw new B2bSecurityError(400,'INVALID_BINDING');
  if(['PRINT_READ','PRINT_SAVE','PRINT_PREVIEW','FISCAL_READ','FISCAL_SAVE','FISCAL_AUDIT','SMTP_READ','SMTP_SAVE'].includes(action)){if(id!==String(binding.issuerId))throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');id=undefined;}
  const payload:any=adminSnapshot(r.body??{});if(r.method==='GET'&&r.body!==undefined||!payload||Array.isArray(payload)||typeof payload!=='object'||Object.keys(payload).some(k=>['binding','id'].includes(k)))throw new B2bSecurityError(400,'INVALID_ADMIN_PAYLOAD');
  const ownerPayload=action==='FISCAL_AUDIT'?{...payload,page:q.get('page')??'1'}:payload;
  return this.core.execute({token:a.slice(7),kind:'USER'},action,{binding,payload:ownerPayload,...(id===undefined?{}:{id})});
 }
 @Get('masters')catalog(@Req()r:any,@Res({passthrough:true})s:any){return this.run(r,s,'MASTERS_READ');}
 @Post('issuers')issuerCreate(@Req()r:any,@Res({passthrough:true})s:any){return this.run(r,s,'ISSUER_CREATE');}
 @Patch('issuers/:id')issuerUpdate(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string){return this.run(r,s,'ISSUER_UPDATE',id);}
 @Post('branches')branchCreate(@Req()r:any,@Res({passthrough:true})s:any){return this.run(r,s,'BRANCH_CREATE');}
 @Patch('branches/:id')branchUpdate(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string){return this.run(r,s,'BRANCH_UPDATE',id);}
 @Post('branches/:id/points')pointCreate(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string){return this.run(r,s,'POINT_CREATE',id);}
 @Patch('points/:id')pointUpdate(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string){return this.run(r,s,'POINT_UPDATE',id);}
 @Post('points/:id/series')seriesCreate(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string){return this.run(r,s,'SERIES_CREATE',id);}
 @Patch('series/:id')seriesUpdate(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string){return this.run(r,s,'SERIES_UPDATE',id);}
 @Get('users')users(@Req()r:any,@Res({passthrough:true})s:any){return this.run(r,s,'USERS_LIST');}
 @Post('users')createUser(@Req()r:any,@Res({passthrough:true})s:any){return this.run(r,s,'USERS_CREATE');}
 @Patch('users/:id/access')access(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string){return this.run(r,s,'USERS_UPDATE',id);}
 @Get('roles')roles(@Req()r:any,@Res({passthrough:true})s:any){return this.run(r,s,'ROLES_LIST');}
 @Patch('roles/:id')role(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string){return this.run(r,s,'ROLES_UPDATE',id);}
 @Get('print-profiles/:id')print(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string){return this.run(r,s,'PRINT_READ',id);}
 @Patch('print-profiles/:id')printSave(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string){return this.run(r,s,'PRINT_SAVE',id);}
 @Post('print-profiles/:id/preview')preview(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string){return this.run(r,s,'PRINT_PREVIEW',id);}
 @Get('fiscal-config/:id/readiness')fiscal(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string){return this.run(r,s,'FISCAL_READ',id);}
 @Get('fiscal-config/:id/audit')audit(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string){return this.run(r,s,'FISCAL_AUDIT',id);}
 @Post('fiscal-config/:id/replacements')replace(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string){return this.run(r,s,'FISCAL_SAVE',id);}
 @Get('mail-config/:id')smtp(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string){return this.run(r,s,'SMTP_READ',id);}
 @Post('mail-config/:id/replacements')smtpSave(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string){return this.run(r,s,'SMTP_SAVE',id);}
}
@Module({})
export class B2bPhase8AdminModule{static isolated(core:B2bPhase8Admin,peers:readonly string[]):DynamicModule{if(!core||typeof core.execute!=='function'||!peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw new Error('EXPLICIT_PRIVILEGED_OWNERS_REQUIRED');return {module:B2bPhase8AdminModule,controllers:[B2bPhase8AdminController],providers:[B2bReadErrorFilter,{provide:CORE,useValue:core},{provide:PEERS,useValue:[...peers]}]};}}
