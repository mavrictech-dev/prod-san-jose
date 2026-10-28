import {ProductionNotesArtifactsService,type ProductionNotesArtifactKind} from './production-notes-artifacts.service';
import { buildReceiptSummarySnapshot, fiscalSnapshotSha256, receiptSummaryReconstructionAsOf } from '@factuez/sunat-core';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Optional, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import { PrismaService } from '../infrastructure/prisma.service';
import { ArtifactStore, MAX_ARTIFACT_BYTES } from '../infrastructure/artifact-store';
import { productionTransportXml } from '../infrastructure/sunat/production-transport-zip';
import { safeXml, CAC_NS, CBC_NS, child, children, leaf } from '../infrastructure/sunat/safe-xml';
const kinds = { xml: ['SIGNED_XML', 'application/xml'], 'cdr-xml': ['CDR_XML','application/xml'], 'cdr-zip': ['CDR_ZIP','application/zip'], 'submission-zip': ['SUBMISSION_ZIP','application/zip'] } as const;
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
/** Raw originals, never generated or relabelled as accepted. Authorization precedes every read. */
@Injectable()
export class FiscalOriginalsService {
 constructor(private readonly prisma:PrismaService,private readonly store:ArtifactStore,@Optional() private readonly notes?:ProductionNotesArtifactsService){}
 async download(documentId:string,kind:string,authorization?:string){
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(documentId)||!Object.hasOwn(kinds,kind))throw new BadRequestException('Archivo original o documento inválido');
  if(!authorization||!/^Bearer [A-Za-z0-9_.-]{1,8192}$/i.test(authorization))throw new UnauthorizedException('Inicie sesión para descargar originales');
  let response:Response;
  try{response=await fetch(`${process.env.BILLING_INTERNAL_URL??'http://billing-service:3002'}/api/v1/documents/${documentId}`,{headers:{Authorization:authorization,Accept:'application/json'},signal:AbortSignal.timeout(5000),redirect:'error'});}
  catch{throw new ServiceUnavailableException('No se pudo comprobar el acceso al comprobante');}
  if(response.status===401)throw new UnauthorizedException('Inicie sesión nuevamente');
  if(response.status===403)throw new ForbiddenException('Comprobante fuera de su alcance');
  if(response.status===404)throw new NotFoundException('Comprobante no disponible');
  if(!response.ok)throw new ServiceUnavailableException('No se pudo comprobar el acceso al comprobante');
  let permitted:{id:string;immutableSnapshot:FiscalDocumentSnapshot};
  try{permitted=await response.json() as typeof permitted;}catch{throw new ServiceUnavailableException('Respuesta de autorización inválida');}
  const snapshot=permitted?.immutableSnapshot;
  if(permitted?.id!==documentId||snapshot?.documentId!==documentId)throw new ServiceUnavailableException('Respuesta de autorización inconsistente');
  if(snapshot.environment==='PRODUCTION'&&['07','08'].includes(snapshot.documentTypeCode)){
   if(!this.notes)throw new ServiceUnavailableException('Originales de notas aún no ensamblados.');
   return this.notes.download(documentId,(kind==='xml'?'signed-xml':kind) as ProductionNotesArtifactKind,authorization);
  }
  if(snapshot.environment!=='PRODUCTION'||!['01','03'].includes(snapshot.documentTypeCode)||!/^\d{11}$/.test(snapshot.issuer?.identityNumber??'')||!(snapshot.documentTypeCode==='01'?/^F[A-Z0-9]{3}-[1-9]\d{0,7}$/:/^B[A-Z0-9]{3}-[1-9]\d{0,7}$/).test(snapshot.fullNumber??'')||snapshot.fullNumber!==`${snapshot.series}-${snapshot.number}`)
   throw new ConflictException('Los originales de esta ruta requieren una factura 01 o boleta 03 de Producción');
  const own=await this.prisma.fiscalDocument.findUnique({where:{documentId}});
  if(!own||own.environment!==snapshot.environment||own.issuerRuc!==snapshot.issuer.identityNumber||own.documentType!==snapshot.documentTypeCode||own.series!==snapshot.series||own.number!==BigInt(snapshot.number)||!isDeepStrictEqual(own.immutablePayload,JSON.parse(JSON.stringify(snapshot))))
   throw new ConflictException('El archivo no corresponde al snapshot autorizado');
  const receipt=snapshot.documentTypeCode==='03'&&kind!=='xml'?await this.receipt(snapshot):undefined;
  const [artifactKind,mediaType]=kinds[kind as keyof typeof kinds];
  const artifact=receipt&&kind==='submission-zip'?receipt.artifacts.find(row=>row.kind===artifactKind):await this.prisma.documentArtifact.findUnique({where:{documentId_kind:{documentId,kind:artifactKind}}});
  if(!artifact)throw new ConflictException(kind.startsWith('cdr')?'CDR original todavía no disponible':'XML firmado o paquete original todavía no disponible');
  if((receipt&&kind==='submission-zip'?(!('batchId' in artifact)||artifact.batchId!==receipt.batchId):(!('documentId' in artifact)||artifact.documentId!==documentId))||artifact.kind!==artifactKind||artifact.mediaType!==mediaType||!Number.isSafeInteger(Number(artifact.sizeBytes))||Number(artifact.sizeBytes)<1||Number(artifact.sizeBytes)>MAX_ARTIFACT_BYTES||!/^[a-f0-9]{64}$/.test(artifact.sha256))throw new ConflictException('Metadatos del original inconsistentes');
  let bytes:Buffer;
  const base=receipt?`${snapshot.issuer.identityNumber}-${receipt.reference}`:`${snapshot.issuer.identityNumber}-${snapshot.documentTypeCode}-${snapshot.fullNumber}`;
  try{
   if(receipt&&kind.startsWith('cdr')){const matching=receipt.artifacts.filter(row=>row.kind===artifactKind);if(matching.length!==1||matching[0].sha256!==artifact.sha256||BigInt(matching[0].sizeBytes)!==BigInt(artifact.sizeBytes)||matching[0].mediaType!==artifact.mediaType)throw Error();}
   bytes=await this.store.read(receipt&&kind==='submission-zip'?receipt.ownerId:documentId,artifact);
   if(!Buffer.isBuffer(bytes)||BigInt(bytes.length)!==BigInt(artifact.sizeBytes)||sha(bytes)!==artifact.sha256)throw Error();
   let xml:Buffer=bytes;
   if(mediaType==='application/zip')xml=productionTransportXml(bytes,`${kind==='cdr-zip'?'R-':''}${base}.xml`,kind==='cdr-zip').xml;
   const root=safeXml(new TextDecoder('utf-8',{fatal:true}).decode(xml));
   if(kind.startsWith('cdr')){
    if(root.localName!=='ApplicationResponse'||root.namespaceURI!=='urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2'||leaf(child(child(root,CAC_NS,'ReceiverParty'),CAC_NS,'PartyIdentification'),CBC_NS,'ID',11)!==snapshot.issuer.identityNumber||leaf(child(child(root,CAC_NS,'DocumentResponse'),CAC_NS,'DocumentReference'),CBC_NS,'ID',40)!==(receipt?.reference??snapshot.fullNumber))throw Error();
   }else if(receipt){
    if(kind!=='submission-zip'||sha(xml)!==receipt.xmlSha256||artifact.sha256!==receipt.zipSha256||root.localName!=='SummaryDocuments')throw Error();
   }else{
    if(root.localName!=='Invoice'||root.namespaceURI!=='urn:oasis:names:specification:ubl:schema:xsd:Invoice-2'||leaf(root,CBC_NS,'ID',40)!==snapshot.fullNumber||leaf(root,CBC_NS,'InvoiceTypeCode',2)!==snapshot.documentTypeCode||leaf(child(child(child(root,CAC_NS,'AccountingSupplierParty'),CAC_NS,'Party'),CAC_NS,'PartyIdentification'),CBC_NS,'ID',11)!==snapshot.issuer.identityNumber)throw Error();
    if(kind==='submission-zip'){
     const original=await this.prisma.documentArtifact.findUnique({where:{documentId_kind:{documentId,kind:'SIGNED_XML'}}});
     if(!original||original.documentId!==documentId||original.sha256!==sha(xml))throw Error();
    }
   }
  }catch{throw new ConflictException('El original archivado está incompleto, alterado o corresponde a otro documento');}
  return {bytes,mediaType,fileName:`${kind.startsWith('cdr')?'R-':''}${base}.${mediaType==='application/zip'?'zip':'xml'}`};
 }
 private async receipt(snapshot:FiscalDocumentSnapshot){
  try{
   const rows=await this.prisma.sunatSubmission.findMany({where:{documentId:snapshot.documentId,idempotencyKey:`production:${snapshot.documentId}:v1`},include:{batch:true},take:2});
   if(rows.length!==1)throw Error();const submission=rows[0],batch=submission.batch;
   if(!batch||!submission.errorMessage||submission.errorMessage.length>32768)throw Error();
   const metadata=JSON.parse(submission.errorMessage),manifest=metadata?.prepared;
   if(metadata.version!==1||!manifest||typeof manifest.reference!=='string'||!/^RC-\d{8}-[1-9]\d{0,4}$/.test(manifest.reference))throw Error();
   const expected=buildReceiptSummarySnapshot(snapshot,manifest.reference,receiptSummaryReconstructionAsOf(manifest.reference));
   if(batch.environment!=='PRODUCTION'||batch.issuerRuc!==snapshot.issuer.identityNumber||batch.summaryId!==snapshot.documentId||batch.identifier!==manifest.reference||batch.billingEventId!==metadata.eventId||
    manifest.requestOwnerId!==expected.documentId||manifest.documentSnapshotSha256!==fiscalSnapshotSha256(snapshot)||fiscalSnapshotSha256(batch.immutablePayload)!==fiscalSnapshotSha256(expected)||!manifest.individualXmlZip||
    manifest.xml.storageKey===manifest.documentXml.storageKey||manifest.zip.storageKey===manifest.individualXmlZip.storageKey)throw Error();
   const originals=await this.prisma.batchArtifact.findMany({where:{batchId:batch.id,kind:{in:['SIGNED_XML','SUBMISSION_ZIP','CDR_XML','CDR_ZIP']}}});
   for(const [kind,stored]of [['SIGNED_XML',manifest.xml],['SUBMISSION_ZIP',manifest.zip]] as const){
    const matches=originals.filter(row=>row.kind===kind);
    if(matches.length!==1||matches[0].batchId!==batch.id||matches[0].kind!==kind||matches[0].mediaType!==(kind==='SIGNED_XML'?'application/xml':'application/zip')||matches[0].sha256!==stored.sha256||matches[0].storageKey!==stored.storageKey||BigInt(matches[0].sizeBytes)!==BigInt(stored.sizeBytes))throw Error();
   }
   const bytes=await this.store.read(expected.documentId,manifest.xml),root=safeXml(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
   if(sha(bytes)!==manifest.xml.sha256||root.localName!=='SummaryDocuments'||leaf(root,CBC_NS,'ID',40)!==manifest.reference||leaf(child(root,CAC_NS,'AccountingSupplierParty'),CBC_NS,'CustomerAssignedAccountID',11)!==snapshot.issuer.identityNumber)throw Error();
   const lines=children(root,'urn:sunat:names:specification:ubl:peru:schema:xsd:SunatAggregateComponents-1','SummaryDocumentsLine');
   if(lines.length!==1||leaf(lines[0],CBC_NS,'ID',40)!==snapshot.fullNumber||leaf(lines[0],CBC_NS,'DocumentTypeCode',2)!=='03'||leaf(lines[0],'urn:sunat:names:specification:ubl:peru:schema:xsd:SunatAggregateComponents-1','TotalAmount',24)!==snapshot.totals.payableAmount||leaf(child(lines[0],CAC_NS,'TaxTotal'),CBC_NS,'TaxAmount',24)!==snapshot.totals.igvAmount)throw Error();
   return{reference:manifest.reference as string,ownerId:expected.documentId,batchId:batch.id,artifacts:originals,xmlSha256:manifest.xml.sha256 as string,zipSha256:manifest.zip.sha256 as string};
  }catch{throw new ConflictException('El resumen RC no corresponde exactamente a esta boleta; requiere revisión');}
 }

}
