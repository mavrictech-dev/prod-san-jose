'use strict';
const {createHash}=require('node:crypto');
const uuid=n=>`00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
function mapping(company=1,type='03') {
  const base=company*100+Number(type);
  return {mappingId:uuid(base*10+4),issuerRuc:'00000000'+String(company).padStart(3,'0'),companyId:company,
    branchId:uuid(company*10000+1),emissionPointId:uuid(company*10000+2),seriesCounterId:uuid(base*10+3),
    documentTypeCode:type,series:type==='03'?'BQ01':'FQ01'};
}
function artifactBytes(kind) {return Buffer.from(`<?xml version="1.0"?>\n<Ficticio>${kind}: SIN FIRMA NI CDR OFICIAL, SOLO QA.</Ficticio>\n`);}
function amounts() {return {taxableAmount:'100.00',exemptAmount:'0.00',unaffectedAmount:'0.00',freeAmount:'0.00',discountTotal:'0.00',
  igvAmount:'18.00',iscAmount:'0.00',otherTaxesAmount:'0.00',payableAmount:'118.00'};}
function document(number=1,company=1,type='03',withFiles=false) {
  return {schemaVersion:'factuez.history-document.v1',environment:'BETA',ownership:mapping(company,type),
    sourceDocumentId:uuid(company*1000000+number*100+Number(type)),originSystem:'RESTOAPP',originId:`FICTICIO-${company}-${type}-${number}`,
    number:String(number),issueDate:'2026-10-01T10:00:00-05:00',currencyCode:'PEN',operationTypeCode:'0101',
    issuer:{ruc:mapping(company,type).issuerRuc,legalName:`EMISOR FICTICIO ${company}`,tradeName:null,address:'DIRECCION FICTICIA QA',ubigeo:'000000',establishmentCode:'0000'},
    customer:{identityType:'0',identityNumber:'0',legalName:'CLIENTE FICTICIO',address:null,email:'ficticio@pruebas.invalid'},
    items:[{lineNumber:1,productCode:'FICTICIO',description:'COMBUSTIBLE FICTICIO PARA QA',unitCode:'GLL',quantity:'2',unitValue:'50',unitPriceWithTax:'59',
      taxAffectationCode:'10',igvRate:'18.00',amounts:amounts()}],
    tax:[{taxSchemeId:'1000',taxName:'IGV',taxableAmount:'100.00',taxAmount:'18.00'}],amounts:amounts(),paymentTerms:{type:'CONTADO'},
    reference:['07','08'].includes(type)?{issuerRuc:mapping(company,type).issuerRuc,documentTypeCode:'01',series:'FQ01',number:'1',reasonCode:'01',reason:'REFERENCIA FICTICIA'}:null,
    vehiclePlate:null,amountInWords:null,observations:'NO FISCAL - QA AISLADA',
    sourceEvidence:{declaredStatus:'NOT_DECLARED',responseCode:null,description:null,authenticity:'NOT_VERIFIED'},
    artifacts:withFiles?['SIGNED_XML','CDR_XML'].map(kind=>({kind,originalName:'ficticio.xml',sha256:createHash('sha256').update(artifactBytes(kind)).digest('hex'),sizeBytes:artifactBytes(kind).length})):[]};
}
function exported(count=1,withFiles=false) {
  return {schemaVersion:'factuez.history-full.v1',environment:'BETA',datasetClass:'SYNTHETIC',exportId:uuid(9000001),originSystem:'RESTOAPP',
    mappings:[mapping()],documents:Array.from({length:count},(_,i)=>document(i+1,1,'03',withFiles&&i===0))};
}
function actor(global=true) {
  const m=mapping(); return {userId:uuid(9000002),roles:global?['ADMIN']:['AUDITOR'],permissions:global?['history.import','history.view']:['history.view'],
    scope:global?{kind:'GLOBAL'}:{kind:'ASSIGNED',branchIds:[m.branchId],emissionPointIds:[m.emissionPointId],seriesCounterIds:[m.seriesCounterId]}};
}
module.exports={uuid,mapping,document,exported,actor,artifactBytes};
