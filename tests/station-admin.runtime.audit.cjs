// Auditoría QA de sólo lectura: código/flags, esquema y GET públicos. Sin claves ni datos de emisores.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
if (process.argv.slice(2).join(' ') !== '--read-only-qa') throw new Error('Indique --read-only-qa');
function docker(args) { return execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 65536 }).trim(); }
const project = 'factuez-stage2-qa';
for (const name of ['billing-service', 'web-pwa', 'postgres']) {
  const container = `${project}-${name}-1`;
  assert.equal(docker(['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', container]), project);
}
const probe = `
  const fs = require('node:fs');
  const service = fs.readFileSync('/workspace/services/billing-service/dist/application/station-admin.service.js', 'utf8');
  const controller = fs.readFileSync('/workspace/services/billing-service/dist/stations.controller.js', 'utf8');
  process.stdout.write(JSON.stringify({
    enabled: process.env.STATION_MASTER_CRUD_ENABLED === 'true',
    seedClosed: process.env.FACTUEZ_DEMO_SEED === 'false',
    administratorGuard: service.includes("includes('ADMIN')") && service.includes("'GLOBAL'"),
    betaGuard: service.includes("environment !== 'BETA'"),
    revisionGuard: service.includes('expectedRevision') && service.includes('masterRevision'),
    historicalSeriesGuard: service.includes('current.nextNumber !== 1n'),
    noCounterEdits: service.includes('counterEditing: false'),
    noHardDelete: !/\\.delete(?:Many)?\\(/.test(service),
    catalogRoute: controller.includes('admin/catalog')
  }));
`;
const runtime = JSON.parse(docker(['exec', `${project}-billing-service-1`, 'node', '-e', probe]));
for (const [key, value] of Object.entries(runtime)) assert.equal(value, true, key);
const columns = docker(['exec', `${project}-postgres-1`, 'psql', '-U', 'factuez_demo_admin', '-d', 'factuez_billing', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-c',
  `SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND ((table_name='CompanySettings' AND column_name='active' AND data_type='boolean') OR (table_name IN ('Branch','EmissionPoint','SeriesCounter') AND column_name='masterRevision' AND data_type='integer')) AND is_nullable='NO';`]);
assert.equal(columns, '4');
(async () => {
  const base = 'http://127.0.0.1:8091';
  const page = await fetch(`${base}/stations`, { signal: AbortSignal.timeout(10000) });
  assert.equal(page.status, 200);
  const html = await page.text();
  const scripts = [...new Set([...html.matchAll(/(?:src|href)="([^"<>]+\.js(?:\?[^"<>]*)?)"/g)].map(match => match[1]))];
  const stationScript = scripts.find(url => url.includes('/stations/page-'));
  assert.ok(stationScript, 'STATIONS_PUBLIC_CHUNK_MISSING');
  assert.ok(stationScript.startsWith('/_next/static/'), 'PUBLIC_CHUNK_SCOPE');
  const chunk = await fetch(base + stationScript, { signal: AbortSignal.timeout(10000) }); assert.equal(chunk.status, 200);
  const source = await chunk.text();
  // El minificador puede representar la ó con escape hexadecimal/unicode.
  for (const label of ['Sedes, puntos y series', 'Confirmar desactivaci', 'Confirmar reactivaci', 'Siguiente correlativo']) assert.ok(source.includes(label), label);
  const anonymous = await fetch(`${base}/api/v1/stations/admin/catalog`, { signal: AbortSignal.timeout(10000) }); assert.equal(anonymous.status, 401);
  console.log(JSON.stringify({ status: 'PASS', readOnly: true, project, checks: runtime, schemaColumns: 4, page: 200, anonymousCatalog: 401, frontendCrud: true }));
})().catch(error => { console.error(JSON.stringify({ status: 'FAIL', reason: error.message })); process.exitCode = 1; });
