import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');
const QRCode = createRequire(new URL('../packages/pdf-renderer/package.json', import.meta.url))('qrcode');
const childProcess = require('node:child_process');
const evidence = require('../migration/evidence-pdf.cjs');
const { decodeQrPng, bindSyntheticQr, bindSyntheticPdfText, inspectSyntheticPdf, compareSyntheticPdf, PDF_RUNTIME, PDF_LIMITS } = evidence;
const fixtures = require('./helpers/history-full-fixtures.cjs');
const { validateHistoricalSnapshot } = require('../packages/history-core/dist/index.js');
const digest = createHash('sha256').update('FICTIONAL-SYNTHETIC-ONLY').digest('base64');
const options = { environment: 'BETA', datasetClass: 'SYNTHETIC', format: 'a4', ...PDF_RUNTIME };
// These are intentionally incomplete rejection inputs, NEVER authored/valid PDF artifacts.
const broken = Buffer.from('%PDF-1.7\nintentionally incomplete synthetic rejection input\n%%EOF');
const payloadFor = (s = validateHistoricalSnapshot(fixtures.document())) => [s.issuer.ruc,
  s.ownership.documentTypeCode, s.ownership.series, s.number, s.amounts.igvAmount,
  s.amounts.payableAmount, '2026-10-01', s.customer.identityType, s.customer.identityNumber, digest].join('|') + '|';

function whitePng(width = 400, height = 400) {
  const image = new PNG({ width, height }); image.data.fill(255);
  return image;
}
function encode(image: any) { return PNG.sync.write(image); }
async function qrPng(payload = payloadFor()) {
  return QRCode.toBuffer(payload, { type: 'png', width: 400, margin: 4, errorCorrectionLevel: 'M' });
}
async function tiledPng(payloads: string[], fullPage = false) {
  const width = fullPage ? 1191 : 420 * payloads.length, height = fullPage ? 1684 : 420;
  const image = whitePng(width, height);
  for (let index = 0; index < payloads.length; index++) {
    const tile = PNG.sync.read(await qrPng(payloads[index]));
    const left = fullPage ? 40 : index * 420 + 10, top = fullPage ? 40 + index * 420 : 10;
    for (let row = 0; row < tile.height; row++) tile.data.copy(image.data,
      ((row + top) * width + left) * 4, row * tile.width * 4, (row + 1) * tile.width * 4);
  }
  return encode(image);
}
function metadata(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: 'factuez.synthetic-pdf-metadata.v1', format: 'a4',
    pageSizesMicrometers: [{ width: 210001, height: 297000 }], textLines: ['DOCUMENTO FICTICIO'], ...overrides };
}
function mockTools(data: unknown, png: Buffer) {
  return vi.spyOn(childProcess, 'spawnSync').mockImplementation((_executable: unknown, args: string[]) => ({
    status: 0, signal: null, stdout: args[0] === '-I' ? Buffer.from(JSON.stringify(data)) : png,
    stderr: Buffer.alloc(0), pid: 1, output: [],
  }));
}
afterEach(() => vi.restoreAllMocks());

describe('evidence PDF: actual PNG pixels, fictional QR binding, no PDF authoring', () => {
  it('decodes an actual PNG QR and hashes decoded pixels rather than PNG compression', async () => {
    const png = await qrPng(), decoded = decodeQrPng(png);
    expect(decoded).toMatchObject({ width: 400, height: 400, qrPayloads: [payloadFor()], qrScanLimitReached: false });
    expect(decoded.rasterSha256).toMatch(/^[a-f0-9]{64}$/);
    const recompressed = PNG.sync.write(PNG.sync.read(png), { deflateLevel: 0 });
    expect(recompressed.equals(png)).toBe(false);
    expect(decodeQrPng(recompressed).rasterSha256).toBe(decoded.rasterSha256);
  });
  it('reports missing QR from real blank pixels', () => {
    expect(decodeQrPng(encode(whitePng()))).toMatchObject({ qrPayloads: [], qrScanLimitReached: false });
  });
  it('finds multiple actual codes and preserves duplicate occurrences after masking', async () => {
    const first = payloadFor(), second = payloadFor(validateHistoricalSnapshot(fixtures.document(2)));
    const decoded = decodeQrPng(await tiledPng([first, second, first]));
    expect([...decoded.qrPayloads].sort()).toEqual([first, second, first].sort());
    expect(decoded.qrScanLimitReached).toBe(false);
  });
  it('marks scan completeness unknown at the bounded four-code limit', async () => {
    const decoded = decodeQrPng(await tiledPng(Array(5).fill(payloadFor())));
    expect(decoded.qrPayloads).toHaveLength(4);
    expect(decoded.qrScanLimitReached).toBe(true);
  });
  it('bounds PNG bytes and dimensions before inflating', async () => {
    expect(() => decodeQrPng(Buffer.alloc(PDF_LIMITS.pngBytes + 1))).toThrow(/PNG_INPUT_LIMIT/);
    const png = Buffer.from(await qrPng()); png.writeUInt32BE(PDF_LIMITS.side + 1, 16);
    expect(() => decodeQrPng(png)).toThrow(/PNG_PIXEL_LIMIT/);
    png.writeUInt32BE(3000, 16); png.writeUInt32BE(3000, 20);
    expect(() => decodeQrPng(png)).toThrow(/PNG_PIXEL_LIMIT/);
  });
  it('rejects corrupt PNGs and unsupported bit depth', async () => {
    expect(() => decodeQrPng(Buffer.alloc(40))).toThrow(/PNG_INVALID/);
    const corrupt = Buffer.from(await qrPng()); corrupt[29] ^= 255;
    expect(() => decodeQrPng(corrupt)).toThrow(/PNG_INVALID/);
    const depth = Buffer.from(await qrPng()); depth[24] = 16;
    expect(() => decodeQrPng(depth)).toThrow(/PNG_PROFILE_BLOCKED/);
    const interlaced = Buffer.from(await qrPng()); interlaced[28] = 1;
    expect(() => decodeQrPng(interlaced)).toThrow(/PNG_PROFILE_BLOCKED/);
    const original = await qrPng(), duplicateHeader = Buffer.concat([original.subarray(0,33), original.subarray(8)]);
    expect(() => decodeQrPng(duplicateHeader)).toThrow(/PNG_INVALID/);
  });

  it.each(['01','03','07','08'])('binds ten exact fields for fictional type %s without acceptance claims', type => {
    const snapshot = validateHistoricalSnapshot(fixtures.document(1, 1, type));
    const result = bindSyntheticQr(payloadFor(snapshot), snapshot, digest);
    expect(result).toMatchObject({ bound: true, differenceCount: 0, noOfficialAuthority: true,
      fiscalAuthority: false, signatureVerified: false, officialAcceptance: false, currencyInQr: false });
    expect(Object.keys(result.fields)).toHaveLength(10);
  });
  it('returns binding differences, even when the two candidate QRs would compare equal', () => {
    const snapshot = fixtures.document(), parts = payloadFor().split('|');
    parts[4] = '19.00'; parts[5] = '119.00'; parts[9] = createHash('sha256').update('OTHER-FICTIONAL').digest('base64');
    const result = bindSyntheticQr(parts.join('|'), snapshot, digest);
    expect(result.bound).toBe(false);
    expect(result.differences.map((d: any) => d.path)).toEqual(['qr.igvAmount','qr.payableAmount','qr.digestValue']);
  });
  it('uses the Lima day, exact decimal normalization, and exposes absent currency binding', () => {
    const snapshot = fixtures.document(); snapshot.issueDate = '2026-10-02T02:00:00Z'; snapshot.currencyCode = 'USD';
    snapshot.amounts.payableAmount = '118';
    const result = bindSyntheticQr(payloadFor(), snapshot, digest);
    expect(result).toMatchObject({ bound: true, currencyCode: 'USD', currencyBindingVerified: false, digestConsistencyOnly: true });
  });
  it.each([
    (p: string) => p.slice(0, -1), (p: string) => p + '|', (p: string) => p + 'USD|',
    (p: string) => p.replace('18.00', '18'), (p: string) => p.replace('18.00', '-18.00'),
    (p: string) => p.replace('2026-10-01', '2026-02-30'),
    (p: string) => p.replace('00000000001', '20615878481'),
    (p: string) => p.replace('|0|0|', '|6|20615878481|'),
    (p: string) => '\n' + p, (p: string) => p.replace('BQ01', 'BQ01\u202e'),
  ])('rejects malformed or non-synthetic QR %#', mutate => {
    expect(() => bindSyntheticQr(mutate(payloadFor()), fixtures.document(), digest)).toThrow();
  });
  it('rejects oversized QR, invalid digest and unvalidated snapshots without executing accessors', () => {
    expect(() => bindSyntheticQr('x'.repeat(2049), fixtures.document(), digest)).toThrow(/QR_INVALID/);
    expect(() => bindSyntheticQr(payloadFor(), fixtures.document(), 'not-base64')).toThrow(/QR_DIGEST_INVALID/);
    const snapshot = fixtures.document(); snapshot.currencyCode = 'EUR';
    expect(() => bindSyntheticQr(payloadFor(), snapshot, digest)).toThrow();
    const getter = vi.fn(); Object.defineProperty(snapshot, 'issuer', { enumerable: true, get: getter });
    expect(() => bindSyntheticQr(payloadFor(), snapshot, digest)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });

  it.each([{ environment: 'PRODUCTION' }, { datasetClass: 'AUTHORIZED_COPY' }, { format: 'letter' },
    { inputPath: 'real-client.pdf' }, { pythonPath: 'python' }, { pythonPath: 'D:\\user\\python.exe' },
    { pdftoppmPath: 'D:\\user\\pdftoppm.exe' }])('rejects profile/paths before subprocess %#', change => {
    const spawn = vi.spyOn(childProcess, 'spawnSync');
    expect(() => inspectSyntheticPdf(broken, { ...options, ...change })).toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });
  it('rejects option proxies/accessors before evaluating them', () => {
    const getter = vi.fn(), proxy = vi.fn();
    const value = { ...options }; Object.defineProperty(value, 'format', { enumerable: true, get: getter });
    expect(() => inspectSyntheticPdf(broken, value)).toThrow(); expect(getter).not.toHaveBeenCalled();
    expect(() => inspectSyntheticPdf(broken, new Proxy(options, { ownKeys: proxy }))).toThrow();
    expect(proxy).not.toHaveBeenCalled();
  });
  it('rejects oversized, non-Buffer and broken-header inputs before invoking Python', () => {
    const spawn = vi.spyOn(childProcess, 'spawnSync');
    for (const value of [Buffer.alloc(PDF_LIMITS.pdfBytes + 1), 'not-a-buffer', Buffer.from('broken')]) {
      expect(() => inspectSyntheticPdf(value, options)).toThrow();
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  // Transport mocks exercise ordering/comparison only. They do not prove valid PDF extraction.
  it('passes detached PDF bytes to the fixed helper and Poppler via stdin, without file arguments', async () => {
    const png = await tiledPng([payloadFor()], true), spawn = mockTools(metadata(), png);
    const result = inspectSyntheticPdf(broken, options);
    expect(result).toMatchObject({ qrStatus: 'SINGLE', noOfficialAuthority: true, qrPayloads: [payloadFor()] });
    expect(result.pdfSha256).toBe(createHash('sha256').update(broken).digest('hex'));
    expect(spawn).toHaveBeenCalledTimes(2);
    const pythonArgs = spawn.mock.calls[0][1] as string[], popplerArgs = spawn.mock.calls[1][1] as string[];
    expect(pythonArgs).toEqual(['-I','-B', expect.stringMatching(/evidence-pdf-inspect\.py$/), '--format','a4']);
    expect(popplerArgs).toEqual(['-f','1','-l','1','-singlefile','-r','144','-png','-']);
    for (const call of spawn.mock.calls) {
      const settings = call[2] as any;
      expect(settings).toMatchObject({ shell: false, windowsHide: true, timeout: 15000 });
      expect(settings.input.equals(broken)).toBe(true); expect(settings.input).not.toBe(broken);
    }
  });
  it.each([
    { pageSizesMicrometers: Array(11).fill({ width: 210000, height: 297000 }) },
    { pageSizesMicrometers: [{ width: 80000, height: 297000 }] },
    { pageSizesMicrometers: [{ width: 210000, height: 2000000 }] },
    { textLines: Array(2001).fill('x') }, { textLines: ['x'.repeat(1001)] },
    { textLines: ['text\u0000'] }, { error: 'PDF_ACTIVE_FEATURE_BLOCKED' },
  ])('rejects helper flags/limits before Poppler %#', overrides => {
    const spawn = mockTools(metadata(overrides), Buffer.alloc(0));
    expect(() => inspectSyntheticPdf(broken, options)).toThrow(); expect(spawn).toHaveBeenCalledTimes(1);
  });
  it('enforces total pixel budget for ticket pages before rasterization', () => {
    const spawn = mockTools(metadata({ format: 'ticket', pageSizesMicrometers: Array(10).fill({ width: 80000, height: 1400000 }) }), Buffer.alloc(0));
    expect(() => inspectSyntheticPdf(broken, { ...options, format: 'ticket' })).toThrow(/PDF_PAGE_LIMIT/);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it('rejects timeout/maxBuffer/subprocess failure and invalid helper JSON without exposing stderr', () => {
    const spawn = vi.spyOn(childProcess, 'spawnSync');
    for (const failure of [{ error: new Error('private-path'), status: null }, { status: 1 }, { status: 0, signal: 'SIGTERM' }]) {
      spawn.mockReturnValue({ ...failure, stdout: Buffer.alloc(0), stderr: Buffer.from('do not disclose') });
      expect(() => inspectSyntheticPdf(broken, options)).toThrow(/PDF_INSPECT_FAILED/);
    }
    spawn.mockReturnValue({ status: 0, signal: null, stdout: Buffer.from('not-json') });
    expect(() => inspectSyntheticPdf(broken, options)).toThrow(/PDF_METADATA_INVALID/);
  });
  it('compares normalized text/page sizes/real raster pixels without requiring equal PDF bytes', async () => {
    const png = await tiledPng([payloadFor()], true);
    const spy = mockTools(metadata(), png);
    let helperCalls = 0;
    spy.mockImplementation((_exe: unknown, args: string[]) => ({ status: 0, signal: null,
      stdout: args[0] === '-I' ? Buffer.from(JSON.stringify(metadata({ textLines: [++helperCalls === 1 ? '  FICTICIO   cafe\u0301 ' : 'FICTICIO café'] }))) : png }));
    const right = Buffer.concat([broken, Buffer.from('\nmetadata transport variation')]);
    const report = compareSyntheticPdf(broken, right, options);
    expect(report.left.pdfSha256).not.toBe(report.right.pdfSha256);
    expect(report).toMatchObject({ comparativeMatch: true, qrEvidenceComplete: true, fiscalAuthority: false, differenceCount: 0 });
  });
  it('compares raster hashes from real PNG pixels and detects helper text differences', async () => {
    const png = await tiledPng([payloadFor()], true), changed = PNG.sync.read(png);
    changed.data[0] = 0;
    const other = encode(changed); let helperCalls = 0, rasterCalls = 0;
    const spy = mockTools(metadata(), png);
    spy.mockImplementation((_exe: unknown, args: string[]) => ({ status: 0, signal: null,
      stdout: args[0] === '-I' ? Buffer.from(JSON.stringify(metadata({ textLines: [++helperCalls === 1 ? '118.00' : '119.00'] }))) : ++rasterCalls === 1 ? png : other }));
    const report = compareSyntheticPdf(broken, broken, options);
    expect(report.comparativeMatch).toBe(false);
    expect(report.differences.map((d: any) => d.path)).toEqual(['textLines','pages.rasterSha256']);
  });
  it('keeps comparative equality distinct from missing and duplicate QR evidence', async () => {
    const blank = encode(whitePng(1191,1684)); mockTools(metadata(), blank);
    expect(compareSyntheticPdf(broken, broken, options)).toMatchObject({ comparativeMatch: true, qrEvidenceComplete: false, status: 'INCOMPLETE' });
    vi.restoreAllMocks(); mockTools(metadata(), await tiledPng([payloadFor(),payloadFor()], true));
    const report = inspectSyntheticPdf(broken, options);
    expect(report.qrStatus).toBe('MULTIPLE'); expect(report.duplicateQrPayloads).toEqual([{ payload: payloadFor(), count: 2 }]);
  });
});

describe.skipIf(!existsSync(PDF_RUNTIME.pythonPath) || !existsSync(PDF_RUNTIME.pdftoppmPath))('real fixed Python helper: rejection inputs only', () => {
  it('rejects malformed PDF bytes before rendering, without authoring any PDF', () => {
    const spawn = vi.spyOn(childProcess, 'spawnSync');
    expect(() => inspectSyntheticPdf(broken, options)).toThrow(/PDF_INVALID/);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it.each(['JavaScript','JS','EmbeddedFiles','EmbeddedFile','OpenAction','AA','Launch','XFA','URI',
    'GoToR','GoToE','SubmitForm','ImportData','Rendition','RichMedia','Filespec','AcroForm','Encrypt','A','F','J#61vaScript'])('blocks /%s before raster', name => {
    const spawn = vi.spyOn(childProcess, 'spawnSync');
    const input = Buffer.from(`%PDF-1.7\n/${name}\nintentionally incomplete rejection input\n%%EOF`);
    expect(() => inspectSyntheticPdf(input, options)).toThrow(/PDF_ACTIVE_FEATURE_BLOCKED/);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it.each(['ObjStm','XRef'])('fails closed on compressed object feature /%s', name => {
    expect(() => inspectSyntheticPdf(Buffer.from(`%PDF-1.7\n/${name}\n%%EOF`), options)).toThrow(/PDF_OBJECT_STREAM_BLOCKED/);
  });
});

// Fixed extracted-text samples, not PDF authoring or proof of extraction integration.
function sampleTextReport(format = 'a4') {
  const s = validateHistoricalSnapshot(fixtures.document());
  const day = new Intl.DateTimeFormat('es-PE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Lima' }).format(new Date(s.issueDate));
  return { schemaVersion: 'factuez.synthetic-pdf-inspection.v1', environment: 'BETA', datasetClass: 'SYNTHETIC',
    noOfficialAuthority: true, fiscalAuthority: false, format, pdfSha256: 'a'.repeat(64),
    textLines: ['DOCUMENTO LOCAL DE PRUEBA', 'SIN VALIDEZ TRIBUTARIA · NO ACEPTADO POR SUNAT',
      'EMISOR FICTICIO 1','RUC 00000000001','DIRECCION FICTICIA QA','BOLETA DE VENTA · BQ01-1',
      `Emisión: ${day} · Lima`, 'Cliente: CLIENTE FICTICIO','Documento: 0', 'Moneda: PEN · Entorno: BETA',
      ...(format === 'a4' ? ['Descripción Cant. Und. P. unit. * Importe'] : []),
      '1. COMBUSTIBLE FICTICIO PARA QA', format === 'ticket' ? '2 GLL × 59.00 118.00' : '2 GLL 59.00 118.00',
      '* Precios unitarios con impuestos incluidos.', 'Base de ítems sin IGV 100.00','IGV 18.00',
      'TOTAL PEN 118.00','Forma de pago: Contado','FIRMA LOCAL · SIN CDR NI ENVÍO','Estado de prueba: SIGNED_LOCAL',
      `Hash XML firmado: ${digest}`,'QR de prueba con hash verificado. No acredita aceptación SUNAT.',
      'Esta prueba no acredita envío ni aceptación de SUNAT.'] };
}

describe('strict binding of current renderer extracted-text samples', () => {
  it('binds the real fictional pypdf/Inter ticket extraction with a digest split inside its token', () => {
    const snapshot = fixtures.document(1,1,'01'); snapshot.issueDate = '2026-10-04T15:30:00Z';
    Object.assign(snapshot.issuer,{ legalName: 'EMISOR FICTICIO QA', tradeName: 'ESTACION FICTICIA', address: 'AVENIDA FICTICIA 123' });
    Object.assign(snapshot.customer,{ identityType: '6', identityNumber: '00000000002', legalName: 'CLIENTE FICTICIO QA', address: 'DIRECCION FICTICIA 456' });
    snapshot.items[0].description = 'COMBUSTIBLE FICTICIO - PRUEBA LOCAL';
    const report = sampleTextReport('ticket');
    // Exact textLines copied from main's already-created fictional Inspection_01_ticket.json.
    // This regression authors no PDF and does not depend on disposable run directories.
    report.textLines = [
      'DOCUMENTO LOCAL DE PRUEBA','SIN VALIDEZ TRIBUTARIA · NO ACEPTADO POR SUNAT',
      'ESTACION FICTICIA','EMISOR FICTICIO QA','RUC 00000000001','AVENIDA FICTICIA 123',
      'FACTURA · FQ01-1','Emisión: 4/10/26, 10:30 a. m. · Lima',
      'Cliente: CLIENTE FICTICIO QA','RUC: 00000000002','DIRECCION FICTICIA 456','Moneda: PEN · Entorno: BETA',
      '1. COMBUSTIBLE FICTICIO - PRUEBA LOCAL','2 GLL × 59.00 118.00',
      '* Precios unitarios con impuestos incluidos.','Base de ítems sin IGV 100.00','IGV 18.00','TOTAL PEN 118.00',
      'Forma de pago: Contado','FIRMA LOCAL · SIN CDR NI ENVÍO','Estado de prueba: SIGNED_LOCAL',
      'Hash XML firmado: g2232CY7CEuS8n+','+an5wwXXIZlV4JYiwNiOcgP6n5vY=',
      'QR de prueba con hash verificado. No acredita aceptación','SUNAT.',
      'Esta prueba no acredita envío ni aceptación de SUNAT.','Desarrollado e implementado por www.mavrictec.com',
    ];
    expect(bindSyntheticPdfText(report,snapshot,'g2232CY7CEuS8n++an5wwXXIZlV4JYiwNiOcgP6n5vY=')).toMatchObject({ bound: true, differenceCount: 0 });
  });
  it.each([1,15,43])('joins a digest token wrapped after character %i and compares the full canonical value', split => {
    const report = sampleTextReport('ticket'), index = report.textLines.indexOf(`Hash XML firmado: ${digest}`);
    report.textLines.splice(index,1,`Hash XML firmado: ${digest.slice(0,split)}`,digest.slice(split));
    expect(bindSyntheticPdfText(report,fixtures.document(),digest).bound).toBe(true);
  });
  it('joins several digest-only continuation lines after a standalone label', () => {
    const report = sampleTextReport('ticket'), index = report.textLines.indexOf(`Hash XML firmado: ${digest}`);
    report.textLines.splice(index,1,'Hash XML firmado:',digest.slice(0,15),digest.slice(15,30),digest.slice(30));
    expect(bindSyntheticPdfText(report,fixtures.document(),digest).bound).toBe(true);
  });
  it.each([
    [`Hash XML firmado: ${digest.slice(0,8)} ${digest.slice(8,15)}`,digest.slice(15)],
    [`Hash XML firmado: ${digest.slice(0,15)}`,digest.slice(15) + 'X'],
    [`Hash XML firmado: ${digest.slice(0,15)}`,'X' + digest.slice(15)],
    [`Hash XML firmado: ${digest.slice(0,15)}`,digest.slice(15),'EXTRA'],
    [`Hash XML firmado: ${digest.slice(0,15)}`,'Hash XML firmado: ' + digest.slice(15)],
  ])('rejects spaces within a digest line and extra characters/labels in wrapped tokens %#', (...parts) => {
    const report = sampleTextReport('ticket'), index = report.textLines.indexOf(`Hash XML firmado: ${digest}`);
    report.textLines.splice(index,1,...parts);
    const result = bindSyntheticPdfText(report,fixtures.document(),digest);
    expect(result.bound).toBe(false);
    expect(result.differences.map((d: any) => d.path)).toContain('text.digestValue');
  });
  it.each(['a4','ticket'])('binds complete fixed sample blocks for %s and declares limited coverage', format => {
    const result = bindSyntheticPdfText(sampleTextReport(format), fixtures.document(), digest);
    expect(result).toMatchObject({ bound: true, differenceCount: 0, fiscalAuthority: false,
      completePdfSemanticsVerified: false, cryptographicHashVerified: false, reportProvenanceVerified: false });
    expect(result.checks).toHaveLength(12); expect(result.checks.every((c: any) => c.matched)).toBe(true);
  });
  it('joins wrapped label/value and cell lines without accepting value substrings', () => {
    const report = sampleTextReport();
    report.textLines = report.textLines.flatMap(line => {
      if (line.startsWith('Cliente:')) return ['Cliente: CLIENTE', 'FICTICIO'];
      if (line.startsWith('1.')) return ['1. COMBUSTIBLE FICTICIO', 'PARA QA'];
      if (line === '2 GLL 59.00 118.00') return ['2','GLL','59.00','118.00'];
      if (line.startsWith('Hash XML firmado:')) return ['Hash XML firmado:',digest];
      return [line];
    });
    expect(bindSyntheticPdfText(report, fixtures.document(), digest).bound).toBe(true);
    report.textLines[report.textLines.indexOf('118.00')] = '1118.00';
    expect(bindSyntheticPdfText(report, fixtures.document(), digest).differences.map((d: any) => d.path)).toContain('text.items.1.row');
  });
  it.each([
    ['BOLETA DE VENTA · BQ01-1','BOLETA DE VENTA · BQ01-11','text.header.document'],
    ['Cliente: CLIENTE FICTICIO','Cliente: CLIENTE FICTICIO EXTRA','text.customer.legalName'],
    ['Documento: 0','Documento: 00','text.customer.identityAndAddress'],
    ['Moneda: PEN · Entorno: BETA','Moneda: USD · Entorno: BETA','text.header.currency'],
    ['1. COMBUSTIBLE FICTICIO PARA QA','1. OTRO COMBUSTIBLE FICTICIO PARA QA','text.items.1.row'],
    ['2 GLL 59.00 118.00','2 GLL 159.00 118.00','text.items.1.row'],
    ['Base de ítems sin IGV 100.00','Base de ítems sin IGV 1100.00','text.amounts.taxableAmount'],
    ['IGV 18.00','IGV 118.00','text.amounts.igvAmount'],
    ['TOTAL PEN 118.00','TOTAL PEN 1118.00','text.amounts.payableAmount'],
    [`Hash XML firmado: ${digest}`,`Hash XML firmado: X${digest}`,'text.digestValue'],
  ])('flags changed printed blocks with correct QR still present: %s', (before, after, path) => {
    const report = sampleTextReport(); report.textLines[report.textLines.indexOf(before)] = after;
    const result = bindSyntheticPdfText(report, fixtures.document(), digest);
    expect(result.bound).toBe(false); expect(result.differences.map((d: any) => d.path)).toContain(path);
    expect(bindSyntheticQr(payloadFor(), fixtures.document(), digest).bound).toBe(true);
  });
  it('requires missing fields and rejects duplicate matches as ambiguous', () => {
    const report = sampleTextReport(); report.textLines = report.textLines.filter(line => !line.startsWith('Hash XML firmado:'));
    const missing = bindSyntheticPdfText(report, fixtures.document(), digest);
    expect(missing.differences).toContainEqual(expect.objectContaining({ path: 'text.digestValue', category: 'DATA_MISSING' }));
    const repeated = sampleTextReport(); repeated.textLines.splice(repeated.textLines.indexOf('IGV 18.00'),0,'IGV 18.00');
    expect(bindSyntheticPdfText(repeated, fixtures.document(), digest).differences).toContainEqual(
      expect.objectContaining({ path: 'text.amounts.igvAmount', ambiguous: true }));
  });
  it('does not accept a valid name prefix when a wrapped continuation contains extra text', () => {
    const report = sampleTextReport(); const index = report.textLines.indexOf('Cliente: CLIENTE FICTICIO');
    report.textLines.splice(index,1,'Cliente: CLIENTE FICTICIO','OTRO CLIENTE');
    expect(bindSyntheticPdfText(report, fixtures.document(), digest).differences.map((d: any) => d.path)).toContain('text.customer.legalName');
  });
  it('enforces item order/count and every item quantity/price/amount', () => {
    const s = fixtures.document(); s.items = [s.items[0], { ...structuredClone(s.items[0]), lineNumber: 2 }];
    for (const key of ['taxableAmount','igvAmount','payableAmount']) s.amounts[key] = ({ taxableAmount: '200.00', igvAmount: '36.00', payableAmount: '236.00' } as any)[key];
    s.tax[0].taxableAmount = '200.00'; s.tax[0].taxAmount = '36.00';
    const report = sampleTextReport(), index = report.textLines.indexOf('* Precios unitarios con impuestos incluidos.');
    report.textLines.splice(index,0,'2. COMBUSTIBLE FICTICIO PARA QA','2 GLL 59.00 118.00');
    report.textLines = report.textLines.map(line => line.replace('sin IGV 100.00','sin IGV 200.00').replace('IGV 18.00','IGV 36.00').replace('TOTAL PEN 118.00','TOTAL PEN 236.00'));
    expect(bindSyntheticPdfText(report,s,digest).bound).toBe(true);
    report.textLines.splice(index,2);
    const missing = bindSyntheticPdfText(report,s,digest);
    expect(missing.differences.map((d: any) => d.path)).toEqual(expect.arrayContaining(['text.items.orderAndCount','text.items.2.row']));
  });
  it('handles only exact known A4 continuation/footer/table lines between blocks', () => {
    const report = sampleTextReport(); const index = report.textLines.indexOf('* Precios unitarios con impuestos incluidos.');
    report.textLines.splice(index,0,'Prueba local · BQ01-1 · Página 1 de 2','BQ01-1 · RUC 00000000001 · PRUEBA LOCAL',
      'Descripción','Cant.','Und.','P. unit. *','Importe');
    expect(bindSyntheticPdfText(report,fixtures.document(),digest).bound).toBe(true);
  });
  it('matches exact renderer grouping and preserves fractional unit prices without rounding', () => {
    const s = fixtures.document(); s.items[0].quantity = '20';
    s.items[0].unitPriceWithTax = '59.123400';
    for (const target of [s.amounts,s.items[0].amounts]) Object.assign(target,{ taxableAmount: '1000.00', igvAmount: '180.00', payableAmount: '1180.00' });
    s.tax[0].taxableAmount = '1000.00'; s.tax[0].taxAmount = '180.00';
    const report = sampleTextReport(); report.textLines = report.textLines.map(line => line
      .replace('2 GLL 59.00 118.00','20 GLL 59.1234 1,180.00').replace('sin IGV 100.00','sin IGV 1,000.00')
      .replace('IGV 18.00','IGV 180.00').replace('TOTAL PEN 118.00','TOTAL PEN 1,180.00'));
    expect(bindSyntheticPdfText(report,s,digest).bound).toBe(true);
    report.textLines[report.textLines.indexOf('20 GLL 59.1234 1,180.00')] = '20 GLL 59.12 1,180.00';
    expect(bindSyntheticPdfText(report,s,digest).bound).toBe(false);
  });
  it('rejects untrusted profile, oversized text and report/snapshot accessors without evaluating them', () => {
    expect(() => bindSyntheticPdfText({ ...sampleTextReport(), environment: 'PRODUCTION' },fixtures.document(),digest)).toThrow(/PDF_TEXT_PROFILE_BLOCKED/);
    expect(() => bindSyntheticPdfText({ ...sampleTextReport(), textLines: ['x'.repeat(1001)] },fixtures.document(),digest)).toThrow(/PDF_TEXT_LIMIT/);
    const report = sampleTextReport(), getter = vi.fn(); Object.defineProperty(report,'textLines',{ enumerable: true,get:getter });
    expect(() => bindSyntheticPdfText(report,fixtures.document(),digest)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
});
