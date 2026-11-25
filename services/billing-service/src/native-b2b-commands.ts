import {HttpException,Injectable,type OnModuleInit} from '@nestjs/common';
import {createHash,randomUUID} from 'node:crypto';
import {ProductionError,binding,authorize,canonical,deny,hash,type ProductionBinding,type ProductionActor} from '@factuez/service-access/dist/b2b-production-contract';
import {NativeB2bPrismaStore} from '@factuez/service-access/dist/native-b2b-store';
import {nativeB2bConfig} from '@factuez/service-access/dist/native-b2b-rpc';
import {PrismaService} from './infrastructure/prisma.service';
import {NativeB2bBillingAuthority,nativeIssueScope,type NativeBinding,type NativeServiceContext} from './native-b2b-authority';
import {IssueDocumentService} from './application/issue-document.service';
import {ProductionNotesOwnerService} from './application/production-notes-owner.service';
import {ProductionGuidesOwner} from './production-guides-owner';
type Code='01'|'03'|'07'|'08'|'09'|'31';
type Command={clientId:string;binding:ProductionBinding;code:Code;requestHash:string;operationId:string;state:'PENDING'|'SUCCEEDED'|'REJECTED'|'UNCERTAIN';result?:unknown;errorCode?:string;createdAt:string;updatedAt:string};
export function nativeOperationId(key:string){const b=createHash('sha256').update('factuez:native-production:'+key).digest().subarray(0,16);b[6]=(b[6]&15)|80;b[8]=(b[8]&63)|128;const h=b.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}
@Injectable()
export class NativeB2bCommands implements OnModuleInit {
 private readonly store:NativeB2bPrismaStore;
 private activeWrites=0;
 constructor(private readonly db:PrismaService,private readonly authority:NativeB2bBillingAuthority,private readonly issue:IssueDocumentService,private readonly notes:ProductionNotesOwnerService,private readonly guides:ProductionGuidesOwner){this.store=new NativeB2bPrismaStore(db);}
 async onModuleInit(){if(process.env.NATIVE_B2B_ENABLED!=='true')return;nativeB2bConfig();const [r]=await this.db.$queryRawUnsafe<any[]>("SELECT to_regclass('b2b_production_record') IS NOT NULL AS ready");if(!r?.ready)throw Error('NATIVE_B2B_BILLING_SCHEMA_REQUIRED');}
 context(actor:ProductionActor,n:NativeBinding,authorization:string,id:string):NativeServiceContext{return {userId:null,createdByActor:{kind:'SERVICE',clientId:actor.clientId,revision:actor.revision,environment:'PRODUCTION',subjectId:null,userAuthRevision:null},scope:{kind:'ASSIGNED',branchIds:[n.branchId],emissionPointIds:[n.pointId],series:[n.seriesId]},productionBinding:{environment:'PRODUCTION',issuerId:n.companyId,issuerRuc:n.issuerRuc,branchId:n.branchId,pointId:n.pointId,seriesId:n.seriesId,series:n.series,documentType:n.documentType},operationId:id,idempotencyKey:`b2b-production:${actor.clientId}:${id}`,correlationId:id,authorization};}
 async execute(authorization:string,raw:unknown,key:unknown,kind:'documents'|'notes'|'guides',originalId?:string){
  // Keep connections free for the fiscal owner's authenticated callbacks while
  // native producers hold their counter transaction. Saturation is rejected
  // before journaling or reserving; retrying the same key remains safe.
  if(this.activeWrites>=2)throw new HttpException({code:'NATIVE_ISSUANCE_BUSY',message:'Hay dos emisiones en proceso en este servidor. Reintente conservando la misma clave y el mismo contenido; esta solicitud todavía no se registró.'},429);
  this.activeWrites++;
  try{return await this.executeAccepted(authorization,raw,key,kind,originalId);}finally{this.activeWrites--;}
 }
 private async executeAccepted(authorization:string,raw:unknown,key:unknown,kind:'documents'|'notes'|'guides',originalId?:string){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).sort().join(',')!=='binding,payload')deny(400,'INVALID_BODY');
  const envelope=raw as {binding:ProductionBinding;payload:any},b=binding(envelope.binding),v=envelope.payload;
  if(!v||typeof v!=='object'||Array.isArray(v))deny(400,'INVALID_NATIVE_PAYLOAD');
  const code:Code=kind==='documents'?v.documentType==='INVOICE'?'01':v.documentType==='SALES_RECEIPT'?'03':deny(400,'INVALID_DOCUMENT_TYPE'):kind==='notes'?['07','08'].includes(v.adjustment?.documentTypeCode)?v.adjustment.documentTypeCode:deny(400,'INVALID_NOTE_PAYLOAD'):v.profile==='GRE31_PUBLIC_SINGLE09_V1'?'31':'09';
  if(typeof key!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(key))deny(400,'IDEMPOTENCY_KEY_REQUIRED');
  const actor=await this.authority.actor(authorization),n=await this.authority.resolve(actor,nativeIssueScope(code),b);
  if(n.documentType!==code||kind==='documents'&&(v.emissionPointId!==n.pointId||v.series!==n.series)||kind!=='documents'&&v.seriesCounterId!==n.seriesId)deny(403,'PAYLOAD_BINDING_MISMATCH');
  authorize(actor,'production:masters:read',b);
  const commandKey=hash(canonical({clientId:actor.clientId,key})),requestHash=hash(canonical({kind,b,payload:v,originalId:originalId??null})),operationId=nativeOperationId(commandKey),now=new Date().toISOString();
  const command:Command={clientId:actor.clientId,binding:b,code,requestHash,operationId,state:'PENDING',createdAt:now,updatedAt:now};
  const prior=await this.store.transaction(['command:'+commandKey],async tx=>{const old=await tx.get<Command>('command',commandKey);if(old){if(old.requestHash!==requestHash)deny(409,'IDEMPOTENCY_CONFLICT');return old;}await tx.put('command',commandKey,command);await tx.put('audit',randomUUID(),{action:'COMMAND_ACCEPTED',clientId:actor.clientId,operationId,code,binding:b,at:now});return null;});
  if(prior){if(prior.state==='SUCCEEDED')return prior.result;throw new HttpException({code:'COMMAND_'+prior.state,operationId:prior.operationId,operationState:prior.state},409);}
  const context=this.context(actor,n,authorization,operationId);
  let ownerCommitted=false;
  try{
   const result=kind==='documents'?await this.issue.executeB2B(v,context):kind==='notes'?await this.notes.issueB2B(originalId!,v,operationId,context):await this.guides.issueB2B(v,operationId,context);
   ownerCommitted=true;
   const response={environment:'PRODUCTION',operationId,state:'REGISTERED',...result as object};
   await this.store.transaction(['command:'+commandKey],async tx=>{await tx.put('command',commandKey,{...command,state:'SUCCEEDED',result:response,updatedAt:new Date().toISOString()});await tx.put('audit',randomUUID(),{action:'COMMAND_SUCCEEDED',clientId:actor.clientId,operationId,at:new Date().toISOString()});});return response;
  }catch(error){
   // Owner methods commit all document/counter/outbox effects in one transaction. A lost
   // response can follow commit: never send again automatically or reuse a new key.
   const status=error instanceof HttpException?error.getStatus():error instanceof ProductionError?error.status:500,state=!ownerCommitted&&status>=400&&status<500?'REJECTED':'UNCERTAIN';
   await this.store.transaction(['command:'+commandKey],async tx=>{await tx.put('command',commandKey,{...command,state,updatedAt:new Date().toISOString()});await tx.put('audit',randomUUID(),{action:'COMMAND_'+state,clientId:actor.clientId,operationId,at:new Date().toISOString()});});
   const raw=error instanceof HttpException?error.getResponse():error instanceof ProductionError?{code:error.code}:{};
   throw new HttpException({...(raw&&typeof raw==='object'?raw:typeof raw==='string'?{message:raw}:{}),operationId,operationState:state},status);
  }
 }
 async operation(actor:ProductionActor,id:string){
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))deny(400,'INVALID_OPERATION_ID');
  const rows=await this.db.$queryRawUnsafe<Array<{value:Command}>>("SELECT value FROM b2b_production_record WHERE namespace='command' AND value->>'clientId'=$1 AND value->>'operationId'=$2 LIMIT 1",actor.clientId,id),c=rows[0]?.value;
  if(!c)deny(404,'OPERATION_NOT_FOUND');authorize(actor,nativeIssueScope(c.code),c.binding);
  const read=await this.authority.resolve(actor,'production:documents:read',c.binding);
  const own=await this.db.document.findFirst({where:{companyId:read.companyId,emissionPointId:read.pointId,seriesCounterId:read.seriesId,immutableSnapshot:{path:['environment'],equals:'PRODUCTION'},OR:[{originSystem:'B2B_PRODUCTION',originId:id,createdByActor:{path:['clientId'],equals:actor.clientId}},{originSystem:'PRODUCTION_NOTES',originId:id,createdByActor:{path:['clientId'],equals:actor.clientId}},{originSystem:'PRODUCTION_GUIDES',originId:id,createdByActor:{path:['clientId'],equals:actor.clientId}}]},select:{id:true,fullNumber:true,status:true,sunatStatus:true}});
  return {environment:'PRODUCTION',operationId:id,state:c.state,createdAt:c.createdAt,updatedAt:c.updatedAt,...(c.state==='SUCCEEDED'?{result:c.result}:{}),nativeDocument:own,automaticResubmission:false};
 }
}
