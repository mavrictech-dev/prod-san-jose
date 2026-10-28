// Auditoría de sólo lectura: XML firmados existentes en el QA aislado, nunca SUNAT.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../services/sunat-service/package.json', import.meta.url));
const { unzipSync } = require('fflate');
if (!process.argv.includes('--isolated-only')) throw new Error('Use --isolated-only');
const base = 'http://127.0.0.1:8091';
const proof = JSON.parse(await readFile(new URL('../tmp/circuit-qa/proof.json', import.meta.url), 'utf8'));
assert.match(proof.ruc, /^00\d{9}$/);
const password = (await readFile(new URL('../.factuez-demo/secrets/initial_admin_password.txt', import.meta.url), 'utf8')).trim();
async function call(path, token, body) {
  return fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
}
const login = await call('/api/v1/auth/login', undefined, { username: 'demo.admin', password });
assert.equal(login.status, 200); const { accessToken } = await login.json();
const catalog = await call('/api/v1/documents/catalog/issuance', accessToken);
assert.equal(catalog.status, 200); const capabilities = (await catalog.json()).capabilities;
assert.equal(capabilities.demoData, true); assert.equal(capabilities.fiscalTransmission, false);
const entries = []; const directory = new URL('../tmp/circuit-qa/schema/', import.meta.url);
await mkdir(directory, { recursive: true });
for (const type of ['INVOICE', 'SALES_RECEIPT']) {
  const document = proof.documents.find(d => d.type === type && d.scenario === 'ACCEPTED');
  assert.ok(document);
  for (const format of type === 'INVOICE' ? ['xml'] : ['xml', 'request']) {
    const response = await call(`/api/v1/fiscal-circuit-qa/${document.id}/${format}`, accessToken);
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer()); assert.ok(bytes.length <= 4 * 1024 * 1024);
    let xml = bytes; let kind = 'Invoice';
    if (format === 'request') {
      const files = unzipSync(bytes); const names = Object.keys(files);
      assert.equal(names.length, 1); assert.match(names[0], /^00\d{9}-RC-\d{8}-\d+\.xml$/);
      xml = Buffer.from(files[names[0]]); kind = 'SummaryDocuments';
    }
    const file = `${type}-${format}.xml`;
    await writeFile(new URL(file, directory), xml);
    entries.push({ file, kind, documentId: document.id, sha256: createHash('sha256').update(xml).digest('hex') });
  }
}
await writeFile(new URL('manifest.json', directory), JSON.stringify({ ruc: proof.ruc, entries, fiscalTransmission: false }, null, 2));
console.log('Auditoría de sólo lectura: tres XML firmados descargados por Kong; sin nuevos documentos ni envíos.');
