import {vi} from 'vitest';
import {buildFiscalBatchSnapshot,buildFiscalBatchUbl,type FiscalRcEntry} from '../../packages/sunat-core/src/fiscal-batch';
import {buildFiscalNoteSnapshot,buildFiscalNoteUbl,fiscalSnapshotSha256} from '../../packages/sunat-core/src/fiscal-note';
import {buildFiscalSupplementCommand} from '../../packages/sunat-core/src/fiscal-supplement-command';
import {BetaOwnerSummaryAcceptance,type BetaOwnedSummaryRecord} from '../../services/sunat-service/src/application/beta-owner-summary-acceptance';
import {BetaVerifiedSupplementOutcome,type BetaOutcomeRecord} from '../../services/sunat-service/src/application/beta-verified-supplement-outcome';
import {betaFiscalIdentity} from '../../services/sunat-service/src/infrastructure/crypto/beta-fiscal-package-pipeline';
import {supplementCommandFixture,supplementUuid as id} from './fiscal-supplement.fixture';
import {AS_OF,ACCEPTED,hash,zipSync,cdrXml} from './beta-document-evidence.fixture';

export {AS_OF,ACCEPTED,hash,zipSync,id};
const marker='<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="SYNTHETIC-NO-TRUST"><ds:SignedInfo/></ds:Signature>';
export const structuralSignature=(xml:string)=>xml.replace('<ext:ExtensionContent/>',`<ext:ExtensionContent>${marker}</ext:ExtensionContent>`);
const pack=(name:string,bytes:Buffer)=>Buffer.from(zipSync({[name]:bytes},{level:6}));
const artifact=(n:number,name:string,bytes:Buffer)=>({id:id(n),storageKey:`synthetic/${name}`,sha256:hash(bytes),sizeBytes:bytes.length});

/** Fake signature ports exercise composition, NOT cryptography, PKI or official SUNAT acceptance. */
export function summaryCompositionFixture(type:'03'|'07'|'08'='03',condition:'1'|'2'|'3'='1'){
  const data=supplementCommandFixture('RC');
  const snapshot=type==='03'?structuredClone(data.doc):type==='07'?structuredClone(data.note):buildFiscalNoteSnapshot(data.context,
    {documentTypeCode:'08',reasonCode:'02',reasonDescription:'AUMENTO SINTETICO',lines:[{originalLineNumber:1,unitPriceAdjustmentWithTax:'1'}]},
    {documentId:id(9),series:'BD01',number:'1',issueDate:'2026-10-02T17:00:00Z'});
  const document={snapshot,...(type!=='03'?{noteContext:structuredClone(data.context)}:{})};
  const evidence={...data.acceptance,documentId:snapshot.documentId,documentTypeCode:snapshot.documentTypeCode as '03'|'07'|'08',fullNumber:snapshot.fullNumber,snapshotSha256:fiscalSnapshotSha256(snapshot)};
  const entry: FiscalRcEntry=condition==='1'?{conditionCode:'1',document}:condition==='2'?{conditionCode:'2',document,previous:{document:structuredClone(document),acceptance:evidence}}:
    {conditionCode:'3',document,previous:{document:structuredClone(document),acceptance:evidence},notDelivered:{status:'NOT_DELIVERED',documentId:snapshot.documentId,
      documentTypeCode:snapshot.documentTypeCode as '03',fullNumber:snapshot.fullNumber,issuerRuc:snapshot.issuer.identityNumber,snapshotSha256:fiscalSnapshotSha256(snapshot),
      evidenceId:id(70),assertedAt:'2026-10-03T16:00:00Z'}};
  const batch=buildFiscalBatchSnapshot({kind:'RC',entries:[entry]},
    {documentId:id(60),identifier:'RC-20261003-1',issueDate:'2026-10-03',referenceDate:'2026-10-02'},AS_OF);
  const xml=Buffer.from(structuralSignature(buildFiscalBatchUbl(batch,AS_OF))),name=`${snapshot.issuer.identityNumber}-${batch.identifier}`;
  let request=pack(`${name}.xml`,xml),cdr=Buffer.from(structuralSignature(cdrXml(batch.identifier,'RC',snapshot.issuer.identityNumber))),response=pack(`R-${name}.xml`,cdr);
  const record:BetaOwnedSummaryRecord={batch,status:'ACCEPTED',completedAt:ACCEPTED,submissionId:id(61),version:'b'.repeat(64),signerFingerprint:'a'.repeat(64),digestValue:Buffer.alloc(32,1).toString('base64'),
    signedXml:artifact(62,'summary.xml',xml),requestZip:artifact(63,'summary.zip',request),cdrZip:artifact(64,'summary-cdr.zip',response)};
  const repository={current:vi.fn(async()=>structuredClone(record))};
  const artifacts={read:vi.fn(async(_owner:string,a:typeof record.signedXml)=>Buffer.from(a.id===record.signedXml.id?xml:a.id===record.requestZip.id?request:response))};
  const signatures={verifyBatch:vi.fn(async()=>({digestValue:record.digestValue,certificateFingerprint:record.signerFingerprint,checkedAt:AS_OF,trustStoreSha256:'c'.repeat(64)}))};
  const cdrTrust={verify:vi.fn(async()=>true)};
  const core=new BetaOwnerSummaryAcceptance(repository,artifacts,signatures,cdrTrust);
  return {data,document:snapshot,record,repository,artifacts,signatures,cdrTrust,xml,get request(){return request;},get response(){return response;},get cdr(){return cdr;},
    setRequest(bytes:Buffer){request=Buffer.from(bytes);Object.assign(record.requestZip,{sha256:hash(request),sizeBytes:request.length});},
    setCdr(bytes:Buffer){cdr=Buffer.from(bytes);response=pack(`R-${name}.xml`,cdr);Object.assign(record.cdrZip,{sha256:hash(response),sizeBytes:response.length});},
    run:()=>core.verify(snapshot,AS_OF)};
}

export function summaryOwnerRow(f:ReturnType<typeof summaryCompositionFixture>){
  const r=f.record,ownerId=id(80),eventId=id(81),envelope={kind:'BATCH',batch:r.batch,asOf:AS_OF};
  const prepared={fingerprint:r.signerFingerprint,digest:r.digestValue,fileName:`${r.batch.issuer.identityNumber}-${r.batch.identifier}.zip`,reference:r.batch.identifier,
    xml:structuredClone(r.signedXml),zip:structuredClone(r.requestZip)};
  const metadata={kind:'BETA_SUPPLEMENT',eventId,envelope,envelopeSha256:fiscalSnapshotSha256(envelope),prepared};
  return {id:ownerId,summaryId:r.batch.documentId,identifier:r.batch.identifier,billingEventId:eventId,status:r.status,immutablePayload:structuredClone(r.batch),updatedAt:new Date(ACCEPTED),
    artifacts:[{...r.signedXml,kind:'SIGNED_XML'},{...r.requestZip,kind:'SUBMISSION_ZIP'},{...r.cdrZip,kind:'CDR_ZIP'}],
    submissions:[{id:r.submissionId,idempotencyKey:`beta-supplement:${r.batch.documentId}:v1`,channel:'SOAP_SEND_SUMMARY',result:'SUCCESS',errorCode:'DONE',errorMessage:JSON.stringify(metadata),documentId:null,batchId:ownerId,
      completedAt:new Date(ACCEPTED),requestArtifactKey:r.requestZip.storageKey,responseArtifactKey:r.cdrZip.storageKey,
      cdrLogs:[{submissionId:r.submissionId,batchId:ownerId,responseCode:'0',cdrStorageKey:r.cdrZip.storageKey,cdrSha256:r.cdrZip.sha256}]}]};
}

export function outcomeFixture(kind:'07'|'08'|'RC'|'RA'='07',code='0',observed=false){
  const data=supplementCommandFixture(kind==='RC'?'RC':kind==='RA'?'RA':'NOTE');
  if(kind==='08'){
    const note=buildFiscalNoteSnapshot(data.context,{documentTypeCode:'08',reasonCode:'02',reasonDescription:'AJUSTE SINTETICO',lines:[{originalLineNumber:1,unitPriceAdjustmentWithTax:'1'}]},
      {documentId:id(3),series:'FD01',number:'1',issueDate:'2026-10-02T17:00:00Z'});
    data.envelope={kind:'NOTE',note,context:data.context};
    data.command=buildFiscalSupplementCommand(data.envelope,{eventId:data.command.eventId,correlationId:data.command.correlationId,occurredAt:data.command.occurredAt});
  }
  const command=data.command,envelope=command.payload.envelope,identity=betaFiscalIdentity(envelope),xml=Buffer.from(structuralSignature(envelope.kind==='NOTE'?buildFiscalNoteUbl(envelope.note,envelope.context):buildFiscalBatchUbl(envelope.batch,envelope.asOf)));
  let request=pack(identity.fileName.replace(/\.zip$/,'.xml'),xml),cdr=Buffer.from(structuralSignature(cdrXml(identity.reference,kind,identity.ruc,observed)).replace('<cbc:ResponseCode>0</cbc:ResponseCode>',`<cbc:ResponseCode>${code}</cbc:ResponseCode>`));
  let response=pack('R-'+identity.fileName.replace(/\.zip$/,'.xml'),cdr);
  const record:BetaOutcomeRecord={commandSha256:fiscalSnapshotSha256(command),submissionId:id(90),completedAt:ACCEPTED,responseCode:code,result:code==='0'?'SUCCESS':'BUSINESS_ERROR',version:'b'.repeat(64),fingerprint:'a'.repeat(64),digestValue:Buffer.alloc(32,1).toString('base64'),
    signedXml:artifact(91,'outcome.xml',xml),requestZip:artifact(92,'outcome.zip',request),cdrZip:artifact(93,'outcome-cdr.zip',response)};
  const owner={load:vi.fn(async()=>structuredClone(record)),read:vi.fn(async(_owner:string,a:typeof record.signedXml)=>Buffer.from(a.id===record.signedXml.id?xml:a.id===record.requestZip.id?request:response))};
  const signatures={verifyEnvelope:vi.fn(async()=>({digestValue:record.digestValue,certificateFingerprint:record.fingerprint,checkedAt:AS_OF,trustStoreSha256:'c'.repeat(64)}))};
  const cdrTrust={verify:vi.fn(async()=>true)},core=new BetaVerifiedSupplementOutcome(owner,signatures,cdrTrust);
  return {data,command,identity,record,owner,signatures,cdrTrust,xml,get request(){return request;},get response(){return response;},get cdr(){return cdr;},
    setRequest(bytes:Buffer){request=Buffer.from(bytes);Object.assign(record.requestZip,{sha256:hash(request),sizeBytes:request.length});},
    setCdr(bytes:Buffer){cdr=Buffer.from(bytes);response=pack('R-'+identity.fileName.replace(/\.zip$/,'.xml'),cdr);Object.assign(record.cdrZip,{sha256:hash(response),sizeBytes:response.length});},
    run:()=>core.verify(command,AS_OF)};
}

export function outcomeOwnerRow(f:ReturnType<typeof outcomeFixture>,code='0'){
  const r=f.record,e=f.command.payload.envelope,isNote=e.kind==='NOTE',ownerId=id(95);
  const metadata={kind:'BETA_SUPPLEMENT',eventId:f.command.eventId,correlationId:f.command.correlationId,envelope:e,envelopeSha256:fiscalSnapshotSha256(e),
    prepared:{fileName:f.identity.fileName,reference:f.identity.reference,fingerprint:r.fingerprint,digest:r.digestValue,xml:structuredClone(r.signedXml),zip:structuredClone(r.requestZip)}};
  const own={...(isNote?{documentId:f.identity.documentId}:{summaryId:f.identity.documentId}),issuerRuc:f.identity.ruc,environment:'BETA',immutablePayload:structuredClone(isNote?e.note:e.batch)};
  const files=[{...r.signedXml,kind:'SIGNED_XML'},{...r.requestZip,kind:'SUBMISSION_ZIP'},{...r.cdrZip,kind:'CDR_ZIP'}];
  const row={id:r.submissionId,documentId:isNote?ownerId:null,batchId:isNote?null:ownerId,channel:isNote?'SOAP_SEND_BILL':'SOAP_SEND_SUMMARY',result:code==='0'?'SUCCESS':'BUSINESS_ERROR',errorCode:'DONE',errorMessage:JSON.stringify(metadata),
    requestArtifactKey:r.requestZip.storageKey,responseArtifactKey:r.cdrZip.storageKey,completedAt:new Date(ACCEPTED),document:isNote?own:null,batch:isNote?null:own,
    cdrLogs:[{submissionId:r.submissionId,documentId:isNote?ownerId:null,batchId:isNote?null:ownerId,responseCode:code,cdrStorageKey:r.cdrZip.storageKey,cdrSha256:r.cdrZip.sha256}]};
  return {row,files,metadata};
}
