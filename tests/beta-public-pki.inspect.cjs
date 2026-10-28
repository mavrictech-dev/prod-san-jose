'use strict';

// Standalone PUBLIC-PKI audit. Does not import application/configuration code.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');

const PROJECT = path.resolve(__dirname, '..');
const INPUT = path.join(PROJECT, 'tmp/beta-pilot/20615878481-20261002');
const OUTPUT = path.join(PROJECT, 'tmp/beta-public-pki/20615878481-20261002');
const REPOSITORY = 'https://pki.reniec.gob.pe/repositorio/';
const DS = 'http://www.w3.org/2000/09/xmldsig#';
const IMAGE = 'sha256:d33e1d2100d1accd204cc4e265de5321aaea113b824bc9fa2403dc723f8b2e32';
const XMLS = [
  { name: '20615878481-01-FQ01-1.xml', role: 'invoice', sha256: 'aae30a18b5ad395ecd11e7f27ca6029cd3cf618decabb8e100662f1b2c20b5e6' },
  { name: 'cdr-beta.xml', role: 'cdr-beta', sha256: 'bb4fe9dfbbb65a956407b89ce53de85a5c4fd53423d69f15df89c4c4a83d8c37' },
];
// Certificate pins are over DER; CRL pins identify this exact public snapshot.
// A changed/expired snapshot requires a new reviewed audit, never weaker flags.
const SOURCES = [
  { file: 'caclass1r.crt', kind: 'certificate', url: 'http://crt.reniec.gob.pe/crt/sha2/caclass1r.crt', cn: 'ECEP-RENIEC CAClass 1', sha256: '6c9d72e967d8e5f6435090851ddb7493525b141d6d5f6a8afc2280ff4f504c56', source: 'invoice-aia' },
  { file: 'ecep.crt', kind: 'certificate', url: 'http://www.reniec.gob.pe/crt/sha2/ecep.crt', cn: 'ECEP-RENIEC', sha256: '91520e1f381a46402b9490c06749b2d81ddad4b53e7f252a1dd79b55dfcb340b', sha1: '2fe0a4ab97544334c122bb142e39e91f69607647', source: 'repository' },
  { file: 'ecernep-root3.crt', kind: 'certificate', url: 'http://www.reniec.gob.pe/crt/sha2/ecernep.crt', cn: 'ECERNEP PERU CA ROOT 3', sha256: '96508217c36f3bbc556e2e07d7ab50c40da8027c388235813322e41b87a568be', sha1: 'e611d33d29857be83b5003704bb61c9883ed8ded', source: 'repository' },
  { file: 'caclass1r-primary.crl', kind: 'crl', url: 'http://crl.reniec.gob.pe/crl/sha2/caclass1r.crl', sha256: 'f67ebbcc679ae596e1ffa2e4aa46a31f96ed14f863f74e0c8cfa8365d403da16', source: 'invoice-cdp' },
  { file: 'caclass1r-mirror.crl', kind: 'crl', url: 'http://crl2.reniec.gob.pe/crl/sha2/caclass1r.crl', sha256: '00ff0b26a6edc44ea08eabac050395eea2208574660e5aa573779257916c25a3', source: 'invoice-cdp' },
  { file: 'ecep.crl', kind: 'crl', url: 'http://crl.reniec.gob.pe/arl/sha2/ecep.crl', sha256: '931fe7fa0b1ac45f193b5442139d0a2156086a469fc92a0744d717531c065095', source: 'repository' },
  { file: 'ecernep-root3.crl', kind: 'crl', url: 'http://crl.reniec.gob.pe/arl/sha2/ecernep.crl', sha256: '131163cc73d94f9ad5f52e2de2a534efe174adc8b8f14a3618572e19a8191694', source: 'repository' },
];
const DERIVED = ['invoice-leaf.pem', 'caclass1r.pem', 'ecep.pem', 'ecernep-root3.pem', 'intermediates.pem', 'crls-primary.pem', 'crls-mirror.pem'];
const digest = (b, alg = 'sha256') => crypto.createHash(alg).update(b).digest('hex');
function demand(ok, code) { if (!ok) throw new Error(code); }

function tlv(b, offset = 0, limit = b.length) {
  demand(offset + 2 <= limit && limit <= b.length, 'ASN1_TRUNCATED');
  const start = offset;
  const tag = b[offset++];
  demand((tag & 31) !== 31, 'ASN1_HIGH_TAG_UNSUPPORTED');
  let length = b[offset++];
  if (length & 128) {
    const count = length & 127;
    demand(count > 0 && count <= 4 && offset + count <= limit && b[offset] !== 0, 'ASN1_LENGTH');
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + b[offset++];
    demand(length >= 128, 'ASN1_NON_MINIMAL_LENGTH');
  }
  demand(offset + length <= limit, 'ASN1_TRUNCATED');
  return { tag, start, content: offset, end: offset + length };
}
function one(b, tag) {
  const n = tlv(b);
  demand(n.end === b.length && (tag === undefined || n.tag === tag), 'ASN1_STRUCTURE');
  return n;
}
function children(b, n) {
  demand((n.tag & 32) !== 0, 'ASN1_NOT_CONSTRUCTED');
  const result = [];
  for (let offset = n.content; offset < n.end;) {
    const c = tlv(b, offset, n.end);
    result.push(c); offset = c.end;
  }
  return result;
}
function oid(b, n) {
  demand(n.tag === 6 && n.end > n.content, 'ASN1_OID');
  const values = []; let value = 0; let continuation = false;
  for (const byte of b.subarray(n.content, n.end)) {
    demand(!(value === 0 && byte === 128), 'ASN1_OID_NON_MINIMAL');
    value = value * 128 + (byte & 127);
    demand(Number.isSafeInteger(value), 'ASN1_OID_RANGE');
    continuation = (byte & 128) !== 0;
    if (!continuation) { values.push(value); value = 0; }
  }
  demand(!continuation && values.length > 0, 'ASN1_OID_TRUNCATED');
  const first = values.shift();
  return [Math.min(2, Math.floor(first / 40)), first < 80 ? first % 40 : first - 80, ...values].join('.');
}
function parseASN1GeneralName6(encoded) {
  const n = one(encoded, 0x86); // [6] IMPLICIT IA5String, primitive, exact DER bounds.
  const bytes = encoded.subarray(n.content, n.end);
  demand(bytes.length > 0 && bytes.every(c => c >= 0x21 && c <= 0x7e), 'GENERALNAME6_IA5');
  const uri = bytes.toString('ascii');
  demand(/^https?:\/\//.test(uri), 'GENERALNAME6_PROTOCOL');
  const parsed = new URL(uri);
  demand(!parsed.username && !parsed.password && !parsed.hash, 'GENERALNAME6_URI');
  return uri; // Original octets, not URL normalization or an ASN.1 regex scan.
}
function extensions(b) {
  const certificate = children(b, one(b, 0x30));
  demand(certificate.length === 3 && certificate[0].tag === 0x30, 'CERTIFICATE_STRUCTURE');
  const tbs = children(b, certificate[0]);
  const block = tbs.filter(n => n.tag === 0xa3);
  demand(block.length <= 1, 'DUPLICATE_EXTENSIONS');
  if (!block.length) return new Map();
  const explicit = children(b, block[0]);
  demand(explicit.length === 1 && explicit[0].tag === 0x30, 'EXTENSIONS_STRUCTURE');
  const result = new Map();
  for (const e of children(b, explicit[0])) {
    demand(e.tag === 0x30, 'EXTENSION_STRUCTURE');
    const c = children(b, e); const key = oid(b, c[0]);
    demand(c.length === 2 || (c.length === 3 && c[1].tag === 1), 'EXTENSION_STRUCTURE');
    const value = c[c.length - 1];
    demand(value.tag === 4 && !result.has(key), 'EXTENSION_VALUE');
    result.set(key, b.subarray(value.content, value.end));
  }
  return result;
}
function authorityUris(raw) {
  const exts = extensions(raw); const aia = []; const cdp = [];
  const a = exts.get('1.3.6.1.5.5.7.1.1');
  if (a) for (const record of children(a, one(a, 0x30))) {
    const c = children(a, record);
    demand(c.length === 2, 'AIA_STRUCTURE');
    const method = oid(a, c[0]);
    if (c[1].tag === 0x86) aia.push({ method, uri: parseASN1GeneralName6(a.subarray(c[1].start, c[1].end)) });
  }
  const d = exts.get('2.5.29.31');
  if (d) for (const point of children(d, one(d, 0x30))) {
    demand(point.tag === 0x30, 'CDP_STRUCTURE');
    for (const field of children(d, point)) if (field.tag === 0xa0) {
      const names = children(d, field);
      demand(names.length === 1, 'CDP_NAME_STRUCTURE');
      if (names[0].tag === 0xa0) for (const name of children(d, names[0])) {
        if (name.tag === 0x86) cdp.push(parseASN1GeneralName6(d.subarray(name.start, name.end)));
      }
    }
  }
  return { aia, cdp };
}
function canonicalBase64(text) {
  const s = text.replace(/[\t\r\n ]/g, '');
  demand(s.length > 0 && s.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(s), 'BASE64_INVALID');
  const b = Buffer.from(s, 'base64');
  demand(b.toString('base64') === s, 'BASE64_NON_CANONICAL');
  return b;
}
function xmlSignaturePublicBlocks(xml) {
  demand(!/<!DOCTYPE|<!ENTITY/i.test(xml), 'XML_DTD_FORBIDDEN');
  // Namespace-aware, bounded scanner for local public blocks. No entity expansion,
  // no schema loads and no claim to verify XMLDSig or canonicalization.
  const stack = []; const signatures = []; const certs = [];
  let offset = 0;
  function addText(text) { if (stack.length) stack[stack.length - 1].text += text; }
  while (offset < xml.length) {
    const start = xml.indexOf('<', offset);
    if (start < 0) { addText(xml.slice(offset)); break; }
    addText(xml.slice(offset, start));
    if (xml.startsWith('<!--', start)) {
      const end = xml.indexOf('-->', start + 4); demand(end >= 0, 'XML_COMMENT'); offset = end + 3; continue;
    }
    if (xml.startsWith('<![CDATA[', start)) {
      const end = xml.indexOf(']]>', start + 9); demand(end >= 0, 'XML_CDATA'); addText(xml.slice(start + 9, end)); offset = end + 3; continue;
    }
    if (xml.startsWith('<?', start)) {
      const end = xml.indexOf('?>', start + 2); demand(end >= 0, 'XML_PI'); offset = end + 2; continue;
    }
    const match = /^<([^<>]*?(?:"[^"<>]*"|'[^'<>]*')?[^<>]*?)>/.exec(xml.slice(start));
    demand(match, 'XML_TAG'); offset = start + match[0].length;
    const tag = match[1];
    if (tag.startsWith('/')) {
      const node = stack.pop(); demand(node && tag.slice(1).trim() === node.qname, 'XML_BALANCE'); finish(node); continue;
    }
    const m = /^([A-Za-z_][\w.:-]*)([\s\S]*?)(\/?)$/.exec(tag);
    demand(m, 'XML_NAME');
    const ns = { ...(stack.length ? stack[stack.length - 1].ns : {}) };
    const attrs = [...m[2].matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*("[^"]*"|'[^']*')/g)];
    demand(m[2].replace(/([A-Za-z_][\w.:-]*)\s*=\s*("[^"]*"|'[^']*')/g, '').trim() === '', 'XML_ATTRIBUTES');
    const seen = new Set();
    for (const a of attrs) {
      demand(!seen.has(a[1]), 'XML_DUPLICATE_ATTRIBUTE'); seen.add(a[1]);
      if (a[1] === 'xmlns') ns[''] = a[2].slice(1, -1);
      if (a[1].startsWith('xmlns:')) ns[a[1].slice(6)] = a[2].slice(1, -1);
    }
    const parts = m[1].split(':'); demand(parts.length <= 2, 'XML_NAME');
    const local = parts[parts.length - 1]; const uri = ns[parts.length === 2 ? parts[0] : ''] || '';
    const parentSig = stack.length ? stack[stack.length - 1].sig : undefined;
    const node = { qname: m[1], local, uri, ns, sig: parentSig, text: '', ancestors: stack.map(n => [n.uri, n.local]) };
    if (uri === DS && local === 'Signature') { node.sig = { valuePresent: false, valueBase64Valid: false }; signatures.push(node.sig); }
    if (m[3]) finish(node); else { stack.push(node); demand(stack.length <= 128, 'XML_DEPTH'); }
  }
  demand(stack.length === 0, 'XML_BALANCE');
  return { signatures, certs };
  function finish(n) {
    if (n.uri !== DS || !n.sig) return;
    if (n.local === 'SignatureValue') {
      n.sig.valuePresent = n.text.trim().length > 0;
      try { canonicalBase64(n.text); n.sig.valueBase64Valid = true; } catch { /* Public status only. */ }
    }
    if (n.local === 'X509Certificate' && n.ancestors.some(([u, l]) => u === DS && l === 'KeyInfo') && n.ancestors.some(([u, l]) => u === DS && l === 'X509Data')) certs.push(n.text);
  }
}
function certificateMetadata(c, authority = false) {
  const knownIssuer = c.issuer.split('\n').find(s => s.startsWith('CN='))?.slice(3);
  const known = SOURCES.some(s => s.cn === knownIssuer);
  return {
    sha256: digest(c.raw), ca: c.ca,
    ...(authority ? { authority: c.subject } : {}),
    issuerAuthority: known ? c.issuer : 'WITHHELD_UNRECOGNIZED_ISSUER',
    validFrom: new Date(c.validFrom).toISOString(), validTo: new Date(c.validTo).toISOString(),
    publicKeyType: c.publicKey.asymmetricKeyType,
    publicKeyBits: c.publicKey.asymmetricKeyDetails?.modulusLength,
    ...authorityUris(c.raw),
  };
}
function inspectInputs() {
  const documents = XMLS.map(item => {
    const raw = fs.readFileSync(path.join(INPUT, item.name));
    demand(raw.length < 2 * 1024 * 1024 && digest(raw) === item.sha256, 'INPUT_PIN_MISMATCH');
    const blocks = xmlSignaturePublicBlocks(raw.toString('utf8'));
    const certificates = blocks.certs.map(text => {
      try { const certificate = new crypto.X509Certificate(canonicalBase64(text)); return { status: 'X509_PARSED', certificate }; }
      catch { return { status: 'NO_VALID_PUBLIC_X509' }; }
    });
    return { ...item, signatures: blocks.signatures, certificates };
  });
  const invoice = documents[0];
  demand(invoice.signatures.length === 1 && invoice.certificates.length === 1 && invoice.certificates[0].certificate, 'INVOICE_PUBLIC_CERTIFICATE_MISSING');
  const leaf = invoice.certificates[0].certificate;
  demand(!leaf.ca && digest(leaf.raw) === 'd37b6eb06c4bfd3aba66e9630b84d28689bab2be595343643de02d61b971df8c', 'LEAF_PIN_MISMATCH');
  const uris = authorityUris(leaf.raw);
  demand(uris.aia.some(a => a.method === '1.3.6.1.5.5.7.48.2' && a.uri === SOURCES[0].url), 'AIA_EXACT_URI_MISMATCH');
  demand(uris.cdp.includes(SOURCES[3].url) && uris.cdp.includes(SOURCES[4].url), 'CDP_EXACT_URI_MISMATCH');
  return { documents, leaf };
}
function asDer(raw, label) {
  const text = raw.toString('ascii');
  if (!text.startsWith('-----BEGIN ')) { one(raw, 0x30); return raw; }
  const start = `-----BEGIN ${label}-----`; const end = `-----END ${label}-----`;
  demand(text.startsWith(start) && text.trimEnd().endsWith(end), 'PUBLIC_PEM_FORMAT');
  const der = canonicalBase64(text.slice(start.length, text.lastIndexOf(end))); one(der, 0x30); return der;
}
function pem(label, der) { return `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`; }
function asnTime(b, n) {
  const s = b.subarray(n.content, n.end).toString('ascii');
  demand((n.tag === 23 && /^\d{12}Z$/.test(s)) || (n.tag === 24 && /^\d{14}Z$/.test(s)), 'ASN1_TIME');
  const year = n.tag === 23 ? (+s.slice(0, 2) < 50 ? '20' : '19') + s.slice(0, 2) : s.slice(0, 4);
  const r = s.slice(n.tag === 23 ? 2 : 4);
  const iso = `${year}-${r.slice(0, 2)}-${r.slice(2, 4)}T${r.slice(4, 6)}:${r.slice(6, 8)}:${r.slice(8, 10)}.000Z`;
  const date = new Date(iso); demand(Number.isFinite(+date) && date.toISOString() === iso, 'ASN1_TIME_RANGE'); return iso;
}
function crlMetadata(raw) {
  const der = asDer(raw, 'X509 CRL');
  const c = children(der, one(der, 0x30)); demand(c.length === 3, 'CRL_STRUCTURE');
  const tbs = children(der, c[0]); const i = tbs[0].tag === 2 ? 1 : 0;
  demand(tbs[i].tag === 0x30 && tbs[i + 1].tag === 0x30, 'CRL_STRUCTURE');
  const lastUpdate = asnTime(der, tbs[i + 2]);
  const next = tbs[i + 3]; demand(next && (next.tag === 23 || next.tag === 24), 'CRL_NEXT_UPDATE_REQUIRED');
  const nextUpdate = asnTime(der, next); demand(nextUpdate > lastUpdate, 'CRL_TIME_ORDER');
  let crlNumber;
  const ext = tbs.find(n => n.tag === 0xa0);
  if (ext) for (const e of children(der, children(der, ext)[0])) {
    const fields = children(der, e);
    if (oid(der, fields[0]) === '2.5.29.20') {
      const octets = fields[fields.length - 1]; demand(octets.tag === 4, 'CRL_NUMBER');
      const v = der.subarray(octets.content, octets.end); const n = one(v, 2); crlNumber = v.subarray(n.content, n.end).toString('hex');
    }
  }
  return { der, sha256: digest(der), lastUpdate, nextUpdate, crlNumber };
}
function current(metadata, now) { return +new Date(metadata.lastUpdate) <= now && now < +new Date(metadata.nextUpdate); }
function validateSource(source, bytes) {
  if (source.kind === 'certificate') {
    // RENIEC .crt downloads may carry a textual public authority chain, not
    // just one PEM. Pin the entire download and validate every contained CA.
    const rawPins = {
      'caclass1r.crt': 'cada3d2585c4f9359341cbcde7d63c98bbc8e87ade33042a31520507807a2047',
      'ecep.crt': '23ecc41dfc0fb0424f399062dd3e853d0eb6b48acc059d5aacceace81634537b',
      'ecernep-root3.crt': '96508217c36f3bbc556e2e07d7ab50c40da8027c388235813322e41b87a568be',
    };
    demand(digest(bytes) === rawPins[source.file], 'AUTHORITY_DOWNLOAD_PIN_MISMATCH');
    const text = bytes.toString('ascii');
    const blocks = [...text.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)];
    const embedded = blocks.length ? blocks.map(m => new crypto.X509Certificate(canonicalBase64(m[1]))) : [new crypto.X509Certificate(asDer(bytes, 'CERTIFICATE'))];
    const expected = SOURCES.filter(s => s.kind === 'certificate').slice(SOURCES.findIndex(s => s.file === source.file));
    demand(!text.includes('PRIVATE KEY') && embedded.length === expected.length, 'AUTHORITY_PUBLIC_BUNDLE_STRUCTURE');
    embedded.forEach((c, i) => demand(c.ca && digest(c.raw) === expected[i].sha256, 'AUTHORITY_EMBEDDED_PIN_MISMATCH'));
    const c = embedded[0];
    demand(c.ca && digest(c.raw) === source.sha256 && c.subject.split('\n').includes('CN=' + source.cn), 'AUTHORITY_PIN_MISMATCH');
    if (source.sha1) demand(digest(c.raw, 'sha1') === source.sha1, 'PUBLISHED_AUTHORITY_FINGERPRINT_MISMATCH');
    return { ...source, bytes, certificate: c, der: c.raw };
  }
  demand(digest(bytes) === source.sha256, 'CRL_SNAPSHOT_PIN_MISMATCH');
  return { ...source, bytes, ...crlMetadata(bytes) };
}
const ALLOWED_URLS = new Set([REPOSITORY, ...SOURCES.map(s => s.url)]);
function getPublic(url) {
  demand(ALLOWED_URLS.has(url), 'DOWNLOAD_NOT_ALLOWLISTED');
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https:') ? https : http).get(url, { timeout: 15000, rejectUnauthorized: true, headers: { Accept: '*/*' } }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error('PUBLIC_HTTP_' + response.statusCode)); return; }
      const chunks = []; let count = 0;
      response.on('data', b => { count += b.length; if (count > 8 * 1024 * 1024) req.destroy(new Error('PUBLIC_DOWNLOAD_LIMIT')); else chunks.push(b); });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', () => reject(new Error('PUBLIC_RESPONSE_ERROR')));
    });
    // Redirects, authentication, TLS overrides and arbitrary URI chasing are forbidden.
    req.on('timeout', () => req.destroy(new Error('PUBLIC_DOWNLOAD_TIMEOUT')));
    req.on('error', e => reject(new Error(/^PUBLIC_/.test(e.message) ? e.message : 'PUBLIC_NETWORK_ERROR')));
  });
}
function safeOutputPath() {
  for (let p = OUTPUT;; p = path.dirname(p)) {
    if (fs.existsSync(p)) demand(!fs.lstatSync(p).isSymbolicLink() && fs.statSync(p).isDirectory(), 'OUTPUT_REPARSE_PATH_REFUSED');
    if (p === PROJECT) break;
    demand(p.startsWith(PROJECT + path.sep), 'OUTPUT_OUTSIDE_PROJECT');
  }
}
function derivedFiles(records, leaf) {
  const byName = new Map(records.map(r => [r.file, r]));
  const cert = name => pem('CERTIFICATE', byName.get(name).der);
  const crl = name => pem('X509 CRL', byName.get(name).der);
  return new Map([
    ['invoice-leaf.pem', pem('CERTIFICATE', leaf.raw)],
    ['caclass1r.pem', cert('caclass1r.crt')], ['ecep.pem', cert('ecep.crt')], ['ecernep-root3.pem', cert('ecernep-root3.crt')],
    ['intermediates.pem', cert('caclass1r.crt') + cert('ecep.crt')],
    ['crls-primary.pem', crl('caclass1r-primary.crl') + crl('ecep.crl') + crl('ecernep-root3.crl')],
    ['crls-mirror.pem', crl('caclass1r-mirror.crl') + crl('ecep.crl') + crl('ecernep-root3.crl')],
  ]);
}
async function download(leaf) {
  safeOutputPath();
  for (const name of [...SOURCES.map(s => s.file), ...DERIVED]) demand(!fs.existsSync(path.join(OUTPUT, name)), 'WX_TARGET_ALREADY_EXISTS');
  const html = await getPublic(REPOSITORY); const text = html.toString('utf8');
  for (const s of SOURCES.filter(s => s.source === 'repository')) {
    demand(text.includes(s.url), 'PRIMARY_REPOSITORY_LINK_MISSING');
    if (s.sha1) {
      const row = text.split(/<tr\b/i).find(r => r.split(/<\/tr>/i)[0].includes(s.url) && r.split(/<\/tr>/i)[0].replace(/\s/g, '').includes(s.sha1));
      demand(row, 'PRIMARY_REPOSITORY_FINGERPRINT_MISSING');
    }
  }
  // Independent requests are gathered before any artifact is written.
  const fetched = await Promise.allSettled(SOURCES.map(async s => validateSource(s, await getPublic(s.url))));
  const records = fetched.map(r => { if (r.status === 'rejected') throw r.reason; return r.value; });
  safeOutputPath(); fs.mkdirSync(OUTPUT, { recursive: true }); safeOutputPath();
  const outputs = new Map(records.map(r => [r.file, r.bytes]));
  for (const [name, value] of derivedFiles(records, leaf)) outputs.set(name, Buffer.from(value));
  for (const [name, bytes] of outputs) fs.writeFileSync(path.join(OUTPUT, name), bytes, { flag: 'wx', mode: 0o600 });
  return { records, provenance: { repository: REPOSITORY, fetchedAt: new Date().toISOString(), repositoryHtmlSha256: digest(html), publicArtifactsCreatedExclusively: outputs.size } };
}
function loadSnapshot(leaf) {
  safeOutputPath();
  const records = SOURCES.map(s => {
    const p = path.join(OUTPUT, s.file); demand(!fs.lstatSync(p).isSymbolicLink(), 'PUBLIC_FILE_SYMLINK_REFUSED');
    return validateSource(s, fs.readFileSync(p));
  });
  for (const [name, expected] of derivedFiles(records, leaf)) {
    const p = path.join(OUTPUT, name); demand(!fs.lstatSync(p).isSymbolicLink(), 'PUBLIC_FILE_SYMLINK_REFUSED');
    demand(fs.readFileSync(p).equals(Buffer.from(expected)), 'DERIVED_PUBLIC_FILE_MISMATCH');
  }
  return records;
}
function openssl(args, input, mount = false) {
  const flags = ['run', '--rm', '--pull=never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '32', '--memory', '128m'];
  if (input) flags.push('-i');
  if (mount) flags.push('--mount', `type=bind,source=${OUTPUT},target=/pki,readonly`);
  flags.push('--entrypoint', '/usr/bin/openssl', IMAGE, ...args);
  const result = spawnSync('docker', flags, { input, timeout: 30000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  const stdout = result.stdout || Buffer.alloc(0); const stderr = result.stderr || Buffer.alloc(0);
  // Never emit raw verify diagnostics: OpenSSL prints the personal leaf subject.
  const combined = Buffer.concat([stdout, stderr]).toString('utf8');
  const errors = [...combined.matchAll(/error (\d+) at (\d+) depth lookup:/g)].map(m => ({ code: +m[1], depth: +m[2] }));
  const crlSignatureCheck = args[0] === 'crl' && args.includes('-verify');
  const signatureVerified = crlSignatureCheck ? /(?:^|\r?\n)verify OK(?:\r?\n|$)/.test(combined) : undefined;
  const signatureRejected = crlSignatureCheck ? /(?:^|\r?\n)verify failure(?:\r?\n|$)/.test(combined) : undefined;
  return { args, exit: result.status, transportError: result.error ? 'DOCKER_EXECUTION_UNAVAILABLE' : undefined,
    stdoutSha256: digest(stdout), stderrSha256: digest(stderr), errors,
    signatureVerified, signatureRejected,
    ok: result.status === 0 && !result.error && (!crlSignatureCheck || signatureVerified), ...(args[0] === 'version' && result.status === 0 ? { version: stdout.toString('utf8').trim() } : {}) };
}
function verify(records, leaf, now) {
  const results = []; const version = openssl(['version']); results.push({ check: 'runtime', ...version });
  if (!version.ok) return { ok: false, results };
  demand(/^OpenSSL 3\.0\.22\b/.test(version.version), 'OPENSSL_FIXED_VERSION_MISMATCH');
  const certs = records.filter(r => r.kind === 'certificate');
  const certDatesCurrent = [leaf, ...certs.map(r => r.certificate)].every(c => +new Date(c.validFrom) <= now && now <= +new Date(c.validTo));
  const crlsCurrent = records.filter(r => r.kind === 'crl').every(r => current(r, now));
  const class1 = certs[0].certificate, ecep = certs[1].certificate, root = certs[2].certificate;
  const independentIssuerSignatures = leaf.checkIssued(class1) && leaf.verify(class1.publicKey) && class1.checkIssued(ecep) && class1.verify(ecep.publicKey) && ecep.checkIssued(root) && ecep.verify(root.publicKey) && root.checkIssued(root) && root.verify(root.publicKey);
  const common = ['verify', '-no-CApath', '-no-CAstore', '-CAfile', '/pki/ecernep-root3.pem', '-purpose', 'any', '-auth_level', '2', '-x509_strict', '-check_ss_sig', '-attime', String(Math.floor(now / 1000))];
  results.push({ check: 'root-self-signature-strict', ...openssl([...common, '/pki/ecernep-root3.pem'], undefined, true) });
  for (const r of records.filter(r => r.kind === 'crl')) {
    const signer = r.file.startsWith('caclass1r-') ? 'caclass1r.pem' : r.file === 'ecep.crl' ? 'ecep.pem' : 'ecernep-root3.pem';
    results.push({ check: 'crl-signature:' + r.file, ...openssl(['crl', '-inform', 'DER', '-in', '/dev/stdin', '-noout', '-verify', '-CAfile', '/pki/' + signer], r.der, true) });
    const broken = Buffer.from(r.der); broken[broken.length - 1] ^= 1;
    const rejected = openssl(['crl', '-inform', 'DER', '-in', '/dev/stdin', '-noout', '-verify', '-CAfile', '/pki/' + signer], broken, true);
    // OpenSSL 'crl -verify' may return zero on a bad signature; require its
    // explicit rejection marker, rather than treating exit zero as acceptance.
    results.push({ check: 'crl-corruption-negative:' + r.file, ...rejected,
      ok: !rejected.transportError && rejected.signatureRejected === true && rejected.signatureVerified === false });
  }
  for (const [role, file] of [['primary', 'crls-primary.pem'], ['mirror', 'crls-mirror.pem']]) {
    results.push({ check: 'invoice-chain-crl-all:' + role, ...openssl([...common, '-untrusted', '/pki/intermediates.pem', '-crl_check_all', '-CRLfile', '/pki/' + file, '/pki/invoice-leaf.pem'], undefined, true) });
  }
  const negative = openssl(['verify', '-no-CAfile', '-no-CApath', '-no-CAstore', '-purpose', 'any', '-auth_level', '2', '-x509_strict', '-attime', String(Math.floor(now / 1000)), '-untrusted', '/pki/intermediates.pem', '/pki/invoice-leaf.pem'], undefined, true);
  results.push({ check: 'no-unpinned-root-autotrust-negative', ...negative, ok: negative.exit !== 0 && !negative.transportError && negative.errors.some(e => e.code === 20) });
  return { ok: certDatesCurrent && crlsCurrent && independentIssuerSignatures && results.every(r => r.ok),
    validationUtc: new Date(now).toISOString(), validationEpoch: Math.floor(now / 1000),
    purpose: 'any', authLevel: 2, x509Strict: true, crlCheckAll: true, certDatesCurrent, crlsCurrent, independentIssuerSignatures,
    trustAnchor: { authority: 'ECERNEP PERU CA ROOT 3', sha256: SOURCES[2].sha256, source: REPOSITORY, systemTrustModified: false },
    runtime: { image: IMAGE, network: 'none', readonlyMount: 'public-pki-directory-only', configurationMounted: false }, results };
}
function selfTest() {
  const uri = SOURCES[0].url;
  const name = Buffer.concat([Buffer.from([0x86, Buffer.byteLength(uri)]), Buffer.from(uri)]);
  assert.equal(parseASN1GeneralName6(name), uri);
  assert.throws(() => parseASN1GeneralName6(Buffer.concat([name, Buffer.from('0&/06')])));
  assert.throws(() => parseASN1GeneralName6(Buffer.concat([Buffer.from([0x30, name.length]), name])));
  assert.throws(() => parseASN1GeneralName6(name.subarray(0, name.length - 1)));
  assert.throws(() => parseASN1GeneralName6(Buffer.from([0x86, 1, 0xff])));
  assert.throws(() => parseASN1GeneralName6(Buffer.from([0x86, 0x81, 1, 0x41])));
  const sample = `<x:Signature xmlns:x="${DS}"><x:SignatureValue>YQ==</x:SignatureValue><x:KeyInfo><x:X509Data><x:X509Certificate>Yg==</x:X509Certificate></x:X509Data></x:KeyInfo></x:Signature>`;
  assert.equal(xmlSignaturePublicBlocks(sample).certs.length, 1);
  assert.equal(xmlSignaturePublicBlocks(sample.replace(DS, 'urn:not-dsig')).certs.length, 0);
  assert.equal(xmlSignaturePublicBlocks('<!--' + sample + '--><a/>').certs.length, 0);
  assert.throws(() => xmlSignaturePublicBlocks('<!DOCTYPE a SYSTEM "http://example.invalid"><a/>'));
  assert.throws(() => canonicalBase64('placeholder'));
  assert.equal(current({ lastUpdate: '2026-10-02T00:00:00Z', nextUpdate: '2026-10-03T00:00:00Z' }, Date.parse('2026-10-03T00:00:00Z')), false);
  assert.equal(current({ lastUpdate: '2026-10-02T00:00:00Z', nextUpdate: '2026-10-03T00:00:00Z' }, Date.parse('2026-10-01T00:00:00Z')), false);
  return { ok: true, checks: 13, exactGeneralName6: true, namespaceAwarePublicBlocks: true, freshnessBoundaries: true };
}
async function main() {
  const mode = process.argv[2] || '--inspect';
  demand(process.argv.length <= 3 && ['--inspect', '--self-test', '--download', '--verify'].includes(mode), 'FIXED_MODE_REQUIRED');
  const tests = selfTest();
  if (mode === '--self-test') { console.log(JSON.stringify({ mode, tests }, null, 2)); return; }
  const { documents, leaf } = inspectInputs();
  let records = []; let provenance;
  if (mode === '--download') ({ records, provenance } = await download(leaf));
  if (mode === '--verify') records = loadSnapshot(leaf);
  const now = Date.now();
  const verification = mode === '--verify' ? verify(records, leaf, now) : undefined;
  const report = {
    mode, inspectedUtc: new Date(now).toISOString(), tests,
    scope: 'public XML certificates + fixed official RENIEC downloads; no application configuration',
    documents: documents.map(d => ({ file: d.name, role: d.role, sha256: d.sha256,
      xmlDsigElements: d.signatures.length, signatureValues: d.signatures,
      publicCertificateBlocks: d.certificates.length, certificates: d.certificates.map(c => ({ status: c.status, ...(c.certificate ? certificateMetadata(c.certificate) : {}) })),
      xmlSignatureCryptographicallyVerified: false,
      ...(d.role === 'cdr-beta' ? { authentication: d.certificates.some(c => c.certificate) ? 'PUBLIC_CERTIFICATE_AVAILABLE_XMLDSIG_UNVERIFIED' : 'UNAUTHENTICATABLE_NO_VALID_SUNAT_PUBLIC_LEAF' } : {}) })),
    provenance,
    publicDownloads: records.map(r => ({ file: r.file, url: r.url, source: r.source,
      rawSha256: digest(r.bytes), derSha256: digest(r.der),
      ...(r.certificate ? certificateMetadata(r.certificate, true) : { lastUpdate: r.lastUpdate, nextUpdate: r.nextUpdate, crlNumber: r.crlNumber, current: current(r, now) }) })),
    derivedPublicFiles: records.length ? [...derivedFiles(records, leaf)].map(([file, bytes]) => ({ file, sha256: digest(Buffer.from(bytes)) })) : [],
    verification,
    pilotGate: { changed: false, prepareBetaExecuted: false, cert20615878481Executed: false, completeFiscalTrustEstablished: false,
      reason: 'Independent public invoice chain evidence does not authenticate CDR or configure the application.' },
  };
  console.log(JSON.stringify(report, null, 2));
  if (verification && !verification.ok) process.exitCode = 1;
}
if (require.main === module) main().catch(e => {
  // Do not dump stack, XML, certificate subjects, environment or raw child output.
  const code = /^[A-Z][A-Z0-9_]+$/.test(e.message || '') ? e.message : 'PUBLIC_PKI_INSPECTION_FAILED';
  console.error(JSON.stringify({ error: code, configurationChanged: false })); process.exitCode = 1;
});
module.exports = { parseASN1GeneralName6, authorityUris, xmlSignaturePublicBlocks, selfTest };
