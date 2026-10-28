import { ForbiddenException,NotFoundException,ServiceUnavailableException } from '@nestjs/common';
import { X509Certificate } from 'node:crypto';
import type { ProductionGuidesIssued as Issued,ProductionGuidesSnapshot as Snapshot,ProductionGuidesGrant as Grant,ProductionGuidesOwnerPort,ProductionGuidesVerifier,ProductionGuidesReadPort,ProductionGuidesReference09,ProductionGuidesArtifactKind as Kind } from '@factuez/contracts/production-guides';
import { buildProductionGuidesXml,validateProductionGuidesSnapshot,productionGuidesHash as hash,productionGuidesBytesHash as bytesHash,productionGuidesExact as exact,productionGuidesUuid } from '@factuez/sunat-core/dist/production-guides';
import { parseSafeInvoice,verifyLocalSignedInvoice } from './infrastructure/crypto/xml-signer.service';
import { productionTransportXml } from './infrastructure/sunat/production-transport-zip';
import { verifyGuideCdrEvidence } from './application/guide-cdr-evidence';
import type { CdrSignatureTrustService } from './infrastructure/crypto/cdr-signature-trust.service';
import type { ProductionGuidesCrypto } from './production-guides-crypto';
import type { ProductionGuidesTransport } from './production-guides-transport';
import { ProductionGuidesStore,type ProductionGuidesJob } from './production-guides-store';
export type ProductionGuidesSunatOptions={enabled:()=>boolean;owner:ProductionGuidesOwnerPort;ownerVerifier:ProductionGuidesVerifier;
 referenceOwner:(requester:Snapshot)=>Promise<Issued>;crypto:ProductionGuidesCrypto;transport:ProductionGuidesTransport;cdr:Pick<CdrSignatureTrustService,'verify'>;
 pdf:(snapshot:Snapshot,result:ProductionGuidesJob['result'],manifest:NonNullable<ProductionGuidesJob['manifest']>)=>Promise<Buffer>;now?:()=>string};
/** No bootstrap side effects. Main wires the explicit outbox/worker adapters to these capabilities. */
export class ProductionGuidesService implements ProductionGuidesReadPort {
 constructor(private readonly store:ProductionGuidesStore,private readonly options?:ProductionGuidesSunatOptions){if(options&&store.source!==options.transport.source)throw Error('GRE_SOURCE_MISMATCH');}
 private enabled(){if(!this.options?.enabled())throw new ServiceUnavailableException('Guías productivas SUNAT deshabilitadas');return this.options;}
 private check(e:Issued){
  const o=this.enabled();exact(e,['eventId','eventType','snapshot','snapshotSha256','seal']);productionGuidesUuid(e.eventId);
  const {seal,...payload}=e;if(e.eventType!=='billing.production-guides.issued.v1'||!o.ownerVerifier.verify(payload,seal,'ISSUED'))throw new ForbiddenException('Firma de Billing inválida');
  const s=validateProductionGuidesSnapshot(e.snapshot);if(hash(s)!==e.snapshotSha256)throw new ForbiddenException('Snapshot inválido');return s;
 }
 private grant(s:Snapshot,g:Grant){
  const {companyId,issuerRuc,branchId,pointId,seriesCounterId,establishmentCode}=g;
  if(hash(s.scope)!==hash({companyId,issuerRuc,branchId,pointId,seriesCounterId,establishmentCode})||g.actorId!==s.actorId||g.version!==s.grantVersion||g.enabled!==true||!g.profiles.includes(s.profile)||Date.parse(g.expiresAt)<=Date.parse(this.options?.now?.()??new Date().toISOString()))throw new ForbiddenException('Concesión GRE cambió');
 }
 async admit(snapshot:Snapshot,grant:Grant){
  const o=this.enabled(),s=validateProductionGuidesSnapshot(snapshot);this.grant(s,grant);
  const ref=s.documentType==='31'?await o.owner.reference09(s):undefined;buildProductionGuidesXml(s,ref);await o.crypto.ready(s,grant);
 }
 async ingest(raw:Issued){
  const e=structuredClone(raw),s=this.check(e),g=await this.enabled().owner.current(e);this.grant(s,g);await this.admit(s,g);return (await this.store.ingest(e)).result;
 }
 private async own(j:ProductionGuidesJob){const s=this.check(j.event),g=await this.enabled().owner.current(j.event);this.grant(s,g);if(hash(s)!==j.snapshotSha256)throw Error('GRE_JOB_BINDING_INVALID');return {s,g};}
 private async readable(e:Issued){
  this.check(e);await this.enabled().owner.current(e);const j=await this.store.get(e.snapshot.documentId);if(!j||hash(j.event)!==hash(e))throw new NotFoundException();return j;
 }
 async process(id:string){
  const o=this.enabled();let j=await this.store.get(id);if(!j)throw new NotFoundException();await this.own(j);
  j=await this.store.prepare(id,async job=>{
   const {s,g}=await this.own(job),reference=s.documentType==='31'?await o.owner.reference09(s):undefined;
   const unsigned=buildProductionGuidesXml(s,reference);const signed=await o.crypto.sign(s,g,unsigned.xml);
   if(bytesHash(signed.xml)!==signed.xmlSha256||bytesHash(signed.zip)!==signed.zipSha256||signed.fingerprint!==g.certificateFingerprint)throw Error('GRE_SIGNED_MANIFEST_INVALID');
   const name=`${s.issuer.ruc}-${s.documentType}-${s.series}-${s.number}`;
   if(!productionTransportXml(signed.zip,name+'.xml').xml.equals(signed.xml))throw Error('GRE_PACKING_MISMATCH');
   return {manifest:{unsignedXml:unsigned.xml,fingerprint:signed.fingerprint,digest:signed.digest,...(reference?{reference}:{})},xmlSha256:signed.xmlSha256,zipSha256:signed.zipSha256,
    artifacts:[{kind:'signed-xml',artifact:{name:name+'.xml',mediaType:'application/xml',bytes:signed.xml,sha256:signed.xmlSha256}},{kind:'submission-zip',artifact:{name:name+'.zip',mediaType:'application/zip',bytes:signed.zip,sha256:signed.zipSha256}}]};
  });
  if(j.state==='PREPARED'){
   // Revalidate current owner/config before consuming the single durable POST capability.
   const {g}=await this.own(j);await o.crypto.ready(j.event.snapshot,g);
   const zip=await this.store.artifact(id,'submission-zip');const attempt=await this.store.beginPost(id);
   if(attempt){try{
    const current=await this.own(attempt);const sent=await o.transport.submit(current.g,{fileName:zip.name,xmlSha256:attempt.result.xmlSha256!,zipSha256:zip.sha256,zip:zip.bytes});
    j=await this.store.attachTicket(id,attempt.attemptId!,sent.ticket);
   }catch{j=(await this.store.get(id))!;/* UNKNOWN is durable, no automatic replay or reset. */}}
   else j=(await this.store.get(id))!;
  }
  if(j.state==='TICKET')return (await this.poll(j)).result;
  return j.result;
 }
 private async poll(j:ProductionGuidesJob){
  const o=this.enabled(),{s,g}=await this.own(j);const response=await o.transport.ticket(g,j.ticket!);
  if(response.state==='PENDING')return j;
  if(response.state==='FAILED_NO_CDR')return this.store.finish(j.documentId,j.ticket!,{state:'FAILED_NO_CDR'},[]);
  if(!response.cdrZip)throw Error('GRE_CDR_MISSING');
  const zip=Buffer.from(response.cdrZip),expected={issuerRuc:s.issuer.ruc,documentType:s.documentType,fullNumber:`${s.series}-${s.number}`,requestXmlSha256:j.result.xmlSha256!,requestZipSha256:j.result.zipSha256!,issuedAt:(s.body as any).issueDate,receivedAt:o.now?.()??new Date().toISOString(),source:'EXTERNAL_CDR' as const};
  const evidence=await verifyGuideCdrEvidence(expected,zip,o.cdr),xml=productionTransportXml(zip,evidence.cdrFileName,true).xml;
  const base=evidence.cdrFileName.slice(0,-4);
  return this.store.finish(j.documentId,j.ticket!,{state:evidence.status,cdrZipSha256:evidence.cdrZipSha256,officialCdrVerified:o.transport.source==='SUNAT_OFFICIAL'},[
   {kind:'cdr-xml',artifact:{name:evidence.cdrFileName,mediaType:'application/xml',sha256:bytesHash(xml),bytes:xml}},
   {kind:'cdr-zip',artifact:{name:base+'.zip',mediaType:'application/zip',sha256:bytesHash(zip),bytes:zip}}],{...evidence,source:o.transport.source,ticket:j.ticket,requestHashesBoundByCdr:false});
 }
 /** Exact authenticated public09 owner + stored official CDR, cross-RUC visibility is constrained by Billing. */
 async reference09(requester:Snapshot):Promise<ProductionGuidesReference09>{
  const o=this.enabled(),request=validateProductionGuidesSnapshot(requester);if(request.documentType!=='31')throw Error('GRE_REFERENCE_REQUEST_INVALID');
  const e=await o.referenceOwner(request),s=this.check(e);if(s.profile!=='GRE09_PUBLIC01_V1'||s.documentType!=='09')throw Error('GRE_REFERENCE_PROFILE_INVALID');
  const j=await this.store.get(s.documentId);if(!j||hash(j.event)!==hash(e)||j.result.source!=='SUNAT_OFFICIAL'||!j.result.officialCdrVerified||!['ACCEPTED','ACCEPTED_WITH_OBSERVATIONS'].includes(j.state))throw Error('GRE_REFERENCE_NOT_OFFICIAL');
  await this.originals(j);const cdr=await this.store.artifact(s.documentId,'cdr-zip');
  const evidence=await verifyGuideCdrEvidence({issuerRuc:s.issuer.ruc,documentType:'09',fullNumber:`${s.series}-${s.number}`,requestXmlSha256:j.result.xmlSha256!,requestZipSha256:j.result.zipSha256!,issuedAt:(s.body as any).issueDate,receivedAt:j.evidence.receivedAt,source:'EXTERNAL_CDR'},cdr.bytes,o.cdr);
  if(evidence.cdrZipSha256!==j.result.cdrZipSha256||evidence.status!==j.state)throw Error('GRE_REFERENCE_CDR_CHANGED');
  const b=s.body as any,projection={schemaVersion:'factuez.carrier-reference09-owner.v1',documentId:s.documentId,documentType:'09',issuer:s.issuer,series:s.series,number:s.number,
   ...Object.fromEntries(['issueDate','transferDate','sender','recipient','origin','destination','carrier','grossWeight','weightUnit','items','transportMode','regulatedGoods'].map(k=>[k,b[k]]))};
  const proof:ProductionGuidesReference09={snapshot:s,projection,projectionSha256:hash(projection),cdrZipSha256:cdr.sha256,source:'SUNAT_OFFICIAL',signatureTrusted:true,state:j.state as 'ACCEPTED'|'ACCEPTED_WITH_OBSERVATIONS',acceptedAt:evidence.receivedAt};
  // Apply the same full reference matcher used by the production renderer.
  buildProductionGuidesXml(request,proof);return proof;
 }
 /** Reconciliation only: protected operator supplies a recovered ticket; no POST is ever reissued. */
 async reconcileUnknown(id:string,ticket:string){
  const j=await this.store.get(id);if(!j||j.state!=='UNKNOWN'||!j.attemptId)throw Error('GRE_NOT_UNKNOWN');const {g}=await this.own(j);
  // Check ticket exists for the RUC before attaching; final identity comes from the signed CDR.
  await this.enabled().transport.ticket(g,ticket);return (await this.store.attachTicket(id,j.attemptId,ticket)).result;
 }
 async status(e:Issued){return (await this.readable(e)).result;}
 private async originals(j:ProductionGuidesJob){
  if(!j.manifest)throw Error('GRE_ORIGINAL_UNAVAILABLE');
  if(buildProductionGuidesXml(j.event.snapshot,j.manifest.reference as ProductionGuidesReference09|undefined).xml!==j.manifest.unsignedXml)throw Error('GRE_OWNER_XML_MISMATCH');
  const xml=await this.store.artifact(j.documentId,'signed-xml'),zip=await this.store.artifact(j.documentId,'submission-zip');
  if(xml.sha256!==j.result.xmlSha256||zip.sha256!==j.result.zipSha256||!productionTransportXml(zip.bytes,xml.name).xml.equals(xml.bytes))throw Error('GRE_ORIGINAL_BINDING_INVALID');
  const parsed=parseSafeInvoice(xml.bytes.toString('utf8'),'DespatchAdvice'),certs=parsed.document.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#','X509Certificate');
  if(certs.length!==1)throw Error('GRE_SIGNER_INVALID');const cert=new X509Certificate(Buffer.from((certs[0].textContent??'').replace(/\s/g,''),'base64'));
  if(cert.fingerprint256.replaceAll(':','').toLowerCase()!==j.manifest.fingerprint||verifyLocalSignedInvoice(xml.bytes.toString('utf8'),cert.toString(),j.manifest.unsignedXml,'DespatchAdvice')!==j.manifest.digest)throw Error('GRE_ORIGINAL_SIGNATURE_INVALID');
  return {xml,zip};
 }
 async artifact(e:Issued,kind:Kind){
  const j=await this.readable(e);if(!['signed-xml','submission-zip','cdr-xml','cdr-zip'].includes(kind))throw Error('GRE_ARTIFACT_KIND_INVALID');
  await this.originals(j);const a=await this.store.artifact(j.documentId,kind);
  if(kind.startsWith('cdr-')){const c=await this.store.artifact(j.documentId,'cdr-zip'),x=await this.store.artifact(j.documentId,'cdr-xml');if(c.sha256!==j.result.cdrZipSha256||!productionTransportXml(c.bytes,x.name,true).xml.equals(x.bytes)||!await this.enabled().cdr.verify(x.bytes))throw Error('GRE_CDR_ORIGINAL_INVALID');}
  return a;
 }
 async pdf(e:Issued){const j=await this.readable(e);await this.originals(j);if(j.result.officialCdrVerified){await this.artifact(e,'cdr-zip');}const pdf=await this.enabled().pdf(e.snapshot,j.result,j.manifest!);if(!Buffer.isBuffer(pdf)||pdf.length>8*1024*1024||pdf.subarray(0,5).toString()!=='%PDF-')throw Error('GRE_PDF_INVALID');return pdf;}
 /** Opt-in bounded worker tick; main owns scheduling/queue lifecycle and signed-event delivery. */
 async tick(limit=20){const result=[];for(const row of await this.store.pending(limit)){try{result.push(await this.process(row.documentId));}catch{result.push({documentId:row.documentId,state:'REQUIRES_REVIEW'});}}return result;}
}
