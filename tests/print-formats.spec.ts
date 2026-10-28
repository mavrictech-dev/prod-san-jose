import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { FiscalDocumentSnapshot, FrozenPrintPresentationV1, PrintableTransportGuide } from '../packages/contracts/src';
import { IMPLEMENTATION_CREDIT, renderLocalDocumentPdf, renderLocalGrePdf, renderLocalTransportGuidePdf,
  type PrintableGre, type PrintableNote } from '../packages/pdf-renderer/src';
import { LocalPdfLayout, type Row } from '../packages/pdf-renderer/src/layout';
import { money } from '../packages/pdf-renderer/src/types';
import { documentSample, guideSample, pngLogo, presentation } from './qa-print-formats.mjs';

const require = createRequire(new URL('../packages/pdf-renderer/package.json', import.meta.url));
const QRCode = require('qrcode');

const document = (type = '01', options = {}) => documentSample(type, options) as FiscalDocumentSnapshot;
const guide = (type = '09', options = {}) => guideSample(type, options) as PrintableTransportGuide;
const digestValue = createHash('sha256').update('bytes ficticios de evidencia QA, sin firma ni envío').digest('base64');
const SALES_WIDTHS = [23, 50, 179, 23, 50, 60, 60, 50, 60];
const DEBIT_WIDTHS = [23, 50, 139, 23, 50, 60, 40, 60, 50, 60];
const GUIDE_WIDTHS = [23, 94, 250, 94, 94];
const SALES_LABELS = ['Ítem', 'Código', 'Descripción', 'Und.', 'Cantidad', 'V. Unitario', 'P. Unitario', 'Descuento', 'Valor Venta'];
const DEBIT_LABELS = [...SALES_LABELS.slice(0, 6), 'IGV', ...SALES_LABELS.slice(6)];
afterEach(() => vi.restoreAllMocks());

function capture() {
  const text: { value: string; x: number; y: number; width: number; height: number; page: number; paperWidth: number; paperHeight: number;
    color?: string; font?: string; fontSize?: number; reference: boolean }[] = [];
  const images: { source: string | Buffer; x: number; y: number; options: any }[] = [];
  const mastheads: { fill: string; stroke: string; lineWidth: number }[] = [];
  const rectangles: { x: number; y: number; width: number; height: number; page: number }[] = [];
  const segments: { x1: number; y1: number; x2: number; y2: number; page: number }[] = [];
  const fonts: string[] = [];
  const fontSizes: number[] = [];
  const layouts: { width: number; margin: number; content: number; size: number; reference: boolean }[] = [];
  const rows: Row[] = [];
  const pages = new Map<object, number>();
  const originalFinish = LocalPdfLayout.prototype.finish;
  vi.spyOn(LocalPdfLayout.prototype, 'finish').mockImplementation(function(this: any) {
    const doc = this.doc;
    const originalText = doc.text;
    const originalImage = doc.image;
    const originalFillColor = doc.fillColor;
    const originalLineWidth = doc.lineWidth;
    const originalFillAndStroke = doc.fillAndStroke;
    const originalFont = doc.font;
    const originalFontSize = doc.fontSize;
    const originalRect = doc.rect;
    const originalMoveTo = doc.moveTo;
    const originalLineTo = doc.lineTo;
    let currentColor: string | undefined;
    let currentLineWidth = 1;
    let currentFont: string | undefined;
    let currentFontSize: number | undefined;
    let point: { x: number; y: number } | undefined;
    const pageNumber = (page: object) => {
      if (!pages.has(page)) pages.set(page, pages.size);
      return pages.get(page)!;
    };
    layouts.push({ width: this.width, margin: this.margin, content: this.content, size: this.size, reference: this.reference });
    rows.push(...this.blocks.filter((block: { kind: string }) => block.kind === 'row'));
    vi.spyOn(doc, 'font').mockImplementation(function(this: any, ...args: any[]) {
      currentFont = args[0]; fonts.push(args[0]);
      return originalFont.apply(this, args);
    });
    vi.spyOn(doc, 'fontSize').mockImplementation(function(this: any, ...args: any[]) {
      currentFontSize = args[0]; fontSizes.push(args[0]);
      return originalFontSize.apply(this, args);
    });
    vi.spyOn(doc, 'rect').mockImplementation(function(this: any, ...args: any[]) {
      rectangles.push({ x: args[0], y: args[1], width: args[2], height: args[3], page: pageNumber(this.page) });
      return originalRect.apply(this, args);
    });
    vi.spyOn(doc, 'moveTo').mockImplementation(function(this: any, ...args: any[]) {
      point = { x: args[0], y: args[1] };
      return originalMoveTo.apply(this, args);
    });
    vi.spyOn(doc, 'lineTo').mockImplementation(function(this: any, ...args: any[]) {
      if (point) segments.push({ x1: point.x, y1: point.y, x2: args[0], y2: args[1], page: pageNumber(this.page) });
      point = { x: args[0], y: args[1] };
      return originalLineTo.apply(this, args);
    });
    vi.spyOn(doc, 'fillColor').mockImplementation(function(this: any, ...args: any[]) {
      currentColor = args[0];
      return originalFillColor.apply(this, args);
    });
    vi.spyOn(doc, 'lineWidth').mockImplementation(function(this: any, ...args: any[]) {
      currentLineWidth = args[0];
      return originalLineWidth.apply(this, args);
    });
    vi.spyOn(doc, 'fillAndStroke').mockImplementation(function(this: any, ...args: any[]) {
      mastheads.push({ fill: args[0], stroke: args[1], lineWidth: currentLineWidth });
      return originalFillAndStroke.apply(this, args);
    });
    vi.spyOn(doc, 'text').mockImplementation(function(this: any, ...args: any[]) {
      const [value, x, y] = args;
      text.push({ value, x, y, width: this.widthOfString(value), height: this.currentLineHeight(true),
        page: pageNumber(this.page), paperWidth: this.page.width, paperHeight: this.page.height, color: currentColor,
        font: currentFont, fontSize: currentFontSize, reference: layouts[layouts.length - 1].reference });
      return originalText.apply(this, args);
    });
    vi.spyOn(doc, 'image').mockImplementation(function(this: any, ...args: any[]) {
      images.push({ source: args[0], x: args[1], y: args[2], options: args[3] });
      return originalImage.apply(this, args);
    });
    return originalFinish.call(this);
  });
  return { text, images, mastheads, rectangles, segments, fonts, fontSizes, layouts, rows, pages,
    content: () => text.map(line => line.value).join(' '),
    bounds: () => {
      expect(text.map(line => line.value).join(' ')).not.toMatch(/20175642341|F179|Bizlinks|RI34005/i);
      for (const line of text) {
        expect(line.x, `x de ${line.value}`).toBeGreaterThanOrEqual(0);
        expect(line.x + line.width, `derecha de ${line.value}`).toBeLessThanOrEqual(line.paperWidth + 0.05);
        expect(line.y, `y de ${line.value}`).toBeGreaterThanOrEqual(0);
        expect(line.y + line.height, `abajo de ${line.value}`).toBeLessThanOrEqual(line.paperHeight + 0.05);
        if (line.reference) {
          expect(line.x, `margen izquierdo de ${line.value}`).toBeGreaterThanOrEqual(20 - 0.05);
          expect(line.x + line.width, `margen derecho de ${line.value}`).toBeLessThanOrEqual(575 + 0.05);
        }
      }
    } };
}

type Capture = ReturnType<typeof capture>;

function expectField(drawn: Capture, label: string, value: string, labelX: number, valueX: number) {
  const labels = drawn.text.filter(line => line.value === label && Math.abs(line.x - labelX) < 0.05);
  expect(labels, `Etiqueta ${label} en x=${labelX}`).toHaveLength(1);
  const field = labels[0];
  const values = drawn.text.filter(line => line.page === field.page && Math.abs(line.y - field.y) < 0.05 &&
    Math.abs(line.x - valueX) < 0.05);
  expect(values.map(line => line.value), `Valor de ${label} en su propia casilla`).toEqual([value]);
}

function expectItemCell(drawn: Capture, item: number, column: number, widths: number[], value: string) {
  const identifiers = drawn.text.filter(line => line.value === `${item}.` && line.x >= 20 && line.x < 43);
  expect(identifiers, `Ítem ${item}`).toHaveLength(1);
  const row = identifiers[0];
  const left = 20 + widths.slice(0, column).reduce((sum, width) => sum + width, 0);
  const right = left + widths[column];
  const cell = drawn.text.filter(line => line.page === row.page && Math.abs(line.y - row.y) < 0.05 &&
    line.x >= left && line.x < right);
  expect(cell.map(line => line.value), `Ítem ${item}, columna ${column + 1}`).toEqual([value]);
  expect(cell[0].x + cell[0].width).toBeLessThanOrEqual(right - 1 + 0.05);
  expect(cell[0].font).toBe('Helvetica'); expect(cell[0].fontSize).toBe(7);
}

function expectGrid(drawn: Capture, labels: string[], widths: number[]) {
  const headers = drawn.rows.filter(row => row.cells[0].text === 'Ítem');
  expect(headers).toHaveLength(1);
  expect(headers[0].cells.map(cell => cell.text)).toEqual(labels);
  expect(headers[0].cells.map(cell => cell.width)).toEqual(widths);
  expect(headers[0]).toMatchObject({ size: 7, grid: true, minHeight: 26, padding: 3, fill: '#f6f7f9' });
  const drawnHeaders = drawn.text.filter(line => line.value === 'Ítem');
  expect(drawnHeaders.length).toBeGreaterThan(0);
  const edges = widths.slice(0, -1).map((_, column) => 20 + widths.slice(0, column + 1).reduce((sum, width) => sum + width, 0));
  for (const header of drawnHeaders) {
    const frame = drawn.rectangles.find(rect => rect.page === header.page && rect.x === 20 && rect.width === 555 &&
      rect.y <= header.y && rect.y + rect.height > header.y);
    expect(frame, 'Borde de tabla A4').toBeDefined();
    expect(frame!.height).toBe(26);
    const divisions = drawn.segments.filter(line => line.page === header.page && line.y1 === frame!.y &&
      line.y2 === frame!.y + frame!.height && line.x1 === line.x2);
    expect(divisions.map(line => line.x1)).toEqual(edges);
    let left = 20;
    for (const [column, label] of labels.entries()) {
      const cell = drawn.text.filter(line => line.page === header.page && line.value === label &&
        line.y >= frame!.y && line.y < frame!.y + frame!.height);
      expect(cell, `Cabecera ${label}`).toHaveLength(1);
      expect(cell[0].x).toBeGreaterThanOrEqual(left + 1 - 0.05);
      expect(cell[0].x + cell[0].width).toBeLessThanOrEqual(left + widths[column] - 1 + 0.05);
      expect(cell[0].font).toBe('Helvetica-Bold'); expect(cell[0].fontSize).toBe(7);
      left += widths[column];
    }
  }
}

function minimalGuide(type: string): PrintableTransportGuide {
  const s = guide(type, { logoMode: 'NONE' });
  s.items = [{ code: 'QA-1', description: 'Bien ficticio QA', quantity: '1', unitCode: 'NIU' }];
  delete s.issuer.address; delete s.carrier; delete s.transferReason; delete s.relatedDocuments;
  delete s.packageCount; delete s.observations;
  delete s.origin.establishmentCode; delete s.destination.establishmentCode;
  s.printPresentation!.settings.showBranchAddress = false;
  s.printPresentation!.settings.footerNote = '';
  return s;
}

function pdfPages(bytes: Buffer) { return (bytes.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length; }
function legacy(): PrintableGre {
  const s = guide();
  return { id: 'QA', ublNumber: 'TQ00-1', issueDate: s.issueDate, issuer: { ruc: s.issuer.identityNumber, legalName: s.issuer.legalName },
    transferDate: s.transferDate, origin: { ...s.origin, establishmentCode: 'QA-ORIGEN' },
    destination: { ...s.destination, establishmentCode: 'QA-DESTINO' }, grossWeight: s.grossWeight, weightUnit: s.weightUnit,
    transport: { mode: '02', plate: 'QA0-001', driverDni: '00000001', driverFirstName: 'CONDUCTOR', driverLastName: 'QA', driverLicense: 'LICENCIA-QA' },
    items: s.items.map(item => ({ ...item, code: item.code ?? '' })), branchId: s.branchId, printPresentation: s.printPresentation };
}

describe('plantillas locales de comprobantes', () => {
  it.each(['01', '03', '07', '08', '09', '31'].flatMap(type => ['a4', 'ticket'].map(format => [type, format] as const)))(
    '%s/%s muestra recuadro blanco, borde gris y texto oscuro', async (type, format) => {
      const drawn = capture();
      const paper = format as 'a4' | 'ticket';
      if (type === '09' || type === '31') await renderLocalTransportGuidePdf(guide(type), paper);
      else await renderLocalDocumentPdf(document(type), paper);
      expect(drawn.mastheads).toEqual([{ fill: '#ffffff', stroke: '#b7b7b7', lineWidth: 0.8 }]);
      const rucLabel = format === 'ticket' ? 'RUC' : type === '09' || type === '31' ? 'RUC N°' : 'R.U.C.';
      expect(drawn.text.some(line => line.value === `${rucLabel} 00000000000`)).toBe(true);
      expect(drawn.text.some(line => line.value.endsWith('-00000001'))).toBe(true);
      for (const line of drawn.text) expect(line.color, `Color de ${line.value}`).toBe('#191919');
      drawn.bounds();
    });

  it.each(['01', '03', '07', '08', '09', '31'])('%s/A4 conserva papel y columnas con cabecera proporcionada', async type => {
    const drawn = capture();
    const isGuide = type === '09' || type === '31';
    const s = isGuide ? guide(type) : document(type);
    const before = structuredClone(s);
    if (isGuide) await renderLocalTransportGuidePdf(s as PrintableTransportGuide, 'a4');
    else await renderLocalDocumentPdf(s as FiscalDocumentSnapshot, 'a4');
    expect(drawn.layouts).toEqual([{ width: 595, margin: 20, content: 555, size: 7, reference: true }]);
    for (const page of drawn.pages.keys()) expect(page).toMatchObject({ width: 595, height: 842 });
    expect(new Set(drawn.fonts)).toEqual(new Set(['Helvetica', 'Helvetica-Bold']));
    expect(drawn.fontSizes).toContain(7);
    const card = drawn.rectangles.filter(rect => rect.x === 359 && rect.page === 0);
    expect(card).toHaveLength(1);
    expect(card[0]).toMatchObject({ x: 359, y: 20, width: 216, page: 0 });
    expect(card[0].height).toBeCloseTo(isGuide ? 121.755 : 102.285, 3);
    expectGrid(drawn, isGuide ? ['Ítem', 'Código', 'Descripción', 'Unidad', 'Cantidad'] :
      type === '08' ? DEBIT_LABELS : SALES_LABELS, isGuide ? GUIDE_WIDTHS : type === '08' ? DEBIT_WIDTHS : SALES_WIDTHS);
    const issuer = drawn.text.find(line => line.value === s.issuer.legalName && line.x === 20);
    expect(issuer).toMatchObject({ font: 'Helvetica-Bold', fontSize: 9 });
    expect(issuer!.y).toBeGreaterThan(20); expect(issuer!.y).toBeLessThan(card[0].y + card[0].height);
    expect(drawn.text.filter(line => line.value === s.issuer.legalName)).toHaveLength(1);
    if (!isGuide) {
      const trade = drawn.text.find(line => line.value === (s as FiscalDocumentSnapshot).issuer.tradeName && line.x === 20);
      expect(trade).toMatchObject({ font: 'Helvetica', fontSize: 7 });
      expect(trade!.y).toBeGreaterThan(issuer!.y);
    }
    expect(s).toEqual(before); drawn.bounds();
  });

  it.each(['01', '03', '07', '08'].flatMap(type => ['a4', 'ticket'].map(format => [type, format] as const)))(
    '%s/%s conserva números, marca de prueba y metadatos', async (type, format) => {
      const drawn = capture();
      const s = document(type); const before = structuredClone(s);
      const bytes = await renderLocalDocumentPdf(s, format as 'a4' | 'ticket');
      expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
      const source = bytes.toString('latin1');
      const author = /\/Author (\d+) 0 R/.exec(source)?.[1];
      expect(Boolean(author && source.includes(`${author} 0 obj\n(Mavric Technologies)`))).toBe(true);
      expect(pdfPages(bytes)).toBe(1);
      expect(s).toEqual(before);
      expect(drawn.content()).toContain(`${s.series}-00000001`);
      expect(drawn.content()).toContain(s.fullNumber);
      expect(drawn.content()).toContain('DOCUMENTO LOCAL DE PRUEBA');
      expect(drawn.content()).toContain('SIN VALIDEZ TRIBUTARIA');
      expect(drawn.content()).toContain('46.25');
      expect(drawn.content()).toContain(IMPLEMENTATION_CREDIT);
      expect(drawn.images.filter(image => Buffer.isBuffer(image.source))).toHaveLength(0);
      expect(drawn.images.some(image => typeof image.source === 'string' && image.source.endsWith('san-jose-logo.png'))).toBe(true);
      expect(drawn.images.some(image => typeof image.source === 'string' && image.source.endsWith('factuez-logo.png'))).toBe(true);
      expect(drawn.images.some(image => typeof image.source === 'string' && image.source.endsWith('mavric-logo.png'))).toBe(true);
      drawn.bounds();
      if (format === 'ticket') expect([...drawn.pages.keys()][0].width).toBeCloseTo(80 * 72 / 25.4, 4);
    });

  it('A4 muestra nueve columnas y no deduce descuento ni importes', async () => {
    const drawn = capture(); const s = document();
    s.lines[0].lineExtensionAmount = '9.123456'; s.totals.payableAmount = '77.77';
    await renderLocalDocumentPdf(s, 'a4');
    for (const label of SALES_LABELS)
      expect(drawn.text.some(line => line.value === label), `Cabecera ${label}`).toBe(true);
    for (const value of ['2.500000', '15.677966', '18.50', '9.123456', '77.77', '—'])
      expect(drawn.text.some(line => line.value === value), `Decimal ${value}`).toBe(true);
    expectGrid(drawn, SALES_LABELS, SALES_WIDTHS);
    for (const [column, value] of [[4, '2.500000'], [5, '15.677966'], [6, '18.50'], [7, '—'], [8, '9.123456']] as const)
      expectItemCell(drawn, 1, column, SALES_WIDTHS, value);
    expect(money('99999999999999999999.999999')).toBe('99,999,999,999,999,999,999.999999');
    expect(() => money('0.1234567')).toThrow();
    expect(() => money('1e2')).toThrow();
    drawn.bounds();
  });

  it.each(['01', '03', '07', '08'])('%s imprime descuento explícito, cero y ausencia en la fila y columna correctas', async type => {
    const drawn = capture(); const s = document(type);
    s.lines = [
      { ...s.lines[0], lineNumber: 1, discountAmount: '1.234567' },
      { ...s.lines[0], lineNumber: 2, discountAmount: '0' },
      { ...s.lines[0], lineNumber: 3 },
    ] as typeof s.lines;
    await renderLocalDocumentPdf(s, 'a4');
    const widths = type === '08' ? DEBIT_WIDTHS : SALES_WIDTHS;
    const column = type === '08' ? 8 : 7;
    expectGrid(drawn, type === '08' ? DEBIT_LABELS : SALES_LABELS, widths);
    for (const [index, value] of ['1.234567', '0.00', '—'].entries()) expectItemCell(drawn, index + 1, column, widths, value);
    if (type === '08') for (const item of [1, 2, 3]) expectItemCell(drawn, item, 6, widths, '7.06');
    drawn.bounds();
  });

  it('la nota de débito puede mostrar IGV; Contado es compatible con previews de notas', async () => {
    const drawn = capture(); const s = document('08') as PrintableNote;
    await renderLocalDocumentPdf(s, 'a4');
    expect(drawn.content()).toContain('Forma de pago: Contado');
    expectGrid(drawn, DEBIT_LABELS, DEBIT_WIDTHS);
    expectItemCell(drawn, 1, 6, DEBIT_WIDTHS, '7.06');
    expectItemCell(drawn, 1, 8, DEBIT_WIDTHS, '—');
    expectField(drawn, 'Motivo o', s.reasonDescription, 23, 102);
    expect(drawn.text.some(line => line.value === `Tipo Nota: 02 - ${s.reasonDescription}` && line.x === 23)).toBe(true);
    expectField(drawn, 'Factura/Boleta:', 'FQ00-00000002', 307, 392);
    drawn.bounds();
  });

  it.each(['01', '03'])('nota de crédito de %s conserva referencia completa y seis/siete filas adicionales', async referenceType => {
    const drawn = capture(); const s = document('07') as PrintableNote;
    const series = referenceType === '03' ? 'BQ00' : 'FQ00';
    s.series = series; s.fullNumber = `${series}-${s.number}`;
    s.reference.documentTypeCode = referenceType; s.reference.fullNumber = `${series}-2`;
    const before = structuredClone(s);
    const bytes = await renderLocalDocumentPdf(s, 'a4');
    expect(pdfPages(bytes)).toBe(1);
    expectField(drawn, 'Factura/Boleta:', `${series}-00000002`, 307, 392);
    expect(drawn.text.some(line => line.value === `${series}-00000001`)).toBe(true);
    expect(drawn.content()).toContain('Forma de pago: Contado');
    const labels = [...(referenceType === '03' ? ['PLACA'] : []), 'USUARIO', 'Hora Emisión', 'Nombre de la Sucursal',
      'Dirección Alterna', 'Fecha de Comprobante', 'Documento de referencia'];
    const values = [...(referenceType === '03' ? [s.printOperation!.vehiclePlate!] : []), s.printOperation!.attendedBy!,
      '10:30:00', s.printPresentation!.branchName!, s.printPresentation!.branchAddress!, '30/09/2026',
      referenceType === '03' ? 'BOLETA DE VENTA ELECTRÓNICA' : 'FACTURA ELECTRÓNICA'];
    const info = drawn.rows.filter(row => row.grid && row.cells.length === 3 && row.cells[0].width === 18);
    expect(info).toHaveLength(referenceType === '03' ? 7 : 6);
    expect(info.map(row => row.cells.map(cell => cell.text))).toEqual(labels.map((label, index) => [`${index + 1}`, label, values[index]]));
    for (const [index, label] of labels.entries()) expectField(drawn, label, values[index], 40, 193);
    expectField(drawn, 'Motivo o', s.reasonDescription, 23, 102);
    expect(drawn.content()).toContain(`Tipo Nota: 01 - ${s.reasonDescription}`);
    expect(s).toEqual(before); drawn.bounds();
  });

  it.each(['01', '03'])('%s/A4 muestra ausencias como raya sin inventar pago, placa ni importes en letras', async type => {
    const drawn = capture(); const s = document(type);
    delete s.printOperation; delete s.paymentTerms;
    s.printPresentation!.settings.showBranchAddress = false;
    await renderLocalDocumentPdf(s, 'a4');
    for (const label of ['Sucursal', 'Atendido Por', 'Placa', 'Condición de Pago', 'Origen', 'Odómetro'])
      expectField(drawn, label, '—', 40, 193);
    for (const label of ['N° Guía Remisión:', 'N° SCOP:', 'Orden de Compra:', 'Forma de Pago:'])
      expectField(drawn, label, '—', 390, 460);
    expectItemCell(drawn, 1, 7, SALES_WIDTHS, '—');
    expect(drawn.content()).not.toContain('Son:'); expect(drawn.content()).not.toContain('Contado');
    drawn.bounds();
  });

  it('usa sólo los datos presentes de operación, sin inventar Son ni referencias', async () => {
    const drawn = capture(); const s = document();
    s.printOperation = { vehiclePlate: 'QA0-002', scopNumber: 'SCOP-QA', amountInWords: 'IMPORTE EN LETRAS DEL SNAPSHOT', relatedGuide: 'TQ00-9' };
    await renderLocalDocumentPdf(s, 'a4');
    expectField(drawn, 'Placa', 'QA0-002', 40, 193);
    expectField(drawn, 'N° SCOP:', 'SCOP-QA', 390, 460);
    expectField(drawn, 'N° Guía Remisión:', 'TQ00-9', 390, 460);
    expect(drawn.text.some(line => line.value === 'IMPORTE EN LETRAS DEL SNAPSHOT' && line.x === 20)).toBe(true);
    for (const label of ['Atendido Por', 'Origen', 'Odómetro']) expectField(drawn, label, '—', 40, 193);
    expectField(drawn, 'Orden de Compra:', '—', 390, 460);
    expectItemCell(drawn, 1, 7, SALES_WIDTHS, '—');
    expect(drawn.content()).not.toContain('Atendido por:');
    expect(drawn.content()).not.toContain('Resolución');
    drawn.bounds();
  });

  it('página A4 repetida con 100 ítems, una fila enorme, identificadores largos y cuotas', async () => {
    const drawn = capture(); const s = document('01', { long: true, credit: true, logoMode: 'NONE' });
    s.lines[49].description = 'INICIO-FILA-ENORME ' + 'Texto extendido sin recortar la fila ni perder importes. '.repeat(500) + ' FIN-FILA-ENORME';
    s.lines[50].productCode = 'CODIGO'.repeat(60);
    s.customer.address = 'Dirección ficticia muy extensa. '.repeat(130);
    const before = structuredClone(s);
    const bytes = await renderLocalDocumentPdf(s, 'a4');
    expect(pdfPages(bytes)).toBeGreaterThan(5);
    expect(drawn.content()).toContain('FIN-FILA-ENORME');
    expect(drawn.content()).toContain('100.');
    expect(drawn.content()).toContain('Cuota 80');
    expect(drawn.text.filter(line => line.value === 'Descripción').length).toBeGreaterThan(3);
    expect(drawn.text.filter(line => line.value === 'Vencimiento').length).toBeGreaterThan(1);
    for (let page = 0; page < pdfPages(bytes); page++) {
      const text = drawn.text.filter(line => line.page === page).map(line => line.value).join(' ');
      expect(text).toContain('SIN VALIDEZ TRIBUTARIA'); expect(text).toContain(IMPLEMENTATION_CREDIT);
      expect(text).toContain(`Página ${page + 1} de ${pdfPages(bytes)}`);
    }
    expect(s).toEqual(before); drawn.bounds();
  }, 20000);

  it('ticket largo mantiene 80 mm y todos los ítems; rechaza papel sobre 14400 pt', async () => {
    const drawn = capture(); const s = document('03', { logoMode: 'NONE' });
    s.lines = Array.from({ length: 100 }, (_, index) => ({ ...s.lines[0], lineNumber: index + 1, description: `Producto QA ${index + 1}` }));
    expect(pdfPages(await renderLocalDocumentPdf(s, 'ticket'))).toBe(1);
    expect(drawn.content()).toContain('100. Producto QA 100'); drawn.bounds();
    s.lines[0].description = 'Texto ficticio muy extenso. '.repeat(4000);
    await expect(renderLocalDocumentPdf(s, 'ticket')).rejects.toThrow('utilice A4');
  }, 20000);

  it.each(['quantity', 'unitValue', 'unitPriceWithTax', 'lineExtensionAmount', 'igvAmount', 'totalAmount'])(
    'rechaza decimal inválido en %s', async field => {
      const s = document(); Object.assign(s.lines[0], { [field]: '1.0000009' });
      await expect(renderLocalDocumentPdf(s, 'a4')).rejects.toThrow();
    });

  it('mantiene validaciones de notas, fechas, pago, cantidad e identidad fiscal', async () => {
    const note = document('07') as PrintableNote; delete (note as any).reference;
    await expect(renderLocalDocumentPdf(note, 'a4')).rejects.toThrow('requiere');
    for (const patch of [{ fullNumber: 'FQ00-2' }, { issueDate: '2026-02-30T15:30:00Z' }, { lines: [] },
      { lines: Array.from({ length: 101 }, () => document().lines[0]) }, { paymentTerms: { type: 'OTRO' } }])
      await expect(renderLocalDocumentPdf({ ...document(), ...patch } as FiscalDocumentSnapshot, 'a4')).rejects.toThrow();
  });
});

describe('presentación congelada y evidencia QA', () => {
  it.each([[8, 256], [256, 8], [64, 64]].flatMap(([width, height]) =>
    ['a4', 'ticket'].map(format => [width, height, format] as const)))(
    'logo %s x %s en %s conserva proporción y se adapta sin invadir datos', async (width, height, format) => {
      const drawn = capture(); const s = document('01', { logoMode: 'CUSTOM' });
      s.printPresentation!.logo = pngLogo(width, height);
      s.printPresentation!.settings.logoWidthMm = 60;
      s.printPresentation!.settings.logoAlignment = 'CENTER';
      const before = structuredClone(s);
      await renderLocalDocumentPdf(s, format as 'a4' | 'ticket');
      const [logo] = drawn.images.filter(image => Buffer.isBuffer(image.source));
      expect(logo).toBeDefined();
      expect(logo.options.width / logo.options.height).toBeCloseTo(width / height, 6);
      expect(logo.options.height).toBeLessThanOrEqual(format === 'a4' ? 52 : 58);
      expect(logo.options.width).toBeLessThanOrEqual(60 * 72 / 25.4);
      expect(logo.x).toBeGreaterThanOrEqual(format === 'a4' ? 20 : 4 * 72 / 25.4);
      if (format === 'a4') {
        expect(logo.x + logo.options.width).toBeLessThanOrEqual(343);
        const issuer = drawn.text.find(line => line.value === s.issuer.legalName)!;
        expect(logo.y + logo.options.height + 9).toBeLessThanOrEqual(issuer.y);
      }
      expect(s).toEqual(before); drawn.bounds();
    });

  it('no repite la razón social cuando el nombre comercial coincide', async () => {
    const drawn = capture(); const s = document(); s.issuer.tradeName = s.issuer.legalName;
    await renderLocalDocumentPdf(s, 'a4');
    expect(drawn.text.filter(line => line.value === s.issuer.legalName)).toHaveLength(1);
    drawn.bounds();
  });

  it('dirección extensa pasa a filas paginables sin recortar ni esconder datos', async () => {
    const drawn = capture(); const s = document();
    s.issuer.address = 'Dirección fiscal ficticia extensa con todos sus datos. '.repeat(45) + 'FIN DIRECCIÓN QA';
    const before = structuredClone(s);
    await renderLocalDocumentPdf(s, 'a4');
    expect(drawn.content()).toContain('FIN DIRECCIÓN QA');
    expect(drawn.text.find(line => line.value === s.issuer.legalName)).toMatchObject({ fontSize: 7 });
    expect(s).toEqual(before); drawn.bounds();
  });

  it.each(['CUSTOM', 'DEFAULT', 'NONE'] as const)('logo %s respeta ancho/alineación y no borra marcas/crédito', async logoMode => {
    const drawn = capture(); const s = document('01', { logoMode });
    s.printPresentation!.settings.logoAlignment = 'CENTER'; s.printPresentation!.settings.logoWidthMm = 60;
    await renderLocalDocumentPdf(s, 'a4');
    const custom = drawn.images.filter(image => Buffer.isBuffer(image.source));
    expect(custom.length).toBe(logoMode === 'CUSTOM' ? 1 : 0);
    if (custom.length) {
      expect(custom[0].x).toBeGreaterThan(34);
      expect(custom[0].options.width).toBeCloseTo(Math.min(60 * 72 / 25.4, 52 * 32 / 12));
      expect(custom[0].options.height).toBeCloseTo(52);
      expect(custom[0].x + custom[0].options.width).toBeLessThan(343);
    }
    expect(drawn.images.some(image => typeof image.source === 'string' && image.source.endsWith('san-jose-logo.png'))).toBe(logoMode === 'DEFAULT');
    expect(drawn.content()).toContain(s.printPresentation!.settings.footerNote);
    expect(drawn.content()).toContain(IMPLEMENTATION_CREDIT); expect(drawn.content()).toContain('SIN VALIDEZ TRIBUTARIA');
  });

  it('oculta sede opcional y acepta presentación heredada con branchId ausente', async () => {
    const drawn = capture(); const s = document();
    s.printPresentation!.settings.showBranchAddress = false;
    await renderLocalDocumentPdf(s, 'a4');
    expect(drawn.content()).not.toContain('SEDE FICTICIA QA'); expect(drawn.content()).not.toContain('Dirección de sede ficticia QA');
    delete s.branchId; s.printPresentation!.branchId = null;
    await expect(renderLocalDocumentPdf(s, 'a4')).resolves.toBeInstanceOf(Buffer);
  });

  it.each([
    ['versión', (p: any) => { p.version = 'v2'; }], ['RUC', (p: any) => { p.issuerRuc = '00000000001'; }],
    ['sede', (p: any) => { p.branchId = 'OTRA'; }], ['revisión', (p: any) => { p.profileRevision = -1; }],
    ['ancho bajo', (p: any) => { p.settings.logoWidthMm = 19; }], ['ancho alto', (p: any) => { p.settings.logoWidthMm = 61; }],
    ['ancho NaN', (p: any) => { p.settings.logoWidthMm = NaN; }], ['nota', (p: any) => { p.settings.footerNote = 'a'.repeat(161); }],
    ['template', (p: any) => { p.settings.template = 'OTRA'; }], ['alineación', (p: any) => { p.settings.logoAlignment = 'RIGHT'; }],
    ['flag', (p: any) => { p.settings.showBranchAddress = 1; }], ['URL', (p: any) => { p.logoUrl = 'https://example.invalid/logo.png'; }],
    ['ruta settings', (p: any) => { p.settings.logoPath = 'C:\\archivo.png'; }],
    ['logo sin modo', (p: any) => { p.logo = pngLogo(); }],
  ])('rechaza %s sin cargar fuentes externas', async (_label, mutate) => {
    const s = document(); mutate(s.printPresentation);
    await expect(renderLocalDocumentPdf(s, 'a4')).rejects.toThrow();
  });

  it.each([
    ['SHA256', (l: any) => { l.sha256 = '0'.repeat(64); }], ['dimensiones', (l: any) => { l.width++; }],
    ['ancho 1025', (l: any) => { l.width = 1025; }], ['alto 513', (l: any) => { l.height = 513; }],
    ['bytes', (l: any) => { l.base64 = Buffer.alloc(128 * 1024 + 1).toString('base64'); }],
    ['ruta', (l: any) => { l.base64 = 'C:\\logo.png'; }], ['data URL', (l: any) => { l.base64 = 'data:image/png;base64,' + l.base64; }],
    ['MIME', (l: any) => { l.mediaType = 'image/jpeg'; }],
    ['CRC', (l: any) => { const bytes = Buffer.from(l.base64, 'base64'); bytes[35] ^= 1; l.base64 = bytes.toString('base64'); l.sha256 = createHash('sha256').update(bytes).digest('hex'); }],
    ['truncado', (l: any) => { const bytes = Buffer.from(l.base64, 'base64').subarray(0, 48); l.base64 = bytes.toString('base64'); l.sha256 = createHash('sha256').update(bytes).digest('hex'); }],
  ])('rechaza PNG con %s inválido', async (_label, mutate) => {
    const s = document('01', { logoMode: 'CUSTOM' }); mutate(s.printPresentation!.logo);
    await expect(renderLocalDocumentPdf(s, 'a4')).rejects.toThrow();
  });

  it('preview de RUC registrado sigue sin QR; verifiedQa sólo admite 00, BETA y hash canónico', async () => {
    const drawn = capture(); const qr = vi.spyOn(QRCode, 'toBuffer'); const s = document();
    s.issuer.identityNumber = '20111111111'; s.printPresentation!.issuerRuc = s.issuer.identityNumber;
    await renderLocalDocumentPdf(s, 'a4'); expect(qr).not.toHaveBeenCalled();
    await expect(renderLocalDocumentPdf(s, 'a4', { digestValue, status: 'SIGNED_LOCAL' })).rejects.toThrow('QA');
    const qa = document('01', { logoMode: 'CUSTOM' });
    await renderLocalDocumentPdf(qa, 'a4', { digestValue, status: 'SIGNED_LOCAL' });
    expect(qr).toHaveBeenCalledTimes(1); expect(drawn.text.some(line => line.value === `Código: ${digestValue}` && line.y === 810)).toBe(true);
    expect(drawn.content()).toContain('QR de prueba con hash verificado.');
    expect(qr.mock.calls[0][0]).toBe(`00000000000|01|FQ00|1|7.06|46.25|2026-10-01|6|00000000001|${digestValue}|`);
    expect(drawn.content()).toContain('FIRMA LOCAL - SIN CDR NI ENVÍO A SUNAT.');
    for (const [candidate, evidence] of [
      [{ ...qa, environment: 'PRODUCTION' }, { digestValue, status: 'ACCEPTED' }],
      [qa, { digestValue: 'fake', status: 'ACCEPTED' }], [qa, { digestValue, status: 'OFICIAL' }],
    ] as const) await expect(renderLocalDocumentPdf(candidate as FiscalDocumentSnapshot, 'a4', evidence)).rejects.toThrow('QA');
    drawn.bounds();
  });

  it.each(['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS', 'REJECTED', 'UNKNOWN'])(
    'estado QA %s conserva advertencia de CDR no oficial y no acredita aceptación', async status => {
      const drawn = capture(); const qr = vi.spyOn(QRCode, 'toBuffer'); const s = document(); const before = structuredClone(s);
      const bytes = await renderLocalDocumentPdf(s, 'a4', { digestValue, status });
      expect(qr).toHaveBeenCalledTimes(1);
      expect(drawn.content()).toContain(`CIRCUITO SIMULADO - CDR NO OFICIAL. Estado de prueba: ${status}`);
      expect(drawn.content()).toContain('QR de prueba con hash verificado. No acredita aceptación SUNAT.');
      expect(drawn.text.some(line => line.value === `Código: ${digestValue}` && line.y === 810)).toBe(true);
      for (let page = 0; page < pdfPages(bytes); page++) {
        const content = drawn.text.filter(line => line.page === page).map(line => line.value).join(' ');
        expect(content).toContain('SIN VALIDEZ TRIBUTARIA'); expect(content).toContain('NO ACREDITA ACEPTACIÓN SUNAT');
      }
      expect(s).toEqual(before); drawn.bounds();
    });
});

describe('guías 09/31 y perfil GRE QA histórico', () => {
  it.each(['09', '31'].flatMap(code => ['a4', 'ticket'].map(format => [code, format] as const)))(
    '%s/%s sólo muestra plantilla local, traslado y campos presentes', async (code, format) => {
      const drawn = capture(); const qr = vi.spyOn(QRCode, 'toBuffer'); const s = guide(code); const before = structuredClone(s);
      const bytes = await renderLocalTransportGuidePdf(s, format as 'a4' | 'ticket');
      expect(pdfPages(bytes)).toBe(1);
      expect(bytes.subarray(0, 5).toString()).toBe('%PDF-'); expect(s).toEqual(before); expect(qr).not.toHaveBeenCalled();
      for (const value of ['NO AUTORIZA TRASLADO', 'ORIGEN FICTICIO QA', 'DESTINO FICTICIO QA', '25.500000',
        'MTC-QA', 'QA0-001', 'LICENCIA-QA', 'FQ00-1', IMPLEMENTATION_CREDIT]) expect(drawn.content()).toContain(value);
      expect(drawn.content()).toContain(code === '31' ? 'TRANSPORTISTA' : 'REMITENTE');
      if (format === 'a4') {
        expectGrid(drawn, ['Ítem', 'Código', 'Descripción', 'Unidad', 'Cantidad'], GUIDE_WIDTHS);
        expectField(drawn, 'Número de Bultos o Pallets:', '2', 20, 220);
        expectField(drawn, 'Placa:', 'QA0-001', 23, 105);
        expect(drawn.text.filter(line => line.value === 'Código Hash: Sin firma / pendiente')).toHaveLength(pdfPages(bytes));
        expect(drawn.text.some(line => line.value.startsWith('Código Hash:') && line.value.includes(digestValue))).toBe(false);
        expect(drawn.content()).toContain('Sin aceptación oficial de SUNAT.');
        for (const [index, item] of s.items.entries()) {
          expectItemCell(drawn, index + 1, 1, GUIDE_WIDTHS, item.code!);
          expectItemCell(drawn, index + 1, 4, GUIDE_WIDTHS, item.quantity);
        }
      } else {
        expect(drawn.content()).toContain('Bultos: 2');
        if (code === '31') expect(drawn.content()).toContain('SIN EMISIÓN');
        expect(drawn.content()).not.toContain('Hash');
      }
      for (let page = 0; page < pdfPages(bytes); page++) {
        const content = drawn.text.filter(line => line.page === page).map(line => line.value).join(' ');
        expect(content).toContain('NO AUTORIZA TRASLADO'); expect(content).toContain(IMPLEMENTATION_CREDIT);
        expect(content).toContain(`Página ${page + 1} de ${pdfPages(bytes)}`);
      }
      drawn.bounds();
    });

  it.each(['09', '31'])('%s/A4 mínima sin complementos cabe en una página y conserva seguridad', async code => {
    const drawn = capture(); const qr = vi.spyOn(QRCode, 'toBuffer'); const s = minimalGuide(code); const before = structuredClone(s);
    const bytes = await renderLocalTransportGuidePdf(s, 'a4');
    expect(pdfPages(bytes)).toBe(1); expect(qr).not.toHaveBeenCalled();
    expect(drawn.content()).toContain('NO AUTORIZA TRASLADO'); expect(drawn.content()).toContain('SIN VALIDEZ TRIBUTARIA');
    expect(drawn.content()).toContain(IMPLEMENTATION_CREDIT);
    expect(drawn.content()).toContain('Código Hash: Sin firma / pendiente');
    expectGrid(drawn, ['Ítem', 'Código', 'Descripción', 'Unidad', 'Cantidad'], GUIDE_WIDTHS);
    expectItemCell(drawn, 1, 4, GUIDE_WIDTHS, '1');
    expect(s).toEqual(before); drawn.bounds();
  });

  it('guía de 100 ítems repite cabecera; no inventa transportista, motivo ni referencia ausentes', async () => {
    const drawn = capture(); const s = guide('31', { long: true, logoMode: 'NONE' });
    delete s.carrier; delete s.transferReason; delete s.relatedDocuments;
    const bytes = await renderLocalTransportGuidePdf(s, 'a4');
    expect(pdfPages(bytes)).toBeGreaterThan(2); expect(drawn.content()).toContain('100.');
    expect(drawn.text.filter(line => line.value === 'Descripción').length).toBeGreaterThan(1);
    expectField(drawn, 'Número registro MTC:', '-', 20, 110);
    expectField(drawn, 'Motivo de Traslado:', '-', 20, 110);
    expect(drawn.content()).not.toContain('MTC-QA'); expect(drawn.content()).not.toContain('Motivo 04');
    expect(drawn.content()).not.toContain('Traslado ficticio entre establecimientos');
    expect(drawn.content()).not.toContain('Datos del Transportista');
    expectGrid(drawn, ['Ítem', 'Código', 'Descripción', 'Unidad', 'Cantidad'], GUIDE_WIDTHS);
    expect(drawn.content()).not.toContain('FQ00-1'); drawn.bounds();
  });

  it('GRE QA conserva branch/presentación y QR interno con digest recibido', async () => {
    const drawn = capture(); const qr = vi.spyOn(QRCode, 'toBuffer'); const s = legacy();
    s.printPresentation = presentation('CUSTOM') as FrozenPrintPresentationV1;
    await renderLocalGrePdf(s, 'a4', digestValue);
    expect(drawn.content()).toContain('SEDE FICTICIA QA');
    expect(drawn.content()).toContain('NO AUTORIZA TRASLADO');
    expect(qr.mock.calls[0][0]).toBe(`FACTUEZ-GRE-QA|00000000000|TQ00-1|${digestValue}|NO-AUTORIZA-TRASLADO`);
    expect(drawn.text.some(line => line.value === `Código Hash: ${digestValue}` && line.y === 810)).toBe(true);
    expect(drawn.content()).toContain('QR interno de prueba. Sin CDR oficial ni autorización de traslado.');
    expect(drawn.content()).not.toContain('Motivo 04');
    for (const candidate of [{ ...s, issuer: { ...s.issuer, ruc: '20111111111' } }, { ...s, ublNumber: 'VQ00-1' },
      { ...s, items: Array.from({ length: 51 }, () => s.items[0]) }, { ...s, branchId: 'AJENA' }])
      await expect(renderLocalGrePdf(candidate, 'a4')).rejects.toThrow();
    await expect(renderLocalGrePdf(s, 'a4', 'fake')).rejects.toThrow();
    drawn.bounds();
  });

  it('no convierte 31 en documento fiscal ni permite guías dentro del renderer de ventas', async () => {
    await expect(renderLocalDocumentPdf({ ...document(), documentTypeCode: '31' } as any, 'a4')).rejects.toThrow('sólo admite');
    await expect(renderLocalTransportGuidePdf({ ...guide(), documentTypeCode: '01' } as any, 'a4')).rejects.toThrow();
  });

  it('generador exige --local-only antes de cargar o renderizar', () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./qa-print-formats.mjs', import.meta.url))], { encoding: 'utf8' });
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('--local-only'); expect(result.stdout).toBe('');
  });
});
