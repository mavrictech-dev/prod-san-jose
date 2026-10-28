import { describe, expect, it } from 'vitest';
import {
  calculateSaleAdjustments, SaleAdjustmentError, validateSaleAdjustments,
  type InformationalDetractionInput, type SaleAdvanceInput, type SaleAdjustmentErrorCode,
  type SaleAdjustmentLineInput, type SaleAdjustmentsInput, type SaleTaxAffectationCode,
} from '../packages/sunat-core/src/sale-adjustments';
import { calculateTaxLine, parseDecimal } from '../packages/sunat-core/src/tax';
import { buildAdjustedInvoiceUbl } from '../packages/sunat-core/src/sale-adjustments-ubl';
import type { FiscalDocumentSnapshot } from '../packages/contracts/src/events';

// Pure synthetic fixtures. No DB, certs, network, emission, mail, or process setup.
const line = (overrides: Partial<SaleAdjustmentLineInput> = {}): SaleAdjustmentLineInput => ({
  id: 'item-1', quantity: '1', unitPriceWithTax: '118.00', taxAffectationCode: '10', igvRate: '18', ...overrides,
});
const sale = (overrides: Partial<SaleAdjustmentsInput> = {}): SaleAdjustmentsInput => ({
  environment: 'BETA', currencyCode: 'PEN', issueDate: '2026-10-02', lines: [line()], ...overrides,
});
const advance = (overrides: Partial<SaleAdvanceInput> = {}): SaleAdvanceInput => ({
  documentTypeCode: '01', series: 'FQ01', number: '1', issuerRuc: '00000000001',
  issueDate: '2026-09-30', currencyCode: 'PEN', taxAffectationCode: '10', baseAmount: '20.00', igvAmount: '3.60', ...overrides,
});
const detraction = (overrides: Partial<InformationalDetractionInput> = {}): InformationalDetractionInput => ({
  mode: 'INFORMATIONAL', operationTypeCode: '1001', goodsServiceCode: '037', percentage: '12',
  baseAmount: '118.00', rounding: 'CENT', ...overrides,
});
function snapshot(input: SaleAdjustmentsInput): FiscalDocumentSnapshot {
  const lines = input.lines.map((entry, index) => ({ lineNumber: index + 1, description: 'Ítem QA <&>', unitCode: 'NIU',
    quantity: entry.quantity, unitPriceWithTax: entry.unitPriceWithTax, igvRate: entry.igvRate,
    taxAffectationCode: entry.taxAffectationCode, ...calculateTaxLine(entry),
  }));
  const sum = (values: string[]) => values.reduce((total, value) => total + parseDecimal(value, 2), 0n);
  const fmt = (value: bigint) => `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
  return {
    documentId: 'local-fixture', environment: 'BETA', documentTypeCode: '01', series: 'FQ01', number: '1', fullNumber: 'FQ01-1',
    issueDate: `${input.issueDate}T16:00:00Z`, currencyCode: input.currencyCode, operationTypeCode: '0101',
    issuer: { identityType: '6', identityNumber: '00000000001', legalName: 'EMISOR <&> QA', ubigeo: '150101', establishmentCode: '0001' },
    customer: { identityType: '6', identityNumber: '00000000000', legalName: 'CLIENTE QA' }, lines,
    totals: { taxableAmount: fmt(sum(lines.filter(entry => entry.taxAffectationCode === '10').map(entry => entry.lineExtensionAmount))),
      igvAmount: fmt(sum(lines.map(entry => entry.igvAmount))), payableAmount: fmt(sum(lines.map(entry => entry.totalAmount))) },
  };
}
function rejected(input: unknown, code: SaleAdjustmentErrorCode, path?: string) {
  const result = validateSaleAdjustments(input);
  expect(result.valid).toBe(false);
  if (result.valid) throw new Error('Expected rejection');
  expect(result.issues).toHaveLength(1);
  expect(result.issues[0].code).toBe(code);
  if (path) expect(result.issues[0].path).toBe(path);
  expect(Object.hasOwn(result, 'result')).toBe(false);
  try {
    calculateSaleAdjustments(input as SaleAdjustmentsInput);
    throw new Error('Expected exception');
  } catch (error) {
    expect(error).toBeInstanceOf(SaleAdjustmentError);
    expect((error as SaleAdjustmentError).code).toBe(code);
  }
}

describe('BETA sale profiles and exact decimal arithmetic', () => {
  it('preserves the existing line arithmetic without adjustments', () => {
    const input = sale({ lines: [line({ quantity: '2.125', unitPriceWithTax: '33.333333' })] });
    const result = calculateSaleAdjustments(input);
    const original = calculateTaxLine(input.lines[0]);
    expect(result.lines[0]).toMatchObject({ lineExtensionAmount: original.lineExtensionAmount, igvAmount: original.igvAmount, totalAmount: original.totalAmount });
    expect(result.totals).toEqual({
      taxableAmount: original.lineExtensionAmount, exoneratedAmount: '0.00', inaffectedAmount: '0.00',
      igvAmount: original.igvAmount, totalBeforeAdvances: original.totalAmount,
      prepaidAmount: '0.00', nonTaxDiscountAmount: '0.00', payableAmount: original.totalAmount,
    });
    expect(result.globalDiscounts).toEqual([]); expect(result.advances).toEqual([]);
    expect(Object.hasOwn(result, 'detraction')).toBe(false);
  });
  it.each(['20', '30'] as const)('classifies %s separately with zero IGV', code => {
    const result = calculateSaleAdjustments(sale({ lines: [line({ taxAffectationCode: code, igvRate: '0', unitPriceWithTax: '100.00' })] }));
    expect(result.totals).toMatchObject({
      taxableAmount: '0.00', exoneratedAmount: code === '20' ? '100.00' : '0.00',
      inaffectedAmount: code === '30' ? '100.00' : '0.00', igvAmount: '0.00', payableAmount: '100.00',
    });
  });
  it.each(['PEN', 'USD'] as const)('supports explicit %s without FX', currencyCode => {
    expect(calculateSaleAdjustments(sale({ currencyCode })).currencyCode).toBe(currencyCode);
  });
  it('handles intermediate products beyond Number.MAX_SAFE_INTEGER exactly', () => {
    const input = sale({ lines: [line({ quantity: '1000000.000001', unitPriceWithTax: '100000.000001', igvRate: '0', taxAffectationCode: '30' })] });
    expect(calculateSaleAdjustments(input).totals.payableAmount).toBe('100000000001.10');
  });
  it('accepts the n(12,2) ceiling and rejects a sum above it', () => {
    const maximum = line({ taxAffectationCode: '20', igvRate: '0', unitPriceWithTax: '999999999999.99' });
    expect(calculateSaleAdjustments(sale({ lines: [maximum] })).totals.payableAmount).toBe('999999999999.99');
    rejected(sale({ lines: [maximum, line({ id: 'item-2' })] }), 'RANGE');
  });
  it('rounds quantity * price once, half up, without a binary float', () => {
    const result = calculateSaleAdjustments(sale({ lines: [line({ quantity: '0.1', unitPriceWithTax: '0.15', taxAffectationCode: '30', igvRate: '0' })] }));
    expect(result.totals.payableAmount).toBe('0.02');
  });
  it('rejects a rate outside the explicit current IGV18 pipeline', () => rejected(sale({ lines: [line({ igvRate: '10.50' })] }), 'IGV_RATE'));
});

describe('Line/global discounts and tax buckets', () => {
  it('reduces a taxable line base with 00, then the gross amount with 01', () => {
    const result = calculateSaleAdjustments(sale({ lines: [line({ discounts: [
      { reasonCode: '00', factor: '0.1', amount: '10' }, { reasonCode: '01', factor: '0.1', amount: '10.62' },
    ] })] }));
    expect(result.lines[0]).toMatchObject({ originalBaseAmount: '100.00', lineExtensionAmount: '90.00', igvAmount: '16.20', totalAmount: '106.20', payableAmount: '95.58' });
    expect(result.lines[0].discounts).toEqual([
      { reasonCode: '00', baseAmount: '100.00', factor: '0.10000', amount: '10.00', igvReductionAmount: '1.80' },
      { reasonCode: '01', baseAmount: '106.20', factor: '0.10000', amount: '10.62', igvReductionAmount: '0.00' },
    ]);
    expect(result.totals.nonTaxDiscountAmount).toBe('10.62');
  });
  it.each(['20', '30'] as const)('line 00 reduces the %s base without manufacturing IGV', code => {
    const result = calculateSaleAdjustments(sale({ lines: [line({ taxAffectationCode: code, igvRate: '0', unitPriceWithTax: '100', discounts: [{ reasonCode: '00', factor: '0.15' }] })] }));
    expect(result.totals[code === '20' ? 'exoneratedAmount' : 'inaffectedAmount']).toBe('85.00');
    expect(result.totals.igvAmount).toBe('0.00'); expect(result.totals.payableAmount).toBe('85.00');
  });
  it('global 02 targets only taxable 10 and global 03 leaves all bases/IGV intact', () => {
    const result = calculateSaleAdjustments(sale({
      lines: [line(), line({ id: 'ex', taxAffectationCode: '20', igvRate: '0', unitPriceWithTax: '100' }), line({ id: 'in', taxAffectationCode: '30', igvRate: '0', unitPriceWithTax: '50' })],
      globalDiscounts: [{ reasonCode: '02', factor: '0.1' }, { reasonCode: '03', factor: '0.1' }],
    }));
    expect(result.totals).toEqual({ taxableAmount: '90.00', exoneratedAmount: '100.00', inaffectedAmount: '50.00', igvAmount: '16.20', totalBeforeAdvances: '230.58', prepaidAmount: '0.00', nonTaxDiscountAmount: '25.62', payableAmount: '230.58' });
    expect(result.globalDiscounts).toEqual([
      { reasonCode: '02', baseAmount: '100.00', factor: '0.10000', amount: '10.00', igvReductionAmount: '1.80' },
      { reasonCode: '03', baseAmount: '256.20', factor: '0.10000', amount: '25.62', igvReductionAmount: '0.00' },
    ]);
    expect(result.lines[0].lineExtensionAmount).toBe('100.00');
  });
  it.each(['20', '30'] as const)('global 03 works on a %s-only profile, 02 fails closed', code => {
    const input = sale({ lines: [line({ taxAffectationCode: code, igvRate: '0', unitPriceWithTax: '100' })], globalDiscounts: [{ reasonCode: '03', factor: '0.1' }] });
    const result = calculateSaleAdjustments(input);
    expect(result.totals[code === '20' ? 'exoneratedAmount' : 'inaffectedAmount']).toBe('100.00');
    expect(result.totals.payableAmount).toBe('90.00');
    rejected({ ...input, globalDiscounts: [{ reasonCode: '02', factor: '0.1' }] }, 'DISCOUNT_CODE');
  });
  it('does not count line discounts again as global discounts', () => {
    const result = calculateSaleAdjustments(sale({ lines: [line({ discounts: [{ reasonCode: '00', factor: '0.1' }] })], globalDiscounts: [{ reasonCode: '02', factor: '0.1' }] }));
    expect(result.totals.taxableAmount).toBe('81.00'); expect(result.totals.igvAmount).toBe('14.58'); expect(result.totals.payableAmount).toBe('95.58');
  });
  it('handles a 100% base discount as zero net/tax/payable', () => {
    expect(calculateSaleAdjustments(sale({ globalDiscounts: [{ reasonCode: '02', factor: '1' }] })).totals).toMatchObject({ taxableAmount: '0.00', igvAmount: '0.00', payableAmount: '0.00' });
    expect(calculateSaleAdjustments(sale({ lines: [line({ discounts: [{ reasonCode: '00', factor: '1' }] })] })).totals.payableAmount).toBe('0.00');
  });
  it('rounds a half cent discount up and checks the asserted amount', () => {
    const input = sale({ lines: [line({ taxAffectationCode: '30', igvRate: '0', unitPriceWithTax: '0.05', discounts: [{ reasonCode: '00', factor: '0.1', amount: '0.01' }] })] });
    expect(calculateSaleAdjustments(input).totals.payableAmount).toBe('0.04');
    rejected(sale({ globalDiscounts: [{ reasonCode: '02', factor: '0.1', amount: '9.99' }] }), 'AMOUNT_MISMATCH');
  });
  it('rejects a rounded-zero discount', () => rejected(sale({ globalDiscounts: [{ reasonCode: '02', factor: '0.00001' }] }), 'RANGE'));
  it('rejects non-base discounts leaving a negative balance after a base discount', () => {
    rejected(sale({ lines: [line({ discounts: [{ reasonCode: '01', factor: '1' }] })], globalDiscounts: [{ reasonCode: '02', factor: '1' }, { reasonCode: '03', factor: '0.1' }] }), 'NEGATIVE_BALANCE');
  });
  it('rejects a rounding conflict that would increase IGV while discounting', () => {
    rejected(sale({ lines: [line({ unitPriceWithTax: '0.03' }), line({ id: 'item-2', unitPriceWithTax: '0.03' })], globalDiscounts: [{ reasonCode: '02', factor: '0.1' }] }), 'NEGATIVE_BALANCE');
  });
});

describe('Previously invoiced advances', () => {
  it('deducts gross advance once and carries catalog 12/53 references', () => {
    const result = calculateSaleAdjustments(sale({ advances: [advance()] }));
    expect(result.totals).toMatchObject({ taxableAmount: '80.00', igvAmount: '14.40', totalBeforeAdvances: '118.00', prepaidAmount: '23.60', payableAmount: '94.40' });
    expect(result.advances[0]).toMatchObject({ relatedDocumentCode: '02', allowanceReasonCode: '04', baseAmount: '20.00', igvAmount: '3.60', totalAmount: '23.60' });
    expect(result.globalDiscounts).toEqual([]);
  });
  it.each(['20', '30'] as const)('applies an advance to the matching %s bucket only', code => {
    const result = calculateSaleAdjustments(sale({ lines: [line({ taxAffectationCode: code, igvRate: '0', unitPriceWithTax: '100' })], advances: [advance({ documentTypeCode: '03', series: 'BQ01', taxAffectationCode: code, igvAmount: '0' })] }));
    expect(result.totals[code === '20' ? 'exoneratedAmount' : 'inaffectedAmount']).toBe('80.00');
    expect(result.totals).toMatchObject({ igvAmount: '0.00', prepaidAmount: '20.00', payableAmount: '80.00' });
    expect(result.advances[0]).toMatchObject({ relatedDocumentCode: '03', allowanceReasonCode: code === '20' ? '05' : '06' });
  });
  it('combines line/global discounts, all three advance bases and detraction', () => {
    const result = calculateSaleAdjustments(sale({
      lines: [line({ discounts: [{ reasonCode: '00', factor: '0.1' }] }), line({ id: 'ex', taxAffectationCode: '20', igvRate: '0', unitPriceWithTax: '100' }), line({ id: 'in', taxAffectationCode: '30', igvRate: '0', unitPriceWithTax: '50' })],
      globalDiscounts: [{ reasonCode: '02', factor: '0.1' }, { reasonCode: '03', factor: '0.1' }],
      advances: [advance(), advance({ number: '2', taxAffectationCode: '20', baseAmount: '10', igvAmount: '0' }), advance({ number: '3', taxAffectationCode: '30', baseAmount: '5', igvAmount: '0' })],
      detraction: detraction({ baseAmount: '221.02' }),
    }));
    expect(result.totals).toEqual({ taxableAmount: '61.00', exoneratedAmount: '90.00', inaffectedAmount: '45.00', igvAmount: '10.98', totalBeforeAdvances: '221.02', prepaidAmount: '38.60', nonTaxDiscountAmount: '24.56', payableAmount: '182.42' });
    expect(result.detraction?.amount).toBe('26.52');
    const t = result.totals;
    expect(parseDecimal(t.taxableAmount, 2) + parseDecimal(t.exoneratedAmount, 2) + parseDecimal(t.inaffectedAmount, 2) + parseDecimal(t.igvAmount, 2) - parseDecimal(t.nonTaxDiscountAmount, 2)).toBe(parseDecimal(t.payableAmount, 2));
  });
  it('accepts a full advance as zero payable', () => {
    expect(calculateSaleAdjustments(sale({ advances: [advance({ baseAmount: '100', igvAmount: '18' })] })).totals.payableAmount).toBe('0.00');
  });
  it.each([
    [advance({ baseAmount: '100.01', igvAmount: '18' }), 'ADVANCE_EXCEEDS_BASE'],
    [advance({ taxAffectationCode: '20', igvAmount: '0' }), 'ADVANCE_EXCEEDS_BASE'],
    [advance({ igvAmount: '3.59' }), 'AMOUNT_MISMATCH'],
    [advance({ currencyCode: 'USD' }), 'CURRENCY'],
    [advance({ issueDate: '2026-10-03' }), 'ADVANCE_REFERENCE'],
    [advance({ issueDate: '2026-02-30' }), 'DATE'],
    [advance({ baseAmount: '0' }), 'RANGE'],
    [advance({ series: 'BQ01' }), 'SHAPE'],
    [advance({ number: '01' }), 'SHAPE'],
    [advance({ issuerRuc: '123' }), 'SHAPE'],
  ] as const)('rejects invalid advance %#', (value, code) => rejected(sale({ advances: [value] }), code));
  it.each(['20', '30'] as const)('rejects IGV on a %s advance', code => {
    rejected(sale({ lines: [line({ taxAffectationCode: code, igvRate: '0', unitPriceWithTax: '100' })], advances: [advance({ taxAffectationCode: code, igvAmount: '1' })] }), 'AMOUNT_MISMATCH');
  });
  it('rejects duplicate document references and cumulative bucket overflow', () => {
    rejected(sale({ advances: [advance(), advance()] }), 'DUPLICATE');
    rejected(sale({ advances: [advance({ baseAmount: '60', igvAmount: '10.80' }), advance({ number: '2', baseAmount: '60', igvAmount: '10.80' })] }), 'ADVANCE_EXCEEDS_BASE');
  });
  it('checks advance coverage against the sale after non-base discounts', () => {
    rejected(sale({ globalDiscounts: [{ reasonCode: '03', factor: '0.9' }], advances: [advance()] }), 'NEGATIVE_BALANCE');
  });
});

describe('Explicit informational detraction', () => {
  it('requires a configured percentage and never changes tax/payable', () => {
    const plain = calculateSaleAdjustments(sale());
    const result = calculateSaleAdjustments(sale({ detraction: detraction({ amount: '14.16' }) }));
    expect(result.totals).toEqual(plain.totals);
    expect(result.detraction).toEqual({ ...detraction(), percentage: '12.00000', amount: '14.16', effectOnPayableAmount: '0.00' });
  });
  it('supports an explicit whole-sol rounding policy', () => {
    expect(calculateSaleAdjustments(sale({ detraction: detraction({ rounding: 'SOL', amount: '14' }) })).detraction?.amount).toBe('14.00');
    const result = calculateSaleAdjustments(sale({ lines: [line({ unitPriceWithTax: '125' })], detraction: detraction({ baseAmount: '125', percentage: '10', rounding: 'SOL' }) }));
    expect(result.detraction?.amount).toBe('13.00');
  });
  it('keeps the configured base before advances', () => {
    const result = calculateSaleAdjustments(sale({ advances: [advance()], detraction: detraction() }));
    expect(result.detraction?.baseAmount).toBe('118.00'); expect(result.detraction?.amount).toBe('14.16'); expect(result.totals.payableAmount).toBe('94.40');
    rejected(sale({ advances: [advance()], detraction: detraction({ baseAmount: '94.40' }) }), 'AMOUNT_MISMATCH');
  });
  it('can describe the catalog 035 exonerated case without adding IGV', () => {
    const result = calculateSaleAdjustments(sale({ lines: [line({ taxAffectationCode: '20', igvRate: '0', unitPriceWithTax: '100' })], detraction: detraction({ goodsServiceCode: '035', baseAmount: '100', percentage: '1.5' }) }));
    expect(result.detraction?.amount).toBe('1.50'); expect(result.totals.igvAmount).toBe('0.00');
  });
  it.each([
    [{ percentage: undefined }, 'REQUIRED_FIELD'], [{ rounding: undefined }, 'REQUIRED_FIELD'],
    [{ goodsServiceCode: '999' }, 'DETRACTION_CONFIG'], [{ goodsServiceCode: '37' }, 'DETRACTION_CONFIG'],
    [{ operationTypeCode: '1002' }, 'DETRACTION_CONFIG'], [{ operationTypeCode: '1004' }, 'DETRACTION_CONFIG'],
    [{ goodsServiceCode: '004' }, 'DETRACTION_CONFIG'], [{ mode: 'DEDUCT' }, 'DETRACTION_CONFIG'],
    [{ percentage: '0' }, 'RANGE'], [{ percentage: '100.00001' }, 'RANGE'],
    [{ percentage: '12.000001' }, 'DECIMAL'], [{ amount: '14.15' }, 'AMOUNT_MISMATCH'],
    [{ baseAmount: '100' }, 'AMOUNT_MISMATCH'], [{ deductFromPayable: true }, 'UNSUPPORTED_FIELD'],
    [{ bankAccount: 'synthetic' }, 'UNSUPPORTED_FIELD'],
  ] as const)('rejects unsupported detraction %#', (patch, code) => rejected({ ...sale(), detraction: { ...detraction(), ...patch } }, code));
  it('rejects FX and inferred applicability', () => {
    rejected(sale({ currencyCode: 'USD', detraction: detraction() }), 'DETRACTION_CONFIG');
    const result = calculateSaleAdjustments(sale({ lines: [line({ unitPriceWithTax: '1180' })] }));
    expect(Object.hasOwn(result, 'detraction')).toBe(false);
  });
});

describe('Fail-closed runtime validation', () => {
  it.each([undefined, null, [], 'BETA', 1, new Date(), Object.create({ environment: 'BETA' })])('rejects non-record %#', value => rejected(value, 'SHAPE'));
  it.each(['REAL', 'PRODUCTION', '', undefined])('requires explicit BETA %#', environment => rejected({ ...sale(), environment }, environment === undefined ? 'REQUIRED_FIELD' : 'BETA_ONLY'));
  it.each(['EUR', 'BRL', 'pen', 'XXX', 604])('rejects unsupported currency %#', currencyCode => rejected({ ...sale(), currencyCode }, 'CURRENCY'));
  it.each(['2026-02-30', '2025-02-29', '2026-13-01', '2026-10-02T00:00:00Z', '02/10/2026'])('rejects invalid date %s', issueDate => rejected(sale({ issueDate }), 'DATE'));
  it('accepts a real leap day', () => expect(validateSaleAdjustments(sale({ issueDate: '2024-02-29' })).valid).toBe(true));
  it.each(['', '-1', '-0', '+1', '01', '1e2', '1,00', ' 1', '1 ', 'NaN', 'Infinity', '.', '1.', '0.0000001', 1, null])('rejects decimal coercion/precision %#', quantity => {
    rejected({ ...sale(), lines: [{ ...line(), quantity }] }, 'DECIMAL', 'sale.lines[0].quantity');
  });
  it.each(['17', '21', '31', '40', '99', 10])('rejects unsupported affectation %#', taxAffectationCode => rejected({ ...sale(), lines: [{ ...line(), taxAffectationCode }] }, 'AFFECTATION'));
  it.each(['0', '100.01'])('rejects incompatible taxable rate %s', igvRate => rejected(sale({ lines: [line({ igvRate })] }), 'IGV_RATE'));
  it.each(['20', '30'] as const)('rejects a nonzero IGV rate on %s', taxAffectationCode => rejected(sale({ lines: [line({ taxAffectationCode })] }), 'IGV_RATE'));
  it('rejects mixed rates instead of allocating discounts across them', () => rejected(sale({ lines: [line(), line({ id: 'second', igvRate: '10.5' })] }), 'IGV_RATE'));
  it.each(['0', '0.000001'])('rejects zero or rounded-zero sale value %s', unitPriceWithTax => rejected(sale({ lines: [line({ unitPriceWithTax })] }), 'RANGE'));
  it.each(['0', '1.00001', '2'])('rejects out-of-range discount factor %s', factor => rejected(sale({ globalDiscounts: [{ reasonCode: '02', factor }] }), 'RANGE'));
  it.each(['0.123456', 0.1, '-0.1'])('rejects malformed discount factor %#', factor => rejected({ ...sale(), globalDiscounts: [{ reasonCode: '02', factor }] }, 'DECIMAL'));
  it.each([
    [{ lines: [{ ...line(), discounts: [{ reasonCode: '02', factor: '0.1' }] }] }, 'DISCOUNT_CODE'],
    [{ globalDiscounts: [{ reasonCode: '00', factor: '0.1' }] }, 'DISCOUNT_CODE'],
    [{ globalDiscounts: [{ reasonCode: '04', factor: '0.1' }] }, 'DISCOUNT_CODE'],
    [{ globalDiscounts: [{ reasonCode: '03', factor: '0.1' }, { reasonCode: '02', factor: '0.1' }] }, 'DISCOUNT_ORDER'],
    [{ globalDiscounts: [{ reasonCode: '02', factor: '0.1' }, { reasonCode: '02', factor: '0.1' }] }, 'DISCOUNT_ORDER'],
    [{ lines: [{ ...line(), discounts: [{ reasonCode: '01', factor: '0.1' }, { reasonCode: '00', factor: '0.1' }] }] }, 'DISCOUNT_ORDER'],
    [{ globalDiscounts: [{ reasonCode: '02', amount: '10' }] }, 'REQUIRED_FIELD'],
    [{ globalDiscounts: [{ reasonCode: '02', factor: '0.1', amount: '10.001' }] }, 'DECIMAL'],
    [{ advances: [{ ...advance(), documentTypeCode: '07' }] }, 'ADVANCE_REFERENCE'],
  ] as const)('rejects unsupported adjustment %#', (patch, code) => rejected({ ...sale(), ...patch }, code));
  it.each(['isc', 'iscRate', 'paymentTerms', 'historicalSnapshot', 'operationTypeCode'])('rejects unknown root %s even when undefined', field => rejected({ ...sale(), [field]: undefined }, 'UNSUPPORTED_FIELD'));
  it('rejects unknown fields at every nested level', () => {
    rejected({ ...sale(), lines: [{ ...line(), iscAmount: '0' }] }, 'UNSUPPORTED_FIELD');
    rejected({ ...sale(), lines: [{ ...line(), discounts: [{ reasonCode: '00', factor: '0.1', baseAmount: '100' }] }] }, 'UNSUPPORTED_FIELD');
    rejected({ ...sale(), globalDiscounts: [{ reasonCode: '02', factor: '0.1', taxAffectationCode: '20' }] }, 'UNSUPPORTED_FIELD');
    rejected({ ...sale(), advances: [{ ...advance(), paidAmount: '23.60' }] }, 'UNSUPPORTED_FIELD');
  });
  it('rejects missing fields, explicit undefined and duplicate IDs', () => {
    const { igvRate: unused, ...missingRate } = line();
    rejected({ ...sale(), lines: [missingRate] }, 'REQUIRED_FIELD');
    rejected({ ...sale(), advances: undefined }, 'REQUIRED_FIELD');
    rejected(sale({ lines: [line(), line()] }), 'DUPLICATE');
    rejected(sale({ lines: [] }), 'RANGE');
  });
  it('rejects sparse/decorated arrays and accessor records without invoking getters', () => {
    rejected({ ...sale(), lines: new Array(1) }, 'SHAPE');
    const decorated = Object.assign([line()], { ignored: true });
    rejected({ ...sale(), lines: decorated }, 'SHAPE');
    const accessor = { ...sale() };
    Object.defineProperty(accessor, 'environment', { enumerable: true, get() { throw new Error('Must not execute'); } });
    rejected(accessor, 'SHAPE');
    rejected({ ...sale(), [Symbol('hidden')]: true }, 'UNSUPPORTED_FIELD');
  });
  it('rejects list limits', () => {
    rejected(sale({ lines: Array.from({ length: 501 }, (_, i) => line({ id: `item-${i}` })) }), 'RANGE');
    rejected(sale({ advances: Array.from({ length: 100 }, (_, i) => advance({ number: `${i + 1}` })) }), 'RANGE');
  });
});

describe('Integration boundary and historical isolation', () => {
  it('projects an explicit profile into a new snapshot without double deductions', () => {
    const draft = { documentId: 'fixture-only', lines: [{ description: 'Local fixture', unitCode: 'NIU', ...line() }], totals: { taxableAmount: '100.00', igvAmount: '18.00', payableAmount: '118.00' } };
    const before = structuredClone(draft);
    const result = calculateSaleAdjustments(sale({ lines: draft.lines.map(({ description, unitCode, ...input }) => input), advances: [advance()] }));
    const adjusted = { ...draft, lines: draft.lines.map((source, index) => ({ ...source,
      lineExtensionAmount: result.lines[index].lineExtensionAmount, igvAmount: result.lines[index].igvAmount,
      totalAmount: result.lines[index].totalAmount,
    })), totals: { taxableAmount: result.totals.taxableAmount, igvAmount: result.totals.igvAmount,
      payableAmount: result.totals.payableAmount }, saleAdjustments: { input: sale({ advances: [advance()] }), result } };
    expect(adjusted.totals).toEqual({ taxableAmount: '80.00', igvAmount: '14.40', payableAmount: '94.40' });
    expect(adjusted.lines[0].description).toBe('Local fixture');
    expect(draft).toEqual(before);
  });
  it('does not mutate frozen input or reuse nested arrays from callers', () => {
    const input = sale({ lines: [line({ discounts: [{ reasonCode: '00', factor: '0.1' }] })], advances: [advance()] });
    const before = structuredClone(input);
    const freeze = (value: unknown): void => {
      if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    };
    freeze(input);
    const validation = validateSaleAdjustments(input);
    expect(validation.valid).toBe(true);
    const result = calculateSaleAdjustments(input);
    result.lines[0].discounts[0].amount = '999'; result.advances[0].baseAmount = '999';
    expect(input).toEqual(before);
  });
  it.each(['10', '20', '30'] as const)('reconciles cent-level results across many local %s fixtures', taxAffectationCode => {
    for (let i = 1; i <= 120; i++) {
      const input = sale({ lines: [line({ taxAffectationCode, igvRate: taxAffectationCode === '10' ? '18' : '0', unitPriceWithTax: `${i}.37`, discounts: [{ reasonCode: '00', factor: '0.12345' }] })], globalDiscounts: [{ reasonCode: '03', factor: '0.07' }] });
      const result = calculateSaleAdjustments(input), t = result.totals;
      const cents = (value: string) => parseDecimal(value, 2);
      expect(cents(t.taxableAmount) + cents(t.exoneratedAmount) + cents(t.inaffectedAmount) + cents(t.igvAmount) - cents(t.nonTaxDiscountAmount)).toBe(cents(t.payableAmount));
      expect(cents(t.totalBeforeAdvances) - cents(t.prepaidAmount)).toBe(cents(t.payableAmount));
      expect(cents(t.payableAmount)).toBeGreaterThanOrEqual(0n);
    }
  });
});

describe('Explicit adjusted Invoice UBL boundary', () => {
  it.each(['PEN', 'USD'] as const)('builds an unsigned %s Invoice with line and global discounts', currencyCode => {
    const input = sale({ currencyCode, lines: [line({ id: '1', discounts: [{ reasonCode: '00', factor: '0.1' }, { reasonCode: '01', factor: '0.1' }] })], globalDiscounts: [{ reasonCode: '02', factor: '0.1' }, { reasonCode: '03', factor: '0.1' }] });
    const base = snapshot(input), before = structuredClone(base), result = calculateSaleAdjustments(input);
    const output = buildAdjustedInvoiceUbl(base, { input, result });
    expect(output).toContain('<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"');
    expect(output).toContain('Ítem QA &lt;&amp;&gt;'); expect(output).toContain('EMISOR &lt;&amp;&gt; QA');
    expect(output.match(/<cac:AllowanceCharge>/g)).toHaveLength(4);
    expect(output).toContain(`currencyID="${currencyCode}"`);
    expect(output).toContain(`<cbc:PayableAmount currencyID="${currencyCode}">${result.totals.payableAmount}</cbc:PayableAmount>`);
    expect(output).toContain('<cbc:Name>IGV</cbc:Name>'); expect(output).not.toContain('ds:Signature');
    expect(output).not.toContain('FormaPago'); expect(base).toEqual(before);
    expect(buildAdjustedInvoiceUbl(base, input)).toBe(output);
  });
  it('builds a mixed 10/20/30 Invoice with official catalog 05 tax schemes', () => {
    const input = sale({ lines: [line({ id: '1' }), line({ id: '2', taxAffectationCode: '20', igvRate: '0', unitPriceWithTax: '100' }), line({ id: '3', taxAffectationCode: '30', igvRate: '0', unitPriceWithTax: '50' })], globalDiscounts: [{ reasonCode: '02', factor: '0.1' }] });
    const output = buildAdjustedInvoiceUbl(snapshot(input), input);
    expect(output).toContain('>9997</cbc:ID><cbc:Name>EXO</cbc:Name><cbc:TaxTypeCode>VAT');
    expect(output).toContain('>9998</cbc:ID><cbc:Name>INA</cbc:Name><cbc:TaxTypeCode>FRE');
    expect(output.match(/<cac:TaxSubtotal>/g)).toHaveLength(6); // Three document buckets + three lines.
    expect(output).toContain('<cbc:PayableAmount currencyID="PEN">256.20</cbc:PayableAmount>');
    expect(output).toContain('<cbc:LineExtensionAmount currencyID="PEN">240.00</cbc:LineExtensionAmount>');
  });
  it.each(['20', '30'] as const)('serializes a %s-only boleta with zero IGV and explicit Contado', code => {
    const input = sale({ lines: [line({ id: '1', taxAffectationCode: code, igvRate: '0', unitPriceWithTax: '100' })] });
    const base = snapshot(input); base.documentTypeCode = '03'; base.series = 'BQ01'; base.fullNumber = 'BQ01-1';
    base.customer = { identityType: '0', identityNumber: '0', legalName: 'CLIENTE QA' }; base.paymentTerms = { type: 'CONTADO' };
    const output = buildAdjustedInvoiceUbl(base, input);
    expect(output).toContain('>03</cbc:InvoiceTypeCode>'); expect(output).toContain('<cbc:PaymentMeansID>Contado');
    expect(output).not.toContain('>1000</cbc:ID>'); expect(output).toContain('<cbc:TaxAmount currencyID="PEN">0.00');
  });
  it('rejects advance Invoice XML instead of guessing the modern totals relationship', () => {
    const input = sale({ lines: [line({ id: '1' })], advances: [advance()] });
    expect(calculateSaleAdjustments(input).advances[0].allowanceReasonCode).toBe('04');
    expect(() => buildAdjustedInvoiceUbl(snapshot(input), input)).toThrow(/UBL_PROFILE.*Advance Invoice serialization/);
  });
  it('keeps configured detraction informational and does not invent SPOT XML', () => {
    const input = sale({ lines: [line({ id: '1' })], detraction: detraction() });
    const output = buildAdjustedInvoiceUbl(snapshot(input), input);
    expect(output).not.toContain('Detraccion'); expect(output).not.toContain('2006');
    expect(output).toContain('<cbc:PayableAmount currencyID="PEN">118.00');
  });
  it('rejects stale/tampered results and already-adjusted snapshots', () => {
    const input = sale({ lines: [line({ id: '1' })], globalDiscounts: [{ reasonCode: '02', factor: '0.1' }] });
    const base = snapshot(input), result = calculateSaleAdjustments(input);
    result.totals.payableAmount = '1.00';
    expect(() => buildAdjustedInvoiceUbl(base, { input, result })).toThrow('RESULT_MISMATCH');
    base.totals.payableAmount = '106.20';
    expect(() => buildAdjustedInvoiceUbl(base, input)).toThrow('SNAPSHOT_MISMATCH');
  });
  it.each([
    ['environment', 'PRODUCTION'], ['environment', undefined], ['operationTypeCode', '1001'], ['documentTypeCode', '07'],
    ['fullNumber', 'FQ01-2'], ['currencyCode', 'USD'], ['issueDate', '2026-10-03T16:00:00Z'],
    ['paymentTerms', { type: 'CREDITO', currencyCode: 'PEN', pendingAmount: '118', installments: [{ amount: '118', dueDate: '2026-10-03' }] }],
    ['secret', 'fixture-private'],
  ])('rejects unsupported/stale snapshot field %s', (key, value) => {
    const input = sale({ lines: [line({ id: '1' })] });
    expect(() => buildAdjustedInvoiceUbl({ ...snapshot(input), [key]: value } as FiscalDocumentSnapshot, input)).toThrow();
  });
  it('rejects XML control text, unit codes, binding mismatches and unexpected nested fields', () => {
    const input = sale({ lines: [line({ id: '1' })] });
    for (const patch of [{ description: '\u0000' }, { unitCode: 'BAD' }, { quantity: '2' }, { lineNumber: 2 }, { iscAmount: '1' }]) {
      const base = snapshot(input); Object.assign(base.lines[0], patch);
      expect(() => buildAdjustedInvoiceUbl(base, input)).toThrow();
    }
    expect(() => buildAdjustedInvoiceUbl(snapshot(input), sale())).toThrow('Line number/id/affectation mismatch');
  });
  it('uses the Lima calendar day of the base snapshot', () => {
    const input = sale({ issueDate: '2026-10-01', lines: [line({ id: '1' })] });
    const base = snapshot(input); base.issueDate = '2026-10-02T02:00:00Z';
    expect(buildAdjustedInvoiceUbl(base, input)).toContain('<cbc:IssueDate>2026-10-01');
  });
});
