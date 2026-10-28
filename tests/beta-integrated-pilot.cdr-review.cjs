// Read-only inspection of the ALREADY received public Beta CDR. No PKI trust,
// certificate pinning, signing, keys, DB, network, state transitions or resend.
'use strict';
const fs = require('node:fs'), path = require('node:path');
const { createHash, X509Certificate } = require('node:crypto');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../tmp/beta-integrated-pilot/20615878481-20261002-FQ02-1');
const localRequire = createRequire(path.resolve(__dirname, '../services/sunat-service/package.json'));
const { DOMParser } = localRequire('@xmldom/xmldom');
const { SignedXml } = localRequire('xml-crypto');
const DS = 'http://www.w3.org/2000/09/xmldsig#';
if (process.argv.length !== 3 || process.argv[2] !== '--offline-only') throw new Error('OFFLINE_ONLY_REQUIRED');
global.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
function read(name, limit = 65536) {
  const target = path.join(root, name), stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > limit) throw new Error('PUBLIC_ARTIFACT_INVALID');
  const bytes = fs.readFileSync(target);
  if (bytes.length !== stat.size) throw new Error('PUBLIC_ARTIFACT_CHANGED');
  return bytes;
}
try {
  const result = JSON.parse(read('result.json')), evidence = JSON.parse(read('cdr-trust.json'));
  if (result.ruc !== '20615878481' || result.environment !== 'BETA' || result.reference !== 'FQ02-1' ||
      result.requests !== 1 || result.productionRequests !== 0 || result.fiscalWrites !== 0 || !result.submissionLocked ||
      evidence.ruc !== result.ruc || evidence.reference !== result.reference || evidence.environment !== 'BETA') throw new Error('PILOT_SCOPE_INVALID');
  const bytes = read('cdr-beta.xml', 2 * 1024 * 1024), xml = bytes.toString('utf8');
  if (!Buffer.from(xml).equals(bytes) || /<!|<\?(?!xml\s)/i.test(xml) ||
      createHash('sha256').update(bytes).digest('hex') !== evidence.cdrXmlSha256) throw new Error('CDR_HASH_OR_XML_INVALID');
  const document = new DOMParser({ onError: () => { throw new Error('XML_INVALID'); } }).parseFromString(xml, 'application/xml');
  const signatures = document.getElementsByTagNameNS(DS, 'Signature');
  let embeddedCertificateParseable = false, signatureMathematicallyVerified = false;
  let embeddedCertificateBytes = null, signatureBytes = null;
  if (signatures.length === 1) {
    const sig = signatures[0], certs = sig.getElementsByTagNameNS(DS, 'X509Certificate');
    const values = sig.getElementsByTagNameNS(DS, 'SignatureValue'), refs = sig.getElementsByTagNameNS(DS, 'Reference');
    if (values.length === 1) signatureBytes = Buffer.from(values[0].textContent.replace(/\s/g, ''), 'base64').length;
    if (certs.length === 1) {
      const encoded = certs[0].textContent.replace(/\s/g, '');
      if (/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) && encoded.length <= 65536) {
        const der = Buffer.from(encoded, 'base64'); embeddedCertificateBytes = der.length;
        try {
          const certificate = new X509Certificate(der); embeddedCertificateParseable = true;
          // This is only a mathematical check against an untrusted public key.
          // Never derives trust, identity or a signer pin from received KeyInfo.
          if (refs.length === 1 && refs[0].getAttribute('URI') === '') {
            const verifier = new SignedXml({ publicCert: certificate.toString(), getCertFromKeyInfo: () => null });
            verifier.loadSignature(sig); signatureMathematicallyVerified = verifier.checkSignature(xml);
          }
        } catch { /* Malformed dummy certificate or invalid signature: no trust. */ }
      }
    }
  }
  console.log(JSON.stringify({ state: 'OFFLINE_PUBLIC_CDR_REVIEWED', ruc: result.ruc, environment: 'BETA', reference: 'FQ02-1',
    responseCode: result.responseCode, observationCount: result.observationCount, signatureCount: signatures.length,
    embeddedCertificateBytes, embeddedCertificateParseable, signatureBytes, signatureMathematicallyVerified,
    cdrSignatureTrustVerified: false, fiscalAcceptance: false, originalRequests: 1, newRequests: 0,
    fiscalWrites: 0, productionRequests: 0, artifactWrites: 0,
    notice: 'Inspección de bytes públicos; no equivale a confianza PKI ni cambia el estado del piloto.' }));
} catch {
  process.exitCode = 1;
  console.error(JSON.stringify({ state: 'OFFLINE_REVIEW_BLOCKED', newRequests: 0, fiscalWrites: 0, productionRequests: 0 }));
}
