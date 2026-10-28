import type {PrismaService} from '../infrastructure/prisma.service';
import {fiscalSnapshotSha256,type FiscalNoteContext} from '@factuez/sunat-core/dist/fiscal-note';
import {boundedSupplementJson} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import type {BetaAcceptedDocumentRecord,BetaAcceptanceArtifact,BetaAcceptanceDocument} from './beta-document-acceptance';
/** Read-only owner adapter. No credentials table, writes, inferred acceptance or latest-success fallback. */
export class PrismaBetaDocumentAcceptanceRepository {
  constructor(private readonly db:PrismaService){}
  async load(ruc:string,environment:'BETA',documentId:string):Promise<BetaAcceptedDocumentRecord|null>{
    if(environment!=='BETA'||!/^\d{11}$/.test(ruc)||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(documentId))throw new Error('BETA_DOCUMENT_SCOPE_REQUIRED');
    const own=await this.db.fiscalDocument.findFirst({where:{documentId,issuerRuc:ruc,environment:'BETA'},select:{documentId:true,issuerRuc:true,environment:true,documentType:true,series:true,number:true,
      status:true,acceptedAt:true,immutablePayload:true,digestValue:true,billingEventId:true,updatedAt:true,
      artifacts:{where:{kind:{in:['SIGNED_XML','CDR_ZIP','SUBMISSION_ZIP']}},select:{id:true,kind:true,storageKey:true,sha256:true,sizeBytes:true}},
      submissions:{take:2,orderBy:[{startedAt:'desc'},{id:'desc'}],select:{id:true,documentId:true,batchId:true,channel:true,result:true,errorCode:true,errorMessage:true,
        idempotencyKey:true,requestArtifactKey:true,responseArtifactKey:true,completedAt:true,startedAt:true,
        cdrLogs:{take:2,select:{documentId:true,batchId:true,submissionId:true,responseCode:true,cdrStorageKey:true,cdrSha256:true}}}}}});
    if(!own)return null;
    const fail=():never=>{throw new Error('OWNER_DOCUMENT_EVIDENCE_INCOMPLETE');};
    if(!['ACCEPTED','ACCEPTED_WITH_OBSERVATIONS'].includes(own.status)||!own.acceptedAt||!own.digestValue||!['01','07','08'].includes(own.documentType)||!own.series.startsWith('F')||own.submissions.length!==1)return fail();
    const submission=own.submissions[0];
    if(submission.documentId!==documentId||submission.batchId!==null||submission.channel!=='SOAP_SEND_BILL'||submission.result!=='SUCCESS'||submission.errorCode!=='DONE'||
      !submission.completedAt||submission.completedAt.getTime()!==own.acceptedAt.getTime()||!submission.errorMessage||submission.errorMessage.length>256*1024||submission.cdrLogs.length!==1)return fail();
    let metadata:any;try{metadata=boundedSupplementJson(JSON.parse(submission.errorMessage));}catch{return fail();}
    if(metadata.version!==1||metadata.eventId!==own.billingEventId||!metadata.prepared)return fail();
    const document=boundedSupplementJson(own.immutablePayload) as BetaAcceptanceDocument;
    if(document.documentId!==documentId||document.environment!=='BETA'||document.issuer?.identityNumber!==ruc||document.documentTypeCode!==own.documentType||document.series!==own.series||document.number!==String(own.number)||document.fullNumber!==`${own.series}-${own.number}`)return fail();
    const manifest=metadata.prepared,note=own.documentType!=='01';let noteContext:FiscalNoteContext|undefined;
    if(note){
      if(metadata.kind!=='BETA_SUPPLEMENT'||metadata.envelope?.kind!=='NOTE'||fiscalSnapshotSha256(metadata.envelope.note)!==fiscalSnapshotSha256(document)||
        fiscalSnapshotSha256(metadata.envelope)!==metadata.envelopeSha256||submission.idempotencyKey!==`beta-supplement:${documentId}:v1`)return fail();
      noteContext=metadata.envelope.context;
    }else if(submission.idempotencyKey!==`beta:${documentId}:v1`||metadata.kind!==undefined)return fail();
    const signed=own.artifacts.find(a=>a.kind==='SIGNED_XML'),cdr=own.artifacts.find(a=>a.kind==='CDR_ZIP'),request=own.artifacts.find(a=>a.kind==='SUBMISSION_ZIP'),log=submission.cdrLogs[0],preparedXml=note?manifest.xml:manifest.documentXml;
    if(own.artifacts.length!==3||!signed||!cdr||!request||!preparedXml||preparedXml.storageKey!==signed.storageKey||preparedXml.sha256!==signed.sha256||String(preparedXml.sizeBytes)!==String(signed.sizeBytes)||
      manifest.digest!==own.digestValue||typeof manifest.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(manifest.fingerprint)||
      manifest.reference!==document.fullNumber||manifest.fileName!==`${ruc}-${own.documentType}-${document.fullNumber}.zip`||
      manifest.zip?.storageKey!==submission.requestArtifactKey||manifest.zip.storageKey!==request.storageKey||manifest.zip.sha256!==request.sha256||String(manifest.zip.sizeBytes)!==String(request.sizeBytes)||submission.responseArtifactKey!==cdr.storageKey||log.documentId!==documentId||log.batchId!==null||log.submissionId!==submission.id||log.responseCode!=='0'||log.cdrStorageKey!==cdr.storageKey||log.cdrSha256!==cdr.sha256)return fail();
    const artifact=(a:typeof signed):BetaAcceptanceArtifact=>({id:a.id,storageKey:a.storageKey,sha256:a.sha256,sizeBytes:Number(a.sizeBytes)});
    return {document,...(noteContext?{noteContext}:{}),submissionId:submission.id,completedAt:submission.completedAt.toISOString(),status:own.status as BetaAcceptedDocumentRecord['status'],
      signerFingerprint:manifest.fingerprint,digestValue:own.digestValue,
      version:fiscalSnapshotSha256({updatedAt:own.updatedAt.toISOString(),startedAt:submission.startedAt.toISOString(),metadataSha256:fiscalSnapshotSha256(metadata),billingEventId:own.billingEventId}),
      signedXml:artifact(signed),cdrZip:artifact(cdr),requestZip:artifact(request)};
  }
}
