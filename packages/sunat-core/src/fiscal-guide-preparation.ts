import {createHash} from 'node:crypto';
import {boundedSupplementJson} from './fiscal-supplement-command';
import {fiscalDate,fiscalDecimal,fiscalLimaDate,fiscalRuc,fiscalSnapshotSha256,fiscalTimestamp} from './fiscal-note';

/** Independently versioned PREPARATION profile, not the QA GRE emitter or a fiscal
 * producer. No numbering, signing, transport, PKI or SUNAT acceptance is implied.
 * Base mapping: SUNAT Anexo VII RS123-2022 and AnexoIII RS240-2024. The GRE
 * portal advertises rules 25.09.2026/XSL 01.10.2026; those complete rule packages
 * have NOT been loaded or executed by this preparation profile. */
export const GUIDE09_PREPARATION_PROFILE='FACTUEZ-BETA-GRE09-PRIVATE04-PREPARATION-v1';
export const GUIDE_PREPARATION_SOURCES=Object.freeze({
  portal:'https://cpe.sunat.gob.pe/node/116',
  base:'https://www.sunat.gob.pe/legislacion/superin/2022/anexo-123-2022.pdf',
  amendment:'https://www.sunat.gob.pe/legislacion/superin/2024/anexo3-000240-2024.pdf',
  rules:'https://cpe.sunat.gob.pe/sites/default/files/2026-09/Reglas%20de%20validaci%C3%B3n%20publicado%20al%2025.09.2026.xlsx',
  xsl:'https://cpe.sunat.gob.pe/sites/default/files/2026-10/Archivos_XSL.10.zip',
});
type Party={ruc:string;legalName:string};
type Location={ubigeo:string;address:string;establishmentCode:string};
export type Guide09PreparationBody={issueDate:string;transferDate:string;reasonCode:'04';origin:Location;destination:Location;
  sender:Party;recipient:Party;grossWeight:string;weightUnit:'KGM'|'TNE';
  transport:{mode:'02';vehicle:{plate:string;registration:string};driver:{identityType:'1'|'4';identityNumber:string;firstName:string;lastName:string;license:string}};
  items:{code:string;description:string;quantity:string;unitCode:string}[];references:[];regulatedGoods:false};
export type Guide09PreparationInput={schemaVersion:'factuez.guide09-preparation-input.v1';draftId:string;draftRevision:string;draftBodySha256:string;issuer:Party;body:Guide09PreparationBody};
const FLAGS={candidateOnly:true as const,fiscalExecutionEnabled:false as const,transmissionAuthorized:false as const,authorizedForTransfer:false as const,numberReserved:false as const,
  signatureVerified:false as const,officialRulesValidated:false as const,referenceVerification:'NOT_VERIFIED' as const};
export type Guide09PreparationPlan=Guide09PreparationInput&typeof FLAGS&{profile:typeof GUIDE09_PREPARATION_PROFILE;planSha256:string};
export class GuidePreparationError extends Error{constructor(readonly code:string){super(code);}}
const bad=(code:string):never=>{throw new GuidePreparationError(code);};
function object(v:unknown,keys:string[]):asserts v is Record<string,any>{
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==[...keys].sort().join(','))bad('INVALID_GUIDE_PREPARATION');
}
function pattern(v:unknown,re:RegExp):asserts v is string{if(typeof v!=='string'||!re.test(v))bad('INVALID_GUIDE_PREPARATION');}
function text(v:unknown,max:number):asserts v is string{
  if(typeof v!=='string'||!v||v!==v.trim()||v.length>max||/[\x00-\x1f\x7f-\x9f\ud800-\udfff\ufffe\uffff]/u.test(v))bad('INVALID_GUIDE_PREPARATION');
}
function party(v:unknown):asserts v is Party{object(v,['ruc','legalName']);fiscalRuc(v.ruc,'party.ruc');text(v.legalName,200);}
function location(v:unknown):asserts v is Location{object(v,['ubigeo','address','establishmentCode']);pattern(v.ubigeo,/^[0-9]{6}$/);pattern(v.establishmentCode,/^[0-9]{4}$/);text(v.address,300);}
/** Caller supplies the issuer from its owner, never from an HTTP body's claim.
 * This pure function only checks consistency; it cannot authenticate that owner. */
export function prepareGuide09(input:unknown):Guide09PreparationPlan{
  try{
    const v=boundedSupplementJson(input) as Guide09PreparationInput;
    object(v,['schemaVersion','draftId','draftRevision','draftBodySha256','issuer','body']);
    if(v.schemaVersion!=='factuez.guide09-preparation-input.v1')bad('INVALID_GUIDE_PREPARATION');
    pattern(v.draftId,/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    pattern(v.draftRevision,/^"v[1-9][0-9]{0,8}"$/);pattern(v.draftBodySha256,/^[a-f0-9]{64}$/);party(v.issuer);
    const b=v.body;object(b,['issueDate','transferDate','reasonCode','origin','destination','sender','recipient','grossWeight','weightUnit','transport','items','references','regulatedGoods']);
    if(fiscalSnapshotSha256(b)!==v.draftBodySha256)bad('GUIDE_PREPARATION_BODY_MISMATCH');
    if(b.reasonCode!=='04'||b.regulatedGoods!==false||!Array.isArray(b.references)||b.references.length)bad('GUIDE_PREPARATION_PROFILE_NOT_ENABLED');
    fiscalTimestamp(b.issueDate,'issueDate');fiscalDate(b.transferDate,'transferDate');
    if(new Date(b.issueDate).toISOString()!==b.issueDate||b.transferDate<fiscalLimaDate(b.issueDate))bad('INVALID_GUIDE_PREPARATION');
    party(b.sender);party(b.recipient);location(b.origin);location(b.destination);
    if([b.sender,b.recipient].some(p=>p.ruc!==v.issuer.ruc||p.legalName!==v.issuer.legalName))bad('GUIDE_PREPARATION_ISSUER_MISMATCH');
    if(b.origin.establishmentCode===b.destination.establishmentCode||b.origin.ubigeo===b.destination.ubigeo&&b.origin.address===b.destination.address)bad('GUIDE_PREPARATION_SAME_ESTABLISHMENT');
    fiscalDecimal(b.grossWeight,3,true,'grossWeight');if(!['KGM','TNE'].includes(b.weightUnit))bad('INVALID_GUIDE_PREPARATION');
    const t=b.transport;object(t,['mode','vehicle','driver']);if(t.mode!=='02')bad('GUIDE_PREPARATION_PROFILE_NOT_ENABLED');
    object(t.vehicle,['plate','registration']);pattern(t.vehicle.plate,/^[A-Z0-9]{6,8}$/);pattern(t.vehicle.registration,/^[A-Z0-9]{1,15}$/);
    object(t.driver,['identityType','identityNumber','firstName','lastName','license']);
    if(!['1','4'].includes(t.driver.identityType))bad('INVALID_GUIDE_PREPARATION');
    pattern(t.driver.identityNumber,t.driver.identityType==='1'?/^[0-9]{8}$/:/^[A-Z0-9]{1,12}$/);
    text(t.driver.firstName,100);text(t.driver.lastName,100);pattern(t.driver.license,/^[A-Z0-9]{1,10}$/);
    if(!Array.isArray(b.items)||!b.items.length||b.items.length>100)bad('INVALID_GUIDE_PREPARATION');
    const seen=new Set<string>();for(const item of b.items){object(item,['code','description','quantity','unitCode']);text(item.code,40);text(item.description,250);
      fiscalDecimal(item.quantity,6,true,'quantity');pattern(item.unitCode,/^[A-Z0-9]{2,3}$/);if(seen.has(item.code))bad('INVALID_GUIDE_PREPARATION');seen.add(item.code);}
    const unsigned={...v,profile:GUIDE09_PREPARATION_PROFILE as typeof GUIDE09_PREPARATION_PROFILE,...FLAGS};return{...unsigned,planSha256:fiscalSnapshotSha256(unsigned)};
  }catch(e){if(e instanceof GuidePreparationError)throw e;return bad('INVALID_GUIDE_PREPARATION');}
}
export function validateGuide09Plan(value:unknown):Guide09PreparationPlan{
  try{
    const p=boundedSupplementJson(value) as Guide09PreparationPlan;
    object(p,['schemaVersion','draftId','draftRevision','draftBodySha256','issuer','body','profile','planSha256',...Object.keys(FLAGS)]);
    const {profile,planSha256,...rest}=p,raw=Object.fromEntries(Object.entries(rest).filter(([key])=>!Object.hasOwn(FLAGS,key)));
    const rebuilt=prepareGuide09(raw);if(fiscalSnapshotSha256(p)!==fiscalSnapshotSha256(rebuilt))bad('GUIDE_PREPARATION_PLAN_MISMATCH');return rebuilt;
  }catch{return bad('GUIDE_PREPARATION_PLAN_MISMATCH');}
}
const esc=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const ID='schemeName="Documento de Identidad" schemeAgencyName="PE:SUNAT" schemeURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo06"';
/** Isolated XML PREVIEW only. The proposed identity is not allocated or reserved.
 * Never pass this output to the official adapter: its visible LOCAL marker is
 * intentional. A future producer needs its own numbered, trusted envelope. */
export function renderGuide09PreparationXml(value:unknown,proposal:unknown){
  const p=validateGuide09Plan(value),n=boundedSupplementJson(proposal);object(n,['series','number']);
  pattern(n.series,/^T[A-Z0-9]{3}$/);pattern(n.number,/^[1-9][0-9]{0,7}$/);
  const b=p.body,t=b.transport,d=t.driver,party=(v:Party)=>`<cac:Party><cac:PartyIdentification><cbc:ID schemeID="6" ${ID}>${v.ruc}</cbc:ID></cac:PartyIdentification><cac:PartyLegalEntity><cbc:RegistrationName>${esc(v.legalName)}</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party>`;
  const address=(a:Location)=>`<cbc:ID schemeAgencyName="PE:INEI" schemeName="Ubigeos">${a.ubigeo}</cbc:ID><cbc:AddressTypeCode listID="${p.issuer.ruc}" listAgencyName="PE:SUNAT" listName="Establecimientos anexos">${a.establishmentCode}</cbc:AddressTypeCode><cac:AddressLine><cbc:Line>${esc(a.address)}</cbc:Line></cac:AddressLine>`;
  const local=new Date(Date.parse(b.issueDate)-5*60*60*1000).toISOString(),fullNumber=`${n.series}-${n.number}`;
  const xml=`<?xml version="1.0" encoding="UTF-8"?><DespatchAdvice xmlns="urn:oasis:names:specification:ubl:schema:xsd:DespatchAdvice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"><cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:CustomizationID>2.0</cbc:CustomizationID><cbc:ID>${fullNumber}</cbc:ID><cbc:IssueDate>${local.slice(0,10)}</cbc:IssueDate><cbc:IssueTime>${local.slice(11,19)}</cbc:IssueTime><cbc:DespatchAdviceTypeCode listAgencyName="PE:SUNAT" listName="Tipo de Documento" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo01">09</cbc:DespatchAdviceTypeCode><cbc:Note>PRUEBA LOCAL - PREPARACION SIN FIRMA - SIN VALIDEZ TRIBUTARIA - NO AUTORIZA TRASLADO</cbc:Note><cac:DespatchSupplierParty>${party(p.issuer)}</cac:DespatchSupplierParty><cac:DeliveryCustomerParty>${party(b.recipient)}</cac:DeliveryCustomerParty><cac:Shipment><cbc:ID>SUNAT_Envio</cbc:ID><cbc:HandlingCode listAgencyName="PE:SUNAT" listName="Motivo de traslado" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo20">04</cbc:HandlingCode><cbc:HandlingInstructions>Traslado entre establecimientos de la misma empresa</cbc:HandlingInstructions><cbc:GrossWeightMeasure unitCode="${b.weightUnit}">${b.grossWeight}</cbc:GrossWeightMeasure><cac:ShipmentStage><cbc:TransportModeCode listAgencyName="PE:SUNAT" listName="Modalidad de traslado" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo18">02</cbc:TransportModeCode><cac:TransitPeriod><cbc:StartDate>${b.transferDate}</cbc:StartDate></cac:TransitPeriod><cac:DriverPerson><cbc:ID schemeID="${d.identityType}" ${ID}>${d.identityNumber}</cbc:ID><cbc:FirstName>${esc(d.firstName)}</cbc:FirstName><cbc:FamilyName>${esc(d.lastName)}</cbc:FamilyName><cbc:JobTitle>Principal</cbc:JobTitle><cac:IdentityDocumentReference><cbc:ID>${d.license}</cbc:ID></cac:IdentityDocumentReference></cac:DriverPerson></cac:ShipmentStage><cac:Delivery><cac:DeliveryAddress>${address(b.destination)}</cac:DeliveryAddress><cac:Despatch><cac:DespatchAddress>${address(b.origin)}</cac:DespatchAddress></cac:Despatch></cac:Delivery><cac:TransportHandlingUnit><cac:TransportEquipment><cbc:ID>${t.vehicle.plate}</cbc:ID><cac:ApplicableTransportMeans><cbc:RegistrationNationalityID>${t.vehicle.registration}</cbc:RegistrationNationalityID></cac:ApplicableTransportMeans></cac:TransportEquipment></cac:TransportHandlingUnit></cac:Shipment>${b.items.map((item,i)=>`<cac:DespatchLine><cbc:ID>${i+1}</cbc:ID><cbc:DeliveredQuantity unitCode="${item.unitCode}" unitCodeListID="UN/ECE rec 20" unitCodeListAgencyName="United Nations Economic Commission for Europe">${item.quantity}</cbc:DeliveredQuantity><cac:OrderLineReference><cbc:LineID>${i+1}</cbc:LineID></cac:OrderLineReference><cac:Item><cbc:Description>${esc(item.description)}</cbc:Description><cac:SellersItemIdentification><cbc:ID>${esc(item.code)}</cbc:ID></cac:SellersItemIdentification></cac:Item></cac:DespatchLine>`).join('')}</DespatchAdvice>`;
  return{xml,xmlSha256:createHash('sha256').update(xml,'utf8').digest('hex'),proposedFullNumber:fullNumber,planSha256:p.planSha256,...FLAGS};
}
