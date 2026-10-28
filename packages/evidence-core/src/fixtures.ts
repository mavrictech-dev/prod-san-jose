/** Fixed fictional namespace only. Never a production emitter or legacy extractor. */
import {validateHistoricalSnapshot,type HistoricalDocumentSnapshotV1} from '@factuez/history-core';
const uuid=(n:number)=>`00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
const x=(s:unknown)=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function createBusinessEvidenceSnapshot(type:'01'|'03'|'07'|'08'='01',number=1):HistoricalDocumentSnapshotV1 {
  const amounts={taxableAmount:'100.00',exemptAmount:'0.00',unaffectedAmount:'0.00',freeAmount:'0.00',discountTotal:'0.00',
    igvAmount:'18.00',iscAmount:'0.00',otherTaxesAmount:'0.00',payableAmount:'118.00'},base=Number(type)*100;
  return validateHistoricalSnapshot({schemaVersion:'factuez.history-document.v1',environment:'BETA',ownership:{mappingId:uuid(base+1),issuerRuc:'00000000001',companyId:1,
    branchId:uuid(30001),emissionPointId:uuid(30002),seriesCounterId:uuid(base+2),documentTypeCode:type,series:type==='03'?'BQ01':'FQ01'},
    sourceDocumentId:uuid(base+number+40000),originSystem:'RESTOAPP',originId:`FICTICIO-EVIDENCIA-${type}-${number}`,number:String(number),
    issueDate:'2026-10-04T15:30:00Z',currencyCode:'PEN',operationTypeCode:'0101',
    issuer:{ruc:'00000000001',legalName:'EMISOR FICTICIO QA',tradeName:'ESTACION FICTICIA',address:'AVENIDA FICTICIA 123',ubigeo:'000000',establishmentCode:'0000'},
    customer:{identityType:'6',identityNumber:'00000000002',legalName:'CLIENTE FICTICIO QA',address:'DIRECCION FICTICIA 456',email:'qa@pruebas.invalid'},
    items:[{lineNumber:1,productCode:'FUEL-QA',description:'COMBUSTIBLE FICTICIO - PRUEBA LOCAL',unitCode:'GLL',quantity:'2.000000',unitValue:'50.000000',
      unitPriceWithTax:'59.000000',taxAffectationCode:'10',igvRate:'18.00',amounts:{...amounts}}],
    tax:[{taxSchemeId:'1000',taxName:'IGV',taxableAmount:'100.00',taxAmount:'18.00'}],amounts,paymentTerms:{type:'CONTADO'},
    reference:['07','08'].includes(type)?{issuerRuc:'00000000001',documentTypeCode:'01',series:'FQ01',number:'1',reasonCode:'01',reason:'AJUSTE FICTICIO QA'}:null,
    vehiclePlate:null,amountInWords:'CIENTO DIECIOCHO Y 00/100 SOLES',observations:'FICTICIO - SIN VALIDEZ TRIBUTARIA',
    sourceEvidence:{declaredStatus:'NOT_DECLARED',responseCode:null,description:null,authenticity:'NOT_VERIFIED'},artifacts:[]});
}
export function buildBusinessEvidenceXml(input:unknown,prefix='cbc') {
  const s=validateHistoricalSnapshot(input);if(!/^[a-z]{1,5}$/.test(prefix)||['ext','cac','ds','xml','xmlns'].includes(prefix))throw new Error('Prefijo QA inválido');
  const type=s.ownership.documentTypeCode,kind=type==='07'?'CreditNote':type==='08'?'DebitNote':'Invoice',lineTag=type==='07'?'CreditNoteLine':type==='08'?'DebitNoteLine':'InvoiceLine';
  const leaf=(n:string,v:unknown,a='')=>`<${prefix}:${n}${a}>${x(v)}</${prefix}:${n}>`,agg=(n:string,v:string)=>`<cac:${n}>${v}</cac:${n}>`,amount=(n:string,v:string)=>leaf(n,v,` currencyID="${s.currencyCode}"`);
  const address=(value:{address:string|null;ubigeo?:string;establishmentCode?:string})=>agg('RegistrationAddress',
    (value.ubigeo?leaf('ID',value.ubigeo):'')+(value.establishmentCode?leaf('AddressTypeCode',value.establishmentCode):'')+
    (value.address?agg('AddressLine',leaf('Line',value.address)):'')+agg('Country',leaf('IdentificationCode','PE')));
  const party=(supplier:boolean)=>{const p=supplier?{identityType:'6',identityNumber:s.issuer.ruc,legalName:s.issuer.legalName,address:s.issuer.address}:s.customer;
    return agg(supplier?'AccountingSupplierParty':'AccountingCustomerParty',agg('Party',agg('PartyIdentification',leaf('ID',p.identityNumber,` schemeID="${p.identityType}"`))+
      (supplier&&s.issuer.tradeName?agg('PartyName',leaf('Name',s.issuer.tradeName)):'')+agg('PartyLegalEntity',leaf('RegistrationName',p.legalName)+address(supplier?s.issuer:p))));};
  const scheme=(id:string,name:string)=>agg('TaxScheme',leaf('ID',id)+leaf('Name',name)+leaf('TaxTypeCode',id==='2000'?'EXC':id==='9999'?'OTH':id==='9995'?'FRE':'VAT'));
  const subtotal=(id:string,name:string,base:string,tax:string,rate?:string,affectation?:string)=>agg('TaxSubtotal',amount('TaxableAmount',base)+amount('TaxAmount',tax)+agg('TaxCategory',
    (rate!==undefined?leaf('Percent',rate):'')+(affectation!==undefined?leaf('TaxExemptionReasonCode',affectation):'')+scheme(id,name)));
  const taxCents=s.tax.reduce((n,t)=>n+BigInt(t.taxAmount.replace('.','')),0n);
  const tax=agg('TaxTotal',amount('TaxAmount',`${taxCents/100n}.${String(taxCents%100n).padStart(2,'0')}`)+
    s.tax.map(t=>subtotal(t.taxSchemeId,t.taxName,t.taxableAmount,t.taxAmount)).join(''));
  const lines=s.items.map(l=>{const primary=l.amounts.freeAmount!=='0.00'?'9995':l.amounts.exemptAmount!=='0.00'?'9997':l.amounts.unaffectedAmount!=='0.00'?'9998':'1000';
    const base=l.amounts.taxableAmount!=='0.00'?l.amounts.taxableAmount:l.amounts.exemptAmount!=='0.00'?l.amounts.exemptAmount:l.amounts.unaffectedAmount;
    return agg(lineTag,leaf('ID',l.lineNumber)+leaf(type==='07'?'CreditedQuantity':type==='08'?'DebitedQuantity':'InvoicedQuantity',l.quantity,` unitCode="${l.unitCode}"`)+amount('LineExtensionAmount',base)+
      agg('PricingReference',agg('AlternativeConditionPrice',amount('PriceAmount',l.unitPriceWithTax)+leaf('PriceTypeCode',primary==='9995'?'02':'01')))+
      (l.amounts.discountTotal==='0.00'?'':agg('AllowanceCharge',leaf('ChargeIndicator','false')+leaf('AllowanceChargeReasonCode','00')+amount('Amount',l.amounts.discountTotal)))+
      agg('TaxTotal',amount('TaxAmount',l.amounts.igvAmount)+subtotal(primary,s.tax.find(t=>t.taxSchemeId===primary)?.taxName??'IGV',primary==='9995'?l.amounts.freeAmount:base,l.amounts.igvAmount,l.igvRate,l.taxAffectationCode))+
      agg('Item',leaf('Description',l.description)+(l.productCode?agg('SellersItemIdentification',leaf('ID',l.productCode)):''))+agg('Price',amount('PriceAmount',l.unitValue)));});
  const payment=s.paymentTerms.type==='CONTADO'?agg('PaymentTerms',leaf('ID','FormaPago')+leaf('PaymentMeansID','Contado')):
    agg('PaymentTerms',leaf('ID','FormaPago')+leaf('PaymentMeansID','Credito')+amount('Amount',s.paymentTerms.pendingAmount))+s.paymentTerms.installments.map((i,n)=>
      agg('PaymentTerms',leaf('ID','FormaPago')+leaf('PaymentMeansID',`Cuota${String(n+1).padStart(3,'0')}`)+amount('Amount',i.amount)+leaf('PaymentDueDate',i.dueDate))).join('');
  const reference=s.reference?agg('DiscrepancyResponse',leaf('ReferenceID',s.reference.series+'-'+s.reference.number)+leaf('ResponseCode',s.reference.reasonCode)+leaf('Description',s.reference.reason))+
    agg('BillingReference',agg('InvoiceDocumentReference',leaf('ID',s.reference.series+'-'+s.reference.number)+leaf('DocumentTypeCode',s.reference.documentTypeCode))):'';
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Lima',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(s.issueDate));
  const time=new Intl.DateTimeFormat('en-GB',{timeZone:'America/Lima',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(s.issueDate));
  const netCents=['taxableAmount','exemptAmount','unaffectedAmount'].reduce((n,k)=>n+BigInt(s.amounts[k as keyof typeof s.amounts].replace('.','')),0n);
  return `<?xml version="1.0" encoding="UTF-8"?><${kind} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${kind}-2" xmlns:${prefix}="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"><ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions>`+
    leaf('UBLVersionID','2.1')+leaf('CustomizationID','2.0')+(kind!=='Invoice'?leaf('ProfileID',s.operationTypeCode):'')+leaf('ID',s.ownership.series+'-'+s.number)+leaf('IssueDate',date)+leaf('IssueTime',time)+
    (kind==='Invoice'?leaf('InvoiceTypeCode',type,` listID="${s.operationTypeCode}"`):'')+(s.amountInWords?leaf('Note',s.amountInWords,' languageLocaleID="1000"'):'')+
    (s.observations?leaf('Note',s.observations,' languageLocaleID="2000"'):'')+leaf('DocumentCurrencyCode',s.currencyCode)+reference+party(true)+party(false)+payment+tax+
    agg(type==='08'?'RequestedMonetaryTotal':'LegalMonetaryTotal',amount('LineExtensionAmount',`${netCents/100n}.${String(netCents%100n).padStart(2,'0')}`)+
      amount('TaxInclusiveAmount',s.amounts.payableAmount)+amount('AllowanceTotalAmount',s.amounts.discountTotal)+amount('PayableAmount',s.amounts.payableAmount))+lines.join('')+`</${kind}>`;
}
