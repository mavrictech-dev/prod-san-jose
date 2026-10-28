import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { ReceivedDocumentDetail, ReceivedDocumentProjectionV1, ReceivedDocumentRow } from '@factuez/contracts';

// All amounts remain strings: importing evidence must not round or reinterpret taxes.
export async function receivedWorkbook(rows: (ReceivedDocumentRow & { projection: ReceivedDocumentProjectionV1 })[]) {
  const book = new ExcelJS.Workbook();
  book.creator = 'FactuEz';
  const headers = book.addWorksheet('Cabeceras');
  const items = book.addWorksheet('Items');
  headers.addRow(['ID recepción', 'RUC receptor', 'Sede ID', 'RUC proveedor', 'Proveedor', 'Tipo', 'Número', 'Emisión', 'Vencimiento', 'Moneda', 'Total declarado', 'SUNAT', 'Registro', 'Referencia ERP', 'SHA256 XML']);
  items.addRow(['ID recepción', 'RUC receptor', 'RUC proveedor', 'Número', 'Ítem', 'Código proveedor', 'Código SUNAT', 'Descripción', 'Unidad', 'Cantidad', 'Valor unitario', 'Precio unitario', 'Valor venta', 'Descuentos/cargos JSON', 'Tributos JSON']);
  for (const row of rows) {
    headers.addRow([row.id, row.recipientRuc, row.branchId, row.supplierRuc, row.supplierName, row.documentType, row.fullNumber, row.issueDate, row.projection.dueDate, row.currencyCode, row.payableAmount, 'NO CONSULTADO', row.registeredAt ? 'REGISTRADO' : 'PENDIENTE', row.erpReference, row.projection.xmlSha256]);
    for (const item of row.projection.items) items.addRow([row.id, row.recipientRuc, row.supplierRuc, row.fullNumber, item.lineId, item.supplierCode, item.sunatCode, item.description, item.unitCode, item.quantity, item.unitValue, item.unitPrice, item.lineExtensionAmount, JSON.stringify(item.allowances), JSON.stringify(item.taxes)]);
  }
  // Strings are cell values, never formulas/hyperlinks supplied by an XML.
  for (const sheet of [headers, items]) {
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } };
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF172235' } };
    sheet.columns.forEach(column => { column.width = 24; });
    sheet.eachRow((row, i) => { if (i > 1) row.eachCell(cell => { cell.numFmt = '@'; cell.alignment = { vertical: 'top', wrapText: true }; }); });
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}

export function receivedReadingPdf(detail: ReceivedDocumentDetail): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', margin: 44, bufferPages: true, info: { Title: `Lectura ${detail.fullNumber}`, Author: 'FactuEz' } });
    const chunks: Buffer[] = [];
    let size = 0;
    pdf.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 12 * 1024 * 1024) pdf.destroy(new Error('PDF demasiado grande')); else chunks.push(chunk); });
    pdf.on('error', reject); pdf.on('end', () => resolve(Buffer.concat(chunks)));
    const p = detail.projection;
    const block = (label: string, value: string | null | undefined) => {
      if (pdf.y > 710) pdf.addPage();
      pdf.font('Helvetica-Bold').fontSize(9).fillColor('#172235').text(label);
      pdf.font('Helvetica').fontSize(9).fillColor('#334155').text(value ?? 'No declarado', { width: 505, lineGap: 3 });
      pdf.moveDown(0.55);
    };
    pdf.font('Helvetica-Bold').fontSize(18).text('Documento recibido');
    pdf.font('Helvetica').fontSize(10).text(`${p.documentType} - ${p.fullNumber}`);
    pdf.moveDown();
    block('COPIA DE LECTURA NO FISCAL', 'Generada desde la proyección del XML. No sustituye al original ni acredita aceptación SUNAT. Estado: NO CONSULTADO.');
    block('Proveedor', `${p.supplier.legalName ?? 'No declarado'} | RUC ${p.supplier.identityNumber ?? 'No declarado'}\n${p.supplier.address ?? ''}`);
    block('Destinatario', `${p.recipient.legalName ?? 'No declarado'} | RUC ${p.recipient.identityNumber ?? 'No declarado'}\n${p.recipient.address ?? ''}`);
    block('Emisión / vencimiento / moneda', `${p.issueDate} ${p.issueTime ?? ''} | ${p.dueDate ?? 'No declarado'} | ${p.currencyCode ?? 'No declarada'}`);
    for (const item of p.items) {
      if (pdf.y > 580) pdf.addPage();
      pdf.moveTo(44, pdf.y).lineTo(550, pdf.y).strokeColor('#CBD5E1').stroke(); pdf.moveDown(0.6);
      block(`Ítem ${item.lineId}`, item.description);
      block('Códigos / cantidad / unidad', `${item.supplierCode ?? '-'} | SUNAT ${item.sunatCode ?? '-'} | ${item.quantity ?? '-'} ${item.unitCode ?? ''}`);
      block('Valor unitario / precio unitario / valor venta', `${item.unitValue ?? '-'} | ${item.unitPrice ?? '-'} | ${item.lineExtensionAmount ?? '-'}`);
      if (item.allowances.length) block('Descuentos y cargos', item.allowances.map(a => `${a.charge ? 'Cargo' : 'Descuento'}: ${a.amount ?? '-'} ${a.reason ?? ''}`).join('\n'));
      if (item.taxes.length) block('Tributos del ítem', item.taxes.map(t => `${t.schemeId ?? '-'} ${t.name ?? ''} | Base ${t.taxableAmount ?? '-'} | Tasa ${t.percent ?? '-'} | Importe ${t.amount ?? '-'} | Afectación ${t.affectationCode ?? '-'}`).join('\n'));
    }
    block('Totales declarados (no recalculados)', Object.entries(p.totals).filter(([, value]) => value !== null).map(([key, value]) => `${key}: ${value}`).join('\n') || 'No declarados en este tipo de documento');
    if (p.paymentTerms.length) block('Condiciones y cuotas', p.paymentTerms.map(t => `${t.id ?? '-'} | ${t.means ?? '-'} | ${t.amount ?? '-'} | ${t.dueDate ?? '-'}`).join('\n'));
    if (p.references.length) block('Referencias', p.references.map(r => `${r.kind}: ${r.documentType ?? '-'} ${r.number ?? '-'}`).join('\n'));
    if (p.notes.length) block('Notas del XML', p.notes.join('\n'));
    block('Firma', p.signature.status === 'MISSING' ? 'Ausente' : 'Presente, no verificada matemática ni oficialmente');
    block('SHA-256 del original', p.xmlSha256);
    block('Campos no proyectados', 'El detalle completo permanece en el XML original descargable. Consulte las advertencias de la bandeja.');
    const pages = pdf.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      pdf.switchToPage(i);
      // Footer is inside the bottom margin; temporarily extend the flow area.
      const bottom = pdf.page.margins.bottom; pdf.page.margins.bottom = 0;
      pdf.font('Helvetica').fontSize(8).fillColor('#64748B').text(`FactuEz | Documento recibido | Copia no fiscal | ${i + 1}/${pages.count}`, 44, 805, { width: 505 });
      pdf.page.margins.bottom = bottom;
    }
    pdf.end();
  });
}
