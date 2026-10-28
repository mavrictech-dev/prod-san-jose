import {vi} from 'vitest';
import {X509Certificate} from 'node:crypto';
import {buildInvoiceUbl} from '../../packages/sunat-core/src/ubl';
import {buildFiscalNoteSnapshot,buildFiscalNoteUbl,fiscalSnapshotSha256,type FiscalNoteContext} from '../../packages/sunat-core/src/fiscal-note';
import {buildFiscalBatchSnapshot,buildFiscalBatchUbl,type FiscalRcEntry} from '../../packages/sunat-core/src/fiscal-batch';
import {XmlSignerService,type XmlRootKind} from '../../services/sunat-service/src/infrastructure/crypto/xml-signer.service';
import {BetaOwnerXmlTrust} from '../../services/sunat-service/src/infrastructure/crypto/beta-owner-xml-trust';
import {BetaOwnerAcceptanceResolver} from '../../services/sunat-service/src/application/beta-owner-acceptance-resolver';
import {BetaOwnerDocumentAcceptance} from '../../services/sunat-service/src/application/beta-owner-document-acceptance';
import {BetaOwnerSummaryAcceptance,type BetaOwnedSummaryRecord} from '../../services/sunat-service/src/application/beta-owner-summary-acceptance';
import type {BetaAcceptedDocumentRecord,BetaAcceptanceArtifact,BetaAcceptanceDocument} from '../../services/sunat-service/src/application/beta-document-acceptance';
import {BatchMemberEvidence,createBatchMemberEvidence,type BatchMemberOwnerVersionRecord} from '../../services/sunat-service/src/application/batch-member-evidence';
import {createGuideSidecarPki} from './guide-sidecar-ephemeral-pki.fixture';
import {supplementCommandFixture,supplementUuid as id} from './fiscal-supplement.fixture';
import {hash,zipSync,cdrXml} from './beta-document-evidence.fixture';

export {id,hash};
export function batchMemberTestPki(){return createGuideSidecarPki();}
export async function batchMemberEvidenceFixture(pki:ReturnType<typeof batchMemberTestPki>,type:'01'|'03'|'07'|'08'='01',
  options:{boleta?:boolean;unreported?:boolean;condition?:'1'|'2'}={}){
  const asOf=new Date().toISOString(),boleta=type==='03'||options.boleta===true,data=supplementCommandFixture(boleta?'RC':'NOTE');
  const blobs=new Map<string,Buffer>(),individuals=new Map<string,BetaAcceptedDocumentRecord>(),summaries=new Map<string,BetaOwnedSummaryRecord>();
  let sequence=100;
  const descriptor=(bytes:Buffer)=>{const n=sequence++,a={id:id(n),storageKey:`synthetic/${n}`,sha256:hash(bytes),sizeBytes:bytes.length};blobs.set(a.id,bytes);return a;};
  const sign=(unsigned:string,root:XmlRootKind)=>new XmlSignerService().sign(unsigned,pki.issuer.pkcs12,pki.password,root);
  const pack=(name:string,bytes:Buffer)=>Buffer.from(zipSync({[name]:bytes}));
  // Only offline trust POLICY/CRL is stubbed. Leaf pin, chain signature and all XML/CDR signatures are real.
  const trust={evaluate:vi.fn(async(metadata:any,ruc:string,now:Date)=>({profile:'OFFLINE-PINNED-ROOTS-CRL-v1' as const,
    chainValid:new X509Certificate(metadata.certificatePem).verify(new X509Certificate(pki.rootPem).publicKey),
    identityMatched:metadata.subjectRucCandidates[0]===ruc,revocation:'VERIFIED_OFFLINE_CRL' as const,
    certificateFingerprint:metadata.fingerprint,checkedAt:now.toISOString(),trustStoreSha256:'c'.repeat(64),blockers:[] as string[]}))};
  const certificates={load:vi.fn(async(ruc:string,fingerprint:string)=>{
    if(ruc!==data.doc.issuer.identityNumber||fingerprint!==pki.issuer.fingerprint)throw new Error('TEST_PIN_MISMATCH');
    return {certificatePem:pki.issuer.certificatePem,chainPems:pki.issuer.chainPems};
  })};
  const signatures=new BetaOwnerXmlTrust(certificates,trust);
  const artifacts={read:vi.fn(async(_documentId:string,a:BetaAcceptanceArtifact)=>{
    const bytes=blobs.get(a.id);if(!bytes)throw new Error('TEST_ARTIFACT_MISSING');return bytes;
  })};
  const individual={load:vi.fn(async(_ruc:string,_env:'BETA',documentId:string)=>{
    const found=[...individuals.values()].find(r=>r.document.documentId===documentId);return found?structuredClone(found):null;
  })};
  const summary={current:vi.fn(async(document:BetaAcceptanceDocument)=>{
    const found=summaries.get(fiscalSnapshotSha256(document));return found?structuredClone(found):null;
  })};
  const resolver=new BetaOwnerAcceptanceResolver(new BetaOwnerDocumentAcceptance(individual,artifacts,signatures,pki.cdrVerifier),
    new BetaOwnerSummaryAcceptance(summary,artifacts,signatures,pki.cdrVerifier));
  const add=async(snapshot:BetaAcceptanceDocument,context:FiscalNoteContext|null,accepted:boolean,version=1)=>{
    const original=['01','03'].includes(snapshot.documentTypeCode);
    const unsigned=original?buildInvoiceUbl(snapshot as typeof data.doc,{mode:'REAL_PREPARATION'}):buildFiscalNoteUbl(snapshot as typeof data.note,context!);
    const signed=sign(unsigned,original?'Invoice':snapshot.documentTypeCode==='07'?'CreditNote':'DebitNote'),xml=Buffer.from(signed.xml);
    const stem=`${snapshot.issuer.identityNumber}-${snapshot.documentTypeCode}-${snapshot.fullNumber}`;
    const record:BatchMemberOwnerVersionRecord={member:{documentId:snapshot.documentId,version,snapshotSha256:fiscalSnapshotSha256(snapshot)},
      ownerVersion:'b'.repeat(64),snapshot:structuredClone(snapshot),binding:{environment:'BETA',issuerRuc:snapshot.issuer.identityNumber,
        companyId:99,branchId:id(2),pointId:id(90),seriesId:id(91),series:snapshot.series,documentType:snapshot.documentTypeCode as '01'},
      signerFingerprint:signed.certificateFingerprintSha256,digestValue:signed.digestValue,signedXml:descriptor(xml),requestZip:descriptor(pack(stem+'.xml',xml)),
      ownerOriginalVersion:context?{documentId:context.original.documentId,version:1,snapshotSha256:fiscalSnapshotSha256(context.original)}:null,
      noteContext:context?structuredClone(context):null,acceptance:null,notDelivered:null,
      creditCatalogue:{source:'OWNER_PRIVATE_COMPLETE_CREDIT_CATALOGUE_V1',complete:true,revision:1,entries:[]}};
    if(accepted){
      const completedAt=original?'2026-10-02T16:10:00Z':'2026-10-03T18:00:00Z';
      if(!snapshot.series.startsWith('B')){
        const cdr=Buffer.from(pki.signCdr(cdrXml(snapshot.fullNumber,snapshot.documentTypeCode,snapshot.issuer.identityNumber)
          .replace('2026-10-03',completedAt.slice(0,10))));
        individuals.set(fiscalSnapshotSha256(snapshot),{document:structuredClone(snapshot),...(context?{noteContext:structuredClone(context)}:{}),
          submissionId:id(sequence++),completedAt,status:'ACCEPTED',version:record.ownerVersion,signerFingerprint:record.signerFingerprint,
          digestValue:record.digestValue,signedXml:record.signedXml,requestZip:record.requestZip,cdrZip:descriptor(pack('R-'+stem+'.xml',cdr))});
      }else{
        const document={snapshot:structuredClone(snapshot),...(context?{noteContext:structuredClone(context)}:{})};
        const condition=options.condition??'1',entry:FiscalRcEntry=condition==='1'?{conditionCode:'1',document}:
          {conditionCode:'2',document,previous:{document,acceptance:{...data.acceptance,documentId:snapshot.documentId,
            documentTypeCode:snapshot.documentTypeCode as '03',fullNumber:snapshot.fullNumber,snapshotSha256:fiscalSnapshotSha256(snapshot)}}};
        const day=completedAt.slice(0,10),batch=buildFiscalBatchSnapshot({kind:'RC',entries:[entry]},
          {documentId:id(sequence++),identifier:'RC-'+day.replaceAll('-','')+'-1',issueDate:day,referenceDate:'2026-10-02'},asOf);
        const result=sign(buildFiscalBatchUbl(batch,asOf),'SummaryDocuments'),batchXml=Buffer.from(result.xml),name=`${snapshot.issuer.identityNumber}-${batch.identifier}`;
        const cdr=Buffer.from(pki.signCdr(cdrXml(batch.identifier,'RC',snapshot.issuer.identityNumber).replace('2026-10-03',day)));
        summaries.set(fiscalSnapshotSha256(snapshot),{batch,status:'ACCEPTED',completedAt,submissionId:id(sequence++),version:'d'.repeat(64),
          signerFingerprint:record.signerFingerprint,digestValue:result.digestValue,signedXml:descriptor(batchXml),
          requestZip:descriptor(pack(name+'.xml',batchXml)),cdrZip:descriptor(pack('R-'+name+'.xml',cdr))});
      }
      const proof=await resolver.verify(snapshot,asOf);
      record.acceptance={kind:snapshot.series.startsWith('B')?'SUMMARY':'INDIVIDUAL',fence:structuredClone(proof.fence)};
    }
    return {record,unsigned};
  };
  let context:FiscalNoteContext|null=null,snapshot:BetaAcceptanceDocument=data.doc;
  if(type==='07'||type==='08'){
    await add(data.doc,null,true);
    const original=await resolver.verify(data.doc,asOf);
    context={original:data.doc,acceptance:original.evidence,asOf,creditHistory:{complete:true,entries:[]}};
    snapshot=buildFiscalNoteSnapshot(context,type==='07'?data.note.adjustment:
      {documentTypeCode:'08',reasonCode:'02',reasonDescription:'DEBITO FICTICIO',lines:[{originalLineNumber:1,unitPriceAdjustmentWithTax:'1'}]},
      {documentId:id(3),series:boleta?'BC01':'FC01',number:'1',issueDate:'2026-10-02T17:00:00Z'});
  }
  const result=await add(snapshot,context,!options.unreported),record=result.record;
  const owner={load:vi.fn(async(_handle:string)=>structuredClone(record))};
  const adapter=new BatchMemberEvidence(owner,artifacts,signatures,resolver);
  return {...result,asOf,blobs,individuals,summaries,signatures,resolver,certificates,trust,artifacts,owner,adapter,sign,pack,descriptor,add,
    run:()=>adapter.verifySignedVersion('opaque-member-version-1',asOf),
    assemble:()=>createBatchMemberEvidence({owner,artifacts,certificates,trust,individual,summary,cdr:pki.cdrVerifier}),
    replaceXml(bytes:Buffer){blobs.set(record.signedXml.id,bytes);Object.assign(record.signedXml,{sha256:hash(bytes),sizeBytes:bytes.length});
      const zip=pack(`${snapshot.issuer.identityNumber}-${snapshot.documentTypeCode}-${snapshot.fullNumber}.xml`,bytes);
      blobs.set(record.requestZip.id,zip);Object.assign(record.requestZip,{sha256:hash(zip),sizeBytes:zip.length});},
  };
}
