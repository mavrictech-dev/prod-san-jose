import { Injectable } from '@nestjs/common';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { ProductionBatchesRepository, type ProductionBatchesRow, type ProductionBatchesManifest } from './production-batches-repository';
import { ProductionBatchesPolicyService } from './production-batches-policy.service';
import { ProductionBatchesEvidenceService } from './production-batches-evidence.service';
import { ProductionNotesEvidenceService } from './production-notes-evidence.service';
import { buildProductionBatchesUbl, assertProductionBatchesSnapshot } from '@factuez/sunat-core/dist/production-batches';
import { buildInvoiceUbl, fiscalSnapshotSha256, fiscalLimaDate } from '@factuez/sunat-core';
import { ArtifactStore } from '../infrastructure/artifact-store';
import { SecretVault } from '../infrastructure/crypto/secret-vault';
import { CertificateInspectionService } from '../infrastructure/crypto/certificate-inspection.service';
import { CertificateTrustService } from '../infrastructure/crypto/certificate-trust.service';
import { PublicSignerArchive } from '../infrastructure/crypto/public-signer-archive';
import { CdrSignatureTrustService } from '../infrastructure/crypto/cdr-signature-trust.service';
import { XsdValidationService } from '../infrastructure/sunat/xsd-validation.service';
import { verifyLocalSignedInvoice } from '../infrastructure/crypto/xml-signer.service';
import { createProductionSoapAuthorization } from '../infrastructure/sunat/production-soap-authorization';
import { productionTransportXml } from '../infrastructure/sunat/production-transport-zip';
import { ProductionBatchesSoap } from '../infrastructure/production-batches-soap';
import { verifyProductionBatchesCdr } from '../infrastructure/production-batches-cdr';
import type { prepareProductionBatchesXml } from './production-batches-crypto';
@Injectable()
export class ProductionBatchesDispatchService {
 constructor(private readonly repository:ProductionBatchesRepository,private readonly policy:ProductionBatchesPolicyService,
 private readonly evidence:ProductionBatchesEvidenceService,private readonly signed:ProductionNotesEvidenceService,
 private readonly store:ArtifactStore,private readonly vault:SecretVault,private readonly inspection:CertificateInspectionService,
 private readonly trust:CertificateTrustService,private readonly publicSigners:PublicSignerArchive,
 private readonly cdrTrust:CdrSignatureTrustService,private readonly xsd:XsdValidationService){}
 protected async sign(row:ProductionBatchesRow,bytes:Buffer,password:string):Promise<ReturnType<typeof prepareProductionBatchesXml>>{
  return new Promise((resolve,reject)=>{
   const worker=new Worker(join(__dirname,'production-batches-crypto.worker.js'),{workerData:{snapshot:row.payload.snapshot,bytes,password},resourceLimits:{maxOldGenerationSizeMb:96,maxYoungGenerationSizeMb:16}});
   let settled=false;
   const finish=(error?:Error,value?:ReturnType<typeof prepareProductionBatchesXml>)=>{
    if(settled)return;settled=true;clearTimeout(timer);
    void worker.terminate().then(()=>error?reject(error):resolve({...value!,zip:Buffer.from(value!.zip),originals:value!.originals.map(o=>({...o,zip:Buffer.from(o.zip)}))}),()=>reject(Error('Worker interrumpido')));
   };
   const timer=setTimeout(()=>finish(Error('Firma excedió límite')),10000);
   worker.once('message',m=>m.ok?finish(undefined,m.value):finish(Error('Firma inválida')));
   worker.once('error',()=>finish(Error('Worker no disponible')));worker.once('exit',()=>finish(Error('Worker interrumpido')));
  });
 }
 private async authorize(row:ProductionBatchesRow,forSend:boolean){
  const b=row.payload.snapshot;
  assertProductionBatchesSnapshot(b,forSend?new Date().toISOString():row.payload.occurredAt);
  if(forSend){const today=fiscalLimaDate(new Date().toISOString());for(const e of b.entries){const start=b.kind==='RC'?b.referenceDate:fiscalLimaDate(e.acceptance!.acceptedAt);if((Date.parse(today+'T12:00:00Z')-Date.parse(start+'T12:00:00Z'))/86400000>7)throw Error('Lote vencido; no enviar');}}
  await this.policy.current(b.issuerRuc,row.grant);
  for(const e of b.entries){
   const frozen=e.previous?.acceptance??e.acceptance;
   if(frozen){
    const actual=await this.evidence.current(e.previous?.snapshot??e.snapshot);
    if(fiscalSnapshotSha256(actual)!==fiscalSnapshotSha256(frozen))throw Error('Aceptación original cambió');
   }
  }
 }
 protected async prepare(row:ProductionBatchesRow):Promise<{manifest:ProductionBatchesManifest;grant:NonNullable<ProductionBatchesRow['grant']>}>{
  const b=row.payload.snapshot,{grant,credentials:c}=await this.policy.current(b.issuerRuc),aad={ruc:b.issuerRuc,environment:'PRODUCTION'};
  if(!c.certificateCipher||!c.certificatePasswordCipher)throw Error('Certificado pendiente');
  const bytes=this.vault.open(c.certificateCipher,{...aad,field:'certificate'});let password:Buffer|undefined;
  try{
   password=this.vault.open(c.certificatePasswordCipher,{...aad,field:'certificatePassword'});
   const metadata=await this.inspection.inspect(bytes,password.toString()),now=new Date(),proof=await this.trust.evaluate(metadata,b.issuerRuc,now);
   if(metadata.fingerprint!==grant.fingerprint||proof.profile!=='OFFLINE-PINNED-ROOTS-CRL-v1'||!proof.chainValid||!proof.identityMatched||proof.revocation!=='VERIFIED_OFFLINE_CRL'||proof.blockers.length||
      proof.certificateFingerprint!==metadata.fingerprint||proof.checkedAt!==now.toISOString()||!/^[a-f0-9]{64}$/.test(proof.trustStoreSha256??''))throw Error('PKI/CRL de firma pendiente');
   const result=await this.sign(row,bytes,password.toString()),kind=b.kind==='RC'?'SummaryDocuments':'VoidedDocuments',name=b.issuerRuc+'-'+b.identifier;
   if(result.fileName!==name||result.certificateFingerprintSha256!==grant.fingerprint||verifyLocalSignedInvoice(result.xml,metadata.certificatePem,buildProductionBatchesUbl(b),kind)!==result.digestValue||
      !productionTransportXml(result.zip,name+'.xml').xml.equals(Buffer.from(result.xml)))throw Error('Firma/ZIP difiere del lote');
   await this.xsd.validate(result.xml,kind);await this.policy.current(b.issuerRuc,grant);
   await this.publicSigners.archive(b.issuerRuc,metadata);
   const originals:NonNullable<ProductionBatchesManifest['originals']>={};
   for(const o of result.originals){const entry=b.entries.find(e=>e.snapshot.documentId===o.documentId);if(!entry||entry.conditionCode!=='1'||o.fileName!==b.issuerRuc+'-03-'+entry.snapshot.fullNumber||verifyLocalSignedInvoice(o.xml,metadata.certificatePem,buildInvoiceUbl(entry.snapshot,{mode:'REAL_PREPARATION'}),'Invoice')!==o.digestValue||!productionTransportXml(o.zip,o.fileName+'.xml').xml.equals(Buffer.from(o.xml)))throw Error('Original individual no exacto');await this.xsd.validate(o.xml,'Invoice');originals[o.documentId]={xml:await this.store.put(o.documentId,o.fileName+'.xml',Buffer.from(o.xml)),zip:await this.store.put(o.documentId,o.fileName+'.zip',o.zip),digest:o.digestValue};}
   return {grant,manifest:{originals,fileName:name+'.zip',xml:await this.store.put(b.batchId,name+'.xml',Buffer.from(result.xml)),zip:await this.store.put(b.batchId,name+'.zip',result.zip)}};
  }finally{bytes.fill(0);password?.fill(0);}
 }
 private async archived(row:ProductionBatchesRow){
  const m=row.manifest,b=row.payload.snapshot;if(!m)throw Error('Manifiesto requerido');
  const xml=await this.store.read(b.batchId,m.xml),zip=await this.store.read(b.batchId,m.zip),kind=b.kind==='RC'?'SummaryDocuments':'VoidedDocuments';
  if(m.fileName!==b.issuerRuc+'-'+b.identifier+'.zip'||!productionTransportXml(zip,m.fileName.replace(/\.zip$/,'.xml')).xml.equals(xml))throw Error('Archivo exacto inválido');
  const proof=await this.signed.signed(b.issuerRuc,xml,buildProductionBatchesUbl(b),kind);
  if(proof.fingerprint!==row.grant?.fingerprint)throw Error('Firmante archivado cambió');
  const validation=await this.xsd.validate(xml,kind);if(validation.xmlSha256!==m.xml.sha256)throw Error('XSD ajeno');
  return zip;
 }
 protected async adapter(row:ProductionBatchesRow,send:boolean){
  const b=row.payload.snapshot,{credentials:c}=await this.policy.current(b.issuerRuc,row.grant),aad={ruc:b.issuerRuc,environment:'PRODUCTION'};
  if(!c.solUsernameCipher||!c.solPasswordCipher)throw Error('SOL pendiente');
  const user=this.vault.open(c.solUsernameCipher,{...aad,field:'solUsername'});let password:Buffer|undefined;
  try{
   password=this.vault.open(c.solPasswordCipher,{...aad,field:'solPassword'});
   const authority=createProductionSoapAuthorization({ruc:b.issuerRuc,operations:send?['sendSummary']:['getStatus']},async()=>{await this.authorize(row,send);await this.archived(row);});
   return new ProductionBatchesSoap(b.issuerRuc,user.toString(),password.toString(),authority);
  }finally{user.fill(0);password?.fill(0);}
 }
 async process(id:string){
  let row=await this.repository.load(id);
  if(!row||!['QUEUED','PREPARED','SUBMITTED'].includes(row.state))return;
  await this.authorize(row,row.state!=='SUBMITTED');
  if(row.state==='QUEUED'){
   const prepared=await this.prepare(row);
   if(!await this.repository.prepared(row,prepared.manifest,prepared.grant))return;
   row={...row,state:'PREPARED',manifest:prepared.manifest,grant:prepared.grant};
  }
  if(row.state==='PREPARED'){
   const zip=await this.archived(row),adapter=await this.adapter(row,true);
   if(!await this.repository.claim(row))return;
   try{
    const ticket=await adapter.submitSummary({documentId:id,fileName:row.manifest!.fileName,zip,sha256:row.manifest!.zip.sha256});
    await this.repository.outcome(row,'SENDING','SUBMITTED',ticket);
   }catch{await this.repository.outcome(row,'SENDING','UNKNOWN');}
   return;
  }
  if(!row.ticket)throw Error('Ticket requerido; no reenvío');
  try{
   const result=await (await this.adapter(row,false)).getStatus(row.ticket);
   if(result.kind==='PROCESSING')return;
   if(result.kind!=='CDR'){await this.repository.outcome(row,'SUBMITTED','UNKNOWN');return;}
   await this.archived(row);
   const b=row.payload.snapshot,cdr=await verifyProductionBatchesCdr(result.cdrZip,b,this.cdrTrust),members:NonNullable<ProductionBatchesRow['cdrManifest']>['members']={};
   for(const [name,xml]of Object.entries(cdr.files))members[name]=await this.store.put(id,name,xml);
   const archive={zip:await this.store.put(id,'R-'+b.issuerRuc+'-'+b.identifier+'.zip',result.cdrZip),members};
   await this.repository.outcome(row,'SUBMITTED',cdr.status,undefined,archive,cdr.responseCode);
  }catch{
   // Keep known ticket pollable after transient read/PKI/XSD failure. Never retry POST sendSummary.
  }
 }
}
