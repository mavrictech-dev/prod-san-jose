import {createHash} from 'node:crypto';
import {boundedSupplementJson} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import {fiscalSnapshotSha256,fiscalTimestamp,validateFiscalAcceptance,buildFiscalNoteUbl,
  type FiscalAcceptanceEvidence,type FiscalNoteContext,type FiscalNoteSnapshot} from '@factuez/sunat-core/dist/fiscal-note';
import type {FiscalNotDeliveredEvidence} from '@factuez/sunat-core/dist/fiscal-batch';
import {BetaOwnerXmlTrust,type BetaIssuerPublicCertificates} from '../infrastructure/crypto/beta-owner-xml-trust';
import type {CertificateTrustService} from '../infrastructure/crypto/certificate-trust.service';
import type {CdrSignatureTrustService} from '../infrastructure/crypto/cdr-signature-trust.service';
import {singleNotesTransportXml} from '../infrastructure/sunat/notes-transport-qa-validator';
import {betaCdrZipMetadata,betaCdrCrc32} from './beta-summary-acceptance';
import {isBetaOwnerDocumentAcceptance,type BetaAcceptanceArtifact,type BetaAcceptanceDocument} from './beta-document-acceptance';
import {BetaOwnerDocumentAcceptance} from './beta-owner-document-acceptance';
import {BetaOwnerSummaryAcceptance,isBetaOwnerSummaryAcceptance,type BetaSummaryOwner} from './beta-owner-summary-acceptance';
import {BetaOwnerAcceptanceResolver} from './beta-owner-acceptance-resolver';

// Portable structural contracts: SUNAT does not depend on Billing classes or types.
export type BatchEvidenceVersion={documentId:string;version:number;snapshotSha256:string};
export type BatchEvidenceBinding={environment:'BETA';issuerRuc:string;companyId:number;branchId:string;
  pointId:string;seriesId:string;series:string;documentType:'01'|'03'|'07'|'08'};
export type BatchEvidenceAcceptanceFence={submissionId:string;ownerRecordSha256:string;ownerVersion:string;
  signedXmlSha256:string;requestZipSha256:string;cdrZipSha256:string;cdrXmlSha256:string};
export interface BatchMemberOwnerVersionRecord {
  member:BatchEvidenceVersion;ownerVersion:string;binding:BatchEvidenceBinding;snapshot:BetaAcceptanceDocument;
  signerFingerprint:string;digestValue:string;signedXml:BetaAcceptanceArtifact;requestZip:BetaAcceptanceArtifact;
  ownerOriginalVersion:BatchEvidenceVersion|null;noteContext:FiscalNoteContext|null;
  acceptance:null|{kind:'INDIVIDUAL'|'SUMMARY';fence:BatchEvidenceAcceptanceFence};
  notDelivered:FiscalNotDeliveredEvidence|null;
  /** Private owner attestation, never populated from public complete/accepted flags.
   * Revision covers the entire accepted/reserved catalogue, excluding this member.
   * Entries use BatchPG's documentId ascending order; their array is hashed directly. */
  creditCatalogue:{source:'OWNER_PRIVATE_COMPLETE_CREDIT_CATALOGUE_V1';complete:true;revision:number;
    entries:{member:BatchEvidenceVersion;state:'ACCEPTED'|'RESERVED'}[]};
}
export interface BatchMemberPrivateOwnerPort {
  /** Resolve the exact immutable version, including historical signed packages; never latest fallback.
   * Both reads must observe every owner evidence/catalogue revision. Persisted snapshots are JSON. */
  load(ownerHandle:string):Promise<BatchMemberOwnerVersionRecord|null>;
}
export interface BatchMemberArtifactPort {read(documentId:string,artifact:BetaAcceptanceArtifact):Promise<Buffer>}
export type BatchMemberVerifiedEvidence={binding:BatchEvidenceBinding;snapshot:BetaAcceptanceDocument;
  acceptance:FiscalAcceptanceEvidence|null;notDelivered:FiscalNotDeliveredEvidence|null;original:BatchEvidenceVersion|null;
  provenance:{verifierId:string;artifactId:string;verifiedAt:string;signedXmlSha256:string;cdrSha256:string|null;catalogueSha256:string}};
export type BatchMemberEvidenceErrorCode='BATCH_EVIDENCE_INPUT_INVALID'|'BATCH_EVIDENCE_OWNER_INVALID'|
  'BATCH_EVIDENCE_OWNER_CHANGED'|'BATCH_EVIDENCE_ARTIFACT_INVALID'|'BATCH_EVIDENCE_SIGNATURE_INVALID'|
  'BATCH_EVIDENCE_ACCEPTANCE_INVALID'|'BATCH_EVIDENCE_CATALOGUE_INVALID'|'BATCH_EVIDENCE_UNAVAILABLE';
export class BatchMemberEvidenceError extends Error {
  constructor(readonly code:BatchMemberEvidenceErrorCode){super(code);this.name='BatchMemberEvidenceError';}
}
const ERROR_CODES:readonly BatchMemberEvidenceErrorCode[]=['BATCH_EVIDENCE_INPUT_INVALID','BATCH_EVIDENCE_OWNER_INVALID',
  'BATCH_EVIDENCE_OWNER_CHANGED','BATCH_EVIDENCE_ARTIFACT_INVALID','BATCH_EVIDENCE_SIGNATURE_INVALID',
  'BATCH_EVIDENCE_ACCEPTANCE_INVALID','BATCH_EVIDENCE_CATALOGUE_INVALID','BATCH_EVIDENCE_UNAVAILABLE'];
function deny(code:BatchMemberEvidenceErrorCode):never{throw new BatchMemberEvidenceError(code);}
const HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const same=(a:unknown,b:unknown)=>fiscalSnapshotSha256(a)===fiscalSnapshotSha256(b);
const positive=(v:number)=>Number.isSafeInteger(v)&&v>0;
function exact(value:unknown,keys:string[],code:BatchMemberEvidenceErrorCode='BATCH_EVIDENCE_OWNER_INVALID'){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.sort().join(','))deny(code);
}
function version(v:BatchEvidenceVersion){
  exact(v,['documentId','version','snapshotSha256']);
  if(!UUID.test(v.documentId)||!positive(v.version)||!HASH.test(v.snapshotSha256))deny('BATCH_EVIDENCE_OWNER_INVALID');
}
function artifact(v:BetaAcceptanceArtifact,max:number){
  exact(v,['id','storageKey','sha256','sizeBytes']);
  if(!UUID.test(v.id)||!HASH.test(v.sha256)||!positive(v.sizeBytes)||v.sizeBytes>max||
    typeof v.storageKey!=='string'||!v.storageKey||v.storageKey.length>500)deny('BATCH_EVIDENCE_ARTIFACT_INVALID');
}
function validate(r:BatchMemberOwnerVersionRecord,asOf:string){
  exact(r,['member','ownerVersion','binding','snapshot','signerFingerprint','digestValue','signedXml','requestZip',
    'ownerOriginalVersion','noteContext','acceptance','notDelivered','creditCatalogue']);
  version(r.member);const s=r.snapshot,b=r.binding,c=r.creditCatalogue;
  exact(b,['environment','issuerRuc','companyId','branchId','pointId','seriesId','series','documentType']);
  if(!HASH.test(r.ownerVersion)||!HASH.test(r.signerFingerprint)||!/^[A-Za-z0-9+/]{43}=$/.test(r.digestValue)||
    !positive(b.companyId)||![b.branchId,b.pointId,b.seriesId].every(id=>UUID.test(id))||
    !/^\d{11}$/.test(b.issuerRuc)||!['01','03','07','08'].includes(b.documentType)||!(/^[BF][A-Z0-9]{3}$/).test(b.series)||
    b.environment!=='BETA'||s.environment!==b.environment||s.documentId!==r.member.documentId||
    fiscalSnapshotSha256(s)!==r.member.snapshotSha256||s.companyId!==b.companyId||s.branchId!==b.branchId||
    s.series!==b.series||s.documentTypeCode!==b.documentType||s.issuer.identityNumber!==b.issuerRuc)deny('BATCH_EVIDENCE_OWNER_INVALID');
  artifact(r.signedXml,2*1024*1024);artifact(r.requestZip,4*1024*1024);
  if(r.signedXml.id===r.requestZip.id||r.signedXml.storageKey===r.requestZip.storageKey)deny('BATCH_EVIDENCE_ARTIFACT_INVALID');
  exact(c,['source','complete','revision','entries'],'BATCH_EVIDENCE_CATALOGUE_INVALID');
  if(c.source!=='OWNER_PRIVATE_COMPLETE_CREDIT_CATALOGUE_V1'||c.complete!==true||!positive(c.revision)||
    !Array.isArray(c.entries)||c.entries.length>99)deny('BATCH_EVIDENCE_CATALOGUE_INVALID');
  let last='';
  for(const e of c.entries){
    exact(e,['member','state'],'BATCH_EVIDENCE_CATALOGUE_INVALID');version(e.member);
    if(!['ACCEPTED','RESERVED'].includes(e.state)||e.member.documentId<=last||e.member.documentId===s.documentId)deny('BATCH_EVIDENCE_CATALOGUE_INVALID');
    last=e.member.documentId;
  }
  if(s.documentTypeCode==='07'||s.documentTypeCode==='08'){
    if(!r.ownerOriginalVersion||!r.noteContext)deny('BATCH_EVIDENCE_CATALOGUE_INVALID');
    version(r.ownerOriginalVersion);const context=r.noteContext;
    if(context.creditHistory.complete!==true||context.original.documentId!==r.ownerOriginalVersion.documentId||
      fiscalSnapshotSha256(context.original)!==r.ownerOriginalVersion.snapshotSha256||
      !same(context.creditHistory.entries.map(e=>({member:{documentId:e.note.documentId,
        version:c.entries.find(h=>h.member.documentId===e.note.documentId)?.member.version??0,
        snapshotSha256:fiscalSnapshotSha256(e.note)},state:e.state})),c.entries))deny('BATCH_EVIDENCE_CATALOGUE_INVALID');
    // Regenerate the complete core snapshot, including reason, original, amounts and credit capacity.
    buildFiscalNoteUbl(s as FiscalNoteSnapshot,{...context,asOf});
  }else if(r.ownerOriginalVersion!==null||r.noteContext!==null||c.entries.length)deny('BATCH_EVIDENCE_CATALOGUE_INVALID');
  if(r.acceptance!==null){
    exact(r.acceptance,['kind','fence']);const f=r.acceptance.fence;
    exact(f,['submissionId','ownerRecordSha256','ownerVersion','signedXmlSha256','requestZipSha256','cdrZipSha256','cdrXmlSha256']);
    if(r.acceptance.kind!==(s.series.startsWith('B')?'SUMMARY':'INDIVIDUAL')||!UUID.test(f.submissionId)||
      Object.entries(f).some(([k,v])=>k!=='submissionId'&&!HASH.test(v))||
      r.acceptance.kind==='INDIVIDUAL'&&(f.ownerVersion!==r.ownerVersion||f.signedXmlSha256!==r.signedXml.sha256||f.requestZipSha256!==r.requestZip.sha256))deny('BATCH_EVIDENCE_ACCEPTANCE_INVALID');
  }
  if(r.notDelivered!==null){
    const e=r.notDelivered;exact(e,['status','documentId','documentTypeCode','fullNumber','issuerRuc','snapshotSha256','evidenceId','assertedAt']);
    fiscalTimestamp(e.assertedAt,'notDelivered.assertedAt');
    if(e.status!=='NOT_DELIVERED'||e.documentId!==s.documentId||e.documentTypeCode!==s.documentTypeCode||e.fullNumber!==s.fullNumber||
      e.issuerRuc!==b.issuerRuc||e.snapshotSha256!==r.member.snapshotSha256||!UUID.test(e.evidenceId)||
      Date.parse(e.assertedAt)<Date.parse(s.issueDate)||Date.parse(e.assertedAt)>Date.parse(asOf))deny('BATCH_EVIDENCE_OWNER_INVALID');
  }
}

/** Read-only, offline implementation of Billing's structural BatchMemberEvidencePort. */
export class BatchMemberEvidence {
  constructor(private readonly owner:BatchMemberPrivateOwnerPort,private readonly artifacts:BatchMemberArtifactPort,
    private readonly signatures:BetaOwnerXmlTrust,private readonly acceptance:BetaOwnerAcceptanceResolver){}
  async verifySignedVersion(ownerHandle:string,asOf:string):Promise<BatchMemberVerifiedEvidence>{
    try{return await this.verify(ownerHandle,asOf);}catch(e){
      // Recreate even known errors: private ports must not leak messages, causes or extra fields.
      if(e instanceof BatchMemberEvidenceError&&ERROR_CODES.includes(e.code))return deny(e.code);
      return deny('BATCH_EVIDENCE_UNAVAILABLE');
    }
  }
  private async verify(ownerHandle:string,asOf:string):Promise<BatchMemberVerifiedEvidence>{
    // Handles are opaque capabilities, never filesystem paths, URLs or certificate locations.
    if(typeof ownerHandle!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(ownerHandle))deny('BATCH_EVIDENCE_INPUT_INVALID');
    try{fiscalTimestamp(asOf,'asOf');}catch{deny('BATCH_EVIDENCE_INPUT_INVALID');}
    const load=async()=>{
      const value=await this.owner.load(ownerHandle);if(!value)deny('BATCH_EVIDENCE_OWNER_INVALID');
      const copy=boundedSupplementJson(value) as BatchMemberOwnerVersionRecord;
      try{validate(copy,asOf);}catch(e){if(e instanceof BatchMemberEvidenceError)throw e;deny('BATCH_EVIDENCE_OWNER_INVALID');}
      return copy;
    };
    const r=await load(),stamp=fiscalSnapshotSha256(r),s=r.snapshot;
    const read=async(a:BetaAcceptanceArtifact)=>{
      const raw=await this.artifacts.read(s.documentId,structuredClone(a));
      if(!Buffer.isBuffer(raw)||raw.length!==a.sizeBytes||hash(raw)!==a.sha256)deny('BATCH_EVIDENCE_ARTIFACT_INVALID');
      return Buffer.from(raw);
    };
    const xml=await read(r.signedXml),zip=await read(r.requestZip);
    try{
      const name=`${s.issuer.identityNumber}-${s.documentTypeCode}-${s.fullNumber}.zip`;
      const packaged=singleNotesTransportXml(zip,name),metadata=betaCdrZipMetadata(zip,name.replace(/\.zip$/,'.xml'));
      if(!packaged.equals(xml)||metadata.size!==xml.length||metadata.crc!==betaCdrCrc32(xml))deny('BATCH_EVIDENCE_ARTIFACT_INVALID');
    }catch{deny('BATCH_EVIDENCE_ARTIFACT_INVALID');}
    try{
      const signer=await this.signatures.verifyPreparedDocument(structuredClone(s),r.signerFingerprint,Buffer.from(xml),asOf,r.noteContext?structuredClone(r.noteContext):undefined);
      if(signer.certificateFingerprint!==r.signerFingerprint||signer.digestValue!==r.digestValue||signer.checkedAt!==asOf||
        !HASH.test(signer.trustStoreSha256))deny('BATCH_EVIDENCE_SIGNATURE_INVALID');
    }catch{deny('BATCH_EVIDENCE_SIGNATURE_INVALID');}
    const accepted=async(document:BetaAcceptanceDocument)=>{
      try{
        const proof=await this.acceptance.verify(structuredClone(document),asOf);
        if(!(document.series.startsWith('B')?isBetaOwnerSummaryAcceptance(proof):isBetaOwnerDocumentAcceptance(proof)))deny('BATCH_EVIDENCE_ACCEPTANCE_INVALID');
        validateFiscalAcceptance(document,proof.evidence,asOf);
        if(proof.fence.cdrZipSha256!==proof.evidence.cdrSha256)deny('BATCH_EVIDENCE_ACCEPTANCE_INVALID');
        return proof;
      }catch{ return deny('BATCH_EVIDENCE_ACCEPTANCE_INVALID'); }
    };
    let evidence:FiscalAcceptanceEvidence|null=null;
    if(r.acceptance){
      const proof=await accepted(s);
      if(!same(proof.fence,r.acceptance.fence))deny('BATCH_EVIDENCE_ACCEPTANCE_INVALID');
      evidence=proof.evidence;
    }
    if(r.noteContext){
      const original=await accepted(r.noteContext.original);
      if(!same(original.evidence,r.noteContext.acceptance))deny('BATCH_EVIDENCE_ACCEPTANCE_INVALID');
      for(const prior of r.noteContext.creditHistory.entries)if(prior.state==='ACCEPTED')await accepted(prior.note);
    }
    // Stable bytes AND owner row/catalogue on both sides of all asynchronous verification.
    if(!same(await load(),r))deny('BATCH_EVIDENCE_OWNER_CHANGED');
    if(!xml.equals(await read(r.signedXml))||!zip.equals(await read(r.requestZip)))deny('BATCH_EVIDENCE_ARTIFACT_INVALID');
    if(fiscalSnapshotSha256(await load())!==stamp)deny('BATCH_EVIDENCE_OWNER_CHANGED');
    return {binding:r.binding,snapshot:s,acceptance:evidence,notDelivered:r.notDelivered,original:r.ownerOriginalVersion,
      provenance:{verifierId:'sunat.batch-member-evidence.v1',artifactId:r.signedXml.id,verifiedAt:asOf,
        signedXmlSha256:hash(xml),cdrSha256:evidence?.cdrSha256??null,catalogueSha256:fiscalSnapshotSha256(r.creditCatalogue.entries)}};
  }
}

/** Explicit assembly with required public issuer/CRL policy and real branded acceptance resolvers.
 * Repositories must resolve exact immutable history for the selected private owner version.
 * No bootstrap, HTTP registration, credentials, signing, transport or default allow verifier. */
export function createBatchMemberEvidence(options:{owner:BatchMemberPrivateOwnerPort;artifacts:BatchMemberArtifactPort;
  certificates:BetaIssuerPublicCertificates;trust:Pick<CertificateTrustService,'evaluate'>;
  individual:ConstructorParameters<typeof BetaOwnerDocumentAcceptance>[0];summary:BetaSummaryOwner;
  cdr:Pick<CdrSignatureTrustService,'verify'>}){
  const signatures=new BetaOwnerXmlTrust(options.certificates,options.trust);
  const acceptance=new BetaOwnerAcceptanceResolver(new BetaOwnerDocumentAcceptance(options.individual,options.artifacts,signatures,options.cdr),
    new BetaOwnerSummaryAcceptance(options.summary,options.artifacts,signatures,options.cdr));
  return new BatchMemberEvidence(options.owner,options.artifacts,signatures,acceptance);
}
