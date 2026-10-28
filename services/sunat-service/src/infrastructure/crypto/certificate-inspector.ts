import { BadRequestException } from "@nestjs/common";
import { createPrivateKey, X509Certificate } from "node:crypto";
import forge from "node-forge";
import { certificateRucCandidates } from './certificate-identity';

export const MAX_CERTIFICATE_BYTES = 512 * 1024;

/** Validación local, no certifica confianza de la cadena ni autorización SUNAT. */
export function inspectCertificate(bytes: Buffer, password: string, now = new Date()) {
  if (!bytes.length || bytes.length > MAX_CERTIFICATE_BYTES)
    throw new BadRequestException("El certificado debe pesar como máximo 512 KB");
  try {
    const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(bytes.toString("binary")), false, password);
    const keys = [forge.pki.oids.pkcs8ShroudedKeyBag, forge.pki.oids.keyBag].flatMap(type =>
      (p12.getBags({ bagType: type })[type] ?? []).flatMap(bag => bag.key ? [bag.key] : []));
    const certificates = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [])
      .flatMap(bag => bag.cert ? [bag.cert] : []);
    if (certificates.length > 16 || keys.length > 4) throw new Error();
    const pairs = new Map<string, { certificate: forge.pki.Certificate; x509: X509Certificate }>();
    for (const key of keys) {
      const privateKey = createPrivateKey(forge.pki.privateKeyToPem(key));
      if (privateKey.asymmetricKeyType !== "rsa" || (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) continue;
      for (const certificate of certificates) {
        const x509 = new X509Certificate(forge.pki.certificateToPem(certificate));
        if (x509.checkPrivateKey(privateKey)) pairs.set(x509.fingerprint256, { certificate, x509 });
      }
    }
    if (pairs.size !== 1) throw new Error();
    const { certificate, x509 } = [...pairs.values()][0];
    if (now < certificate.validity.notBefore || now >= certificate.validity.notAfter) throw new Error();
    const usage = certificate.getExtension("keyUsage") as { digitalSignature?: boolean } | null;
    if (x509.ca || (usage && usage.digitalSignature !== true)) throw new Error();
    return {
      fingerprint: x509.fingerprint256.replace(/:/g, "").toLowerCase(),
      expiresAt: certificate.validity.notAfter,
      selfSigned: x509.subject === x509.issuer && x509.verify(x509.publicKey),
      // Material PÚBLICO para el verificador offline, no se expone en el HTTP de setup.
      certificatePem: forge.pki.certificateToPem(certificate),
      chainPems: certificates.filter(candidate => candidate !== certificate).slice(0, 16).map(candidate => forge.pki.certificateToPem(candidate)),
      digitalSignature: usage?.digitalSignature === true,
      subjectRucCandidates: certificateRucCandidates(certificate.subject.attributes),
    };
  } catch {
    // Nunca propagamos excepciones de Forge que puedan incluir el contenido.
    throw new BadRequestException("PKCS#12 inválido: revise contraseña, vigencia, clave RSA y certificado de firma único");
  }
}
