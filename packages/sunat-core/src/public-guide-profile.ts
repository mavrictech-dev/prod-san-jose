import { createHash } from 'node:crypto';
import { boundedSupplementJson } from './fiscal-supplement-command';
import { fiscalDate, fiscalDecimal, fiscalLimaDate, fiscalRuc, fiscalSnapshotSha256 as hash, fiscalTimestamp, fiscalXml as esc } from './fiscal-note';
import type { CarrierReference09Snapshot } from './carrier-guide-profile';

/** Separate public01/sale01 owner contract. Does not adapt numbered-v1/private02,
 * allocate numbers, assert acceptance, or enable official rules/transport.
 * UBL mapping follows the pinned local DespatchAdvice2.1 schema; SUNAT rules/XSL
 * are a separate gate. A trusted owner bridge must authenticate this full record. */
export type PublicGuide09OwnerSnapshot = {
  schemaVersion: 'factuez.public-guide09-issued-owner.v1'; companyId: number; branchId: string;
  documentId: string; operationId: string; issuer: { ruc: string; legalName: string };
  series: string; number: string;
  body: Omit<CarrierReference09Snapshot, 'schemaVersion' | 'documentId' | 'documentType' | 'issuer' | 'series' | 'number'> & {
    reasonCode: '01'; mtcRegistration: string;
  };
};
export const PUBLIC_GUIDE09_PROFILE = 'FACTUEZ-BETA-GRE09-PUBLIC01-SALE01-OWNER-v1';
const fail = (): never => { throw new Error('INVALID_PUBLIC_GUIDE09_OWNER'); };
function exact(v: unknown, keys: string[]): asserts v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== [...keys].sort().join(',')) fail();
}
function pattern(v: unknown, p: RegExp): asserts v is string { if (typeof v !== 'string' || p.exec(v)?.[0] !== v) fail(); }
function text(v: unknown, max: number): asserts v is string {
  if (typeof v !== 'string' || !v || v.trim() !== v || v.length > max || /[\x00-\x1f\x7f-\x9f\ud800-\udfff\ufffe\uffff]/u.test(v)) fail();
}
function party(v: unknown) { exact(v, ['ruc', 'legalName']); fiscalRuc(v.ruc, 'ruc'); text(v.legalName, 250); }
export function validatePublicGuide09OwnerSnapshot(raw: unknown): PublicGuide09OwnerSnapshot {
  try {
    const s = boundedSupplementJson(raw) as PublicGuide09OwnerSnapshot;
    exact(s, ['schemaVersion', 'companyId', 'branchId', 'documentId', 'operationId', 'issuer', 'series', 'number', 'body']);
    if (s.schemaVersion !== 'factuez.public-guide09-issued-owner.v1' || !Number.isSafeInteger(s.companyId) || s.companyId < 1) fail();
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
    for (const id of [s.branchId, s.documentId, s.operationId]) pattern(id, uuid);
    party(s.issuer); pattern(s.series, /^T[A-Z0-9]{3}$/); pattern(s.number, /^[1-9][0-9]{0,7}$/);
    const b = s.body;
    exact(b, ['issueDate', 'transferDate', 'sender', 'recipient', 'origin', 'destination', 'carrier', 'grossWeight', 'weightUnit',
      'items', 'transportMode', 'regulatedGoods', 'reasonCode', 'mtcRegistration']);
    if (b.transportMode !== '01' || b.reasonCode !== '01' || b.regulatedGoods !== false || hash(s.issuer) !== hash(b.sender)) fail();
    for (const p of [b.sender, b.recipient, b.carrier]) party(p);
    fiscalTimestamp(b.issueDate, 'issueDate'); fiscalDate(b.transferDate, 'transferDate');
    if (new Date(b.issueDate).toISOString() !== b.issueDate || b.transferDate < fiscalLimaDate(b.issueDate)) fail();
    for (const a of [b.origin, b.destination]) { exact(a, ['ubigeo', 'address']); pattern(a.ubigeo, /^[0-9]{6}$/); if (a.ubigeo === '000000') fail(); text(a.address, 500); }
    if (hash(b.origin) === hash(b.destination)) fail();
    fiscalDecimal(b.grossWeight, 3, true, 'grossWeight'); if (!['KGM', 'TNE'].includes(b.weightUnit)) fail();
    pattern(b.mtcRegistration, /^[A-Z0-9-]{1,20}$/);
    if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 100) fail();
    const seen = new Set<string>();
    for (const i of b.items) {
      exact(i, ['code', 'description', 'quantity', 'unitCode']); text(i.code, 30); text(i.description, 500);
      fiscalDecimal(i.quantity, 10, true, 'quantity'); pattern(i.unitCode, /^[A-Z0-9]{2,3}$/);
      if (seen.has(i.code)) fail(); seen.add(i.code);
    }
    return s;
  } catch { return fail(); }
}
export function projectPublicGuide09OwnerSnapshot(raw: unknown): CarrierReference09Snapshot {
  const s = validatePublicGuide09OwnerSnapshot(raw), { reasonCode: _reason, mtcRegistration: _mtc, ...body } = s.body;
  return { schemaVersion: 'factuez.carrier-reference09-owner.v1', documentId: s.documentId, documentType: '09', issuer: s.issuer,
    series: s.series, number: s.number, ...body };
}
/** Exact unsigned expected document for a private cryptographic verifier. The
 * verifier must compare every non-signature node after removing the verified
 * XMLDSig. This template alone is neither a signed original nor accepted proof. */
export function buildPublicGuide09Xml(raw: unknown) {
  const s = validatePublicGuide09OwnerSnapshot(raw), b = s.body, fullNumber = `${s.series}-${s.number}`;
  const local = new Date(Date.parse(b.issueDate) - 5 * 60 * 60 * 1000).toISOString();
  const attrs = 'schemeName="Documento de Identidad" schemeAgencyName="PE:SUNAT" schemeURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo06"';
  const id = (ruc: string) => `<cac:PartyIdentification><cbc:ID schemeID="6" ${attrs}>${ruc}</cbc:ID></cac:PartyIdentification>`;
  const partyXml = (p: PublicGuide09OwnerSnapshot['issuer']) => `${id(p.ruc)}<cac:PartyLegalEntity><cbc:RegistrationName>${esc(p.legalName)}</cbc:RegistrationName></cac:PartyLegalEntity>`;
  const address = (a: typeof b.origin) => `<cbc:ID schemeAgencyName="PE:INEI" schemeName="Ubigeos">${a.ubigeo}</cbc:ID><cac:AddressLine><cbc:Line>${esc(a.address)}</cbc:Line></cac:AddressLine>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?><DespatchAdvice xmlns="urn:oasis:names:specification:ubl:schema:xsd:DespatchAdvice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions><cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:CustomizationID>2.0</cbc:CustomizationID><cbc:ID>${fullNumber}</cbc:ID><cbc:IssueDate>${local.slice(0, 10)}</cbc:IssueDate><cbc:IssueTime>${local.slice(11, 19)}</cbc:IssueTime><cbc:DespatchAdviceTypeCode listAgencyName="PE:SUNAT" listName="Tipo de Documento" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo01">09</cbc:DespatchAdviceTypeCode><cbc:Note>BETA LOCAL - CANDIDATO SIN FIRMA - SIN VALIDEZ TRIBUTARIA - NO AUTORIZA TRASLADO</cbc:Note><cac:Signature><cbc:ID>signatureFactuEz</cbc:ID><cac:SignatoryParty>${id(s.issuer.ruc)}<cac:PartyName><cbc:Name>${esc(s.issuer.legalName)}</cbc:Name></cac:PartyName></cac:SignatoryParty><cac:DigitalSignatureAttachment><cac:ExternalReference><cbc:URI>#signatureFactuEz</cbc:URI></cac:ExternalReference></cac:DigitalSignatureAttachment></cac:Signature><cac:DespatchSupplierParty><cac:Party>${partyXml(b.sender)}</cac:Party></cac:DespatchSupplierParty><cac:DeliveryCustomerParty><cac:Party>${partyXml(b.recipient)}</cac:Party></cac:DeliveryCustomerParty><cac:Shipment><cbc:ID>SUNAT_Envio</cbc:ID><cbc:HandlingCode listAgencyName="PE:SUNAT" listName="Motivo de traslado" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo20">01</cbc:HandlingCode><cbc:HandlingInstructions>Venta</cbc:HandlingInstructions><cbc:GrossWeightMeasure unitCode="${b.weightUnit}">${b.grossWeight}</cbc:GrossWeightMeasure><cac:ShipmentStage><cbc:TransportModeCode listAgencyName="PE:SUNAT" listName="Modalidad de traslado" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo18">01</cbc:TransportModeCode><cac:TransitPeriod><cbc:StartDate>${b.transferDate}</cbc:StartDate></cac:TransitPeriod><cac:CarrierParty>${id(b.carrier.ruc)}<cac:PartyLegalEntity><cbc:RegistrationName>${esc(b.carrier.legalName)}</cbc:RegistrationName><cbc:CompanyID>${b.mtcRegistration}</cbc:CompanyID></cac:PartyLegalEntity></cac:CarrierParty></cac:ShipmentStage><cac:Delivery><cac:DeliveryAddress>${address(b.destination)}</cac:DeliveryAddress><cac:Despatch><cac:DespatchAddress>${address(b.origin)}</cac:DespatchAddress></cac:Despatch></cac:Delivery></cac:Shipment>${b.items.map((i, n) => `<cac:DespatchLine><cbc:ID>${n + 1}</cbc:ID><cbc:DeliveredQuantity unitCode="${i.unitCode}" unitCodeListID="UN/ECE rec 20" unitCodeListAgencyName="United Nations Economic Commission for Europe">${i.quantity}</cbc:DeliveredQuantity><cac:OrderLineReference><cbc:LineID>${n + 1}</cbc:LineID></cac:OrderLineReference><cac:Item><cbc:Description>${esc(i.description)}</cbc:Description><cac:SellersItemIdentification><cbc:ID>${esc(i.code)}</cbc:ID></cac:SellersItemIdentification></cac:Item></cac:DespatchLine>`).join('')}</DespatchAdvice>`;
  return { xml, xmlSha256: createHash('sha256').update(xml).digest('hex'), profile: PUBLIC_GUIDE09_PROFILE,
    documentId: s.documentId, operationId: s.operationId, issuerRuc: s.issuer.ruc, documentType: '09' as const,
    fullNumber, snapshotSha256: hash(s), projectionSha256: hash(projectPublicGuide09OwnerSnapshot(s)), environment: 'BETA' as const,
    candidateOnly: true as const, fiscalExecutionEnabled: false as const, transmissionAuthorized: false as const,
    authorizedForTransfer: false as const, officialRulesValidated: false as const };
}
