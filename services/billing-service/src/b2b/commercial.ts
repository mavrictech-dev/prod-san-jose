import {createHash,randomUUID} from 'node:crypto';
import {B2bSecurityError,b2bBindingsContain,type B2bPrincipal,type B2bIdentityScope} from '@factuez/contracts/b2b-security';
import {b2bUuid} from '@factuez/contracts/b2b-read-query';
import {B2bOwnerReadFrame,type B2bIdentityPort} from '@factuez/service-access/dist/b2b-read-adapter';
import {snapshotHash} from '@factuez/service-access/dist/integration';
import {calculateDocumentTotals} from '../application/totals';
import {draftBody,draftPatch} from './draft-validation';
import type {ContextRepository} from './context';
import type {DraftBody,DraftOperation} from './draft-model';
import type {CommercialStore,CommercialResource,CommercialKind,CommercialAction,CommercialOperation,CorrectionBody} from './commercial-model';
import {assessCorrectionDeclarations} from './correction-readiness';
const actorKey=(p:B2bPrincipal)=>p.kind+':'+(p.subjectId??'-');
const revision=(r:CommercialResource)=>`"v${r.revision}"`;
const fail=(status:number,code:string):never=>{throw new B2bSecurityError(status,code);};
const plain=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:unknown,allowed:string[],required=allowed)=>plain(v)&&Object.keys(v).every(k=>allowed.includes(k))&&required.every(k=>Object.hasOwn(v,k));
const empty=(v:unknown)=>exact(v,[]);
export const commercialScopes=(kind:CommercialKind,write=false):B2bIdentityScope[]=>kind==='SALES_NOTE'?[write?'b2b:sales-notes:write':'b2b:sales-notes:read']:[write?'b2b:corrections:write':'b2b:corrections:read','b2b:documents:read'];
function correctionBody(value:unknown):CorrectionBody {
  if(!exact(value,['originalDocumentId','kind','reason','proposedAmount','externalReference'],['originalDocumentId','kind','reason','externalReference']))return fail(400,'INVALID_CORRECTION_REQUEST');
  const b=value as CorrectionBody;
  if(!b2bUuid(b.originalDocumentId)||!['CREDIT_NOTE','DEBIT_NOTE','VOID'].includes(b.kind)||typeof b.reason!=='string'||!b.reason.trim()||b.reason.length>250||/[\x00-\x1f\x7f]/.test(b.reason)||
    !exact(b.externalReference,['namespace','value'])||typeof b.externalReference.namespace!=='string'||!/^[a-z][a-z0-9_-]{0,39}$/.test(b.externalReference.namespace)||typeof b.externalReference.value!=='string'||!b.externalReference.value.trim()||b.externalReference.value.length>120||/[\x00-\x1f\x7f]/.test(b.externalReference.value))return fail(400,'INVALID_CORRECTION_REQUEST');
  if(b.kind==='VOID'?b.proposedAmount!==undefined:typeof b.proposedAmount!=='string'||!/^\d{1,12}\.\d{2}$/.test(b.proposedAmount)||BigInt(b.proposedAmount.replace('.',''))<=0n)return fail(400,'INVALID_PROPOSED_AMOUNT');
  return structuredClone(b);
}
export function commercialView(r:CommercialResource){
  const common={schemaVersion:'factuez.b2b.v1',id:r.id,context:r.binding,revision:revision(r),kind:r.kind,state:r.state,externalReference:r.body.externalReference,createdAt:r.createdAt,updatedAt:r.updatedAt,fiscalAcceptance:'NOT_ASSERTED'};
  if(r.kind==='CORRECTION_REQUEST')return {...common,request:r.body,original:r.original,fiscalExecutionEnabled:false,
    blockers:['TRUSTED_EVIDENCE_RESOLVER_PENDING','ATOMIC_FINANCIAL_LEDGER_PENDING','FISCAL_PROFILE_NOT_ENABLED']};
  const b=r.body as DraftBody;
  return {...common,documentType:'NV',fiscal:false,commercialNumber:r.commercialNumber,numberingScope:{issuerId:r.binding.issuerId,pointId:r.binding.pointId},
    conversionTarget:r.binding,currency:b.currency,paymentTerms:b.paymentTerms,customer:b.customer,lines:b.lines,issueDate:b.issueDate,
    totals:calculateDocumentTotals(b.lines).totals,completedSha256:r.completedSha256,convertedDocumentId:r.convertedDocumentId,convertedDraftId:r.convertedDraftId};
}
/** Commercial state only. A correction request is NOT an NC/ND/RA or an authorization. */
export class B2bCommercial {
  constructor(private readonly store:CommercialStore,private readonly identity:B2bIdentityPort,private readonly context:ContextRepository,readonly conversionConfigured=false,private readonly now=Date.now){}
  private async authorized(p:B2bPrincipal,r:CommercialResource,issuerId:number,kind:CommercialKind){
    if(r.kind!==kind||r.clientId!==p.clientId||r.actorKey!==actorKey(p)||r.binding.issuerId!==issuerId||!b2bBindingsContain(p.bindings,r.binding)||!await this.context.resolve(r.binding))fail(404,'RESOURCE_NOT_FOUND');
  }
  private operationView(op:CommercialOperation){return {schemaVersion:'factuez.b2b.v1',operationId:op.id,requestId:op.requestId,context:op.binding,resourceId:op.resourceId,kind:op.kind,action:op.action,state:op.action==='CONVERT'?'COMMITTED':'SUCCEEDED',fiscalAcceptance:'NOT_ASSERTED'};}
  async command(token:string,actor:'SERVICE'|'USER',kind:CommercialKind,action:CommercialAction,issuerId:number,id:string|null,key:string,ifMatch:string|undefined,body:unknown){
    if(!['SALES_NOTE','CORRECTION_REQUEST'].includes(kind)||!['CREATE','PATCH','COMPLETE','CONVERT','CANCEL'].includes(action)||!Number.isSafeInteger(issuerId)||issuerId<1||issuerId>2147483647||
      typeof key!=='string'||!/^[A-Za-z0-9_-]{16,100}$/.test(key)||(action==='CREATE'?(id!==null||ifMatch!==undefined):!b2bUuid(id)))fail(400,'INVALID_REQUEST');
    if(action!=='CREATE'&&(typeof ifMatch!=='string'||!/^"v[1-9][0-9]{0,8}"$/.test(ifMatch)))fail(428,'PRECONDITION_REQUIRED');
    if(!plain(body)||Buffer.byteLength(JSON.stringify(body))>128*1024)fail(400,'INVALID_REQUEST');
    if(['COMPLETE','CONVERT','CANCEL'].includes(action)&&!empty(body))fail(400,'EMPTY_COMMAND_REQUIRED');
    if(kind==='CORRECTION_REQUEST'&&!['CREATE','CANCEL'].includes(action))fail(409,'FISCAL_PROFILE_NOT_ENABLED');
    const required=[...commercialScopes(kind,true),...(action==='CONVERT'?['b2b:documents:issue' as const]:[])];
    const frame=new B2bOwnerReadFrame(this.identity,actor),p=await frame.principal(token,required),owner=actorKey(p);
    if(!p.bindings.some(b=>b.issuerId===issuerId))fail(404,'RESOURCE_NOT_FOUND');
    if(action==='CONVERT'&&!this.conversionConfigured)fail(409,'PROFILE_NOT_ENABLED');
    const keyHash=createHash('sha256').update(key).digest('hex'),requestHash=snapshotHash({kind,action,issuerId,id,ifMatch:ifMatch??null,body});
    return this.store.transaction(p.clientId+':'+owner,async tx=>{
      const prior=await tx.prior(p.clientId,owner,keyHash);
      if(prior){
        if(prior.requestHash!==requestHash)fail(409,'IDEMPOTENCY_CONFLICT');const r=await tx.get(prior.resourceId);if(!r)fail(409,'COMMERCIAL_INCONSISTENT');
        await this.authorized(p,r!,issuerId,kind);await frame.principal(token,required);return {response:structuredClone(prior.response),operation:this.operationView(prior),replayed:true};
      }
      const at=new Date(this.now()).toISOString();let r:CommercialResource;
      if(action==='CREATE'){
        let b:DraftBody|CorrectionBody,binding:B2bPrincipal['bindings'][number],original:CommercialResource['original']=null;
        if(kind==='SALES_NOTE'){
          if(!exact(body,['conversion']))fail(400,'INVALID_SALES_NOTE');b=draftBody((body as any).conversion);
          const matches=p.bindings.filter(c=>c.issuerId===issuerId&&c.issuerId===(b as DraftBody).issuerId&&c.branchId===(b as DraftBody).branchId&&c.pointId===(b as DraftBody).pointId&&c.seriesId===(b as DraftBody).seriesId&&c.documentType===(b as DraftBody).documentType);
          if(matches.length!==1)fail(404,'RESOURCE_NOT_FOUND');binding=matches[0];
        }else{
          b=correctionBody(body);original=await tx.original(b.originalDocumentId);
          if(!original||original.binding.issuerId!==issuerId||!b2bBindingsContain(p.bindings,original.binding))fail(404,'RESOURCE_NOT_FOUND');binding=original!.binding;
          if(b.kind==='CREDIT_NOTE'&&BigInt(b.proposedAmount!.replace('.',''))>BigInt(original!.payableAmount.replace('.','')))fail(422,'PROPOSED_CREDIT_EXCEEDS_ORIGINAL');
        }
        r={id:randomUUID(),kind,clientId:p.clientId,actorKey:owner,binding:structuredClone(binding!),body:b,revision:1,
          state:kind==='SALES_NOTE'?'DRAFT':'BLOCKED_FISCAL_EXECUTION',commercialNumber:null,completedSha256:null,original,convertedDocumentId:null,convertedDraftId:null,createdAt:at,updatedAt:at};
        await this.authorized(p,r,issuerId,kind);if(kind==='SALES_NOTE')r.commercialNumber=await tx.nextNumber(r.binding);await tx.create(r);
      }else{
        const found=await tx.get(id!);if(!found)fail(404,'RESOURCE_NOT_FOUND');r=found!;await this.authorized(p,r,issuerId,kind);
        if(revision(r)!==ifMatch)fail(412,'REVISION_CONFLICT');if(['CONVERTED','CANCELLED'].includes(r.state))fail(409,'COMMERCIAL_IMMUTABLE');
        if(action==='PATCH'){
          if(r.state!=='DRAFT')fail(409,'COMMERCIAL_IMMUTABLE');r={...r,body:draftPatch(r.body as DraftBody,body)};
        }else if(action==='COMPLETE'){
          if(r.state!=='DRAFT')fail(409,'COMMERCIAL_IMMUTABLE');const b=draftBody(r.body);r={...r,body:b,state:'COMPLETED',completedSha256:snapshotHash(b)};
        }else if(action==='CONVERT'){
          if(r.state!=='COMPLETED'||r.completedSha256!==snapshotHash(r.body))fail(409,'SALES_NOTE_COMPLETION_REQUIRED');
          if(!tx.convert)fail(409,'PROFILE_NOT_ENABLED');
        }else r={...r,state:'CANCELLED'};
      }
      const {kind:actorKind,clientId,revision:authRevision,subjectId,userAuthRevision}=p;
      const op:CommercialOperation={id:randomUUID(),requestId:randomUUID(),clientId,actorKey:owner,actor:{kind:actorKind,clientId,revision:authRevision,subjectId,userAuthRevision},
        keyHash,requestHash,resourceId:r.id,kind,action,binding:r.binding,at,response:null};
      let issued;
      if(action==='CONVERT'){
        const draftId=randomUUID(),issueOp:DraftOperation={...op,commandId:op.id,action:'ISSUE',draftId};
        issued=await tx.convert!(r,issueOp);
        if(!b2bUuid(issued.documentId)||!new RegExp('^'+(r.binding.documentType==='01'?'F':'B')+'[A-Z0-9]{3}$').test(issued.series)||!/^\d{1,8}$/.test(issued.number)||BigInt(issued.number)<1n||issued.fullNumber!==issued.series+'-'+issued.number)fail(503,'INCONSISTENT_ISSUANCE_RESULT');
        r={...r,state:'CONVERTED',convertedDocumentId:issued.documentId,convertedDraftId:draftId};
      }
      if(action!=='CREATE'){const expected=r.revision;r={...r,revision:expected+1,updatedAt:at};await tx.save(r,expected);}
      op.response={...commercialView(r),...(issued?{issuance:{...issued,state:'COMMITTED',fiscalAcceptance:'NOT_ASSERTED'}}:{})};
      await tx.append(op);await frame.principal(token,required);
      return {response:op.response,operation:this.operationView(op),replayed:false};
    });
  }
  async read(token:string,actor:'SERVICE'|'USER',kind:CommercialKind,issuerId:number,id:string){
    if(!b2bUuid(id))fail(400,'INVALID_ID');const required=commercialScopes(kind),frame=new B2bOwnerReadFrame(this.identity,actor),p=await frame.principal(token,required);
    return this.store.transaction(p.clientId+':'+actorKey(p),async tx=>{const r=await tx.get(id);if(!r)fail(404,'RESOURCE_NOT_FOUND');await this.authorized(p,r!,issuerId,kind);await frame.principal(token,required);return commercialView(r!);});
  }
  async list(token:string,actor:'SERVICE'|'USER',kind:CommercialKind,issuerId:number,limit=50,after:string|null=null){
    if(!Number.isSafeInteger(limit)||limit<1||limit>100||after!==null&&!b2bUuid(after))fail(400,'INVALID_QUERY');
    const required=commercialScopes(kind),frame=new B2bOwnerReadFrame(this.identity,actor),p=await frame.principal(token,required),bindings=p.bindings.filter(b=>b.issuerId===issuerId);
    if(!bindings.length)fail(404,'RESOURCE_NOT_FOUND');
    for(const b of bindings)if(!await this.context.resolve(b))fail(404,'RESOURCE_NOT_FOUND');
    return this.store.transaction(p.clientId+':'+actorKey(p),async tx=>{
      const rows=await tx.list(p.clientId,actorKey(p),kind,bindings,limit+1,after),items=rows.slice(0,limit);
      for(const r of items)await this.authorized(p,r,issuerId,kind);await frame.principal(token,required);
      return {schemaVersion:'factuez.b2b.v1',items:items.map(commercialView),page:{limit,hasMore:rows.length>limit,nextAfter:rows.length>limit?items.at(-1)!.id:null,consistency:'LIVE_KEYSET_NOT_A_SNAPSHOT'}};
    });
  }
  async operation(token:string,actor:'SERVICE'|'USER',issuerId:number,id:string){
    if(!b2bUuid(id))fail(400,'INVALID_ID');const frame=new B2bOwnerReadFrame(this.identity,actor),p=await frame.principal(token,['b2b:operations:read']);
    return this.store.transaction(p.clientId+':'+actorKey(p),async tx=>{
      const op=await tx.operation(id,p.clientId,actorKey(p));if(!op)fail(404,'RESOURCE_NOT_FOUND');
      const r=await tx.get(op!.resourceId);if(!r)fail(409,'COMMERCIAL_INCONSISTENT');await frame.principal(token,commercialScopes(op!.kind));
      await this.authorized(p,r!,issuerId,op!.kind);await frame.principal(token,['b2b:operations:read']);return this.operationView(op!);
    });
  }
  async readiness(token:string,actor:'SERVICE'|'USER',issuerId:number,id:string){
    if(!b2bUuid(id))fail(400,'INVALID_ID');
    const required=commercialScopes('CORRECTION_REQUEST'),frame=new B2bOwnerReadFrame(this.identity,actor),p=await frame.principal(token,required);
    return this.store.transaction(p.clientId+':'+actorKey(p),async tx=>{
      const r=await tx.get(id);if(!r)fail(404,'RESOURCE_NOT_FOUND');await this.authorized(p,r!,issuerId,'CORRECTION_REQUEST');
      const saved=r!.original,original=saved?await tx.original(saved.id):null;
      if(!saved||!original||snapshotHash(saved)!==snapshotHash(original))fail(409,'ORIGINAL_REFERENCE_CHANGED');
      const declarations=assessCorrectionDeclarations(original!,await tx.observedCredits(original!.id,issuerId));
      const blockers=[...(r!.state==='CANCELLED'?['REQUEST_CANCELLED']:[]),...declarations.problems,
        'TRUSTED_EVIDENCE_RESOLVER_PENDING','ATOMIC_FINANCIAL_LEDGER_PENDING','FISCAL_PROFILE_NOT_ENABLED'];
      await frame.principal(token,required);
      return {schemaVersion:'factuez.b2b.v1',id:r!.id,context:r!.binding,revision:revision(r!),requestState:r!.state,
        assessedAt:new Date(this.now()).toISOString(),readiness:'BLOCKED',fiscalExecutionEnabled:false,transmissionAuthorized:false,
        evidenceAuthenticityVerified:false,originalSnapshotSha256:original!.snapshotSha256,declarations,blockers,
        consistency:'LOCAL_OBSERVATION_NOT_A_RESERVATION',note:'No CDR/PKI verification, no reservation and no fiscal balance authorization'};
    });
  }
}
