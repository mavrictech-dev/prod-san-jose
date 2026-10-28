import type { FrozenPrintPresentationV1 } from '@factuez/contracts';
/** GRE remitente: perfil LOCAL acotado al motivo 04, no certificado ni aceptación fiscal. */
export const GRE_QA_PROFILE = 'GRE-QA-09-MOTIVO04-v1';
export const GRE_QA_WARNING = 'PRUEBA LOCAL · SIN VALIDEZ TRIBUTARIA · NO AUTORIZA TRASLADO';
export const GRE_QA_UBIGEOS = Object.freeze({ '150101': 'Lima', '150102': 'Ancón', '150103': 'Ate', '150104': 'Barranco', '150122': 'Miraflores', '070101': 'Callao' });
export const GRE_QA_UNITS = ['NIU', 'LTR', 'GLL', 'KGM'] as const;
export type GreQaAddress = { branchId: string; ubigeo: string; address: string; establishmentCode: string };
export type GreQaItem = { code: string; description: string; quantity: string; unitCode: typeof GRE_QA_UNITS[number] };
export type GreQaInput = {
  companyId: number; origin: GreQaAddress; destination: GreQaAddress; reasonCode: '04';
  transferDate: string; grossWeight: string; weightUnit: 'KGM' | 'TNE'; nonRegulatedGoods: true;
  transport: { mode: '01'; carrierRuc: string; carrierName: string; mtcRegistration: string }
    | { mode: '02'; plate: string; driverDni: string; driverFirstName: string; driverLastName: string; driverLicense: string };
  items: GreQaItem[];
};
export type GreQaSnapshot = GreQaInput & {
  id: string; localIdentifier: string; ublNumber: string; issueDate: string; issueTime: string;
  issuer: { ruc: string; legalName: string }; profile: typeof GRE_QA_PROFILE; environment: 'BETA';
  branchId?: string; printPresentation?: FrozenPrintPresentationV1;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fail(message: string): never { throw new Error(message); }
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail('Campos GRE fuera del perfil local');
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff\ufffe\uffff]/u.test(value)) fail(`Revise ${label}`);
  return value.trim();
}
function decimal(value: unknown, label: string, scale: number) {
  if (typeof value !== 'string' || !new RegExp(`^(0|[1-9]\\d{0,11})(\\.\\d{1,${scale}})?$`).test(value) || BigInt(value.replace('.', '')) <= 0n) fail(`Revise ${label}: número decimal positivo sin exponentes`);
  return value;
}
function address(value: unknown): GreQaAddress {
  const v = record(value, ['branchId', 'ubigeo', 'address', 'establishmentCode']);
  if (typeof v.branchId !== 'string' || !UUID.test(v.branchId)) fail('Sede GRE inválida');
  if (typeof v.ubigeo !== 'string' || !Object.hasOwn(GRE_QA_UBIGEOS, v.ubigeo)) fail('Ubigeo fuera del catálogo QA acotado');
  if (typeof v.establishmentCode !== 'string' || !/^\d{4}$/.test(v.establishmentCode)) fail('Código de establecimiento debe tener cuatro dígitos');
  return { branchId: v.branchId, ubigeo: v.ubigeo, address: text(v.address, 'dirección', 500), establishmentCode: v.establishmentCode };
}
export function validateGreQaInput(value: unknown, issueDate: string): GreQaInput {
  const v = record(value, ['companyId','origin','destination','reasonCode','transferDate','grossWeight','weightUnit','nonRegulatedGoods','transport','items']);
  if (!Number.isSafeInteger(v.companyId) || Number(v.companyId) < 1) fail('Emisor GRE inválido');
  if (v.reasonCode !== '04') fail('Sólo motivo 04: traslado entre establecimientos de la misma empresa');
  if (v.nonRegulatedGoods !== true) fail('Perfil QA no cubre combustibles/bienes fiscalizados ni autorizaciones especiales');
  if (typeof v.transferDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.transferDate) || !Number.isFinite(Date.parse(`${v.transferDate}T00:00:00Z`)) || new Date(`${v.transferDate}T00:00:00Z`).toISOString().slice(0,10) !== v.transferDate || v.transferDate < issueDate) fail('Fecha de traslado inválida o anterior a la emisión');
  if (v.weightUnit !== 'KGM' && v.weightUnit !== 'TNE') fail('Peso: sólo KGM o TNE');
  const origin = address(v.origin), destination = address(v.destination);
  if (origin.branchId === destination.branchId || origin.establishmentCode === destination.establishmentCode) fail('Seleccione dos establecimientos distintos del mismo emisor');
  const t = record(v.transport, ['mode','carrierRuc','carrierName','mtcRegistration','plate','driverDni','driverFirstName','driverLastName','driverLicense']);
  let transport: GreQaInput['transport'];
  if (t.mode === '01') {
    if (Object.keys(t).some(key => !['mode','carrierRuc','carrierName','mtcRegistration'].includes(key)) || typeof t.carrierRuc !== 'string' || !/^00\d{9}$/.test(t.carrierRuc)) fail('Transporte público QA requiere RUC transportista ficticio 00…; no mezclar datos privados');
    const mtcRegistration = text(t.mtcRegistration, 'registro MTC', 20);
    if (!/^[A-Za-z0-9-]+$/.test(mtcRegistration)) fail('Registro MTC inválido');
    transport = { mode: '01', carrierRuc: t.carrierRuc, carrierName: text(t.carrierName, 'transportista', 250), mtcRegistration };
  } else if (t.mode === '02') {
    if (Object.keys(t).some(key => !['mode','plate','driverDni','driverFirstName','driverLastName','driverLicense'].includes(key)) || typeof t.plate !== 'string' || !/^[A-Z0-9]{6}$/.test(t.plate) || typeof t.driverDni !== 'string' || !/^\d{8}$/.test(t.driverDni) || typeof t.driverLicense !== 'string' || !/^[A-Z0-9]{1,10}$/.test(t.driverLicense)) fail('Transporte privado: placa sin guion, DNI y licencia obligatorios');
    transport = { mode: '02', plate: t.plate, driverDni: t.driverDni, driverLicense: t.driverLicense, driverFirstName: text(t.driverFirstName, 'nombres del conductor ficticio', 100), driverLastName: text(t.driverLastName, 'apellidos del conductor ficticio', 100) };
  } else fail('Modalidad GRE fuera del perfil: público 01 o privado 02');
  if (!Array.isArray(v.items) || !v.items.length || v.items.length > 50) fail('GRE requiere entre 1 y 50 ítems');
  const codes = new Set<string>();
  const items = v.items.map(raw => {
    const item = record(raw, ['code','description','quantity','unitCode']);
    const code = text(item.code, 'código de ítem', 30);
    if (!/^[A-Za-z0-9_-]+$/.test(code) || codes.has(code)) fail('Código de ítem inválido o duplicado'); codes.add(code);
    if (!GRE_QA_UNITS.includes(item.unitCode as typeof GRE_QA_UNITS[number])) fail('Unidad GRE fuera del catálogo local');
    return { code, description: text(item.description, 'descripción de ítem', 500), quantity: decimal(item.quantity, 'cantidad', 10), unitCode: item.unitCode as typeof GRE_QA_UNITS[number] };
  });
  return { companyId: Number(v.companyId), origin, destination, reasonCode: '04', transferDate: v.transferDate, grossWeight: decimal(v.grossWeight, 'peso bruto', 3), weightUnit: v.weightUnit, nonRegulatedGoods: true, transport, items };
}
const escape = (s: string) => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const idAttrs = 'schemeName="Documento de Identidad" schemeAgencyName="PE:SUNAT" schemeURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo06"';
/** Sin firma: integrar el worker GRE con XmlSignerService rootKind=DespatchAdvice. */
export function buildGreQaUbl(snapshot: GreQaSnapshot) {
  const { issuer } = snapshot;
  const { id, localIdentifier, ublNumber, issueDate, issueTime, profile, environment, issuer: _issuer,
    branchId: _printBranchId, printPresentation: _presentation, ...input } = snapshot;
  const v = validateGreQaInput(input, issueDate);
  if (!UUID.test(id) || localIdentifier !== `GRE-QA-${id}` || !/^TQ00-[1-9]\d{0,7}$/.test(ublNumber) || !/^00\d{9}$/.test(issuer.ruc) || text(issuer.legalName,'razón social',250) !== issuer.legalName || !/^\d{4}-\d{2}-\d{2}$/.test(issueDate) || !/^\d{2}:\d{2}:\d{2}$/.test(issueTime) || profile !== GRE_QA_PROFILE || environment !== 'BETA') fail('Cabecera GRE QA inválida');
  const party = `<cac:Party><cac:PartyIdentification><cbc:ID schemeID="6" ${idAttrs}>${issuer.ruc}</cbc:ID></cac:PartyIdentification><cac:PartyLegalEntity><cbc:RegistrationName>${escape(issuer.legalName)}</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party>`;
  const addressXml = (a: GreQaAddress) => `<cbc:ID schemeAgencyName="PE:INEI" schemeName="Ubigeos">${a.ubigeo}</cbc:ID><cbc:AddressTypeCode listID="${issuer.ruc}" listAgencyName="PE:SUNAT" listName="Establecimientos anexos">${a.establishmentCode}</cbc:AddressTypeCode><cac:AddressLine><cbc:Line>${escape(a.address)}</cbc:Line></cac:AddressLine>`;
  const t = v.transport;
  const carrier = t.mode === '01' ? `<cac:CarrierParty><cac:PartyIdentification><cbc:ID schemeID="6" ${idAttrs}>${t.carrierRuc}</cbc:ID></cac:PartyIdentification><cac:PartyLegalEntity><cbc:RegistrationName>${escape(t.carrierName)}</cbc:RegistrationName><cbc:CompanyID>${escape(t.mtcRegistration)}</cbc:CompanyID></cac:PartyLegalEntity></cac:CarrierParty>` : '';
  const driver = t.mode === '02' ? `<cac:DriverPerson><cbc:ID schemeID="1" ${idAttrs}>${t.driverDni}</cbc:ID><cbc:FirstName>${escape(t.driverFirstName)}</cbc:FirstName><cbc:FamilyName>${escape(t.driverLastName)}</cbc:FamilyName><cbc:JobTitle>Principal</cbc:JobTitle><cac:IdentityDocumentReference><cbc:ID>${t.driverLicense}</cbc:ID></cac:IdentityDocumentReference></cac:DriverPerson>` : '';
  const vehicle = t.mode === '02' ? `<cac:TransportHandlingUnit><cac:TransportEquipment><cbc:ID>${t.plate}</cbc:ID></cac:TransportEquipment></cac:TransportHandlingUnit>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?><DespatchAdvice xmlns="urn:oasis:names:specification:ubl:schema:xsd:DespatchAdvice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"><ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions><cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:CustomizationID>2.0</cbc:CustomizationID><cbc:ID>${ublNumber}</cbc:ID><cbc:IssueDate>${issueDate}</cbc:IssueDate><cbc:IssueTime>${issueTime}</cbc:IssueTime><cbc:DespatchAdviceTypeCode listAgencyName="PE:SUNAT" listName="Tipo de Documento" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo01">09</cbc:DespatchAdviceTypeCode><cbc:Note>${GRE_QA_WARNING} · ${localIdentifier}</cbc:Note><cac:DespatchSupplierParty>${party}</cac:DespatchSupplierParty><cac:DeliveryCustomerParty>${party}</cac:DeliveryCustomerParty><cac:Shipment><cbc:ID>SUNAT_Envio</cbc:ID><cbc:HandlingCode listAgencyName="PE:SUNAT" listName="Motivo de traslado" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogoD05">04</cbc:HandlingCode><cbc:HandlingInstructions>Traslado entre establecimientos de la misma empresa</cbc:HandlingInstructions><cbc:GrossWeightMeasure unitCode="${v.weightUnit}">${v.grossWeight}</cbc:GrossWeightMeasure><cac:ShipmentStage><cbc:TransportModeCode listAgencyName="PE:SUNAT" listName="Modalidad de traslado" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo18">${t.mode}</cbc:TransportModeCode><cac:TransitPeriod><cbc:StartDate>${v.transferDate}</cbc:StartDate></cac:TransitPeriod>${carrier}${driver}</cac:ShipmentStage><cac:Delivery><cac:DeliveryAddress>${addressXml(v.destination)}</cac:DeliveryAddress><cac:Despatch><cac:DespatchAddress>${addressXml(v.origin)}</cac:DespatchAddress></cac:Despatch></cac:Delivery>${vehicle}</cac:Shipment>${v.items.map((item,i) => `<cac:DespatchLine><cbc:ID>${i+1}</cbc:ID><cbc:DeliveredQuantity unitCode="${item.unitCode}" unitCodeListID="UN/ECE rec 20" unitCodeListAgencyName="United Nations Economic Commission for Europe">${item.quantity}</cbc:DeliveredQuantity><cac:OrderLineReference><cbc:LineID>${i+1}</cbc:LineID></cac:OrderLineReference><cac:Item><cbc:Description>${escape(item.description)}</cbc:Description><cac:SellersItemIdentification><cbc:ID>${escape(item.code)}</cbc:ID></cac:SellersItemIdentification></cac:Item></cac:DespatchLine>`).join('')}</DespatchAdvice>`;
}
