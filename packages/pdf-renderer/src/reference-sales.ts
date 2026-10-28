import type { FiscalDocumentSnapshot, FiscalLineSnapshot } from '@factuez/contracts';
import type { LocalPdfLayout, Cell } from './layout';
import type { ResolvedPresentation } from './presentation';
import type { ProductionPdfEvidence } from './production';
import { clean, dateParts, money, quantity, visualNumber, type PrintableNote } from './types';

type Sale = FiscalDocumentSnapshot | PrintableNote;
type Line = FiscalLineSnapshot & { discountAmount?: string };
const dash = (value?: string) => value ? clean(value) : '—';

/** Exact integer arithmetic for display-only buckets from frozen items, not new fiscal calculations. */
function lineBucket(lines: Line[], codes?: string[]): string {
  if (lines.some(line => !/^(10|11|12|13|14|15|16|17|20|21|30|31|32|33|34|35|36|37|40)$/.test(line.taxAffectationCode))) return '—';
  let sum = 0n;
  for (const line of lines.filter(line => !codes || codes.includes(line.taxAffectationCode))) {
    money(line.lineExtensionAmount);
    const [whole, fraction = ''] = line.lineExtensionAmount.split('.');
    sum += BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  }
  const fraction = (sum % 1000000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return money(`${sum / 1000000n}.${fraction}`);
}

function fields(layout: LocalPdfLayout, cells: string[], widths: number[], minHeight = 15): void {
  layout.row(cells.map((text, index) => ({ text, width: widths[index], bold: index % 2 === 0 })), 7, { minHeight });
}

function box(layout: LocalPdfLayout, title: string, value: string, height = 30): void {
  layout.row([{ text: title, width: layout.content }], 7,
    { bold: true, padding: 3, minHeight: 14, borderTop: true, borderSides: true, keepNext: true });
  layout.row([{ text: value, width: layout.content }], 7,
    { padding: 3, minHeight: height - 14, borderBottom: true, borderSides: true });
}

/** Compact A4 faithful to the supplied 01/03/07/08 geometries. Only frozen business facts. */
export function buildReferenceSale(layout: LocalPdfLayout, s: Sale, presentation: ResolvedPresentation,
  qr?: Buffer, evidence?: { digestValue: string; status: string } | ProductionPdfEvidence): void {
  const note = 'reference' in s;
  const op = s.printOperation;
  const issued = dateParts(s.issueDate);
  const payment = s.paymentTerms?.type === 'CONTADO' ? 'Contado' : s.paymentTerms?.type === 'CREDITO' ? 'Crédito' : '—';
  const idLabel = s.customer.identityType === '6' ? 'RUC:' : s.customer.identityType === '1' ? 'DNI:' : 'Documento:';
  const branchName = presentation.settings.showBranchAddress ? presentation.branchName ?? op?.branchName : undefined;
  const branchAddress = presentation.settings.showBranchAddress ? presentation.branchAddress ?? op?.branchAddress : undefined;

  if (!layout.inlineIssuer) {
    layout.row([{ text: s.issuer.legalName, width: 339 }, { text: '', width: 216 }], 7, { bold: true, minHeight: 14 });
    if (s.issuer.tradeName && s.issuer.tradeName !== s.issuer.legalName)
      layout.row([{ text: s.issuer.tradeName, width: 339 }, { text: '', width: 216 }], 7, { minHeight: 8.15 });
    layout.row([{ text: dash(s.issuer.address), width: 260 }, { text: '', width: 295 }], 7, { minHeight: 16.3 });
  }
  layout.space(6);
  if (note) {
    const widths = [79, 208, 85, 183];
    fields(layout, ['Nombre/Razón Social:', s.customer.legalName, idLabel, s.customer.identityNumber], widths);
    fields(layout, ['Dirección:', dash(s.customer.address), 'Fecha Emisión:', issued.date], widths);
    fields(layout, ['Moneda:', s.currencyCode === 'PEN' ? 'Sol' : 'Dólar estadounidense', 'Factura/Boleta:', visualNumber(s.reference.fullNumber)], widths);
    layout.space(8);
  } else {
    const widths = [70, 117, 70, 113, 70, 115];
    fields(layout, ['Cliente:', s.customer.legalName, idLabel, s.customer.identityNumber, 'N° Guía Remisión:', dash(op?.relatedGuide)], widths);
    fields(layout, ['Dirección:', dash(s.customer.address), 'Fecha Emisión:', issued.date, 'N° SCOP:', dash(op?.scopNumber)], widths);
    fields(layout, ['Moneda:', s.currencyCode === 'PEN' ? 'Sol' : 'Dólar estadounidense', 'Hora Emisión:', dash(issued.time), 'Orden de Compra:', dash(op?.purchaseOrder)], widths);
    fields(layout, ['', '', '', '', 'Forma de Pago:', payment], widths);
    layout.space(11);
  }

  const debit = s.documentTypeCode === '08';
  const widths = debit ? [23, 50, 139, 23, 50, 60, 40, 60, 50, 60] : [23, 50, 179, 23, 50, 60, 60, 50, 60];
  const labels = ['Ítem', 'Código', 'Descripción', 'Und.', 'Cantidad', 'V. Unitario', ...(debit ? ['IGV'] : []), 'P. Unitario', 'Descuento', 'Valor Venta'];
  const header = layout.table(labels, widths, 7);
  const lines = s.lines as Line[];
  for (const line of lines) {
    const plate = note && (debit || s.reference.documentTypeCode === '03') ? `\nNúmero de Placa: ${dash(op?.vehiclePlate)}` : '';
    const values = [`${line.lineNumber}.`, dash(line.productCode), line.description + plate, line.unitCode, quantity(line.quantity),
      money(line.unitValue), ...(debit ? [money(line.igvAmount)] : []), money(line.unitPriceWithTax),
      line.discountAmount === undefined ? '—' : money(line.discountAmount), money(line.lineExtensionAmount)];
    layout.row(values.map((text, column): Cell => ({ text, width: widths[column],
      align: column === 0 || column === 1 || column === 3 ? 'center' : column >= 4 ? 'right' : 'left' })),
    7, { padding: 3, minHeight: 18, grid: true, tableHeader: header });
  }
  layout.space(5);
  const totals: [string, string][] = [
    ...(!note ? [['Sub Total', lineBucket(lines)] as [string, string]] : []),
    ['Op. Gravada', money(s.totals.taxableAmount)], ['I.G.V', money(s.totals.igvAmount)],
    ['Op. Inafecta', lineBucket(lines, ['30', '31', '32', '33', '34', '35', '36', '37'])],
    ['Op. Exonerada', lineBucket(lines, ['20', '21'])], ['Op. Exportación', lineBucket(lines, ['40'])],
    ['', '___________'], ['Importe Total', money(s.totals.payableAmount)],
  ];
  for (const [index, [label, value]] of totals.entries()) {
    layout.row([{ text: note && index === 0 ? dash(op?.amountInWords) : '', width: 264 },
      { text: label, width: 167, bold: true }, { text: label ? s.currencyCode === 'PEN' ? 'S/' : 'US$' : '', width: 50 },
      { text: value, width: 74, align: 'right' }], 7, { minHeight: 13 });
  }
  layout.space(8);
  if (note) {
    layout.row([{ text: 'Motivo o', width: 79, bold: true }, { text: s.reasonDescription, width: 476 }], 7,
      { padding: 3, minHeight: 14, borderTop: true, borderSides: true, keepNext: true });
    layout.row([{ text: `Tipo Nota: ${s.reasonCode} - ${s.reasonDescription}`, width: 555 }], 7,
      { padding: 3, minHeight: 18, borderBottom: true, borderSides: true });
  } else {
    layout.row([{ text: '', width: 264 }, { text: 'EFECTIVO', width: 291 }], 7, { bold: true, minHeight: 13 });
    layout.row([{ text: dash(op?.amountInWords), width: 264 }, { text: 'TARJETA DE CRÉDITO', width: 291 }], 7, { minHeight: 13 });
    layout.space(2);
    layout.row([
      { text: `USUARIO: ${dash(op?.attendedBy)}`, width: 150 }, { text: 'LADO: —', width: 136 },
      { text: `TURNO: ${dash(op?.shiftLabel)}`, width: 132 }, { text: `PLACA: ${dash(op?.vehiclePlate)}`, width: 137 },
    ], 7, { bold: true, padding: 3, minHeight: 16, borderTop: true, borderSides: true, keepNext: true });
    layout.row([{ text: `Observación: ${dash(op?.observations)}`, width: 555 }], 7,
      { padding: 3, minHeight: 28, borderBottom: true, borderSides: true });
  }
  layout.space(6);
  const production = evidence && 'environment' in evidence ? evidence : undefined;
  box(layout, 'Observaciones de SUNAT:', layout.fiscalStatus ?
    [layout.fiscalStatus, production?.cdrDescription, ...(production?.cdrNotes ?? [])].filter(Boolean).join('\n') : evidence ?
    evidence.status === 'SIGNED_LOCAL' ? 'FIRMA LOCAL - SIN CDR NI ENVÍO A SUNAT.' :
      `CIRCUITO SIMULADO - CDR NO OFICIAL. Estado de prueba: ${evidence.status}` :
    'Esta prueba no acredita envío ni aceptación de SUNAT. Sin CDR oficial.', 30);
  layout.space(5);
  if (!debit) {
    layout.text('Información Adicional', 7, { bold: true, gap: 2 });
    const info: [string, string][] = note ? [
      ...(s.reference.documentTypeCode === '03' ? [['PLACA', dash(op?.vehiclePlate)] as [string, string]] : []),
      ['USUARIO', dash(op?.attendedBy)], ['Hora Emisión', dash(issued.time)],
      ['Nombre de la Sucursal', dash(branchName)], ['Dirección Alterna', dash(branchAddress)],
      ['Fecha de Comprobante', dateParts(s.reference.issueDate).date],
      ['Documento de referencia', s.reference.documentTypeCode === '03' ? 'BOLETA DE VENTA ELECTRÓNICA' : 'FACTURA ELECTRÓNICA'],
    ] : [
      ['Sucursal', dash([branchName, branchAddress].filter(Boolean).join(' - '))], ['Atendido Por', dash(op?.attendedBy)],
      ['Placa', dash(op?.vehiclePlate)], ['Condición de Pago', payment], ['Origen', dash(op?.emissionPointName)], ['Odómetro', dash(op?.odometer)],
    ];
    for (const [index, [label, value]] of info.entries()) layout.row([
      { text: `${index + 1}`, width: 18 }, { text: label, width: 153 }, { text: value, width: 384 },
    ], 7, { grid: true, padding: 2, minHeight: 17 });
  }
  if (s.paymentTerms?.type === 'CREDITO') {
    layout.space(5);
    layout.text(`Forma de pago: Crédito - Saldo pendiente: ${s.paymentTerms.currencyCode} ${money(s.paymentTerms.pendingAmount)}`, 7, { bold: true });
    const quotaWidths = [128, 194, 233];
    const quotaHeader = layout.table(['Cuota', 'Vencimiento', `Importe ${s.paymentTerms.currencyCode}`], quotaWidths, 7);
    for (const [index, installment] of s.paymentTerms.installments.entries()) layout.row([
      { text: `Cuota ${index + 1}`, width: 128 }, { text: installment.dueDate, width: 194 },
      { text: money(installment.amount), width: 233, align: 'right' },
    ], 7, { grid: true, padding: 2, minHeight: 17, tableHeader: quotaHeader });
  }
  if (note) {
    layout.space(3);
    layout.text(`Forma de pago: ${payment}`, 7, { gap: 2 });
    if (op?.emissionPointName) layout.text(`Punto de emisión: ${clean(op.emissionPointName)}`, 7, { gap: 2 });
    if (op?.observations) layout.text(`Observación: ${clean(op.observations)}`, 7, { gap: 2 });
    for (const [label, value] of [['SCOP', op?.scopNumber], ['Guía relacionada', op?.relatedGuide], ['Orden de compra', op?.purchaseOrder],
      ['Odómetro', op?.odometer], ['Turno', op?.shiftLabel]] as const) if (value) layout.text(`${label}: ${clean(value)}`, 7, { gap: 2 });
    if (debit && presentation.settings.showBranchAddress && (branchName || branchAddress))
      layout.text(`Sucursal: ${[branchName, branchAddress].filter(Boolean).join(' - ')}`, 7, { gap: 2 });
  }
  if (presentation.settings.footerNote) { layout.space(4); layout.text(presentation.settings.footerNote, 7, { gap: 4 }); }
  layout.space(4);
  layout.text(layout.fiscalStatus ?? 'Autorización de emisión electrónica: pendiente. Representación LOCAL / BETA.', 7, { gap: 2 });
  if (production?.receiptSummary) layout.text(`CDR Resumen RC: ${production.receiptSummary.identifier} · vinculado a boleta ${s.fullNumber}`, 7, { gap: 2, bold: true });
  if (layout.fiscalStatus && evidence && 'responseCode' in evidence) layout.text(`Código CDR: ${evidence.responseCode}`, 7, { gap: 2 });
  layout.closing({ description: `Representación impresa${layout.fiscalStatus ? '' : ' local'} de ${note ? s.documentTypeCode === '07' ? 'la Nota de Crédito' : 'la Nota de Débito' : s.documentTypeCode === '03' ? 'la Boleta de Venta' : 'la Factura'} Electrónica.`,
    qr, digest: evidence?.digestValue });
}
