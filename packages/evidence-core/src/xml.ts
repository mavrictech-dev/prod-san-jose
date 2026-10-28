import {DOMParser} from '@xmldom/xmldom';
import {createHash} from 'node:crypto';
import {AMOUNT_KEYS, historyJson, historicalSha256, validateHistoricalSnapshot, type HistoricalDocumentSnapshotV1} from '@factuez/history-core';
import {isProxy} from 'node:util/types';

export class EvidenceError extends Error {
  constructor(readonly code:string) { super(`Evidencia sintética: ${code}`); delete this.stack; }
}
export function evidenceAssert(ok:unknown,code:string):asserts ok {if(!ok)throw new EvidenceError(code);}
export const EVIDENCE_POLICY=Object.freeze({environment:'BETA',datasetClass:'SYNTHETIC',transmission:false,
  fiscalAuthority:false,officialTrust:false,accountingApproved:false,cutoverAuthorized:false,
  fiscalWrites:0,outboxWrites:0,countersChanged:false,productionBlocked:true,reviewRequired:true} as const);
export const UBL_CBC='urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
export const UBL_CAC='urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
const EXT='urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',DS='http://www.w3.org/2000/09/xmldsig#';
type El=NonNullable<ReturnType<DOMParser['parseFromString']>['documentElement']>;
const zero=():Record<typeof AMOUNT_KEYS[number],string>=>Object.fromEntries(AMOUNT_KEYS.map(k=>[k,'0.00'])) as Record<typeof AMOUNT_KEYS[number],string>;
const cents=(s:string)=>BigInt(s.replace('.',''));
const money=(n:bigint)=>`${n/100n}.${String(n%100n).padStart(2,'0')}`;
function decimal(s:string,scale=2) {
  evidenceAssert(new RegExp(`^(0|[1-9][0-9]{0,15})(\\.[0-9]{1,${scale}})?$`).test(s),'XML_DECIMAL');
  const [w,f='']=s.split('.');return `${w}.${f.padEnd(scale,'0')}`;
}
const day=(date:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Lima',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(date));
const time=(date:string)=>new Intl.DateTimeFormat('en-GB',{timeZone:'America/Lima',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(date));

/** Exact business projection, not XSD validation or universal UBL support. Unknown elements fail closed. */
export function readSyntheticBusinessXml(xml:string,profile:{environment:string;datasetClass:string}) {
  evidenceAssert(profile&&typeof profile==='object'&&!isProxy(profile)&&[Object.prototype,null].includes(Object.getPrototypeOf(profile)),'PROFILE_BLOCKED');
  const descriptors=Object.getOwnPropertyDescriptors(profile);evidenceAssert(Reflect.ownKeys(descriptors).every(k=>typeof k==='string'&&'value' in descriptors[k]),'PROFILE_BLOCKED');
  evidenceAssert(descriptors.environment?.value==='BETA'&&descriptors.datasetClass?.value==='SYNTHETIC','PROFILE_BLOCKED');
  evidenceAssert(typeof xml==='string'&&xml.length>0&&Buffer.byteLength(xml)<=1024*1024&&
    !/<!|<\?(?!xml\s)/i.test(xml)&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(xml),'XML_UNSAFE');
  let document:ReturnType<DOMParser['parseFromString']>;
  try{document=new DOMParser({onError:()=>{throw new EvidenceError('XML_MALFORMED');}}).parseFromString(xml,'application/xml');}
  catch{throw new EvidenceError('XML_MALFORMED');}
  const root=document.documentElement!;
  evidenceAssert(root&&['Invoice','CreditNote','DebitNote'].includes(root.localName??'')&&
    root.namespaceURI===`urn:oasis:names:specification:ubl:schema:xsd:${root.localName}-2`,'XML_ROOT');
  for(let n=document.firstChild;n;n=n.nextSibling)evidenceAssert(n===root||n.nodeType===7&&n.nodeName==='xml'||n.nodeType===3&&!n.nodeValue?.trim(),'XML_ROOT');
  const consumed=new Set<El>([root]),ids=new Set<string>(),pending=[{el:root,depth:1}];let elements=0;
  while(pending.length){const {el,depth}=pending.pop()!;evidenceAssert(++elements<=15000&&depth<=32,'XML_COMPLEXITY');
    evidenceAssert(el.attributes.length<=32,'XML_ATTRIBUTE_LIMIT');
    for(let i=0;i<el.attributes.length;i++){const a=el.attributes.item(i)!;
      if(['ID','Id','id'].includes(a.localName!)){evidenceAssert(a.value&&!ids.has(a.value),'XML_DUPLICATE_ID');ids.add(a.value);}
      evidenceAssert(el.namespaceURI===DS||a.namespaceURI==='http://www.w3.org/2000/xmlns/'||!a.namespaceURI&&
        ['ID','Id','id','currencyID','unitCode','schemeID','listID','languageLocaleID','schemeAgencyName','schemeName','schemeAgencyID','listAgencyName','listAgencyID','listName','listURI','unitCodeListID','unitCodeListAgencyName'].includes(a.localName!),'XML_ATTRIBUTE_UNSUPPORTED');
    }
    for(let n=el.firstChild;n;n=n.nextSibling){evidenceAssert(n.nodeType===1||n.nodeType===3,'XML_NODE_UNSUPPORTED');
      if(n.nodeType===1)pending.push({el:n as El,depth:depth+1});}
  }
  const children=(parent:El,ns:string,name:string)=>{const result:El[]=[];for(let n=parent.firstChild;n;n=n.nextSibling)
    if(n.nodeType===1&&(n as El).namespaceURI===ns&&(n as El).localName===name){consumed.add(n as El);result.push(n as El);}return result;};
  const one=(parent:El,ns:string,name:string,required=true)=>{const a=children(parent,ns,name);evidenceAssert(a.length<=1&&(!required||a.length===1),`XML_CARDINALITY_${name}`);return a[0]??null;};
  const aggregate=(parent:El,name:string,required=true)=>one(parent,UBL_CAC,name,required);
  const raw=(el:El)=>{evidenceAssert(!Array.from({length:el.childNodes.length},(_,i)=>el.childNodes.item(i)).some(n=>n?.nodeType===1),'XML_LEAF');
    const s=el.textContent??'';evidenceAssert(s===s.trim()&&s.length>0&&s.length<=2000,'XML_TEXT');return s;};
  const leaf=(parent:El,name:string,required=true)=>{const el=one(parent,UBL_CBC,name,required);return el?raw(el):null;};
  const all=(parent:El)=>{consumed.add(parent);for(let n=parent.firstChild;n;n=n.nextSibling)if(n.nodeType===1)all(n as El);};
  const extensions=one(root,EXT,'UBLExtensions')!,extension=one(extensions,EXT,'UBLExtension')!,content=one(extension,EXT,'ExtensionContent')!;
  const signatures=document.getElementsByTagNameNS(DS,'Signature');evidenceAssert(signatures.length<=1&&(!signatures.length||signatures[0].parentNode===content),'XML_SIGNATURE_LOCATION');
  for(let n=content.firstChild;n;n=n.nextSibling)evidenceAssert(n.nodeType===3&&!n.nodeValue?.trim()||n.nodeType===1&&n===signatures[0],'XML_EXTENSION_UNSUPPORTED');
  all(content); // Signature is evidence, never authority for this semantic reader.
  evidenceAssert(leaf(root,'UBLVersionID')==='2.1'&&leaf(root,'CustomizationID')==='2.0','XML_VERSION');
  const currencyCode=leaf(root,'DocumentCurrencyCode')!;evidenceAssert(/^(PEN|USD)$/.test(currencyCode),'XML_CURRENCY');
  const amount=(parent:El,name:string,scale=2,required=true)=>{const el=one(parent,UBL_CBC,name,required);if(!el)return null;
    evidenceAssert(el.getAttribute('currencyID')===currencyCode,'XML_AMOUNT_CURRENCY');return decimal(raw(el),scale);};
  const type=root.localName==='Invoice'?leaf(root,'InvoiceTypeCode')!:root.localName==='CreditNote'?'07':'08';
  evidenceAssert(['01','03','07','08'].includes(type),'XML_TYPE');
  const operationTypeCode=root.localName==='Invoice'?one(root,UBL_CBC,'InvoiceTypeCode')!.getAttribute('listID'):leaf(root,'ProfileID',false);
  evidenceAssert(operationTypeCode===null||/^\d{4}$/.test(operationTypeCode),'XML_OPERATION');
  const fullNumber=leaf(root,'ID')!,issueDate=leaf(root,'IssueDate')!,issueTime=leaf(root,'IssueTime',false);
  const calendar=new Date(issueDate+'T00:00:00Z');
  evidenceAssert(/^[FB][A-Z0-9]{3}-[1-9][0-9]{0,7}$/.test(fullNumber)&&/^\d{4}-\d{2}-\d{2}$/.test(issueDate)&&Number.isFinite(calendar.getTime())&&calendar.toISOString().slice(0,10)===issueDate,'XML_HEADER');
  evidenceAssert(issueTime===null||/^(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/.test(issueTime),'XML_TIME');
  function address(entity:El,required:boolean){const a=aggregate(entity,'RegistrationAddress',required);if(!a)return null;
    const line=aggregate(a,'AddressLine',required),country=aggregate(a,'Country',required);
    if(country)evidenceAssert(leaf(country,'IdentificationCode')==='PE','XML_COUNTRY');
    return {address:line?leaf(line,'Line')!:null,ubigeo:leaf(a,'ID',required),establishmentCode:leaf(a,'AddressTypeCode',required)};}
  function party(name:string,supplier:boolean){const p=aggregate(aggregate(root,name)!,'Party')!,identity=one(aggregate(p,'PartyIdentification')!,UBL_CBC,'ID')!,entity=aggregate(p,'PartyLegalEntity')!;
    const legalName=leaf(entity,'RegistrationName')!,addr=address(entity,supplier),nameEl=aggregate(p,'PartyName',false);
    return {identityType:identity.getAttribute('schemeID'),identityNumber:raw(identity),legalName,tradeName:nameEl?leaf(nameEl,'Name'):null,address:addr};}
  const supplier=party('AccountingSupplierParty',true),recipient=party('AccountingCustomerParty',false);
  evidenceAssert(supplier.identityType==='6'&&/^00000000[0-9]{3}$/.test(supplier.identityNumber),'REAL_ISSUER_BLOCKED');
  const issuer={ruc:supplier.identityNumber,legalName:supplier.legalName,tradeName:supplier.tradeName,address:supplier.address!.address!,ubigeo:supplier.address!.ubigeo!,establishmentCode:supplier.address!.establishmentCode!};
  const customer={identityType:recipient.identityType,identityNumber:recipient.identityNumber,legalName:recipient.legalName,address:recipient.address?.address??null};
  const descriptor=aggregate(root,'Signature',false);
  if(descriptor){const id=leaf(descriptor,'ID')!,p=aggregate(descriptor,'SignatoryParty')!,i=aggregate(p,'PartyIdentification')!,n=aggregate(p,'PartyName')!;
    evidenceAssert(leaf(i,'ID')===issuer.ruc&&leaf(n,'Name')===issuer.legalName&&leaf(aggregate(aggregate(descriptor,'DigitalSignatureAttachment')!,'ExternalReference')!,'URI')===`#${id}`,'XML_SIGNATURE_DESCRIPTOR');}
  function taxes(parent:El,line:boolean){const results:Array<{taxSchemeId:string;taxName:string;taxableAmount:string;taxAmount:string;rate:string|null;affectation:string|null}>=[];
    const totals=children(parent,UBL_CAC,'TaxTotal');evidenceAssert(totals.length>0&&totals.length<=8,'XML_TAX_TOTAL_REQUIRED');
    for(const total of totals){const taxAmount=amount(total,'TaxAmount')!,subs=children(total,UBL_CAC,'TaxSubtotal');
      evidenceAssert(subs.length>0&&subs.length<=8,'XML_TAX_SUBTOTAL_REQUIRED');let sum=0n;
      for(const sub of subs){const taxableAmount=amount(sub,'TaxableAmount')!,tax=amount(sub,'TaxAmount')!,cat=aggregate(sub,'TaxCategory')!,scheme=aggregate(cat,'TaxScheme')!;
        const taxSchemeId=leaf(scheme,'ID')!,taxName=leaf(scheme,'Name')!,taxType=leaf(scheme,'TaxTypeCode')!;
        evidenceAssert(/^(1000|2000|9995|9997|9998|9999)$/.test(taxSchemeId)&&/^(VAT|EXC|FRE|OTH)$/.test(taxType),'XML_TAX_SCHEME_UNSUPPORTED');
        const rate=leaf(cat,'Percent',line&&['1000','9995','9997','9998'].includes(taxSchemeId)),affectation=leaf(cat,'TaxExemptionReasonCode',line&&['1000','9995','9997','9998'].includes(taxSchemeId));
        results.push({taxSchemeId,taxName,taxableAmount,taxAmount:tax,rate:rate===null?null:decimal(rate),affectation});sum+=cents(tax);}
      evidenceAssert(sum===cents(taxAmount),'XML_TAX_TOTAL_MISMATCH');}
    evidenceAssert(new Set(results.map(t=>t.taxSchemeId)).size===results.length,'XML_DUPLICATE_TAX');return results.sort((a,b)=>a.taxSchemeId.localeCompare(b.taxSchemeId));}
  const lineTag=type==='07'?'CreditNoteLine':type==='08'?'DebitNoteLine':'InvoiceLine',quantityTag=type==='07'?'CreditedQuantity':type==='08'?'DebitedQuantity':'InvoicedQuantity';
  const lineElements=children(root,UBL_CAC,lineTag);evidenceAssert(lineElements.length>0&&lineElements.length<=100,'XML_ITEM_LIMIT');
  const items=lineElements.map((line,index)=>{evidenceAssert(leaf(line,'ID')===String(index+1),'XML_LINE_ORDER');
    const q=one(line,UBL_CBC,quantityTag)!,quantity=decimal(raw(q),6),unitCode=q.getAttribute('unitCode')??'';evidenceAssert(cents(quantity)>0n&&/^[A-Z0-9]{2,3}$/.test(unitCode),'XML_QUANTITY');
    const lineExtension=amount(line,'LineExtensionAmount')!,price=aggregate(line,'Price')!,unitValue=amount(price,'PriceAmount',6)!;
    const alt=aggregate(aggregate(line,'PricingReference')!,'AlternativeConditionPrice')!,unitPriceWithTax=amount(alt,'PriceAmount',6)!,priceType=leaf(alt,'PriceTypeCode')!;
    evidenceAssert(['01','02'].includes(priceType),'XML_PRICE_TYPE');
    const tax=taxes(line,true),igv=tax.find(t=>['1000','9995','9997','9998'].includes(t.taxSchemeId));evidenceAssert(igv&&igv.affectation&&/^\d{2}$/.test(igv.affectation),'XML_AFFECTATION');
    const amounts=zero();for(const t of tax){if(t.taxSchemeId==='1000'){amounts.taxableAmount=t.taxableAmount;amounts.igvAmount=t.taxAmount;}
      else if(t.taxSchemeId==='9995'){amounts.freeAmount=t.taxableAmount;amounts.igvAmount=t.taxAmount;}
      else if(t.taxSchemeId==='9997')amounts.exemptAmount=t.taxableAmount;
      else if(t.taxSchemeId==='9998')amounts.unaffectedAmount=t.taxableAmount;
      else if(t.taxSchemeId==='2000')amounts.iscAmount=t.taxAmount;else amounts.otherTaxesAmount=t.taxAmount;}
    evidenceAssert(cents(lineExtension)===cents(amounts.taxableAmount)+cents(amounts.exemptAmount)+cents(amounts.unaffectedAmount),'XML_LINE_BASE_MISMATCH');
    const allowances=children(line,UBL_CAC,'AllowanceCharge');evidenceAssert(allowances.length<=8,'XML_DISCOUNT_LIMIT');let discounts=0n;
    for(const a of allowances){evidenceAssert(leaf(a,'ChargeIndicator')==='false','XML_CHARGE_UNSUPPORTED');leaf(a,'AllowanceChargeReasonCode');
      const factor=leaf(a,'MultiplierFactorNumeric',false);if(factor!==null)decimal(factor,6);amount(a,'BaseAmount',2,false);discounts+=cents(amount(a,'Amount')!);}
    amounts.discountTotal=money(discounts);amounts.payableAmount=money(cents(lineExtension)+cents(amounts.igvAmount)+cents(amounts.iscAmount)+cents(amounts.otherTaxesAmount));
    const item=aggregate(line,'Item')!,product=aggregate(item,'SellersItemIdentification',false);
    return {lineNumber:index+1,productCode:product?leaf(product,'ID'):null,description:leaf(item,'Description')!,unitCode,quantity,unitValue,unitPriceWithTax,
      taxAffectationCode:igv.affectation,igvRate:igv.rate!,amounts};});
  const tax=taxes(root,false).map(({rate,affectation,...t})=>t),amounts=zero();
  for(const k of AMOUNT_KEYS)amounts[k]=money(items.reduce((n,l)=>n+cents(l.amounts[k]),0n));
  const headerTax=new Map(tax.map(t=>[t.taxSchemeId,t]));const byLine=new Map<string,{base:bigint;tax:bigint;name:string}>();
  for(const line of lineElements)for(const t of taxes(line,true)){const acc=byLine.get(t.taxSchemeId)??{base:0n,tax:0n,name:t.taxName};evidenceAssert(acc.name===t.taxName,'XML_TAX_NAME_MISMATCH');acc.base+=cents(t.taxableAmount);acc.tax+=cents(t.taxAmount);byLine.set(t.taxSchemeId,acc);}
  evidenceAssert(byLine.size===headerTax.size&&[...byLine].every(([id,a])=>headerTax.get(id)?.taxableAmount===money(a.base)&&headerTax.get(id)?.taxAmount===money(a.tax)&&headerTax.get(id)?.taxName===a.name),'XML_HEADER_TAX_MISMATCH');
  const monetary=aggregate(root,type==='08'?'RequestedMonetaryTotal':'LegalMonetaryTotal')!;
  evidenceAssert(amount(monetary,'LineExtensionAmount')===money(cents(amounts.taxableAmount)+cents(amounts.exemptAmount)+cents(amounts.unaffectedAmount))&&amount(monetary,'PayableAmount')===amounts.payableAmount,'XML_MONETARY_MISMATCH');
  const inclusive=amount(monetary,'TaxInclusiveAmount',2,false),discount=amount(monetary,'AllowanceTotalAmount',2,false);
  evidenceAssert(inclusive===null||inclusive===amounts.payableAmount,'XML_MONETARY_MISMATCH');evidenceAssert(discount===null||discount===amounts.discountTotal,'XML_MONETARY_MISMATCH');
  const terms=children(root,UBL_CAC,'PaymentTerms');let paymentTerms:HistoricalDocumentSnapshotV1['paymentTerms']|null=null;
  if(terms.length){evidenceAssert(terms.length<=101&&leaf(terms[0],'ID')==='FormaPago','XML_PAYMENT');const mode=leaf(terms[0],'PaymentMeansID')!;
    if(mode==='Contado'){evidenceAssert(terms.length===1,'XML_PAYMENT');paymentTerms={type:'CONTADO'};}
    else {evidenceAssert(mode==='Credito'&&type==='01'&&terms.length>1,'XML_PAYMENT');const pendingAmount=amount(terms[0],'Amount')!;
      const installments=terms.slice(1).map((p,i)=>{evidenceAssert(leaf(p,'ID')==='FormaPago'&&leaf(p,'PaymentMeansID')===`Cuota${String(i+1).padStart(3,'0')}`,'XML_PAYMENT');
        return {amount:amount(p,'Amount')!,dueDate:leaf(p,'PaymentDueDate')!};});paymentTerms={type:'CREDITO',currencyCode,pendingAmount,installments};}}
  let reference:HistoricalDocumentSnapshotV1['reference']=null;
  if(['07','08'].includes(type)){const discrepancy=aggregate(root,'DiscrepancyResponse')!,ref=aggregate(aggregate(root,'BillingReference')!,'InvoiceDocumentReference')!;
    const refNumber=leaf(ref,'ID')!,refType=leaf(ref,'DocumentTypeCode')!;evidenceAssert(/^[FB][A-Z0-9]{3}-[1-9][0-9]{0,7}$/.test(refNumber)&&['01','03'].includes(refType)&&leaf(discrepancy,'ReferenceID')===refNumber,'XML_REFERENCE');
    const [series,number]=refNumber.split('-');reference={issuerRuc:issuer.ruc,documentTypeCode:refType as '01'|'03',series,number,reasonCode:leaf(discrepancy,'ResponseCode')!,reason:leaf(discrepancy,'Description')!};}
  const notes=children(root,UBL_CBC,'Note');evidenceAssert(notes.length<=2,'XML_NOTE_LIMIT');let amountInWords:string|null=null,observations:string|null=null;
  for(const note of notes){const code=note.getAttribute('languageLocaleID')??'';evidenceAssert(['1000','2000',''].includes(code),'XML_NOTE_UNSUPPORTED');
    if(code==='1000'){evidenceAssert(amountInWords===null,'XML_DUPLICATE_NOTE');amountInWords=raw(note);}else{evidenceAssert(observations===null,'XML_DUPLICATE_NOTE');observations=raw(note);}}
  // Nothing silently disappears: new aggregates require a versioned mapping, not an ignore flag.
  for(const el of Array.from({length:document.getElementsByTagName('*').length},(_,i)=>document.getElementsByTagName('*').item(i)!))
    evidenceAssert(consumed.has(el),'XML_ELEMENT_UNSUPPORTED');
  const projection={header:{fullNumber,issueDate,issueTime,currencyCode,documentTypeCode:type,operationTypeCode},issuer,customer,items,tax,amounts,paymentTerms,reference,amountInWords,observations};
  return {schemaVersion:'factuez.xml-business-evidence.v1' as const,...EVIDENCE_POLICY,projection,
    rawSha256:createHash('sha256').update(xml).digest('hex'),semanticSha256:historicalSha256(projection),
    signaturePresent:signatures.length===1,signatureVerified:false as const,
    notRepresented:['ownership','originId','sourceDocumentId','customer.email','vehiclePlate','sourceEvidence','artifacts',
      ...(issueTime===null?['issueTime']:[]),...(operationTypeCode===null?['operationTypeCode']:[])],
    ruleValidation:'NOT_FISCAL_VALIDATION' as const};
}
export type BusinessXmlEvidence=ReturnType<typeof readSyntheticBusinessXml>;
export type EvidenceDifference={path:string;expected:unknown;observed:unknown};
export function compareEvidenceValues(expected:unknown,observed:unknown) {
  expected=historyJson(expected);observed=historyJson(observed);
  const differences:EvidenceDifference[]=[];let differenceCount=0;
  function visit(a:any,b:any,path:string){if(a===b)return;
    if(a!==null&&b!==null&&typeof a==='object'&&typeof b==='object'&&Array.isArray(a)===Array.isArray(b)){
      for(const k of [...new Set([...Object.keys(a),...Object.keys(b)])].sort())visit(a[k]??null,b[k]??null,`${path}.${k}`);return;}
    differenceCount++;if(differences.length<200)differences.push({path,expected:a??null,observed:b??null});}
  visit(expected,observed,'business');return {match:differenceCount===0,differenceCount,differences,differencesTruncated:differenceCount>differences.length};
}
export function bindSyntheticBusinessXml(xml:string,snapshotInput:unknown) {
  const snapshot=validateHistoricalSnapshot(snapshotInput),evidence=readSyntheticBusinessXml(xml,EVIDENCE_POLICY),{email,...customer}=snapshot.customer;
  const expected={header:{fullNumber:`${snapshot.ownership.series}-${snapshot.number}`,issueDate:day(snapshot.issueDate),
    issueTime:evidence.projection.header.issueTime===null?null:time(snapshot.issueDate),currencyCode:snapshot.currencyCode,
    documentTypeCode:snapshot.ownership.documentTypeCode,operationTypeCode:evidence.projection.header.operationTypeCode===null?null:snapshot.operationTypeCode},
    issuer:snapshot.issuer,customer,items:snapshot.items,tax:snapshot.tax,amounts:snapshot.amounts,paymentTerms:snapshot.paymentTerms,
    reference:snapshot.reference,amountInWords:snapshot.amountInWords,observations:snapshot.observations};
  return {...evidence,binding:compareEvidenceValues(expected,evidence.projection),snapshotSha256:historicalSha256(snapshot)};
}
export function compareSyntheticBusinessXml(left:string,right:string) {
  const a=readSyntheticBusinessXml(left,EVIDENCE_POLICY),b=readSyntheticBusinessXml(right,EVIDENCE_POLICY);
  return {schemaVersion:'factuez.xml-business-comparison.v1' as const,...EVIDENCE_POLICY,
    leftSha256:a.rawSha256,rightSha256:b.rawSha256,...compareEvidenceValues(a.projection,b.projection)};
}
