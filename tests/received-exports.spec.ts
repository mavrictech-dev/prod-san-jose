import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { parseReceivedXml } from '../packages/received-core/src';
import { receivedXml } from './received-fixture.mjs';
import { receivedWorkbook, receivedReadingPdf } from '../services/received-documents-service/src/exports';
const require = createRequire(new URL('../services/received-documents-service/package.json', import.meta.url));
const ExcelJS = require('exceljs');
const p = parseReceivedXml(Buffer.from(receivedXml()));
const row = { id: 'qa', companyId: 101, recipientRuc: '00000000101', branchId: null, supplierRuc: '00000000303', supplierName: '=HYPERLINK("evil")', documentType: '01', fullNumber: p.fullNumber, issueDate: p.issueDate, currencyCode: 'PEN', payableAmount: '118.00', receivedAt: '2026-01-01T12:00:00Z', itemCount: 1, sunatStatus: 'NOT_CHECKED' as const, lastVerifiedAt: null, registeredAt: null, erpReference: null, warnings: p.warnings, projection: p, artifacts: [] };
describe('Received exports keep source evidence separate', () => {
  it('exports two sheets with decimal strings and no spreadsheet formulas', async () => {
    const book = new ExcelJS.Workbook(); await book.xlsx.load(await receivedWorkbook([row]));
    expect(book.worksheets.length).toBe(2); expect(book.getWorksheet('Items').getCell('K2').value).toBe('20.000000');
    expect(book.getWorksheet('Cabeceras').getCell('E2').value).toBe(row.supplierName);
    expect(book.getWorksheet('Cabeceras').getCell('L2').value).toBe('NO CONSULTADO');
    expect(book.getWorksheet('Cabeceras').getCell('E2').type).toBe(ExcelJS.ValueType.String);
  });
  it('generates reading PDF without changing the original projection/hash', async () => {
    const before = JSON.stringify(row); const pdf = await receivedReadingPdf(row);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-'); expect(JSON.stringify(row)).toBe(before);
  });
});
