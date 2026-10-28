import { describe, expect, it } from 'vitest';
import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import { buildInvoiceUbl } from './ubl';

describe('UBL Invoice', () => {
  it('conserva la unidad comercial de combustible y escapa texto', () => {
    const snapshot = {
      documentId: 'd1', documentTypeCode: '03', series: 'B001', number: '1', fullNumber: 'B001-1',
      issueDate: '2026-09-11T10:00:00-05:00', currencyCode: 'PEN', operationTypeCode: '0101',
      issuer: { identityType: '6', identityNumber: '20450819230', legalName: 'GRIFO SAN JOSE S.R.L.', ubigeo: '000000', establishmentCode: '0000' },
      customer: { identityType: '0', identityNumber: '-', legalName: 'CLIENTE VARIOS' },
      lines: [{ lineNumber: 1, description: 'Diesel & aditivo', unitCode: 'GLL', quantity: '2.500000', unitValue: '4.000000', unitPriceWithTax: '4.720000', taxAffectationCode: '10', igvRate: '18.00', lineExtensionAmount: '10.00', igvAmount: '1.80', totalAmount: '11.80' }],
      totals: { taxableAmount: '10.00', igvAmount: '1.80', payableAmount: '11.80' },
    } satisfies FiscalDocumentSnapshot;
    const result = buildInvoiceUbl(snapshot);
    expect(result).toContain('unitCode="GLL"');
    expect(result).toContain('Diesel &amp; aditivo');
    expect(result).toContain('<cbc:InvoiceTypeCode listID="0101">03</cbc:InvoiceTypeCode>');
  });
});
