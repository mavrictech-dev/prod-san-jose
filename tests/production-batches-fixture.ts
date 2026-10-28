import { calculateDocumentTotals } from '../packages/sunat-core/src/tax';
import { buildProductionBatchesSnapshot } from '../packages/sunat-core/src/production-batches';
import { fiscalSnapshotSha256 } from '../packages/sunat-core/src/fiscal-note';
import type { FiscalDocumentSnapshot } from '../packages/contracts/src/events';
import type { ProductionBatchesAcceptance,ProductionBatchesEntry,ProductionBatchesDeclaration } from '../packages/contracts/src/production-batches';
export const uuid=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
export const asOf='2026-10-28T18:00:00Z';
export function receipt(n:number,type:'01'|'03'='03'):FiscalDocumentSnapshot{
 const series=type==='03'?'B001':'F001';
 return {documentId:uuid(n),companyId:1,branchId:uuid(999),environment:'PRODUCTION',documentTypeCode:type,series,number:String(n),fullNumber:series+'-'+n,issueDate:'2026-10-27T16:00:00Z',currencyCode:'PEN',operationTypeCode:'0101',
 ...(type==='01'?{paymentTerms:{type:'CONTADO' as const}}:{}),
 issuer:{identityType:'6',identityNumber:'20100070970',legalName:'Emisor sintético & pruebas',address:'Dirección sintética 123',ubigeo:'150101',establishmentCode:'0001'},
 customer:{identityType:'6',identityNumber:'20131312955',legalName:'Cliente sintético'},
 ...calculateDocumentTotals([{description:'Bien sintético',unitCode:'NIU',quantity:'2',unitPriceWithTax:'118',taxAffectationCode:'10',igvRate:'18'}])};
}
export function acceptance(s:FiscalDocumentSnapshot):ProductionBatchesAcceptance{
 return {documentId:s.documentId,snapshotSha256:fiscalSnapshotSha256(s),issuerRuc:s.issuer.identityNumber,acceptedAt:'2026-10-27T17:00:00Z',cdrZipSha256:'a'.repeat(64),cdrXmlSha256:'b'.repeat(64),requestXmlSha256:'c'.repeat(64),reference:s.documentTypeCode==='03'?'RC-20261027-1':s.fullNumber,source:s.documentTypeCode==='03'?'INDIVIDUAL_RC':'DOCUMENT'};
}
export function declaration(s:FiscalDocumentSnapshot):ProductionBatchesDeclaration{
 return {id:uuid(700),documentId:s.documentId,snapshotSha256:fiscalSnapshotSha256(s),issuerRuc:s.issuer.identityNumber,actorId:uuid(701),assertedAt:asOf,reason:'Documento no otorgado al cliente',status:'NOT_DELIVERED'};
}
export function entries(count=2):ProductionBatchesEntry[]{
 return Array.from({length:count},(_,i)=>({snapshot:receipt(i+1),conditionCode:'1',pendingRoute:{documentId:uuid(i+1),token:uuid(1000+i),transmissionStarted:false}}));
}
export function batch(es=entries(),kind:'RC'|'RA'='RC'){
 return buildProductionBatchesSnapshot(es,kind,{documentId:uuid(9000),identifier:kind+'-20261028-1',issueDate:'2026-10-28',referenceDate:'2026-10-27'},1,asOf);
}
