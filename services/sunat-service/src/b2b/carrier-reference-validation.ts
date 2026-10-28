import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {boundedSupplementJson} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import {fiscalSnapshotSha256 as hash} from '@factuez/sunat-core/dist/fiscal-note';
import {projectPublicGuide09OwnerSnapshot,validatePublicGuide09OwnerSnapshot,type PublicGuide09OwnerSnapshot} from '@factuez/sunat-core/dist/public-guide-profile';
import type {CarrierReference09Evidence} from '@factuez/sunat-core/dist/carrier-guide-profile';
import {CarrierReferenceCryptoVerifier,type CarrierReferenceVerifyInput,type CarrierReferenceSignerPins} from '../application/carrier-reference-verifier';
import type {BetaIssuerPublicCertificates} from '../infrastructure/crypto/beta-owner-xml-trust';
import type {CertificateTrustService} from '../infrastructure/crypto/certificate-trust.service';
import type {CdrSignatureTrustService} from '../infrastructure/crypto/cdr-signature-trust.service';
import type {PrismaService} from '../infrastructure/prisma.service';
import {XSD_PROFILE,XSD_ARCHIVE_SHA256,type XsdValidationService} from '../infrastructure/sunat/xsd-validation.service';
import {parseSafeInvoice} from '../infrastructure/crypto/xml-signer.service';

export const carrierReferenceLimits=Object.freeze({artifact:384*1024,snapshot:64*1024,request:2*1024*1024,response:8192,freshMs:30000});
export class CarrierReferenceValidationError extends Error {constructor(){super('CARRIER_REFERENCE_VALIDATION_UNAVAILABLE');}}
export function referenceRequire(ok:unknown):asserts ok{if(!ok)throw new CarrierReferenceValidationError();}
export const referenceSha=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
export const REFERENCE_SHA=/^[a-f0-9]{64}$/;
export function referenceRecord(v:any,keys:string[]){
 referenceRequire(v&&typeof v==='object'&&!types.isProxy(v)&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===keys.length);
 const d=Object.getOwnPropertyDescriptors(v);referenceRequire(keys.every(k=>Object.hasOwn(d,k))&&Object.values(d).every(p=>p.enumerable&&'value'in p));
}
export function normalizeCarrierReference(input:Readonly<CarrierReferenceVerifyInput>):CarrierReferenceVerifyInput{
 referenceRecord(input,['ownerSnapshot','ownerSnapshotSha256','projection','projectionSha256','signedXml','signedXmlSha256','cdrXml','cdrSha256']);
 for(const bytes of [input.signedXml,input.cdrXml])referenceRequire(bytes instanceof Uint8Array&&!types.isProxy(bytes)&&bytes.byteLength>0&&bytes.byteLength<=carrierReferenceLimits.artifact);
 const ownerSnapshot=validatePublicGuide09OwnerSnapshot(input.ownerSnapshot),projection=projectPublicGuide09OwnerSnapshot(ownerSnapshot);
 referenceRequire(Buffer.byteLength(JSON.stringify(ownerSnapshot))<=carrierReferenceLimits.snapshot);
 // Existing serializer records whole seconds. Reject unrepresentable fractions, never round an issuance time silently.
 referenceRequire(/\.000Z$/.test(ownerSnapshot.body.issueDate));
 const actualProjection=boundedSupplementJson(input.projection);
 for(const digest of [input.ownerSnapshotSha256,input.projectionSha256,input.signedXmlSha256,input.cdrSha256])referenceRequire(typeof digest==='string'&&REFERENCE_SHA.test(digest));
 const signedXml=Buffer.from(input.signedXml),cdrXml=Buffer.from(input.cdrXml);
 referenceRequire(hash(ownerSnapshot)===input.ownerSnapshotSha256&&hash(projection)===input.projectionSha256&&hash(actualProjection)===hash(projection)&&
  referenceSha(signedXml)===input.signedXmlSha256&&referenceSha(cdrXml)===input.cdrSha256);
 for(const xml of [signedXml,cdrXml])referenceRequire(Buffer.from(xml.toString('utf8')).equals(xml));
 return {ownerSnapshot,ownerSnapshotSha256:input.ownerSnapshotSha256,projection,projectionSha256:input.projectionSha256,signedXml,signedXmlSha256:input.signedXmlSha256,cdrXml,cdrSha256:input.cdrSha256};
}
export interface CarrierReferenceOwnedBinding {
 ownerSnapshot:PublicGuide09OwnerSnapshot;signedXmlSha256:string;cdrSha256:string;digestValue:string;revision:string;
}
export type CarrierReferenceOwnerQuery={documentId:string;issuerRuc:string;ownerSnapshotSha256:string};
/** Independent authoritative owner row. Never resolve a URL/path/table/provider from a request. */
export interface CarrierReferenceOwnerBindingPort {current(query:Readonly<CarrierReferenceOwnerQuery>):Promise<CarrierReferenceOwnedBinding>}
/** Strict existing SUNAT projection only. A different immutablePayload profile,
 * missing original CDR_XML, pending/UNKNOWN status or missing digest fails closed.
 * This adapter does not invent a public09 record from an older/private guide. */
export class PrismaCarrierReferenceOwnerBinding implements CarrierReferenceOwnerBindingPort {
 constructor(private readonly db:Pick<PrismaService,'fiscalDocument'>){}
 async current(q:Readonly<CarrierReferenceOwnerQuery>):Promise<CarrierReferenceOwnedBinding>{
  try{
   const row=await this.db.fiscalDocument.findFirst({where:{documentId:q.documentId,issuerRuc:q.issuerRuc,environment:'BETA',documentType:'09'},
    select:{documentId:true,issuerRuc:true,environment:true,documentType:true,series:true,number:true,status:true,immutablePayload:true,digestValue:true,updatedAt:true,
     artifacts:{where:{kind:{in:['SIGNED_XML','CDR_XML']}},select:{kind:true,sha256:true}}}});
   referenceRequire(row&&row.environment==='BETA'&&row.documentType==='09'&&row.documentId===q.documentId&&row.issuerRuc===q.issuerRuc&&['ACCEPTED','ACCEPTED_WITH_OBSERVATIONS'].includes(row.status));
   const ownerSnapshot=validatePublicGuide09OwnerSnapshot(row.immutablePayload),xml=row.artifacts.filter(a=>a.kind==='SIGNED_XML'),cdr=row.artifacts.filter(a=>a.kind==='CDR_XML');
   referenceRequire(hash(ownerSnapshot)===q.ownerSnapshotSha256&&ownerSnapshot.documentId===row.documentId&&ownerSnapshot.issuer.ruc===row.issuerRuc&&ownerSnapshot.series===row.series&&ownerSnapshot.number===String(row.number)&&
    row.artifacts.length===2&&xml.length===1&&cdr.length===1&&row.digestValue&&/^[A-Za-z0-9+/]{43}=$/.test(row.digestValue)&&REFERENCE_SHA.test(xml[0].sha256)&&REFERENCE_SHA.test(cdr[0].sha256));
   return {ownerSnapshot,signedXmlSha256:xml[0].sha256,cdrSha256:cdr[0].sha256,digestValue:row.digestValue,revision:hash({updatedAt:row.updatedAt.toISOString(),status:row.status,ownerSnapshot,artifacts:[{kind:xml[0].kind,sha256:xml[0].sha256},{kind:cdr[0].kind,sha256:cdr[0].sha256}],digest:row.digestValue})};
  }catch{throw new CarrierReferenceValidationError();}
 }
}
export interface CarrierReferenceValidationDependencies {
 owner:CarrierReferenceOwnerBindingPort;pins:CarrierReferenceSignerPins;certificates:BetaIssuerPublicCertificates;
 trust:Pick<CertificateTrustService,'evaluate'>;cdr:Pick<CdrSignatureTrustService,'verify'>;
 /** Optional additional schema validator; success must bind the exact XML SHA, not an approved flag. */
 xsd?:Pick<XsdValidationService,'validate'>;
 now?:()=>string;
}
function ownedBinding(value:CarrierReferenceOwnedBinding,input:CarrierReferenceVerifyInput){
 referenceRecord(value,['ownerSnapshot','signedXmlSha256','cdrSha256','digestValue','revision']);
 const ownerSnapshot=validatePublicGuide09OwnerSnapshot(value.ownerSnapshot);
 referenceRequire(hash(ownerSnapshot)===input.ownerSnapshotSha256&&value.signedXmlSha256===input.signedXmlSha256&&value.cdrSha256===input.cdrSha256&&
  typeof value.digestValue==='string'&&/^[A-Za-z0-9+/]{43}=$/.test(value.digestValue)&&typeof value.revision==='string'&&REFERENCE_SHA.test(value.revision));
 return {...value,ownerSnapshot};
}
/** Structurally implements Billing CarrierReferenceSignatureCdrValidator without
 * importing Billing code/DB. All crypto and parsing remain with SUNAT. No send. */
export class CarrierReferenceValidation {
 #deps:CarrierReferenceValidationDependencies;#now:()=>string;
 constructor(deps:CarrierReferenceValidationDependencies){
  referenceRequire(deps&&typeof deps.owner?.current==='function'&&typeof deps.pins?.current==='function'&&typeof deps.certificates?.load==='function'&&typeof deps.trust?.evaluate==='function'&&typeof deps.cdr?.verify==='function'&&(!deps.xsd||typeof deps.xsd.validate==='function'));
  this.#deps={...deps};this.#now=deps.now??(()=>new Date().toISOString());
 }
 async verify(raw:Readonly<CarrierReferenceVerifyInput>):Promise<CarrierReference09Evidence['acceptance']>{
  try{
   const input=normalizeCarrierReference(raw),original=hash({...input,signedXml:input.signedXmlSha256,cdrXml:input.cdrSha256}),d=this.#deps;
   const query={documentId:input.ownerSnapshot.documentId,issuerRuc:input.ownerSnapshot.issuer.ruc,ownerSnapshotSha256:input.ownerSnapshotSha256};
   const before=ownedBinding(await d.owner.current({...query}),input),asOf=this.#now();
   referenceRequire(Number.isFinite(Date.parse(asOf))&&new Date(asOf).toISOString()===asOf&&Date.parse(input.ownerSnapshot.body.issueDate)<=Date.parse(asOf));
   if(d.xsd){const proof=await d.xsd.validate(Buffer.from(input.signedXml),'DespatchAdvice');referenceRequire(proof&&proof.xmlSha256===input.signedXmlSha256&&proof.profile===XSD_PROFILE&&proof.archiveSha256===XSD_ARCHIVE_SHA256&&Number.isFinite(Date.parse(proof.verifiedAt)));}
   const acceptance=await new CarrierReferenceCryptoVerifier(d.pins,d.certificates,d.trust,d.cdr,()=>asOf).verify(input);
   const signed=parseSafeInvoice(Buffer.from(input.signedXml).toString('utf8'),'DespatchAdvice');
   const values=signed.document.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#','DigestValue');
   referenceRequire(values.length===1&&values[0].textContent===before.digestValue);
   const after=ownedBinding(await d.owner.current({...query}),input);
   referenceRequire(hash(before)===hash(after)&&hash({...normalizeCarrierReference(raw),signedXml:referenceSha(raw.signedXml),cdrXml:referenceSha(raw.cdrXml)})===original);
   referenceRequire(Date.parse(this.#now())-Date.parse(asOf)>=0&&Date.parse(this.#now())-Date.parse(asOf)<=carrierReferenceLimits.freshMs);
   return validateCarrierReferenceAcceptance(acceptance,input,this.#now());
  }catch{throw new CarrierReferenceValidationError();}
 }
}
export function validateCarrierReferenceAcceptance(value:CarrierReference09Evidence['acceptance'],input:CarrierReferenceVerifyInput,now:string){
 referenceRecord(value,['environment','documentId','issuerRuc','fullNumber','snapshotSha256','cdrSha256','responseCode','status','acceptedAt']);
 referenceRequire(value.environment==='BETA'&&value.documentId===input.ownerSnapshot.documentId&&value.issuerRuc===input.ownerSnapshot.issuer.ruc&&value.fullNumber===`${input.ownerSnapshot.series}-${input.ownerSnapshot.number}`&&
  value.snapshotSha256===input.projectionSha256&&value.cdrSha256===input.cdrSha256&&value.responseCode==='0'&&['ACCEPTED','ACCEPTED_WITH_OBSERVATIONS'].includes(value.status)&&
  typeof value.acceptedAt==='string'&&Number.isFinite(Date.parse(value.acceptedAt))&&new Date(value.acceptedAt).toISOString()===value.acceptedAt&&Date.parse(value.acceptedAt)>=Date.parse(input.ownerSnapshot.body.issueDate)&&Date.parse(value.acceptedAt)<=Date.parse(now));
 return Object.freeze({...value});
}
