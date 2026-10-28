import {inspect} from 'node:util';
import {B2bSecurityError,b2bBindingsContain,b2bBindingKey,validB2bBinding,type B2bBinding,type B2bPrincipal} from '@factuez/contracts/b2b-security';
import {B2bIdentityHttp,type B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {HttpB2bEmailActor,queuedEmailActor} from '@factuez/service-access/dist/b2b-email-actor';
import {adminDigest,adminSnapshot} from '@factuez/service-access/dist/b2b-phase8-admin-wire';
import type {EmailDeliveryDocumentSource,EmailDeliveryAttachment} from './email-deliveries.types';
import {checkedEmailDocument,emailHash} from './email-deliveries';
import {MAILER_READER_SCOPES,type MailerReaderTokens} from './host-reader-token';
type Http=Pick<B2bPrivateHttp,'post'|'file'>;
type Original={id:string;kind:'SIGNED_XML'|'CDR_XML'|'CDR_ZIP';owner:{kind:'DOCUMENT'|'BATCH';id:string};fileName:string;mediaType:'application/xml'|'application/zip';sha256:string;byteLength:number};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const denied=():never=>{throw new B2bSecurityError(409,'EMAIL_ARTIFACT_INTEGRITY');};
const actorOf=({kind,clientId,revision,subjectId,userAuthRevision}:B2bPrincipal)=>queuedEmailActor({kind,clientId,revision,subjectId,userAuthRevision});
/** Concrete readonly source: fresh queued actor AND independently authorized
 * SERVICE reader, Billing snapshots and original SUNAT-owner references. Shared
 * CDRs require closure over every member, not just the requested document. */
export class MailerOwnerDocumentSource implements EmailDeliveryDocumentSource {
 #identity:B2bIdentityHttp;#actor:HttpB2bEmailActor;#closed=false;
 constructor(private readonly billing:Http,private readonly fiscal:Http,identity:Pick<B2bPrivateHttp,'post'>,workerIdentity:Pick<B2bPrivateHttp,'post'>,private readonly tokens:MailerReaderTokens){
  this.#identity=new B2bIdentityHttp(identity as B2bPrivateHttp);this.#actor=new HttpB2bEmailActor(workerIdentity);
 }
 async authorizeDocumentCurrent(p:B2bPrincipal,binding:B2bBinding,documentId:string,format:'ticket'|'a4'){
  if(this.#closed||!uuid(documentId)||!validB2bBinding(binding)||!b2bBindingsContain(p.bindings,binding)||!['ticket','a4'].includes(format))throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');
  if(!['01','03'].includes(binding.documentType))throw new B2bSecurityError(422,'EMAIL_SOURCE_PROFILE_NOT_AVAILABLE');
  const actor=actorOf(p),scopes=['b2b:email:send','b2b:documents:read','b2b:artifacts:read'] as const,started=Date.now();
  let calls=0;
  const bounded=()=>{if(++calls>100||Date.now()-started>45000)throw new B2bSecurityError(413,'NARROW_QUERY');};
  const fresh=async()=>{bounded();const current=await this.#actor.freshIdentity(actor,scopes);if(!b2bBindingsContain(current.bindings,binding))throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');return current;};
  const beforeActor=await fresh(),token=await this.tokens.token();
  const reader=await this.#identity.authenticate(token,[...MAILER_READER_SCOPES],'SERVICE');
  if(reader.scopes.length!==2||!b2bBindingsContain(reader.bindings,binding))throw new B2bSecurityError(403,'EMAIL_READER_SCOPE_DENIED');
  const args={issuerId:String(binding.issuerId),environment:'BETA',id:documentId};
  const context=async(id:string,print=false)=>{
   bounded();const r=adminSnapshot(await this.billing.post('/internal/b2b/read',{kind:'SERVICE',action:print?'print-snapshot':'document',args:{...args,id}},token)) as any;
   if(!r||!validB2bBinding(r.context)||!b2bBindingsContain(reader.bindings,r.context)||!b2bBindingsContain(beforeActor.bindings,r.context)||
    r.document?.id!==id||!/^[a-f0-9]{64}$/.test(r.snapshotSha256)||r.context.issuerId!==binding.issuerId||r.context.issuerRuc!==binding.issuerRuc)denied();
   if(print&&(b2bBindingKey(r.context)!==b2bBindingKey(binding)||!r.snapshot||adminDigest(r.snapshot)!==r.snapshotSha256))denied();
   return r;
  };
  const originals=async()=>{
   bounded();const r=adminSnapshot(await this.fiscal.post('/internal/b2b/fiscal-read',{kind:'SERVICE',action:'artifacts',args},token)) as any;
   if(!r||r.schemaVersion!=='factuez.integration.v1'||!Array.isArray(r.items)||r.items.length>32)denied();
   const found:Original[]=[];const ids=new Set<string>();
   for(const a of r.items){
    if(!['SIGNED_XML','CDR_XML','CDR_ZIP'].includes(a?.kind))continue;
    if(!uuid(a.id)||ids.has(a.id)||a.availability!=='AVAILABLE'||a.representation!=='ORIGINAL'||!a.owner||!['DOCUMENT','BATCH'].includes(a.owner.kind)||!uuid(a.owner.id)||a.kind==='SIGNED_XML'&&a.owner.kind!=='DOCUMENT'||
     a.owner.kind==='DOCUMENT'&&a.owner.id!==documentId||typeof a.fileName!=='string'||!/^[A-Za-z0-9_-]{1,140}\.(xml|zip)$/.test(a.fileName)||
     !/^[a-f0-9]{64}$/.test(a.sha256)||!Number.isSafeInteger(a.byteLength)||a.byteLength<1||a.byteLength>10*1024*1024||
     (a.kind==='CDR_ZIP'?a.mediaType!=='application/zip'||!a.fileName.endsWith('.zip'):a.mediaType!=='application/xml'||!a.fileName.endsWith('.xml')))denied();
    ids.add(a.id);found.push({id:a.id,kind:a.kind,owner:a.owner,fileName:a.fileName,mediaType:a.mediaType,sha256:a.sha256,byteLength:a.byteLength});
   }
   if(found.filter(a=>a.kind==='SIGNED_XML').length>1||found.filter(a=>a.kind==='CDR_XML').length>1||found.filter(a=>a.kind==='CDR_ZIP').length>1)denied();
   const xml=found.find(a=>a.kind==='SIGNED_XML'),cdr=found.find(a=>a.kind==='CDR_ZIP')??found.find(a=>a.kind==='CDR_XML');
   return [xml,cdr].filter((a):a is Original=>!!a);
  };
  const closure=async(list:Original[])=>{
   const result:unknown[]=[];
   for(const id of [...new Set(list.filter(a=>a.owner.kind==='BATCH').map(a=>a.owner.id))]){
    bounded();const batch=adminSnapshot(await this.billing.post('/internal/b2b/read',{kind:'SERVICE',action:'batch',args:{...args,id}},token)) as any;
    if(!batch||!Array.isArray(batch.items)||!batch.items.length||batch.items.length>32||new Set(batch.items.map((i:any)=>i.documentId)).size!==batch.items.length||!batch.items.some((i:any)=>i.documentId===documentId))denied();
    const members=[];
    for(const item of batch.items){if(!uuid(item.documentId))denied();const d=await context(item.documentId);members.push({id:item.documentId,context:d.context,snapshotSha256:d.snapshotSha256});}
    result.push({id,members:members.sort((a,b)=>a.id.localeCompare(b.id))});
   }
   return result;
  };
  const doc=await context(documentId,true),list=await originals(),members=await closure(list);
  const proof=(d:any,a:Original[],m:unknown[])=>adminDigest({context:d.context,snapshotSha256:d.snapshotSha256,presentation:d.presentation,originals:a,members:m});
  const sourceProofSha256=proof(doc,list,members),presentationRevision=adminDigest(doc.presentation),shared={binding:structuredClone(binding),documentId,sourceProofSha256};
  bounded();const pdf=await this.fiscal.file({kind:'SERVICE',action:'pdf',args:{...args,format}},token);
  if(pdf.mediaType!=='application/pdf'||emailHash(pdf.bytes)!==pdf.sha256)denied();
  const attachments:EmailDeliveryAttachment[]=[{...shared,kind:'PDF',representation:'CURRENT_GENERATED',fileName:pdf.fileName,mediaType:'application/pdf',bytes:pdf.bytes,sha256:pdf.sha256}];
  for(const a of list){
   bounded();const f=await this.fiscal.file({kind:'SERVICE',action:'content',args:{...args,id:a.id}},token);
   if(f.fileName!==a.fileName||f.mediaType!==a.mediaType||f.sha256!==a.sha256||f.bytes.length!==a.byteLength||emailHash(f.bytes)!==a.sha256)denied();
   attachments.push({...shared,kind:a.kind==='SIGNED_XML'?'XML':'CDR',representation:'IMMUTABLE_ORIGINAL',fileName:a.fileName,mediaType:a.mediaType,bytes:f.bytes,sha256:a.sha256});
  }
  const afterList=await originals();if(proof(await context(documentId,true),afterList,await closure(afterList))!==sourceProofSha256)denied();
  const afterActor=await fresh(),afterReader=await this.#identity.authenticate(token,[...MAILER_READER_SCOPES],'SERVICE');
  const selection=(v:B2bPrincipal)=>({...actorOf(v),bindings:v.bindings.map(b2bBindingKey).sort()});
  if(adminDigest(selection(afterActor))!==adminDigest(selection(beforeActor))||adminDigest(selection(afterReader))!==adminDigest(selection(reader))||afterReader.scopes.length!==2)denied();
  return checkedEmailDocument({...shared,presentationRevision,attachments},{binding,documentId});
 }
 close(){this.#closed=true;this.tokens.close();}
 toJSON(){return {service:'MailerOwnerDocumentSource',environment:'BETA',source:'BILLING_AND_SUNAT_OWNERS',profiles:['01','03'],credentials:'PRIVATE'};}[inspect.custom](){return this.toJSON();}
}
