import { Injectable } from '@nestjs/common';
import { X509Certificate } from 'node:crypto';
import forge from 'node-forge';
import { CertificateTrustService, loadPinnedPublicFile } from './certificate-trust.service';
import { certificateRucCandidates } from './certificate-identity';
import { parseSafeInvoice, verifyLocalSignedInvoice } from './xml-signer.service';
import { CAC_NS, CBC_NS, child, leaf } from '../sunat/safe-xml';

/** El firmante de SUNAT se fija por archivo/hash de despliegue, jamás por KeyInfo del CDR recibido. */
@Injectable()
export class CdrSignatureTrustService {
  constructor(private readonly trust: CertificateTrustService) {}
  private async signer(): Promise<string | null> {
    try {
      const pinned = await loadPinnedPublicFile(process.env.SUNAT_CDR_SIGNER_CERT_FILE, process.env.SUNAT_CDR_SIGNER_CERT_SHA256);
      const pems = pinned.text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
      if (!pems.length || pems.length > 16 || pinned.text.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim()) return null;
      const leafPem = pems[0]!;
      const x509 = new X509Certificate(leafPem), certificate = forge.pki.certificateFromPem(leafPem);
      const metadata = { fingerprint: x509.fingerprint256.replaceAll(':', '').toLowerCase(), expiresAt: new Date(x509.validTo),
        selfSigned: x509.subject === x509.issuer && x509.verify(x509.publicKey), certificatePem: leafPem, chainPems: pems.slice(1),
        digitalSignature: (certificate.getExtension('keyUsage') as { digitalSignature?: boolean } | null)?.digitalSignature === true,
        subjectRucCandidates: certificateRucCandidates(certificate.subject.attributes) };
      const proof = await this.trust.evaluate(metadata, '20131312955');
      if (!proof.chainValid || !proof.identityMatched || proof.revocation !== 'VERIFIED_OFFLINE_CRL') return null;
      return leafPem;
    } catch { return null; }
  }
  async configured(): Promise<boolean> { return (await this.signer()) !== null; }
  async verify(xml: Buffer): Promise<boolean> {
    try {
      const leafPem = await this.signer(); if (!leafPem) return false;
      const value = xml.toString('utf8'); if (!Buffer.from(value).equals(xml)) return false;
      const parsed = parseSafeInvoice(value, 'ApplicationResponse');
      if (leaf(child(child(parsed.root, CAC_NS, 'SenderParty'), CAC_NS, 'PartyIdentification'), CBC_NS, 'ID', 11) !== '20131312955') return false;
      const signatures = parsed.document.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature');
      if (signatures.length !== 1 || signatures[0].parentNode !== parsed.extension) return false;
      parsed.extension.removeChild(signatures[0]);
      verifyLocalSignedInvoice(value, leafPem, parsed.root.toString(), 'ApplicationResponse');
      return true;
    } catch { return false; } // Ausencia de pin/CRL, algoritmo o firma inválida nunca equivalen a confianza.
  }
}
