// Headless coding smoke test with a NEW temporary Chrome profile, never a user's session.
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
if (process.argv.slice(2).join(' ') !== '--read-only-qa') throw new Error('Indique --read-only-qa');
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(chrome)) throw new Error('No hay Chrome de prueba en la ruta verificada');
const root = mkdtempSync(join(tmpdir(), 'factuez-swagger-browser-'));
const screenshot = join(root, 'swagger.png');
const result = spawnSync(chrome, [
  '--headless', '--disable-gpu', '--disable-background-networking', '--disable-component-update',
  '--disable-sync', '--disable-default-apps', '--no-first-run', '--no-default-browser-check', '--metrics-recording-only',
  `--user-data-dir=${join(root, 'profile')}`, '--window-size=1440,1200', '--virtual-time-budget=12000',
  '--dump-dom', `--screenshot=${screenshot}`, 'http://127.0.0.1:8091/api-docs',
], { encoding: 'utf8', windowsHide: true, timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
assert.ifError(result.error);
assert.equal(result.status, 0, 'Chrome no completó la prueba aislada');
const dom = result.stdout ?? '';
assert.ok(dom.includes('SwaggerUIBundle') || dom.includes('swagger-ui'), 'Visor ausente');
assert.ok(dom.includes('FactuEz · Extracción privada ERP'), 'La especificación no se renderizó');
assert.ok(!dom.includes('Failed to load API definition'), 'Swagger no pudo cargar el contrato');
assert.ok(!dom.includes('OpenAPI.jsonSchemaDialect field contains a value different'), 'El dialecto documental no es compatible con el visor');
const operationCount = (dom.match(/class="opblock opblock-(get|post)(?:\s|")/g) ?? []).length;
assert.equal(operationCount, 17, 'Deben renderizarse los 17 endpoints privados');
assert.ok(!/class="[^"]*execute opblock-control__btn/.test(dom), 'No debe existir botón de ejecución');
assert.ok(existsSync(screenshot) && statSync(screenshot).size > 1000);
console.log(JSON.stringify({ status: 'PASS', readOnly: true, isolatedBrowserProfile: true, operationCount, screenshot }));
