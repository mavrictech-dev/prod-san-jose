import { X509Certificate } from 'node:crypto';
import forge from 'node-forge';
import { MAX_CERTIFICATE_BYTES } from './certificate-inspector';

/** Diagnostic export: select the saved leaf fingerprint, including an expired certificate.
 * Only X509 DER leaves this function. No private key conversion, certificate activation or trust decision.
 */
export function storedPublicCertificate(bytes: Buffer, password: string, fingerprint: string): Buffer {
 try {
  if (!bytes.length || bytes.length > MAX_CERTIFICATE_BYTES || !/^[a-f0-9]{64}$/.test(fingerprint)) throw Error();
  const archive = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(bytes.toString('binary')), false, password);
  const bags = archive.getBags({bagType:forge.pki.oids.certBag})[forge.pki.oids.certBag] ?? [];
  if (bags.length > 16) throw Error();
  const matches = bags.flatMap(b => b.cert ? [new X509Certificate(forge.pki.certificateToPem(b.cert))] : [])
   .filter(c => c.fingerprint256.replaceAll(':','').toLowerCase() === fingerprint);
  if (matches.length !== 1) throw Error();
  return Buffer.from(matches[0].raw);
 } catch { throw Error('PUBLIC_CERTIFICATE_UNAVAILABLE'); }
}
