import {documentEvidenceFixture,ACCEPTED} from './beta-document-evidence.fixture';
import {supplementUuid as id} from './fiscal-supplement.fixture';
import {fiscalSnapshotSha256} from '../../packages/sunat-core/src/fiscal-note';
export function ownerDocumentFixture(type:'01'|'07'|'08'='01'){
  const f=documentEvidenceFixture(type),requestKey=`${f.doc.documentId}/request.zip`,prepared={
    fingerprint:f.record.signerFingerprint,digest:f.record.digestValue,reference:f.doc.fullNumber,fileName:`${f.doc.issuer.identityNumber}-${type}-${f.doc.fullNumber}.zip`,
    xml:{storageKey:f.record.signedXml.storageKey,sha256:f.record.signedXml.sha256,sizeBytes:f.record.signedXml.sizeBytes},
    documentXml:{storageKey:f.record.signedXml.storageKey,sha256:f.record.signedXml.sha256,sizeBytes:f.record.signedXml.sizeBytes},zip:{storageKey:f.record.requestZip.storageKey,sha256:f.record.requestZip.sha256,sizeBytes:f.record.requestZip.sizeBytes}};
  const envelope={kind:'NOTE',note:f.doc,context:f.record.noteContext};
  const metadata={version:1,eventId:id(70),correlationId:id(71),prepared,...(type!=='01'?{kind:'BETA_SUPPLEMENT',envelope,envelopeSha256:fiscalSnapshotSha256(envelope)}:{})};
  const row={documentId:f.doc.documentId,issuerRuc:f.doc.issuer.identityNumber,environment:'BETA',documentType:type,series:f.doc.series,number:BigInt(f.doc.number),
    status:f.record.status,acceptedAt:new Date(ACCEPTED),immutablePayload:f.doc,digestValue:f.record.digestValue,billingEventId:id(70),updatedAt:new Date(ACCEPTED),
    artifacts:[{...f.record.signedXml,kind:'SIGNED_XML',sizeBytes:BigInt(f.record.signedXml.sizeBytes)},{...f.record.cdrZip,kind:'CDR_ZIP',sizeBytes:BigInt(f.record.cdrZip.sizeBytes)},{...f.record.requestZip,kind:'SUBMISSION_ZIP',sizeBytes:BigInt(f.record.requestZip.sizeBytes)}],
    submissions:[{id:f.record.submissionId,documentId:f.doc.documentId,batchId:null,channel:'SOAP_SEND_BILL',result:'SUCCESS',errorCode:'DONE',
      errorMessage:JSON.stringify(metadata),idempotencyKey:`${type==='01'?'beta:':'beta-supplement:'}${f.doc.documentId}:v1`,requestArtifactKey:requestKey,responseArtifactKey:f.record.cdrZip.storageKey,
      completedAt:new Date(ACCEPTED),startedAt:new Date('2026-10-03T17:59:00Z'),
      cdrLogs:[{documentId:f.doc.documentId,batchId:null,submissionId:f.record.submissionId,responseCode:'0',cdrStorageKey:f.record.cdrZip.storageKey,cdrSha256:f.record.cdrZip.sha256}]}]};
  return {...f,row,metadata};
}
