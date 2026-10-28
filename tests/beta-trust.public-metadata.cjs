// Lee únicamente el certificado PÚBLICO del XML del piloto previo autorizado.
// No abre P12/PFX, vault, DB ni archivos de secretos; tampoco descarga URLs.
const fs = require('node:fs');
const path = require('node:path');
const { X509Certificate } = require('node:crypto');
const { createRequire } = require('node:module');
const localRequire = createRequire(path.resolve(__dirname, '../services/sunat-service/package.json'));
const forge = localRequire('node-forge');
const source = path.resolve(__dirname, '../tmp/beta-pilot/20615878481-20261002/20615878481-01-FQ01-1.xml');
if (!process.argv.includes('--public-only')) throw new Error('Sólo metadatos públicos autorizados');
const xml = fs.readFileSync(source, 'utf8');
const value = xml.match(/<(?:\w+:)?X509Certificate(?:\s[^>]*)?>([A-Za-z0-9+/=\s]+)<\/(?:\w+:)?X509Certificate>/)?.[1];
if (!value || !xml.includes('20615878481')) throw new Error('Piloto público no disponible');
const x509 = new X509Certificate(Buffer.from(value.replace(/\s/g, ''), 'base64'));
const cert = forge.pki.certificateFromPem(x509.toString());
const issuer = cert.issuer.attributes.filter(a => ['2.5.4.3', '2.5.4.10', '2.5.4.6'].includes(a.type)).map(a => ({ oid: a.type, value: a.value }));
const urls = [];
for (const name of ['authorityInfoAccess', 'cRLDistributionPoints']) {
  const extension = cert.getExtension(name);
  for (const match of String(extension?.value ?? '').matchAll(/https?:\/\/[^\s\x00-\x20\x7f-\xff]+/g)) {
    try { const url = new URL(match[0]); if (url.username || url.password || url.search || url.hash) continue;
      urls.push({ source: name, publicUrl: url.href }); } catch {}
  }
}
console.log(JSON.stringify({ ruc: '20615878481', environment: 'BETA', issuer, urls,
  readsPrivateMaterial: false, officialRequests: 0, fiscalWrites: 0, trustVerified: false }));
