import PDFDocument from 'pdfkit';
import { join } from 'node:path';
import type { ResolvedPresentation } from './presentation';
import { clean, IMPLEMENTATION_CREDIT, type PrintFormat, visualNumber } from './types';

const MM = 72 / 25.4;
const ASSETS = join(__dirname, '../assets');
const FONT = require.resolve('@fontsource/inter/files/inter-latin-400-normal.woff');
const BOLD = require.resolve('@fontsource/inter/files/inter-latin-600-normal.woff');
export interface Cell { text: string; width: number; align?: 'left' | 'center' | 'right'; bold?: boolean }
export interface Row {
  kind: 'row'; cells: Cell[]; size: number; bold?: boolean; padding: number; gap: number;
  fill?: string; rule?: boolean; tableHeader?: Row; keepNext?: boolean;
  grid?: boolean; minHeight?: number;
  borderTop?: boolean; borderBottom?: boolean; borderSides?: boolean;
}
type Block = Row | { kind: 'masthead' } | { kind: 'image'; bytes: Buffer; side: number } |
  { kind: 'space'; height: number } | { kind: 'closing'; description: string; qr?: Buffer; digest?: string };
interface MeasuredRow { block: Row; lines: string[][]; lineHeight: number; count: number; height: number }
interface Header {
  fullNumber: string; ruc: string; label: string; issueDate: string;
  productionStatus?: import('./production').ProductionPdfStatus;
  guide?: boolean; presentation: ResolvedPresentation;
  /** Measurements from the supplied A4 models, never business defaults. */
  reference?: boolean;
  issuer?: { legalName: string; tradeName?: string; address?: string };
}

/** Explicit wrapping also splits unbroken codes/URLs. No PDFKit automatic pages. */
function wrap(doc: PDFKit.PDFDocument, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of clean(text).split(/\r\n|\r|\n/)) {
    let line = '';
    for (const word of paragraph.match(/\S+/gu) ?? []) {
      const candidate = line ? `${line} ${word}` : word;
      if (doc.widthOfString(candidate) <= width) { line = candidate; continue; }
      if (line) { lines.push(line); line = ''; }
      for (const character of word) {
        if (line && doc.widthOfString(line + character) > width) { lines.push(line); line = ''; }
        line += character;
      }
    }
    lines.push(line);
  }
  return lines;
}

export class LocalPdfLayout {
  readonly ticket: boolean;
  readonly width: number;
  readonly margin: number;
  readonly content: number;
  readonly size: number;
  readonly reference: boolean;
  private readonly doc: PDFKit.PDFDocument;
  private readonly blocks: Block[] = [{ kind: 'masthead' }];
  private digest?: string;

  constructor(private readonly header: Header, format: PrintFormat) {
    this.ticket = format === 'ticket';
    this.reference = !this.ticket && header.reference === true;
    this.width = this.ticket ? 80 * MM : this.reference ? 595 : 595.28;
    this.margin = this.ticket ? 4 * MM : this.reference ? 20 : 34;
    this.content = this.width - this.margin * 2;
    this.size = this.ticket ? 8 : this.reference ? 7 : header.guide ? 8 : 9;
    this.doc = new PDFDocument({ autoFirstPage: false, bufferPages: true, compress: true,
      info: { Title: `${header.fullNumber} - ${header.productionStatus ? `${header.label} · PRODUCCIÓN` : 'Prueba local'}`, Author: 'Mavric Technologies', CreationDate: new Date(header.issueDate) } });
    this.doc.registerFont('Inter', FONT).registerFont('InterBold', BOLD).font('Inter');
  }

  text(text: string, size = this.size, options: { bold?: boolean; gap?: number; align?: Cell['align'] } = {}): void {
    this.row([{ text, width: this.content, align: options.align }], size, { bold: options.bold, gap: options.gap ?? 4 });
  }

  row(cells: Cell[], size = this.size, options: Partial<Omit<Row, 'kind' | 'cells' | 'size'>> = {}): Row {
    const row: Row = { kind: 'row', cells: cells.map(cell => ({ ...cell, text: clean(cell.text) })),
      size, padding: this.ticket ? 3 : this.reference ? 0 : 2, gap: this.reference ? 0 : 3, ...options };
    if (!cells.length || cells.some(cell => !Number.isFinite(cell.width) || cell.width <= row.padding * 2) ||
      Math.abs(cells.reduce((sum, cell) => sum + cell.width, 0) - this.content) > 0.05 ||
      !Number.isFinite(size) || size < 5 || size > 24 ||
      row.minHeight !== undefined && (!Number.isFinite(row.minHeight) || row.minHeight < 0))
      throw new Error('Geometría de impresión inválida');
    this.blocks.push(row);
    return row;
  }

  section(label: string): void {
    this.row([{ text: label, width: this.content }], this.ticket ? 8 : this.header.guide ? 8 : 8.5,
      { bold: true, fill: '#eeeeee', padding: this.ticket ? 5 : this.header.guide ? 3 : 4,
        gap: this.ticket ? 4 : 3, keepNext: true });
  }

  fields(columns: string[]): void {
    this.row(columns.map(text => ({ text, width: this.content / columns.length })), this.size,
      { padding: 4, gap: 3 });
  }

  table(labels: string[], widths: number[], size = this.ticket ? 7.5 : 7.8): Row {
    if (this.reference) return this.row(labels.map((text, index) => ({ text, width: widths[index], align: 'center' })),
      size, { bold: true, padding: 3, minHeight: 26, gap: 0, grid: true, fill: '#f6f7f9', keepNext: true });
    return this.row(labels.map((text, index) => ({ text, width: widths[index], align: index > 2 ? 'right' : 'left' })),
      size, { bold: true, fill: '#e8e8e8', padding: 4, gap: 0, rule: true, keepNext: true });
  }

  image(bytes: Buffer): void { this.blocks.push({ kind: 'image', bytes, side: this.ticket ? 88 : 90 }); }

  space(height: number): void {
    if (!Number.isFinite(height) || height < 0 || height > 200) throw new Error('Espacio de impresión inválido');
    this.blocks.push({ kind: 'space', height });
  }

  closing(value: { description: string; qr?: Buffer; digest?: string }): void {
    this.digest = value.digest;
    this.blocks.push({ kind: 'closing', ...value, description: clean(value.description) });
  }

  private font(size: number, bold = false): void {
    this.doc.font(this.reference ? bold ? 'Helvetica-Bold' : 'Helvetica' : bold ? 'InterBold' : 'Inter').fontSize(size);
  }

  private measured(block: Row): MeasuredRow {
    this.font(block.size, block.bold);
    const lines = block.cells.map(cell => {
      this.font(block.size, cell.bold ?? block.bold);
      return wrap(this.doc, cell.text, cell.width - 2 * block.padding);
    });
    this.font(block.size, block.bold);
    const count = Math.max(1, ...lines.map(cell => cell.length));
    const lineHeight = this.reference ? block.size * 1.164 : this.doc.currentLineHeight(true) + 1;
    return { block, lines, count, lineHeight, height: Math.max(block.minHeight ?? 0, count * lineHeight + 2 * block.padding) + block.gap };
  }

  private logoGeometry(): { width: number; height: number } {
    const presentation = this.header.presentation;
    if (presentation.settings.logoMode === 'NONE') return { width: 0, height: 0 };
    const ratio = presentation.logo ? presentation.logoHeight! / presentation.logoWidth! : 222 / 961;
    const requested = presentation.settings.logoWidthMm * MM;
    const boxWidth = this.ticket ? this.content : this.reference ? 216 : 205;
    const availableWidth = this.ticket ? this.content : this.content - boxWidth - 16;
    const width = Math.min(requested, availableWidth, (this.ticket ? 58 : this.reference ? 52 : 72) / ratio);
    return { width, height: width * ratio };
  }

  private mastheadHeight(): number {
    const logo = this.logoGeometry();
    return this.ticket ? logo.height + 74 : this.reference ? this.referenceHeader().height + 14 : 88;
  }

  /** Fit the brand and immutable issuer data into their column without cropping.
   * Very long issuer data falls back to paginatable body rows, never truncation. */
  private referenceHeader() {
    const boxWidth = 216;
    const logoArea = this.content - boxWidth - 16;
    const logo = this.logoGeometry();
    const issuer = this.header.issuer;
    const summary = issuer ? [
      { text: clean(issuer.legalName), size: 9, bold: true },
      ...(issuer.tradeName?.trim() && issuer.tradeName.trim() !== issuer.legalName.trim()
        ? [{ text: clean(issuer.tradeName), size: 7, bold: false }] : []),
      ...(issuer.address?.trim() ? [{ text: clean(issuer.address), size: 7, bold: false }] : []),
    ] : [];
    const measure = (text: string, width: number, size: number, bold: boolean) => {
      this.font(size, bold);
      return wrap(this.doc, text, width).length * (this.doc.currentLineHeight(true) + 1);
    };
    const summaryHeight = summary.reduce((height, line) => height + measure(line.text, logoArea, line.size, line.bold) + 3, 0);
    const inline = summary.length > 0 && summaryHeight + logo.height + (logo.width ? 10 : 0) <= 160;
    const leftHeight = logo.height + (inline ? summaryHeight + (logo.width ? 10 : 0) : 0);
    const labels = this.header.guide ? ['GUÍA DE REMISIÓN', 'ELECTRÓNICA',
      this.header.label.includes('TRANSPORTISTA') ? 'TRANSPORTISTA' : 'REMITENTE'] :
      [this.header.label.replace(/ ELECTRÓNICA$/, ''), 'ELECTRÓNICA'];
    const card = [
      { text: `${this.header.guide ? 'RUC N°' : 'R.U.C.'} ${this.header.ruc}`, size: 11.5, gap: 7 },
      ...labels.map(text => ({ text, size: 13, gap: 3 })),
      { text: visualNumber(this.header.fullNumber), size: 14, gap: 0 },
    ];
    const cardHeight = 24 + card.reduce((height, line) => height + measure(line.text, boxWidth - 24, line.size, true) + line.gap, 0);
    return { boxWidth, logoArea, logo, summary, inline, leftHeight, card, cardHeight,
      height: Math.max(leftHeight, cardHeight) };
  }

  get inlineIssuer(): boolean { return this.reference && this.referenceHeader().inline; }

  private drawLogo(x: number, y: number): void {
    const { width, height } = this.logoGeometry();
    if (!width) return;
    if (this.header.presentation.logo) this.doc.image(this.header.presentation.logo, x, y, { width, height });
    else {
      this.doc.save().rect(x, y, width, height).clip();
      this.doc.image(join(ASSETS, 'san-jose-logo.png'), x - 130 * width / 961, y - 286 * width / 961,
        { width: 1200 * width / 961, height: 800 * width / 961 });
      this.doc.restore();
    }
  }

  private linesAt(text: string, x: number, y: number, width: number, size: number,
    options: { bold?: boolean; align?: Cell['align']; color?: string } = {}): number {
    this.font(size, options.bold);
    this.doc.fillColor(options.color ?? '#191919');
    const lineHeight = this.doc.currentLineHeight(true) + 1;
    const lines = wrap(this.doc, text, width);
    for (const [index, line] of lines.entries()) {
      const textWidth = this.doc.widthOfString(line);
      const offset = options.align === 'right' ? width - textWidth : options.align === 'center' ? (width - textWidth) / 2 : 0;
      this.doc.text(line, x + offset, y + index * lineHeight, { lineBreak: false });
    }
    return lines.length * lineHeight;
  }

  private drawMasthead(y: number): void {
    if (this.reference) {
      const head = this.referenceHeader();
      const centered = this.header.presentation.settings.logoAlignment === 'CENTER';
      let left = y + (head.height - head.leftHeight) / 2;
      this.drawLogo(this.margin + (centered ? (head.logoArea - head.logo.width) / 2 : 0), left);
      left += head.logo.height + (head.logo.width && head.inline ? 10 : 0);
      if (head.inline) for (const line of head.summary) {
        left += this.linesAt(line.text, this.margin, left, head.logoArea, line.size, { bold: line.bold }) + 3;
      }
      const x = this.width - this.margin - head.boxWidth;
      const top = y + (head.height - head.cardHeight) / 2;
      this.doc.save().lineWidth(0.8).rect(x, top, head.boxWidth, head.cardHeight)
        .fillAndStroke('#ffffff', '#b7b7b7').restore();
      let textY = top + 12;
      for (const line of head.card) textY += this.linesAt(line.text, x + 12, textY,
        head.boxWidth - 24, line.size, { bold: true, align: 'center' }) + line.gap;
      return;
    }
    const logo = this.logoGeometry();
    const center = this.header.presentation.settings.logoAlignment === 'CENTER';
    const boxWidth = this.ticket ? this.content : 205;
    const logoArea = this.ticket ? this.content : this.content - boxWidth - 16;
    this.drawLogo(this.margin + (center ? (logoArea - logo.width) / 2 : 0), y + (this.ticket ? 0 : 5));
    const x = this.ticket ? this.margin : this.width - this.margin - boxWidth;
    const top = y + (this.ticket ? logo.height + 8 : 0);
    const height = this.ticket ? 60 : 80;
    this.doc.save().lineWidth(0.8).rect(x, top, boxWidth, height)
      .fillAndStroke('#ffffff', '#b7b7b7').restore();
    this.linesAt(`RUC ${this.header.ruc}`, x + 8, top + 7, boxWidth - 16, this.ticket ? 9 : 10,
      { bold: true, align: 'center' });
    this.linesAt(this.header.label, x + 8, top + 23, boxWidth - 16, this.ticket ? 8 : 10,
      { bold: true, align: 'center' });
    this.linesAt(visualNumber(this.header.fullNumber), x + 8, top + (this.ticket ? 44 : 58), boxWidth - 16,
      this.ticket ? 10 : 13, { bold: true, align: 'center' });
  }

  get fiscalStatus(): string | undefined {
    return this.header.productionStatus ? ({ PENDING: 'PENDIENTE · SIN ACEPTACIÓN SUNAT ACREDITADA',
      ACCEPTED: 'ACEPTADA · CDR ORIGINAL VERIFICADO', ACCEPTED_WITH_OBSERVATIONS: 'ACEPTADA CON OBSERVACIONES · CDR ORIGINAL VERIFICADO',
      REJECTED: 'RECHAZADA POR SUNAT · SIN VALIDEZ TRIBUTARIA' } as const)[this.header.productionStatus] : undefined;
  }

  private warning(): string {
    if (this.fiscalStatus) return this.fiscalStatus;
    return this.header.guide ? 'SIN VALIDEZ TRIBUTARIA · NO AUTORIZA TRASLADO' : 'SIN VALIDEZ TRIBUTARIA · NO ACREDITA ACEPTACIÓN SUNAT';
  }

  private drawBrands(y: number): number {
    const factWidth = this.ticket ? 80 : 72, mavricSize = this.ticket ? 25 : 22, gap = 12;
    const factHeight = factWidth * 250 / 799;
    const x = this.ticket ? (this.width - factWidth - gap - mavricSize) / 2 : this.margin;
    const factY = y + (mavricSize - factHeight) / 2;
    this.doc.save().rect(x, factY, factWidth, factHeight).clip();
    this.doc.image(join(ASSETS, 'factuez-logo.png'), x - factWidth * 0.1064, factY - factHeight * 0.26,
      { width: factWidth * 1.5019 });
    this.doc.restore();
    this.doc.image(join(ASSETS, 'mavric-logo.png'), x + factWidth + gap, y, { width: mavricSize, height: mavricSize });
    return Math.max(factHeight, mavricSize);
  }

  private drawRow(measured: MeasuredRow, y: number, offset = 0, count = measured.count): number {
    const { block, lines, lineHeight } = measured;
    const height = Math.max(offset === 0 && count === measured.count ? block.minHeight ?? 0 : 0, count * lineHeight + 2 * block.padding);
    if (block.fill) this.doc.rect(this.margin, y, this.content, height).fill(block.fill);
    this.font(block.size, block.bold); this.doc.fillColor('#191919');
    let x = this.margin;
    for (const [index, cell] of block.cells.entries()) {
      this.font(block.size, cell.bold ?? block.bold);
      const available = cell.width - 2 * block.padding;
      for (let line = 0; line < count; line++) {
        const value = lines[index][offset + line];
        if (!value) continue;
        const textWidth = this.doc.widthOfString(value);
        const shift = cell.align === 'right' ? available - textWidth : cell.align === 'center' ? (available - textWidth) / 2 : 0;
        const centered = block.grid ? Math.max(0, (height - count * lineHeight - 2 * block.padding) / 2) : 0;
        this.doc.text(value, x + block.padding + shift, y + block.padding + centered + line * lineHeight, { lineBreak: false });
      }
      x += cell.width;
    }
    if (block.grid) {
      this.doc.save().lineWidth(0.5).rect(this.margin, y, this.content, height).stroke('#c7cdd5');
      let edge = this.margin;
      for (const cell of block.cells.slice(0, -1)) {
        edge += cell.width;
        this.doc.moveTo(edge, y).lineTo(edge, y + height).stroke('#c7cdd5');
      }
      this.doc.restore();
    }
    if (block.borderTop || block.borderBottom || block.borderSides) {
      this.doc.save().lineWidth(0.5).strokeColor('#aeb6c2');
      if (block.borderTop) this.doc.moveTo(this.margin, y).lineTo(this.width - this.margin, y).stroke();
      if (block.borderBottom) this.doc.moveTo(this.margin, y + height).lineTo(this.width - this.margin, y + height).stroke();
      if (block.borderSides) {
        this.doc.moveTo(this.margin, y).lineTo(this.margin, y + height).stroke();
        this.doc.moveTo(this.width - this.margin, y).lineTo(this.width - this.margin, y + height).stroke();
      }
      this.doc.restore();
    }
    if (block.rule) this.doc.moveTo(this.margin, y + height).lineTo(this.width - this.margin, y + height)
      .lineWidth(0.4).stroke('#d0d0d0');
    return height + block.gap;
  }

  async finish(): Promise<Buffer> {
    const doc = this.doc;
    const measured = this.blocks.map(block => block.kind === 'row' ? this.measured(block) : undefined);
    const heights = this.blocks.map((block, index) => block.kind === 'row' ? measured[index]!.height :
      block.kind === 'masthead' ? this.mastheadHeight() : block.kind === 'space' ? block.height :
        block.kind === 'closing' ? this.header.guide ? 82 : 104 : block.side + 8);
    const banner = this.ticket ? 42 : this.reference ? 0 : 28, footer = this.ticket ? 94 : this.reference ? 45 : 82;
    const pageHeight = this.ticket ? Math.max(180, this.margin * 2 + banner + footer + heights.reduce((a, b) => a + b, 0)) : this.reference ? 842 : 841.89;
    if (pageHeight > 14400) { doc.end(); doc.resume(); throw new Error('Ticket demasiado largo; utilice A4'); }
    const result = new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      doc.on('data', chunk => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    });
    const bottom = pageHeight - footer - (this.ticket ? this.margin : 0);
    const start = this.margin + banner;
    let y = start;
    const page = (table?: Row) => {
      doc.addPage({ size: [this.width, pageHeight], margin: 0 });
      if (this.reference) {
        this.linesAt(this.fiscalStatus ? `${this.header.label} · PRODUCCIÓN · ${this.fiscalStatus}` : 'DOCUMENTO LOCAL DE PRUEBA - SIN VALIDEZ TRIBUTARIA - LOCAL / BETA', this.margin, 5, this.content, 5.5, { bold: true });
      } else {
        this.linesAt(this.fiscalStatus ? `${this.header.label} · PRODUCCIÓN` : 'DOCUMENTO LOCAL DE PRUEBA', this.margin, this.margin, this.content, this.ticket ? 7.5 : 8, { bold: true });
        this.linesAt(`${this.warning()}${this.fiscalStatus ? '' : ' · LOCAL / BETA'}`, this.margin, this.margin + 12, this.content, this.ticket ? 6.5 : 7);
        if (!this.ticket) this.linesAt(this.header.fullNumber, this.width - this.margin - 170, this.margin, 170, 8, { align: 'right' });
      }
      y = start;
      if (table) y += this.drawRow(this.measured(table), y);
    };
    page();
    for (const [index, block] of this.blocks.entries()) {
      if (block.kind !== 'row') {
        if (!this.ticket && y + heights[index] > bottom) page();
        if (block.kind === 'masthead') this.drawMasthead(y);
        else if (block.kind === 'image') doc.image(block.bytes, this.ticket ? (this.width - block.side) / 2 : this.margin, y, { width: block.side, height: block.side });
        else if (block.kind === 'closing') {
          const qrX = this.header.guide ? 515 : 451;
          if (block.qr) doc.image(block.qr, qrX, y + 4, { width: 60, height: 60 });
          else {
            doc.save().lineWidth(0.5).rect(qrX, y + 4, 60, 60).stroke('#b7b7b7').restore();
            this.linesAt('QR pendiente\nSin emisión\nfiscal', qrX + 4, y + 22, 52, 7, { align: 'center' });
          }
          this.drawBrands(y + 8);
          this.linesAt(IMPLEMENTATION_CREDIT, this.margin, y + 36, 380, 6.5);
          this.linesAt(block.description, this.margin, y + (this.header.guide ? 50 : 66),
            this.header.guide ? 480 : this.content, 7);
          this.linesAt(this.fiscalStatus ? this.fiscalStatus : block.digest ? this.header.guide ? 'QR interno de prueba. Sin CDR oficial ni autorización de traslado.' :
            'QR de prueba con hash verificado. No acredita aceptación SUNAT.' : this.warning(),
          this.margin, y + (this.header.guide ? 70 : 90), this.content, 7, { bold: true });
        }
        y += heights[index]; continue;
      }
      const row = measured[index]!;
      const headerHeight = block.tableHeader ? this.measured(block.tableHeader).height : 0;
      const fresh = bottom - start - headerHeight;
      const next = block.keepNext ? Math.min(heights[index + 1] ?? 0, 32) : 0;
      if (!this.ticket && y + row.height + next > bottom && row.height <= fresh) page(block.tableHeader);
      let offset = 0;
      while (offset < row.count) {
        const available = Math.floor((bottom - y - 2 * block.padding - block.gap + 0.01) / row.lineHeight);
        if (available < 1) { page(block.tableHeader); continue; }
        const count = Math.min(row.count - offset, available);
        y += this.drawRow(row, y, offset, count);
        offset += count;
        if (offset < row.count) page(block.tableHeader);
      }
    }
    const pages = doc.bufferedPageRange();
    for (let index = 0; index < pages.count; index++) {
      doc.switchToPage(pages.start + index);
      if (this.reference) {
        this.linesAt(this.warning(), this.margin, pageHeight - 44, this.content, 6.5, { bold: true });
        this.linesAt(`Código${this.header.guide ? ' Hash' : ''}: ${this.digest ?? 'Sin firma / pendiente'}`, this.margin, 810, 260, 7);
        this.linesAt(`Página ${index + 1} de ${pages.count}`, 278, 810, 100, 7, { align: 'center' });
        this.linesAt(`R.U.C. ${this.header.ruc} · ${this.header.fullNumber}`, 390, 810, 185, 7, { align: 'right' });
        this.linesAt(IMPLEMENTATION_CREDIT, this.margin, 824, this.content, 6);
      } else if (this.ticket) {
        let top = pageHeight - footer;
        top += this.linesAt(this.warning(), this.margin, top, this.content, 6.5, { align: 'center' }) + 5;
        top += this.drawBrands(top) + 5;
        top += this.linesAt(IMPLEMENTATION_CREDIT, this.margin, top, this.content, 6.5, { align: 'center' }) + 3;
        this.linesAt(`${this.fiscalStatus ? 'PRODUCCIÓN' : 'Prueba local'} · ${this.header.fullNumber} · Página ${index + 1} de ${pages.count}`, this.margin, top, this.content, 6);
      } else {
        this.linesAt(this.warning(), this.margin, pageHeight - 69, this.content, 7);
        this.drawBrands(pageHeight - 51);
        this.linesAt(IMPLEMENTATION_CREDIT, this.margin, pageHeight - 19, this.content - 160, 6.5);
        this.linesAt(`Página ${index + 1} de ${pages.count} · ${this.header.fullNumber}`,
          this.width - this.margin - 150, pageHeight - 19, 150, 6.5, { align: 'right' });
      }
    }
    doc.end();
    return result;
  }
}
