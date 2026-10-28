import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
const localRequire = createRequire(new URL('../../services/sunat-service/package.json', import.meta.url));
const forge = localRequire('node-forge') as typeof import('node-forge');
/** Clave/cadena ficticias efímeras; nunca acreditan identidad ni confianza de una empresa. */
export function betaSigningFixture(ruc = '20615878481') {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const caPair = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const root = forge.pki.createCertificate(); root.publicKey = forge.pki.publicKeyFromPem(caPair.publicKey); root.serialNumber = '01';
  root.validity.notBefore = new Date(Date.now() - 3600000); root.validity.notAfter = new Date(Date.now() + 86400000);
  root.setSubject([{ name: 'commonName', value: 'ROOT FICTICIA PRUEBAS AISLADAS' }]); root.setIssuer(root.subject.attributes);
  root.setExtensions([{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true }]);
  const caKey = forge.pki.privateKeyFromPem(caPair.privateKey); root.sign(caKey, forge.md.sha256.create());
  const leaf = forge.pki.createCertificate(); leaf.publicKey = forge.pki.publicKeyFromPem(pair.publicKey); leaf.serialNumber = '02';
  leaf.validity.notBefore = root.validity.notBefore; leaf.validity.notAfter = root.validity.notAfter;
  leaf.setSubject([{ name: 'commonName', value: 'FICTICIO SIN IDENTIDAD FISCAL' }, { type: '2.5.4.97', value: `NTRPE-${ruc}` }]);
  leaf.setIssuer(root.subject.attributes); leaf.setExtensions([{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true }]);
  leaf.sign(caKey, forge.md.sha256.create());
  const key = forge.pki.privateKeyFromPem(pair.privateKey), password = 'FICTICIO-NO-CONFIGURACION';
  const p12 = Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(key, [leaf, root], password, { algorithm: 'aes256' })).getBytes(), 'binary');
  return { p12, password, certificatePem: forge.pki.certificateToPem(leaf) };
}
