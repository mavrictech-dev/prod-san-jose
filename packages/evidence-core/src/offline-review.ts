import { createHash, verify, X509Certificate } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { DOMParser, type Element } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';

/** Deliberately separate from SYNTHETIC and from fiscal transport/import ports.
 * Embedded certificates prove mathematical integrity only, never PKI authority.
 * This module has no I/O, DB, queue, signing, network or activation dependency. */
export const OFFLINE_REVIEW_POLICY = Object.freeze({
  environment: 'BETA', purpose: 'DIAGNOSTIC_ONLY', transmission: false,
  officialTrust: false, officialAcceptance: false, canEmit: false,
  canImportHistory: false, canChangeCounters: false, phase2Closed: false,
  phase3Closed: false, accountingApproved: false, cutoverAuthorized: false,
} as const);
export interface OfflineReviewScopeV1 {
  schemaVersion: 'factuez.offline-review-scope.v1';
  environment: 'BETA'; purpose: 'DIAGNOSTIC_ONLY';
  issuerRucs: readonly string[]; fromDate: string; toDate: string;
}
export class OfflineReviewError extends Error {
  constructor(readonly code: string) { super(`Revisión offline: ${code}`); }
}
const DS = 'http://www.w3.org/2000/09/xmldsig#';
const CBC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
const CAC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
const EXT = 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const C14N = ['http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
  'http://www.w3.org/TR/2001/REC-xml-c14n-20010315#WithComments',
  'http://www.w3.org/2001/10/xml-exc-c14n#', 'http://www.w3.org/2001/10/xml-exc-c14n#WithComments'];
const RSA: Record<string, string> = { [DS + 'rsa-sha1']: 'RSA-SHA1',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256': 'RSA-SHA256',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512': 'RSA-SHA512' };
const DIGEST = [DS + 'sha1', 'http://www.w3.org/2001/04/xmlenc#sha256',
  'http://www.w3.org/2001/04/xmlenc#sha512'];
function requireValue(ok: unknown, code: string): asserts ok { if (!ok) throw new OfflineReviewError(code); }
function plain(value: unknown): Record<string, unknown> {
  requireValue(value && typeof value === 'object' && !isProxy(value), 'INPUT_SHAPE');
  requireValue([Object.prototype, null].includes(Object.getPrototypeOf(value)), 'INPUT_SHAPE');
  const descriptors = Object.getOwnPropertyDescriptors(value), result = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    requireValue(typeof key === 'string' && 'value' in descriptors[key], 'INPUT_SHAPE');
    result[key] = descriptors[key].value;
  }
  return result;
}
function dateValid(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}
export function validateOfflineReviewScope(input: unknown): OfflineReviewScopeV1 {
  const s = plain(input);
  requireValue(Object.keys(s).sort().join(',') === 'environment,fromDate,issuerRucs,purpose,schemaVersion,toDate', 'SCOPE_FIELDS');
  requireValue(s.schemaVersion === 'factuez.offline-review-scope.v1' && s.environment === 'BETA' && s.purpose === 'DIAGNOSTIC_ONLY', 'SCOPE_BLOCKED');
  requireValue(Array.isArray(s.issuerRucs) && !isProxy(s.issuerRucs) && Object.getPrototypeOf(s.issuerRucs) === Array.prototype, 'SCOPE_RUCS');
  const descriptors = Object.getOwnPropertyDescriptors(s.issuerRucs);
  requireValue(Reflect.ownKeys(descriptors).every(k => typeof k === 'string' && 'value' in descriptors[k]), 'SCOPE_RUCS');
  requireValue(s.issuerRucs.length >= 1 && s.issuerRucs.length <= 20 &&
    Object.keys(s.issuerRucs).length === s.issuerRucs.length && s.issuerRucs.every(r => typeof r === 'string' && /^\d{11}$/.test(r)) &&
    new Set(s.issuerRucs).size === s.issuerRucs.length, 'SCOPE_RUCS');
  requireValue(dateValid(s.fromDate) && dateValid(s.toDate) && s.fromDate <= s.toDate, 'SCOPE_PERIOD');
  return { schemaVersion: 'factuez.offline-review-scope.v1', environment: 'BETA', purpose: 'DIAGNOSTIC_ONLY',
    issuerRucs: [...s.issuerRucs], fromDate: s.fromDate, toDate: s.toDate };
}
function children(parent: Element, ns?: string, name?: string): Element[] {
  const result: Element[] = [];
  for (let n = parent.firstChild; n; n = n.nextSibling)
    if (n.nodeType === 1 && (!ns || (n as Element).namespaceURI === ns) && (!name || (n as Element).localName === name)) result.push(n as Element);
  return result;
}
function one(parent: Element, ns: string, name: string, required = true): Element | null {
  const nodes = children(parent, ns, name);
  requireValue(nodes.length <= 1 && (!required || nodes.length === 1), 'XML_CARDINALITY');
  return nodes[0] ?? null;
}
function text(node: Element | null): string | null {
  if (!node) return null;
  requireValue(children(node).length === 0, 'XML_LEAF');
  const value = node.textContent ?? '';
  requireValue(value.length <= 4000 && value === value.trim(), 'XML_TEXT');
  return value;
}
const leaf = (parent: Element, name: string, required = true) => text(one(parent, CBC, name, required));
function parse(xml: unknown, kind: 'DespatchAdvice' | 'ApplicationResponse' | 'Invoice' | 'CreditNote' | 'DebitNote') {
  requireValue(typeof xml === 'string' && xml.length > 0 && Buffer.byteLength(xml) <= 2 * 1024 * 1024 &&
    !/<!DOCTYPE|<!ENTITY|<!--|<\?(?!xml\s)/i.test(xml) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(xml), 'XML_UNSAFE');
  // A UTF8 BOM is an encoding marker, not signed XML character data. Preserve
  // it for byte-hash evidence while presenting the XML infoset to the parser.
  const rawXml = xml, parserXml = xml.startsWith('\uFEFF') ? xml.slice(1) : xml;
  let doc;
  try { doc = new DOMParser({ onError: () => { throw new OfflineReviewError('XML_MALFORMED'); } }).parseFromString(parserXml, 'application/xml'); }
  catch { throw new OfflineReviewError('XML_MALFORMED'); }
  const root = doc.documentElement;
  requireValue(root?.localName === kind && root.namespaceURI === `urn:oasis:names:specification:ubl:schema:xsd:${kind}-2`, 'XML_ROOT');
  for (let n = doc.firstChild; n; n = n.nextSibling)
    requireValue(n === root || n.nodeType === 7 && n.nodeName === 'xml' || n.nodeType === 3 && !n.nodeValue?.trim(), 'XML_ROOT');
  const pending = [{ node: root, depth: 1 }], ids = new Map<string, Element>(); let count = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    requireValue(++count <= 15000 && depth <= 32 && node.attributes.length <= 32, 'XML_COMPLEXITY');
    for (let i = 0; i < node.attributes.length; i++) {
      const a = node.attributes.item(i)!;
      requireValue(!(a.namespaceURI === 'http://www.w3.org/XML/1998/namespace' && a.localName === 'base') &&
        a.namespaceURI !== 'http://www.w3.org/2001/XMLSchema-instance', 'XML_EXTERNAL_REFERENCE');
      if (['Id', 'id', 'ID'].includes(a.localName!)) {
        requireValue(a.value && !ids.has(a.value), 'XML_DUPLICATE_ID'); ids.set(a.value, node);
      }
    }
    requireValue(node.namespaceURI !== 'http://www.w3.org/2001/XInclude', 'XML_EXTERNAL_REFERENCE');
    for (let n = node.firstChild; n; n = n.nextSibling) {
      requireValue([1, 3, 4].includes(n.nodeType), 'XML_NODE_UNSUPPORTED');
      if (n.nodeType === 1) pending.push({ node: n as Element, depth: depth + 1 });
    }
  }
  return { doc, root, ids, xml: parserXml, rawXml };
}

/** Internal primitives for explicitly scoped offline diagnostics. Do not use
 * these to bypass the separate SYNTHETIC history/emission contracts. */
export const offlineXmlDiagnostics = Object.freeze({
  parse, children, one, text, leaf, withinScope, assessment, plain, requireValue,
});
function party(parent: Element, aggregate: string, nestedParty = true) {
  const p = one(parent, CAC, aggregate)!, entity = nestedParty ? one(p, CAC, 'Party')! : p;
  const identity = one(one(entity, CAC, 'PartyIdentification')!, CBC, 'ID')!;
  const legal = one(entity, CAC, 'PartyLegalEntity', false);
  return { identityType: identity.getAttribute('schemeID'), identityNumber: text(identity)!, legalName: legal ? leaf(legal, 'RegistrationName', false) : null };
}
function withinScope(ruc: string, issuedOn: string | null, scope: OfflineReviewScopeV1) {
  requireValue(scope.issuerRucs.includes(ruc), 'ISSUER_OUT_OF_SCOPE');
  requireValue(dateValid(issuedOn) && issuedOn >= scope.fromDate && issuedOn <= scope.toDate, 'DATE_OUT_OF_SCOPE');
}
export interface OfflineSignatureAssessment {
  status: 'MISSING' | 'INTEGRITY_VERIFIED_UNTRUSTED' | 'DIGEST_MISMATCH' | 'SIGNATURE_MISMATCH' | 'PROFILE_UNSUPPORTED';
  signatureValueVerified: boolean; referenceDigestVerified: boolean; wholeDocumentIntegrity: boolean;
  officialTrust: false; revocationChecked: false; certificateIdentityAuthorized: false;
  certificate?: { sha256: string; validFrom: string; validTo: string; keyBits: number; inDeclaredIssueDateWindow: boolean };
  algorithms?: { signature: string; digest: string; canonicalization: string; transforms: string[] };
  weakDigestObserved: boolean;
}
function assessment(parsed: ReturnType<typeof parse>, issueDate: string | null): OfflineSignatureAssessment {
  const result: OfflineSignatureAssessment = { status: 'MISSING', signatureValueVerified: false,
    referenceDigestVerified: false, wholeDocumentIntegrity: false, officialTrust: false,
    revocationChecked: false, certificateIdentityAuthorized: false, weakDigestObserved: false };
  const signatures = parsed.doc.getElementsByTagNameNS(DS, 'Signature');
  if (!signatures.length) return result;
  requireValue(signatures.length === 1, 'SIGNATURE_AMBIGUOUS');
  const signature = signatures[0];
  const extensions = one(parsed.root, EXT, 'UBLExtensions')!, extension = one(extensions, EXT, 'UBLExtension')!, content = one(extension, EXT, 'ExtensionContent')!;
  requireValue(signature.parentNode === content && children(content).length === 1, 'SIGNATURE_LOCATION');
  const info = one(signature, DS, 'SignedInfo')!, ref = one(info, DS, 'Reference')!;
  const method = one(info, DS, 'SignatureMethod')!, cm = one(info, DS, 'CanonicalizationMethod')!;
  const dm = one(ref, DS, 'DigestMethod')!, t = one(ref, DS, 'Transforms')!;
  const transforms = children(t).map(n => n.getAttribute('Algorithm') ?? '');
  const ca = cm.getAttribute('Algorithm') ?? '', sa = method.getAttribute('Algorithm') ?? '', da = dm.getAttribute('Algorithm') ?? '';
  const uri = ref.getAttribute('URI');
  requireValue(uri === '' || typeof uri === 'string' && /^#[A-Za-z_][A-Za-z0-9_.-]*$/.test(uri) && parsed.ids.get(uri.slice(1)) === parsed.root, 'SIGNATURE_REFERENCE');
  result.algorithms = { signature: sa, digest: da, canonicalization: ca, transforms };
  result.weakDigestObserved = da === DS + 'sha1' || sa === DS + 'rsa-sha1';
  const allowed = C14N.includes(ca) && Object.hasOwn(RSA, sa) && DIGEST.includes(da) &&
    transforms.length >= 1 && transforms.length <= 2 && transforms[0] === DS + 'enveloped-signature' &&
    (transforms.length === 1 || C14N.includes(transforms[1])) &&
    children(cm).length === 0 && children(method).length === 0 && children(dm).length === 0 &&
    children(t).every(n => n.namespaceURI === DS && n.localName === 'Transform' && !children(n).length);
  if (!allowed) { result.status = 'PROFILE_UNSUPPORTED'; return result; }
  const digestValue = text(one(ref, DS, 'DigestValue'))!.replace(/\s/g, '');
  const digestBytes = da === DS + 'sha1' ? 20 : da.endsWith('sha256') ? 32 : 64;
  requireValue(/^[A-Za-z0-9+/]+={0,2}$/.test(digestValue) && Buffer.from(digestValue, 'base64').length === digestBytes &&
    Buffer.from(digestValue, 'base64').toString('base64') === digestValue, 'DIGEST_ENCODING');
  const certNodes = signature.getElementsByTagNameNS(DS, 'X509Certificate');
  if (certNodes.length !== 1) { result.status = 'PROFILE_UNSUPPORTED'; return result; }
  const keyInfo = one(signature, DS, 'KeyInfo')!, data = one(keyInfo, DS, 'X509Data')!;
  requireValue(certNodes[0].parentNode === data, 'CERTIFICATE_LOCATION');
  const encoded = text(certNodes[0])!.replace(/\s/g, '');
  requireValue(encoded.length <= 24000 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded), 'CERTIFICATE_ENCODING');
  let cert: X509Certificate;
  try { cert = new X509Certificate(Buffer.from(encoded, 'base64')); } catch { throw new OfflineReviewError('CERTIFICATE_ENCODING'); }
  const bits = cert.publicKey.asymmetricKeyDetails?.modulusLength ?? 0;
  if (cert.publicKey.asymmetricKeyType !== 'rsa' || bits < 2048 || bits > 4096) { result.status = 'PROFILE_UNSUPPORTED'; return result; }
  result.certificate = { sha256: createHash('sha256').update(cert.raw).digest('hex'), validFrom: new Date(cert.validFrom).toISOString(),
    validTo: new Date(cert.validTo).toISOString(), keyBits: bits,
    inDeclaredIssueDateWindow: dateValid(issueDate) && issueDate >= new Date(cert.validFrom).toISOString().slice(0, 10) && issueDate <= new Date(cert.validTo).toISOString().slice(0, 10) };
  const sigValue = text(one(signature, DS, 'SignatureValue'))!.replace(/\s/g, '');
  requireValue(sigValue.length <= 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(sigValue), 'SIGNATURE_ENCODING');
  const namespaces = new Map<string, string>();
  for (let node = info.parentNode; node?.nodeType === 1; node = node.parentNode) {
    const attrs = (node as Element).attributes;
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs.item(i)!;
      if (a.namespaceURI === XMLNS) { const prefix = a.name === 'xmlns' ? '' : a.localName!; if (!namespaces.has(prefix)) namespaces.set(prefix, a.value); }
    }
  }
  const verifier = new SignedXml({ publicCert: cert.toString(), getCertFromKeyInfo: () => null });
  verifier.loadSignature(signature);
  const canonicalInfo = verifier.getCanonXml([ca], info, { ancestorNamespaces: [...namespaces].map(([prefix, namespaceURI]) => ({ prefix, namespaceURI })) });
  result.signatureValueVerified = verify(RSA[sa], Buffer.from(canonicalInfo), cert.publicKey, Buffer.from(sigValue, 'base64'));
  let valid = false;
  try { valid = verifier.checkSignature(parsed.xml); } catch { /* Never return raw crypto errors, XML or signature bytes. */ }
  result.referenceDigestVerified = verifier.getReferences().length === 1 && !verifier.getReferences()[0].validationError;
  result.wholeDocumentIntegrity = valid && result.signatureValueVerified && result.referenceDigestVerified && verifier.getSignedReferences().length === 1;
  result.status = result.wholeDocumentIntegrity ? 'INTEGRITY_VERIFIED_UNTRUSTED' : !result.referenceDigestVerified ? 'DIGEST_MISMATCH' : 'SIGNATURE_MISMATCH';
  return result;
}
/** Guide-specific diagnostic snapshot, not a Document insert contract. */
export function inspectOfflineGuide(xml: unknown, scopeInput: unknown) {
  const scope = validateOfflineReviewScope(scopeInput), parsed = parse(xml, 'DespatchAdvice'), root = parsed.root;
  requireValue(leaf(root, 'UBLVersionID') === '2.1' && leaf(root, 'CustomizationID') === '2.0', 'GUIDE_VERSION');
  const type = leaf(root, 'DespatchAdviceTypeCode'); requireValue(type === '09' || type === '31', 'GUIDE_TYPE');
  const number = leaf(root, 'ID')!, issueDate = leaf(root, 'IssueDate')!, issueTime = leaf(root, 'IssueTime', false);
  requireValue(new RegExp(`^${type === '31' ? 'V' : 'T'}[A-Z0-9]{3}-[0-9]{1,8}$`).test(number) && !/-0+$/.test(number), 'GUIDE_NUMBER');
  requireValue(issueTime === null || /^(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.\d{1,3})?$/.test(issueTime), 'GUIDE_TIME');
  const issuer = party(root, 'DespatchSupplierParty'); requireValue(issuer.identityType === '6' && /^\d{11}$/.test(issuer.identityNumber), 'GUIDE_ISSUER');
  withinScope(issuer.identityNumber, issueDate, scope);
  const shipment = one(root, CAC, 'Shipment')!, weight = one(shipment, CBC, 'GrossWeightMeasure', false);
  if (weight) requireValue(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(text(weight) ?? '') &&
    ['KGM', 'TNE'].includes(weight.getAttribute('unitCode') ?? ''), 'GUIDE_WEIGHT');
  const partyOptional = (parent: Element, name: string, nestedParty = true) => one(parent, CAC, name, false) ? party(parent, name, nestedParty) : null;
  const address = (parent: Element, name: string) => {
    const a = one(parent, CAC, name, false); if (!a) return null;
    const line = one(a, CAC, 'AddressLine', false), ubigeo = leaf(a, 'ID', false);
    requireValue(ubigeo === null || /^\d{6}$/.test(ubigeo), 'GUIDE_UBIGEO');
    return { ubigeo, address: line ? leaf(line, 'Line') : null };
  };
  const stageElements = children(shipment, CAC, 'ShipmentStage'); requireValue(stageElements.length <= 10, 'GUIDE_STAGES');
  const stages = stageElements.map(stage => {
    const carrier = one(stage, CAC, 'CarrierParty', false), legal = carrier ? one(carrier, CAC, 'PartyLegalEntity', false) : null;
    const transit = one(stage, CAC, 'TransitPeriod', false), startDate = transit ? leaf(transit, 'StartDate', false) : null;
    requireValue(startDate === null || dateValid(startDate), 'GUIDE_TRANSIT_DATE');
    const drivers = children(stage, CAC, 'DriverPerson'); requireValue(drivers.length <= 10, 'GUIDE_DRIVERS');
    return { transportModeCode: leaf(stage, 'TransportModeCode', false), transitStartDate: startDate,
      carrierRegistrationNumber: legal ? leaf(legal, 'CompanyID', false) : null,
      drivers: drivers.map(d => {
        const license = one(d, CAC, 'IdentityDocumentReference', false);
        return { identityNumber: leaf(d, 'ID'), firstName: leaf(d, 'FirstName', false), familyName: leaf(d, 'FamilyName', false),
          role: leaf(d, 'JobTitle', false), licenseNumber: license ? leaf(license, 'ID') : null };
      }) };
  });
  const delivery = one(shipment, CAC, 'Delivery', false), despatch = delivery ? one(delivery, CAC, 'Despatch', false) : null;
  const handling = children(shipment, CAC, 'TransportHandlingUnit'); requireValue(handling.length <= 20, 'GUIDE_VEHICLES');
  const vehicles = handling.flatMap(h => children(h, CAC, 'TransportEquipment')).map(v => ({ plate: leaf(v, 'ID') }));
  requireValue(vehicles.length <= 20, 'GUIDE_VEHICLES');
  const indicators = children(shipment, CBC, 'SpecialInstructions').map(n => text(n)!); requireValue(indicators.length <= 20, 'GUIDE_INDICATORS');
  const shipmentProjection = { shipmentId: leaf(shipment, 'ID'), indicators, stages, vehicles,
    origin: despatch ? address(despatch, 'DespatchAddress') : null,
    destination: delivery ? address(delivery, 'DeliveryAddress') : null,
    despatchParty: despatch ? partyOptional(despatch, 'DespatchParty', false) : null };
  const lines = children(root, CAC, 'DespatchLine'); requireValue(lines.length >= 1 && lines.length <= 1000, 'GUIDE_ITEMS');
  const lineIds = new Set<string>();
  const items = lines.map(n => {
    const id = leaf(n, 'ID')!, q = one(n, CBC, 'DeliveredQuantity')!, item = one(n, CAC, 'Item')!, product = one(item, CAC, 'SellersItemIdentification', false);
    requireValue(/^\d{1,6}$/.test(id) && !lineIds.has(id), 'GUIDE_LINE_ID'); lineIds.add(id);
    const quantity = text(q)!;
    requireValue(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(quantity) && !/^0(?:\.0+)?$/.test(quantity), 'GUIDE_QUANTITY');
    requireValue(/^[A-Z0-9]{2,3}$/.test(q.getAttribute('unitCode') ?? ''), 'GUIDE_UNIT');
    return { lineId: id, productCode: product ? leaf(product, 'ID') : null, description: leaf(item, 'Description'), quantity, unitCode: q.getAttribute('unitCode')! };
  });
  const signature = assessment(parsed, issueDate);
  return { schemaVersion: 'factuez.offline-guide-evidence.v1' as const, ...OFFLINE_REVIEW_POLICY,
    rawSha256: createHash('sha256').update(parsed.rawXml).digest('hex'), signature,
    projection: { documentTypeCode: type, fullNumber: number, issueDate, issueTime, issuer,
      deliveryCustomer: partyOptional(root, 'DeliveryCustomerParty'), buyerCustomer: partyOptional(root, 'BuyerCustomerParty'), items, shipment: shipmentProjection,
      grossWeight: weight ? { value: text(weight), unitCode: weight.getAttribute('unitCode') } : null },
    mappingCompleteness: 'PARTIAL_DIAGNOSTIC' as const, xsdVerified: false, businessRulesVerified: false,
    notMapped: ['ownership.station', 'ownership.emissionPoint', 'seriesAuthorization', 'originDatabaseId',
      'completeShipmentSnapshot', 'completeVehicleDriverSnapshot', 'certificateAuthorization', 'trustedCdr'],
  };
}
export function inspectOfflineCdr(xml: unknown, scopeInput: unknown) {
  const scope = validateOfflineReviewScope(scopeInput), parsed = parse(xml, 'ApplicationResponse'), root = parsed.root;
  const version = leaf(root, 'UBLVersionID')!, customization = leaf(root, 'CustomizationID')!;
  requireValue(['2.0', '2.1'].includes(version) && ['1.0', '2.0'].includes(customization), 'CDR_VERSION');
  const sender = party(root, 'SenderParty', false), receiver = party(root, 'ReceiverParty', false), issueDate = leaf(root, 'IssueDate')!;
  requireValue(/^\d{11}$/.test(sender.identityNumber) && /^\d{11}$/.test(receiver.identityNumber), 'CDR_PARTY');
  withinScope(receiver.identityNumber, issueDate, scope);
  const responses = children(root, CAC, 'DocumentResponse'); requireValue(responses.length === 1, 'CDR_RESPONSE_COUNT');
  const response = one(responses[0], CAC, 'Response')!, reference = one(responses[0], CAC, 'DocumentReference')!;
  const code = leaf(response, 'ResponseCode')!; requireValue(/^\d{1,5}$/.test(code), 'CDR_CODE');
  const notes = [...children(root, CBC, 'Note'), ...children(response, CBC, 'Note')]; requireValue(notes.length <= 100, 'CDR_NOTES');
  const signature = assessment(parsed, issueDate);
  const projection = { senderRuc: sender.identityNumber, receiverRuc: receiver.identityNumber, issueDate,
    reference: leaf(reference, 'ID')!, responseReference: leaf(response, 'ReferenceID', false),
    documentTypeCode: leaf(reference, 'DocumentTypeCode', false), responseCode: code,
    description: leaf(response, 'Description'), notes: notes.map(n => text(n)!),
    reportedResult: code === '0' ? notes.length ? 'REPORTED_ACCEPTED_WITH_OBSERVATIONS' : 'REPORTED_ACCEPTED' : 'REPORTED_NON_ACCEPTANCE' };
  return { schemaVersion: 'factuez.offline-cdr-evidence.v1' as const, ...OFFLINE_REVIEW_POLICY,
    rawSha256: createHash('sha256').update(parsed.rawXml).digest('hex'), signature, projection,
    contentAuthenticated: signature.wholeDocumentIntegrity, senderClaimsSunat: sender.identityNumber === '20131312955',
    warningCodes: notes.map(n => /^\d{4}\b/.exec(text(n)!)?.[0] ?? null), xsdVerified: false };
}
export function reviewOfflineGuidePair(input: unknown) {
  const i = plain(input);
  requireValue(Object.keys(i).sort().join(',') === 'cdrXml,documentXml,scope', 'PAIR_FIELDS');
  const guide = inspectOfflineGuide(i.documentXml, i.scope), cdr = inspectOfflineCdr(i.cdrXml, i.scope);
  const bindings = { issuerMatches: guide.projection.issuer.identityNumber === cdr.projection.receiverRuc,
    referenceMatches: guide.projection.fullNumber === cdr.projection.reference &&
      (cdr.projection.responseReference === null || cdr.projection.responseReference === guide.projection.fullNumber),
    documentTypeMatches: cdr.projection.documentTypeCode === null ? null : cdr.projection.documentTypeCode === guide.projection.documentTypeCode };
  const issues: string[] = [];
  if (!bindings.issuerMatches) issues.push('CDR_OTHER_ISSUER');
  if (!bindings.referenceMatches) issues.push('CDR_OTHER_DOCUMENT');
  if (bindings.documentTypeMatches === false) issues.push('CDR_OTHER_TYPE');
  if (bindings.documentTypeMatches === null) issues.push('CDR_TYPE_NOT_DECLARED');
  if (!guide.signature.wholeDocumentIntegrity) issues.push('GUIDE_' + guide.signature.status);
  if (!cdr.signature.wholeDocumentIntegrity) issues.push('CDR_' + cdr.signature.status);
  if (guide.signature.weakDigestObserved || cdr.signature.weakDigestObserved) issues.push('LEGACY_SHA1_OBSERVED');
  issues.push('PKI_AND_SIGNER_AUTHORIZATION_NOT_VERIFIED', 'PARTIAL_SNAPSHOT_NOT_IMPORTABLE');
  return { schemaVersion: 'factuez.offline-guide-review.v1' as const, ...OFFLINE_REVIEW_POLICY, guide, cdr, bindings, issues,
    cryptographicPairBound: guide.signature.wholeDocumentIntegrity && cdr.signature.wholeDocumentIntegrity &&
      bindings.issuerMatches && bindings.referenceMatches && bindings.documentTypeMatches !== false,
    typeBindingVerified: bindings.documentTypeMatches === true };
}

/** Phase-3 preflight only. Source IDs must be supplied from a separately
 * authorized export; they are never inferred from filenames or fiscal maxima. */
export function reviewOfflineGuideInventory(input: unknown) {
  const i = plain(input);
  requireValue(Object.keys(i).sort().join(',') === 'entries,schemaVersion,scope' &&
    i.schemaVersion === 'factuez.offline-guide-inventory.v1', 'INVENTORY_FIELDS');
  const scope = validateOfflineReviewScope(i.scope);
  requireValue(Array.isArray(i.entries) && !isProxy(i.entries) && Object.getPrototypeOf(i.entries) === Array.prototype &&
    i.entries.length > 0 && i.entries.length <= 20, 'INVENTORY_LIMIT');
  const descriptors = Object.getOwnPropertyDescriptors(i.entries);
  requireValue(Reflect.ownKeys(descriptors).every(k => typeof k === 'string' && 'value' in descriptors[k]) &&
    Object.keys(i.entries).length === i.entries.length, 'INVENTORY_SHAPE');
  const origins = new Set<string>(), fiscal = new Map<string, string>();
  const findings: { row: number; code: string }[] = [];
  let totalBytes = 0;
  const summaries = i.entries.map((entry, row) => {
    const e = plain(entry);
    requireValue(Object.keys(e).sort().join(',') === 'cdrXml,documentXml,originRecordId,originSystem', 'INVENTORY_ENTRY');
    requireValue(typeof e.originSystem === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(e.originSystem) &&
      typeof e.originRecordId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(e.originRecordId), 'ORIGIN_ID');
    requireValue(typeof e.documentXml === 'string' && typeof e.cdrXml === 'string', 'INVENTORY_ENTRY');
    totalBytes += Buffer.byteLength(e.documentXml) + Buffer.byteLength(e.cdrXml);
    requireValue(totalBytes <= 16 * 1024 * 1024, 'INVENTORY_BYTES');
    const r = reviewOfflineGuidePair({ scope, documentXml: e.documentXml, cdrXml: e.cdrXml });
    const p = r.guide.projection, [series, number] = p.fullNumber.split('-');
    const fiscalKey = `${p.issuer.identityNumber}:${p.documentTypeCode}:${series}:${BigInt(number)}`;
    const originKey = JSON.stringify([e.originSystem, e.originRecordId]);
    if (origins.has(originKey)) findings.push({ row: row + 1, code: 'DUPLICATE_ORIGIN' });
    origins.add(originKey);
    if (fiscal.has(fiscalKey)) findings.push({ row: row + 1, code: fiscal.get(fiscalKey) === r.guide.rawSha256 ? 'DUPLICATE_FISCAL' : 'CONFLICTING_FISCAL_XML' });
    else fiscal.set(fiscalKey, r.guide.rawSha256);
    if (!r.cryptographicPairBound) findings.push({ row: row + 1, code: 'PAIR_INTEGRITY_OR_BINDING_FAILED' });
    if (!r.typeBindingVerified) findings.push({ row: row + 1, code: 'CDR_TYPE_NOT_BOUND' });
    return { row: row + 1, fiscalKey, guideSha256: r.guide.rawSha256, cdrSha256: r.cdr.rawSha256,
      lineCount: p.items.length, guideIntegrity: r.guide.signature.status, cdrIntegrity: r.cdr.signature.status };
  });
  return { schemaVersion: 'factuez.offline-guide-inventory-report.v1' as const, ...OFFLINE_REVIEW_POLICY,
    rowCount: summaries.length, uniqueFiscalCount: fiscal.size, uniqueOriginCount: origins.size,
    findings, summaries, metadataChecksPassed: findings.length === 0,
    missingApprovals: ['AUTHORIZED_COMPLETE_EXPORT', 'CONFIRMED_OWNERSHIP_MAP', 'FULL_SNAPSHOT_BINDING',
      'PKI_TRUST_AND_REVOCATION', 'ACCOUNTING_RECONCILIATION', 'BACKUP_RESTORE_REHEARSAL', 'CUTOVER_ACT'],
    notAnImportManifest: true as const };
}
