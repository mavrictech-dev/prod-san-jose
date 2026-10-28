import type { ProductionBatchesSnapshot } from '@factuez/contracts/production-batches';
import { buildProductionBatchesUbl } from '@factuez/sunat-core/dist/production-batches';
import { buildInvoiceUbl } from '@factuez/sunat-core';
import { XmlSignerService } from '../infrastructure/crypto/xml-signer.service';
import { zipSync } from 'fflate';
export function prepareProductionBatchesXml(snapshot:ProductionBatchesSnapshot,bytes:Buffer,password:string){
 const kind=snapshot.kind==='RC'?'SummaryDocuments':'VoidedDocuments';
 const signed=new XmlSignerService().sign(buildProductionBatchesUbl(snapshot),bytes,password,kind);
 const fileName=snapshot.issuerRuc+'-'+snapshot.identifier;
 const originals=snapshot.entries.filter(e=>e.conditionCode==='1').map(e=>{const name=snapshot.issuerRuc+'-03-'+e.snapshot.fullNumber,original=new XmlSignerService().sign(buildInvoiceUbl(e.snapshot,{mode:'REAL_PREPARATION'}),bytes,password,'Invoice');return {documentId:e.snapshot.documentId,fileName:name,...original,zip:Buffer.from(zipSync({[name+'.xml']:Buffer.from(original.xml)},{level:6,mtime:new Date('2020-01-01T00:00:00Z')}))};});
 return {...signed,originals,fileName,zip:Buffer.from(zipSync({[fileName+'.xml']:Buffer.from(signed.xml)},{level:6,mtime:new Date('2020-01-01T00:00:00Z')}))};
}
