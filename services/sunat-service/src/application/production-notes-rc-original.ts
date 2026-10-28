import { isDeepStrictEqual } from 'node:util';
import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import { buildInvoiceUbl, buildReceiptSummary, buildReceiptSummarySnapshot, fiscalSnapshotSha256, receiptSummaryReconstructionAsOf } from '@factuez/sunat-core';
import type { PrismaService } from '../infrastructure/prisma.service';
import type { XmlRootKind } from '../infrastructure/crypto/xml-signer.service';
import { productionTransportXml } from '../infrastructure/sunat/production-transport-zip';
import type { parseCdrZip } from '../infrastructure/sunat/cdr-parser';
import type { BetaManifest } from './beta-issuance.repository';
type File={kind:string;storageKey:string;sha256:string;sizeBytes:number|bigint;mediaType:string;documentId:string};
type MathProof=(ruc:string,xml:Buffer,unsigned:string,kind:XmlRootKind,fingerprint?:string)=>{digest:string;fingerprint:string};
/** Read-only raw archive verification. Embedded certificates prove identity and signature
 * mathematics only. No current PKI/CRL, credentials, grants, P12, rendering or network. */
export async function productionNotesOriginal03Raw(snapshot:FiscalDocumentSnapshot,prisma:PrismaService,
  read:(id:string,file:File,media:string)=>Promise<Buffer>,signed:MathProof,cdr:(zip:Buffer,xml:Buffer,ruc:string,type:'RC',reference:string)=>ReturnType<typeof parseCdrZip>){
  const doc=await prisma.fiscalDocument.findUnique({where:{documentId:snapshot.documentId},include:{artifacts:true,submissions:true}});
  if(!doc||snapshot.documentTypeCode!=='03'||doc.documentType!=='03'||doc.environment!=='PRODUCTION'||doc.issuerRuc!==snapshot.issuer.identityNumber||doc.series!==snapshot.series||doc.number!==BigInt(snapshot.number)||!isDeepStrictEqual(doc.immutablePayload,JSON.parse(JSON.stringify(snapshot)))||!['ACCEPTED','ACCEPTED_WITH_OBSERVATIONS'].includes(doc.status)||!doc.acceptedAt||!Number.isFinite(doc.acceptedAt.getTime())||doc.acceptedAt.getTime()<Date.parse(snapshot.issueDate)||doc.acceptedAt.getTime()>Date.now())throw Error('RAW_03_OWNER_INVALID');
  const one=(kind:string)=>{const a=doc.artifacts.filter(f=>f.kind===kind);if(a.length!==1)throw Error('RAW_03_ARTIFACT_REQUIRED');return a[0]!;};
  const submissions=doc.submissions.filter(s=>s.channel==='SOAP_SEND_SUMMARY');
  if(submissions.length!==1)throw Error('RAW_03_UNIQUE_SUBMISSION_REQUIRED');
  const submission=submissions[0]!;
  if(submission.documentId!==snapshot.documentId||!submission.batchId||submission.idempotencyKey!==`production:${snapshot.documentId}:v1`||submission.errorCode!=='DONE'||submission.result!=='SUCCESS'||!submission.completedAt||!submission.errorMessage||submission.errorMessage.length>262144)throw Error('RAW_03_SUBMISSION_INVALID');
  const metadata=JSON.parse(submission.errorMessage) as {version:number;eventId:string;correlationId:string;prepared?:BetaManifest},manifest=metadata.prepared;
  if(metadata.version!==1||metadata.eventId!==doc.billingEventId||!metadata.correlationId||!manifest||manifest.documentSnapshotSha256!==fiscalSnapshotSha256(snapshot)||!Number.isSafeInteger(manifest.revision)||manifest.revision<0)throw Error('RAW_03_MANIFEST_REQUIRED');
  const asOf=receiptSummaryReconstructionAsOf(manifest.reference),expected=buildReceiptSummarySnapshot(snapshot,manifest.reference,asOf);
  const batch=await prisma.fiscalBatch.findUnique({where:{summaryId:snapshot.documentId},include:{artifacts:true}});
  if(!batch||batch.summaryId!==snapshot.documentId||batch.id!==submission.batchId||batch.environment!=='PRODUCTION'||batch.issuerRuc!==snapshot.issuer.identityNumber||batch.identifier!==manifest.reference||batch.billingEventId!==metadata.eventId||batch.status!==doc.status||!isDeepStrictEqual(batch.immutablePayload,JSON.parse(JSON.stringify(expected)))||manifest.requestOwnerId!==expected.documentId||manifest.requestOwnerId===snapshot.documentId||manifest.fileName!==snapshot.issuer.identityNumber+'-'+manifest.reference+'.zip')throw Error('RAW_03_BATCH_BINDING_INVALID');
  const batchOne=(kind:string)=>{const a=batch.artifacts.filter(f=>f.kind===kind);if(a.length!==1||a[0]!.batchId!==batch.id)throw Error('RAW_03_BATCH_ARTIFACT_REQUIRED');return a[0]!;};
  const match=(a:{storageKey:string;sha256:string;sizeBytes:number|bigint},b:{storageKey:string;sha256:string;sizeBytes:number}|undefined)=>{if(!b||a.storageKey!==b.storageKey||a.sha256!==b.sha256||!Number.isSafeInteger(b.sizeBytes)||BigInt(a.sizeBytes)!==BigInt(b.sizeBytes))throw Error('RAW_03_MANIFEST_FILE_INVALID');};
  const memberXml=one('SIGNED_XML'),memberZip=one('SUBMISSION_ZIP'),summaryXml=batchOne('SIGNED_XML'),summaryZip=batchOne('SUBMISSION_ZIP');
  match(memberXml,manifest.documentXml);match(memberZip,manifest.individualXmlZip);match(summaryXml,manifest.xml);match(summaryZip,manifest.zip);
  if(submission.requestArtifactKey!==summaryZip.storageKey||memberXml.storageKey===summaryXml.storageKey||memberZip.storageKey===summaryZip.storageKey)throw Error('RAW_03_REQUEST_BINDING_INVALID');
  const xml=await read(snapshot.documentId,memberXml,'application/xml'),zip=await read(snapshot.documentId,memberZip,'application/zip');
  if(!productionTransportXml(zip,snapshot.issuer.identityNumber+'-03-'+snapshot.fullNumber+'.xml').xml.equals(xml))throw Error('RAW_03_INDIVIDUAL_ZIP_INVALID');
  const individual=signed(snapshot.issuer.identityNumber,xml,buildInvoiceUbl(snapshot,{mode:'REAL_PREPARATION'}),'Invoice',manifest.fingerprint);
  if(individual.digest!==doc.digestValue||individual.digest!==manifest.digest)throw Error('RAW_03_DIGEST_INVALID');
  const batchRead=(a:typeof summaryXml,media:string)=>read(expected.documentId,{...a,documentId:expected.documentId},media);
  const rcXml=await batchRead(summaryXml,'application/xml'),rcZip=await batchRead(summaryZip,'application/zip');
  if(!productionTransportXml(rcZip,manifest.fileName.replace(/\.zip$/,'.xml')).xml.equals(rcXml))throw Error('RAW_03_RC_ZIP_INVALID');
  signed(snapshot.issuer.identityNumber,rcXml,buildReceiptSummary(snapshot,manifest.reference,'REAL_PREPARATION',asOf),'SummaryDocuments',individual.fingerprint);
  const batchCdrXml=await batchRead(batchOne('CDR_XML'),'application/xml'),batchCdrZip=await batchRead(batchOne('CDR_ZIP'),'application/zip');
  const memberCdrXml=one('CDR_XML'),memberCdrZip=one('CDR_ZIP');
  if(submission.responseArtifactKey!==memberCdrZip.storageKey||!(await read(snapshot.documentId,memberCdrXml,'application/xml')).equals(batchCdrXml)||!(await read(snapshot.documentId,memberCdrZip,'application/zip')).equals(batchCdrZip))throw Error('RAW_03_CDR_COPY_INVALID');
  const result=cdr(batchCdrZip,batchCdrXml,snapshot.issuer.identityNumber,'RC',manifest.reference);
  if(result.status!==doc.status)throw Error('RAW_03_CDR_STATE_INVALID');
  return {profile:'PRODUCTION-03-RC-ARCHIVE-v1' as const,documentId:snapshot.documentId,snapshotSha256:fiscalSnapshotSha256(snapshot),signedXmlSha256:memberXml.sha256,cdrXmlSha256:memberCdrXml.sha256,cdrZipSha256:memberCdrZip.sha256,acceptedAt:doc.acceptedAt.toISOString(),receiptSummary:{identifier:manifest.reference,individualXmlSha256:memberXml.sha256,individualZipSha256:memberZip.sha256,summaryXmlSha256:summaryXml.sha256,summaryZipSha256:summaryZip.sha256,cdrXmlSha256:memberCdrXml.sha256,cdrZipSha256:memberCdrZip.sha256}};
}
