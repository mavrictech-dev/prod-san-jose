import {randomUUID,createHash} from 'node:crypto';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {b2bUuid} from '@factuez/contracts/b2b-read-query';
import {validB2bGuideBinding,b2bGuideBindingKey,type B2bGuideBinding} from '@factuez/contracts/b2b-guide-security';
import {boundedSupplementJson} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import {fiscalSnapshotSha256} from '@factuez/sunat-core/dist/fiscal-note';
import {supplementActor} from '../application/supplement-actor';
import type {GuideAuthorization,GuideAccess} from './guide-authorization';
import type {GuideCatalogue} from './guide-catalogue';
import {parseGuideBody,parseGuidePatch,type GuideDraft,type GuideStore,type GuideOperation} from './guide-model';
type Kind='SERVICE'|'USER';type Action=GuideOperation['action'];
const digest=(v:string)=>createHash('sha256').update(v).digest('hex'),hash=fiscalSnapshotSha256;
const flags={candidateOnly:true as const,fiscalExecutionEnabled:false as const,transmissionAuthorized:false as const};
const etag=(d:GuideDraft)=>`"v${d.revision}"`;
function fail(status:number,code:string):never{throw new B2bSecurityError(status,code);}
function detached<T>(v:T):T{try{return boundedSupplementJson(v) as T;}catch{return fail(400,'INVALID_GUIDE_REQUEST');}}
const bindingOf=(v:unknown)=>{const b=detached(v);if(!validB2bGuideBinding(b))fail(400,'INVALID_GUIDE_BINDING');return b as B2bGuideBinding;};
const ownerKey=(a:ReturnType<typeof supplementActor>)=>a.b2b!.kind+':'+(a.b2b!.subjectId??'-');
const view=(d:GuideDraft)=>({schemaVersion:'factuez.b2b.guide-draft.v1',id:d.id,binding:d.binding,revision:etag(d),state:d.state,body:d.body,bodySha256:d.bodySha256,createdAt:d.createdAt,updatedAt:d.updatedAt,...flags,authorizedForTransfer:false,referenceVerification:'NOT_VERIFIED'});
const operationView=(op:GuideOperation,binding:B2bGuideBinding)=>({operationId:op.id,requestId:op.requestId,draftId:op.draftId,action:op.action,state:'SUCCEEDED_LOCAL',binding,...flags});
function checkedBody(value:unknown,binding:B2bGuideBinding,status:number,code:string){try{return parseGuideBody(value,binding);}catch{return fail(status,code);}}
/** Business draft aggregate, NOT a fiscal producer. READY only freezes a local
 * plan; references/permits, official profiles and original XML/CDR remain gates.
 * No Document, counter, transport, Outbox or credentials are used by this class. */
export class B2bGuides{
  constructor(private readonly store:GuideStore,private readonly authorization:GuideAuthorization,private readonly catalogue:GuideCatalogue,private readonly now=()=>new Date().toISOString()){}
  private async access(token:string,kind:Kind,binding:B2bGuideBinding,action:GuideAccess){
    if(!['SERVICE','USER'].includes(kind)||typeof token!=='string'||!/^[A-Za-z0-9._~-]{1,8192}$/.test(token))fail(401,'INVALID_TOKEN');
    const granted=await this.authorization.current(token,kind,binding,action),actor=supplementActor(granted.actor),p=actor.b2b,s=actor.scope;
    if(!p||p.kind!==kind||p.revision!==granted.clientRevision||!Number.isSafeInteger(granted.grantRevision)||granted.grantRevision<1||s.kind!=='ASSIGNED'||s.branchIds.length!==1||s.branchIds[0]!==binding.anchor.branchId||s.emissionPointIds.length!==1||s.emissionPointIds[0]!==binding.anchor.pointId||s.series.length!==2||new Set(s.series).size!==2||![binding.anchor.seriesId,binding.guideSeriesId].every(id=>s.series.includes(id)))fail(503,'INVALID_GUIDE_AUTHORITY_RESPONSE');
    const resolved=await this.catalogue.resolve(binding);
    if(!resolved||!validB2bGuideBinding(resolved.binding)||b2bGuideBindingKey(resolved.binding)!==b2bGuideBindingKey(binding)||!/^[a-f0-9]{64}$/.test(resolved.metadataSha256))fail(404,'GUIDE_CONTEXT_NOT_FOUND');
    return{actor,clientId:p.clientId,actorKey:ownerKey(actor),grantRevision:granted.grantRevision,stamp:hash({granted,metadata:resolved.metadataSha256})};
  }
  private async boundary(token:string,kind:Kind,binding:B2bGuideBinding,action:GuideAccess){
    const initial=await this.access(token,kind,binding,action);
    return{...initial,fresh:async()=>{if((await this.access(token,kind,binding,action)).stamp!==initial.stamp)fail(409,'GUIDE_AUTHORITY_CHANGED');}};
  }
  private own(value:GuideDraft|null,binding:B2bGuideBinding,clientId:string,actorKey:string):GuideDraft{
    if(!value||value.clientId!==clientId||value.actorKey!==actorKey||!validB2bGuideBinding(value.binding)||b2bGuideBindingKey(value.binding)!==b2bGuideBindingKey(binding))fail(404,'GUIDE_DRAFT_NOT_FOUND');
    const d=detached(value);if(!b2bUuid(d.id)||!Number.isSafeInteger(d.revision)||d.revision<1||d.revision>999999999||!['DRAFT','READY','CANCELLED'].includes(d.state)||hash(d.body)!==d.bodySha256||hash(checkedBody(d.body,binding,409,'GUIDE_DRAFT_INCONSISTENT'))!==d.bodySha256||!Number.isFinite(Date.parse(d.createdAt))||!Number.isFinite(Date.parse(d.updatedAt))||Date.parse(d.updatedAt)<Date.parse(d.createdAt))fail(409,'GUIDE_DRAFT_INCONSISTENT');return d;
  }
  private receipt(value:GuideOperation,current:GuideDraft,binding:B2bGuideBinding,expectedAction?:Action,expectedRevision?:number){
    try{
      const op=boundedSupplementJson(value) as GuideOperation,response=op.response as ReturnType<typeof view>,p=op.actor;
      const exact=(v:object,fields:string[])=>!!v&&Object.keys(v).sort().join(',')===[...fields].sort().join(',');
      const instant=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
      if(!exact(op,['id','requestId','clientId','actorKey','keySha256','requestSha256','draftId','action','actor','grantRevision','at','response'])||
        !b2bUuid(op.id)||!b2bUuid(op.requestId)||op.clientId!==current.clientId||op.actorKey!==current.actorKey||op.draftId!==current.id||
        !/^[a-f0-9]{64}$/.test(op.keySha256)||!/^[a-f0-9]{64}$/.test(op.requestSha256)||!['CREATE','PATCH','READY','CANCEL'].includes(op.action)||
        expectedAction!==undefined&&op.action!==expectedAction||!Number.isSafeInteger(op.grantRevision)||op.grantRevision<1||
        !exact(p,['kind','clientId','revision','subjectId','userAuthRevision'])||p.clientId!==op.clientId||!Number.isSafeInteger(p.revision)||p.revision<1||
        !(p.kind==='SERVICE'?p.subjectId===null&&p.userAuthRevision===null:p.kind==='USER'&&b2bUuid(p.subjectId)&&Number.isSafeInteger(p.userAuthRevision)&&Number(p.userAuthRevision)>=0)||
        p.kind+':'+(p.subjectId??'-')!==op.actorKey||!exact(response,Object.keys(view(current)))||response.schemaVersion!=='factuez.b2b.guide-draft.v1'||
        response.id!==current.id||!validB2bGuideBinding(response.binding)||b2bGuideBindingKey(response.binding)!==b2bGuideBindingKey(binding)||
        response.candidateOnly!==true||response.fiscalExecutionEnabled!==false||response.transmissionAuthorized!==false||response.authorizedForTransfer!==false||response.referenceVerification!=='NOT_VERIFIED'||
        typeof response.revision!=='string'||!/^"v[1-9][0-9]{0,8}"$/.test(response.revision)||!instant(response.createdAt)||!instant(response.updatedAt)||
        response.createdAt!==current.createdAt||response.updatedAt<response.createdAt||response.updatedAt>current.updatedAt||op.at!==response.updatedAt||
        response.state!==(op.action==='READY'?'READY':op.action==='CANCEL'?'CANCELLED':'DRAFT')||hash(response.body)!==response.bodySha256||
        hash(checkedBody(response.body,binding,409,'GUIDE_OPERATION_INCONSISTENT'))!==response.bodySha256)throw new Error();
      const revision=Number(response.revision.slice(2,-1));
      if(revision>current.revision||(op.action==='CREATE'?revision!==1:revision<2)||expectedRevision!==undefined&&revision!==expectedRevision||
        revision===current.revision&&(response.state!==current.state||response.bodySha256!==current.bodySha256||response.updatedAt!==current.updatedAt))throw new Error();
      return response;
    }catch{return fail(409,'GUIDE_OPERATION_INCONSISTENT');}
  }
  async command(token:string,kind:Kind,bindingInput:unknown,action:Action,id:string|null,key:string,ifMatch:string|undefined,input:unknown){
    const binding=bindingOf(bindingInput),body=detached(input);
    if(Buffer.byteLength(JSON.stringify(body))>128*1024)fail(413,'GUIDE_BODY_TOO_LARGE');
    if(!['CREATE','PATCH','READY','CANCEL'].includes(action)||typeof key!=='string'||!/^[A-Za-z0-9_-]{16,100}$/.test(key)||action==='CREATE'&&(id!==null||ifMatch!==undefined)||action!=='CREATE'&&!b2bUuid(id))fail(400,'INVALID_GUIDE_COMMAND');
    if(action!=='CREATE'&&(typeof ifMatch!=='string'||!/^"v[1-9][0-9]{0,8}"$/.test(ifMatch)))fail(428,'PRECONDITION_REQUIRED');
    if(['READY','CANCEL'].includes(action)&&(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length))fail(400,'EMPTY_COMMAND_REQUIRED');
    const a=await this.boundary(token,kind,binding,'WRITE'),keySha256=digest(key),requestSha256=hash({binding,action,id,ifMatch:ifMatch??null,body});
    return this.store.transaction(async tx=>{
      await a.fresh();const prior=await tx.prior(a.clientId,a.actorKey,keySha256);
      if(prior){
        if(prior.requestSha256!==requestSha256)fail(409,'IDEMPOTENCY_CONFLICT');
        const current=this.own(await tx.get(prior.draftId),binding,a.clientId,a.actorKey);
        if(prior.clientId!==a.clientId||prior.actorKey!==a.actorKey||prior.keySha256!==keySha256||!b2bUuid(prior.id)||!b2bUuid(prior.requestId))fail(409,'GUIDE_OPERATION_INCONSISTENT');
        const response=this.receipt(prior,current,binding,action,action==='CREATE'?1:Number(ifMatch!.slice(2,-1))+1);
        await a.fresh();return{response,operation:operationView(prior,binding),replayed:true};
      }
      const at=this.now();let d:GuideDraft;
      if(action==='CREATE'){
        const parsed=checkedBody(body,binding,400,'INVALID_GUIDE_BODY');d={id:randomUUID(),clientId:a.clientId,actorKey:a.actorKey,binding,body:parsed,bodySha256:hash(parsed),revision:1,state:'DRAFT',createdAt:at,updatedAt:at};await tx.create(d);
      }else{
        const current=this.own(await tx.get(id!),binding,a.clientId,a.actorKey);
        if(etag(current)!==ifMatch)fail(412,'REVISION_CONFLICT');
        if(current.revision>=999999999)fail(409,'GUIDE_REVISION_EXHAUSTED');
        if(current.state==='CANCELLED'||current.state==='READY'&&action!=='CANCEL')fail(409,'GUIDE_DRAFT_IMMUTABLE');
        let parsed=current.body;
        if(action==='PATCH')try{parsed=checkedBody({...current.body,...parseGuidePatch(body)},binding,400,'INVALID_GUIDE_BODY');}catch{fail(400,'INVALID_GUIDE_BODY');}
        d={...current,body:parsed,bodySha256:hash(parsed),revision:current.revision+1,state:action==='READY'?'READY':action==='CANCEL'?'CANCELLED':'DRAFT',updatedAt:at};await tx.save(d,current.revision);
      }
      const response=view(d),p=a.actor.b2b!;
      const op:GuideOperation={id:randomUUID(),requestId:randomUUID(),clientId:a.clientId,actorKey:a.actorKey,keySha256,requestSha256,draftId:d.id,action,at,response,
        actor:{kind:p.kind,clientId:p.clientId,revision:p.revision,subjectId:p.subjectId,userAuthRevision:p.userAuthRevision},grantRevision:a.grantRevision};
      await tx.append(op);await a.fresh();return{response,operation:operationView(op,binding),replayed:false};
    });
  }
  async read(token:string,kind:Kind,bindingInput:unknown,id:string){
    const binding=bindingOf(bindingInput);if(!b2bUuid(id))fail(400,'INVALID_GUIDE_ID');const a=await this.boundary(token,kind,binding,'READ');
    return this.store.transaction(async tx=>{await a.fresh();const d=this.own(await tx.get(id),binding,a.clientId,a.actorKey);await a.fresh();return view(d);});
  }
  async list(token:string,kind:Kind,bindingInput:unknown,limit:number=10,after:string|null=null){
    const binding=bindingOf(bindingInput);if(!Number.isSafeInteger(limit)||limit<1||limit>10||after!==null&&!b2bUuid(after))fail(400,'INVALID_GUIDE_PAGE');const a=await this.boundary(token,kind,binding,'READ');
    return this.store.transaction(async tx=>{await a.fresh();const rows=await tx.list(a.clientId,a.actorKey,[binding],limit+1,after);
      if(!Array.isArray(rows)||rows.length>limit+1||new Set(rows.map(r=>r.id)).size!==rows.length||rows.some((r,i)=>after!==null&&r.id<=after||i>0&&r.id<=rows[i-1].id))fail(409,'GUIDE_PAGE_INCONSISTENT');
      const items=rows.slice(0,limit).map(r=>view(this.own(r,binding,a.clientId,a.actorKey)));await a.fresh();return{items,page:{limit,hasMore:rows.length>limit,nextAfter:rows.length>limit?items.at(-1)!.id:null,consistency:'LIVE_KEYSET_NOT_A_SNAPSHOT'}};});
  }
  async operation(token:string,kind:Kind,bindingInput:unknown,id:string){
    const binding=bindingOf(bindingInput);if(!b2bUuid(id))fail(400,'INVALID_GUIDE_OPERATION_ID');const a=await this.boundary(token,kind,binding,'OPERATION');
    return this.store.transaction(async tx=>{await a.fresh();const op=await tx.operation(id,a.clientId,a.actorKey);if(!op||op.id!==id||op.clientId!==a.clientId||op.actorKey!==a.actorKey)fail(404,'GUIDE_OPERATION_NOT_FOUND');const current=this.own(await tx.get(op.draftId),binding,a.clientId,a.actorKey);this.receipt(op,current,binding);await a.fresh();return operationView(op,binding);});
  }
}
