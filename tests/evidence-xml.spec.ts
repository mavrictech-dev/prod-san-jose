import {describe,it,expect} from 'vitest';
import {validateHistoricalSnapshot} from '../packages/history-core/src';
import {createBusinessEvidenceSnapshot,buildBusinessEvidenceXml} from '../packages/evidence-core/src/fixtures';
import {bindSyntheticBusinessXml,readSyntheticBusinessXml,compareSyntheticBusinessXml,EVIDENCE_POLICY} from '../packages/evidence-core/src/xml';
const s=()=>createBusinessEvidenceSnapshot(),xml=()=>buildBusinessEvidenceXml(s());
describe('evidencia XML de negocio completa del contrato sintético',()=>{
  it.each(['01','03','07','08'] as const)('vincula cabecera emisor cliente ítems impuestos totales pago y referencia %s',type=>{
    const snap=createBusinessEvidenceSnapshot(type),r=bindSyntheticBusinessXml(buildBusinessEvidenceXml(snap),snap);
    expect(r.binding).toMatchObject({match:true,differenceCount:0});expect(r).toMatchObject({fiscalAuthority:false,signatureVerified:false,productionBlocked:true});
    expect(r.projection.items[0]).toEqual(snap.items[0]);expect(r.projection.issuer).toEqual(snap.issuer);
  });
  it('normaliza decimales exactos y namespaces independientemente de los prefijos',()=>{
    const a=xml(),b=buildBusinessEvidenceXml(s(),'b').replace('>2.000000<','>2<');
    expect(compareSyntheticBusinessXml(a,b).match).toBe(true);
  });
  it('normaliza instantes Lima sin depender de la zona local del servidor',()=>{
    const snap={...s(),issueDate:'2026-10-04T10:30:00-05:00'};expect(bindSyntheticBusinessXml(xml(),snap).binding.match).toBe(true);
    expect(bindSyntheticBusinessXml(xml(),{...snap,issueDate:'2026-10-04T10:31:00-05:00'}).binding.match).toBe(false);
  });
  it.each([
    ['issuer.legalName','EMISOR FICTICIO QA','EMISOR FICTICIO ALTERADO'],
    ['issuer.address','AVENIDA FICTICIA 123','AVENIDA FICTICIA 124'],
    ['issuer.ubigeo','>000000<','>000001<'],
    ['issuer.establishmentCode','>0000<','>0001<'],
    ['issuer.tradeName','ESTACION FICTICIA','OTRA ESTACION FICTICIA'],
    ['customer.legalName','CLIENTE FICTICIO QA','OTRO CLIENTE FICTICIO'],
    ['customer.identityNumber','00000000002','00000000003'],
    ['customer.address','DIRECCION FICTICIA 456','DIRECCION FICTICIA 457'],
    ['items.0.description','COMBUSTIBLE FICTICIO - PRUEBA LOCAL','OTRO ITEM FICTICIO'],
    ['items.0.productCode','FUEL-QA','OTRO-QA'],
    ['items.0.quantity','>2.000000<','>3.000000<'],
    ['items.0.unitCode','unitCode="GLL"','unitCode="LTR"'],
    ['items.0.unitValue','>50.000000<','>51.000000<'],
    ['items.0.unitPriceWithTax','>59.000000<','>60.000000<'],
    ['items.0.igvRate','>18.00</cbc:Percent>','>17.00</cbc:Percent>'],
    ['items.0.taxAffectationCode','>10</cbc:TaxExemptionReasonCode>','>20</cbc:TaxExemptionReasonCode>'],
    ['header.operationTypeCode','listID="0101"','listID="0200"'],
  ])('no oculta cambios de %s',(path,from,to)=>{
    const r=bindSyntheticBusinessXml(xml().replace(from,to),s());expect(r.binding.match).toBe(false);
    expect(r.binding.differences.some(d=>d.path.endsWith(path))).toBe(true);
  });
  it('no acepta impuestos cabecera que no suman exactamente las líneas',()=>{
    expect(()=>readSyntheticBusinessXml(xml().replace('>18.00</cbc:TaxAmount>','>17.99</cbc:TaxAmount>'),EVIDENCE_POLICY)).toThrow(/XML_TAX_TOTAL_MISMATCH/);
  });
  it('no acepta totales monetarios incoherentes',()=>{
    expect(()=>readSyntheticBusinessXml(xml().replace('>118.00</cbc:PayableAmount>','>118.01</cbc:PayableAmount>'),EVIDENCE_POLICY)).toThrow(/XML_MONETARY_MISMATCH/);
  });
  it('dos líneas conservan orden y sumas exactas',()=>{
    const snap:any=structuredClone(s());snap.items.push({...snap.items[0],lineNumber:2,description:'SEGUNDO ITEM QA'});
    snap.amounts.taxableAmount='200.00';snap.amounts.igvAmount='36.00';snap.amounts.payableAmount='236.00';snap.tax[0].taxableAmount='200.00';snap.tax[0].taxAmount='36.00';
    expect(bindSyntheticBusinessXml(buildBusinessEvidenceXml(snap),snap).binding.match).toBe(true);
  });
  it('crédito conserva monto pendiente y fechas/cuotas en orden',()=>{
    const snap:any=structuredClone(s());snap.paymentTerms={type:'CREDITO',currencyCode:'PEN',pendingAmount:'118.00',installments:[{amount:'59.00',dueDate:'2026-11-04'},{amount:'59.00',dueDate:'2026-12-04'}]};
    const text=buildBusinessEvidenceXml(snap),r=bindSyntheticBusinessXml(text,snap);expect(r.binding.match).toBe(true);
    expect(bindSyntheticBusinessXml(text.replace('2026-12-04','2026-12-05'),snap).binding.match).toBe(false);
  });
  it('descuento de línea no se resta dos veces del importe neto',()=>{
    const snap:any=structuredClone(s());snap.amounts.discountTotal='5.00';snap.items[0].amounts.discountTotal='5.00';
    expect(bindSyntheticBusinessXml(buildBusinessEvidenceXml(snap),snap).binding.match).toBe(true);
  });
  it.each([['20','9997','EXO','exemptAmount'],['30','9998','INA','unaffectedAmount']])('lee afectación %s sin inventar IGV', (code,scheme,name,base)=>{
    const snap:any=structuredClone(s());snap.amounts.taxableAmount='0.00';snap.amounts[base]='100.00';snap.amounts.igvAmount='0.00';snap.amounts.payableAmount='100.00';
    snap.items[0].amounts={...snap.amounts};snap.items[0].taxAffectationCode=code;snap.items[0].igvRate='0.00';snap.items[0].unitPriceWithTax='50';
    snap.tax=[{taxSchemeId:scheme,taxName:name,taxableAmount:'100.00',taxAmount:'0.00'}];snap.amountInWords=null;
    expect(bindSyntheticBusinessXml(buildBusinessEvidenceXml(snap),snap).binding.match).toBe(true);
  });
  it.each([
    ['DTD',()=>xml().replace('<?xml version="1.0" encoding="UTF-8"?>','<!DOCTYPE Invoice [<!ENTITY x SYSTEM "file:///no">]>')],
    ['comment',()=>xml().replace('<cbc:ID>FQ01-1','<!-- x --><cbc:ID>FQ01-1')],
    ['duplicate header',()=>xml().replace('<cbc:ID>FQ01-1</cbc:ID>','<cbc:ID>FQ01-1</cbc:ID><cbc:ID>FQ01-2</cbc:ID>')],
    ['unknown aggregate',()=>xml().replace('</Invoice>','<cac:PrepaidPayment/></Invoice>')],
    ['unknown leaf',()=>xml().replace('</Invoice>','<cbc:BuyerReference>HIDDEN</cbc:BuyerReference></Invoice>')],
    ['unknown attribute',()=>xml().replace('unitCode="GLL"','unitCode="GLL" hidden="true"')],
    ['currency amount',()=>xml().replace('currencyID="PEN"','currencyID="USD"')],
    ['negative amount',()=>xml().replace('>100.00<','>-100.00<')],
    ['excess precision',()=>xml().replace('>100.00<','>100.001<')],
    ['invalid date',()=>xml().replace('2026-10-04','2026-02-30')],
    ['unknown namespace',()=>xml().replace('schema:xsd:CommonBasicComponents-2','schema:xsd:CommonBasicComponents-3')],
    ['multiple roots',()=>xml()+xml()],
    ['signature wrapping',()=>xml().replace('</Invoice>','<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"/></Invoice>')],
    ['real issuer',()=>xml().replaceAll('00000000001','20615878481')],
  ] as const)('bloquea %s',(_name,make)=>expect(()=>readSyntheticBusinessXml(make(),EVIDENCE_POLICY)).toThrow());
  it.each(['PRODUCTION','REAL'])('no permite expandir el perfil a %s',value=>{
    expect(()=>readSyntheticBusinessXml(xml(),{environment:value,datasetClass:'SYNTHETIC'})).toThrow(/PROFILE_BLOCKED/);
    expect(()=>readSyntheticBusinessXml(xml(),{environment:'BETA',datasetClass:value})).toThrow(/PROFILE_BLOCKED/);
  });
  it('no sustituye evidencia faltante por aceptación o una firma declarada',()=>{
    const r=bindSyntheticBusinessXml(xml(),s());expect(r.signatureVerified).toBe(false);expect(r.ruleValidation).toBe('NOT_FISCAL_VALIDATION');expect(r.notRepresented).toContain('customer.email');
  });
  it('snapshot inválido sigue bloqueado sin debilitar el guard histórico',()=>{
    expect(()=>bindSyntheticBusinessXml(xml(),{...s(),environment:'PRODUCTION'})).toThrow(/HISTORY_PROFILE_BLOCKED/);
    expect(()=>validateHistoricalSnapshot({...s(),issuer:{...s().issuer,ruc:'20615878481'}})).toThrow();
  });
  it('línea gratuita conserva base referencial sin sumarla a ventas cobradas',()=>{
    const snap:any=structuredClone(s());snap.amounts.taxableAmount='0.00';snap.amounts.freeAmount='100.00';snap.amounts.igvAmount='0.00';snap.amounts.payableAmount='0.00';
    snap.items[0].amounts={...snap.amounts};snap.items[0].taxAffectationCode='11';snap.items[0].igvRate='0.00';snap.amountInWords=null;
    snap.tax=[{taxSchemeId:'9995',taxName:'GRA',taxableAmount:'100.00',taxAmount:'0.00'}];
    const r=bindSyntheticBusinessXml(buildBusinessEvidenceXml(snap),snap);expect(r.binding.match).toBe(true);expect(r.projection.amounts.payableAmount).toBe('0.00');
  });
  it('USD vincula moneda en todos los importes sin mezclarla con PEN',()=>{
    const snap:any=structuredClone(s());snap.currencyCode='USD';expect(bindSyntheticBusinessXml(buildBusinessEvidenceXml(snap),snap).binding.match).toBe(true);
  });
  it('getters o proxies en el perfil nunca se ejecutan',()=>{
    let calls=0;const p:any={datasetClass:'SYNTHETIC',get environment(){calls++;return 'BETA';}};
    expect(()=>readSyntheticBusinessXml(xml(),p)).toThrow(/PROFILE_BLOCKED/);expect(calls).toBe(0);
    expect(()=>readSyntheticBusinessXml(xml(),new Proxy(EVIDENCE_POLICY,{get(){calls++;return 'BETA';}}))).toThrow();expect(calls).toBe(0);
  });
  it('ISC se lee separado del IGV y los subtotales deben conciliar',()=>{
    const snap:any=structuredClone(s());snap.amounts.iscAmount='4.00';snap.amounts.payableAmount='122.00';snap.items[0].amounts={...snap.amounts};
    snap.tax.push({taxSchemeId:'2000',taxName:'ISC',taxableAmount:'100.00',taxAmount:'4.00'});
    const extra='<cac:TaxSubtotal><cbc:TaxableAmount currencyID="PEN">100.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="PEN">4.00</cbc:TaxAmount><cac:TaxCategory><cac:TaxScheme><cbc:ID>2000</cbc:ID><cbc:Name>ISC</cbc:Name><cbc:TaxTypeCode>EXC</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>';
    const text=xml().replaceAll('>118.00<','>122.00<').replace(/<cac:TaxTotal><cbc:TaxAmount currencyID="PEN">18.00<\/cbc:TaxAmount>/g,'<cac:TaxTotal><cbc:TaxAmount currencyID="PEN">22.00</cbc:TaxAmount>').replaceAll('</cac:TaxTotal>',extra+'</cac:TaxTotal>');
    expect(bindSyntheticBusinessXml(text,snap).binding.match).toBe(true);
  });
});
