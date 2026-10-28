import { Injectable } from '@nestjs/common';
import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import type { ProductionBatchesAcceptance } from '@factuez/contracts/production-batches';
import { buildProductionBatchesUbl } from '@factuez/sunat-core/dist/production-batches';
import { ProductionPdfService } from './production-pdf.service';
import { ProductionNotesEvidenceService } from './production-notes-evidence.service';
import { ProductionBatchesRepository } from './production-batches-repository';
import { PrismaService } from '../infrastructure/prisma.service';
import { ArtifactStore } from '../infrastructure/artifact-store';
import { CdrSignatureTrustService } from '../infrastructure/crypto/cdr-signature-trust.service';
import { productionTransportXml } from '../infrastructure/sunat/production-transport-zip';
import { verifyProductionBatchesCdr,productionBatchesHash } from '../infrastructure/production-batches-cdr';
import { buildInvoiceUbl, fiscalSnapshotSha256 } from '@factuez/sunat-core';
@Injectable()
export class ProductionBatchesEvidenceService{
 constructor(private readonly pdf:ProductionPdfService,private readonly prisma:PrismaService,private readonly repository:ProductionBatchesRepository,
 private readonly store:ArtifactStore,private readonly signed:ProductionNotesEvidenceService,private readonly cdrTrust:CdrSignatureTrustService){}
 async accepted(snapshot:FiscalDocumentSnapshot):Promise<ProductionBatchesAcceptance>{
  // Never trust hashes supplied by a client. Public original archive verifies XMLDSig, current PKI/CRL and exact CDR.
  const a=await this.pdf.acceptedArchive(snapshot),rc=a.receiptSummary;
  if(snapshot.documentTypeCode==='03'&&!rc)throw Error('RC aceptado requerido');
  return {documentId:snapshot.documentId,snapshotSha256:a.snapshotSha256,issuerRuc:snapshot.issuer.identityNumber,acceptedAt:a.acceptedAt,
   cdrZipSha256:rc?.cdrZipSha256??a.cdrZipSha256,cdrXmlSha256:rc?.cdrXmlSha256??a.cdrXmlSha256,
   requestXmlSha256:rc?.summaryXmlSha256??a.signedXmlSha256,reference:rc?.identifier??snapshot.fullNumber,source:rc?'INDIVIDUAL_RC':'DOCUMENT'};
 }
 async acceptedBatch(snapshot:FiscalDocumentSnapshot,batchId:string):Promise<ProductionBatchesAcceptance>{
  const row=await this.repository.load(batchId);
  if(!row||row.state!=='ACCEPTED'||!row.manifest||!row.cdrManifest)throw Error('Lote aceptado archivado requerido');
  const b=row.payload.snapshot,e=b.entries.find(e=>e.snapshot.documentId===snapshot.documentId);
  if(!e||b.kind!=='RC'||e.conditionCode==='3'||fiscalSnapshotSha256(e.snapshot)!==fiscalSnapshotSha256(snapshot))throw Error('Miembro RC aceptado ajeno');
  const doc=await this.prisma.fiscalDocument.findUnique({where:{documentId:snapshot.documentId},include:{artifacts:true}});
  if(!doc||doc.environment!=='PRODUCTION'||fiscalSnapshotSha256(doc.immutablePayload)!==fiscalSnapshotSha256(snapshot))throw Error('Original de miembro no exacto');
  const one=(kind:string)=>{const rows=doc.artifacts.filter(a=>a.kind===kind);if(rows.length!==1)throw Error('Original firmado único requerido');return rows[0];};
  const originalXml=await this.store.read(snapshot.documentId,one('SIGNED_XML')),originalZip=await this.store.read(snapshot.documentId,one('SUBMISSION_ZIP'));
  if(!productionTransportXml(originalZip,b.issuerRuc+'-03-'+snapshot.fullNumber+'.xml').xml.equals(originalXml))throw Error('Original individual ZIP/XML no exacto');
  const originalProof=await this.signed.signed(b.issuerRuc,originalXml,buildInvoiceUbl(snapshot,{mode:'REAL_PREPARATION'}),'Invoice');
  if(originalProof.digest!==doc.digestValue)throw Error('Digest individual no exacto');
  const xml=await this.store.read(batchId,row.manifest.xml),zip=await this.store.read(batchId,row.manifest.zip);
  if(!productionTransportXml(zip,row.manifest.fileName.replace(/\.zip$/,'.xml')).xml.equals(xml))throw Error('ZIP/XML RC archivado inconsistente');
  await this.signed.signed(b.issuerRuc,xml,buildProductionBatchesUbl(b), 'SummaryDocuments');
  const cdr=await verifyProductionBatchesCdr(await this.store.read(batchId,row.cdrManifest.zip),b,this.cdrTrust);
  if(cdr.status!=='ACCEPTED')throw Error('CDR no aceptado');
  const name='R-'+b.issuerRuc+'-'+b.identifier+'.xml',artifact=row.cdrManifest.members[name];
  if(!artifact||!cdr.files[name].equals(await this.store.read(batchId,artifact)))throw Error('CDR XML exacto requerido');
  const times=await this.prisma.$queryRawUnsafe<{updatedAt:Date}[]>('SELECT "updatedAt" FROM "ProductionBatchesDispatch" WHERE "batchId"=$1::uuid',batchId);
  return {documentId:snapshot.documentId,snapshotSha256:fiscalSnapshotSha256(snapshot),issuerRuc:b.issuerRuc,acceptedAt:times[0].updatedAt.toISOString(),
   cdrZipSha256:cdr.zipSha256,cdrXmlSha256:productionBatchesHash(cdr.files[name]),requestXmlSha256:row.manifest.xml.sha256,reference:b.identifier,source:'BATCH_RC'};
 }
 async current(snapshot:FiscalDocumentSnapshot){
  const rows=await this.prisma.$queryRawUnsafe<{batchId:string}[]>('SELECT d."batchId" FROM "ProductionBatchesDispatch" d JOIN "ProductionBatchesMember" m ON m."batchId"=d."batchId" WHERE m."documentId"=$1::uuid AND d."state"=\'ACCEPTED\' ORDER BY d."updatedAt" DESC LIMIT 1',snapshot.documentId);
  return rows[0]?this.acceptedBatch(snapshot,rows[0].batchId):this.accepted(snapshot);
 }
}
