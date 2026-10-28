import {fiscalSnapshotSha256,fiscalTimestamp} from '@factuez/sunat-core/dist/fiscal-note';
import {boundedSupplementJson} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import {verifyBoletaPackage,type BoletaPackageRecord} from './boleta-package-evidence-b2b09';
import {BetaOwnerSummaryAcceptance,isBetaOwnerSummaryAcceptance,type BetaSummaryOwner} from './beta-owner-summary-acceptance';
import type {BatchEvidenceVersion,BatchEvidenceAcceptanceFence,BatchMemberArtifactPort} from './batch-member-evidence';
import type {BetaOwnerXmlTrust} from '../infrastructure/crypto/beta-owner-xml-trust';
import type {CdrSignatureTrustService} from '../infrastructure/crypto/cdr-signature-trust.service';

/** Private exact-version owner record, not a public request or an implementation of the historical store. */
export type BoletaRcLinkedRecord={member:BatchEvidenceVersion; ownerVersion:string; package:BoletaPackageRecord; acceptanceFence:BatchEvidenceAcceptanceFence};
export async function verifyBoletaRcLinked(handle:string,asOf:string,ports:{
  loadExact(handle:string):Promise<BoletaRcLinkedRecord|null>; artifacts:BatchMemberArtifactPort;
  signatures:Pick<BetaOwnerXmlTrust,'verifyPreparedDocument'|'verifyBatch'>;
  summary:BetaSummaryOwner; cdr:Pick<CdrSignatureTrustService,'verify'>;
}) {
 try {
  if(typeof handle!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(handle))throw Error();
  fiscalTimestamp(asOf,'asOf');
  const load=async()=>{const r=await ports.loadExact(handle);if(!r)throw Error();return boundedSupplementJson(r) as BoletaRcLinkedRecord;};
  const r=await load(),stamp=fiscalSnapshotSha256(r),p=r.package,d=p.document,t=p.transport;
  if(!r.member||!Number.isSafeInteger(r.member.version)||r.member.version<1||r.member.documentId!==d.documentId||
    r.member.snapshotSha256!==fiscalSnapshotSha256(d)||!/^[a-f0-9]{64}$/.test(r.ownerVersion)||
    d.environment!=='BETA'||d.documentTypeCode!=='03'||t.kind!=='RC')throw Error();
  const packageProof=await verifyBoletaPackage({load:async()=>{const current=await load();if(fiscalSnapshotSha256(current)!==stamp)throw Error();return current.package;},read:ports.artifacts.read.bind(ports.artifacts),signatures:ports.signatures},asOf);
  const verifier=new BetaOwnerSummaryAcceptance(ports.summary,ports.artifacts,ports.signatures,ports.cdr);
  const acceptance=await verifier.verify(structuredClone(d),asOf);
  const source=acceptance.evidence.source;
  if(!isBetaOwnerSummaryAcceptance(acceptance)||source.kind!=='CDR_SUMMARY'||packageProof.kind!=='RC'||
    packageProof.memberXmlSha256!==p.memberXml.sha256||packageProof.requestZipSha256!==acceptance.fence.requestZipSha256||
    packageProof.rcXmlSha256!==acceptance.fence.signedXmlSha256||packageProof.rcIdentifier!==source.identifier||
    packageProof.lineNumber!==source.lineNumber||acceptance.proof.batchSnapshotSha256!==fiscalSnapshotSha256(t.batch)||
    acceptance.evidence.snapshotSha256!==r.member.snapshotSha256||acceptance.evidence.cdrSha256!==acceptance.fence.cdrZipSha256||
    fiscalSnapshotSha256(acceptance.fence)!==fiscalSnapshotSha256(r.acceptanceFence))throw Error();
  // Repeat both verifications across the other verifier's asynchronous work; this is not an atomic fence.
  const again=await verifyBoletaPackage({load:async()=>{const current=await load();if(fiscalSnapshotSha256(current)!==stamp)throw Error();return current.package;},read:ports.artifacts.read.bind(ports.artifacts),signatures:ports.signatures},asOf);
  const second=await verifier.verify(structuredClone(d),asOf);
  if(!isBetaOwnerSummaryAcceptance(second)||fiscalSnapshotSha256(again)!==fiscalSnapshotSha256(packageProof)||
    fiscalSnapshotSha256(second)!==fiscalSnapshotSha256(acceptance)||fiscalSnapshotSha256(await load())!==stamp)throw Error();
  return Object.freeze({schemaVersion:'factuez.boleta-rc-linked.v1' as const,member:Object.freeze(structuredClone(r.member)),
    ownerVersion:r.ownerVersion,ownerRecordSha256:stamp,memberXmlSha256:packageProof.memberXmlSha256,
    acceptance,verifiedAt:asOf,candidateOnly:true as const,fiscalExecutionEnabled:false as const,transmissionAuthorized:false as const});
 } catch {throw new Error('BOLETA_RC_LINK_VERIFICATION_FAILED');}
}