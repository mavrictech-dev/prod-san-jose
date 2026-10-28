// Sólo lectura del QA existente. No lee certificados, secretos ni datos comerciales.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
if (process.argv.slice(2).join(' ') !== '--read-only-qa') throw new Error('Indique --read-only-qa');
const project = 'factuez-stage2-qa';
const docker = args => execFileSync('docker', ['--context', 'desktop-linux', ...args], { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 65536 }).trim();
assert.equal(docker(['context', 'inspect', 'desktop-linux', '--format', '{{(index .Endpoints "docker").Host}}']), 'npipe:////./pipe/dockerDesktopLinuxEngine');
const checks = {};
for (const service of ['identity-service', 'billing-service', 'sunat-service', 'mailer-worker', 'web-pwa']) {
  const container = `${project}-${service}-1`;
  assert.equal(docker(['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', container]), project);
  assert.equal(docker(['inspect', '--format', '{{.State.Health.Status}}', container]), 'healthy');
}
const probes = {
  'identity-service': { roleEditing: ['users.controller.js', 'roles/:code'], extraPermissions: ['users.controller.js', 'users/:id/permissions'], roleAudit: ['application/user-administration.service.js', 'role.permissions.updated'], preserveEditedRoles: ['application/rbac-bootstrap.service.js', 'code === contracts_1.RoleCodes.ADMIN'] },
  'billing-service': { productRoutes: ['products.controller.js', 'api/v1/stations/products'], productAudit: ['application/product-admin.service.js', 'product.deactivated'], historicalProtection: ['application/product-admin.service.js', 'historicalDocumentsChanged: false'] },
  'sunat-service': { certificateRemoval: ['application/fiscal-configuration.service.js', 'certificatePasswordCipher: null'], fiscalAudit: ['fiscal-configuration.controller.js', ':companyId/:environment/audit'] },
  'mailer-worker': { smtpRemoval: ['smtp-configuration.module.js', ':companyId/remove'], smtpAudit: ['smtp-configuration.module.js', ':companyId/audit'] },
};
for (const [service, definitions] of Object.entries(probes)) {
  const code = `const fs=require('node:fs'); const d=${JSON.stringify(definitions)}; const out={}; for(const [key,[file,needle]] of Object.entries(d))out[key]=fs.readFileSync('/workspace/services/${service}/dist/'+file,'utf8').includes(needle); console.log(JSON.stringify(out));`;
  const result = JSON.parse(docker(['exec', `${project}-${service}-1`, 'node', '-e', code]));
  for (const [key, value] of Object.entries(result)) { assert.equal(value, true, key); checks[key] = value; }
}
const fiscalFlags = JSON.parse(docker(['exec', `${project}-sunat-service-1`, 'node', '-e', `console.log(JSON.stringify({ betaClosed:process.env.SUNAT_BETA_TRANSMISSION_ENABLED==='false', workflowClosed:process.env.SUNAT_BETA_WORKFLOW_ENABLED==='false' }));`]));
assert.ok(fiscalFlags.betaClosed && fiscalFlags.workflowClosed);
const base = 'http://127.0.0.1:8091';
const anonymous = {};
for (const route of ['/api/v1/roles', '/api/v1/stations/products', '/api/v1/setup/sunat/1/BETA/audit', '/api/v1/mail-settings/1/audit']) {
  const response = await fetch(base + route, { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 401, route); anonymous[route] = response.status;
}
for (const [route, wanted, excluded] of [
  ['/stations', ['/api/v1/stations/products', 'Nuevo producto'], ['Entrega del cliente']],
  ['/sunat-settings', ['/audit?page=', 'Confirmar retiro', 'Historial de configuraci'], []],
  ['/roles', ['Editar permisos', 'expectedPermissions'], ['etapas posteriores']],
  ['/users', ['Permisos extra', 'Paginaci'], []],
]) {
  const response = await fetch(base + route, { signal: AbortSignal.timeout(15000) }); assert.equal(response.status, 200);
  const html = await response.text();
  const chunks = [...new Set([...html.matchAll(/(?:src|href)="([^"<>]+\.js(?:\?[^"<>]*)?)"/g)].map(match => match[1]))].filter(path => path.startsWith('/_next/static/'));
  const sources = await Promise.all(chunks.map(async path => { const response = await fetch(base + path, { signal: AbortSignal.timeout(15000) }); assert.equal(response.status, 200); return response.text(); }));
  const combined = sources.join('\n');
  for (const label of wanted) assert.ok(combined.includes(label), `${route}: ${label}`);
  for (const label of excluded) assert.ok(!combined.includes(label), `${route}: texto retirado`);
}
console.log(JSON.stringify({ status: 'PASS', readOnly: true, project, checks, fiscalFlags, anonymous, pages: 4 }));
