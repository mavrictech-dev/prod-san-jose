import { createPrivateKey, X509Certificate } from 'node:crypto';
import forge from 'node-forge';
import { DOMParser } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';
import { inspectCertificate } from './certificate-inspector';

const DS = 'http://www.w3.org/2000/09/xmldsig#';
export type XmlRootKind = 'Invoice' | 'SummaryDocuments' | 'VoidedDocuments' | 'CreditNote' | 'DebitNote' | 'DespatchAdvice' | 'ApplicationResponse';
const ROOT_NAMESPACES: Record<XmlRootKind, string> = {
  Invoice: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  ApplicationResponse: 'urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2',
  CreditNote: 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2',
  DebitNote: 'urn:oasis:names:specification:ubl:schema:xsd:DebitNote-2',
  DespatchAdvice: 'urn:oasis:names:specification:ubl:schema:xsd:DespatchAdvice-2',
  SummaryDocuments: 'urn:sunat:names:specification:ubl:peru:schema:xsd:SummaryDocuments-1',
  VoidedDocuments: 'urn:sunat:names:specification:ubl:peru:schema:xsd:VoidedDocuments-1',
};
const EXT = 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2';
export const MAX_XML_BYTES = 2 * 1024 * 1024;
export const LOCAL_SIGNATURE_PROFILE = Object.freeze({
  canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
});
export interface XmlSignatureProfile { canonicalizationAlgorithm: string; signatureAlgorithm: string; digestAlgorithm: string }
export interface SignedXmlResult { xml: string; digestValue: string; certificateFingerprintSha256: string }

/** Sin DTD/entidades, comentarios, múltiples raíces ni parsing recuperado. */
export function parseSafeInvoice(xml: string, rootKind: XmlRootKind = 'Invoice') {
  if (!xml || Buffer.byteLength(xml, 'utf8') > MAX_XML_BYTES || /<!|<\?(?!xml\s)/i.test(xml)) throw new Error('XML no permitido');
  const document = new DOMParser({ onError: () => { throw new Error('XML mal formado'); } }).parseFromString(xml, 'application/xml');
  const root = document.documentElement;
  if (!Object.hasOwn(ROOT_NAMESPACES, rootKind)) throw new Error('Perfil XML desconocido');
  const namespace = ROOT_NAMESPACES[rootKind];
  if (!root || root.namespaceURI !== namespace || root.localName !== rootKind || document.getElementsByTagNameNS(namespace, rootKind).length !== 1) throw new Error('Raíz XML inválida');
  const ids = new Set<string>(); let count = 0;
  const pending = [{ node: root, depth: 1 }];
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++count > 30000 || depth > 40) throw new Error('Complejidad XML excedida');
    for (let i = 0; i < node.attributes.length; i++) {
      const attr = node.attributes.item(i)!;
      if (['id', 'Id', 'ID'].includes(attr.localName!)) {
        if (!attr.value || ids.has(attr.value)) throw new Error('IDs XML duplicados');
        ids.add(attr.value);
      }
    }
    for (let child = node.firstChild; child; child = child.nextSibling)
      if (child.nodeType === 1) pending.push({ node: child as typeof root, depth: depth + 1 });
  }
  const extensions = document.getElementsByTagNameNS(EXT, 'ExtensionContent');
  if (extensions.length !== 1 || extensions[0].parentNode?.localName !== 'UBLExtension' ||
      extensions[0].parentNode?.parentNode?.localName !== 'UBLExtensions' || extensions[0].parentNode?.parentNode?.parentNode !== root) throw new Error('Extensión de firma inválida');
  return { document, root, extension: extensions[0] };
}

/** Verifica con certificado externo; KeyInfo no es la autoridad. Usa sólo referencias autenticadas. */
export function verifyLocalSignedInvoice(xml: string, certificatePem: string, expectedUnsignedXml: string, rootKind: XmlRootKind = 'Invoice'): string {
  const parsed = parseSafeInvoice(xml, rootKind);
  const signatures = parsed.document.getElementsByTagNameNS(DS, 'Signature');
  if (signatures.length !== 1 || signatures[0].parentNode !== parsed.extension) throw new Error('Firma única de Invoice requerida');
  const signature = signatures[0];
  const one = (name: string) => {
    const nodes = signature.getElementsByTagNameNS(DS, name);
    if (nodes.length !== 1) throw new Error('Estructura XMLDSig inválida');
    return nodes[0];
  };
  if (one('Reference').getAttribute('URI') !== '' ||
      one('CanonicalizationMethod').getAttribute('Algorithm') !== LOCAL_SIGNATURE_PROFILE.canonicalizationAlgorithm ||
      one('SignatureMethod').getAttribute('Algorithm') !== LOCAL_SIGNATURE_PROFILE.signatureAlgorithm ||
      one('DigestMethod').getAttribute('Algorithm') !== LOCAL_SIGNATURE_PROFILE.digestAlgorithm) throw new Error('Perfil XMLDSig no permitido');
  const transforms = signature.getElementsByTagNameNS(DS, 'Transform');
  if (transforms.length !== 2 || transforms[0].getAttribute('Algorithm') !== `${DS}enveloped-signature` ||
      transforms[1].getAttribute('Algorithm') !== LOCAL_SIGNATURE_PROFILE.canonicalizationAlgorithm) throw new Error('Transformaciones no permitidas');
  const pinned = new X509Certificate(certificatePem);
  const embedded = one('X509Certificate').textContent ?? '';
  if (!/^[A-Za-z0-9+/=\s]+$/.test(embedded) || !new X509Certificate(Buffer.from(embedded.replace(/\s/g, ''), 'base64')).raw.equals(pinned.raw)) throw new Error('Certificado XML no coincide');
  const verifier = new SignedXml({ publicCert: certificatePem, getCertFromKeyInfo: () => null });
  verifier.loadSignature(signature);
  if (!verifier.checkSignature(xml)) throw new Error('Firma XML inválida');
  const authenticated = verifier.getSignedReferences();
  if (authenticated.length !== 1) throw new Error('Referencia firmada inválida');
  const trusted = parseSafeInvoice(authenticated[0], rootKind);
  if (trusted.document.getElementsByTagNameNS(DS, 'Signature').length) throw new Error('Referencia autenticada inesperada');
  const expected = parseSafeInvoice(expectedUnsignedXml, rootKind);
  const canonical = (root: typeof expected.root) => new SignedXml().getCanonXml([LOCAL_SIGNATURE_PROFILE.canonicalizationAlgorithm], root);
  if (canonical(trusted.root) !== canonical(expected.root)) throw new Error('XML firmado difiere del snapshot');
  const digest = one('DigestValue').textContent ?? '';
  if (!/^[A-Za-z0-9+/]{43}=$/.test(digest)) throw new Error('Digest inválido');
  return digest;
}

/** Perfil QA: no demuestra confianza PKI, autorización RUC ni aceptación SUNAT. */
export class XmlSignerService {
  constructor(private readonly profile: XmlSignatureProfile = LOCAL_SIGNATURE_PROFILE) {}
  sign(unsignedXml: string, pkcs12: Buffer, password: string, rootKind: XmlRootKind = 'Invoice'): SignedXmlResult {
    if (JSON.stringify(this.profile) !== JSON.stringify(LOCAL_SIGNATURE_PROFILE)) throw new Error('Sólo perfil local habilitado');
    const parsed = parseSafeInvoice(unsignedXml, rootKind);
    if (parsed.document.getElementsByTagNameNS(DS, 'Signature').length || parsed.extension.hasChildNodes()) throw new Error('XML ya firmado o extensión no vacía');
    const metadata = inspectCertificate(pkcs12, password);
    const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(pkcs12.toString('binary')), false, password);
    const cert = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []).find(bag => bag.cert &&
      new X509Certificate(forge.pki.certificateToPem(bag.cert)).fingerprint256.replace(/:/g, '').toLowerCase() === metadata.fingerprint)?.cert;
    if (!cert) throw new Error('Identidad de firma no disponible');
    const certificatePem = forge.pki.certificateToPem(cert);
    const x509 = new X509Certificate(certificatePem);
    const keys = [forge.pki.oids.pkcs8ShroudedKeyBag, forge.pki.oids.keyBag].flatMap(type => p12.getBags({ bagType: type })[type] ?? []);
    const key = keys.find(bag => bag.key && x509.checkPrivateKey(createPrivateKey(forge.pki.privateKeyToPem(bag.key))))?.key;
    if (!key) throw new Error('Clave de firma no disponible');
    let privateKeyPem = forge.pki.privateKeyToPem(key);
    try {
      const signer = new SignedXml({ privateKey: privateKeyPem, publicCert: certificatePem, ...this.profile });
      signer.addReference({ xpath: '/*', isEmptyUri: true, transforms: [`${DS}enveloped-signature`, this.profile.canonicalizationAlgorithm], digestAlgorithm: this.profile.digestAlgorithm });
      signer.computeSignature(unsignedXml, { attrs: { Id: 'signatureFactuEz' }, location: {
        reference: "/*/*[local-name()='UBLExtensions']/*[local-name()='UBLExtension']/*[local-name()='ExtensionContent']", action: 'append' } });
      const xml = signer.getSignedXml();
      return { xml, digestValue: verifyLocalSignedInvoice(xml, certificatePem, unsignedXml, rootKind), certificateFingerprintSha256: metadata.fingerprint };
    } finally { privateKeyPem = ''; } // El worker termina y descarta su heap; no registrar claves.
  }
}
