import { createHash, randomUUID } from 'node:crypto';
import { B2bSecurityError, b2bBindingsContain, b2bBindingKey, validB2bBinding, validB2bPrincipal,
  type B2bIdentityScope, type B2bPrincipal } from './email-deliveries.security';
import { B2bOwnerReadFrame, type B2bIdentityPort } from '@factuez/service-access/dist/b2b-read-adapter';
import type { EmailDeliveryAccess, EmailDeliveryAction, EmailDeliveryActor, EmailDeliveryAttachment,
  EmailDeliveryDocument, EmailDeliveryDocumentSource, EmailDeliveryExecutionAuthority, EmailDeliveryJob,
  EmailDeliveryStore, EmailDeliveryTransaction, EmailDeliveryCaptureTransport, EmailDeliveryCorporateTransport,
  EmailDeliveryProfile, EmailDeliveryView, EmailDeliveryCorporateAuthorization, EmailDeliveryAttachmentMetadata } from './email-deliveries.types';
export * from './email-deliveries.types';
export { PostgresEmailDeliveryStore, createPostgresEmailDeliveryStore } from './email-deliveries.store';
export { OwnerEmailDeliveryDocumentSource } from './email-deliveries.source';

export const emailDeliveryCodes = [
  'EMAIL_DISABLED','INVALID_REQUEST','INVALID_PRINCIPAL','ACCESS_CHANGED','RESOURCE_NOT_FOUND',
  'IDEMPOTENCY_CONFLICT','EMAIL_STORE_UNAVAILABLE','EMAIL_REVISION_CONFLICT','EMAIL_OWNER_UNAVAILABLE',
  'EMAIL_CAPTURE_DISABLED','EMAIL_ARTIFACT_INTEGRITY','EMAIL_CAPTURE_UNAVAILABLE','EMAIL_PRIVATE_PEER_REQUIRED',
  'EMAIL_CORPORATE_DISABLED','EMAIL_REAL_SEND_FORBIDDEN','EMAIL_SMTP_CONFIGURATION_UNAVAILABLE',
  'EMAIL_SMTP_CONFIGURATION_CHANGED','EMAIL_SMTP_POLICY','EMAIL_ATTEMPT_CHANGED',
] as const;
export const emailFail = (status: number, code: typeof emailDeliveryCodes[number]): never => { throw new B2bSecurityError(status,code); };
export function emailError(error: unknown): B2bSecurityError {
  const e=error as {status?:unknown;code?:unknown}|null;
  return e && typeof e.code==='string' && typeof e.status==='number' && [400,401,403,404,409,503].includes(e.status) && (emailDeliveryCodes as readonly string[]).includes(e.code)
    ? new B2bSecurityError(e.status as number,e.code as string) : new B2bSecurityError(503,'EMAIL_OWNER_UNAVAILABLE');
}
export const emailUuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
export const emailHash = (v: string|Uint8Array): string => createHash('sha256').update(v).digest('hex');
export const emailActor = ({kind,clientId,revision,subjectId,userAuthRevision}: B2bPrincipal): EmailDeliveryActor =>
  ({kind,clientId,revision,subjectId,userAuthRevision});
export const emailActorKey = (p: EmailDeliveryActor) => JSON.stringify([p.kind,p.clientId,p.subjectId]);
export const emailSameActor = (a: EmailDeliveryActor,b: EmailDeliveryActor) =>
  emailActorKey(a)===emailActorKey(b)&&a.revision===b.revision&&a.userAuthRevision===b.userAuthRevision;
export const emailSameCorporateAuthorization = (a: EmailDeliveryCorporateAuthorization,b?: EmailDeliveryCorporateAuthorization) =>
  !!b&&a.grantId===b.grantId&&a.grantRevision===b.grantRevision&&a.configurationRevision===b.configurationRevision&&
    a.configurationSnapshotId===b.configurationSnapshotId;
const sameAttachments=(a:EmailDeliveryAttachmentMetadata[],b:EmailDeliveryAttachmentMetadata[])=>
  a.length===b.length&&a.every((v,i)=>v.kind===b[i].kind&&v.fileName===b[i].fileName&&v.mediaType===b[i].mediaType&&
    v.sha256===b[i].sha256&&v.byteLength===b[i].byteLength&&v.representation===b[i].representation&&v.sourceProofSha256===b[i].sourceProofSha256);
export function emailObject(v: unknown, fields: string[]): Record<string,any> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== fields.sort().join(',')) emailFail(400,'INVALID_REQUEST');
  return v as Record<string,any>;
}
const required = (action: EmailDeliveryAction, corporate = false): B2bIdentityScope[] =>
  [action === 'CREATE'?'b2b:email:send':'b2b:email:read','b2b:documents:read',...(corporate?['b2b:artifacts:read' as const]:[])];
const view = (j: EmailDeliveryJob, replayed = false): EmailDeliveryView => ({
  schemaVersion:'factuez.b2b.email-deliveries.v1',environment:'BETA',candidateOnly:true,
  id:j.id,documentId:j.documentId,binding:structuredClone(j.binding),format:j.format,state:j.state,profile:j.profile,
  revision:j.revision,createdAt:j.createdAt,updatedAt:j.updatedAt,errorCode:j.errorCode,attachments:structuredClone(j.attachments),
  deliveredToClient:false,fiscalAuthority:false,replayed,
});
/** Clone and verify all bytes and ownership before crossing the capture boundary. Never modify originals. */
export function checkedEmailDocument(d: EmailDeliveryDocument, j: Pick<EmailDeliveryJob,'binding'|'documentId'>): EmailDeliveryDocument {
  if (!d || !validB2bBinding(d.binding) || b2bBindingKey(d.binding)!==b2bBindingKey(j.binding) ||
    d.documentId!==j.documentId || !/^[a-f0-9]{64}$/.test(d.sourceProofSha256) ||
    typeof d.presentationRevision!=='string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(d.presentationRevision) ||
    !Array.isArray(d.attachments) || d.attachments.length>3) emailFail(409,'EMAIL_ARTIFACT_INTEGRITY');
  const kinds = new Set<string>(); let total = 0;
  const attachments = d.attachments.map(a => {
    if (!a || !['PDF','XML','CDR'].includes(a.kind) || kinds.has(a.kind) ||
      a.documentId!==j.documentId || !validB2bBinding(a.binding) || b2bBindingKey(a.binding)!==b2bBindingKey(j.binding) ||
      a.sourceProofSha256!==d.sourceProofSha256 || typeof a.fileName!=='string' ||
      !/^[A-Za-z0-9_-]{1,140}\.(pdf|xml|zip)$/.test(a.fileName) ||
      !(a.bytes instanceof Uint8Array) || !a.bytes.length || a.bytes.length>10*1024*1024 ||
      !/^[a-f0-9]{64}$/.test(a.sha256) || emailHash(a.bytes)!==a.sha256 ||
      (a.kind==='PDF' ? a.representation!=='CURRENT_GENERATED'||a.mediaType!=='application/pdf'||!a.fileName.endsWith('.pdf') :
       a.representation!=='IMMUTABLE_ORIGINAL'||(a.kind==='XML'?a.mediaType!=='application/xml'||!a.fileName.endsWith('.xml'):
       !['application/zip','application/xml'].includes(a.mediaType)||(a.mediaType==='application/zip'?!a.fileName.endsWith('.zip'):!a.fileName.endsWith('.xml')))))
      emailFail(409,'EMAIL_ARTIFACT_INTEGRITY');
    total+=a.bytes.length;kinds.add(a.kind);
    return Object.freeze({...a,binding:Object.freeze(structuredClone(a.binding)),bytes:Buffer.from(a.bytes)});
  });
  if (total>20*1024*1024) emailFail(409,'EMAIL_ARTIFACT_INTEGRITY');
  return Object.freeze({...d,binding:Object.freeze(structuredClone(d.binding)),attachments:Object.freeze(attachments)});
}
function metadata(d: EmailDeliveryDocument) {
  return d.attachments.map(({kind,fileName,mediaType,sha256,bytes,representation,sourceProofSha256}) =>
    ({kind,fileName,mediaType,sha256,byteLength:bytes.length,representation,sourceProofSha256}));
}
export class B2bEmailDeliveries {
  private closed = false;
  private activeOperations=0;
  private idleWaiters:(()=>void)[]=[];
  private closing?:Promise<void>;
  private readonly enabled: boolean;
  private readonly profile: EmailDeliveryProfile;
  constructor(private readonly store: EmailDeliveryStore, private readonly identity: B2bIdentityPort,
    private readonly source: EmailDeliveryDocumentSource, private readonly transport: EmailDeliveryCaptureTransport|EmailDeliveryCorporateTransport|null = null,
    options: {enabled?: boolean; profile?: EmailDeliveryProfile} = {}) {
    this.enabled=options.enabled===true; this.profile=options.profile??'NONE';
    if (!['NONE','LOCAL_CAPTURE','CORPORATE'].includes(this.profile)) emailFail(400,'INVALID_REQUEST');
  }
  private open() { if (!this.enabled || this.closed) emailFail(503,'EMAIL_DISABLED'); }
  private async document(p: B2bPrincipal, j: Pick<EmailDeliveryJob,'binding'|'documentId'|'format'>) {
    return checkedEmailDocument(await this.source.authorizeDocumentCurrent(structuredClone(p),structuredClone(j.binding),j.documentId,j.format),j);
  }
  private owns(p: B2bPrincipal, j: EmailDeliveryJob) {
    if (emailActorKey(p)!==j.actorKey || !b2bBindingsContain(p.bindings,j.binding)) emailFail(404,'RESOURCE_NOT_FOUND');
  }
  private async event(tx: EmailDeliveryTransaction,j: EmailDeliveryJob,type: Parameters<EmailDeliveryTransaction['append']>[0]['type']) {
    await tx.append({id:randomUUID(),jobId:j.id,revision:j.revision,actor:structuredClone(j.actor),at:j.updatedAt,type,attemptId:j.attemptId});
  }
  async execute(access: EmailDeliveryAccess, action: EmailDeliveryAction, input: unknown): Promise<EmailDeliveryView> {
    let admitted=false;
    try {
      this.open();this.activeOperations++;admitted=true;
      const auth=structuredClone(emailObject(access,['token','kind']));
      if (typeof auth.token!=='string'||!/^[A-Za-z0-9._~-]{1,8192}$/.test(auth.token)||!['USER','SERVICE'].includes(auth.kind)||!['CREATE','READ'].includes(action)) emailFail(400,'INVALID_REQUEST');
      const q=structuredClone(emailObject(input,action==='CREATE'?['binding','documentId','recipient','format','idempotencyKey']:['id']));
      if (Buffer.byteLength(JSON.stringify(q))>16384) emailFail(400,'INVALID_REQUEST');
      if (action==='CREATE' && (!validB2bBinding(q.binding)||!emailUuid(q.documentId)||!['ticket','a4'].includes(q.format)||
        typeof q.recipient!=='string'||q.recipient.length>254||! /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(q.recipient)||
        q.recipient.split('@')[0].length>64 || typeof q.idempotencyKey!=='string'||!/^[A-Za-z0-9_-]{16,100}$/.test(q.idempotencyKey))) emailFail(400,'INVALID_REQUEST');
      if (action==='READ'&&!emailUuid(q.id)) emailFail(400,'INVALID_REQUEST');
      const frame=new B2bOwnerReadFrame(this.identity,auth.kind),scopes=required(action,this.profile==='CORPORATE');
      const current=()=>frame.principal(auth.token,scopes);
      const p=await current();
      if (action==='CREATE'&&!b2bBindingsContain(p.bindings,q.binding)) emailFail(404,'RESOURCE_NOT_FOUND');
      const owner=emailActorKey(p),keyHash=action==='CREATE'?emailHash(q.idempotencyKey):'';
      const requestHash=action==='CREATE'?emailHash(JSON.stringify([b2bBindingKey(q.binding),q.documentId,q.recipient,q.format])):'';
      return await this.store.transaction([action==='CREATE'?'email:idem:'+owner+':'+keyHash:'email:job:'+q.id],async tx => {
        await current();
        const prior=action==='CREATE'?await tx.prior(owner,keyHash):await tx.job(q.id);
        if (prior) {
          this.owns(p,prior);
          if (prior.profile!==this.profile) emailFail(409,'IDEMPOTENCY_CONFLICT');
          if (action==='CREATE'&&prior.requestHash!==requestHash) emailFail(409,'IDEMPOTENCY_CONFLICT');
          await this.document(await current(),prior); await current();
          return view(prior,action==='CREATE');
        }
        if (action==='READ') emailFail(404,'RESOURCE_NOT_FOUND');
        const d=await this.document(await current(),{binding:q.binding,documentId:q.documentId,format:q.format}); await current();
        const corporate=this.profile==='CORPORATE'
          ? await this.corporateTransport().authorizeCurrent(await current(),
            {binding:q.binding,documentId:q.documentId,recipient:q.recipient,format:q.format},d) : undefined;
        const at=new Date().toISOString();
        const pending=d.attachments.length!==3;
        const job: EmailDeliveryJob={id:randomUUID(),actorKey:owner,actor:emailActor(p),binding:q.binding,documentId:q.documentId,
          recipient:q.recipient,format:q.format,profile:this.profile,keyHash,requestHash,revision:1,
          state:pending?'WAITING_ARTIFACTS':'QUEUED',createdAt:at,updatedAt:at,attemptId:null,
          errorCode:pending?'ARTIFACTS_PENDING':null,attachments:metadata(d)};
        if (corporate) job.corporate={...corporate,messageId:'<factuez-b2b-'+job.id+'@delivery.factuez.invalid>'};
        await tx.insert(job); await this.event(tx,job,'CREATED'); await current(); return view(job);
      });
    } catch(e) { throw emailError(e); }
    finally{if(admitted)this.operationFinished();}
  }
  private corporateTransport(): EmailDeliveryCorporateTransport {
    if (this.transport?.profile!=='CORPORATE') emailFail(503,'EMAIL_CORPORATE_DISABLED');
    return this.transport as EmailDeliveryCorporateTransport;
  }
  /** One bounded attempt. A durable STARTED journal is committed before any capture operation.
   * DISPATCHING after restart is ambiguous and becomes UNKNOWN; it never triggers automatic capture. */
  async run(jobId: string, authority: EmailDeliveryExecutionAuthority): Promise<EmailDeliveryView> {
    let admitted=false;
    try {
      this.open();this.activeOperations++;admitted=true;
      if (!emailUuid(jobId)||!authority||typeof authority.freshIdentity!=='function') emailFail(400,'INVALID_REQUEST');
      if (this.profile==='CORPORATE') this.corporateTransport();
      else if (this.profile!=='LOCAL_CAPTURE'||this.transport?.profile!=='LOCAL_CAPTURE') emailFail(503,'EMAIL_CAPTURE_DISABLED');
      const fresh=async(j: EmailDeliveryJob) => {
        const scopes=required('CREATE',this.profile==='CORPORATE'),p=await authority.freshIdentity(Object.freeze(structuredClone(j.actor)),Object.freeze(scopes));
        if (!validB2bPrincipal(p)||scopes.some(s=>!p.scopes.includes(s))) emailFail(401,'INVALID_PRINCIPAL');
        this.owns(p,j);
        if (!emailSameActor(p,j.actor)) emailFail(401,'ACCESS_CHANGED');
        return structuredClone(p);
      };
      const claimed=await this.store.transaction(['email:job:'+jobId],async tx => {
        const j=await tx.job(jobId); if (!j) emailFail(404,'RESOURCE_NOT_FOUND');
        const p=await fresh(j!); if (j!.profile!==this.profile) emailFail(503,this.profile==='CORPORATE'?'EMAIL_CORPORATE_DISABLED':'EMAIL_CAPTURE_DISABLED');
        if (['CAPTURED_LOCAL','SMTP_ACCEPTED','UNKNOWN'].includes(j!.state)) return {job:j!,doc:null};
        if (j!.state==='DISPATCHING') {
          const next={...j!,state:'UNKNOWN' as const,revision:j!.revision+1,updatedAt:new Date().toISOString(),
            errorCode:this.profile==='CORPORATE'?'SMTP_OUTCOME_UNKNOWN' as const:'CAPTURE_OUTCOME_UNKNOWN' as const};
          await tx.save(next,j!.revision); await this.event(tx,next,'UNKNOWN'); return {job:next,doc:null};
        }
        const d=await this.document(p,j!); await fresh(j!);
        if (this.profile==='CORPORATE') {
          const authorization=await this.corporateTransport().authorizeCurrent(await fresh(j!),j!,d);
          if (!emailSameCorporateAuthorization(authorization,j!.corporate)) emailFail(409,'EMAIL_SMTP_CONFIGURATION_CHANGED');
        }
        if (d.attachments.length!==3) {
          if (j!.state==='WAITING_ARTIFACTS') return {job:j!,doc:null};
          const next={...j!,state:'WAITING_ARTIFACTS' as const,revision:j!.revision+1,updatedAt:new Date().toISOString(),errorCode:'ARTIFACTS_PENDING' as const,attachments:metadata(d)};
          await tx.save(next,j!.revision); await this.event(tx,next,'WAITING_ARTIFACTS'); return {job:next,doc:null};
        }
        const next={...j!,state:'DISPATCHING' as const,revision:j!.revision+1,updatedAt:new Date().toISOString(),
          attemptId:randomUUID(),errorCode:null,attachments:metadata(d)};
        await tx.save(next,j!.revision); await this.event(tx,next,'ATTEMPT_STARTED'); await fresh(j!);
        return {job:next,doc:d};
      });
      if (!claimed.doc) return view(claimed.job);
      const j=claimed.job;
      let state: 'CAPTURED_LOCAL'|'SMTP_ACCEPTED'|'UNKNOWN'='UNKNOWN';
      try {
        // Last fresh check after durable claim. Re-fetch the current PDF/proof immediately before capture.
        const d=await this.document(await fresh(j),j); await fresh(j);
        if (d.attachments.length!==3 || !sameAttachments(metadata(d),j.attachments) ||
          d.presentationRevision!==claimed.doc.presentationRevision) emailFail(409,'EMAIL_ARTIFACT_INTEGRITY');
        if (this.profile==='CORPORATE') {
          const result=await this.corporateTransport().send(Object.freeze(structuredClone(j)),d,async()=>{
            this.open();
            const currentDocument=await this.document(await fresh(j),j);
            if (currentDocument.attachments.length!==3 || !sameAttachments(metadata(currentDocument),j.attachments) ||
              currentDocument.presentationRevision!==d.presentationRevision) emailFail(409,'EMAIL_ARTIFACT_INTEGRITY');
            await this.store.transaction(['email:job:'+j.id],async tx=>{
              const live=await tx.job(j.id);
              if (live?.state!=='DISPATCHING'||live.attemptId!==j.attemptId||live.revision!==j.revision) emailFail(409,'EMAIL_ATTEMPT_CHANGED');
            });
            return fresh(j);
          });
          if (result?.state==='SMTP_ACCEPTED') state='SMTP_ACCEPTED';
        } else {
        const result=await (this.transport as EmailDeliveryCaptureTransport).capture(Object.freeze({jobId:j.id,attemptId:j.attemptId!,recipient:j.recipient,
          headers:Object.freeze({'X-FactuEz-Delivery-Id':j.id,'X-FactuEz-Profile':'LOCAL_CAPTURE','X-FactuEz-Environment':'BETA'}),
          attachments:d.attachments}));
        if (result?.state==='CAPTURED_LOCAL') state='CAPTURED_LOCAL';
        }
      } catch { /* Any ambiguity, including transport failure, is terminal for automatic execution. */ }
      return await this.store.transaction(['email:job:'+jobId],async tx => {
        const current=await tx.job(jobId); if (!current) emailFail(404,'RESOURCE_NOT_FOUND');
        // A competing recovery worker may already have classified this attempt as UNKNOWN.
        if (current!.state!=='DISPATCHING'||current!.attemptId!==j.attemptId) return view(current!);
        const next={...current!,state,revision:current!.revision+1,updatedAt:new Date().toISOString(),
          errorCode:state==='UNKNOWN'?(this.profile==='CORPORATE'?'SMTP_OUTCOME_UNKNOWN' as const:'CAPTURE_OUTCOME_UNKNOWN' as const):null};
        await tx.save(next,current!.revision); await this.event(tx,next,state); return view(next);
      });
    } catch(e) { throw emailError(e); }
    finally{if(admitted)this.operationFinished();}
  }
  private operationFinished(){this.activeOperations--;if(!this.activeOperations)this.idleWaiters.splice(0).forEach(resolve=>resolve());}
  close():Promise<void>{
    if(this.closing)return this.closing;
    this.closed=true;
    this.closing=(async()=>{
      // SMTP and owner reads can be active BETWEEN SQL transactions. Closing the
      // store before these finish would lose the final journal/acceptance write.
      if(this.activeOperations)await new Promise<void>(resolve=>this.idleWaiters.push(resolve));
      try{await this.store.close();}catch(e){throw emailError(e);}
    })();return this.closing;
  }
}

