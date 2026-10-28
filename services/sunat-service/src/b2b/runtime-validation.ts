import {createHash} from 'node:crypto';
import {XSD_PROFILE,XSD_ARCHIVE_SHA256,type XsdValidationService,type XsdDocumentKind} from '../infrastructure/sunat/xsd-validation.service';
import type {GuideDispatchDatabase,GuideDispatchSql} from '../application/guide-dispatch-store';
import {GuideArtifactApi} from '../application/guide-artifact-api';
import type {GuideArtifactPipeline} from '../application/guide-artifact-pipeline';
import {BatchArtifactApi} from '../application/batch-artifact-api';
import type {BatchLocalArtifactPipeline} from '../application/batch-local-artifacts';
import type {BetaOwnerXmlTrust} from '../infrastructure/crypto/beta-owner-xml-trust';
import {fiscalSnapshotSha256} from '@factuez/sunat-core/dist/fiscal-note';
export type RuntimeXsd=Pick<XsdValidationService,'validate'>;
export async function validateRuntimeXml(xsd:RuntimeXsd,xml:string|Buffer,kind:XsdDocumentKind){
 const bytes=Buffer.isBuffer(xml)?Buffer.from(xml):Buffer.from(xml);
 const proof=await xsd.validate(bytes,kind);
 if(!proof||proof.profile!==XSD_PROFILE||proof.archiveSha256!==XSD_ARCHIVE_SHA256||proof.xmlSha256!==createHash('sha256').update(bytes).digest('hex')||!Number.isFinite(Date.parse(proof.verifiedAt)))throw Error('SUNAT_RUNTIME_XSD_EVIDENCE_INVALID');
}
/** Existing owner stores still own transactions and SQL. Only fixed local INSERT
 * projections receive an additional genuine XSD check BEFORE persistence. */
export function runtimeArtifactDatabase(db:GuideDispatchDatabase,xsd:RuntimeXsd,kind:'GUIDE'|'BATCH'):GuideDispatchDatabase {
 return {$transaction<T>(work:(tx:GuideDispatchSql)=>Promise<T>,options:Parameters<GuideDispatchDatabase['$transaction']>[1]){
  return db.$transaction(tx=>work({$queryRawUnsafe:tx.$queryRawUnsafe.bind(tx),$executeRawUnsafe:async(sql,...values)=>{
   if(kind==='GUIDE'&&sql.startsWith('INSERT INTO "GuideLocalArtifact"'))await validateRuntimeXml(xsd,values[7] as Buffer,'DespatchAdvice');
   if(kind==='BATCH'&&sql.startsWith('INSERT INTO "BatchLocalArtifact"')){
    const metadata=JSON.parse(values[5] as string);if(!['RC','RA'].includes(metadata.kind))throw Error('SUNAT_RUNTIME_BATCH_KIND_REQUIRED');
    await validateRuntimeXml(xsd,values[8] as Buffer,metadata.kind==='RC'?'SummaryDocuments':'VoidedDocuments');
   }
   return tx.$executeRawUnsafe(sql,...values);
  }}),options);
 }};
}
export class RuntimeGuideArtifactApi extends GuideArtifactApi {
 constructor(private readonly source:GuideArtifactPipeline,private readonly xsd:RuntimeXsd){super(source);}
 private async checked(input:unknown,access:Parameters<GuideArtifactApi['view']>[1]){const r=await this.source.read(input,access);await validateRuntimeXml(this.xsd,r.record.signedXml,'DespatchAdvice');return r.record.metadata;}
 override async view(...args:Parameters<GuideArtifactApi['view']>){const r=await super.view(...args);const metadata=await this.checked(args[0],args[1]);if(fiscalSnapshotSha256(r.metadata)!==fiscalSnapshotSha256(metadata))throw Error('SUNAT_RUNTIME_OWNER_CHANGED');return r;}
 override async content(...args:Parameters<GuideArtifactApi['content']>){const r=await super.content(...args);await this.checked(args[0],args[1]);return r;}
}
export class RuntimeBatchArtifactApi extends BatchArtifactApi {
 constructor(private readonly source:BatchLocalArtifactPipeline,private readonly xsd:RuntimeXsd){super(source);}
 private async checked(scope:Parameters<BatchArtifactApi['view']>[0],access:Parameters<BatchArtifactApi['view']>[1]){const r=await this.source.read(scope,access);await validateRuntimeXml(this.xsd,r.record.signedXml,r.record.metadata.kind==='RC'?'SummaryDocuments':'VoidedDocuments');return r.record.metadata;}
 override async view(...args:Parameters<BatchArtifactApi['view']>){const r=await super.view(...args);const metadata=await this.checked(args[0],args[1]);if(fiscalSnapshotSha256(r.metadata)!==fiscalSnapshotSha256(metadata))throw Error('SUNAT_RUNTIME_OWNER_CHANGED');return r;}
 override async content(...args:Parameters<BatchArtifactApi['content']>){const r=await super.content(...args);await this.checked(args[0],args[1]);return r;}
}
export function runtimeCorrectionSignatures(signatures:BetaOwnerXmlTrust,xsd:RuntimeXsd):Pick<BetaOwnerXmlTrust,'verifyIssuer'|'verifyBatch'|'verifyEnvelope'>{
 return {
  async verifyIssuer(...a:Parameters<BetaOwnerXmlTrust['verifyIssuer']>){await validateRuntimeXml(xsd,a[1],a[0].document.documentTypeCode==='01'?'Invoice':a[0].document.documentTypeCode==='07'?'CreditNote':'DebitNote');return signatures.verifyIssuer(...a);},
  async verifyBatch(...a:Parameters<BetaOwnerXmlTrust['verifyBatch']>){await validateRuntimeXml(xsd,a[2],a[0].kind==='RC'?'SummaryDocuments':'VoidedDocuments');return signatures.verifyBatch(...a);},
  async verifyEnvelope(...a:Parameters<BetaOwnerXmlTrust['verifyEnvelope']>){const e=a[0];await validateRuntimeXml(xsd,a[2],e.kind==='NOTE'?(e.note.documentTypeCode==='07'?'CreditNote':'DebitNote'):e.batch.kind==='RC'?'SummaryDocuments':'VoidedDocuments');return signatures.verifyEnvelope(...a);},
 };
}
