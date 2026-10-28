import {createHash} from 'node:crypto';
import {validateFiscalSupplementCommand,boundedSupplementJson,type FiscalSupplementCommand} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import {fiscalSnapshotSha256,fiscalTimestamp,fiscalLimaDate} from '@factuez/sunat-core/dist/fiscal-note';
import {betaFiscalIdentity} from '../infrastructure/crypto/beta-fiscal-package-pipeline';
import type {BetaOwnerXmlTrust} from '../infrastructure/crypto/beta-owner-xml-trust';
import type {CdrSignatureTrustService} from '../infrastructure/crypto/cdr-signature-trust.service';
import {singleNotesTransportXml} from '../infrastructure/sunat/notes-transport-qa-validator';
import {betaCdrZipMetadata,betaCdrCrc32} from './beta-summary-acceptance';
import {parseCdrZip} from '../infrastructure/sunat/cdr-parser';
import {safeXml,child,leaf,CAC_NS,CBC_NS} from '../infrastructure/sunat/safe-xml';
import type {BetaAcceptanceArtifact} from './beta-document-acceptance';
export interface BetaOutcomeRecord {commandSha256:string;submissionId:string;completedAt:string;version:string;fingerprint:string;digestValue:string;responseCode:string;result:'SUCCESS'|'BUSINESS_ERROR';
  signedXml:BetaAcceptanceArtifact;requestZip:BetaAcceptanceArtifact;cdrZip:BetaAcceptanceArtifact}
export interface BetaOutcomeOwner {load(command:FiscalSupplementCommand):Promise<BetaOutcomeRecord|null>;read(id:string,a:BetaAcceptanceArtifact):Promise<Buffer>}
const seals=new WeakSet<object>(),hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
function freeze<T>(value:T):T{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
export const isBetaVerifiedSupplementOutcome=(v:unknown)=>!!v&&typeof v==='object'&&seals.has(v);
/** Includes trusted REJECTION (no financial effect), RC/RA and individual notes. Never a Boolean event flag. */
export class BetaVerifiedSupplementOutcome {
  constructor(private readonly owner:BetaOutcomeOwner,private readonly signatures:Pick<BetaOwnerXmlTrust,'verifyEnvelope'>,private readonly cdr:Pick<CdrSignatureTrustService,'verify'>){}
  async verify(input:unknown,asOf:string){
    const command=freeze(validateFiscalSupplementCommand(input)),identity=betaFiscalIdentity(command.payload.envelope),commandHash=fiscalSnapshotSha256(command);fiscalTimestamp(asOf,'asOf');
    const load=async()=>{const r=await this.owner.load(command);if(!r)throw new Error('OWN_OUTCOME_REQUIRED');return boundedSupplementJson(r) as BetaOutcomeRecord;};
    const record=await load(),stamp=fiscalSnapshotSha256(record);
    if(record.commandSha256!==commandHash||!/^[a-f0-9]{64}$/.test(record.version)||!/^[a-f0-9]{64}$/.test(record.fingerprint)||!['SUCCESS','BUSINESS_ERROR'].includes(record.result))throw new Error('OUTCOME_COMMAND_MISMATCH');
    if(new Set([record.signedXml.id,record.requestZip.id,record.cdrZip.id]).size!==3||new Set([record.signedXml.storageKey,record.requestZip.storageKey,record.cdrZip.storageKey]).size!==3)throw new Error('OUTCOME_ARTIFACT_ALIASES');
    fiscalTimestamp(record.completedAt,'completedAt');if(Date.parse(record.completedAt)>Date.parse(asOf)||Date.parse(record.completedAt)<Date.parse(command.occurredAt))throw new Error('OUTCOME_TIME_INVALID');
    const read=async(a:BetaAcceptanceArtifact)=>{if(!Number.isSafeInteger(a.sizeBytes)||a.sizeBytes<1||a.sizeBytes>4*1024*1024)throw new Error('OUTCOME_ARTIFACT_INVALID');
      const b=Buffer.from(await this.owner.read(identity.documentId,structuredClone(a)));if(b.length!==a.sizeBytes||hash(b)!==a.sha256)throw new Error('OUTCOME_ARTIFACT_MISMATCH');return b;};
    const xml=await read(record.signedXml),request=await read(record.requestZip),response=await read(record.cdrZip),name=identity.fileName.replace(/\.zip$/,'.xml');
    const archived=singleNotesTransportXml(request,identity.fileName),metadata=betaCdrZipMetadata(request,name);
    if(!archived.equals(xml)||metadata.size!==xml.length||metadata.crc!==betaCdrCrc32(xml))throw new Error('OUTCOME_PACKAGE_MISMATCH');
    const signature=await this.signatures.verifyEnvelope(command.payload.envelope,record.fingerprint,Buffer.from(xml),asOf);
    if(signature.digestValue!==record.digestValue||signature.certificateFingerprint!==record.fingerprint||signature.checkedAt!==asOf||!/^[a-f0-9]{64}$/.test(signature.trustStoreSha256))throw new Error('OUTCOME_SIGNER_MISMATCH');
    const cdrMetadata=betaCdrZipMetadata(response,'R-'+name),parsed=parseCdrZip(response,{fileName:'R-'+name,issuerRuc:identity.ruc,reference:identity.reference});
    if(parsed.code!==record.responseCode||(parsed.status==='REJECTED')!==(record.result==='BUSINESS_ERROR'))throw new Error('OUTCOME_CDR_RESULT_MISMATCH');
    if(cdrMetadata.size!==parsed.xml.length||cdrMetadata.crc!==betaCdrCrc32(parsed.xml)||!Buffer.from(parsed.xml.toString('utf8')).equals(parsed.xml))throw new Error('OUTCOME_CDR_INVALID');
    const root=safeXml(parsed.xml.toString('utf8')),answer=child(child(root,CAC_NS,'DocumentResponse'),CAC_NS,'Response');
    const cdrDate=leaf(root,CBC_NS,'IssueDate',10);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(cdrDate)||new Date(cdrDate+'T00:00:00Z').toISOString().slice(0,10)!==cdrDate||cdrDate>fiscalLimaDate(record.completedAt)||cdrDate<fiscalLimaDate(command.occurredAt))throw new Error('OUTCOME_CDR_DATE_INVALID');
    if(leaf(child(child(root,CAC_NS,'SenderParty'),CAC_NS,'PartyIdentification'),CBC_NS,'ID',11)!=='20131312955'||leaf(answer,CBC_NS,'ReferenceID',40)!==identity.reference)throw new Error('OUTCOME_CDR_BINDING_INVALID');
    if(command.payload.envelope.kind==='NOTE'&&leaf(child(child(root,CAC_NS,'DocumentResponse'),CAC_NS,'DocumentReference'),CBC_NS,'DocumentTypeCode',2)!==command.payload.envelope.note.documentTypeCode)throw new Error('OUTCOME_CDR_TYPE_INVALID');
    if(await this.cdr.verify(Buffer.from(parsed.xml))!==true)throw new Error('OUTCOME_CDR_UNTRUSTED');
    if(stamp!==fiscalSnapshotSha256(await load())||!xml.equals(await read(record.signedXml))||!request.equals(await read(record.requestZip))||!response.equals(await read(record.cdrZip)))throw new Error('OUTCOME_CHANGED');
    const evidence=Object.freeze({status:parsed.status,cdrSignatureVerified:true,officialCdr:true,cdrSha256:hash(response),requestSha256:hash(request),responseCode:parsed.code,acceptedAt:record.completedAt});
    const result=Object.freeze({schemaVersion:'factuez.beta.verified-supplement-outcome.v1',commandSha256:commandHash,operationId:command.payload.operationId,submissionId:record.submissionId,
      evidence,fence:Object.freeze({version:record.version,recordSha256:stamp,xmlSha256:hash(xml),requestSha256:hash(request),cdrSha256:hash(response)}),
      candidateOnly:true as const,fiscalExecutionEnabled:false as const,transmissionAuthorized:false as const});seals.add(result);return result;
  }
}
