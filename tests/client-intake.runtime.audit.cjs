/* Auditoría GET de QA: sin tokens, credenciales, archivos fiscales o escrituras. */
'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
if (process.argv.length !== 3 || process.argv[2] !== '--read-only-qa') {
  console.error('Uso: node tests/client-intake.runtime.audit.cjs --read-only-qa');
  process.exit(2);
}
const base = 'http://127.0.0.1:8091';
let checks = 0;
async function get(path, headers = {}) {
  assert(path.startsWith('/') && !path.startsWith('//'));
  const response = await fetch(base + path, { headers, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000) });
  checks++;
  return response;
}
(async () => {
  const login = await get('/login'); assert.equal(login.status, 200);
  const html = await login.text();
  assert(html.includes('<title>FactuEz | Grifo San José</title>'));
  const links = [...html.matchAll(/<link\b[^>]*rel="(?:icon|shortcut icon)"[^>]*>/g)].map((match) => match[0]);
  assert(links.some((link) => link.includes('/brand/factuez-modo-claro.webp?v=tab-20261005')));
  assert(links.some((link) => link.includes('/brand/factuez-modo-oscuro.webp?v=tab-20261005') && link.includes('prefers-color-scheme: dark')));
  assert(links.every((link) => !link.includes('completo')));
  for (const name of ['factuez-modo-claro.webp', 'factuez-modo-oscuro.webp']) {
    const response = await get('/brand/' + name + '?v=tab-20261005');
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /^image\/webp/);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString(), 'RIFF'); assert.equal(bytes.subarray(8, 12).toString(), 'WEBP');
    const expected = readFileSync(join(__dirname, '../apps/web-pwa/public/brand', name));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), createHash('sha256').update(expected).digest('hex'));
  }
  const manifest = await get('/manifest.webmanifest'); assert.equal(manifest.status, 200);
  const pwa = await manifest.json(); assert(pwa.icons.some((icon) => icon.src === '/brand/factuez-modo-claro.webp' && icon.sizes === '512x512'));
  for (const headers of [{}, { Authorization: 'Bearer invalid-local-audit-token' }]) {
    const response = await get('/api/v1/stations/client-intake', headers); assert.equal(response.status, 401);
    const body = await response.text();
    assert(!/20175642341|20600979630|20614605864|companies|branches/.test(body));
  }
  console.log(JSON.stringify({ audit: 'client-intake-read-only-qa', target: base, httpChecks: checks, result: 'PASS', titlePreserved: true, isotipoAssetsExact: true, unauthenticatedAccessDenied: true, officialSunatRequests: 0, credentialsRead: 0, writes: 0 }));
})().catch(() => { console.error('Falló auditoría HTTP GET de QA; no se mostraron respuestas privadas ni se modificaron datos.'); process.exitCode = 1; });
