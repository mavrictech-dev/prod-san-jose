import {createHash} from 'node:crypto';
import type {FiscalDocumentSnapshot} from '@factuez/contracts';
import {buildInvoiceUbl} from '@factuez/sunat-core';
import {buildFiscalNoteUbl,fiscalSnapshotSha256,fiscalTimestamp,fiscalDate,fiscalLimaDate,validateFiscalOriginal,
  validateFiscalAcceptance,type FiscalNoteSnapshot,type FiscalNoteContext,type FiscalAcceptanceEvidence} from '@factuez/sunat-core/dist/fiscal-note';
import {boundedSupplementJson} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import {parseCdrZip} from '../infrastructure/sunat/cdr-parser';
import {safeXml,children,CAC_NS,CBC_NS} from '../infrastructure/sunat/safe-xml';
import {betaCdrZipMetadata,betaCdrCrc32} from './beta-summary-acceptance';
import {singleNotesTransportXml} from '../infrastructure/sunat/notes-transport-qa-validator';
export type BetaAcceptanceDocument=FiscalDocumentSnapshot|FiscalNoteSnapshot;
export type BetaAcceptanceArtifact={id:string;storageKey:string;sha256:string;sizeBytes:number};
export interface BetaAcceptedDocumentRecord {
  document:BetaAcceptanceDocument;noteContext?:FiscalNoteContext;
  submissionId:string;completedAt:string;status:'ACCEPTED'|'ACCEPTED_WITH_OBSERVATIONS';
  signerFingerprint:string;digestValue:string;version:string;
  signedXml:BetaAcceptanceArtifact;cdrZip:BetaAcceptanceArtifact;requestZip:BetaAcceptanceArtifact;
}
export interface BetaIssuerXmlProof {digestValue:string;certificateFingerprint:string;trustStoreSha256:string;checkedAt:string}
/** All ports are owner-side. No uploaded XML, URL, credential or trusted=true is accepted as input. */
export interface BetaDocumentAcceptancePorts {
  load(ruc:string,environment:'BETA',documentId:string):Promise<BetaAcceptedDocumentRecord|null>;
  read(documentId:string,artifact:BetaAcceptanceArtifact):Promise<Buffer>;
  verifyIssuer(record:BetaAcceptedDocumentRecord,xml:Buffer,unsignedXml:string,asOf:string):Promise<BetaIssuerXmlProof>;
  verifyCdr(xml:Buffer):Promise<boolean>;
}
export class BetaDocumentAcceptanceError extends Error {
  constructor(readonly code:string){super(code);this.name='BetaDocumentAcceptanceError';}
}
function deny(code:string):never{throw new BetaDocumentAcceptanceError(code);}
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const seals=new WeakSet<object>();
/** In-process proof provenance only; serialized copies cannot be promoted into verified capabilities. */
export const isBetaOwnerDocumentAcceptance=(value:unknown):boolean=>!!value&&typeof value==='object'&&seals.has(value);
function artifact(a:BetaAcceptanceArtifact,max:number){
  if(!a||Object.keys(a).sort().join(',')!=='id,sha256,sizeBytes,storageKey'||!UUID.test(a.id)||!HASH.test(a.sha256)||
    typeof a.storageKey!=='string'||!a.storageKey||a.storageKey.length>500||!Number.isSafeInteger(a.sizeBytes)||a.sizeBytes<1||a.sizeBytes>max)deny('ARTIFACT_INVALID');
}
function one(parent:ReturnType<typeof safeXml>,ns:string,name:string){
  const matches=children(parent,ns,name);let aliases=0;
  for(let n=parent.firstChild;n;n=n.nextSibling)if(n.nodeType===1&&(n as typeof parent).localName===name)aliases++;
  if(matches.length!==1||aliases!==1)deny('CDR_INVALID');return matches[0];
}
function text(parent:ReturnType<typeof safeXml>,ns:string,name:string,max:number){
  const node=one(parent,ns,name),value=node.textContent??'';
  if(node.getElementsByTagName('*').length||!value||value!==value.trim()||value.length>max)deny('CDR_INVALID');return value;
}
function validate(record:BetaAcceptedDocumentRecord,doc:BetaAcceptanceDocument,asOf:string){
  if(!record||fiscalSnapshotSha256(record.document)!==fiscalSnapshotSha256(doc)||
    !['ACCEPTED','ACCEPTED_WITH_OBSERVATIONS'].includes(record.status)||!UUID.test(record.submissionId)||!HASH.test(record.version)||
    !HASH.test(record.signerFingerprint)||!/^[A-Za-z0-9+/]{43}=$/.test(record.digestValue))deny('OWNER_RECORD_INVALID');
  fiscalTimestamp(record.completedAt,'completedAt');
  if(Date.parse(record.completedAt)>Date.parse(asOf)||Date.parse(record.completedAt)<Date.parse(doc.issueDate))deny('ACCEPTANCE_TIME_INVALID');
  artifact(record.signedXml,2*1024*1024);artifact(record.cdrZip,4*1024*1024);artifact(record.requestZip,4*1024*1024);
  if(new Set([record.signedXml.id,record.cdrZip.id,record.requestZip.id]).size!==3||new Set([record.signedXml.storageKey,record.cdrZip.storageKey,record.requestZip.storageKey]).size!==3)deny('ARTIFACT_INVALID');
  if(doc.documentTypeCode==='01'){validateFiscalOriginal(doc as FiscalDocumentSnapshot,asOf);return buildInvoiceUbl(doc as FiscalDocumentSnapshot,{mode:'REAL_PREPARATION'});}
  if(!record.noteContext)deny('NOTE_CONTEXT_REQUIRED');
  return buildFiscalNoteUbl(doc as FiscalNoteSnapshot,record.noteContext);
}
/** Read-only individual sendBill profile 01/F07/F08. Boletas/B notes require the existing RC membership verifier. */
export async function verifyBetaDocumentAcceptance(snapshot:BetaAcceptanceDocument,asOf:string,ports:BetaDocumentAcceptancePorts){
  let doc:BetaAcceptanceDocument;
  try{
    doc=boundedSupplementJson(snapshot) as BetaAcceptanceDocument;fiscalTimestamp(asOf,'asOf');
    if(doc.environment!=='BETA'||!['01','07','08'].includes(doc.documentTypeCode)||!/^F[A-Z0-9]{3}$/.test(doc.series)||
      !UUID.test(doc.documentId)||!/^\d{11}$/.test(doc.issuer?.identityNumber))deny('INDIVIDUAL_BETA_REQUIRED');
  }catch(e){if(e instanceof BetaDocumentAcceptanceError)throw e;deny('INPUT_INVALID');}
  const inputHash=fiscalSnapshotSha256(snapshot),ruc=doc.issuer.identityNumber;
  async function load(){try{const record=await ports.load(ruc,'BETA',doc.documentId);if(!record)deny('OWNER_RECORD_NOT_FOUND');return boundedSupplementJson(record) as BetaAcceptedDocumentRecord;}
    catch(e){if(e instanceof BetaDocumentAcceptanceError)throw e;deny('OWNER_RECORD_UNAVAILABLE');}}
  const record=await load();let unsigned:string;
  try{unsigned=validate(record,doc,asOf);}catch(e){if(e instanceof BetaDocumentAcceptanceError)throw e;deny('OWNER_RECORD_INVALID');}
  const recordHash=fiscalSnapshotSha256(record);
  async function read(a:BetaAcceptanceArtifact){let bytes:Buffer;
    try{bytes=Buffer.from(await ports.read(doc.documentId,structuredClone(a)));}catch{deny('ARTIFACT_UNAVAILABLE');}
    if(bytes.length!==a.sizeBytes||hash(bytes)!==a.sha256)deny('ARTIFACT_MISMATCH');return bytes;
  }
  const xml=await read(record.signedXml),zip=await read(record.cdrZip),requestZip=await read(record.requestZip);
  try{
    const name=`${ruc}-${doc.documentTypeCode}-${doc.fullNumber}.zip`,expectedName=name.replace(/\.zip$/,'.xml');
    const archived=singleNotesTransportXml(requestZip,name),metadata=betaCdrZipMetadata(requestZip,expectedName);
    if(!archived.equals(xml)||metadata.size!==archived.length||metadata.crc!==betaCdrCrc32(archived))deny('REQUEST_PACKAGE_MISMATCH');
  }catch{deny('REQUEST_PACKAGE_MISMATCH');}
  if(!Buffer.from(xml.toString('utf8')).equals(xml))deny('XML_ENCODING_INVALID');
  let issuerProof:BetaIssuerXmlProof;
  try{issuerProof=boundedSupplementJson(await ports.verifyIssuer(structuredClone(record),Buffer.from(xml),unsigned,asOf)) as BetaIssuerXmlProof;}catch{deny('ISSUER_SIGNATURE_UNTRUSTED');}
  if(!issuerProof||Object.keys(issuerProof).sort().join(',')!=='certificateFingerprint,checkedAt,digestValue,trustStoreSha256'||
    issuerProof.certificateFingerprint!==record.signerFingerprint||issuerProof.digestValue!==record.digestValue||
    !HASH.test(issuerProof.trustStoreSha256)||issuerProof.checkedAt!==asOf)deny('ISSUER_SIGNATURE_UNTRUSTED');
  const fileName=`R-${ruc}-${doc.documentTypeCode}-${doc.fullNumber}.xml`;let parsed:ReturnType<typeof parseCdrZip>;
  try{
    const metadata=betaCdrZipMetadata(zip,fileName);parsed=parseCdrZip(zip,{fileName,issuerRuc:ruc,reference:doc.fullNumber});
    if(parsed.xml.length!==metadata.size||betaCdrCrc32(parsed.xml)!==metadata.crc||!Buffer.from(parsed.xml.toString('utf8')).equals(parsed.xml))deny('CDR_INVALID');
    const root=safeXml(parsed.xml.toString('utf8'));
    if(text(one(one(root,CAC_NS,'SenderParty'),CAC_NS,'PartyIdentification'),CBC_NS,'ID',11)!=='20131312955')deny('CDR_INVALID');
    if(text(one(one(root,CAC_NS,'ReceiverParty'),CAC_NS,'PartyIdentification'),CBC_NS,'ID',11)!==ruc)deny('CDR_INVALID');
    const response=one(root,CAC_NS,'DocumentResponse'),reference=one(response,CAC_NS,'DocumentReference');
    const answer=one(response,CAC_NS,'Response');
    if(text(reference,CBC_NS,'ID',40)!==doc.fullNumber||text(reference,CBC_NS,'DocumentTypeCode',2)!==doc.documentTypeCode||text(answer,CBC_NS,'ReferenceID',40)!==doc.fullNumber||text(answer,CBC_NS,'ResponseCode',8)!==parsed.code)deny('CDR_INVALID');
    const day=text(root,CBC_NS,'IssueDate',10);fiscalDate(day,'CDR.IssueDate');
    if(day<fiscalLimaDate(doc.issueDate)||day>fiscalLimaDate(record.completedAt))deny('ACCEPTANCE_TIME_INVALID');
  }catch(e){if(e instanceof BetaDocumentAcceptanceError)throw e;deny('CDR_INVALID');}
  if(parsed.code!=='0'||parsed.status==='REJECTED')deny('CDR_REJECTED');
  if(parsed.status!==record.status)deny('CDR_STATUS_MISMATCH');
  try{if(await ports.verifyCdr(Buffer.from(parsed.xml))!==true)deny('CDR_SIGNATURE_UNTRUSTED');}
  catch{deny('CDR_SIGNATURE_UNTRUSTED');}
  const reread=await load();
  if(fiscalSnapshotSha256(reread)!==recordHash)deny('OWNER_RECORD_CHANGED');
  // Re-read artifacts too: a stable row is not proof of stable file contents across awaits.
  if(!xml.equals(await read(record.signedXml))||!zip.equals(await read(record.cdrZip))||!requestZip.equals(await read(record.requestZip)))deny('ARTIFACT_MISMATCH');
  if(fiscalSnapshotSha256(snapshot)!==inputHash)deny('INPUT_CHANGED');
  const evidence:FiscalAcceptanceEvidence={environment:'BETA',issuerRuc:ruc,documentId:doc.documentId,documentTypeCode:doc.documentTypeCode as '01'|'07'|'08',
    fullNumber:doc.fullNumber,snapshotSha256:fiscalSnapshotSha256(doc),cdrSha256:hash(zip),status:record.status,responseCode:'0',acceptedAt:record.completedAt,source:{kind:'CDR_DOCUMENT'}};
  validateFiscalAcceptance(doc,evidence,asOf);
  Object.freeze(evidence.source);
  const result=Object.freeze({schemaVersion:'factuez.beta.owner-document-acceptance.v1' as const,evidence:Object.freeze(evidence),
    fence:Object.freeze({submissionId:record.submissionId,ownerRecordSha256:recordHash,ownerVersion:record.version,signedXmlSha256:hash(xml),requestZipSha256:hash(requestZip),cdrZipSha256:hash(zip),cdrXmlSha256:hash(parsed.xml)}),
    certificateFingerprint:record.signerFingerprint,trustStoreSha256:issuerProof.trustStoreSha256,checkedAt:asOf,
    candidateOnly:true as const,fiscalExecutionEnabled:false as const,transmissionAuthorized:false as const});
  seals.add(result);return result;
}
