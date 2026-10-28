import QRCode from 'qrcode';
import type { FiscalDocumentSnapshot, FiscalLineSnapshot, PrintOperationSnapshot, ProductionNotesAnySnapshot } from '@factuez/contracts';
import { LocalPdfLayout } from './layout';
import type { ProductionPdfEvidence } from './production';
import { buildReferenceSale } from './reference-sales';
import { resolvePresentation } from './presentation';
import { assertPrintFormat, assertQaDigest, calendarDate, clean, dateParts, money, quantity,
  type PrintFormat, type PrintableNote } from './types';

type LineWithDiscount = FiscalLineSnapshot & { discountAmount?: string };
const LABELS = { '01': 'FACTURA ELECTRÓNICA', '03': 'BOLETA DE VENTA ELECTRÓNICA',
  '07': 'NOTA DE CRÉDITO ELECTRÓNICA', '08': 'NOTA DE DÉBITO ELECTRÓNICA' } as const;

function validate(snapshot: FiscalDocumentSnapshot | PrintableNote, format: PrintFormat, maxLines = 100): void {
  assertPrintFormat(format);
  if (!snapshot || !['01', '03', '07', '08'].includes(snapshot.documentTypeCode) ||
    !Array.isArray(snapshot.lines) || !snapshot.lines.length || snapshot.lines.length > maxLines)
    throw new Error(`Representación sólo admite facturas, boletas y notas de 1 a ${maxLines} ítems`);
  if (!/^\d{11}$/.test(snapshot.issuer.identityNumber) ||
    !/^[FB][A-Z0-9]{3}-[1-9]\d{0,17}$/.test(snapshot.fullNumber) ||
    snapshot.fullNumber !== `${snapshot.series}-${snapshot.number}` || !['PEN', 'USD'].includes(snapshot.currencyCode))
    throw new Error('Identidad fiscal del snapshot inválida');
  dateParts(snapshot.issueDate);
  clean(snapshot.issuer.legalName); clean(snapshot.customer.legalName);
  for (const line of snapshot.lines as LineWithDiscount[]) {
    if (!Number.isInteger(line.lineNumber) || line.lineNumber < 1) throw new Error('Ítem del snapshot inválido');
    clean(line.description); clean(line.unitCode); quantity(line.quantity);
    for (const value of [line.unitValue, line.unitPriceWithTax, line.lineExtensionAmount, line.igvAmount, line.totalAmount]) money(value);
    if (line.discountAmount !== undefined) money(line.discountAmount);
  }
  for (const value of [snapshot.totals.taxableAmount, snapshot.totals.igvAmount, snapshot.totals.payableAmount]) money(value);
  if ('reference' in snapshot) {
    if (!['07', '08'].includes(snapshot.documentTypeCode) || !snapshot.reference ||
      !['01', '03'].includes(snapshot.reference.documentTypeCode) ||
      !/^[FB][A-Z0-9]{3}-[1-9]\d{0,7}$/.test(snapshot.reference.fullNumber) ||
      typeof snapshot.reasonCode !== 'string' || !snapshot.reasonCode.trim() ||
      typeof snapshot.reasonDescription !== 'string' || !clean(snapshot.reasonDescription).trim())
      throw new Error('Referencia de nota inválida');
    dateParts(snapshot.reference.issueDate);
  } else if (['07', '08'].includes(snapshot.documentTypeCode))
    throw new Error('La nota requiere comprobante afectado y motivo');
  const payment = snapshot.paymentTerms;
  if (payment) {
    if (payment.type === 'CONTADO') return;
    if (payment.type !== 'CREDITO' || snapshot.documentTypeCode !== '01' || payment.currencyCode !== snapshot.currencyCode ||
      !Array.isArray(payment.installments) || payment.installments.length < 1 || payment.installments.length > 999)
      throw new Error('Forma de pago del snapshot fuera del perfil');
    money(payment.pendingAmount);
    for (const installment of payment.installments) {
      calendarDate(installment.dueDate); money(installment.amount);
      if (installment.currencyCode && installment.currencyCode !== payment.currencyCode)
        throw new Error('Cuota del snapshot inválida');
    }
  }
}

function operation(layout: LocalPdfLayout, value: PrintOperationSnapshot | undefined): void {
  if (!value) return;
  const labels: [keyof PrintOperationSnapshot, string][] = [
    ['emissionPointName', 'Punto de emisión'], ['vehiclePlate', 'Placa'], ['attendedBy', 'Atendido por'],
    ['shiftLabel', 'Turno'], ['purchaseOrder', 'Orden de compra'], ['scopNumber', 'SCOP'],
    ['relatedGuide', 'Guía relacionada'], ['odometer', 'Odómetro'], ['observations', 'Observaciones'], ['amountInWords', 'Son'],
  ];
  const fields = labels.filter(([key]) => value[key] !== undefined && value[key] !== '');
  if (!fields.length) return;
  layout.section('INFORMACIÓN DE LA OPERACIÓN');
  const compact: string[] = [];
  for (const [key, label] of fields) {
    const text = `${label}: ${clean(value[key]!)}`;
    if (!layout.ticket && !['observations', 'amountInWords'].includes(key)) compact.push(text);
    else layout.text(text);
  }
  for (let index = 0; index < compact.length; index += 2) layout.fields(compact.slice(index, index + 2));
}

/** Shared sale geometry. Public local and production entry points enforce separate evidence contracts. */
async function renderSalePdf(
  snapshot: FiscalDocumentSnapshot | PrintableNote,
  format: PrintFormat,
  verifiedQa?: { digestValue: string; status: string },
  production?: ProductionPdfEvidence,
): Promise<Buffer> {
  validate(snapshot, format, production ? 500 : 100);
  if (production ? snapshot.environment !== 'PRODUCTION' || !['01', '03', '07', '08'].includes(snapshot.documentTypeCode) || snapshot.currencyCode !== 'PEN' || verifiedQa !== undefined : snapshot.environment !== 'BETA')
    throw new Error('Entorno de representación incompatible');
  const presentation = resolvePresentation(snapshot.printPresentation, snapshot.issuer.identityNumber, snapshot.branchId);
  let qr: Buffer | undefined;
  if (verifiedQa) {
    assertQaDigest(verifiedQa.digestValue);
    if (snapshot.environment !== 'BETA' || !/^00\d{9}$/.test(snapshot.issuer.identityNumber) ||
      !['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS', 'REJECTED', 'UNKNOWN', 'SIGNED_LOCAL'].includes(verifiedQa.status))
      throw new Error('Evidencia QA inválida');
    // Se conserva exclusivamente la evidencia recibida del llamador QA.
    const payload = [snapshot.issuer.identityNumber, snapshot.documentTypeCode, snapshot.series, snapshot.number,
      snapshot.totals.igvAmount, snapshot.totals.payableAmount, dateParts(snapshot.issueDate).isoDay,
      snapshot.customer.identityType, snapshot.customer.identityNumber, verifiedQa.digestValue].join('|') + '|';
    qr = await QRCode.toBuffer(payload, { type: 'png', errorCorrectionLevel: 'M', margin: 4, width: 400 });
  }
  if (production) qr = await QRCode.toBuffer(production.qrPayload, { type: 'png', errorCorrectionLevel: 'M', margin: 4, width: 400 });
  const layout = new LocalPdfLayout({ fullNumber: snapshot.fullNumber, ruc: snapshot.issuer.identityNumber,
    label: LABELS[snapshot.documentTypeCode as keyof typeof LABELS], issueDate: snapshot.issueDate,
    issuer: snapshot.issuer, presentation, reference: true, productionStatus: production?.status }, format);
  if (format === 'a4') {
    buildReferenceSale(layout, snapshot, presentation, qr, production ?? verifiedQa);
    return layout.finish();
  }
  layout.text(snapshot.issuer.tradeName || snapshot.issuer.legalName, layout.ticket ? 11 : 15, { bold: true, gap: 2 });
  if (snapshot.issuer.tradeName) layout.text(snapshot.issuer.legalName, layout.size, { gap: 2 });
  if (snapshot.issuer.address) layout.text(snapshot.issuer.address, layout.size, { gap: 2 });
  if (presentation.settings.showBranchAddress) {
    const name = presentation.branchName ?? snapshot.printOperation?.branchName;
    const address = presentation.branchAddress ?? snapshot.printOperation?.branchAddress;
    if (name) layout.text(`Sede: ${name}`, layout.size, { gap: 2 });
    if (address) layout.text(`Dirección de sede: ${address}`, layout.size, { gap: 4 });
  }
  layout.section('CLIENTE Y DOCUMENTO');
  const issued = dateParts(snapshot.issueDate);
  const identityLabel = snapshot.customer.identityType === '6' ? 'RUC' : snapshot.customer.identityType === '1' ? 'DNI' : 'Documento';
  const paymentLabel = snapshot.paymentTerms?.type === 'CONTADO' ? 'Contado' : snapshot.paymentTerms?.type === 'CREDITO' ? 'Crédito' : undefined;
  const customer = [`Cliente: ${snapshot.customer.legalName}`, `${identityLabel}: ${snapshot.customer.identityNumber}`,
    ...(snapshot.customer.address ? [`Dirección: ${snapshot.customer.address}`] : [])];
  const document = [`Fecha de emisión: ${issued.date}`, ...(issued.time ? [`Hora: ${issued.time} · Lima`] : []),
    `Moneda: ${snapshot.currencyCode}`, ...(paymentLabel ? [`Forma de pago: ${paymentLabel}`] : []),
    `Tipo de operación: ${snapshot.operationTypeCode}`, `Entorno del snapshot: ${snapshot.environment ?? 'Sin contexto'}`];
  if ('reference' in snapshot) document.push(`Comprobante afectado: ${snapshot.reference.documentTypeCode} · ${snapshot.reference.fullNumber}`,
    `Fecha de referencia: ${dateParts(snapshot.reference.issueDate).date}`);
  if (layout.ticket) { layout.text(customer.join('\n')); layout.text(document.join('\n')); }
  else layout.fields([customer.join('\n'), document.join('\n')]);

  const lines = snapshot.lines as LineWithDiscount[];
  const debitTax = snapshot.documentTypeCode === '08' && !lines.some(line => line.discountAmount !== undefined);
  const widths = [28, 43, layout.content - 395, 27, 48, 59, 59, 58, 73];
  const table = layout.ticket ? undefined : layout.table(
    ['Ítem', 'Código', 'Descripción', 'Und', 'Cantidad', 'V. Unitario', 'P. Unitario', debitTax ? 'IGV' : 'Descuento', 'Valor Venta'], widths);
  for (const line of lines) {
    if (layout.ticket) {
      layout.text(`${line.lineNumber}. ${line.description}`, 8, { bold: true, gap: 1 });
      if (line.productCode) layout.text(`Código: ${line.productCode}`, 7, { gap: 1 });
      layout.row([
        { text: `${quantity(line.quantity)} ${line.unitCode} × ${money(line.unitPriceWithTax)}`, width: layout.content * 0.65 },
        { text: money(line.totalAmount), width: layout.content * 0.35, align: 'right' },
      ], 8, { gap: 2 });
      layout.text(`V. Unitario: ${money(line.unitValue)} · Valor venta: ${money(line.lineExtensionAmount)}`,
        7, { gap: line.discountAmount === undefined ? 5 : 1 });
      if (line.discountAmount !== undefined) layout.text(`Descuento: ${money(line.discountAmount)}`, 7, { gap: 5 });
    } else {
      const values = [`${line.lineNumber}.`, line.productCode ?? '', line.description, line.unitCode, quantity(line.quantity),
        money(line.unitValue), money(line.unitPriceWithTax), debitTax ? money(line.igvAmount) :
          line.discountAmount === undefined ? '—' : money(line.discountAmount), money(line.lineExtensionAmount)];
      layout.row(values.map((text, index) => ({ text, width: widths[index], align: index > 3 ? 'right' : 'left' })),
        7.8, { padding: 4, gap: 0, rule: true, tableHeader: table });
    }
  }
  layout.text('V. Unitario y Valor Venta: sin IGV. P. Unitario: con impuestos incluidos.', layout.ticket ? 6.8 : 7.5);
  for (const [label, value] of [
    ['Valor de venta sin IGV', snapshot.totals.taxableAmount], ['IGV', snapshot.totals.igvAmount],
    [`TOTAL ${snapshot.currencyCode}`, snapshot.totals.payableAmount],
  ]) {
    const total = label.startsWith('TOTAL');
    layout.row([
      ...(!layout.ticket ? [{ text: '', width: layout.content * 0.45 }] : []),
      { text: label, width: layout.content * (layout.ticket ? 0.6 : 0.32), align: 'right' },
      { text: money(value), width: layout.content * (layout.ticket ? 0.4 : 0.23), align: 'right' },
    ], total ? layout.size + 1 : layout.size, { bold: total, fill: total ? '#eeeeee' : undefined, gap: 2 });
  }
  if ('reference' in snapshot) {
    layout.section('MOTIVO Y REFERENCIA DE LA NOTA');
    layout.text(`Comprobante afectado: ${snapshot.reference.documentTypeCode} · ${snapshot.reference.fullNumber}`);
    layout.text(`Motivo ${snapshot.reasonCode}: ${snapshot.reasonDescription}`);
  }
  const payment = snapshot.paymentTerms;
  if (payment?.type === 'CREDITO') {
    layout.section('PAGO AL CRÉDITO');
    layout.text(`Saldo pendiente: ${payment.currencyCode} ${money(payment.pendingAmount)}`);
    const quotaWidths = [layout.content * 0.23, layout.content * 0.35, layout.content * 0.42];
    const quotaHeader = layout.table(['Cuota', 'Vencimiento', `Importe ${payment.currencyCode}`], quotaWidths, layout.ticket ? 7 : 8);
    for (const [index, installment] of payment.installments.entries()) {
      layout.row([`Cuota ${index + 1}`, installment.dueDate, money(installment.amount)].map((text, column) =>
        ({ text, width: quotaWidths[column], align: column === 2 ? 'right' : 'left' })),
      layout.ticket ? 7 : 8, { gap: 0, rule: true, tableHeader: quotaHeader });
    }
  }
  operation(layout, snapshot.printOperation);
  if (presentation.settings.footerNote) {
    layout.section('NOTA COMERCIAL'); layout.text(presentation.settings.footerNote);
  }
  if (verifiedQa) {
    layout.section('EVIDENCIA DE PRUEBA QA');
    layout.text(verifiedQa.status === 'SIGNED_LOCAL' ? 'FIRMA LOCAL · SIN CDR NI ENVÍO' : 'CIRCUITO SIMULADO · CDR NO OFICIAL');
    layout.text(`Estado de prueba: ${verifiedQa.status}`);
    layout.image(qr!);
    layout.text(`Hash XML firmado: ${verifiedQa.digestValue}`, layout.ticket ? 6.5 : 8);
    layout.text('QR de prueba con hash verificado. No acredita aceptación SUNAT.', layout.ticket ? 7 : 8);
  }
  if (production) {
    layout.section('EVIDENCIA FISCAL · PRODUCCIÓN');
    layout.text(layout.fiscalStatus!, 8, { bold: true });
    if (production.receiptSummary) layout.text(`CDR Resumen RC: ${production.receiptSummary.identifier} · vinculado a boleta ${snapshot.fullNumber}`, 8, { bold: true });
    if (production.responseCode) layout.text(`Código CDR: ${production.responseCode}`);
    if (production.cdrDescription) layout.text(production.cdrDescription);
    for (const note of production.cdrNotes ?? []) layout.text(note);
    layout.image(qr!);
    layout.text(`Hash XML firmado: ${production.digestValue}`, 6.5);
    layout.text(`Representación impresa de ${snapshot.documentTypeCode === '07' ? 'la Nota de Crédito' : snapshot.documentTypeCode === '08' ? 'la Nota de Débito' : snapshot.documentTypeCode === '03' ? 'la Boleta de Venta' : 'la Factura'} Electrónica.`);
  } else layout.text('Esta prueba no acredita envío ni aceptación de SUNAT.', layout.ticket ? 7 : 8);
  return layout.finish();
}

export { IMPLEMENTATION_CREDIT, type PrintFormat, type PrintableNote } from './types';
export { renderLocalGrePdf, renderLocalTransportGuidePdf, type PrintableGre } from './gre';
export type { PrintableTransportGuide } from '@factuez/contracts';
export { PdfPreviewCache, PdfCacheBusyError, PdfCacheClosedError, PdfCacheResultTooLargeError,
  type PdfPreviewCacheOptions } from './pdf-cache';
export const PDF_RENDERER_VERSION = 'factuez.pdf-renderer.v4';


export type { ProductionPdfEvidence, ProductionPdfStatus } from './production';
/** Separate productive contract; common geometry receives only validated production evidence. */
export async function renderProductionInvoicePdf(snapshot: FiscalDocumentSnapshot, format: PrintFormat, evidence: ProductionPdfEvidence): Promise<Buffer> {
  return (await import('./production')).renderProductionInvoicePdf(snapshot, format, evidence, renderSalePdf);
}
/** Productive boleta: individual signed XML QR plus an independently verified summary/CDR binding. */
export async function renderProductionReceiptPdf(snapshot: FiscalDocumentSnapshot, format: PrintFormat, evidence: ProductionPdfEvidence): Promise<Buffer> {
  return (await import('./production')).renderProductionReceiptPdf(snapshot, format, evidence, renderSalePdf);
}
/** Strict LOCAL/BETA entry. It can never select the productive contract. */
export async function renderLocalDocumentPdf(snapshot: FiscalDocumentSnapshot | PrintableNote, format: PrintFormat, verifiedQa?: { digestValue: string; status: string }): Promise<Buffer> {
  if (snapshot?.environment !== 'BETA') throw new Error('Representación local limitada a BETA');
  return renderSalePdf(snapshot, format, verifiedQa);
}

export type { ProductionNotePdfEvidence } from './production-note';
/** Separate production-notes entry; LOCAL/BETA warning/guards remain unchanged. */
export async function renderProductionNotePdf(snapshot: ProductionNotesAnySnapshot, format: PrintFormat,
  evidence: import('./production-note').ProductionNotePdfEvidence): Promise<Buffer> {
  return (await import('./production-note')).renderProductionNotePdf(snapshot, format, evidence, renderSalePdf);
}
