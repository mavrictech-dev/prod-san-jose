import { createHash, X509Certificate } from 'node:crypto';
import { types } from 'node:util';
import { DOMParser, type Element, type Node } from '@xmldom/xmldom';
import forge from 'node-forge';
import { SignedXml } from 'xml-crypto';

export type SyntheticXmlRootKind = 'Invoice' | 'CreditNote' | 'DebitNote' | 'ApplicationResponse';
export interface SyntheticScope { environment: 'BETA'; datasetClass: 'SYNTHETIC' }
export interface SyntheticXmlSignatureInput extends SyntheticScope {
  xml: string;
  certificatePem: string;
  expectedUnsignedXml: string;
  rootKind: SyntheticXmlRootKind;
}
export interface SyntheticXmlSignatureResult {
  authenticatedXml: string;
  digestValue: string;
  signatureVerified: true;
  officialTrust: false;
}
export interface SyntheticCertificateInput extends SyntheticScope {
  certificatePem: string;
  rootCertificatePem: string;
  /** SHA-256 of root DER, exactly 64 lowercase hexadecimal characters. */
  pinnedRootSha256: string;
  issuerRuc: string;
  /** Strict UTC ISO timestamp, seconds with optional three-digit milliseconds. */
  checkedAt: string;
}
export interface SyntheticCertificateResult {
  validity: {
    valid: true;
    checkedAt: string;
    notBefore: string;
    notAfter: string;
    rootNotBefore: string;
    rootNotAfter: string;
  };
  issuerRuc: string;
  certificateFingerprintSha256: string;
  rootFingerprintSha256: string;
  chainSignatureVerified: true;
  keyUsageVerified: true;
  caVerified: true;
  algorithm: 'RSA_SHA256';
  keySizeBits: number;
  rootKeySizeBits: number;
  revocationStatus: 'NOT_CHECKED';
  officialTrust: false;
}
export interface SyntheticCdrInput extends SyntheticCertificateInput {
  xml: string;
  expectedUnsignedXml: string;
  /** Recipient RUC; the certificate identity is instead bound to SenderParty. */
  issuerRuc: string;
  reference: string;
  /** Explicit caller binding; supported fixture codes: 01, 03, 07 and 08. */
  expectedDocumentTypeCode?: string;
}
export type SyntheticCdrStatus = 'SIMULATED_ACCEPTED' | 'SIMULATED_ACCEPTED_WITH_OBSERVATIONS' | 'SIMULATED_REJECTED';
export interface SyntheticCdrResult extends SyntheticXmlSignatureResult {
  environment: 'BETA';
  datasetClass: 'SYNTHETIC';
  certificate: SyntheticCertificateResult;
  certificateVerified: true;
  senderRuc: string;
  issuerRuc: string;
  reference: string;
  documentTypeCode: string | null;
  /** True only when a supplied expected type matches the authenticated CBC field. */
  documentTypeBindingVerified: boolean;
  responseCode: string;
  description: string;
  notes: string[];
  status: SyntheticCdrStatus;
}

const DS = 'http://www.w3.org/2000/09/xmldsig#';
const EXT = 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2';
const CBC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
const CAC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const ORGANIZATION_ID = '2.5.4.97';
const FAKE_RUC = /^00000000[0-9]{3}$/;
const SHA256_RSA_OID = '1.2.840.113549.1.1.11';
const ROOT_NAMESPACES: Record<SyntheticXmlRootKind, string> = {
  Invoice: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  CreditNote: 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2',
  DebitNote: 'urn:oasis:names:specification:ubl:schema:xsd:DebitNote-2',
  ApplicationResponse: 'urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2',
};
export const SYNTHETIC_XML_SIGNATURE_PROFILE = Object.freeze({
  canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
});
/**
 * Deliberately narrow fixture contract, not a production PKI profile:
 * exactly CN, O and organizationIdentifier (2.5.4.97) in each subject;
 * O = "FactuEz SYNTHETIC FICTICIO QA"; organizationIdentifier = fake RUC;
 * signer CN = "SYNTHETIC FICTICIO QA <RUC>"; root CN = "SYNTHETIC FICTICIO QA ROOT".
 * X.509 v3, RSA 2048..4096, SHA256/RSA with NULL parameters, exactly two
 * critical extensions: basicConstraints and keyUsage. Root: CA/pathLen=0,
 * keyCertSign+cRLSign only. Signer: non-CA, digitalSignature only.
 * Only a direct signer/root chain is supported. No embedded trust anchors.
 */
export const SYNTHETIC_CERTIFICATE_PROFILE = Object.freeze({
  organization: 'FactuEz SYNTHETIC FICTICIO QA',
  signerCommonNamePrefix: 'SYNTHETIC FICTICIO QA ',
  rootCommonName: 'SYNTHETIC FICTICIO QA ROOT',
  organizationIdentifierOid: ORGANIZATION_ID,
  minimumRsaBits: 2048,
  maximumRsaBits: 4096,
});

function requireCondition(condition: unknown): asserts condition {
  if (!condition) throw new Error('Invalid synthetic evidence');
}
function scope<T extends SyntheticScope>(input: T): T {
  // Check proxies before any operation that could trigger their traps. Never
  // read caller properties, even scope labels, before inspecting descriptors.
  requireCondition(input !== null && typeof input === 'object' && !types.isProxy(input));
  const prototype = Object.getPrototypeOf(input);
  requireCondition(prototype === Object.prototype || prototype === null);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const safe = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    requireCondition(typeof key === 'string');
    const descriptor = descriptors[key];
    requireCondition(Object.hasOwn(descriptor, 'value') && !Object.hasOwn(descriptor, 'get') && !Object.hasOwn(descriptor, 'set'));
    Object.defineProperty(safe, key, { value: descriptor.value, enumerable: true });
  }
  requireCondition(safe.environment === 'BETA' && safe.datasetClass === 'SYNTHETIC');
  return Object.freeze(safe) as unknown as T;
}
function fakeRuc(value: string) {
  requireCondition(typeof value === 'string' && FAKE_RUC.test(value));
  return value;
}
function children(parent: Node): Element[] {
  const result: Element[] = [];
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) result.push(child as Element);
    else requireCondition(child.nodeType === 3 && !child.nodeValue?.trim());
  }
  return result;
}
function one(parent: Element, namespace: string, name: string): Element {
  // Reject look-alike siblings in other namespaces as well as duplicates.
  const matches = children(parent).filter(node => node.localName === name);
  requireCondition(matches.length === 1 && matches[0].namespaceURI === namespace);
  return matches[0];
}
function attributes(node: Element, allowed: readonly string[] = []) {
  for (let i = 0; i < node.attributes.length; i++) {
    const attr = node.attributes.item(i)!;
    requireCondition(attr.namespaceURI === XMLNS || (!attr.namespaceURI && allowed.includes(attr.name)));
  }
}
function sequence(parent: Element, names: readonly string[], namespace = DS) {
  const nodes = children(parent);
  requireCondition(nodes.length === names.length && nodes.every((node, i) => node.namespaceURI === namespace && node.localName === names[i]));
  return nodes;
}
function text(node: Element, limit: number): string {
  for (let child = node.firstChild; child; child = child.nextSibling) requireCondition(child.nodeType === 3);
  const value = node.textContent?.trim() ?? '';
  requireCondition(value.length > 0 && value.length <= limit);
  return value;
}
function base64(value: string, bytes?: number): Buffer {
  requireCondition(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) && value.length > 0);
  const decoded = Buffer.from(value, 'base64');
  requireCondition(decoded.toString('base64') === value && (bytes === undefined || decoded.length === bytes));
  return decoded;
}
function parseXml(xml: string, rootKind: SyntheticXmlRootKind) {
  requireCondition(typeof rootKind === 'string' && Object.hasOwn(ROOT_NAMESPACES, rootKind) && typeof xml === 'string' && xml.length > 0 &&
    Buffer.byteLength(xml, 'utf8') <= 2 * 1024 * 1024 && !/<!|<\?(?!xml\s)|[\x00-\x08\x0B\x0C\x0E-\x1F]/i.test(xml));
  const document = new DOMParser({ onError: () => { throw new Error('Invalid synthetic XML'); } }).parseFromString(xml, 'application/xml');
  const root = document.documentElement;
  requireCondition(root && root.localName === rootKind && root.namespaceURI === ROOT_NAMESPACES[rootKind]);
  for (let node = document.firstChild; node; node = node.nextSibling) {
    requireCondition(node === root || (node.nodeType === 3 && !node.nodeValue?.trim()) ||
      (node.nodeType === 7 && node.nodeName === 'xml' && node === document.firstChild));
  }
  const ids = new Set<string>();
  const pending = [{ node: root, depth: 1 }];
  let count = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    requireCondition(++count <= 30000 && depth <= 40 && node.attributes.length <= 100);
    requireCondition(node === root || !Object.hasOwn(ROOT_NAMESPACES, node.localName!));
    for (let i = 0; i < node.attributes.length; i++) {
      const attr = node.attributes.item(i)!;
      if (attr.localName?.toLowerCase() === 'id') {
        requireCondition(attr.value && !ids.has(attr.value));
        ids.add(attr.value);
      }
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      requireCondition(child.nodeType === 1 || child.nodeType === 3);
      if (child.nodeType === 1) pending.push({ node: child as Element, depth: depth + 1 });
    }
  }
  const extensionNodes = document.getElementsByTagNameNS(EXT, 'ExtensionContent');
  requireCondition(extensionNodes.length === 1 && document.getElementsByTagNameNS(EXT, 'UBLExtensions').length === 1 &&
    document.getElementsByTagNameNS(EXT, 'UBLExtension').length === 1);
  const extension = one(one(one(root, EXT, 'UBLExtensions'), EXT, 'UBLExtension'), EXT, 'ExtensionContent');
  sequence(extension.parentNode as Element, ['ExtensionContent'], EXT);
  sequence(extension.parentNode!.parentNode as Element, ['UBLExtension'], EXT);
  requireCondition(extension === extensionNodes[0]);
  return { document, root, extension };
}

function asnChildren(node: forge.asn1.Asn1): forge.asn1.Asn1[] {
  requireCondition(Array.isArray(node.value));
  return node.value as forge.asn1.Asn1[];
}
function utc(value: string): Date {
  requireCondition(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value));
  const normalized = value.includes('.') ? value : value.replace('Z', '.000Z');
  const date = new Date(normalized);
  requireCondition(Number.isFinite(date.getTime()) && date.toISOString() === normalized);
  return date;
}
function asnTime(node: forge.asn1.Asn1): Date {
  requireCondition(node.tagClass === forge.asn1.Class.UNIVERSAL && typeof node.value === 'string');
  let value = node.value as string;
  if (node.type === forge.asn1.Type.UTCTIME) {
    requireCondition(/^\d{12}Z$/.test(value));
    value = `${Number(value.slice(0, 2)) >= 50 ? '19' : '20'}${value}`;
  } else requireCondition(node.type === forge.asn1.Type.GENERALIZEDTIME && /^\d{14}Z$/.test(value));
  return utc(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}Z`);
}
function certificateAlgorithm(node: forge.asn1.Asn1) {
  const parts = asnChildren(node);
  requireCondition(node.type === forge.asn1.Type.SEQUENCE && parts.length === 2 && parts[0].type === forge.asn1.Type.OID &&
    typeof parts[0].value === 'string' && forge.asn1.derToOid(parts[0].value) === SHA256_RSA_OID &&
    parts[1].type === forge.asn1.Type.NULL && parts[1].value === '');
}
function syntheticCertificate(pem: string, role: 'signer' | 'root') {
  requireCondition(typeof pem === 'string' && pem.length <= 16384);
  const match = /^-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END CERTIFICATE-----$/.exec(pem.trim());
  requireCondition(match);
  const raw = base64(match[1].replace(/[\r\n]/g, ''));
  const x509 = new X509Certificate(raw);
  requireCondition(x509.raw.equals(raw));
  const asn = forge.asn1.fromDer(raw.toString('binary'), true);
  requireCondition(forge.asn1.toDer(asn).getBytes() === raw.toString('binary'));
  const certificate = forge.pki.certificateFromAsn1(asn);
  const parts = asnChildren(asn);
  requireCondition(parts.length === 3);
  const tbs = asnChildren(parts[0]);
  // v3 includes the explicit version field at index 0.
  requireCondition(certificate.version === 2 && tbs[0].tagClass === forge.asn1.Class.CONTEXT_SPECIFIC);
  certificateAlgorithm(parts[1]);
  certificateAlgorithm(tbs[2]);
  requireCondition(certificate.signatureOid === SHA256_RSA_OID && certificate.siginfo.algorithmOid === SHA256_RSA_OID);
  const serial = certificate.serialNumber;
  requireCondition(/^[a-f\d]{1,40}$/i.test(serial) && BigInt(`0x${serial}`) > 0n && (Number.parseInt(serial.slice(0, 2), 16) & 0x80) === 0);
  const dates = asnChildren(tbs[4]);
  requireCondition(dates.length === 2);
  const notBefore = asnTime(dates[0]);
  const notAfter = asnTime(dates[1]);
  requireCondition(notBefore < notAfter && certificate.validity.notBefore.getTime() === notBefore.getTime() &&
    certificate.validity.notAfter.getTime() === notAfter.getTime());
  const subject = certificate.subject.attributes;
  requireCondition(subject.length === 3);
  const field = (oid: string) => {
    const matches = subject.filter(attribute => attribute.type === oid);
    requireCondition(matches.length === 1 && typeof matches[0].value === 'string');
    return matches[0].value as string;
  };
  const ruc = fakeRuc(field(ORGANIZATION_ID));
  requireCondition(field('2.5.4.10') === SYNTHETIC_CERTIFICATE_PROFILE.organization && field('2.5.4.3') ===
    (role === 'root' ? SYNTHETIC_CERTIFICATE_PROFILE.rootCommonName : `${SYNTHETIC_CERTIFICATE_PROFILE.signerCommonNamePrefix}${ruc}`));
  requireCondition(x509.publicKey.asymmetricKeyType === 'rsa');
  const keySizeBits = x509.publicKey.asymmetricKeyDetails?.modulusLength;
  requireCondition(keySizeBits && keySizeBits >= 2048 && keySizeBits <= 4096 &&
    x509.publicKey.asymmetricKeyDetails?.publicExponent === 65537n);
  requireCondition(certificate.extensions.length === 2);
  const extension = (id: string) => {
    const matches = certificate.extensions.filter(item => item.id === id);
    requireCondition(matches.length === 1 && matches[0].critical === true);
    return matches[0];
  };
  const constraints = extension('2.5.29.19');
  const usage = extension('2.5.29.15');
  const isCa = role === 'root';
  // Exact DER also rejects ignored trailing fields and unknown keyUsage bits.
  requireCondition(constraints.value === (isCa ? '\x30\x06\x01\x01\xff\x02\x01\x00' : '\x30\x00') &&
    usage.value === (isCa ? '\x03\x02\x01\x06' : '\x03\x02\x07\x80'));
  requireCondition(constraints.cA === isCa && x509.ca === isCa && (isCa ? constraints.pathLenConstraint === 0 : constraints.pathLenConstraint === undefined));
  for (const flag of ['digitalSignature', 'nonRepudiation', 'keyEncipherment', 'dataEncipherment', 'keyAgreement', 'keyCertSign', 'cRLSign', 'encipherOnly', 'decipherOnly']) {
    const wanted = isCa ? flag === 'keyCertSign' || flag === 'cRLSign' : flag === 'digitalSignature';
    requireCondition(usage[flag] === wanted);
  }
  return { certificate, x509, ruc, keySizeBits, notBefore, notAfter, tbs,
    fingerprint: createHash('sha256').update(raw).digest('hex') };
}

/** Local cryptographic evidence only. Certificate/time/chain checks are a separate operation. */
export function verifySyntheticXmlSignature(input: SyntheticXmlSignatureInput): SyntheticXmlSignatureResult {
  try {
    input = scope(input);
    const pinned = syntheticCertificate(input.certificatePem, 'signer');
    const parsed = parseXml(input.xml, input.rootKind);
    const signatures = parsed.document.getElementsByTagNameNS(DS, 'Signature');
    requireCondition(signatures.length === 1);
    const signature = sequence(parsed.extension, ['Signature'])[0];
    requireCondition(signature === signatures[0]);
    attributes(signature, ['Id']);
    const signatureParts = children(signature);
    requireCondition(signatureParts.length === 2 || signatureParts.length === 3);
    sequence(signature, signatureParts.length === 3 ? ['SignedInfo', 'SignatureValue', 'KeyInfo'] : ['SignedInfo', 'SignatureValue']);
    const [signedInfo, signatureValue, keyInfo] = signatureParts;
    attributes(signedInfo);
    attributes(signatureValue);
    base64(text(signatureValue, 1024), pinned.keySizeBits / 8);
    const [canonicalization, signatureMethod, reference] = sequence(signedInfo, ['CanonicalizationMethod', 'SignatureMethod', 'Reference']);
    const algorithm = (node: Element, expected: string) => {
      attributes(node, ['Algorithm']);
      requireCondition(node.getAttribute('Algorithm') === expected && children(node).length === 0);
    };
    algorithm(canonicalization, SYNTHETIC_XML_SIGNATURE_PROFILE.canonicalizationAlgorithm);
    algorithm(signatureMethod, SYNTHETIC_XML_SIGNATURE_PROFILE.signatureAlgorithm);
    attributes(reference, ['URI']);
    requireCondition(reference.hasAttribute('URI') && reference.getAttribute('URI') === '' &&
      parsed.document.getElementsByTagNameNS(DS, 'Reference').length === 1);
    const [transforms, digestMethod, digestNode] = sequence(reference, ['Transforms', 'DigestMethod', 'DigestValue']);
    attributes(transforms);
    const transformNodes = sequence(transforms, ['Transform', 'Transform']);
    algorithm(transformNodes[0], `${DS}enveloped-signature`);
    algorithm(transformNodes[1], SYNTHETIC_XML_SIGNATURE_PROFILE.canonicalizationAlgorithm);
    algorithm(digestMethod, SYNTHETIC_XML_SIGNATURE_PROFILE.digestAlgorithm);
    attributes(digestNode);
    const digestValue = text(digestNode, 44);
    base64(digestValue, 32);
    if (keyInfo) {
      attributes(keyInfo);
      const data = sequence(keyInfo, ['X509Data'])[0];
      attributes(data);
      const embedded = sequence(data, ['X509Certificate'])[0];
      attributes(embedded);
      requireCondition(base64(text(embedded, 16384).replace(/\s/g, '')).equals(pinned.x509.raw));
    }
    // No resolver, CA or key supplied by KeyInfo can override the external certificate.
    const verifier = new SignedXml({ publicCert: input.certificatePem, getCertFromKeyInfo: () => null });
    // xml-crypto declares browser DOM types but consumes xmldom nodes at runtime.
    verifier.loadSignature(signature as unknown as Parameters<SignedXml['loadSignature']>[0]);
    requireCondition(verifier.checkSignature(input.xml));
    const authenticated = verifier.getSignedReferences();
    requireCondition(authenticated.length === 1);
    const trusted = parseXml(authenticated[0], input.rootKind);
    const expected = parseXml(input.expectedUnsignedXml, input.rootKind);
    for (const candidate of [trusted, expected]) {
      requireCondition(candidate.document.getElementsByTagNameNS(DS, '*').length === 0 && children(candidate.extension).length === 0);
    }
    const canonical = (root: Element) => new SignedXml().getCanonXml([SYNTHETIC_XML_SIGNATURE_PROFILE.canonicalizationAlgorithm],
      root as unknown as Parameters<SignedXml['getCanonXml']>[1]);
    requireCondition(canonical(trusted.root) === canonical(expected.root));
    return { authenticatedXml: authenticated[0], digestValue, signatureVerified: true, officialTrust: false };
  } catch { throw new Error('SYNTHETIC_XML_SIGNATURE_INVALID'); }
}

export function verifySyntheticCertificate(input: SyntheticCertificateInput): SyntheticCertificateResult {
  try {
    input = scope(input);
    const issuerRuc = fakeRuc(input.issuerRuc);
    const checkedAt = utc(input.checkedAt);
    requireCondition(typeof input.pinnedRootSha256 === 'string' && /^[a-f\d]{64}$/.test(input.pinnedRootSha256));
    const leaf = syntheticCertificate(input.certificatePem, 'signer');
    const root = syntheticCertificate(input.rootCertificatePem, 'root');
    requireCondition(root.fingerprint === input.pinnedRootSha256 && leaf.fingerprint !== root.fingerprint && leaf.ruc === issuerRuc);
    requireCondition(leaf.notBefore <= checkedAt && checkedAt <= leaf.notAfter && root.notBefore <= checkedAt && checkedAt <= root.notAfter &&
      root.notBefore <= leaf.notBefore && leaf.notAfter <= root.notAfter);
    const der = (node: forge.asn1.Asn1) => forge.asn1.toDer(node).getBytes();
    requireCondition(der(leaf.tbs[3]) === der(root.tbs[5]) && der(root.tbs[3]) === der(root.tbs[5]) &&
      root.x509.verify(root.x509.publicKey) && leaf.x509.verify(root.x509.publicKey));
    return {
      validity: { valid: true, checkedAt: checkedAt.toISOString(), notBefore: leaf.notBefore.toISOString(), notAfter: leaf.notAfter.toISOString(),
        rootNotBefore: root.notBefore.toISOString(), rootNotAfter: root.notAfter.toISOString() },
      issuerRuc, certificateFingerprintSha256: leaf.fingerprint, rootFingerprintSha256: root.fingerprint,
      chainSignatureVerified: true, keyUsageVerified: true, caVerified: true, algorithm: 'RSA_SHA256',
      keySizeBits: leaf.keySizeBits, rootKeySizeBits: root.keySizeBits, revocationStatus: 'NOT_CHECKED', officialTrust: false,
    };
  } catch { throw new Error('SYNTHETIC_CERTIFICATE_INVALID'); }
}

/** Reads business fields exclusively from authenticated references; no official acceptance claim. */
export function verifySyntheticCdr(input: SyntheticCdrInput): SyntheticCdrResult {
  try {
    input = scope(input);
    const issuerRuc = fakeRuc(input.issuerRuc);
    requireCondition(typeof input.reference === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(input.reference));
    const expectsDocumentType = Object.hasOwn(input, 'expectedDocumentTypeCode');
    if (expectsDocumentType) requireCondition(typeof input.expectedDocumentTypeCode === 'string' && /^(?:01|03|07|08)$/.test(input.expectedDocumentTypeCode));
    const signature = verifySyntheticXmlSignature({ ...input, rootKind: 'ApplicationResponse' });
    const { root } = parseXml(signature.authenticatedXml, 'ApplicationResponse');
    const partyRuc = (name: string) => fakeRuc(text(one(one(one(root, CAC, name), CAC, 'PartyIdentification'), CBC, 'ID'), 11));
    const senderRuc = partyRuc('SenderParty');
    requireCondition(partyRuc('ReceiverParty') === issuerRuc);
    const documentResponse = one(root, CAC, 'DocumentResponse');
    const documentReference = one(documentResponse, CAC, 'DocumentReference');
    const reference = text(one(documentReference, CBC, 'ID'), 40);
    requireCondition(reference === input.reference);
    const typeNodes = children(documentReference).filter(node => node.localName === 'DocumentTypeCode');
    requireCondition(typeNodes.length <= 1 && typeNodes.every(node => node.namespaceURI === CBC));
    const documentTypeCode = typeNodes.length ? text(typeNodes[0], 2) : null;
    requireCondition(documentTypeCode === null || /^(?:01|03|07|08)$/.test(documentTypeCode));
    if (expectsDocumentType) requireCondition(documentTypeCode === input.expectedDocumentTypeCode);
    const response = one(documentResponse, CAC, 'Response');
    // Some UBL CDRs also carry ReferenceID in Response; if present it must agree.
    const responseReference = children(response).filter(node => node.localName === 'ReferenceID');
    requireCondition(responseReference.length <= 1);
    if (responseReference.length) requireCondition(responseReference[0].namespaceURI === CBC && text(responseReference[0], 40) === reference);
    const responseCode = text(one(response, CBC, 'ResponseCode'), 8);
    requireCondition(/^(?:0|[1-9][0-9]{0,7})$/.test(responseCode));
    const description = text(one(response, CBC, 'Description'), 2048);
    const noteNodes = children(root).filter(node => node.localName === 'Note');
    requireCondition(noteNodes.length <= 50 && noteNodes.every(node => node.namespaceURI === CBC));
    const notes = noteNodes.map(node => text(node, 2048));
    const certificate = verifySyntheticCertificate({ ...input, issuerRuc: senderRuc });
    const status: SyntheticCdrStatus = responseCode === '0'
      ? (notes.length ? 'SIMULATED_ACCEPTED_WITH_OBSERVATIONS' : 'SIMULATED_ACCEPTED') : 'SIMULATED_REJECTED';
    return { ...signature, environment: 'BETA', datasetClass: 'SYNTHETIC', certificate, certificateVerified: true,
      senderRuc, issuerRuc, reference, documentTypeCode, documentTypeBindingVerified: expectsDocumentType,
      responseCode, description, notes, status, officialTrust: false };
  } catch { throw new Error('SYNTHETIC_CDR_INVALID'); }
}
