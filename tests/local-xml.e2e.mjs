// Exclusivamente QA 8091: RUC, cliente y PKCS#12 ficticios. Sin llamadas a SUNAT.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID, generateKeyPairSync, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../services/sunat-service/package.json', import.meta.url));
const forge = require('node-forge'); const { unzipSync } = require('fflate');
const { SignedXml } = require('xml-crypto'); const { DOMParser } = require('@xmldom/xmldom');
const base = 'http://127.0.0.1:8091';
if (!process.argv.includes('--isolated-only')) throw new Error('Indique --isolated-only');
// Restart de Kong puede cerrar el primer socket; esperar sólo con GET público.
let gatewayReady = false;
for (let attempt = 0; attempt < 20; attempt++) {
  try {
    const response = await fetch(base + '/login', { signal: AbortSignal.timeout(2000) });
    gatewayReady = response.status === 200; await response.arrayBuffer();
    if (gatewayReady) break;
  } catch { /* Arranque de gateway, nunca repetir automáticamente un POST. */ }
  await new Promise(resolve => setTimeout(resolve, 500));
}
assert.equal(gatewayReady, true, 'Gateway QA no está listo');
async function call(path, token, body, method = body ? 'POST' : 'GET', key) {
  return fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(25000) });
}
async function json(response, expected = 200) { assert.equal(response.status, expected, `HTTP inesperado ${response.status}`); return response.json(); }
const password = (await readFile(new URL('../.factuez-demo/secrets/initial_admin_password.txt', import.meta.url), 'utf8')).trim();
const { accessToken: admin } = await json(await call('/api/v1/auth/login', undefined, { username: 'demo.admin', password }));
const catalog = await json(await call('/api/v1/documents/catalog/issuance', admin));
assert.equal(catalog.capabilities.demoData, true); assert.equal(catalog.capabilities.fiscalTransmission, false);
const real = catalog.companies.find(c => c.ruc === '20450819230'); assert.ok(real);
const realBefore = await json(await call(`/api/v1/setup/sunat/${real.id}/BETA`, admin));
const suffix = randomBytes(4).toString('hex');
const ruc = '00' + String(BigInt('0x' + randomBytes(5).toString('hex')) % 1000000000n).padStart(9, '0');
const issuer = await json(await call('/api/v1/stations/issuers', admin, { ruc, legalName: `PRUEBA XML FICTICIA ${suffix}`, taxAddress: 'FICTICIA - SIN USO FISCAL', ubigeo: '200101' }), 201);
const branch = await json(await call('/api/v1/stations', admin, { companyId: issuer.id, code: `XML_${suffix}`, name: `PRUEBA laboratorio XML ${suffix}` }), 201);
const point = await json(await call(`/api/v1/stations/${branch.id}/points`, admin, { code: `XML_${suffix}`, name: 'PRUEBA XML local', invoiceSeries: 'FA01', receiptSeries: 'BA01' }), 201);
const pair = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const privateKey = forge.pki.privateKeyFromPem(pair.privateKey);
const cert = forge.pki.createCertificate(); cert.publicKey = forge.pki.publicKeyFromPem(pair.publicKey); cert.serialNumber = '01';
cert.validity.notBefore = new Date(Date.now() - 3600000); cert.validity.notAfter = new Date(Date.now() + 7 * 86400000);
cert.setSubject([{ name: 'commonName', value: 'FICTICIO QA NO VALIDO SUNAT' }]); cert.setIssuer(cert.subject.attributes);
cert.setExtensions([{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true }]); cert.sign(privateKey, forge.md.sha256.create());
const fakeSecret = `ONLY-QA-${randomBytes(20).toString('base64url')}`;
const certificate = Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(privateKey, cert, fakeSecret, { algorithm: 'aes256' })).getBytes(), 'binary');
const configPath = `/api/v1/setup/sunat/${issuer.id}/BETA`;
await json(await call(configPath, admin, { expectedRevision: 0, certificate: { fileName: 'QA-FICTICIO.p12', base64: certificate.toString('base64'), password: fakeSecret } }), 201);
let cashier; const proof = { issuerId: issuer.id, ruc, branchId: branch.id, documents: [] };
try {
  cashier = await json(await call('/api/v1/users', admin, { username: `qa.xml.${suffix}`, fullName: 'PRUEBA permisos XML', password: fakeSecret, roles: ['CASHIER'], branchIds: [branch.id], emissionPointIds: [point.id], series: point.series.map(s => s.id) }), 201);
  const { accessToken: cashierToken } = await json(await call('/api/v1/auth/login', undefined, { username: cashier.username, password: fakeSecret }));
  for (const type of ['SALES_RECEIPT', 'INVOICE']) {
    const body = { emissionPointId: point.id, documentType: type, series: point.series.find(s => s.documentType === type).series,
      customer: { identityType: type === 'INVOICE' ? '6' : '0', identityNumber: type === 'INVOICE' ? '00000000000' : '0', legalName: 'CLIENTE FICTICIO QA' },
      lines: [{ description: 'Diésel B5 PRUEBA XML & FIRMA', quantity: '2.5', unitCode: 'GLL', unitPriceWithTax: '18.50', taxAffectationCode: '10', igvRate: '18' }] };
    const issued = await json(await call('/api/v1/documents', admin, body, 'POST', randomUUID()), 202);
    const path = `/api/v1/local-xml-validation/${issued.documentId}`;
    assert.equal((await call(path)).status, 401);
    assert.equal((await call(path, cashierToken, {}, 'POST')).status, 403);
    assert.equal((await call(`${path}/zip`, cashierToken)).status, 403);
    let result;
    for (let attempt = 0; attempt < 30; attempt++) {
      const response = await call(path, admin, {}, 'POST');
      if (response.status === 201) { result = await response.json(); break; }
      assert.equal(response.status, 409); await response.arrayBuffer();
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.ok(result); assert.equal(result.ready, true); assert.equal(result.signatureVerified, true);
    for (const field of ['fiscalTransmission', 'xsdValidated', 'sunatRulesValidated', 'trustAndRucVerified', 'cdrReceived']) assert.equal(result[field], false);
    assert.doesNotMatch(JSON.stringify(result), /Cipher|StorageKey|password/);
    const repeated = await Promise.all([call(path, admin, {}, 'POST').then(r => json(r, 201)), call(path, admin, {}, 'POST').then(r => json(r, 201))]);
    assert.ok(repeated.every(r => r.id === result.id && r.zipSha256 === result.zipSha256));
    const response = await call(`${path}/zip`, admin); assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^application\/zip/); assert.match(response.headers.get('cache-control'), /no-store/);
    assert.match(response.headers.get('content-disposition'), /PRUEBA-LOCAL\.zip/);
    const zip = Buffer.from(await response.arrayBuffer()); assert.equal(createHash('sha256').update(zip).digest('hex'), result.zipSha256);
    const files = unzipSync(zip); const entries = Object.keys(files); assert.equal(entries.length, 1);
    assert.match(entries[0], new RegExp(`^${ruc}-${type === 'INVOICE' ? '01-FA01' : '03-BA01'}-1\\.xml$`));
    const xml = Buffer.from(files[entries[0]]).toString();
    const parsed = new DOMParser().parseFromString(xml, 'application/xml');
    const signature = parsed.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature'); assert.equal(signature.length, 1);
    const verifier = new SignedXml({ publicCert: forge.pki.certificateToPem(cert), getCertFromKeyInfo: () => null });
    verifier.loadSignature(signature[0]); assert.equal(verifier.checkSignature(xml), true); assert.equal(verifier.getSignedReferences().length, 1);
    const trusted = verifier.getSignedReferences()[0]; assert.ok(trusted.includes(ruc)); assert.ok(trusted.includes('46.25'));
    assert.ok(!xml.includes(fakeSecret)); assert.ok(!xml.includes('PRIVATE KEY'));
    const detail = await json(await call(`/api/v1/documents/${issued.documentId}`, admin));
    assert.equal(detail.fiscalTransmission, false); assert.ok(['PENDING', 'QUEUED', 'PROCESSING'].includes(detail.sunatStatus));
    assert.equal(detail.immutableSnapshot.number, '1'); assert.equal(detail.immutableSnapshot.totals.payableAmount, '46.25');
    assert.equal((await call(`/api/v1/fiscal-artifacts/${issued.documentId}/ticket`, admin)).status, 200);
    proof.documents.push({ id: issued.documentId, type, validationId: result.id });
    await mkdir('tmp/local-xml', { recursive: true }); await writeFile(`tmp/local-xml/${type}-PRUEBA.zip`, zip);
    console.log(`OK ${type}: firma verificada, ZIP íntegro, replay sin otro correlativo; documento QA ${issued.documentId}`);
  }
  const firstPath = `/api/v1/local-xml-validation/${proof.documents[0].id}`;
  await json(await call(configPath, admin, { expectedRevision: 1, sol: { username: 'QAONLY', password: fakeSecret } }), 201);
  assert.equal((await json(await call(firstPath, admin))).ready, false);
  assert.equal((await call(`${firstPath}/zip`, admin)).status, 409);
  const renewed = await json(await call(firstPath, admin, {}, 'POST'), 201);
  assert.notEqual(renewed.id, proof.documents[0].validationId); assert.equal(renewed.credentialRevision, 2);
  await json(await call(`/api/v1/users/${cashier.id}/access`, admin, { active: false }, 'PATCH'));
  assert.equal((await call(firstPath, cashierToken, {}, 'POST')).status, 401);
  assert.deepEqual(await json(await call(`/api/v1/setup/sunat/${real.id}/BETA`, admin)), realBefore);
  await writeFile('tmp/local-xml/proof.json', JSON.stringify(proof, null, 2));
  console.log('OK aislamiento por RUC/revisión, 401/403/revocación, sin alterar credenciales reales ni estado fiscal. Cero transmisión SUNAT.');
} finally {
  certificate.fill(0);
  if (cashier) await json(await call(`/api/v1/users/${cashier.id}/access`, admin, { active: false }, 'PATCH'));
}
