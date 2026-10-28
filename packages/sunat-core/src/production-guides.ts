import { createHash, sign, verify, type KeyObject } from 'node:crypto';
import type { ProductionGuidesSnapshot as Snapshot, ProductionGuidesReference09, ProductionGuidesSeal, ProductionGuidesSigner, ProductionGuidesVerifier } from '@factuez/contracts/production-guides';
import { boundedSupplementJson } from './fiscal-supplement-command';
import { fiscalRuc, fiscalSnapshotSha256 as hash, fiscalTimestamp, fiscalXml as esc } from './fiscal-note';
import { validateNumberedGuideInput, NUMBERED_GUIDE_INPUT_SCHEMA_VERSION } from './numbered-guide-profile';
import { validateCarrierGuideInput, CARRIER_GUIDE_INPUT_SCHEMA_VERSION } from './carrier-guide-profile';
import { validatePublicGuide09OwnerSnapshot } from './public-guide-profile';
export const productionGuidesHash = hash;
export const productionGuidesBytesHash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
export const PRODUCTION_GUIDES_XSD_SHA256 = '5cac9d9353521340fbc15d23f465a4946b004535b9ff411541c87da01694dbd5';
export const PRODUCTION_GUIDES_SOURCES = Object.freeze({
 reception: 'https://www.sunat.gob.pe/legislacion/superin/2022/anexo-123-2022.pdf',
 portal: 'https://cpe.sunat.gob.pe/node/116',
 oauth: 'https://cpe.sunat.gob.pe/sites/default/files/inline-files/Manual_Servicios_GRE%20(1)_0.pdf',
 urls: 'https://cpe.sunat.gob.pe/sites/default/files/inline-files/Manual%20URL%20%E2%80%93%20GRE.xlsx',
});
export function productionGuidesExact(v: unknown, keys: string[]): asserts v is Record<string, any> {
 if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== [...keys].sort().join(',')) throw Error('GRE_INVALID_FIELDS');
}
export function productionGuidesUuid(v: unknown): asserts v is string {
 if (typeof v !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v)) throw Error('GRE_INVALID_UUID');
}
/** Separate production envelope and UBL renderer; existing pure validators retain their limited profiles. */
export function validateProductionGuidesSnapshot(raw: unknown): Snapshot {
 const s = boundedSupplementJson(raw) as Snapshot;
 productionGuidesExact(s,['schemaVersion','documentId','operationId','actorId','scope','issuer','documentType','profile','series','number','body','grantVersion','createdAt','environment']);
 productionGuidesExact(s.scope,['companyId','issuerRuc','branchId','pointId','seriesCounterId','establishmentCode']);
 if (s.schemaVersion !== 'factuez.production-guides.v1' || s.environment !== 'PRODUCTION' || !Number.isSafeInteger(s.grantVersion) || s.grantVersion < 1 || !Number.isSafeInteger(s.scope.companyId) || s.scope.companyId < 1) throw Error('GRE_INVALID_OWNER');
 for (const v of [s.documentId,s.operationId,s.actorId,s.scope.branchId,s.scope.pointId,s.scope.seriesCounterId]) productionGuidesUuid(v);
 fiscalRuc(s.scope.issuerRuc,'issuerRuc'); fiscalTimestamp(s.createdAt,'createdAt');
 if (s.issuer.ruc !== s.scope.issuerRuc || !/^[0-9]{4}$/.test(s.scope.establishmentCode)) throw Error('GRE_OWNER_MISMATCH');
 const common = {documentId:s.documentId,operationId:s.operationId,issuer:s.issuer,series:s.series,number:s.number,body:s.body};
 if (s.profile === 'GRE09_PRIVATE04_V1' && s.documentType === '09') {
  const v=validateNumberedGuideInput({...common,schemaVersion:NUMBERED_GUIDE_INPUT_SCHEMA_VERSION,documentType:'09',snapshotSha256:hash(s)});
  if (v.body.origin.establishmentCode !== s.scope.establishmentCode) throw Error('GRE_ESTABLISHMENT_MISMATCH');
  s.body=v.body;
 } else if (s.profile === 'GRE09_PUBLIC01_V1' && s.documentType === '09') {
  s.body=validatePublicGuide09OwnerSnapshot({...common,schemaVersion:'factuez.public-guide09-issued-owner.v1',companyId:s.scope.companyId,branchId:s.scope.branchId}).body;
 } else if (s.profile === 'GRE31_PUBLIC_SINGLE09_V1' && s.documentType === '31') {
  s.body=validateCarrierGuideInput({...common,schemaVersion:CARRIER_GUIDE_INPUT_SCHEMA_VERSION,companyId:s.scope.companyId,branchId:s.scope.branchId,documentType:'31',snapshotSha256:hash(s)}).body;
 } else throw Error('GRE_PROFILE_UNSUPPORTED');
 return s;
}
/** Production reference comes only from a protected owner/evidence adapter. BETA evidence is never projected as production. */
export function assertProductionGuidesReference(s: Snapshot, ref: ProductionGuidesReference09) {
 const r=validateProductionGuidesSnapshot(ref.snapshot), b=s.body as any, p=ref.projection as any;
 if (s.documentType !== '31' || r.documentType !== '09' || r.profile !== 'GRE09_PUBLIC01_V1' || ref.source !== 'SUNAT_OFFICIAL' || ref.signatureTrusted !== true || !['ACCEPTED','ACCEPTED_WITH_OBSERVATIONS'].includes(ref.state) || !/^[a-f0-9]{64}$/.test(ref.cdrZipSha256) || hash(p) !== ref.projectionSha256) throw Error('GRE_REFERENCE_UNTRUSTED');
 fiscalTimestamp(ref.acceptedAt,'acceptedAt');
 const rb=r.body as any;
 const expected={schemaVersion:'factuez.carrier-reference09-owner.v1',documentId:r.documentId,documentType:'09',issuer:r.issuer,series:r.series,number:r.number,
  ...Object.fromEntries(['issueDate','transferDate','sender','recipient','origin','destination','carrier','grossWeight','weightUnit','items','transportMode','regulatedGoods'].map(k=>[k,rb[k]]))};
 if (hash(expected)!==ref.projectionSha256 || b.reference09.documentId!==r.documentId || b.reference09.issuerRuc!==r.issuer.ruc || b.reference09.series!==r.series || b.reference09.number!==r.number || b.reference09.snapshotSha256!==ref.projectionSha256 || hash(p.carrier)!==hash(s.issuer) || Date.parse(ref.acceptedAt)>Date.parse(b.issueDate) || Date.parse(ref.acceptedAt)<Date.parse(rb.issueDate)) throw Error('GRE_REFERENCE_MISMATCH');
 for (const k of ['sender','recipient','origin','destination','transferDate','grossWeight','weightUnit','items']) if(hash(p[k])!==hash(b[k]))throw Error('GRE_REFERENCE_MISMATCH');
}
const ATTR='schemeName="Documento de Identidad" schemeAgencyName="PE:SUNAT" schemeURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo06"';
const id=(r:string)=>`<cac:PartyIdentification><cbc:ID schemeID="6" ${ATTR}>${r}</cbc:ID></cac:PartyIdentification>`;
const party=(p:any)=>`${id(p.ruc)}<cac:PartyLegalEntity><cbc:RegistrationName>${esc(p.legalName)}</cbc:RegistrationName></cac:PartyLegalEntity>`;
/** No local/candidate metadata is relabelled. Empty XMLDSig slot must be signed and XSD validated before storage/send. */
export function buildProductionGuidesXml(raw: unknown, reference?: ProductionGuidesReference09) {
 const s=validateProductionGuidesSnapshot(raw), b=s.body as any, carrier=s.documentType==='31', priv=s.profile==='GRE09_PRIVATE04_V1';
 if(carrier){if(!reference)throw Error('GRE_REFERENCE_REQUIRED');assertProductionGuidesReference(s,reference);}
 const local=new Date(Date.parse(b.issueDate)-18000000).toISOString(), number=`${s.series}-${s.number}`;
 const address=(a:any)=>`<cbc:ID schemeAgencyName="PE:INEI" schemeName="Ubigeos">${a.ubigeo}</cbc:ID>${priv?`<cbc:AddressTypeCode listID="${s.issuer.ruc}" listAgencyName="PE:SUNAT" listName="Establecimientos anexos">${a.establishmentCode}</cbc:AddressTypeCode>`:''}<cac:AddressLine><cbc:Line>${esc(a.address)}</cbc:Line></cac:AddressLine>`;
 const t=b.transport,d=t?.driver;
 const driver=d?`<cac:DriverPerson><cbc:ID schemeID="${d.identityType}" ${ATTR}>${d.identityNumber}</cbc:ID><cbc:FirstName>${esc(d.firstName)}</cbc:FirstName><cbc:FamilyName>${esc(d.lastName)}</cbc:FamilyName><cbc:JobTitle>Principal</cbc:JobTitle><cac:IdentityDocumentReference><cbc:ID>${d.license}</cbc:ID></cac:IdentityDocumentReference></cac:DriverPerson>`:'';
 const publicCarrier=carrier?t.carrier:{...b.carrier,mtcRegistration:b.mtcRegistration};
 const stage=`<cac:ShipmentStage>${carrier?'':`<cbc:TransportModeCode listAgencyName="PE:SUNAT" listName="Modalidad de traslado" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo18">${priv?'02':'01'}</cbc:TransportModeCode>`}<cac:TransitPeriod><cbc:StartDate>${b.transferDate}</cbc:StartDate></cac:TransitPeriod>${!priv?`<cac:CarrierParty>${id(publicCarrier.ruc)}<cac:PartyLegalEntity><cbc:RegistrationName>${esc(publicCarrier.legalName)}</cbc:RegistrationName><cbc:CompanyID>${publicCarrier.mtcRegistration}</cbc:CompanyID></cac:PartyLegalEntity></cac:CarrierParty>`:''}${driver}</cac:ShipmentStage>`;
 const vehicle=t?.vehicle?`<cac:TransportHandlingUnit><cac:TransportEquipment><cbc:ID>${t.vehicle.plate}</cbc:ID>${carrier?`<cac:ShipmentDocumentReference><cbc:ID>${t.vehicle.tuc}</cbc:ID></cac:ShipmentDocumentReference>`:`<cac:ApplicableTransportMeans><cbc:RegistrationNationalityID>${t.vehicle.registration}</cbc:RegistrationNationalityID></cac:ApplicableTransportMeans>`}</cac:TransportEquipment></cac:TransportHandlingUnit>`:'';
 const referenceXml=carrier?`<cac:AdditionalDocumentReference><cbc:ID>${b.reference09.series}-${b.reference09.number}</cbc:ID><cbc:DocumentTypeCode listAgencyName="PE:SUNAT" listName="Documento relacionado al transporte" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo61">09</cbc:DocumentTypeCode><cbc:DocumentType>Guía de remisión remitente</cbc:DocumentType><cac:IssuerParty>${id(b.reference09.issuerRuc)}</cac:IssuerParty></cac:AdditionalDocumentReference>`:'';
 const xml=`<?xml version="1.0" encoding="UTF-8"?><DespatchAdvice xmlns="urn:oasis:names:specification:ubl:schema:xsd:DespatchAdvice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions><cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:CustomizationID>2.0</cbc:CustomizationID><cbc:ID>${number}</cbc:ID><cbc:IssueDate>${local.slice(0,10)}</cbc:IssueDate><cbc:IssueTime>${local.slice(11,19)}</cbc:IssueTime><cbc:DespatchAdviceTypeCode listAgencyName="PE:SUNAT" listName="Tipo de Documento" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo01">${s.documentType}</cbc:DespatchAdviceTypeCode>${referenceXml}<cac:Signature><cbc:ID>signatureFactuEz</cbc:ID><cac:SignatoryParty>${id(s.issuer.ruc)}<cac:PartyName><cbc:Name>${esc(s.issuer.legalName)}</cbc:Name></cac:PartyName></cac:SignatoryParty><cac:DigitalSignatureAttachment><cac:ExternalReference><cbc:URI>#signatureFactuEz</cbc:URI></cac:ExternalReference></cac:DigitalSignatureAttachment></cac:Signature><cac:DespatchSupplierParty><cac:Party>${party(s.issuer)}</cac:Party></cac:DespatchSupplierParty><cac:DeliveryCustomerParty><cac:Party>${party(b.recipient)}</cac:Party></cac:DeliveryCustomerParty><cac:Shipment><cbc:ID>SUNAT_Envio</cbc:ID>${!carrier?`<cbc:HandlingCode listAgencyName="PE:SUNAT" listName="Motivo de traslado" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo20">${priv?'04':'01'}</cbc:HandlingCode><cbc:HandlingInstructions>${priv?'Traslado entre establecimientos de la misma empresa':'Venta'}</cbc:HandlingInstructions>`:''}<cbc:GrossWeightMeasure unitCode="${b.weightUnit}">${b.grossWeight}</cbc:GrossWeightMeasure>${carrier?'<cbc:SpecialInstructions>SUNAT_Envio_IndicadorTrasladoTotal</cbc:SpecialInstructions><cbc:SpecialInstructions>SUNAT_Envio_IndicadorPagadorFlete_Remitente</cbc:SpecialInstructions>':''}${stage}<cac:Delivery><cac:DeliveryAddress>${address(b.destination)}</cac:DeliveryAddress><cac:Despatch><cac:DespatchAddress>${address(b.origin)}</cac:DespatchAddress>${carrier?`<cac:DespatchParty>${party(b.sender)}</cac:DespatchParty>`:''}</cac:Despatch></cac:Delivery>${vehicle}</cac:Shipment>${b.items.map((i:any,n:number)=>`<cac:DespatchLine><cbc:ID>${n+1}</cbc:ID><cbc:DeliveredQuantity unitCode="${i.unitCode}" unitCodeListID="UN/ECE rec 20" unitCodeListAgencyName="United Nations Economic Commission for Europe">${i.quantity}</cbc:DeliveredQuantity><cac:OrderLineReference><cbc:LineID>${n+1}</cbc:LineID></cac:OrderLineReference><cac:Item><cbc:Description>${esc(i.description)}</cbc:Description><cac:SellersItemIdentification><cbc:ID>${esc(i.code)}</cbc:ID></cac:SellersItemIdentification></cac:Item></cac:DespatchLine>`).join('')}</DespatchAdvice>`;
 return {xml,xmlSha256:productionGuidesBytesHash(xml),snapshotSha256:hash(s),fullNumber:number};
}
function sealBytes(v:unknown,p:string){return Buffer.from(`FACTUEZ-GRE-V1\n${p}\n${hash(v)}`);}
/** Keys are explicit in-memory capabilities; no env/key-file discovery. Ed25519 whole-envelope seals. */
export function createProductionGuidesSigner(keyId:string,key:KeyObject):ProductionGuidesSigner {
 if(!/^[A-Za-z0-9_-]{1,64}$/.test(keyId)||key.type!=='private'||key.asymmetricKeyType!=='ed25519')throw Error('GRE_OWNER_KEY_INVALID');
 return {sign:(v,p)=>({keyId,signature:sign(null,sealBytes(v,p),key).toString('base64url')})};
}
export function createProductionGuidesVerifier(keys:ReadonlyMap<string,KeyObject>):ProductionGuidesVerifier {
 const pins=new Map(keys);return {verify(v,seal:ProductionGuidesSeal,p){try{const key=pins.get(seal.keyId);return !!key&&key.type==='public'&&key.asymmetricKeyType==='ed25519'&&/^[A-Za-z0-9_-]{86}$/.test(seal.signature)&&verify(null,sealBytes(v,p),key,Buffer.from(seal.signature,'base64url'));}catch{return false;}}};
}
