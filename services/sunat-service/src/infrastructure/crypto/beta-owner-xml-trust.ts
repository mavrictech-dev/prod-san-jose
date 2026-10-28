import {X509Certificate} from 'node:crypto';
import forge from 'node-forge';
import {certificateRucCandidates} from './certificate-identity';
import {loadPinnedPublicFile,type CertificateTrustService} from './certificate-trust.service';
import {isAbsolute} from 'node:path';
import {verifyLocalSignedInvoice} from './xml-signer.service';
import type {BetaAcceptedDocumentRecord} from '../../application/beta-document-acceptance';
import type {FiscalBatchSnapshot} from '@factuez/sunat-core/dist/fiscal-batch';
import type {XmlRootKind} from './xml-signer.service';
import type {FiscalSupplementEnvelope} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import {betaFiscalIdentity} from './beta-fiscal-package-pipeline';
import {buildFiscalNoteUbl} from '@factuez/sunat-core/dist/fiscal-note';
import {buildFiscalBatchUbl} from '@factuez/sunat-core/dist/fiscal-batch';
import {buildInvoiceUbl} from '@factuez/sunat-core';
import {validateFiscalOriginal,type FiscalNoteContext,type FiscalNoteSnapshot} from '@factuez/sunat-core/dist/fiscal-note';
import type {FiscalDocumentSnapshot} from '@factuez/contracts';
/** Deployment/owner-controlled PUBLIC certificate resolver. Never resolve from request paths or KeyInfo. */
export interface BetaIssuerPublicCertificates {load(ruc:string,fingerprint:string):Promise<{certificatePem:string;chainPems:string[]}>}
export class PinnedBetaIssuerPublicCertificates implements BetaIssuerPublicCertificates {
  private readonly pins:ReadonlyArray<{issuerRuc:string;fingerprint:string;path:string;sha256:string}>;
  constructor(pins:Array<{issuerRuc:string;fingerprint:string;path:string;sha256:string}>){
    if(!Array.isArray(pins)||!pins.length||pins.length>1000||pins.some(p=>!p||Object.keys(p).sort().join(',')!=='fingerprint,issuerRuc,path,sha256'||
      !/^\d{11}$/.test(p.issuerRuc)||!(/^[a-f0-9]{64}$/).test(p.fingerprint)||!(/^[a-f0-9]{64}$/).test(p.sha256)||typeof p.path!=='string'||!isAbsolute(p.path))||
      new Set(pins.map(p=>p.issuerRuc+':'+p.fingerprint)).size!==pins.length)throw new Error('EXPLICIT_PUBLIC_CERTIFICATE_PINS_REQUIRED');
    this.pins=structuredClone(pins);
  }
  async load(ruc:string,fingerprint:string){
    const pin=this.pins.find(p=>p.issuerRuc===ruc&&p.fingerprint===fingerprint);
    if(!pin)throw new Error('ISSUER_PUBLIC_CERTIFICATE_NOT_PINNED');
    const file=await loadPinnedPublicFile(pin.path,pin.sha256),pems=file.text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)??[];
    const leaf=pems[0];
    if(!leaf||pems.length>17||file.text.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,'').trim()||
      new X509Certificate(leaf).fingerprint256.replace(/:/g,'').toLowerCase()!==fingerprint)throw new Error('ISSUER_PUBLIC_CERTIFICATE_PIN_MISMATCH');
    return {certificatePem:leaf,chainPems:pems.slice(1)};
  }
}
export class BetaOwnerXmlTrust {
  constructor(private readonly certificates:BetaIssuerPublicCertificates,private readonly trust:Pick<CertificateTrustService,'evaluate'>){}
  /** Prepared member XML, including unreported boletas. Individual acceptance gates stay separate. */
  async verifyPreparedDocument(document:BetaAcceptedDocumentRecord['document'],fingerprint:string,xml:Buffer,asOf:string,noteContext?:FiscalNoteContext){
    if(document.environment!=='BETA'||!['01','03','07','08'].includes(document.documentTypeCode)||
      !(/^[BF][A-Z0-9]{3}$/).test(document.series))throw new Error('PREPARED_BETA_DOCUMENT_REQUIRED');
    const original=document.documentTypeCode==='01'||document.documentTypeCode==='03';
    if(original&&(document.series[0]!== (document.documentTypeCode==='01'?'F':'B')||noteContext!==undefined))throw new Error('PREPARED_BETA_DOCUMENT_REQUIRED');
    let unsigned:string;
    if(original){validateFiscalOriginal(document as FiscalDocumentSnapshot,asOf);unsigned=buildInvoiceUbl(document as FiscalDocumentSnapshot,{mode:'REAL_PREPARATION'});}
    else{
      if(!noteContext||document.series[0]!== (noteContext.original.documentTypeCode==='01'?'F':'B'))throw new Error('PREPARED_NOTE_CONTEXT_REQUIRED');
      unsigned=buildFiscalNoteUbl(document as FiscalNoteSnapshot,{...noteContext,asOf});
    }
    return this.verifyXml(document.issuer.identityNumber,fingerprint,original?'Invoice':document.documentTypeCode==='07'?'CreditNote':'DebitNote',xml,unsigned,asOf);
  }
  async verifyIssuer(record:BetaAcceptedDocumentRecord,xml:Buffer,unsignedXml:string,asOf:string){
    if(record.document.environment!=='BETA'||!['01','07','08'].includes(record.document.documentTypeCode)||!record.document.series.startsWith('F'))throw new Error('INDIVIDUAL_BETA_REQUIRED');
    const root=record.document.documentTypeCode==='01'?'Invoice':record.document.documentTypeCode==='07'?'CreditNote':'DebitNote';
    return this.verifyXml(record.document.issuer.identityNumber,record.signerFingerprint,root,xml,unsignedXml,asOf);
  }
  async verifyBatch(batch:FiscalBatchSnapshot,fingerprint:string,xml:Buffer,unsignedXml:string,asOf:string){
    if(batch.environment!=='BETA'||!['RC','RA'].includes(batch.kind))throw new Error('BETA_BATCH_REQUIRED');
    return this.verifyXml(batch.issuer.identityNumber,fingerprint,batch.kind==='RC'?'SummaryDocuments':'VoidedDocuments',xml,unsignedXml,asOf);
  }
  async verifyEnvelope(envelope:FiscalSupplementEnvelope,fingerprint:string,xml:Buffer,asOf:string){
    const identity=betaFiscalIdentity(envelope),unsigned=envelope.kind==='NOTE'?buildFiscalNoteUbl(envelope.note,envelope.context):buildFiscalBatchUbl(envelope.batch,envelope.asOf);
    return this.verifyXml(identity.ruc,fingerprint,identity.rootName,xml,unsigned,asOf);
  }
  private async verifyXml(ruc:string,fingerprint:string,root:XmlRootKind,xml:Buffer,unsignedXml:string,asOf:string){
    const publicChain=await this.certificates.load(ruc,fingerprint);
    if(!publicChain||typeof publicChain.certificatePem!=='string'||publicChain.certificatePem.length>65536||
      !Array.isArray(publicChain.chainPems)||publicChain.chainPems.length>16||publicChain.chainPems.some(p=>typeof p!=='string'||p.length>65536||p.includes('PRIVATE KEY'))||publicChain.certificatePem.includes('PRIVATE KEY'))throw new Error('ISSUER_PUBLIC_CERTIFICATE_REQUIRED');
    const x509=new X509Certificate(publicChain.certificatePem),cert=forge.pki.certificateFromPem(publicChain.certificatePem),now=new Date(asOf);
    if(!Number.isFinite(now.getTime())||now<new Date(x509.validFrom)||now>=new Date(x509.validTo)||x509.ca||x509.publicKey.asymmetricKeyType!=='rsa'||(x509.publicKey.asymmetricKeyDetails?.modulusLength??0)<2048)throw new Error('ISSUER_CERTIFICATE_INVALID');
    const metadata={fingerprint:x509.fingerprint256.replace(/:/g,'').toLowerCase(),expiresAt:new Date(x509.validTo),
      selfSigned:x509.subject===x509.issuer&&x509.verify(x509.publicKey),certificatePem:publicChain.certificatePem,chainPems:publicChain.chainPems,
      digitalSignature:(cert.getExtension('keyUsage') as {digitalSignature?:boolean}|null)?.digitalSignature===true,
      subjectRucCandidates:certificateRucCandidates(cert.subject.attributes)};
    if(metadata.fingerprint!==fingerprint||metadata.selfSigned||!metadata.digitalSignature||metadata.subjectRucCandidates.length!==1||metadata.subjectRucCandidates[0]!==ruc)throw new Error('ISSUER_CERTIFICATE_MISMATCH');
    const proof=await this.trust.evaluate(metadata,ruc,now);
    if(proof.profile!=='OFFLINE-PINNED-ROOTS-CRL-v1'||proof.chainValid!==true||proof.identityMatched!==true||proof.revocation!=='VERIFIED_OFFLINE_CRL'||!Array.isArray(proof.blockers)||proof.blockers.length||
      proof.certificateFingerprint!==fingerprint||proof.checkedAt!==now.toISOString()||typeof proof.trustStoreSha256!=='string'||!(/^[a-f0-9]{64}$/).test(proof.trustStoreSha256))throw new Error('ISSUER_TRUST_NOT_VERIFIED');
    if(!Buffer.from(xml.toString('utf8')).equals(xml))throw new Error('SIGNED_XML_INVALID');
    const digestValue=verifyLocalSignedInvoice(xml.toString('utf8'),publicChain.certificatePem,unsignedXml,root);
    return {digestValue,certificateFingerprint:metadata.fingerprint,trustStoreSha256:proof.trustStoreSha256,checkedAt:asOf};
  }
}
