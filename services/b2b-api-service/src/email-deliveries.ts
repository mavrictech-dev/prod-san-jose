import {Controller,Get,Inject,Module,Param,Post,Req,Res,UseFilters,type DynamicModule} from '@nestjs/common';
import {B2bSecurityError,validB2bBinding,b2bBindingsContain,b2bBindingKey} from '@factuez/contracts/b2b-security';
import {b2bUuid} from '@factuez/contracts/b2b-read-query';
import {B2bOwnerReadFrame,type B2bIdentityPort} from '@factuez/service-access/dist/b2b-read-adapter';
import {b2bPrivatePeer,type B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {correctionEvidenceFreeze} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import {B2bReadErrorFilter} from './http';
type Access={token:string;kind:'SERVICE'|'USER'};type Action='CREATE'|'READ';
const ownerErrorStatus:Readonly<Record<string,number>>={
 INVALID_PRINCIPAL:401,ACCESS_CHANGED:401,RESOURCE_NOT_FOUND:404,INVALID_REQUEST:400,IDEMPOTENCY_CONFLICT:409,
 EMAIL_REVISION_CONFLICT:409,EMAIL_SMTP_CONFIGURATION_CHANGED:409,EMAIL_ATTEMPT_CHANGED:409,EMAIL_REAL_SEND_FORBIDDEN:403,
 EMAIL_DISABLED:503,EMAIL_STORE_UNAVAILABLE:503,EMAIL_OWNER_UNAVAILABLE:503,EMAIL_CAPTURE_DISABLED:503,
 EMAIL_CAPTURE_UNAVAILABLE:503,EMAIL_ARTIFACT_INTEGRITY:409,EMAIL_PRIVATE_PEER_REQUIRED:403,
 EMAIL_CORPORATE_DISABLED:503,EMAIL_SMTP_CONFIGURATION_UNAVAILABLE:503,EMAIL_SMTP_POLICY:503,
};
function validEmailOutcome(v:{profile:unknown;state:unknown;errorCode:unknown}):boolean{
 if(!['NONE','LOCAL_CAPTURE','CORPORATE'].includes(v.profile as string))return false;
 if(v.state==='QUEUED')return v.errorCode===null;
 if(v.state==='WAITING_ARTIFACTS')return v.errorCode==='ARTIFACTS_PENDING';
 if(v.profile==='NONE')return false;
 if(v.state==='DISPATCHING')return v.errorCode===null;
 if(v.state==='UNKNOWN')return v.errorCode===(v.profile==='CORPORATE'?'SMTP_OUTCOME_UNKNOWN':'CAPTURE_OUTCOME_UNKNOWN');
 return v.errorCode===null&&(v.profile==='CORPORATE'?v.state==='SMTP_ACCEPTED':v.state==='CAPTURED_LOCAL');
}
export interface EmailDeliveryOwnerPort{execute(access:Access,action:Action,input:any):Promise<unknown>}
export class HttpEmailDeliveryOwner implements EmailDeliveryOwnerPort{
 constructor(private readonly http:Pick<B2bPrivateHttp,'post'>){}
 async execute(access:Access,action:Action,input:unknown){
  const r:any=await this.http.post('/internal/b2b/email-deliveries',{kind:access.kind,action,input},access.token);
  if(r&&Object.keys(r).join(',')==='error'){
   const n=r.error?.status,status=Number.isInteger(n)&&[400,401,403,404,409,413,422,429,503].includes(n)?n:503;
   const code=r.error?.code;
   throw new B2bSecurityError(status,typeof code==='string'&&Object.hasOwn(ownerErrorStatus,code)&&ownerErrorStatus[code]===status?code:'EMAIL_OWNER_REQUEST_DENIED');
  }return r;
 }
}
export class B2bEmailDeliveryOperations{
 constructor(private readonly identity:B2bIdentityPort,private readonly owner:EmailDeliveryOwnerPort){}
 async execute(access:Access,action:Action,input:unknown){
  const v:any=correctionEvidenceFreeze(input);if(!['CREATE','READ'].includes(action)||!v||action==='CREATE'&&!validB2bBinding(v.binding))throw new B2bSecurityError(400,'INVALID_EMAIL_REQUEST');
  const required=action==='CREATE'?['b2b:email:send','b2b:documents:read'] as const:['b2b:email:read','b2b:documents:read'] as const,frame=new B2bOwnerReadFrame(this.identity,access.kind);
  const fresh=async()=>{const p=await frame.principal(access.token,[...required]);if(action==='CREATE'&&!b2bBindingsContain(p.bindings,v.binding))throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');return p;};const principal=await fresh();
  const r:any=correctionEvidenceFreeze(await this.owner.execute(access,action,v));
  if(!r||r.schemaVersion!=='factuez.b2b.email-deliveries.v1'||r.environment!=='BETA'||r.candidateOnly!==true||r.deliveredToClient!==false||r.fiscalAuthority!==false||!b2bUuid(r.id)||!b2bUuid(r.documentId)||action==='CREATE'&&r.documentId!==v.documentId||action==='READ'&&r.id!==v.id||Object.keys(r).some(k=>['recipient','token','password','credentials','bytes','contentBase64'].includes(k)))throw new B2bSecurityError(503,'INVALID_EMAIL_OWNER_RESPONSE');
  if(Object.keys(r).sort().join(',')!=='attachments,binding,candidateOnly,createdAt,deliveredToClient,documentId,environment,errorCode,fiscalAuthority,format,id,profile,replayed,revision,schemaVersion,state,updatedAt'||!validB2bBinding(r.binding)||!b2bBindingsContain(principal.bindings,r.binding)||action==='CREATE'&&b2bBindingKey(r.binding)!==b2bBindingKey(v.binding)||!validEmailOutcome(r)||!['ticket','a4'].includes(r.format)||!Number.isSafeInteger(r.revision)||r.revision<1||typeof r.replayed!=='boolean'||!Array.isArray(r.attachments)||r.attachments.length>3)throw new B2bSecurityError(503,'INVALID_EMAIL_OWNER_RESPONSE');
  for(const a of r.attachments)if(!a||Object.keys(a).sort().join(',')!=='byteLength,fileName,kind,mediaType,representation,sha256,sourceProofSha256'||!['PDF','XML','CDR'].includes(a.kind)||typeof a.fileName!=='string'||a.fileName.length>150||/[\\/\x00-\x1f]/.test(a.fileName)||!['CURRENT_GENERATED','IMMUTABLE_ORIGINAL'].includes(a.representation)||!/^[a-f0-9]{64}$/.test(a.sha256)||!/^[a-f0-9]{64}$/.test(a.sourceProofSha256)||!Number.isSafeInteger(a.byteLength)||a.byteLength<1)throw new B2bSecurityError(503,'INVALID_EMAIL_OWNER_RESPONSE');
  await fresh();return r;
 }
}
const CORE=Symbol('Email deliveries facade'),PEERS=Symbol('Email delivery peers');
@Controller('b2b/v1')
@UseFilters(B2bReadErrorFilter)
export class B2bEmailDeliveriesController{
 constructor(@Inject(CORE)private readonly core:B2bEmailDeliveryOperations,@Inject(PEERS)private readonly peers:readonly string[]){}
 private access(r:any,s:any){s.setHeader('Cache-Control','private, no-store');s.setHeader('X-Content-Type-Options','nosniff');b2bPrivatePeer(r,this.peers);
  const ns=(r.rawHeaders??[]).filter((_v:any,i:number)=>i%2===0).map((n:string)=>n.toLowerCase()),a=r.headers.authorization,k=r.headers['x-factuez-actor-kind'];
  if(new Set(ns).size!==ns.length||typeof a!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(a)||!['SERVICE','USER'].includes(k))throw new B2bSecurityError(401,'INVALID_TOKEN');if(r.url.includes('?'))throw new B2bSecurityError(400,'INVALID_QUERY');return {token:a.slice(7),kind:k as Access['kind']};}
 @Post('documents/:id/email-deliveries')create(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string){
  const a=this.access(r,s),b:any=correctionEvidenceFreeze(r.body),key=r.headers['idempotency-key'];
  if(!b2bUuid(id)||!b||Object.keys(b).sort().join(',')!=='binding,format,recipient'||typeof key!=='string'||!/^[A-Za-z0-9_-]{16,100}$/.test(key))throw new B2bSecurityError(400,'INVALID_EMAIL_REQUEST');s.status(202);return this.core.execute(a,'CREATE',{...b,documentId:id,idempotencyKey:key});}
 @Get('email-deliveries/:id')read(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string){const a=this.access(r,s);if(!b2bUuid(id)||r.body!==undefined)throw new B2bSecurityError(400,'INVALID_EMAIL_REQUEST');return this.core.execute(a,'READ',{id});}
}
@Module({})
export class B2bEmailDeliveriesModule{static isolated(core:B2bEmailDeliveryOperations,peers:readonly string[]):DynamicModule{if(!core||typeof core.execute!=='function'||!peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw new Error('EXPLICIT_EMAIL_OWNER_REQUIRED');return {module:B2bEmailDeliveriesModule,controllers:[B2bEmailDeliveriesController],providers:[B2bReadErrorFilter,{provide:CORE,useValue:core},{provide:PEERS,useValue:[...peers]}]};}}
