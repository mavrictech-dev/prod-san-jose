import {createHash} from 'node:crypto';
import {boundedSupplementJson} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import {buildFiscalBatchUbl,type FiscalBatchSnapshot} from '@factuez/sunat-core/dist/fiscal-batch';
import {fiscalSnapshotSha256,fiscalLimaDate,type FiscalAcceptanceEvidence} from '@factuez/sunat-core/dist/fiscal-note';
import {verifyBetaSummaryAcceptance,betaCdrZipMetadata,betaCdrCrc32} from './beta-summary-acceptance';
import type {BetaAcceptanceArtifact,BetaAcceptanceDocument} from './beta-document-acceptance';
import type {BetaOwnerXmlTrust} from '../infrastructure/crypto/beta-owner-xml-trust';
import type {CdrSignatureTrustService} from '../infrastructure/crypto/cdr-signature-trust.service';
import {singleNotesTransportXml} from '../infrastructure/sunat/notes-transport-qa-validator';
import {parseCdrZip} from '../infrastructure/sunat/cdr-parser';
import {safeXml,leaf,CBC_NS} from '../infrastructure/sunat/safe-xml';
export interface BetaOwnedSummaryRecord {
  batch:FiscalBatchSnapshot;status:'ACCEPTED'|'ACCEPTED_WITH_OBSERVATIONS';completedAt:string;submissionId:string;
  version:string;signerFingerprint:string;digestValue:string;signedXml:BetaAcceptanceArtifact;requestZip:BetaAcceptanceArtifact;cdrZip:BetaAcceptanceArtifact;
}
export interface BetaSummaryOwner {current(document:BetaAcceptanceDocument):Promise<BetaOwnedSummaryRecord|null>}
const seals=new WeakSet<object>(),hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export const isBetaOwnerSummaryAcceptance=(v:unknown)=>!!v&&typeof v==='object'&&seals.has(v);
/** Latest authoritative RC member + signed request/package + CDR, never caller membership flags. */
export class BetaOwnerSummaryAcceptance {
  constructor(private readonly repository:BetaSummaryOwner,private readonly artifacts:{read(id:string,a:BetaAcceptanceArtifact):Promise<Buffer>},
    private readonly signatures:Pick<BetaOwnerXmlTrust,'verifyBatch'>,private readonly cdr:Pick<CdrSignatureTrustService,'verify'>){}
  async verify(input:BetaAcceptanceDocument,asOf:string){
    const document=boundedSupplementJson(input) as BetaAcceptanceDocument,inputHash=fiscalSnapshotSha256(input);
    if(document.environment!=='BETA'||!document.series.startsWith('B')||!['03','07','08'].includes(document.documentTypeCode))throw new Error('SUMMARY_BETA_MEMBER_REQUIRED');
    const load=async()=>{const r=await this.repository.current(document);if(!r)throw new Error('CURRENT_RC_REQUIRED');return boundedSupplementJson(r) as BetaOwnedSummaryRecord;};
    const record=await load(),recordHash=fiscalSnapshotSha256(record),batch=record.batch;
    const line=batch.input.entries.findIndex(e=>e.document.snapshot.documentId===document.documentId),member=batch.input.entries[line];
    if(batch.kind!=='RC'||!member||!('conditionCode'in member)||!['1','2'].includes(member.conditionCode)||fiscalSnapshotSha256(member.document.snapshot)!==fiscalSnapshotSha256(document))throw new Error('CURRENT_RC_VERSION_REQUIRED');
    const evidence:FiscalAcceptanceEvidence={environment:'BETA',issuerRuc:document.issuer.identityNumber,documentId:document.documentId,documentTypeCode:document.documentTypeCode as '03'|'07'|'08',fullNumber:document.fullNumber,
      snapshotSha256:fiscalSnapshotSha256(document),cdrSha256:record.cdrZip.sha256,status:record.status,responseCode:'0',acceptedAt:record.completedAt,
      source:{kind:'CDR_SUMMARY',identifier:batch.identifier,referenceDate:fiscalLimaDate(document.issueDate),lineNumber:line+1,conditionCode:member.conditionCode as '1'|'2'}};
    const read=async(a:BetaAcceptanceArtifact)=>{if(!a||!Number.isSafeInteger(a.sizeBytes)||a.sizeBytes<1||a.sizeBytes>4*1024*1024||!/^[a-f0-9]{64}$/.test(a.sha256))throw new Error('RC_ARTIFACT_INVALID');
      const bytes=Buffer.from(await this.artifacts.read(batch.documentId,structuredClone(a)));if(bytes.length!==a.sizeBytes||hash(bytes)!==a.sha256)throw new Error('RC_ARTIFACT_MISMATCH');return bytes;};
    const xml=await read(record.signedXml),zip=await read(record.requestZip),cdrZip=await read(record.cdrZip),fileName=`${batch.issuer.identityNumber}-${batch.identifier}.zip`;
    const parsed=parseCdrZip(cdrZip,{fileName:'R-'+fileName.replace(/\.zip$/,'.xml'),issuerRuc:batch.issuer.identityNumber,reference:batch.identifier});
    const cdrDate=leaf(safeXml(parsed.xml.toString('utf8')),CBC_NS,'IssueDate',10);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(cdrDate)||new Date(cdrDate+'T00:00:00Z').toISOString().slice(0,10)!==cdrDate||cdrDate>fiscalLimaDate(record.completedAt)||cdrDate<batch.issueDate)throw new Error('RC_CDR_DATE_INVALID');
    const archived=singleNotesTransportXml(zip,fileName),crc=betaCdrZipMetadata(zip,fileName.replace(/\.zip$/,'.xml'));
    if(!archived.equals(xml)||archived.length!==crc.size||betaCdrCrc32(archived)!==crc.crc)throw new Error('RC_REQUEST_PACKAGE_MISMATCH');
    const signer=await this.signatures.verifyBatch(batch,record.signerFingerprint,Buffer.from(xml),buildFiscalBatchUbl(batch,asOf),asOf);
    if(signer.digestValue!==record.digestValue||signer.certificateFingerprint!==record.signerFingerprint||signer.checkedAt!==asOf||!/^[a-f0-9]{64}$/.test(signer.trustStoreSha256))throw new Error('RC_SIGNER_PROOF_MISMATCH');
    const proof=await verifyBetaSummaryAcceptance(document,evidence,asOf,{
      loadBatch:async(ruc,environment,identifier)=>{const current=await load();if(ruc!==current.batch.issuer.identityNumber||environment!=='BETA'||identifier!==current.batch.identifier||fiscalSnapshotSha256(current)!==recordHash)throw new Error('RC_CHANGED');
        return {batch:current.batch,status:current.status,completedAt:current.completedAt,cdrZip:{...current.cdrZip,fileName:`R-${ruc}-${identifier}.zip`},requestXml:{bytes:Buffer.from(xml),sha256:record.signedXml.sha256}};},
      readCdr:async()=>Buffer.from(cdrZip),verifySignature:bytes=>this.cdr.verify(bytes),
    });
    if(fiscalSnapshotSha256(await load())!==recordHash||fiscalSnapshotSha256(input)!==inputHash||!xml.equals(await read(record.signedXml))||!zip.equals(await read(record.requestZip))||!cdrZip.equals(await read(record.cdrZip)))throw new Error('RC_EVIDENCE_CHANGED');
    Object.freeze(evidence.source);Object.freeze(evidence);
    const result=Object.freeze({schemaVersion:'factuez.beta.owner-summary-acceptance.v1',evidence,proof:Object.freeze(proof),
      fence:Object.freeze({submissionId:record.submissionId,ownerRecordSha256:recordHash,ownerVersion:record.version,requestZipSha256:hash(zip),signedXmlSha256:hash(xml),cdrZipSha256:hash(cdrZip),cdrXmlSha256:proof.cdrXmlSha256}),
      candidateOnly:true as const,fiscalExecutionEnabled:false as const,transmissionAuthorized:false as const});
    seals.add(result);return result;
  }
}
