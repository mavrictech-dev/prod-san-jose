import { createHash } from 'node:crypto';
import { boundedSupplementJson } from './fiscal-supplement-command';
import { fiscalDate, fiscalDecimal, fiscalLimaDate, fiscalRuc, fiscalSnapshotSha256, fiscalTimestamp, fiscalXml } from './fiscal-note';

/** Independent owner contract: never an adapter for NumberedGuideInput v1.
 * Narrow BETA profile: one complete electronic 09, public road transport, RUC
 * parties, one vehicle/driver, sender pays, no subcontract or regulated goods.
 * MTC and TUC are mandatory in this profile even where the annex is conditional.
 * The issuer/number/body must come from an immutable numbered owner snapshot.
 * This module does not allocate numbers, sign, persist or authorize a transfer.
 *
 * Primary mapping, consulted 2026-10-23: SUNAT RS123-2022, Anexo VII,
 * Anexo 14 b), PDF pp.93-99 (zero based), fields 1-64:
 * https://www.sunat.gob.pe/legislacion/superin/2022/anexo-123-2022.pdf
 * Local structural sources: services/sunat-service/assets/sunat/xsd-version.json
 * and xsd-20220228.zip, 2.1/maindoc/UBL-DespatchAdvice-2.1.xsd;
 * tests/validate-official-xsd.py supplies the bounded offline schema resolver.
 * These sources do not establish execution of current SUNAT business rules/XSL.
 */
export const CARRIER_GUIDE_INPUT_SCHEMA_VERSION = 'factuez.carrier-guide-input.v1';
export const CARRIER_GUIDE31_PROFILE = 'FACTUEZ-BETA-GRE31-PUBLIC01-SINGLE09-SENDERPAYS-v1';
export const CARRIER_GUIDE_SOURCES = Object.freeze({
  base: 'https://www.sunat.gob.pe/legislacion/superin/2022/anexo-123-2022.pdf',
  annex: 'Anexo VII / Anexo 14 b), PDF pages 94-100, fields 1-64',
  localXsd: 'services/sunat-service/assets/sunat/xsd-20220228.zip',
  localXsdSha256: '5cac9d9353521340fbc15d23f465a4946b004535b9ff411541c87da01694dbd5',
});
type Party = { ruc: string; legalName: string };
type Location = { ubigeo: string; address: string };
type Item = { code: string; description: string; quantity: string; unitCode: string };
export type CarrierGuideReference09 = {
  documentId: string; issuerRuc: string; series: string; number: string; snapshotSha256: string;
};
export type CarrierGuideBody = {
  issueDate: string; transferDate: string;
  sender: Party; recipient: Party; origin: Location; destination: Location;
  grossWeight: string; weightUnit: 'KGM' | 'TNE';
  transport: {
    mode: '01'; carrier: Party & { mtcRegistration: string };
    vehicle: { plate: string; tuc: string };
    driver: { identityType: '1' | '4'; identityNumber: string; firstName: string; lastName: string; license: string };
  };
  reference09: CarrierGuideReference09; items: Item[];
  totalTransfer: true; freightPayer: 'SENDER'; subcontracted: false; regulatedGoods: false;
};
export type CarrierGuideInput = {
  schemaVersion: typeof CARRIER_GUIDE_INPUT_SCHEMA_VERSION;
  companyId: number; branchId: string; documentId: string; operationId: string;
  issuer: Party; documentType: '31'; series: string; number: string;
  body: CarrierGuideBody;
  /** Opaque numbered OWNER snapshot binding; not hash(body) or proof of authority. */
  snapshotSha256: string;
};

/** Private port returns an authorized, immutable projection of the sender's 09
 * and its cryptographically verified local owner CDR. It MUST authorize access
 * for companyId/branchId/issuerRuc, read the issued snapshot (not a draft/client
 * claim), and reject revoked, replaced or unauthenticated evidence. The hash
 * below covers this versioned projection. The adapter must bind it back to its
 * full stored snapshot and CDR. It is NEVER supplied/deserialized from HTTP.
 * No pure profile can authenticate a malicious implementation of its owner port.
 */
export type CarrierReference09Snapshot = {
  schemaVersion: 'factuez.carrier-reference09-owner.v1';
  documentId: string; documentType: '09'; issuer: Party; series: string; number: string;
  issueDate: string; transferDate: string; sender: Party; recipient: Party;
  origin: Location; destination: Location; carrier: Party;
  grossWeight: string; weightUnit: 'KGM' | 'TNE'; items: Item[];
  transportMode: '01'; regulatedGoods: false;
};
export type CarrierReference09Evidence = {
  snapshot: CarrierReference09Snapshot;
  acceptance: {
    environment: 'BETA'; documentId: string; issuerRuc: string; fullNumber: string;
    snapshotSha256: string; cdrSha256: string; responseCode: '0';
    status: 'ACCEPTED' | 'ACCEPTED_WITH_OBSERVATIONS'; acceptedAt: string;
  };
};
export type CarrierReference09OwnerQuery = {
  companyId: number; branchId: string; issuerRuc: string;
  documentId: string; operationId: string; snapshotSha256: string; asOf: string;
  reference09: CarrierGuideReference09;
};
export interface CarrierGuideReferenceOwnerPort {
  loadAcceptedReference09(query: Readonly<CarrierReference09OwnerQuery>): Promise<unknown>;
}
export type CarrierGuideErrorCode = 'INVALID_CARRIER_GUIDE_INPUT' | 'CARRIER_GUIDE_PROFILE_NOT_ENABLED'
  | 'CARRIER_GUIDE_ISSUER_MISMATCH' | 'CARRIER_GUIDE_REFERENCE_UNVERIFIED'
  | 'CARRIER_GUIDE_REFERENCE_MISMATCH' | 'CARRIER_GUIDE_INPUT_CHANGED';
export class CarrierGuideProfileError extends Error {
  constructor(readonly code: CarrierGuideErrorCode) { super(code); this.name = 'CarrierGuideProfileError'; }
}
const fail = (code: CarrierGuideErrorCode): never => { throw new CarrierGuideProfileError(code); };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('INVALID_CARRIER_GUIDE_INPUT');
}
function pattern(value: unknown, regex: RegExp): asserts value is string {
  if (typeof value !== 'string' || !regex.test(value)) fail('INVALID_CARRIER_GUIDE_INPUT');
}
function text(value: unknown, max: number): asserts value is string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > max ||
    /[\x00-\x1f\x7f-\x9f\ud800-\udfff\ufffe\uffff]/u.test(value)) fail('INVALID_CARRIER_GUIDE_INPUT');
}
function party(value: unknown): asserts value is Party {
  exact(value, ['ruc', 'legalName']); fiscalRuc(value.ruc, 'party.ruc'); text(value.legalName, 250);
}
function location(value: unknown): asserts value is Location {
  exact(value, ['ubigeo', 'address']); pattern(value.ubigeo, /^[0-9]{6}$/);
  if (value.ubigeo === '000000') fail('INVALID_CARRIER_GUIDE_INPUT'); text(value.address, 500);
}
function items(value: unknown): asserts value is Item[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) return fail('INVALID_CARRIER_GUIDE_INPUT');
  const seen = new Set<string>();
  for (const item of value) {
    exact(item, ['code', 'description', 'quantity', 'unitCode']); text(item.code, 30); text(item.description, 500);
    fiscalDecimal(item.quantity, 10, true, 'quantity'); pattern(item.unitCode, /^[A-Z0-9]{2,3}$/);
    if (seen.has(item.code)) fail('INVALID_CARRIER_GUIDE_INPUT'); seen.add(item.code);
  }
}
function dates(issueDate: unknown, transferDate: unknown): void {
  fiscalTimestamp(issueDate, 'issueDate'); fiscalDate(transferDate, 'transferDate');
  if (new Date(issueDate as string).toISOString() !== issueDate || (transferDate as string) < fiscalLimaDate(issueDate as string)) fail('INVALID_CARRIER_GUIDE_INPUT');
}
function weight(grossWeight: unknown, weightUnit: unknown): void {
  fiscalDecimal(grossWeight, 3, true, 'grossWeight');
  if (!['KGM', 'TNE'].includes(String(weightUnit))) fail('INVALID_CARRIER_GUIDE_INPUT');
}
function reference(value: unknown): asserts value is CarrierGuideReference09 {
  exact(value, ['documentId', 'issuerRuc', 'series', 'number', 'snapshotSha256']);
  pattern(value.documentId, UUID); fiscalRuc(value.issuerRuc, 'reference09.issuerRuc');
  pattern(value.series, /^T[A-Z0-9]{3}$/); pattern(value.number, /^[1-9][0-9]{0,7}$/); pattern(value.snapshotSha256, HASH);
}
const equal = (a: unknown, b: unknown) => fiscalSnapshotSha256(a) === fiscalSnapshotSha256(b);

/** Strict JSON copy only. Syntactic validity is NOT reference verification. */
export function validateCarrierGuideInput(input: unknown): CarrierGuideInput {
  try {
    const v = boundedSupplementJson(input);
    exact(v, ['schemaVersion', 'companyId', 'branchId', 'documentId', 'operationId', 'issuer', 'documentType', 'series', 'number', 'body', 'snapshotSha256']);
    if (v.schemaVersion !== CARRIER_GUIDE_INPUT_SCHEMA_VERSION || v.documentType !== '31') fail('INVALID_CARRIER_GUIDE_INPUT');
    if (!Number.isSafeInteger(v.companyId) || (v.companyId as number) < 1) fail('INVALID_CARRIER_GUIDE_INPUT');
    pattern(v.branchId, UUID); pattern(v.documentId, UUID); pattern(v.operationId, UUID); pattern(v.snapshotSha256, HASH);
    party(v.issuer); pattern(v.series, /^V[A-Z0-9]{3}$/); pattern(v.number, /^[1-9][0-9]{0,7}$/);
    const b = v.body;
    exact(b, ['issueDate', 'transferDate', 'sender', 'recipient', 'origin', 'destination', 'grossWeight', 'weightUnit', 'transport', 'reference09', 'items', 'totalTransfer', 'freightPayer', 'subcontracted', 'regulatedGoods']);
    if (b.totalTransfer !== true || b.freightPayer !== 'SENDER' || b.subcontracted !== false || b.regulatedGoods !== false) fail('CARRIER_GUIDE_PROFILE_NOT_ENABLED');
    dates(b.issueDate, b.transferDate); party(b.sender); party(b.recipient); location(b.origin); location(b.destination);
    if (equal(b.origin, b.destination)) fail('INVALID_CARRIER_GUIDE_INPUT');
    weight(b.grossWeight, b.weightUnit); items(b.items); reference(b.reference09);
    if (b.reference09.documentId === v.documentId || b.reference09.issuerRuc !== b.sender.ruc) fail('CARRIER_GUIDE_REFERENCE_MISMATCH');
    const t = b.transport; exact(t, ['mode', 'carrier', 'vehicle', 'driver']);
    if (t.mode !== '01') fail('CARRIER_GUIDE_PROFILE_NOT_ENABLED');
    exact(t.carrier, ['ruc', 'legalName', 'mtcRegistration']);
    fiscalRuc(t.carrier.ruc, 'carrier.ruc'); text(t.carrier.legalName, 250); pattern(t.carrier.mtcRegistration, /^[A-Z0-9-]{1,20}$/);
    if (t.carrier.ruc !== v.issuer.ruc || t.carrier.legalName !== v.issuer.legalName) fail('CARRIER_GUIDE_ISSUER_MISMATCH');
    exact(t.vehicle, ['plate', 'tuc']); pattern(t.vehicle.plate, /^[A-Z0-9]{6,8}$/); pattern(t.vehicle.tuc, /^[A-Z0-9]{1,15}$/);
    const d = t.driver; exact(d, ['identityType', 'identityNumber', 'firstName', 'lastName', 'license']);
    if (!['1', '4'].includes(String(d.identityType))) fail('INVALID_CARRIER_GUIDE_INPUT');
    pattern(d.identityNumber, d.identityType === '1' ? /^[0-9]{8}$/ : /^[A-Z0-9]{1,12}$/);
    text(d.firstName, 125); text(d.lastName, 125); pattern(d.license, /^[A-Z0-9]{1,10}$/);
    return v as CarrierGuideInput;
  } catch (error) { if (error instanceof CarrierGuideProfileError) throw error; return fail('INVALID_CARRIER_GUIDE_INPUT'); }
}

function verifyReference(v: CarrierGuideInput, evidence: unknown): CarrierReference09Evidence {
  try {
    const e = boundedSupplementJson(evidence); exact(e, ['snapshot', 'acceptance']);
    const s = e.snapshot, a = e.acceptance, r = v.body.reference09, b = v.body;
    exact(s, ['schemaVersion', 'documentId', 'documentType', 'issuer', 'series', 'number', 'issueDate', 'transferDate', 'sender', 'recipient', 'origin', 'destination', 'carrier', 'grossWeight', 'weightUnit', 'items', 'transportMode', 'regulatedGoods']);
    if (s.schemaVersion !== 'factuez.carrier-reference09-owner.v1' || s.documentType !== '09' || s.transportMode !== '01' || s.regulatedGoods !== false) fail('CARRIER_GUIDE_REFERENCE_MISMATCH');
    party(s.issuer); party(s.sender); party(s.recipient); party(s.carrier); location(s.origin); location(s.destination);
    pattern(s.documentId, UUID); pattern(s.series, /^T[A-Z0-9]{3}$/); pattern(s.number, /^[1-9][0-9]{0,7}$/);
    dates(s.issueDate, s.transferDate); weight(s.grossWeight, s.weightUnit); items(s.items);
    if (s.documentId !== r.documentId || s.issuer.ruc !== r.issuerRuc || !equal(s.issuer, s.sender) || s.series !== r.series || s.number !== r.number ||
      fiscalSnapshotSha256(s) !== r.snapshotSha256 || Date.parse(s.issueDate as string) > Date.parse(b.issueDate)) fail('CARRIER_GUIDE_REFERENCE_MISMATCH');
    for (const key of ['sender', 'recipient', 'origin', 'destination', 'transferDate', 'grossWeight', 'weightUnit', 'items'] as const) {
      if (!equal(s[key], b[key])) fail('CARRIER_GUIDE_REFERENCE_MISMATCH');
    }
    if (!equal(s.carrier, v.issuer)) fail('CARRIER_GUIDE_REFERENCE_MISMATCH');
    exact(a, ['environment', 'documentId', 'issuerRuc', 'fullNumber', 'snapshotSha256', 'cdrSha256', 'responseCode', 'status', 'acceptedAt']);
    pattern(a.cdrSha256, HASH); fiscalTimestamp(a.acceptedAt, 'acceptedAt');
    if (a.environment !== 'BETA' || a.documentId !== r.documentId || a.issuerRuc !== r.issuerRuc || a.fullNumber !== `${r.series}-${r.number}` ||
      a.snapshotSha256 !== r.snapshotSha256 || a.responseCode !== '0' || !['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS'].includes(String(a.status)) ||
      Date.parse(a.acceptedAt as string) < Date.parse(s.issueDate as string) || Date.parse(a.acceptedAt as string) > Date.parse(b.issueDate)) fail('CARRIER_GUIDE_REFERENCE_MISMATCH');
    return e as CarrierReference09Evidence;
  } catch (error) {
    if (error instanceof CarrierGuideProfileError && error.code === 'CARRIER_GUIDE_REFERENCE_MISMATCH') throw error;
    return fail('CARRIER_GUIDE_REFERENCE_UNVERIFIED');
  }
}

export type CarrierGuideXml = {
  xml: string; xmlSha256: string; profile: typeof CARRIER_GUIDE31_PROFILE;
  companyId: number; branchId: string; documentId: string; operationId: string;
  issuerRuc: string; documentType: '31'; fullNumber: string; snapshotSha256: string;
  reference09: CarrierGuideReference09; referenceCdrSha256: string;
  referenceVerification: 'PRIVATE_OWNER_PORT';
  environment: 'BETA'; candidateOnly: true; fiscalExecutionEnabled: false;
  transmissionAuthorized: false; authorizedForTransfer: false; officialRulesValidated: false;
};
const ID = 'schemeName="Documento de Identidad" schemeAgencyName="PE:SUNAT" schemeURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo06"';
const identity = (ruc: string) => `<cac:PartyIdentification><cbc:ID schemeID="6" ${ID}>${ruc}</cbc:ID></cac:PartyIdentification>`;
const partyXml = (p: Party) => `${identity(p.ruc)}<cac:PartyLegalEntity><cbc:RegistrationName>${fiscalXml(p.legalName)}</cbc:RegistrationName></cac:PartyLegalEntity>`;
const addressXml = (a: Location) => `<cbc:ID schemeAgencyName="PE:INEI" schemeName="Ubigeos">${a.ubigeo}</cbc:ID><cac:AddressLine><cbc:Line>${fiscalXml(a.address)}</cbc:Line></cac:AddressLine>`;

/** Annex 14 b): fields 8-10 carrier, 12-19 reference/sender/recipient,
 * 29-44 addresses/vehicle/TUC/driver, 49-58 shipment. In particular TUC is
 * ShipmentDocumentReference/ID, NOT RegistrationNationalityID (private 09).
 * Annex fields 16-17 print Delivery/DespatchParty, but the pinned official
 * UBL-CommonAggregateComponents-2.1.xsd DeliveryType has no such child;
 * DespatchType explicitly contains DespatchParty after DespatchAddress.
 * Render Delivery/Despatch/DespatchParty, preserving the sender data and valid
 * UBL rather than modifying/skipping the XSD. Current SUNAT XSL is not run.
 * No HandlingCode/reason04 or synthetic private02 vehicle is copied to 31.
 * Empty ExtensionContent is the real signer's input slot, NOT an XSD bypass.
 */
function render(v: CarrierGuideInput, evidence: CarrierReference09Evidence): CarrierGuideXml {
  const b = v.body, t = b.transport, d = t.driver, r = b.reference09, fullNumber = `${v.series}-${v.number}`;
  const local = new Date(Date.parse(b.issueDate) - 5 * 60 * 60 * 1000).toISOString();
  const xml = `<?xml version="1.0" encoding="UTF-8"?><DespatchAdvice xmlns="urn:oasis:names:specification:ubl:schema:xsd:DespatchAdvice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions><cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:CustomizationID>2.0</cbc:CustomizationID><cbc:ID>${fullNumber}</cbc:ID><cbc:IssueDate>${local.slice(0, 10)}</cbc:IssueDate><cbc:IssueTime>${local.slice(11, 19)}</cbc:IssueTime><cbc:DespatchAdviceTypeCode listAgencyName="PE:SUNAT" listName="Tipo de Documento" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo01">31</cbc:DespatchAdviceTypeCode><cbc:Note>BETA LOCAL - CANDIDATO SIN FIRMA - SIN VALIDEZ TRIBUTARIA - NO AUTORIZA TRASLADO</cbc:Note><cac:AdditionalDocumentReference><cbc:ID>${r.series}-${r.number}</cbc:ID><cbc:DocumentTypeCode listAgencyName="PE:SUNAT" listName="Documento relacionado al transporte" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo61">09</cbc:DocumentTypeCode><cbc:DocumentType>Guía de remisión remitente</cbc:DocumentType><cac:IssuerParty>${identity(r.issuerRuc)}</cac:IssuerParty></cac:AdditionalDocumentReference><cac:Signature><cbc:ID>signatureFactuEz</cbc:ID><cac:SignatoryParty>${identity(v.issuer.ruc)}<cac:PartyName><cbc:Name>${fiscalXml(v.issuer.legalName)}</cbc:Name></cac:PartyName></cac:SignatoryParty><cac:DigitalSignatureAttachment><cac:ExternalReference><cbc:URI>#signatureFactuEz</cbc:URI></cac:ExternalReference></cac:DigitalSignatureAttachment></cac:Signature><cac:DespatchSupplierParty><cac:Party>${partyXml(v.issuer)}</cac:Party></cac:DespatchSupplierParty><cac:DeliveryCustomerParty><cac:Party>${partyXml(b.recipient)}</cac:Party></cac:DeliveryCustomerParty><cac:Shipment><cbc:ID>SUNAT_Envio</cbc:ID><cbc:GrossWeightMeasure unitCode="${b.weightUnit}">${b.grossWeight}</cbc:GrossWeightMeasure><cbc:SpecialInstructions>SUNAT_Envio_IndicadorTrasladoTotal</cbc:SpecialInstructions><cbc:SpecialInstructions>SUNAT_Envio_IndicadorPagadorFlete_Remitente</cbc:SpecialInstructions><cac:ShipmentStage><cac:TransitPeriod><cbc:StartDate>${b.transferDate}</cbc:StartDate></cac:TransitPeriod><cac:CarrierParty>${identity(t.carrier.ruc)}<cac:PartyLegalEntity><cbc:RegistrationName>${fiscalXml(t.carrier.legalName)}</cbc:RegistrationName><cbc:CompanyID>${t.carrier.mtcRegistration}</cbc:CompanyID></cac:PartyLegalEntity></cac:CarrierParty><cac:DriverPerson><cbc:ID schemeID="${d.identityType}" ${ID}>${d.identityNumber}</cbc:ID><cbc:FirstName>${fiscalXml(d.firstName)}</cbc:FirstName><cbc:FamilyName>${fiscalXml(d.lastName)}</cbc:FamilyName><cbc:JobTitle>Principal</cbc:JobTitle><cac:IdentityDocumentReference><cbc:ID>${d.license}</cbc:ID></cac:IdentityDocumentReference></cac:DriverPerson></cac:ShipmentStage><cac:Delivery><cac:DeliveryAddress>${addressXml(b.destination)}</cac:DeliveryAddress><cac:Despatch><cac:DespatchAddress>${addressXml(b.origin)}</cac:DespatchAddress><cac:DespatchParty>${partyXml(b.sender)}</cac:DespatchParty></cac:Despatch></cac:Delivery><cac:TransportHandlingUnit><cac:TransportEquipment><cbc:ID>${t.vehicle.plate}</cbc:ID><cac:ShipmentDocumentReference><cbc:ID>${t.vehicle.tuc}</cbc:ID></cac:ShipmentDocumentReference></cac:TransportEquipment></cac:TransportHandlingUnit></cac:Shipment>${b.items.map((item, i) => `<cac:DespatchLine><cbc:ID>${i + 1}</cbc:ID><cbc:DeliveredQuantity unitCode="${item.unitCode}" unitCodeListID="UN/ECE rec 20" unitCodeListAgencyName="United Nations Economic Commission for Europe">${item.quantity}</cbc:DeliveredQuantity><cac:OrderLineReference><cbc:LineID>${i + 1}</cbc:LineID></cac:OrderLineReference><cac:Item><cbc:Description>${fiscalXml(item.description)}</cbc:Description><cac:SellersItemIdentification><cbc:ID>${fiscalXml(item.code)}</cbc:ID></cac:SellersItemIdentification></cac:Item></cac:DespatchLine>`).join('')}</DespatchAdvice>`;
  return {
    xml, xmlSha256: createHash('sha256').update(xml, 'utf8').digest('hex'), profile: CARRIER_GUIDE31_PROFILE,
    companyId: v.companyId, branchId: v.branchId, documentId: v.documentId, operationId: v.operationId,
    issuerRuc: v.issuer.ruc, documentType: '31', fullNumber, snapshotSha256: v.snapshotSha256,
    reference09: { ...r }, referenceCdrSha256: evidence.acceptance.cdrSha256, referenceVerification: 'PRIVATE_OWNER_PORT',
    environment: 'BETA', candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false,
    authorizedForTransfer: false, officialRulesValidated: false,
  };
}

/** Server composition only: the owner port is a capability, never request data.
 * Rendering has no overload accepting a client boolean or caller-built proof.
 */
export function createCarrierGuide31Profile(owner: CarrierGuideReferenceOwnerPort) {
  if (!owner || typeof owner.loadAcceptedReference09 !== 'function') fail('CARRIER_GUIDE_REFERENCE_UNVERIFIED');
  const load = owner.loadAcceptedReference09.bind(owner);
  return Object.freeze({
    async buildXml(input: unknown): Promise<CarrierGuideXml> {
      const v = validateCarrierGuideInput(input), before = fiscalSnapshotSha256(v);
      const query: CarrierReference09OwnerQuery = {
        companyId: v.companyId, branchId: v.branchId, issuerRuc: v.issuer.ruc,
        documentId: v.documentId, operationId: v.operationId, snapshotSha256: v.snapshotSha256,
        asOf: v.body.issueDate, reference09: { ...v.body.reference09 },
      };
      Object.freeze(query.reference09); Object.freeze(query);
      let evidence: unknown;
      try { evidence = await load(query); }
      catch { return fail('CARRIER_GUIDE_REFERENCE_UNVERIFIED'); }
      // Revalidate executable inputs before hashing after the await, too.
      try { if (fiscalSnapshotSha256(validateCarrierGuideInput(input)) !== before) fail('CARRIER_GUIDE_INPUT_CHANGED'); }
      catch { return fail('CARRIER_GUIDE_INPUT_CHANGED'); }
      return render(v, verifyReference(v, evidence));
    },
  });
}
