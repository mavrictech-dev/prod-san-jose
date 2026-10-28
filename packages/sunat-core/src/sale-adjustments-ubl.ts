import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import { isDeepStrictEqual } from 'node:util';
import {
  calculateSaleAdjustments, SaleAdjustmentError,
  type SaleAdjustmentsInput, type SaleAdjustmentsResult, type SaleTaxAffectationCode,
} from './sale-adjustments';
import { calculateTaxLine, formatScaled, parseDecimal } from './tax';

/** A precomputed result always carries its input so the builder can verify it. */
export interface AdjustedInvoiceCalculation {
  input: SaleAdjustmentsInput;
  result: SaleAdjustmentsResult;
}

const CATALOG = 'urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo';
// SUNAT catalogs 05/07; names use the <= 6 character UBL catalog spelling.
const TAX = {
  '10': { id: '1000', name: 'IGV', type: 'VAT', category: 'S' },
  '20': { id: '9997', name: 'EXO', type: 'VAT', category: 'E' },
  '30': { id: '9998', name: 'INA', type: 'FRE', category: 'O' },
} as const;
function bad(path: string, message: string): never { throw new SaleAdjustmentError('UBL_PROFILE', path, message); }
function record(value: unknown, path: string, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) bad(path, 'Expected a plain record');
  const row = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(row)) {
    if (typeof key !== 'string' || ![...required, ...optional].includes(key)) bad(path, `Unsupported field ${String(key)}`);
    const descriptor = Object.getOwnPropertyDescriptor(row, key)!;
    if (!('value' in descriptor) || !descriptor.enumerable || descriptor.value === undefined) bad(`${path}.${key}`, 'Expected explicit plain data');
  }
  for (const key of required) if (!Object.hasOwn(row, key)) bad(`${path}.${key}`, 'Missing field');
  return row;
}
function xml(value: unknown, path: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max
    || /[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u.test(value)) bad(path, 'Invalid XML text');
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
function identifier(value: unknown, path: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) bad(path, 'Invalid identifier');
  return value;
}
function exact(value: unknown, path: string, scale: number): bigint {
  if (typeof value !== 'string' || !new RegExp(`^(0|[1-9][0-9]{0,11})(\\.[0-9]{1,${scale}})?$`).test(value)) bad(path, 'Invalid decimal');
  return parseDecimal(value, scale);
}
function equalAmount(value: unknown, expected: string, path: string, scale = 2): void {
  if (exact(value, path, scale) !== parseDecimal(expected, scale)) {
    throw new SaleAdjustmentError('SNAPSHOT_MISMATCH', path, 'Base snapshot/input must represent the same unadjusted sale');
  }
}
function calendarInLima(value: unknown): string {
  if (typeof value !== 'string') bad('base.issueDate', 'Missing issue date');
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(value)) bad('base.issueDate', 'Expected ISO date/time with explicit timezone');
  const originalDay = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || !Number.isFinite(originalDay.getTime()) || originalDay.toISOString().slice(0, 10) !== value.slice(0, 10)) bad('base.issueDate', 'Invalid date');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(parsed);
  const part = (type: string) => parts.find(item => item.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * Builds an unsigned Invoice for an explicitly supplied BETA/0101 snapshot.
 * Supports discounts and onerous 10/20/30, IGV18, PEN/USD; never emits/sends/signs.
 * Advance calculation is supported by sale-adjustments, but Invoice serialization
 * fails closed until modern SUNAT PrepaidAmount/base-deduction reconciliation is
 * verified. Informational detraction stays in the result; no SPOT XML is inferred.
 * Base MUST be unadjusted; input line IDs MUST equal String(base.lineNumber).
 */
export function buildAdjustedInvoiceUbl(
  base: FiscalDocumentSnapshot,
  calculation: SaleAdjustmentsInput | AdjustedInvoiceCalculation,
): string {
  record(base, 'base', ['environment', 'documentId', 'documentTypeCode', 'series', 'number', 'fullNumber', 'issueDate', 'currencyCode', 'operationTypeCode', 'issuer', 'customer', 'lines', 'totals'], ['companyId', 'branchId', 'paymentTerms']);
  if (base.environment !== 'BETA' || base.operationTypeCode !== '0101'
    || (base.documentTypeCode !== '01' && base.documentTypeCode !== '03')) bad('base', 'Only explicit BETA Invoice 01/03 operation 0101');
  let input: SaleAdjustmentsInput;
  let expected: SaleAdjustmentsResult | undefined;
  if (calculation && typeof calculation === 'object' && Object.hasOwn(calculation, 'input')) {
    const wrapped = record(calculation, 'calculation', ['input', 'result']);
    input = wrapped.input as SaleAdjustmentsInput;
    expected = wrapped.result as SaleAdjustmentsResult;
  } else input = calculation as SaleAdjustmentsInput;
  const result = calculateSaleAdjustments(input);
  if (expected !== undefined && !isDeepStrictEqual(expected, result)) {
    throw new SaleAdjustmentError('RESULT_MISMATCH', 'calculation.result', 'Stale or tampered calculation');
  }
  if (result.advances.length) bad('calculation.advances', 'Advance Invoice serialization is not verified; use the exact calculation/reference API, not approximate XML');
  if (base.currencyCode !== result.currencyCode || calendarInLima(base.issueDate) !== result.issueDate) {
    throw new SaleAdjustmentError('SNAPSHOT_MISMATCH', 'base', 'Currency/date do not match calculation');
  }
  identifier(base.documentId, 'base.documentId', /^[A-Za-z0-9_-]{1,64}$/);
  const series = identifier(base.series, 'base.series', base.documentTypeCode === '01' ? /^F[A-Z0-9]{3}$/ : /^B[A-Z0-9]{3}$/);
  const number = identifier(base.number, 'base.number', /^[1-9][0-9]{0,7}$/);
  if (base.fullNumber !== `${series}-${number}`) bad('base.fullNumber', 'Series/number mismatch');
  record(base.issuer, 'base.issuer', ['identityType', 'identityNumber', 'legalName', 'ubigeo', 'establishmentCode'], ['address', 'tradeName']);
  record(base.customer, 'base.customer', ['identityType', 'identityNumber', 'legalName'], ['address']);
  if (base.issuer.identityType !== '6') bad('base.issuer.identityType', 'Issuer RUC required');
  identifier(base.issuer.identityNumber, 'base.issuer.identityNumber', /^[0-9]{11}$/);
  identifier(base.issuer.ubigeo, 'base.issuer.ubigeo', /^[0-9]{6}$/);
  identifier(base.issuer.establishmentCode, 'base.issuer.establishmentCode', /^[0-9]{4}$/);
  if (base.documentTypeCode === '01' && base.customer.identityType !== '6') bad('base.customer.identityType', 'BETA factura requires RUC');
  const customerPattern = base.customer.identityType === '6' ? /^[0-9]{11}$/ : base.customer.identityType === '1' ? /^[0-9]{8}$/ : base.customer.identityType === '0' ? /^0$/ : undefined;
  if (!customerPattern) bad('base.customer.identityType', 'Unsupported BETA customer identity');
  identifier(base.customer.identityNumber, 'base.customer.identityNumber', customerPattern);
  if (!Array.isArray(base.lines) || base.lines.length !== input.lines.length
    || Reflect.ownKeys(base.lines).length !== base.lines.length + 1) bad('base.lines', 'Line count/array mismatch');
  let baselineTaxable = 0n, baselineIgv = 0n, baselineTotal = 0n;
  const currency = result.currencyCode;
  const amount = (tag: string, value: string) => `<cbc:${tag} currencyID="${currency}">${value}</cbc:${tag}>`;
  const category = (code: SaleTaxAffectationCode, withReason: boolean) => {
    const tax = TAX[code];
    return `<cac:TaxCategory><cbc:ID schemeID="UN/ECE 5305" schemeAgencyID="6">${tax.category}</cbc:ID>${withReason ? `<cbc:Percent>${code === '10' ? '18.00' : '0.00'}</cbc:Percent><cbc:TaxExemptionReasonCode listAgencyName="PE:SUNAT" listName="Afectacion del IGV" listURI="${CATALOG}07">${code}</cbc:TaxExemptionReasonCode>` : ''}<cac:TaxScheme><cbc:ID schemeAgencyName="PE:SUNAT" schemeName="Codigo de tributos" schemeURI="${CATALOG}05">${tax.id}</cbc:ID><cbc:Name>${tax.name}</cbc:Name><cbc:TaxTypeCode>${tax.type}</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory>`;
  };
  const subtotal = (code: SaleTaxAffectationCode, taxable: string, igv: string, line = false) =>
    `<cac:TaxSubtotal>${amount('TaxableAmount', taxable)}${amount('TaxAmount', igv)}${category(code, line)}</cac:TaxSubtotal>`;
  const allowance = (discount: SaleAdjustmentsResult['globalDiscounts'][number]) =>
    `<cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:AllowanceChargeReasonCode listAgencyName="PE:SUNAT" listName="Cargo/descuento" listURI="${CATALOG}53">${discount.reasonCode}</cbc:AllowanceChargeReasonCode><cbc:MultiplierFactorNumeric>${discount.factor}</cbc:MultiplierFactorNumeric>${amount('Amount', discount.amount)}${amount('BaseAmount', discount.baseAmount)}</cac:AllowanceCharge>`;
  const linesXml = base.lines.map((source, index) => {
    const at = `base.lines[${index}]`;
    record(source, at, ['lineNumber', 'description', 'unitCode', 'quantity', 'unitValue', 'unitPriceWithTax', 'taxAffectationCode', 'igvRate', 'lineExtensionAmount', 'igvAmount', 'totalAmount'], ['productCode']);
    const supplied = input.lines[index], adjusted = result.lines[index];
    if (source.lineNumber !== index + 1 || supplied.id !== String(source.lineNumber) || source.taxAffectationCode !== supplied.taxAffectationCode) bad(at, 'Line number/id/affectation mismatch');
    equalAmount(source.quantity, supplied.quantity, `${at}.quantity`, 6);
    equalAmount(source.unitPriceWithTax, supplied.unitPriceWithTax, `${at}.unitPriceWithTax`, 6);
    equalAmount(source.igvRate, supplied.igvRate, `${at}.igvRate`, 2);
    const original = calculateTaxLine(supplied);
    equalAmount(source.unitValue, original.unitValue, `${at}.unitValue`, 6);
    for (const key of ['lineExtensionAmount', 'igvAmount', 'totalAmount'] as const) equalAmount(source[key], original[key], `${at}.${key}`);
    if (supplied.taxAffectationCode === '10') baselineTaxable += parseDecimal(original.lineExtensionAmount, 2);
    baselineIgv += parseDecimal(original.igvAmount, 2); baselineTotal += parseDecimal(original.totalAmount, 2);
    identifier(source.unitCode, `${at}.unitCode`, /^(NIU|LTR|KGM|MTR|HUR|ZZ)$/);
    const product = source.productCode === undefined ? '' : `<cac:SellersItemIdentification><cbc:ID>${xml(source.productCode, `${at}.productCode`, 64)}</cbc:ID></cac:SellersItemIdentification>`;
    return `<cac:InvoiceLine><cbc:ID>${source.lineNumber}</cbc:ID><cbc:InvoicedQuantity unitCode="${source.unitCode}">${formatScaled(parseDecimal(supplied.quantity, 6), 6)}</cbc:InvoicedQuantity>${amount('LineExtensionAmount', adjusted.lineExtensionAmount)}<cac:PricingReference><cac:AlternativeConditionPrice>${amount('PriceAmount', formatScaled(parseDecimal(supplied.unitPriceWithTax, 6), 6))}<cbc:PriceTypeCode>01</cbc:PriceTypeCode></cac:AlternativeConditionPrice></cac:PricingReference>${adjusted.discounts.map(allowance).join('')}<cac:TaxTotal>${amount('TaxAmount', adjusted.igvAmount)}${subtotal(adjusted.taxAffectationCode, adjusted.lineExtensionAmount, adjusted.igvAmount, true)}</cac:TaxTotal><cac:Item><cbc:Description>${xml(source.description, `${at}.description`)}</cbc:Description>${product}</cac:Item><cac:Price>${amount('PriceAmount', original.unitValue)}</cac:Price></cac:InvoiceLine>`;
  }).join('');
  record(base.totals, 'base.totals', ['taxableAmount', 'igvAmount', 'payableAmount']);
  equalAmount(base.totals.taxableAmount, formatScaled(baselineTaxable, 2), 'base.totals.taxableAmount');
  equalAmount(base.totals.igvAmount, formatScaled(baselineIgv, 2), 'base.totals.igvAmount');
  equalAmount(base.totals.payableAmount, formatScaled(baselineTotal, 2), 'base.totals.payableAmount');
  let payment = '';
  if (Object.hasOwn(base, 'paymentTerms')) {
    record(base.paymentTerms, 'base.paymentTerms', ['type']);
    if (base.paymentTerms?.type !== 'CONTADO') bad('base.paymentTerms', 'Credit installments need a separately verified adjusted payment profile');
    payment = '<cac:PaymentTerms><cbc:ID>FormaPago</cbc:ID><cbc:PaymentMeansID>Contado</cbc:PaymentMeansID></cac:PaymentTerms>';
  }
  const address = `<cac:RegistrationAddress><cbc:ID schemeAgencyName="PE:INEI" schemeName="Ubigeos">${base.issuer.ubigeo}</cbc:ID><cbc:AddressTypeCode>${base.issuer.establishmentCode}</cbc:AddressTypeCode>${base.issuer.address === undefined ? '' : `<cac:AddressLine><cbc:Line>${xml(base.issuer.address, 'base.issuer.address')}</cbc:Line></cac:AddressLine>`}<cac:Country><cbc:IdentificationCode>PE</cbc:IdentificationCode></cac:Country></cac:RegistrationAddress>`;
  const supplier = `<cac:AccountingSupplierParty><cac:Party><cac:PartyIdentification><cbc:ID schemeID="6">${base.issuer.identityNumber}</cbc:ID></cac:PartyIdentification>${base.issuer.tradeName === undefined ? '' : `<cac:PartyName><cbc:Name>${xml(base.issuer.tradeName, 'base.issuer.tradeName')}</cbc:Name></cac:PartyName>`}<cac:PartyLegalEntity><cbc:RegistrationName>${xml(base.issuer.legalName, 'base.issuer.legalName')}</cbc:RegistrationName>${address}</cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>`;
  if (base.customer.address !== undefined) xml(base.customer.address, 'base.customer.address');
  const customer = `<cac:AccountingCustomerParty><cac:Party><cac:PartyIdentification><cbc:ID schemeID="${base.customer.identityType}">${base.customer.identityNumber}</cbc:ID></cac:PartyIdentification><cac:PartyLegalEntity><cbc:RegistrationName>${xml(base.customer.legalName, 'base.customer.legalName')}</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingCustomerParty>`;
  const totals = result.totals;
  const totalBase = parseDecimal(totals.taxableAmount, 2) + parseDecimal(totals.exoneratedAmount, 2) + parseDecimal(totals.inaffectedAmount, 2);
  const taxInclusive = formatScaled(totalBase + parseDecimal(totals.igvAmount, 2), 2);
  const codes: SaleTaxAffectationCode[] = ['10', '20', '30'];
  const bases = { '10': totals.taxableAmount, '20': totals.exoneratedAmount, '30': totals.inaffectedAmount };
  const subtotals = codes.filter(code => result.lines.some(line => line.taxAffectationCode === code))
    .map(code => subtotal(code, bases[code], code === '10' ? totals.igvAmount : '0.00')).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions>
<cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:CustomizationID>2.0</cbc:CustomizationID><cbc:ID>${base.fullNumber}</cbc:ID><cbc:IssueDate>${result.issueDate}</cbc:IssueDate><cbc:InvoiceTypeCode listID="0101" listAgencyName="PE:SUNAT" listName="Tipo de Documento" listURI="${CATALOG}01">${base.documentTypeCode}</cbc:InvoiceTypeCode><cbc:DocumentCurrencyCode>${currency}</cbc:DocumentCurrencyCode>
${supplier}${customer}${payment}${result.globalDiscounts.map(allowance).join('')}
<cac:TaxTotal>${amount('TaxAmount', totals.igvAmount)}${subtotals}</cac:TaxTotal>
<cac:LegalMonetaryTotal>${amount('LineExtensionAmount', formatScaled(totalBase, 2))}${amount('TaxInclusiveAmount', taxInclusive)}${parseDecimal(totals.nonTaxDiscountAmount, 2) === 0n ? '' : amount('AllowanceTotalAmount', totals.nonTaxDiscountAmount)}${amount('PayableAmount', totals.payableAmount)}</cac:LegalMonetaryTotal>
${linesXml}</Invoice>`;
}
