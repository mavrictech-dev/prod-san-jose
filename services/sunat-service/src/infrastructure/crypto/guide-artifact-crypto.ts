import { createHash, X509Certificate } from 'node:crypto';
import forge from 'node-forge';
import { zipSync, unzipSync } from 'fflate';
import { fiscalRuc, fiscalTimestamp } from '@factuez/sunat-core/dist/fiscal-note';
import { betaCdrCrc32, betaCdrZipMetadata } from '../../application/beta-summary-acceptance';
import { CAC_NS, CBC_NS, children } from '../sunat/safe-xml';
import { inspectCertificate } from './certificate-inspector';
import { certificateRucCandidates } from './certificate-identity';
import type { BetaIssuerPublicCertificates } from './beta-owner-xml-trust';
import type { CertificateTrustService } from './certificate-trust.service';
import { parseSafeInvoice, verifyLocalSignedInvoice, XmlSignerService } from './xml-signer.service';

export type GuideArtifactIdentity = { issuerRuc: string; documentType: '09' | '31'; fullNumber: string };
export type LocalGuideSigningInput = GuideArtifactIdentity & { unsignedXml: string };
export type LocalGuideArtifact = {
  xml: string; zip: Buffer; xmlSha256: string; zipSha256: string; digestValue: string;
  certificateFingerprintSha256: string; certificatePem: string; fileName: string;
  signingIdentityChecked: true; certificateTrusted: false;
  officialCdrVerified: false; transmissionAuthorized: false; authorizedForTransfer: false;
};
export type GuideArtifactCryptoErrorCode = 'GUIDE_INPUT_INVALID' | 'GUIDE_XML_INVALID' | 'GUIDE_IDENTITY_MISMATCH'
  | 'GUIDE_CERTIFICATE_INVALID' | 'GUIDE_CERTIFICATE_RUC_MISMATCH' | 'GUIDE_SIGNING_FAILED'
  | 'GUIDE_ZIP_INVALID' | 'GUIDE_ISSUER_UNTRUSTED' | 'GUIDE_INPUT_CHANGED';
export class GuideArtifactCryptoError extends Error {
  constructor(readonly code: GuideArtifactCryptoErrorCode) { super(code); this.name = 'GuideArtifactCryptoError'; }
}
function deny(code: GuideArtifactCryptoErrorCode): never { throw new GuideArtifactCryptoError(code); }
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
type Element = ReturnType<typeof parseSafeInvoice>['root'];
function one(parent: Element, ns: string, name: string): Element {
  const matches = children(parent, ns, name); let count = 0;
  for (let n = parent.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && (n as Element).localName === name) count++;
  if (matches.length !== 1 || count !== 1) deny('GUIDE_XML_INVALID');
  return matches[0];
}
function text(parent: Element, ns: string, name: string): string {
  const node = one(parent, ns, name), value = node.textContent ?? '';
  if (!value || value !== value.trim() || value.length > 40 || node.getElementsByTagName('*').length) deny('GUIDE_XML_INVALID');
  return value;
}
function validateIdentity(input: GuideArtifactIdentity): void {
  try {
    fiscalRuc(input.issuerRuc, 'issuerRuc');
    if (!['09', '31'].includes(input.documentType) || typeof input.fullNumber !== 'string' ||
      !(input.documentType === '09' ? /^T[A-Z0-9]{3}-[1-9][0-9]{0,7}$/ : /^V[A-Z0-9]{3}-[1-9][0-9]{0,7}$/).test(input.fullNumber)) deny('GUIDE_INPUT_INVALID');
  } catch { deny('GUIDE_INPUT_INVALID'); }
}
function guideXml(input: LocalGuideSigningInput): void {
  validateIdentity(input);
  try {
    if (typeof input.unsignedXml !== 'string' || Buffer.from(input.unsignedXml).toString('utf8') !== input.unsignedXml) deny('GUIDE_XML_INVALID');
    const { root } = parseSafeInvoice(input.unsignedXml, 'DespatchAdvice');
    const party = one(one(root, CAC_NS, 'DespatchSupplierParty'), CAC_NS, 'Party');
    if (text(one(party, CAC_NS, 'PartyIdentification'), CBC_NS, 'ID') !== input.issuerRuc ||
      text(root, CBC_NS, 'ID') !== input.fullNumber || text(root, CBC_NS, 'DespatchAdviceTypeCode') !== input.documentType) deny('GUIDE_IDENTITY_MISMATCH');
  } catch (error) { if (error instanceof GuideArtifactCryptoError) throw error; deny('GUIDE_XML_INVALID'); }
}

/** Pure local adapter. P12/password stay in memory; identity matching is not PKI trust or SUNAT authorization. */
export function signLocalGuideXml(input: LocalGuideSigningInput, pkcs12: Buffer, password: string): LocalGuideArtifact {
  try { if (!input || Object.keys(input).sort().join(',') !== 'documentType,fullNumber,issuerRuc,unsignedXml') deny('GUIDE_INPUT_INVALID'); }
  catch { deny('GUIDE_INPUT_INVALID'); }
  guideXml(input);
  let metadata: ReturnType<typeof inspectCertificate>;
  try {
    if (!Buffer.isBuffer(pkcs12) || typeof password !== 'string') deny('GUIDE_CERTIFICATE_INVALID');
    metadata = inspectCertificate(pkcs12, password);
  } catch { deny('GUIDE_CERTIFICATE_INVALID'); }
  if (metadata.subjectRucCandidates.length !== 1 || metadata.subjectRucCandidates[0] !== input.issuerRuc) deny('GUIDE_CERTIFICATE_RUC_MISMATCH');
  let signed: ReturnType<XmlSignerService['sign']>;
  try {
    signed = new XmlSignerService().sign(input.unsignedXml, pkcs12, password, 'DespatchAdvice');
    if (signed.certificateFingerprintSha256 !== metadata.fingerprint ||
      verifyLocalSignedInvoice(signed.xml, metadata.certificatePem, input.unsignedXml, 'DespatchAdvice') !== signed.digestValue) deny('GUIDE_SIGNING_FAILED');
  } catch { deny('GUIDE_SIGNING_FAILED'); }
  const fileName = `${input.issuerRuc}-${input.documentType}-${input.fullNumber}.xml`, bytes = Buffer.from(signed.xml, 'utf8');
  let zip: Buffer;
  try {
    // Fixed DOS timestamp, compression and a single member: reproducible bytes, independent of wall clock/TZ.
    zip = Buffer.from(zipSync({ [fileName]: bytes }, { level: 0, mtime: new Date(2000, 0, 1, 0, 0, 0), os: 0 }));
    const metadata = betaCdrZipMetadata(zip, fileName), archived = unzipSync(zip);
    if (zip.readUInt16LE(zip.length - 12) !== 1 || Object.keys(archived).length !== 1 ||
      !Buffer.from(archived[fileName]).equals(bytes) || metadata.size !== bytes.length || metadata.crc !== betaCdrCrc32(bytes)) deny('GUIDE_ZIP_INVALID');
  } catch { deny('GUIDE_ZIP_INVALID'); }
  return { ...signed, zip, xmlSha256: hash(bytes), zipSha256: hash(zip), certificatePem: metadata.certificatePem, fileName,
    signingIdentityChecked: true, certificateTrusted: false,
    officialCdrVerified: false, transmissionAuthorized: false, authorizedForTransfer: false };
}

export type GuideIssuerTrustInput = LocalGuideSigningInput & {
  xml: string; certificateFingerprintSha256: string; asOf: string;
};
/** Optional owner-wired offline trust check, using the same public resolver/policy as BetaOwnerXmlTrust.
 * No environment discovery or registration here. A positive proof still grants no transmission capability. */
export async function verifyGuideIssuerXmlTrust(input: GuideIssuerTrustInput,
  certificates: BetaIssuerPublicCertificates, trust: Pick<CertificateTrustService, 'evaluate'>) {
  try {
    const snapshot = structuredClone(input), original = JSON.stringify(input);
    guideXml(snapshot); fiscalTimestamp(snapshot.asOf, 'asOf');
    if (!HASH.test(snapshot.certificateFingerprintSha256)) deny('GUIDE_ISSUER_UNTRUSTED');
    const loaded = await certificates.load(snapshot.issuerRuc, snapshot.certificateFingerprintSha256);
    const chain = structuredClone(loaded);
    if (!chain || typeof chain.certificatePem !== 'string' || chain.certificatePem.length > 65536 || chain.certificatePem.includes('PRIVATE KEY') ||
      !Array.isArray(chain.chainPems) || chain.chainPems.length > 16 || chain.chainPems.some(p => typeof p !== 'string' || p.length > 65536 || p.includes('PRIVATE KEY'))) deny('GUIDE_ISSUER_UNTRUSTED');
    const x509 = new X509Certificate(chain.certificatePem), cert = forge.pki.certificateFromPem(chain.certificatePem), now = new Date(snapshot.asOf);
    const metadata = { certificatePem: chain.certificatePem, chainPems: chain.chainPems,
      fingerprint: x509.fingerprint256.replaceAll(':', '').toLowerCase(), expiresAt: new Date(x509.validTo),
      selfSigned: x509.subject === x509.issuer && x509.verify(x509.publicKey),
      digitalSignature: (cert.getExtension('keyUsage') as { digitalSignature?: boolean } | null)?.digitalSignature === true,
      subjectRucCandidates: certificateRucCandidates(cert.subject.attributes) };
    if (now < new Date(x509.validFrom) || now >= metadata.expiresAt || x509.ca || x509.publicKey.asymmetricKeyType !== 'rsa' ||
      (x509.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 || metadata.selfSigned || !metadata.digitalSignature ||
      metadata.fingerprint !== snapshot.certificateFingerprintSha256 || metadata.subjectRucCandidates.length !== 1 || metadata.subjectRucCandidates[0] !== snapshot.issuerRuc) deny('GUIDE_ISSUER_UNTRUSTED');
    const proof = await trust.evaluate(structuredClone(metadata), snapshot.issuerRuc, now);
    if (!proof || proof.profile !== 'OFFLINE-PINNED-ROOTS-CRL-v1' || proof.chainValid !== true || proof.identityMatched !== true ||
      proof.revocation !== 'VERIFIED_OFFLINE_CRL' || !Array.isArray(proof.blockers) || proof.blockers.length ||
      proof.certificateFingerprint !== metadata.fingerprint || proof.checkedAt !== snapshot.asOf || !HASH.test(proof.trustStoreSha256 ?? '')) deny('GUIDE_ISSUER_UNTRUSTED');
    const digestValue = verifyLocalSignedInvoice(snapshot.xml, chain.certificatePem, snapshot.unsignedXml, 'DespatchAdvice');
    if (JSON.stringify(input) !== original || JSON.stringify(loaded) !== JSON.stringify(chain)) deny('GUIDE_INPUT_CHANGED');
    return Object.freeze({ digestValue, certificateFingerprintSha256: metadata.fingerprint, trustStoreSha256: proof.trustStoreSha256!,
      checkedAt: snapshot.asOf, officialCdrVerified: false as const, transmissionAuthorized: false as const, authorizedForTransfer: false as const });
  } catch (error) { if (error instanceof GuideArtifactCryptoError) throw error; deny('GUIDE_ISSUER_UNTRUSTED'); }
}
