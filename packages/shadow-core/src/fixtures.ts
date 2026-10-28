/** Bundled synthetic fixture only. No environment, database, files or certificates. */
import {createHash} from 'node:crypto';
import type {HistoricalDocumentSnapshotV1} from '@factuez/history-core';
import type {ShadowCaseV1,ShadowPrintProjection,ShadowRunV1,ShadowSide} from './index';
const uuid=(n:number)=>`00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const digest=(s:string)=>createHash('sha256').update(`DECLARED-ONLY-NOT-A-SIGNED-XML:${s}`).digest('base64');
const escape=(s:unknown)=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const day=(s:HistoricalDocumentSnapshotV1)=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Lima',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(s.issueDate));
function document(number:number,type:'01'|'03'|'07'|'08'):HistoricalDocumentSnapshotV1{
  const base=100+Number(type),ruc='00000000001',amounts={taxableAmount:'100.00',exemptAmount:'0.00',unaffectedAmount:'0.00',freeAmount:'0.00',discountTotal:'0.00',
    igvAmount:'18.00',iscAmount:'0.00',otherTaxesAmount:'0.00',payableAmount:'118.00'};
  return {schemaVersion:'factuez.history-document.v1',environment:'BETA',ownership:{mappingId:uuid(base*10+4),issuerRuc:ruc,companyId:1,
    branchId:uuid(10001),emissionPointId:uuid(10002),seriesCounterId:uuid(base*10+3),documentTypeCode:type,series:type==='03'?'BQ01':'FQ01'},
    sourceDocumentId:uuid(1000000+number*100+Number(type)),originSystem:'RESTOAPP',originId:`FICTICIO-1-${type}-${number}`,number:String(number),
    issueDate:'2026-10-01T10:00:00-05:00',currencyCode:'PEN',operationTypeCode:'0101',
    issuer:{ruc,legalName:'EMISOR FICTICIO 1',tradeName:null,address:'DIRECCION FICTICIA QA',ubigeo:'000000',establishmentCode:'0000'},
    customer:{identityType:'0',identityNumber:'0',legalName:'CLIENTE FICTICIO',address:null,email:'ficticio@pruebas.invalid'},
    items:[{lineNumber:1,productCode:'FICTICIO',description:'COMBUSTIBLE FICTICIO PARA QA',unitCode:'GLL',quantity:'2',unitValue:'50',unitPriceWithTax:'59',taxAffectationCode:'10',igvRate:'18.00',amounts:{...amounts}}],
    tax:[{taxSchemeId:'1000',taxName:'IGV',taxableAmount:'100.00',taxAmount:'18.00'}],amounts,paymentTerms:{type:'CONTADO'},
    reference:['07','08'].includes(type)?{issuerRuc:ruc,documentTypeCode:'01',series:'FQ01',number:'1',reasonCode:'01',reason:'REFERENCIA FICTICIA'}:null,
    vehiclePlate:null,amountInWords:null,observations:'NO FISCAL - QA AISLADA',sourceEvidence:{declaredStatus:'NOT_DECLARED',responseCode:null,description:null,authenticity:'NOT_VERIFIED'},artifacts:[]};
}
function side(s:HistoricalDocumentSnapshotV1,label:string):ShadowSide{
  const kind=s.ownership.documentTypeCode==='07'?'CreditNote':s.ownership.documentTypeCode==='08'?'DebitNote':'Invoice',prefix=label==='legacy'?'c':'b',d=digest(label+':'+s.number);
  const leaf=(name:string,value:unknown)=>`<${prefix}:${name}>${escape(value)}</${prefix}:${name}>`;
  const signature=`<ds:Signature Id="SYNTHETIC-${label}"><ds:SignedInfo><ds:Reference URI=""><ds:DigestValue>${d}</ds:DigestValue></ds:Reference></ds:SignedInfo></ds:Signature>`;
  const xml=`<?xml version="1.0"?><${kind} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${kind}-2" xmlns:${prefix}="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent>${signature}</ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions>${leaf('ID',s.ownership.series+'-'+s.number)}${leaf('IssueDate',day(s))}${kind==='Invoice'?leaf('InvoiceTypeCode',s.ownership.documentTypeCode):''}${leaf('DocumentCurrencyCode',s.currencyCode)}${leaf('Note','XML FICTICIO, NO UBL VALIDADO, SIN FIRMA CRIPTOGRAFICA')}${leaf('PayableAmount',s.amounts.payableAmount)}</${kind}>`;
  const prints:ShadowPrintProjection[]=(['TICKET_80MM','A4'] as const).map(format=>({schemaVersion:'factuez.shadow-print.v1',provenance:'SYNTHETIC_DECLARED',format,
    pageSizesMicrometers:[{width:format==='A4'?210000:80000,height:format==='A4'?297000:150000}],
    textLines:['REPRESENTACION FICTICIA - NO ES UN PDF',s.ownership.series+'-'+s.number,s.customer.legalName,'Total '+s.amounts.payableAmount],
    qrFields:{issuerRuc:s.issuer.ruc,documentTypeCode:s.ownership.documentTypeCode,series:s.ownership.series,number:s.number,igvAmount:s.amounts.igvAmount,payableAmount:s.amounts.payableAmount,issueDate:day(s),customerIdentityType:s.customer.identityType,customerIdentityNumber:s.customer.identityNumber},
    digestValue:d,pdfSha256:sha(`DECLARED-NOT-PDF-BYTES:${label}:${format}:${s.number}`)}));
  return {snapshot:s,xml,prints};
}
/** No caller-supplied input. Fresh, fixed fictional cases for the web laboratory. */
export function createShadowPanelFixture():ShadowRunV1{
  const cases:ShadowCaseV1[]=([['01',1],['01',2],['03',3],['07',4]] as const).map(([type,n])=>{
    const s=document(n,type);let candidate=structuredClone(s);
    if(n===2){const amounts={...s.amounts,taxableAmount:'101.00',igvAmount:'18.18',payableAmount:'119.18'};
      candidate={...s,amounts,items:[{...s.items[0],quantity:'2.02',amounts:{...amounts}}],tax:[{...s.tax[0],taxableAmount:'101.00',taxAmount:'18.18'}]};}
    if(n===4)candidate={...s,observations:'OBSERVACION FICTICIA CON OTRA PRESENTACION'};
    const factuez=side(candidate,'factuez');if(n===3){factuez.xml=null;factuez.prints=[];}
    return {schemaVersion:'factuez.shadow-case.v1',environment:'BETA',datasetClass:'SYNTHETIC',mode:'SHADOW',caseId:uuid(8000000+n),legacy:side(s,'legacy'),factuez};
  });
  return {schemaVersion:'factuez.shadow-run.v1',environment:'BETA',datasetClass:'SYNTHETIC',mode:'SHADOW',runId:uuid(8100000),cases};
}
