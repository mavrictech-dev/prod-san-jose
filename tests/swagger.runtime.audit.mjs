// Opt-in, read-only check of the existing QA: no login, secrets, database or fiscal requests.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
if (process.argv.slice(2).join(' ') !== '--read-only-qa') throw new Error('Indique --read-only-qa');
const docker = args => execFileSync('docker', ['--context', 'desktop-linux', ...args], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 16384 }).trim();
assert.equal(docker(['context', 'inspect', 'desktop-linux', '--format', '{{(index .Endpoints "docker").Host}}']), 'npipe:////./pipe/dockerDesktopLinuxEngine');
const project = 'factuez-stage2-qa';
for (const service of ['web-pwa', 'kong', 'identity-service', 'billing-service', 'sunat-service']) {
  const container = `${project}-${service}-1`;
  assert.equal(docker(['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', container]), project);
  assert.equal(docker(['inspect', '--format', '{{.State.Health.Status}}', container]), 'healthy');
}
const base = 'http://127.0.0.1:8091';
async function get(path, type) {
  const response = await fetch(base + path, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200, path);
  assert.ok(response.headers.get('Content-Type')?.includes(type), path);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.ok(response.headers.get('Content-Security-Policy')?.includes("connect-src 'self'"));
  return response;
}
const html = await (await get('/api-docs', 'text/html')).text();
assert.ok(html.includes('Visor de sólo lectura'));
assert.ok(html.includes('SOURCE_NOT_SUPPORTED'));
const api = await (await get('/api-docs/openapi.json', 'application/json')).json();
const intranet = await (await get('/api-docs/sunat.json', 'application/json')).json();
assert.equal(api['x-delivery-state'], 'IMPLEMENTED_OPT_IN_ACTIVATION_PENDING');
assert.equal(Object.keys(api.paths).length, 17);
assert.equal(api.servers[0].url, 'https://factuez.invalid');
assert.equal(intranet.components.schemas.ConfigurationStatus.properties.fiscalTransmission.const, false);
const assets = [];
for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const path = match[1];
  if (!path.startsWith('/api-docs/assets/')) continue;
  const response = await get(path, path.endsWith('.css') ? 'text/css' : 'javascript');
  assert.ok((await response.arrayBuffer()).byteLength > 100);
  assets.push(path);
}
const init = await (await get('/api-docs/assets/init.js', 'javascript')).text();
assert.ok(init.includes('supportedSubmitMethods: []'));
assert.ok(init.includes('persistAuthorization: false'));
assert.ok(init.includes('validatorUrl: null'));
assert.ok(init.includes('queryConfigEnabled: false'));
const unknown = await fetch(base + '/api-docs/assets/not-an-asset.p12');
assert.equal(unknown.status, 404);
const protectedStatus = await fetch(base + '/api/v1/setup/sunat/1/BETA');
assert.equal(protectedStatus.status, 401);
// Only check route availability anonymously. Never activate opt-in integration from docs.
const extraction = await fetch(base + '/integration/v1/capabilities', { redirect: 'manual' });
assert.equal(extraction.status, 404);
console.log(JSON.stringify({ status: 'PASS', readOnly: true, project, extractionOperations: 17,
  intranetOperations: Object.values(intranet.paths).reduce((count, methods) => count + Object.keys(methods).length, 0),
  localAssets: assets.length, protectedFiscalStatus: protectedStatus.status, extractionNotActivated: extraction.status === 404 }));
