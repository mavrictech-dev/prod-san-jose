import {boundedSupplementJson} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import {fiscalSnapshotSha256} from '@factuez/sunat-core/dist/fiscal-note';
import type {FiscalBatchSnapshot} from '@factuez/sunat-core/dist/fiscal-batch';
import type {PrismaService} from '../infrastructure/prisma.service';
import type {BetaAcceptanceDocument,BetaAcceptanceArtifact} from './beta-document-acceptance';
import type {BetaSummaryOwner,BetaOwnedSummaryRecord} from './beta-owner-summary-acceptance';
/** Bounded authoritative membership lookup. Pending/conflicting/unknown versions require reconciliation. */
export class PrismaBetaSummaryOwner implements BetaSummaryOwner {
  constructor(private readonly db:PrismaService){}
  async current(document:BetaAcceptanceDocument):Promise<BetaOwnedSummaryRecord|null>{
    if(document.environment!=='BETA'||!document.series.startsWith('B')||!/^\d{11}$/.test(document.issuer.identityNumber))throw new Error('SUMMARY_BETA_REQUIRED');
    const rows=await this.db.fiscalBatch.findMany({where:{issuerRuc:document.issuer.identityNumber,environment:'BETA',identifier:{startsWith:'RC-'}},take:201,
      select:{id:true,summaryId:true,identifier:true,billingEventId:true,status:true,immutablePayload:true,updatedAt:true,
        artifacts:{where:{kind:{in:['SIGNED_XML','SUBMISSION_ZIP','CDR_ZIP']}},select:{id:true,kind:true,storageKey:true,sha256:true,sizeBytes:true}},
        submissions:{take:2,orderBy:[{startedAt:'desc'},{id:'desc'}],select:{id:true,idempotencyKey:true,channel:true,result:true,errorCode:true,errorMessage:true,documentId:true,batchId:true,completedAt:true,requestArtifactKey:true,responseArtifactKey:true,
          cdrLogs:{take:2,select:{submissionId:true,batchId:true,responseCode:true,cdrStorageKey:true,cdrSha256:true}}}}}});
    if(rows.length>200)throw new Error('RC_HISTORY_LIMIT');
    const candidates:BetaOwnedSummaryRecord[]=[];
    for(const row of rows){
      if(row.status==='REJECTED')continue;
      const batch=boundedSupplementJson(row.immutablePayload) as FiscalBatchSnapshot;
      if(batch.kind!=='RC'||batch.input?.kind!=='RC'||!Array.isArray(batch.input.entries))throw new Error('RC_PROFILE_REQUIRES_RECONCILIATION');
      const matches=batch.input.entries.filter(e=>e.document.snapshot.documentId===document.documentId||
        e.document.snapshot.documentTypeCode===document.documentTypeCode&&e.document.snapshot.series===document.series&&e.document.snapshot.number===document.number);
      if(!matches.length)continue;
      if(matches.length!==1||!['ACCEPTED','ACCEPTED_WITH_OBSERVATIONS'].includes(row.status)||row.submissions.length!==1)throw new Error('RC_MEMBERSHIP_AMBIGUOUS');
      const submission=row.submissions[0],log=submission.cdrLogs[0];
      if(!submission.completedAt||submission.channel!=='SOAP_SEND_SUMMARY'||submission.result!=='SUCCESS'||submission.errorCode!=='DONE'||submission.batchId!==row.id||submission.documentId!==null||submission.idempotencyKey!==`beta-supplement:${batch.documentId.toLowerCase()}:v1`||submission.cdrLogs.length!==1||!log||
        log.submissionId!==submission.id||log.batchId!==row.id||log.responseCode!=='0'||!submission.errorMessage||submission.errorMessage.length>256*1024)throw new Error('RC_SUBMISSION_INCOMPLETE');
      const metadata=boundedSupplementJson(JSON.parse(submission.errorMessage)) as any,manifest=metadata.prepared;
      if(metadata.kind!=='BETA_SUPPLEMENT'||metadata.eventId!==row.billingEventId||metadata.envelope?.kind!=='BATCH'||fiscalSnapshotSha256(metadata.envelope.batch)!==fiscalSnapshotSha256(batch)||
        fiscalSnapshotSha256(metadata.envelope)!==metadata.envelopeSha256||batch.documentId!==row.summaryId||batch.identifier!==row.identifier||batch.environment!=='BETA'||batch.issuer.identityNumber!==document.issuer.identityNumber||!manifest||manifest.fileName!==`${batch.issuer.identityNumber}-${batch.identifier}.zip`||manifest.reference!==batch.identifier||!/^[a-f0-9]{64}$/.test(manifest.fingerprint))throw new Error('RC_MANIFEST_INVALID');
      const xml=row.artifacts.find(a=>a.kind==='SIGNED_XML'),zip=row.artifacts.find(a=>a.kind==='SUBMISSION_ZIP'),cdr=row.artifacts.find(a=>a.kind==='CDR_ZIP');
      if(row.artifacts.length!==3||!xml||!zip||!cdr||manifest.xml?.sha256!==xml.sha256||manifest.xml.storageKey!==xml.storageKey||String(manifest.xml.sizeBytes)!==String(xml.sizeBytes)||
        manifest.zip?.sha256!==zip.sha256||manifest.zip.storageKey!==zip.storageKey||String(manifest.zip.sizeBytes)!==String(zip.sizeBytes)||submission.requestArtifactKey!==zip.storageKey||submission.responseArtifactKey!==cdr.storageKey||log.cdrSha256!==cdr.sha256||log.cdrStorageKey!==cdr.storageKey)throw new Error('RC_ARTIFACT_BINDING_INVALID');
      const a=(v:typeof xml):BetaAcceptanceArtifact=>({id:v.id,storageKey:v.storageKey,sha256:v.sha256,sizeBytes:Number(v.sizeBytes)});
      candidates.push({batch,status:row.status as BetaOwnedSummaryRecord['status'],completedAt:submission.completedAt.toISOString(),submissionId:submission.id,
        signerFingerprint:manifest.fingerprint,digestValue:manifest.digest,version:fiscalSnapshotSha256({updatedAt:row.updatedAt.toISOString(),metadata,batchId:row.id,submissionId:submission.id}),signedXml:a(xml),requestZip:a(zip),cdrZip:a(cdr)});
    }
    candidates.sort((a,b)=>Date.parse(b.completedAt)-Date.parse(a.completedAt));
    if(candidates.length>1&&candidates[0].completedAt===candidates[1].completedAt)throw new Error('RC_ORDER_AMBIGUOUS');
    return candidates[0]??null;
  }
}
