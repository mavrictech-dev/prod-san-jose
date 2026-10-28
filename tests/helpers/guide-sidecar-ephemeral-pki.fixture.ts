import { createHash, X509Certificate } from 'node:crypto';
import { createRequire } from 'node:module';
import { XmlSignerService, parseSafeInvoice, verifyLocalSignedInvoice } from '../../services/sunat-service/src/infrastructure/crypto/xml-signer.service';
import type { GuideCdrExpected } from '../../services/sunat-service/src/application/guide-cdr-evidence';
import type { LocalGuideSigningInput } from '../../services/sunat-service/src/infrastructure/crypto/guide-artifact-crypto';

const serviceRequire = createRequire(new URL('../../services/sunat-service/package.json', import.meta.url));
const forge: typeof import('node-forge') = serviceRequire('node-forge');
export const { zipSync, unzipSync }: typeof import('../../services/sunat-service/node_modules/fflate') = serviceRequire('fflate');
export const GUIDE_SIDECAR_TEST_PASSWORD = 'EPHEMERAL-GUIDE-SIDECAR-NO-REAL-SECRETS';
export const GUIDE_SIDECAR_TEST_RUC = '20100070970';
export const GUIDE_SIDECAR_OTHER_RUC = '20131312955';
export const guideSidecarHash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const EXT = 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2';
const CBC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
const CAC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
const DS = 'http://www.w3.org/2000/09/xmldsig#';

/** All private keys/P12 are generated and retained only in memory. No filesystem, env, or network access. */
export function createGuideSidecarPki(issuerRuc = GUIDE_SIDECAR_TEST_RUC) {
  type Certificate = ReturnType<typeof forge.pki.createCertificate>;
  type PrivateKey = ReturnType<typeof forge.pki.privateKeyFromPem>;
  function issue(serial: string, ruc?: string, issuer?: { certificate: Certificate; privateKey: PrivateKey }) {
    const pair = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
    const certificate = forge.pki.createCertificate(); certificate.publicKey = pair.publicKey; certificate.serialNumber = serial;
    certificate.validity.notBefore = new Date(Date.now() - 86400000);
    certificate.validity.notAfter = new Date(Date.now() + 30 * 86400000);
    certificate.setSubject([{ name: 'commonName', value: `FICTITIOUS GUIDE SIDECAR ${serial}` },
      ...(ruc ? [{ type: '2.5.4.97', value: `NTRPE-${ruc}` }] : [])]);
    certificate.setIssuer(issuer?.certificate.subject.attributes ?? certificate.subject.attributes);
    certificate.setExtensions([{ name: 'basicConstraints', critical: true, cA: !issuer },
      { name: 'keyUsage', critical: true, digitalSignature: !!issuer, keyCertSign: !issuer, cRLSign: !issuer }]);
    certificate.sign(issuer?.privateKey ?? pair.privateKey, forge.md.sha256.create());
    const certificatePem = forge.pki.certificateToPem(certificate);
    return { certificate, privateKey: pair.privateKey, certificatePem };
  }
  const root = issue('7101');
  function signer(serial: string, ruc: string) {
    const leaf = issue(serial, ruc, root);
    const pkcs12 = Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(leaf.privateKey,
      [leaf.certificate, root.certificate], GUIDE_SIDECAR_TEST_PASSWORD, { algorithm: 'aes256' })).getBytes(), 'binary');
    return { pkcs12, certificatePem: leaf.certificatePem, chainPems: [root.certificatePem],
      fingerprint: new X509Certificate(leaf.certificatePem).fingerprint256.replaceAll(':', '').toLowerCase() };
  }
  const issuer = signer('7102', issuerRuc), otherIssuer = signer('7103', GUIDE_SIDECAR_OTHER_RUC), sunat = signer('7104', '20131312955');
  /** Test-only local verifier: real ephemeral chain + pinned whole-document signature, NOT official SUNAT PKI/CRL. */
  const cdrVerifier = { async verify(bytes: Buffer): Promise<boolean> {
    try {
      const cert = forge.pki.certificateFromPem(sunat.certificatePem);
      forge.pki.verifyCertificateChain(forge.pki.createCaStore([root.certificatePem]), [cert]);
      const value = bytes.toString('utf8'); if (!Buffer.from(value).equals(bytes)) return false;
      const parsed = parseSafeInvoice(value, 'ApplicationResponse'), signatures = parsed.document.getElementsByTagNameNS(DS, 'Signature');
      if (signatures.length !== 1 || signatures[0].parentNode !== parsed.extension) return false;
      parsed.extension.removeChild(signatures[0]);
      verifyLocalSignedInvoice(value, sunat.certificatePem, parsed.root.toString(), 'ApplicationResponse');
      return true;
    } catch { return false; }
  } };
  const signCdr = (unsignedXml: string) => new XmlSignerService().sign(unsignedXml, sunat.pkcs12, GUIDE_SIDECAR_TEST_PASSWORD, 'ApplicationResponse').xml;
  return { issuer, otherIssuer, sunat, rootPem: root.certificatePem, password: GUIDE_SIDECAR_TEST_PASSWORD, cdrVerifier, signCdr };
}

export function guideSidecarSigningInput(documentType: '09' | '31' = '09'): LocalGuideSigningInput {
  const fullNumber = documentType === '09' ? 'TQ71-1' : 'VQ71-1', issuerRuc = GUIDE_SIDECAR_TEST_RUC;
  const unsignedXml = `<DespatchAdvice xmlns="urn:oasis:names:specification:ubl:schema:xsd:DespatchAdvice-2" xmlns:ext="${EXT}" xmlns:cbc="${CBC}" xmlns:cac="${CAC}"><ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions><cbc:ID>${fullNumber}</cbc:ID><cbc:DespatchAdviceTypeCode>${documentType}</cbc:DespatchAdviceTypeCode><cac:DespatchSupplierParty><cac:Party><cac:PartyIdentification><cbc:ID schemeID="6">${issuerRuc}</cbc:ID></cac:PartyIdentification></cac:Party></cac:DespatchSupplierParty></DespatchAdvice>`;
  return { unsignedXml, issuerRuc, documentType, fullNumber };
}
export function guideSidecarCdrExpected(documentType: '09' | '31' = '09'): GuideCdrExpected {
  const input = guideSidecarSigningInput(documentType);
  return { issuerRuc: input.issuerRuc, documentType, fullNumber: input.fullNumber,
    requestXmlSha256: guideSidecarHash('FICTITIOUS LOCAL REQUEST XML'), requestZipSha256: guideSidecarHash('FICTITIOUS LOCAL REQUEST ZIP'),
    issuedAt: '2026-10-23T15:00:00.000Z', receivedAt: '2026-10-23T16:00:00.000Z', source: 'LOCAL_EMULATOR' };
}
export function guideSidecarCdrXml(expected = guideSidecarCdrExpected(), code = '0'): string {
  return `<ApplicationResponse xmlns="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2" xmlns:ext="${EXT}" xmlns:cbc="${CBC}" xmlns:cac="${CAC}"><ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions><cbc:ID>FICTITIOUS-LOCAL-GUIDE-CDR</cbc:ID><cbc:IssueDate>2026-10-23</cbc:IssueDate><cbc:IssueTime>10:30:00-05:00</cbc:IssueTime><cbc:ResponseDate>2026-10-23</cbc:ResponseDate><cbc:ResponseTime>10:31:00-05:00</cbc:ResponseTime><cac:SenderParty><cac:PartyIdentification><cbc:ID>20131312955</cbc:ID></cac:PartyIdentification></cac:SenderParty><cac:ReceiverParty><cac:PartyIdentification><cbc:ID>${expected.issuerRuc}</cbc:ID></cac:PartyIdentification></cac:ReceiverParty><cac:DocumentResponse><cac:Response><cbc:ReferenceID>${expected.fullNumber}</cbc:ReferenceID><cbc:ResponseCode>${code}</cbc:ResponseCode><cbc:Description>FICTITIOUS LOCAL RECEIPT</cbc:Description></cac:Response><cac:DocumentReference><cbc:ID>${expected.fullNumber}</cbc:ID><cbc:DocumentTypeCode>${expected.documentType}</cbc:DocumentTypeCode></cac:DocumentReference></cac:DocumentResponse></ApplicationResponse>`;
}
export function guideSidecarPackCdr(xml: string | Buffer, expected = guideSidecarCdrExpected()): Buffer {
  return Buffer.from(zipSync({ [`R-${expected.issuerRuc}-${expected.documentType}-${expected.fullNumber}.xml`]: Buffer.isBuffer(xml) ? xml : Buffer.from(xml) },
    { level: 0, mtime: new Date(2000, 0, 1) }));
}
