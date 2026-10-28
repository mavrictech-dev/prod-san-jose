import { createHash } from 'node:crypto';
import { boundedSupplementJson } from './fiscal-supplement-command';
import { fiscalObject, fiscalRuc, fiscalSnapshotSha256, fiscalUuid, fiscalXml } from './fiscal-note';
import { GuidePreparationError, prepareGuide09, type Guide09PreparationBody } from './fiscal-guide-preparation';

/** Pure, independently versioned numbered candidate. The caller MUST obtain the
 * identity, body and snapshot binding from its immutable issued owner snapshot.
 * Neither a UUID nor snapshotSha256 authenticates that owner or reserves a number.
 * No preview/proposal, certificate, transport, persistence or official request is
 * accepted here. Structural validation of a RUC does not establish its ownership.
 */
export const NUMBERED_GUIDE_INPUT_SCHEMA_VERSION = 'factuez.numbered-guide-input.v1';
export const NUMBERED_GUIDE09_PROFILE = 'FACTUEZ-BETA-GRE09-PRIVATE02-REASON04-NUMBERED-v1';
export const NUMBERED_GUIDE_LOCAL_WARNING = 'BETA LOCAL - CANDIDATO SIN FIRMA - SIN VALIDEZ TRIBUTARIA - NO AUTORIZA TRASLADO';
export const NUMBERED_GUIDE_SOURCES = Object.freeze({
  portal: 'https://cpe.sunat.gob.pe/node/116',
  base: 'https://www.sunat.gob.pe/legislacion/superin/2022/anexo-123-2022.pdf',
  amendment09: 'https://www.sunat.gob.pe/legislacion/superin/2024/anexo3-000240-2024.pdf',
  limitation: 'Base UBL mapping only; complete current SUNAT business rules/XSL have not been executed.',
});

// Structural GuideBody compatibility, with no dependency from core to a service.
// The public branch deliberately has no vehicle/driver data: it is insufficient
// to render a 31 and MUST NOT be completed from the private branch or defaults.
export type NumberedGuideBody = Omit<Guide09PreparationBody, 'reasonCode' | 'transport' | 'references' | 'regulatedGoods'> & {
  reasonCode: string;
  transport: Guide09PreparationBody['transport'] | {
    mode: '01'; carrier: { ruc: string; legalName: string; mtcRegistration: string };
  };
  references: { type: '01' | '03' | '09' | '31'; issuerRuc: string; series: string; number: string }[];
  regulatedGoods: boolean;
};
export type NumberedGuideInput = {
  schemaVersion: typeof NUMBERED_GUIDE_INPUT_SCHEMA_VERSION;
  documentId: string;
  operationId: string;
  issuer: { ruc: string; legalName: string };
  documentType: '09' | '31';
  series: string;
  number: string;
  body: NumberedGuideBody;
  /** Opaque caller OWNER claim, not hash(body), a credential or authoritative evidence. */
  snapshotSha256: string;
};
export type ValidatedNumberedGuideInput = NumberedGuideInput & { documentType: '09'; body: Guide09PreparationBody };
export type NumberedGuideErrorCode = 'INVALID_NUMBERED_GUIDE_INPUT' | 'NUMBERED_GUIDE_PROFILE_NOT_ENABLED'
  | 'NUMBERED_GUIDE_ISSUER_MISMATCH' | 'NUMBERED_GUIDE_SAME_ESTABLISHMENT'
  | 'NUMBERED_GUIDE31_TRANSPORT_DETAILS_UNREPRESENTABLE';
export class NumberedGuideProfileError extends Error {
  constructor(readonly code: NumberedGuideErrorCode) { super(code); this.name = 'NumberedGuideProfileError'; }
}
const fail = (code: NumberedGuideErrorCode): never => { throw new NumberedGuideProfileError(code); };
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  fiscalObject(value, keys, 'numberedGuide');
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('INVALID_NUMBERED_GUIDE_INPUT');
}
function pattern(value: unknown, regex: RegExp): asserts value is string {
  if (typeof value !== 'string' || !regex.test(value)) fail('INVALID_NUMBERED_GUIDE_INPUT');
}

/** Returns an independent, strictly bounded JSON copy. No environment override or
 * self-asserted authority flags are accepted. Only 09/private02/reason04 is enabled.
 *
 * SUNAT RS123-2022 Anexo VII, b), pp.93-99: 31 issuer is the carrier
 * (DespatchSupplierParty), sender is Shipment/Delivery/DespatchParty, recipient is
 * DeliveryCustomerParty; primary plate and driver identity/name/license are
 * mandatory (fields 35,41-44), with conditional TUC/MTC data. GuideBody mode01
 * only represents carrier identity/MTC, NOT these required transport details.
 * The separate carrier-guide-profile.ts contract supplies 31 data; this v1
 * remains blocked. That renderer documents the annex's missing Despatch path
 * segment versus the pinned UBL XSD. Never guess vehicles/drivers or relabel 02.
 */
export function validateNumberedGuideInput(input: unknown): ValidatedNumberedGuideInput {
  try {
    const value = boundedSupplementJson(input);
    exact(value, ['schemaVersion', 'documentId', 'operationId', 'issuer', 'documentType', 'series', 'number', 'body', 'snapshotSha256']);
    if (value.schemaVersion !== NUMBERED_GUIDE_INPUT_SCHEMA_VERSION || !['09', '31'].includes(String(value.documentType))) fail('INVALID_NUMBERED_GUIDE_INPUT');
    fiscalUuid(value.documentId, 'documentId'); fiscalUuid(value.operationId, 'operationId');
    // Match the existing guide preparation owner's UUID grammar.
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
    pattern(value.documentId, uuid); pattern(value.operationId, uuid);
    exact(value.issuer, ['ruc', 'legalName']); fiscalRuc(value.issuer.ruc, 'issuer.ruc');
    pattern(value.snapshotSha256, /^[a-f0-9]{64}$/);
    pattern(value.series, value.documentType === '09' ? /^T[A-Z0-9]{3}$/ : /^V[A-Z0-9]{3}$/);
    pattern(value.number, /^[1-9][0-9]{0,7}$/);
    if (value.documentType === '31') fail('NUMBERED_GUIDE31_TRANSPORT_DETAILS_UNREPRESENTABLE');
    // Reuse the full existing strict private04 validator, NOT its preview XML.
    // This internal validation envelope is ephemeral: documentId is only its
    // syntactic ID, and v1 is an adapter constant, never evidence of a draft.
    // Its body hash is computed here and is distinct from the opaque owner claim.
    const checked = prepareGuide09({
      schemaVersion: 'factuez.guide09-preparation-input.v1', draftId: value.documentId,
      draftRevision: '"v1"', draftBodySha256: fiscalSnapshotSha256(value.body),
      issuer: value.issuer, body: value.body,
    });
    return { ...value, issuer: checked.issuer, body: checked.body } as ValidatedNumberedGuideInput;
  } catch (error) {
    if (error instanceof NumberedGuideProfileError) throw error;
    if (error instanceof GuidePreparationError) {
      if (error.code === 'GUIDE_PREPARATION_PROFILE_NOT_ENABLED') fail('NUMBERED_GUIDE_PROFILE_NOT_ENABLED');
      if (error.code === 'GUIDE_PREPARATION_ISSUER_MISMATCH') fail('NUMBERED_GUIDE_ISSUER_MISMATCH');
      if (error.code === 'GUIDE_PREPARATION_SAME_ESTABLISHMENT') fail('NUMBERED_GUIDE_SAME_ESTABLISHMENT');
    }
    return fail('INVALID_NUMBERED_GUIDE_INPUT');
  }
}

export type NumberedGuideXml = {
  xml: string; xmlSha256: string; profile: typeof NUMBERED_GUIDE09_PROFILE;
  documentId: string; operationId: string; issuerRuc: string; documentType: '09';
  fullNumber: string; snapshotSha256: string; environment: 'BETA'; candidateOnly: true;
  fiscalExecutionEnabled: false; transmissionAuthorized: false;
  authorizedForTransfer: false; officialRulesValidated: false;
};
const IDENTITY_ATTRIBUTES = 'schemeName="Documento de Identidad" schemeAgencyName="PE:SUNAT" schemeURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo06"';

/** Unsigned XMLDSig template. ExtensionContent MUST remain empty for the existing
 * guarded signer; that signer appends ds:Signature Id="signatureFactuEz". An
 * empty slot is intentionally not a complete XSD-valid signed document. Never
 * insert fake digests/signatures or weaken the signer to make the template pass
 * XSD. Validate the completed signed artifact separately. Hash here is of these
 * exact unsigned UTF-8 bytes; it is not the signed artifact hash or an authority.
 */
export function buildNumberedGuideXml(input: unknown): NumberedGuideXml {
  const v = validateNumberedGuideInput(input), b = v.body, t = b.transport, d = t.driver;
  const fullNumber = `${v.series}-${v.number}`;
  const local = new Date(Date.parse(b.issueDate) - 5 * 60 * 60 * 1000).toISOString();
  const party = (p: NumberedGuideInput['issuer']) => `<cac:Party><cac:PartyIdentification><cbc:ID schemeID="6" ${IDENTITY_ATTRIBUTES}>${p.ruc}</cbc:ID></cac:PartyIdentification><cac:PartyLegalEntity><cbc:RegistrationName>${fiscalXml(p.legalName)}</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party>`;
  const address = (a: Guide09PreparationBody['origin']) => `<cbc:ID schemeAgencyName="PE:INEI" schemeName="Ubigeos">${a.ubigeo}</cbc:ID><cbc:AddressTypeCode listID="${v.issuer.ruc}" listAgencyName="PE:SUNAT" listName="Establecimientos anexos">${a.establishmentCode}</cbc:AddressTypeCode><cac:AddressLine><cbc:Line>${fiscalXml(a.address)}</cbc:Line></cac:AddressLine>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?><DespatchAdvice xmlns="urn:oasis:names:specification:ubl:schema:xsd:DespatchAdvice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions><cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:CustomizationID>2.0</cbc:CustomizationID><cbc:ID>${fullNumber}</cbc:ID><cbc:IssueDate>${local.slice(0, 10)}</cbc:IssueDate><cbc:IssueTime>${local.slice(11, 19)}</cbc:IssueTime><cbc:DespatchAdviceTypeCode listAgencyName="PE:SUNAT" listName="Tipo de Documento" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo01">09</cbc:DespatchAdviceTypeCode><cbc:Note>${NUMBERED_GUIDE_LOCAL_WARNING}</cbc:Note><cac:Signature><cbc:ID>signatureFactuEz</cbc:ID><cac:SignatoryParty><cac:PartyIdentification><cbc:ID schemeID="6" ${IDENTITY_ATTRIBUTES}>${v.issuer.ruc}</cbc:ID></cac:PartyIdentification><cac:PartyName><cbc:Name>${fiscalXml(v.issuer.legalName)}</cbc:Name></cac:PartyName></cac:SignatoryParty><cac:DigitalSignatureAttachment><cac:ExternalReference><cbc:URI>#signatureFactuEz</cbc:URI></cac:ExternalReference></cac:DigitalSignatureAttachment></cac:Signature><cac:DespatchSupplierParty>${party(b.sender)}</cac:DespatchSupplierParty><cac:DeliveryCustomerParty>${party(b.recipient)}</cac:DeliveryCustomerParty><cac:Shipment><cbc:ID>SUNAT_Envio</cbc:ID><cbc:HandlingCode listAgencyName="PE:SUNAT" listName="Motivo de traslado" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo20">04</cbc:HandlingCode><cbc:HandlingInstructions>Traslado entre establecimientos de la misma empresa</cbc:HandlingInstructions><cbc:GrossWeightMeasure unitCode="${b.weightUnit}">${b.grossWeight}</cbc:GrossWeightMeasure><cac:ShipmentStage><cbc:TransportModeCode listAgencyName="PE:SUNAT" listName="Modalidad de traslado" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo18">02</cbc:TransportModeCode><cac:TransitPeriod><cbc:StartDate>${b.transferDate}</cbc:StartDate></cac:TransitPeriod><cac:DriverPerson><cbc:ID schemeID="${d.identityType}" ${IDENTITY_ATTRIBUTES}>${d.identityNumber}</cbc:ID><cbc:FirstName>${fiscalXml(d.firstName)}</cbc:FirstName><cbc:FamilyName>${fiscalXml(d.lastName)}</cbc:FamilyName><cbc:JobTitle>Principal</cbc:JobTitle><cac:IdentityDocumentReference><cbc:ID>${d.license}</cbc:ID></cac:IdentityDocumentReference></cac:DriverPerson></cac:ShipmentStage><cac:Delivery><cac:DeliveryAddress>${address(b.destination)}</cac:DeliveryAddress><cac:Despatch><cac:DespatchAddress>${address(b.origin)}</cac:DespatchAddress></cac:Despatch></cac:Delivery><cac:TransportHandlingUnit><cac:TransportEquipment><cbc:ID>${t.vehicle.plate}</cbc:ID><cac:ApplicableTransportMeans><cbc:RegistrationNationalityID>${t.vehicle.registration}</cbc:RegistrationNationalityID></cac:ApplicableTransportMeans></cac:TransportEquipment></cac:TransportHandlingUnit></cac:Shipment>${b.items.map((item, i) => `<cac:DespatchLine><cbc:ID>${i + 1}</cbc:ID><cbc:DeliveredQuantity unitCode="${item.unitCode}" unitCodeListID="UN/ECE rec 20" unitCodeListAgencyName="United Nations Economic Commission for Europe">${item.quantity}</cbc:DeliveredQuantity><cac:OrderLineReference><cbc:LineID>${i + 1}</cbc:LineID></cac:OrderLineReference><cac:Item><cbc:Description>${fiscalXml(item.description)}</cbc:Description><cac:SellersItemIdentification><cbc:ID>${fiscalXml(item.code)}</cbc:ID></cac:SellersItemIdentification></cac:Item></cac:DespatchLine>`).join('')}</DespatchAdvice>`;
  return {
    xml, xmlSha256: createHash('sha256').update(xml, 'utf8').digest('hex'), profile: NUMBERED_GUIDE09_PROFILE,
    documentId: v.documentId, operationId: v.operationId, issuerRuc: v.issuer.ruc, documentType: v.documentType,
    fullNumber, snapshotSha256: v.snapshotSha256, environment: 'BETA', candidateOnly: true,
    fiscalExecutionEnabled: false, transmissionAuthorized: false, authorizedForTransfer: false, officialRulesValidated: false,
  };
}
