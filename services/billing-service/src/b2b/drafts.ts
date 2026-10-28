import { createHash,randomUUID } from 'node:crypto';
import { B2bSecurityError,b2bBindingsContain,type B2bBinding,type B2bPrincipal,type B2bIdentityScope } from '@factuez/contracts/b2b-security';
import { b2bUuid } from '@factuez/contracts/b2b-read-query';
import { B2bOwnerReadFrame,type B2bIdentityPort } from '@factuez/service-access/dist/b2b-read-adapter';
import { snapshotHash } from '@factuez/service-access/dist/integration';
import { calculateDocumentTotals } from '../application/totals';
import { draftBody,draftPatch } from './draft-validation';
import type { ContextRepository } from './context';
import type { Draft,DraftAction,DraftOperation,DraftStore } from './draft-model';
const actorKey=(p:B2bPrincipal)=>p.kind+':'+(p.subjectId??'-');
const etag=(d:Draft)=>`"v${d.revision}"`;
const view=(d:Draft)=>({schemaVersion:'factuez.b2b.v1',id:d.id,context:d.binding,revision:etag(d),documentType:d.body.documentType,currency:d.body.currency,paymentTerms:d.body.paymentTerms,externalReference:d.body.externalReference,customer:d.body.customer,lines:d.body.lines,issueDate:d.body.issueDate,state:d.state,validatedRevision:d.validatedRevision,createdAt:d.createdAt,updatedAt:d.updatedAt});
/** Owner-local aggregate; fiscal writes require an explicitly bound SAME-transaction port. */
export class B2bDrafts {
  constructor(private readonly store:DraftStore,private readonly identity:B2bIdentityPort,private readonly context:ContextRepository,private readonly now=Date.now){}
  private async authorized(p:B2bPrincipal,d:Draft){if(d.clientId!==p.clientId||d.actorKey!==actorKey(p)||!b2bBindingsContain(p.bindings,d.binding)||!await this.context.resolve(d.binding))throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');}
  private operationView(op:DraftOperation){return {schemaVersion:'factuez.b2b.v1',operationId:op.id,commandId:op.commandId,requestId:op.requestId,environment:'BETA',context:op.binding,state:op.action==='ISSUE'?'COMMITTED':'SUCCEEDED',resourceId:op.documentId??op.draftId,action:op.action,fiscalAcceptance:'NOT_ASSERTED'};}
  async command(token:string,kind:'SERVICE'|'USER',action:DraftAction,id:string|null,key:string,ifMatch:string|undefined,body:unknown,issuerId?:number){
    if(!['CREATE','PATCH','VALIDATE','CANCEL','ISSUE'].includes(action)||typeof key!=='string'||!/^[A-Za-z0-9_-]{16,100}$/.test(key)||(action!=='CREATE'&&!b2bUuid(id))||(action==='CREATE'&&(id!==null||ifMatch!==undefined)))throw new B2bSecurityError(400,'INVALID_REQUEST');
    if(action!=='CREATE'&&(typeof ifMatch!=='string'||!/^"v[1-9][0-9]{0,8}"$/.test(ifMatch)))throw new B2bSecurityError(428,'PRECONDITION_REQUIRED');
    if(['VALIDATE','CANCEL','ISSUE'].includes(action)&&(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length))throw new B2bSecurityError(400,'EMPTY_COMMAND_REQUIRED');
    if(!body||typeof body!=='object'||Array.isArray(body)||Buffer.byteLength(JSON.stringify(body))>128*1024)throw new B2bSecurityError(400,'INVALID_REQUEST');
    const required:B2bIdentityScope[]=action==='ISSUE'?['b2b:drafts:write','b2b:documents:issue']:['b2b:drafts:write'];
    const frame=new B2bOwnerReadFrame(this.identity,kind),p=await frame.principal(token,required);
    const owner=actorKey(p),keyHash=createHash('sha256').update(key).digest('hex'),requestHash=snapshotHash({action,id,ifMatch:ifMatch??null,issuerId:issuerId??null,body});
    try{return await this.store.transaction(p.clientId+':'+owner,async tx=>{
      const prior=await tx.prior(p.clientId,owner,keyHash);
      if(prior){if(prior.requestHash!==requestHash)throw new B2bSecurityError(409,'IDEMPOTENCY_CONFLICT');const d=await tx.get(prior.draftId);if(!d)throw new B2bSecurityError(409,'DRAFT_INCONSISTENT');await this.authorized(p,d);await frame.principal(token,required);return {response:structuredClone(prior.response),operation:this.operationView(prior),replayed:true};}
      let d:Draft;
      if(action==='CREATE'){
        const b=draftBody(body),matches=p.bindings.filter(binding=>binding.issuerId===b.issuerId&&binding.branchId===b.branchId&&binding.pointId===b.pointId&&binding.seriesId===b.seriesId&&binding.documentType===b.documentType);
        if(matches.length!==1||(issuerId!==undefined&&b.issuerId!==issuerId))throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');
        d={id:randomUUID(),clientId:p.clientId,actorKey:owner,binding:structuredClone(matches[0]),body:b,revision:1,state:'DRAFT',validatedRevision:null,createdAt:new Date(this.now()).toISOString(),updatedAt:new Date(this.now()).toISOString()};
        await this.authorized(p,d);await tx.create(d);
      }else{
        const found=await tx.get(id!);if(!found||(issuerId!==undefined&&found.binding.issuerId!==issuerId))throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');d=found;await this.authorized(p,d);
        if(etag(d)!==ifMatch)throw new B2bSecurityError(412,'REVISION_CONFLICT');if(d.state!=='DRAFT')throw new B2bSecurityError(409,'DRAFT_IMMUTABLE');
        if(action==='ISSUE'){
          if(!tx.issue)throw new B2bSecurityError(409,'PROFILE_NOT_ENABLED');
          if(d.validatedRevision!==d.revision)throw new B2bSecurityError(409,'DRAFT_VALIDATION_REQUIRED');
          const {kind:actorKind,clientId,revision,subjectId,userAuthRevision}=p;
          const op:DraftOperation={id:randomUUID(),commandId:randomUUID(),requestId:randomUUID(),clientId:p.clientId,actorKey:owner,
            actor:{kind:actorKind,clientId,revision,subjectId,userAuthRevision},keyHash,requestHash,action,draftId:d.id,binding:d.binding,at:new Date(this.now()).toISOString(),response:null};
          d={...d,body:draftBody(d.body)};
          const issued=await tx.issue(d,op),expected=d.revision;
          if(!b2bUuid(issued.documentId)||!new RegExp('^'+(d.binding.documentType==='01'?'F':'B')+'[A-Z0-9]{3}$').test(issued.series)||
            !/^[1-9][0-9]{0,7}$/.test(issued.number)||issued.fullNumber!==issued.series+'-'+issued.number)
            throw new B2bSecurityError(503,'INCONSISTENT_ISSUANCE_RESULT');
          d={...d,state:'ISSUED',revision:expected+1,updatedAt:op.at};await tx.save(d,expected);
          op.documentId=issued.documentId;op.response={schemaVersion:'factuez.b2b.v1',context:d.binding,draftId:d.id,revision:etag(d),
            ...issued,operationId:op.id,state:'COMMITTED',fiscalAcceptance:'NOT_ASSERTED'};
          await tx.append(op);await frame.principal(token,required);
          return {response:op.response,operation:this.operationView(op),replayed:false};
        }
        const expected=d.revision;d={...d,body:action==='PATCH'?draftPatch(d.body,body):draftBody(d.body),revision:expected+1,updatedAt:new Date(this.now()).toISOString(),validatedRevision:action==='VALIDATE'?expected+1:null,state:action==='CANCEL'?'CANCELLED':'DRAFT'};
        await tx.save(d,expected);
      }
      const response=action==='VALIDATE'?{draftId:d.id,revision:etag(d),profile:'BETA_01_03_TAXABLE18_V1',valid:true,issues:[],totals:calculateDocumentTotals(d.body.lines).totals,fiscalActivation:false}:view(d);
      const {kind:actorKind,clientId,revision,subjectId,userAuthRevision}=p;
      const op:DraftOperation={id:randomUUID(),commandId:randomUUID(),requestId:randomUUID(),clientId:p.clientId,actorKey:owner,actor:{kind:actorKind,clientId,revision,subjectId,userAuthRevision},keyHash,requestHash,action,draftId:d.id,binding:d.binding,at:new Date(this.now()).toISOString(),response};
      await tx.append(op);await frame.principal(token,['b2b:drafts:write']);return {response,operation:this.operationView(op),replayed:false};
    });}catch(e){if(e instanceof B2bSecurityError)throw e;throw new B2bSecurityError(503,'DRAFT_STORE_UNAVAILABLE');}
  }
  async read(token:string,kind:'SERVICE'|'USER',id:string,issuerId?:number){
    if(!b2bUuid(id))throw new B2bSecurityError(400,'INVALID_ID');const frame=new B2bOwnerReadFrame(this.identity,kind),p=await frame.principal(token,['b2b:drafts:write']);
    return this.store.transaction(p.clientId+':'+actorKey(p),async tx=>{const d=await tx.get(id);if(!d||(issuerId!==undefined&&d.binding.issuerId!==issuerId))throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');await this.authorized(p,d);await frame.principal(token,['b2b:drafts:write']);return view(d);});
  }
  async operation(token:string,kind:'SERVICE'|'USER',id:string|null,key?:string,issuerId?:number){
    if(id!==null?!b2bUuid(id):typeof key!=='string'||!/^[A-Za-z0-9_-]{16,100}$/.test(key))throw new B2bSecurityError(400,'INVALID_QUERY');
    const frame=new B2bOwnerReadFrame(this.identity,kind),p=await frame.principal(token,['b2b:operations:read']),owner=actorKey(p);
    return this.store.transaction(p.clientId+':'+owner,async tx=>{const op=id?await tx.operation(id,p.clientId,owner):await tx.prior(p.clientId,owner,createHash('sha256').update(key!).digest('hex'));
      if(!op||(issuerId!==undefined&&op.binding.issuerId!==issuerId))throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');const d=await tx.get(op.draftId);if(!d)throw new B2bSecurityError(409,'DRAFT_INCONSISTENT');await this.authorized(p,d);await frame.principal(token,['b2b:operations:read']);return this.operationView(op);});
  }
}
