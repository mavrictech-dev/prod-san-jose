// Auditoría sin autenticación ni datos reales. No escribe configuración/ventas.
const assert = require('node:assert/strict');
if (process.argv.slice(2).join(' ') !== '--read-only-qa') throw new Error('Indique --read-only-qa');
const origin = 'http://127.0.0.1:8091';
const checks = [
  ['GET', '/print-settings', undefined, 200, 'text/html'],
  ['GET', '/api/v1/stations/print-settings/1', undefined, 401, 'application/json'],
  ['GET', '/api/v1/stations/print-settings/1/snapshot', undefined, 401, 'application/json'],
  ['POST', '/api/v1/stations/print-settings/1/preview', { documentTypeCode: '01', format: 'a4' }, 401, 'application/json'],
  ['POST', '/api/v1/stations/print-settings/1', { expectedRevision: 0, settings: null }, 401, 'application/json'],
];
(async () => {
  for (const [method, path, body, expected, type] of checks) {
    const response = await fetch(origin + path, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Accept: type, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, expected, `${method} ${path}`);
    assert.ok(response.headers.get('content-type')?.includes(type));
    if (expected === 401) {
      const value = await response.json();
      assert.equal(value.statusCode, 401);
      assert.equal(value.ruc, undefined); assert.equal(value.effective, undefined);
    } else await response.arrayBuffer();
    console.log(JSON.stringify({ method, path, status: response.status, guarded: expected === 401, noAuthorizedWrite: true }));
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
