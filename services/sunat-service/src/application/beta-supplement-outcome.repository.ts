import {fiscalSnapshotSha256} from '@factuez/sunat-core/dist/fiscal-note';
import type {FiscalSupplementCommand} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import {boundedSupplementJson} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import {betaFiscalIdentity} from '../infrastructure/crypto/beta-fiscal-package-pipeline';
import type {PrismaService} from '../infrastructure/prisma.service';
import type {ArtifactStore} from '../infrastructure/artifact-store';
import type {BetaOutcomeOwner,BetaOutcomeRecord} from './beta-verified-supplement-outcome';
import type {BetaAcceptanceArtifact} from './beta-document-acceptance';
/** One authoritative operation. No newest-success fallback or reads of credentials. */
export class PrismaBetaSupplementOutcomeOwner implements BetaOutcomeOwner {
  constructor(private readonly db:PrismaService,private readonly artifacts:Pick<ArtifactStore,'read'>){}
  read(id:string,a:BetaAcceptanceArtifact){return this.artifacts.read(id,a);}
  async load(command:FiscalSupplementCommand):Promise<BetaOutcomeRecord|null>{
    const identity=betaFiscalIdentity(command.payload.envelope),row=await this.db.sunatSubmission.findUnique({where:{idempotencyKey:`beta-supplement:${identity.documentId.toLowerCase()}:v1`},
      select:{id:true,documentId:true,batchId:true,channel:true,result:true,errorCode:true,errorMessage:true,requestArtifactKey:true,responseArtifactKey:true,completedAt:true,
        cdrLogs:{take:2,select:{submissionId:true,documentId:true,batchId:true,responseCode:true,cdrStorageKey:true,cdrSha256:true}},
        document:{select:{documentId:true,issuerRuc:true,environment:true,immutablePayload:true}},batch:{select:{summaryId:true,issuerRuc:true,environment:true,immutablePayload:true}}}});
    if(!row)return null;
    const own=row.document??row.batch,ownId=row.document?.documentId??row.batch?.summaryId;
    if(!own||ownId!==identity.documentId||own.issuerRuc!==identity.ruc||own.environment!=='BETA'||row.channel!==(identity.method==='sendBill'?'SOAP_SEND_BILL':'SOAP_SEND_SUMMARY')||row.errorCode!=='DONE'||!['SUCCESS','BUSINESS_ERROR'].includes(row.result)||!row.completedAt||row.cdrLogs.length!==1||!row.errorMessage||row.errorMessage.length>256*1024)throw new Error('FINAL_OWN_OUTCOME_REQUIRED');
    const metadata=boundedSupplementJson(JSON.parse(row.errorMessage)) as any,manifest=metadata.prepared,log=row.cdrLogs[0];
    if(metadata.kind!=='BETA_SUPPLEMENT'||metadata.eventId!==command.eventId||metadata.correlationId!==command.correlationId||metadata.envelopeSha256!==fiscalSnapshotSha256(command.payload.envelope)||
      fiscalSnapshotSha256(metadata.envelope)!==metadata.envelopeSha256||!manifest||manifest.fileName!==identity.fileName||manifest.reference!==identity.reference||
      fiscalSnapshotSha256(own.immutablePayload)!==fiscalSnapshotSha256(command.payload.envelope.kind==='NOTE'?command.payload.envelope.note:command.payload.envelope.batch)||
      log.documentId!==row.documentId||log.batchId!==row.batchId||log.submissionId!==row.id||log.cdrStorageKey!==row.responseArtifactKey||row.result==='SUCCESS'&&log.responseCode!=='0'||row.result==='BUSINESS_ERROR'&&log.responseCode==='0')throw new Error('OUTCOME_METADATA_MISMATCH');
    const query={where:row.documentId?{documentId:row.documentId,kind:{in:['SIGNED_XML','SUBMISSION_ZIP','CDR_ZIP'] as any}}:{batchId:row.batchId!,kind:{in:['SIGNED_XML','SUBMISSION_ZIP','CDR_ZIP'] as any}},select:{id:true,kind:true,storageKey:true,sha256:true,sizeBytes:true}};
    const files=row.documentId?await this.db.documentArtifact.findMany(query as any):await this.db.batchArtifact.findMany(query as any);
    const xml=files.find(f=>f.kind==='SIGNED_XML'),zip=files.find(f=>f.kind==='SUBMISSION_ZIP'),cdr=files.find(f=>f.kind==='CDR_ZIP');
    if(files.length!==3||!xml||!zip||!cdr||manifest.xml?.storageKey!==xml.storageKey||manifest.xml.sha256!==xml.sha256||String(manifest.xml.sizeBytes)!==String(xml.sizeBytes)||manifest.zip?.storageKey!==zip.storageKey||manifest.zip.sha256!==zip.sha256||String(manifest.zip.sizeBytes)!==String(zip.sizeBytes)||row.requestArtifactKey!==zip.storageKey||cdr.sha256!==log.cdrSha256||cdr.storageKey!==log.cdrStorageKey)throw new Error('OUTCOME_ARCHIVES_REQUIRED');
    const a=(f:typeof xml):BetaAcceptanceArtifact=>({id:f.id,storageKey:f.storageKey,sha256:f.sha256,sizeBytes:Number(f.sizeBytes)});
    return {commandSha256:fiscalSnapshotSha256(command),submissionId:row.id,completedAt:row.completedAt.toISOString(),responseCode:log.responseCode,result:row.result as 'SUCCESS'|'BUSINESS_ERROR',version:fiscalSnapshotSha256({id:row.id,result:row.result,completedAt:row.completedAt.toISOString(),metadata,log}),fingerprint:manifest.fingerprint,digestValue:manifest.digest,signedXml:a(xml),requestZip:a(zip),cdrZip:a(cdr)};
  }
}
