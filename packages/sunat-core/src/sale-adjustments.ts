import { calculateTaxLine, formatScaled, parseDecimal, roundDivide } from './tax';

/**
 * Pure, opt-in BETA calculation. Import this module directly; no snapshot/UBL hooks.
 * Decimal strings only. Money: n(12,2); quantity/price: at most 6 decimals;
 * discount factors: (0,1], at most 5 decimals; percentages are NOT factors.
 * SUNAT sources, processing order and unsupported cases: docs/REGLAS_AJUSTES_BETA.md.
 */
export type SaleTaxAffectationCode = '10' | '20' | '30';
export type SaleCurrencyCode = 'PEN' | 'USD';

interface DiscountValueInput {
  /** e.g. "0.10" = 10%. Required; never inferred from an amount. */
  factor: string;
  /** Optional assertion, must equal the rounded base * factor exactly. */
  amount?: string;
}
export interface LineDiscountInput extends DiscountValueInput {
  reasonCode: '00' | '01';
}
export interface GlobalDiscountInput extends DiscountValueInput {
  /** 02 targets only the taxable 10 bucket; 03 targets the remaining sale total. */
  reasonCode: '02' | '03';
}
export interface SaleAdjustmentLineInput {
  id: string;
  quantity: string;
  unitPriceWithTax: string;
  taxAffectationCode: SaleTaxAffectationCode;
  /** Explicit percentage: exactly 18 for 10, exactly zero for 20/30. */
  igvRate: string;
  /** At most one of each reason, in order 00 then 01. */
  discounts?: readonly LineDiscountInput[];
}
export interface SaleAdvanceInput {
  documentTypeCode: '01' | '03';
  series: string;
  number: string;
  issuerRuc: string;
  issueDate: string;
  currencyCode: SaleCurrencyCode;
  taxAffectationCode: SaleTaxAffectationCode;
  /** Previously invoiced base and IGV, not a new commercial discount. */
  baseAmount: string;
  igvAmount: string;
}
export interface InformationalDetractionInput {
  mode: 'INFORMATIONAL';
  /** Only the general operation is supported; transport/hydrobiology need extra data. */
  operationTypeCode: '1001';
  goodsServiceCode: string;
  /** Required configuration; no catalog percentage or legal threshold is inferred. */
  percentage: string;
  /** Must equal the sale total before advances. Only PEN, no FX assumptions. */
  baseAmount: string;
  rounding: 'CENT' | 'SOL';
  amount?: string;
}
export interface SaleAdjustmentsInput {
  environment: 'BETA';
  currencyCode: SaleCurrencyCode;
  issueDate: string;
  lines: readonly SaleAdjustmentLineInput[];
  globalDiscounts?: readonly GlobalDiscountInput[];
  advances?: readonly SaleAdvanceInput[];
  detraction?: InformationalDetractionInput;
}
export interface SaleDiscountResult {
  reasonCode: '00' | '01' | '02' | '03';
  baseAmount: string;
  factor: string;
  amount: string;
  igvReductionAmount: string;
}
export interface SaleAdjustmentLineResult {
  id: string;
  taxAffectationCode: SaleTaxAffectationCode;
  igvRate: string;
  originalBaseAmount: string;
  /** Amounts here include line adjustments only, never global discounts/advances. */
  lineExtensionAmount: string;
  igvAmount: string;
  totalAmount: string;
  nonTaxDiscountAmount: string;
  payableAmount: string;
  discounts: SaleDiscountResult[];
}
export interface SaleAdvanceResult extends SaleAdvanceInput {
  relatedDocumentCode: '02' | '03';
  allowanceReasonCode: '04' | '05' | '06';
  totalAmount: string;
}
export interface InformationalDetractionResult extends InformationalDetractionInput {
  amount: string;
  effectOnPayableAmount: '0.00';
}
export interface SaleAdjustmentsResult {
  environment: 'BETA';
  currencyCode: SaleCurrencyCode;
  issueDate: string;
  lines: SaleAdjustmentLineResult[];
  globalDiscounts: SaleDiscountResult[];
  advances: SaleAdvanceResult[];
  totals: {
    /** Remaining bases/IGV after base discounts and advances. */
    taxableAmount: string;
    exoneratedAmount: string;
    inaffectedAmount: string;
    igvAmount: string;
    /** Commercial sale after all discounts, before deducting advances. */
    totalBeforeAdvances: string;
    prepaidAmount: string;
    /** Only reasons 01/03. Reasons 00/02 already reduced bases. */
    nonTaxDiscountAmount: string;
    /** totalBeforeAdvances - prepaidAmount; detraction never changes this. */
    payableAmount: string;
  };
  detraction?: InformationalDetractionResult;
}
export type SaleAdjustmentErrorCode =
  | 'SHAPE' | 'UNSUPPORTED_FIELD' | 'REQUIRED_FIELD' | 'BETA_ONLY'
  | 'DECIMAL' | 'RANGE' | 'CURRENCY' | 'DATE' | 'AFFECTATION'
  | 'IGV_RATE' | 'MIXED_IGV_RATES' | 'DISCOUNT_CODE' | 'DISCOUNT_ORDER'
  | 'AMOUNT_MISMATCH' | 'DUPLICATE' | 'ADVANCE_REFERENCE'
  | 'ADVANCE_EXCEEDS_BASE' | 'NEGATIVE_BALANCE' | 'DETRACTION_CONFIG'
  | 'UBL_PROFILE' | 'SNAPSHOT_MISMATCH' | 'RESULT_MISMATCH';
export interface SaleAdjustmentIssue { code: SaleAdjustmentErrorCode; path: string; message: string }
export class SaleAdjustmentError extends Error {
  constructor(readonly code: SaleAdjustmentErrorCode, readonly path: string, message: string) {
    super(`${code} at ${path}: ${message}`);
    this.name = 'SaleAdjustmentError';
  }
}
export type SaleAdjustmentsValidationResult =
  | { valid: true; result: SaleAdjustmentsResult }
  | { valid: false; issues: SaleAdjustmentIssue[] };

const MAX_CENTS = 99_999_999_999_999n;
const FACTOR_SCALE = 100_000n;
const RATE_SCALE = 10_000n; // Percentage at 2 decimals divided by 100.
const AFFECTATIONS = ['10', '20', '30'] as const;
// Conservative subset: SUNAT orientation, Anexo IV, consulted 2026-10-02.
// No rates attached. Specialized transport/hydrobiology are intentionally excluded.
const GENERAL_DETRACTION_CODES = new Set([
  '001', '003', '005', '007', '008', '009', '010', '011', '012', '013',
  '014', '015', '016', '017', '019', '020', '021', '022', '023', '024',
  '025', '030', '031', '032', '034', '035', '036', '037', '039', '040',
  '041', '044', '045',
]);
type RecordValue = Record<string, unknown>;
const money = (value: bigint) => formatScaled(value, 2);
function fail(code: SaleAdjustmentErrorCode, path: string, message: string): never {
  throw new SaleAdjustmentError(code, path, message);
}
function object(value: unknown, path: string, required: string[], optional: string[] = []): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail('SHAPE', path, 'Expected a plain record');
  }
  const record = value as RecordValue;
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string' || ![...required, ...optional].includes(key)) {
      fail('UNSUPPORTED_FIELD', path, `Unsupported field ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key)!;
    if (!('value' in descriptor) || !descriptor.enumerable) fail('SHAPE', path, 'Expected plain data');
    if (descriptor.value === undefined) fail('REQUIRED_FIELD', `${path}.${key}`, 'Explicit undefined is not supported');
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) fail('REQUIRED_FIELD', `${path}.${key}`, 'Required field');
  }
  return record;
}
function list(value: unknown, path: string, max: number, min = 0): unknown[] {
  if (!Array.isArray(value)) fail('SHAPE', path, 'Expected an array');
  if (value.length < min || value.length > max) fail('RANGE', path, `Expected ${min}..${max} entries`);
  if (Reflect.ownKeys(value).length !== value.length + 1) fail('SHAPE', path, 'Expected a dense plain array');
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('SHAPE', path, 'Expected a dense plain array');
  }
  return value;
}
function decimal(value: unknown, path: string, scale: number, integerDigits: number): bigint {
  if (typeof value !== 'string' || value.length > integerDigits + scale + 1
    || !new RegExp(`^(0|[1-9][0-9]{0,${integerDigits - 1}})(\\.[0-9]{1,${scale}})?$`).test(value)) {
    fail('DECIMAL', path, `Expected an unsigned decimal string, <= ${integerDigits} integer / ${scale} fractional digits`);
  }
  return parseDecimal(value, scale);
}
function cents(value: unknown, path: string, positive = false): bigint {
  const amount = decimal(value, path, 2, 12);
  if (positive && amount === 0n) fail('RANGE', path, 'Expected a positive amount');
  return amount;
}
function checkedMoney(value: bigint, path: string): string {
  if (value < 0n) fail('NEGATIVE_BALANCE', path, 'Negative amount');
  if (value > MAX_CENTS) fail('RANGE', path, 'Money exceeds n(12,2)');
  return money(value);
}
function currency(value: unknown, path: string): SaleCurrencyCode {
  if (value !== 'PEN' && value !== 'USD') fail('CURRENCY', path, 'Only PEN/USD supported by the BETA pipeline');
  return value;
}
function affectation(value: unknown, path: string): SaleTaxAffectationCode {
  if (value !== '10' && value !== '20' && value !== '30') fail('AFFECTATION', path, 'Only onerous 10/20/30 supported');
  return value;
}
function date(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || value < '1900-01-01' || value > '9999-12-31') fail('DATE', path, 'Expected YYYY-MM-DD');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('DATE', path, 'Invalid calendar date');
  return value;
}
function text(value: unknown, path: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) fail('SHAPE', path, 'Invalid identifier');
  return value;
}
function discounts(value: unknown, path: string, codes: readonly string[]): RecordValue[] {
  const rows = list(value, path, 2);
  let previous = -1;
  return rows.map((entry, index) => {
    const at = `${path}[${index}]`;
    const row = object(entry, at, ['reasonCode', 'factor'], ['amount']);
    const rank = codes.indexOf(row.reasonCode as string);
    if (rank < 0) fail('DISCOUNT_CODE', `${at}.reasonCode`, 'Unsupported discount reason at this level');
    if (rank <= previous) fail('DISCOUNT_ORDER', at, 'Reasons must be unique and base discounts must come first');
    previous = rank;
    return row;
  });
}
function discount(row: RecordValue, base: bigint, path: string): { amount: bigint; result: SaleDiscountResult } {
  checkedMoney(base, `${path}.baseAmount`);
  const factor = decimal(row.factor, `${path}.factor`, 5, 1);
  if (factor === 0n || factor > FACTOR_SCALE) fail('RANGE', `${path}.factor`, 'Factor must be in (0,1]');
  const amount = roundDivide(base * factor, FACTOR_SCALE);
  if (amount === 0n) fail('RANGE', path, 'Discount must round to a positive cent');
  if (Object.hasOwn(row, 'amount') && cents(row.amount, `${path}.amount`) !== amount) {
    fail('AMOUNT_MISMATCH', `${path}.amount`, 'Amount must equal rounded base * factor');
  }
  return { amount, result: {
    reasonCode: row.reasonCode as SaleDiscountResult['reasonCode'],
    baseAmount: checkedMoney(base, `${path}.baseAmount`), factor: formatScaled(factor, 5),
    amount: checkedMoney(amount, `${path}.amount`), igvReductionAmount: '0.00',
  } };
}

/** Throws SaleAdjustmentError on the first invalid input; never mutates the input. */
export function calculateSaleAdjustments(input: SaleAdjustmentsInput): SaleAdjustmentsResult {
  const root = object(input, 'sale', ['environment', 'currencyCode', 'issueDate', 'lines'], ['globalDiscounts', 'advances', 'detraction']);
  if (root.environment !== 'BETA') fail('BETA_ONLY', 'sale.environment', 'Explicit BETA required');
  const currencyCode = currency(root.currencyCode, 'sale.currencyCode');
  const issueDate = date(root.issueDate, 'sale.issueDate');
  const bases: Record<SaleTaxAffectationCode, bigint> = { '10': 0n, '20': 0n, '30': 0n };
  let igv = 0n, nonTaxDiscount = 0n;
  let taxableRate: bigint | undefined;
  const ids = new Set<string>();
  const lines = list(root.lines, 'sale.lines', 500, 1).map((entry, index): SaleAdjustmentLineResult => {
    const at = `sale.lines[${index}]`;
    const row = object(entry, at, ['id', 'quantity', 'unitPriceWithTax', 'taxAffectationCode', 'igvRate'], ['discounts']);
    const id = text(row.id, `${at}.id`, /^[A-Za-z0-9_-]{1,64}$/);
    if (ids.has(id)) fail('DUPLICATE', `${at}.id`, 'Duplicate line');
    ids.add(id);
    const code = affectation(row.taxAffectationCode, `${at}.taxAffectationCode`);
    const quantity = decimal(row.quantity, `${at}.quantity`, 6, 12);
    const price = decimal(row.unitPriceWithTax, `${at}.unitPriceWithTax`, 6, 12);
    if (quantity === 0n || price === 0n) fail('RANGE', at, 'Quantity and price must be positive');
    const rate = decimal(row.igvRate, `${at}.igvRate`, 2, 3);
    if (code === '10' ? rate !== 1_800n : rate !== 0n) fail('IGV_RATE', `${at}.igvRate`, 'BETA requires IGV 18 for 10, zero for 20/30');
    if (code === '10') {
      if (taxableRate !== undefined && taxableRate !== rate) fail('MIXED_IGV_RATES', `${at}.igvRate`, 'One explicit taxable rate per BETA profile');
      taxableRate = rate;
    }
    const original = calculateTaxLine({ quantity: row.quantity as string, unitPriceWithTax: row.unitPriceWithTax as string, igvRate: row.igvRate as string });
    let base = cents(original.lineExtensionAmount, `${at}.lineExtensionAmount`);
    let tax = cents(original.igvAmount, `${at}.igvAmount`);
    const originalBaseAmount = money(base);
    checkedMoney(base + tax, `${at}.totalAmount`);
    if (base + tax === 0n) fail('RANGE', `${at}.totalAmount`, 'Line must round to a positive cent');
    let other = 0n;
    const applied = (Object.hasOwn(row, 'discounts') ? discounts(row.discounts, `${at}.discounts`, ['00', '01']) : [])
      .map((item, i) => {
        const path = `${at}.discounts[${i}]`;
        const adjustment = discount(item, item.reasonCode === '00' ? base : base + tax, path);
        if (item.reasonCode === '00') {
          base -= adjustment.amount;
          const newTax = roundDivide(base * rate, RATE_SCALE);
          adjustment.result.igvReductionAmount = checkedMoney(tax - newTax, `${path}.igvReductionAmount`);
          tax = newTax;
        } else other = adjustment.amount;
        return adjustment.result;
      });
    bases[code] += base; igv += tax; nonTaxDiscount += other;
    return { id, taxAffectationCode: code, igvRate: formatScaled(rate, 2), originalBaseAmount,
      lineExtensionAmount: money(base), igvAmount: money(tax), totalAmount: money(base + tax),
      nonTaxDiscountAmount: money(other), payableAmount: checkedMoney(base + tax - other, `${at}.payableAmount`), discounts: applied };
  });
  const baseTotal = () => bases['10'] + bases['20'] + bases['30'];
  const globalDiscounts = (Object.hasOwn(root, 'globalDiscounts') ? discounts(root.globalDiscounts, 'sale.globalDiscounts', ['02', '03']) : [])
    .map((row, index) => {
      const at = `sale.globalDiscounts[${index}]`;
      const taxable = row.reasonCode === '02';
      if (taxable && (taxableRate === undefined || bases['10'] === 0n)) fail('DISCOUNT_CODE', at, '02 requires a positive taxable 10 base');
      const adjustment = discount(row, taxable ? bases['10'] : baseTotal() + igv - nonTaxDiscount, at);
      if (taxable) {
        bases['10'] -= adjustment.amount;
        const newIgv = roundDivide(bases['10'] * taxableRate!, RATE_SCALE);
        adjustment.result.igvReductionAmount = checkedMoney(igv - newIgv, `${at}.igvReductionAmount`);
        igv = newIgv;
      } else nonTaxDiscount += adjustment.amount;
      return adjustment.result;
    });
  const totalBeforeAdvances = baseTotal() + igv - nonTaxDiscount;
  checkedMoney(totalBeforeAdvances, 'sale.totals.totalBeforeAdvances');
  const references = new Set<string>();
  let prepaid = 0n;
  const advances = (Object.hasOwn(root, 'advances') ? list(root.advances, 'sale.advances', 99) : [])
    .map((entry, index): SaleAdvanceResult => {
      const at = `sale.advances[${index}]`;
      const row = object(entry, at, ['documentTypeCode', 'series', 'number', 'issuerRuc', 'issueDate', 'currencyCode', 'taxAffectationCode', 'baseAmount', 'igvAmount']);
      if (row.documentTypeCode !== '01' && row.documentTypeCode !== '03') fail('ADVANCE_REFERENCE', `${at}.documentTypeCode`, 'Only invoice/receipt references');
      const series = text(row.series, `${at}.series`, row.documentTypeCode === '01' ? /^F[A-Z0-9]{3}$/ : /^B[A-Z0-9]{3}$/);
      const number = text(row.number, `${at}.number`, /^[1-9][0-9]{0,7}$/);
      const issuerRuc = text(row.issuerRuc, `${at}.issuerRuc`, /^[0-9]{11}$/);
      const advanceDate = date(row.issueDate, `${at}.issueDate`);
      if (advanceDate > issueDate) fail('ADVANCE_REFERENCE', `${at}.issueDate`, 'Future advance reference');
      if (currency(row.currencyCode, `${at}.currencyCode`) !== currencyCode) fail('CURRENCY', `${at}.currencyCode`, 'Advance currency mismatch');
      const key = `${issuerRuc}/${row.documentTypeCode}/${series}/${number}`;
      if (references.has(key)) fail('DUPLICATE', at, 'Advance document used twice');
      references.add(key);
      const code = affectation(row.taxAffectationCode, `${at}.taxAffectationCode`);
      const base = cents(row.baseAmount, `${at}.baseAmount`, true);
      const tax = cents(row.igvAmount, `${at}.igvAmount`);
      if (base > bases[code]) fail('ADVANCE_EXCEEDS_BASE', `${at}.baseAmount`, 'Advance exceeds its remaining affectation bucket');
      const expectedIgv = code === '10' ? roundDivide(base * taxableRate!, RATE_SCALE) : 0n;
      if (tax !== expectedIgv) fail('AMOUNT_MISMATCH', `${at}.igvAmount`, 'Advance IGV inconsistent with its base/rate');
      bases[code] -= base; igv -= tax; prepaid += base + tax;
      checkedMoney(igv, `${at}.igvAmount`);
      checkedMoney(totalBeforeAdvances - prepaid, `${at}.totalAmount`);
      return { documentTypeCode: row.documentTypeCode, series, number, issuerRuc, issueDate: advanceDate, currencyCode,
        taxAffectationCode: code, baseAmount: money(base), igvAmount: money(tax),
        relatedDocumentCode: row.documentTypeCode === '01' ? '02' : '03',
        allowanceReasonCode: code === '10' ? '04' : code === '20' ? '05' : '06', totalAmount: checkedMoney(base + tax, `${at}.totalAmount`) };
    });
  const totals: SaleAdjustmentsResult['totals'] = {
    taxableAmount: checkedMoney(bases['10'], 'sale.totals.taxableAmount'),
    exoneratedAmount: checkedMoney(bases['20'], 'sale.totals.exoneratedAmount'),
    inaffectedAmount: checkedMoney(bases['30'], 'sale.totals.inaffectedAmount'),
    igvAmount: checkedMoney(igv, 'sale.totals.igvAmount'), totalBeforeAdvances: money(totalBeforeAdvances),
    prepaidAmount: checkedMoney(prepaid, 'sale.totals.prepaidAmount'),
    nonTaxDiscountAmount: checkedMoney(nonTaxDiscount, 'sale.totals.nonTaxDiscountAmount'),
    payableAmount: checkedMoney(totalBeforeAdvances - prepaid, 'sale.totals.payableAmount'),
  };
  const result: SaleAdjustmentsResult = { environment: 'BETA', currencyCode, issueDate, lines, globalDiscounts, advances, totals };
  if (Object.hasOwn(root, 'detraction')) {
    const at = 'sale.detraction';
    const row = object(root.detraction, at, ['mode', 'operationTypeCode', 'goodsServiceCode', 'percentage', 'baseAmount', 'rounding'], ['amount']);
    if (row.mode !== 'INFORMATIONAL' || row.operationTypeCode !== '1001' || currencyCode !== 'PEN'
      || typeof row.goodsServiceCode !== 'string' || !GENERAL_DETRACTION_CODES.has(row.goodsServiceCode)
      || (row.rounding !== 'CENT' && row.rounding !== 'SOL')) fail('DETRACTION_CONFIG', at, 'Unsupported informational SPOT configuration');
    const percentage = decimal(row.percentage, `${at}.percentage`, 5, 3);
    if (percentage === 0n || percentage > 100n * FACTOR_SCALE) fail('RANGE', `${at}.percentage`, 'Percentage must be in (0,100]');
    const base = cents(row.baseAmount, `${at}.baseAmount`, true);
    if (base !== totalBeforeAdvances) fail('AMOUNT_MISMATCH', `${at}.baseAmount`, 'General SPOT base must equal total before advances');
    const amount = row.rounding === 'CENT'
      ? roundDivide(base * percentage, 100n * FACTOR_SCALE)
      : roundDivide(base * percentage, 10_000n * FACTOR_SCALE) * 100n;
    if (amount === 0n || amount > base) fail('RANGE', `${at}.amount`, 'Rounded informational amount must be positive and <= base');
    if (Object.hasOwn(row, 'amount') && cents(row.amount, `${at}.amount`) !== amount) fail('AMOUNT_MISMATCH', `${at}.amount`, 'Configured amount does not reconcile');
    result.detraction = { mode: 'INFORMATIONAL', operationTypeCode: '1001', goodsServiceCode: row.goodsServiceCode,
      percentage: formatScaled(percentage, 5), baseAmount: money(base), rounding: row.rounding,
      amount: checkedMoney(amount, `${at}.amount`), effectOnPayableAmount: '0.00' };
  }
  return result;
}

/** Validates structure AND all arithmetic, returning only the first issue, with no partial output. */
export function validateSaleAdjustments(input: unknown): SaleAdjustmentsValidationResult {
  try { return { valid: true, result: calculateSaleAdjustments(input as SaleAdjustmentsInput) }; }
  catch (error) {
    if (!(error instanceof SaleAdjustmentError)) throw error;
    return { valid: false, issues: [{ code: error.code, path: error.path, message: error.message }] };
  }
}
