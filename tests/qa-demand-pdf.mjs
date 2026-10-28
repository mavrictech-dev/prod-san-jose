// Ensayo aislado: sólo fixtures ficticias, red sustituida en este proceso.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { documentSample, guideSample, pngLogo } from './qa-print-formats.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(new URL('../services/sunat-service/package.json', import.meta.url));
require('reflect-metadata');
const { CurrentPdfService } = require(join(root, 'services/sunat-service/dist/application/current-pdf.service.js'));
const { renderLocalTransportGuidePdf } = require('@factuez/pdf-renderer');
if (process.argv.slice(2).join(' ') !== '--synthetic-only --write-samples')
  throw new Error('Indique --synthetic-only --write-samples; no usa el runtime de FactuEz.');
const branchId = '20000000-0000-4000-8000-000000000001';
const owner = { companyId: 1, branchId };
const snapshot = type => { const s = documentSample(type); s.branchId = branchId; s.printPresentation.branchId = branchId; return s; };
let profile = structuredClone(snapshot('03').printPresentation);
profile.profileRevision = 5;
profile.settings.footerNote = 'REVISIÓN VISUAL 5 · NO FISCAL';
profile.branchName = 'NOMBRE ACTUAL: NO DEBE SUSTITUIR EL HISTÓRICO';
const beforeFetch = globalThis.fetch;
const beforeEnabled = process.env.PRINT_SETTINGS_ENABLED;
const beforeBase = process.env.BILLING_INTERNAL_URL;
process.env.PRINT_SETTINGS_ENABLED = 'true';
process.env.BILLING_INTERNAL_URL = 'http://billing-fixture.invalid';
let consultations = 0;
globalThis.fetch = async (url, options) => {
  if (String(url) !== `http://billing-fixture.invalid/api/v1/stations/print-settings/1/snapshot?branchId=${branchId}` ||
      options?.headers?.Authorization !== 'Bearer QA.FICTICIO' || options.redirect !== 'error') throw new Error('Intento fuera del ensayo ficticio');
  consultations++;
  return new Response(JSON.stringify(profile), { headers: { 'content-type': 'application/json' } });
};
const service = new CurrentPdfService();
const output = join(root, 'tmp', 'qa-demand-pdf-20261005');
await mkdir(output, { recursive: true });
let written = 0;
async function sample(name, bytes) {
  if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('No es PDF');
  await writeFile(join(output, `${name}.pdf`), bytes, { flag: 'wx' }); written++;
  console.log(JSON.stringify({ sample: name, bytes: bytes.length, localOnly: true }));
}
try {
  for (const type of ['01', '03', '07', '08']) for (const format of ['a4', 'ticket'])
    await sample(`${type}-${format}-formato-vigente`, await service.document(snapshot(type), format, 'Bearer QA.FICTICIO'));
  const guide = guideSample('09');
  const gre = { id: '00000000-0000-4000-8000-000000000001', ublNumber: guide.fullNumber, issueDate: guide.issueDate,
    issuer: { ruc: guide.issuer.identityNumber, legalName: guide.issuer.legalName }, transferDate: guide.transferDate,
    origin: guide.origin, destination: guide.destination, grossWeight: guide.grossWeight, weightUnit: guide.weightUnit,
    transport: { mode: '02', plate: 'QA0001', driverDni: '00000001', driverFirstName: 'CONDUCTOR', driverLastName: 'FICTICIO', driverLicense: 'QA00001' },
    items: guide.items, branchId, printPresentation: { ...guide.printPresentation, branchId } };
  for (const format of ['a4', 'ticket']) await sample(`09-${format}-formato-vigente`, await service.gre(gre, owner, format, 'Bearer QA.FICTICIO'));
  const transport = guideSample('31');
  for (const format of ['a4', 'ticket']) await sample(`31-${format}-solo-preview`, await renderLocalTransportGuidePdf(transport, format));
  const old = snapshot('03'), original = JSON.stringify(old);
  const first = await service.document(old, 'a4', 'Bearer QA.FICTICIO');
  await sample('boleta-historica-revision-5', first);
  profile = { ...profile, profileRevision: 6, settings: { ...profile.settings, logoMode: 'CUSTOM', footerNote: 'REVISIÓN VISUAL 6 · MISMA BOLETA FICTICIA' }, logo: pngLogo() };
  await sample('boleta-historica-revision-6', await service.document(old, 'a4', 'Bearer QA.FICTICIO'));
  if (JSON.stringify(old) !== original) throw new Error('El snapshot fue alterado');
  if (written !== 14 || consultations !== 12) throw new Error('Inventario de muestras incompleto');
  console.log(JSON.stringify({ result: 'PASS', samples: written, currentProfileReadEveryTime: true, frozenSnapshotUnchanged: true, externalNetwork: false }));
} finally {
  service.onModuleDestroy(); globalThis.fetch = beforeFetch;
  if (beforeEnabled === undefined) delete process.env.PRINT_SETTINGS_ENABLED; else process.env.PRINT_SETTINGS_ENABLED = beforeEnabled;
  if (beforeBase === undefined) delete process.env.BILLING_INTERNAL_URL; else process.env.BILLING_INTERNAL_URL = beforeBase;
}
