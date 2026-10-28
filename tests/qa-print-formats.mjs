// Datos propios ficticios. No consulta BD, runtime, certificados ni SUNAT.
// Por defecto los PDFs quedan en memoria. Main puede pedir --write-samples.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function pngLogo(width = 32, height = 12) {
  const { PNG } = require('pngjs');
  const data = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = 195; data[offset + 1] = 30; data[offset + 2] = 45; data[offset + 3] = 255;
  }
  const bytes = PNG.sync.write({ width, height, data });
  return { mediaType: 'image/png', base64: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex'), width, height };
}

export function presentation(logoMode = 'DEFAULT') {
  return { version: 'factuez.print-presentation.v1', issuerRuc: '00000000000', branchId: 'QA-BRANCH', profileRevision: 1,
    settings: { template: 'SAN_JOSE_V1', logoMode, logoWidthMm: 40, logoAlignment: 'LEFT', showBranchAddress: true,
      footerNote: 'Nota comercial ficticia para revisión de la plantilla.' },
    logo: logoMode === 'CUSTOM' ? pngLogo() : null, branchName: 'SEDE FICTICIA QA', branchAddress: 'Dirección de sede ficticia QA' };
}

export function documentSample(documentTypeCode = '01', options = {}) {
  const series = documentTypeCode === '03' ? 'BQ00' : 'FQ00';
  const snapshot = { documentId: '50000000-0000-4000-8000-000000000001', companyId: 1, branchId: 'QA-BRANCH',
    environment: 'BETA', documentTypeCode, series, number: '1', fullNumber: `${series}-1`,
    issueDate: '2026-10-01T15:30:00.000Z', currencyCode: 'PEN', operationTypeCode: '0101',
    issuer: { identityType: '6', identityNumber: '00000000000', legalName: 'EMISOR FICTICIO QA',
      tradeName: 'ESTACIÓN DE PRUEBA LOCAL', address: 'Dirección fiscal ficticia QA', ubigeo: '200101', establishmentCode: 'QA' },
    customer: { identityType: '6', identityNumber: '00000000001', legalName: 'CLIENTE FICTICIO QA', address: 'Dirección del cliente ficticio QA' },
    paymentTerms: { type: 'CONTADO' }, printPresentation: presentation(options.logoMode ?? 'DEFAULT'),
    printOperation: { emissionPointName: 'PUNTO QA', vehiclePlate: 'QA0-001', attendedBy: 'PERSONAL FICTICIO QA',
      shiftLabel: 'Turno QA', observations: 'Datos ficticios. No acredita venta ni envío.', purchaseOrder: 'OC-QA-1' },
    lines: [{ lineNumber: 1, productCode: 'QA-001', description: 'Diésel B5 · producto ficticio para revisión de impresión',
      unitCode: 'GLL', quantity: '2.500000', unitValue: '15.677966', unitPriceWithTax: '18.50', taxAffectationCode: '10',
      igvRate: '18', lineExtensionAmount: '39.19', igvAmount: '7.06', totalAmount: '46.25' }],
    totals: { taxableAmount: '39.19', igvAmount: '7.06', payableAmount: '46.25' } };
  if (['07', '08'].includes(documentTypeCode)) Object.assign(snapshot, {
    reasonCode: documentTypeCode === '07' ? '01' : '02', reasonDescription: 'Motivo ficticio de nota para revisión visual',
    reference: { documentTypeCode: '01', fullNumber: 'FQ00-2', issueDate: '2026-09-30T15:30:00Z' },
  });
  if (options.long) snapshot.lines = Array.from({ length: 100 }, (_, index) => ({ ...snapshot.lines[0], lineNumber: index + 1,
    productCode: `QA-${index + 1}`, description: `Ítem ficticio ${index + 1}: descripción extensa para comprobar paginación, columnas y continuidad en A4. ` +
      'Texto de revisión local con números y tildes. '.repeat(4) }));
  // Totales predefinidos de la fixture; el renderer nunca los calcula desde líneas.
  if (options.long) snapshot.totals = { taxableAmount: '3919.00', igvAmount: '706.00', payableAmount: '4625.00' };
  if (options.credit) snapshot.paymentTerms = { type: 'CREDITO', currencyCode: 'PEN', pendingAmount: '46.25',
    installments: Array.from({ length: 80 }, (_, index) => ({ amount: index === 79 ? '6.75' : '0.50', dueDate: '2026-11-01', currencyCode: 'PEN' })) };
  return snapshot;
}

export function guideSample(documentTypeCode = '09', options = {}) {
  return { documentTypeCode, fullNumber: `${documentTypeCode === '09' ? 'TQ00' : 'VQ00'}-1`, issueDate: '2026-10-01T15:30:00Z',
    transferDate: '2026-10-02', branchId: 'QA-BRANCH', printPresentation: presentation(options.logoMode ?? 'DEFAULT'),
    issuer: { identityNumber: '00000000000', legalName: 'EMISOR DE GUÍA FICTICIO QA', address: 'Dirección ficticia QA' },
    sender: { identityNumber: '00000000001', legalName: 'REMITENTE FICTICIO QA' },
    recipient: { identityNumber: '00000000002', legalName: 'DESTINATARIO FICTICIO QA' },
    origin: { address: 'ORIGEN FICTICIO QA', ubigeo: '200101', establishmentCode: 'QA-ORIGEN' },
    destination: { address: 'DESTINO FICTICIO QA', ubigeo: '200102', establishmentCode: 'QA-DESTINO' },
    transferReason: { code: '04', description: 'Traslado ficticio entre establecimientos' }, transportModeCode: '01',
    grossWeight: '25.500000', weightUnit: 'KGM', packageCount: '2',
    carrier: { identityNumber: '00000000003', legalName: 'TRANSPORTISTA FICTICIO QA', mtcRegistration: 'MTC-QA' },
    vehicles: [{ plate: 'QA0-001', circulationCard: 'TARJETA-QA' }],
    drivers: [{ identityNumber: '00000001', legalName: 'CONDUCTOR FICTICIO QA', license: 'LICENCIA-QA' }],
    relatedDocuments: [{ documentTypeCode: '01', fullNumber: 'FQ00-1', issuerRuc: '00000000000' }],
    observations: 'Plantilla ficticia sin emisión. NO AUTORIZA TRASLADO.',
    items: Array.from({ length: options.long ? 100 : 3 }, (_, index) => ({ code: `QA-${index + 1}`,
      description: `Bien ficticio ${index + 1} para revisar la plantilla de guía`, quantity: '2.500000', unitCode: 'NIU' })) };
}

function sourceRenderer() {
  // Compilación en memoria: no rebuild, dist, instalación ni cambios de contratos.
  const ts = require('typescript');
  const previous = require.extensions['.ts'];
  require.extensions['.ts'] = (module, filename) => {
    if (!filename.startsWith(join(root, 'packages', 'pdf-renderer', 'src') + sep))
      throw new Error('El generador sólo carga fuentes del renderer');
    const source = readFileSync(filename, 'utf8');
    module._compile(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, filename);
  };
  try { return require('../packages/pdf-renderer/src/index.ts'); }
  finally { if (previous) require.extensions['.ts'] = previous; else delete require.extensions['.ts']; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--local-only')) throw new Error('Indique --local-only; exclusivamente datos ficticios');
  const allowed = new Set(['--local-only', '--write-samples', '--built']);
  const runLabel = process.argv.slice(2).find(arg => /^--run-label=[a-z0-9-]{1,32}$/.test(arg))?.slice('--run-label='.length);
  if (process.argv.slice(2).some(arg => !allowed.has(arg) && arg !== `--run-label=${runLabel}`)) throw new Error('Argumento del generador no admitido');
  const renderer = process.argv.includes('--built') ? require('../packages/pdf-renderer/dist/index.js') : sourceRenderer();
  const samples = [];
  for (const code of ['01', '03', '07', '08']) for (const format of ['a4', 'ticket'])
    samples.push([`${code}-${format}-PRUEBA`, () => renderer.renderLocalDocumentPdf(documentSample(code), format)]);
  for (const code of ['09', '31']) for (const format of ['a4', 'ticket'])
    samples.push([`${code}-${format}-NO-AUTORIZA-TRASLADO`, () => renderer.renderLocalTransportGuidePdf(guideSample(code), format)]);
  const receiptCredit = documentSample('07');
  receiptCredit.series = 'BQ00'; receiptCredit.fullNumber = 'BQ00-1';
  receiptCredit.reference.documentTypeCode = '03'; receiptCredit.reference.fullNumber = 'BQ00-2';
  samples.push(['07-boleta-a4-PRUEBA', () => renderer.renderLocalDocumentPdf(receiptCredit, 'a4')]);
  samples.push(['01-a4-100-items-PRUEBA', () => renderer.renderLocalDocumentPdf(documentSample('01', { long: true }), 'a4')],
    ['01-a4-80-cuotas-PRUEBA', () => renderer.renderLocalDocumentPdf(documentSample('01', { credit: true }), 'a4')],
    ['31-a4-100-items-NO-AUTORIZA-TRASLADO', () => renderer.renderLocalTransportGuidePdf(guideSample('31', { long: true }), 'a4')],
    ['01-a4-custom-PRUEBA', () => renderer.renderLocalDocumentPdf(documentSample('01', { logoMode: 'CUSTOM' }), 'a4')],
    ['01-a4-sin-logo-PRUEBA', () => renderer.renderLocalDocumentPdf(documentSample('01', { logoMode: 'NONE' }), 'a4')]);
  const output = resolve(root, `tmp/qa-print-formats${runLabel ? `-${runLabel}` : ''}`);
  if (process.argv.includes('--write-samples')) await mkdir(output, { recursive: true });
  for (const [name, render] of samples) {
    const bytes = await render();
    const pages = (bytes.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
    if (process.argv.includes('--write-samples')) await writeFile(join(output, `${name}.pdf`), bytes, { flag: 'wx' });
    console.log(JSON.stringify({ sample: name, bytes: bytes.length, pages, localOnly: true,
      written: process.argv.includes('--write-samples') }));
  }
}
