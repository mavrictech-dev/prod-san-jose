import { addMoney, calculateTaxLine, parseDecimal } from './tax';
import { validPrintMetadata } from './print-metadata';

/** Source pin, not a claim that every row in the workbook is executable code. */
export const FISCAL_RULES_SOURCE = Object.freeze({
  authority: 'SUNAT', publishedVersion: '2026-08-26', verifiedOn: '2026-10-02',
  indexUrl: 'https://cpe.sunat.gob.pe/guias-y-manuales',
  sourceUrl: 'https://cpe.sunat.gob.pe/sites/default/files/2026-08/Reglas%20de%20validaci%C3%B3n%20-%20actualizado%20al%2026.08.2026.xlsx',
  archiveSha256: 'cb5e871cfe3b81abea7faf25b156e5d35b21e8c4837979350919926612da73b6',
  archiveBytes: 855113,
  workbookAutomaticallyConverted: false,
});

export const FISCAL_RULE_PROFILE = 'FACTUEZ-01-03-IGV18-20260826-v3';
export const FISCAL_RULE_COVERAGE = Object.freeze([
  { capability: '01/03 · venta interna onerosa · IGV 18% · PEN/USD', status: 'LOCAL_PROFILE_VALIDATED' },
  { capability: 'Identidad, numeración, fechas, XML text y aritmética decimal', status: 'LOCAL_PROFILE_VALIDATED' },
  { capability: 'Boleta PEN sin identificación hasta S/700; superior exige identidad', status: 'LOCAL_PROFILE_VALIDATED' },
  { capability: 'USD sin identificación · conversión y umbral · Selva/Tacna', status: 'UNSUPPORTED_FAIL_CLOSED' },
  { capability: 'Exoneradas, inafectas, gratuitas, exportación y regímenes especiales', status: 'UNSUPPORTED_FAIL_CLOSED' },
  { capability: 'Contado explícito; factura 01 al crédito con saldo y cuotas exactas PEN/USD', status: 'LOCAL_PROFILE_VALIDATED' },
  { capability: 'Crédito en boleta 03, ISC, ICBPER, retenciones, detracciones, percepciones, descuentos y anticipos', status: 'UNSUPPORTED_FAIL_CLOSED' },
  { capability: '07/08/09, RC/RA: validadores dedicados fuera de este perfil Invoice', status: 'SEPARATE_PROFILE_REQUIRED' },
  { capability: 'Todas las filas del XLSX y reglas dependientes de padrones SUNAT', status: 'NOT_FULLY_AUTOMATED' },
] as const);

export type FiscalValidationMode = 'LOCAL_DEVELOPMENT' | 'REAL_PREPARATION';
export type FiscalRuleIssue = { code: string; path: string; message: string; category: 'INVALID' | 'UNSUPPORTED' };
export type FiscalSnapshotValidation = {
  profile: string; sourceVersion: string; valid: boolean; coverageComplete: false;
  transmissionAuthorized: false; issues: FiscalRuleIssue[];
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNIT_SUBSET = new Set(['GLL', 'LTR', 'NIU', 'KGM', 'M3', 'HUR', 'ZZ']);
const xmlIllegal = /[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u;
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const SNAPSHOT_KEYS = ['companyId', 'branchId', 'environment', 'documentId', 'documentTypeCode', 'series', 'number', 'fullNumber', 'issueDate', 'currencyCode', 'paymentTerms', 'operationTypeCode', 'issuer', 'customer', 'lines', 'totals', 'printPresentation', 'printOperation'] as const;
const PARTY_KEYS = ['identityType', 'identityNumber', 'legalName', 'address'] as const;
const ISSUER_KEYS = [...PARTY_KEYS, 'tradeName', 'ubigeo', 'establishmentCode'] as const;
const LINE_KEYS = ['lineNumber', 'productCode', 'description', 'unitCode', 'quantity', 'unitValue', 'unitPriceWithTax', 'taxAffectationCode', 'igvRate', 'lineExtensionAmount', 'igvAmount', 'totalAmount'] as const;
const TOTAL_KEYS = ['taxableAmount', 'igvAmount', 'payableAmount'] as const;

/** Shared with the XML/local entry points: unsupported fiscal data is never discarded. */
export function validateInvoiceSupportedFields(input: unknown): FiscalRuleIssue[] {
  const issues: FiscalRuleIssue[] = [];
  const keys = (value: unknown, allowed: readonly string[], path: string) => {
    if (object(value) && Object.keys(value).some(key => !allowed.includes(key)))
      issues.push({ code: 'UNSUPPORTED_FIELDS', path, message: 'Campos adicionales requieren un perfil fiscal dedicado; no se descartan silenciosamente', category: 'UNSUPPORTED' });
  };
  if (!object(input)) return issues;
  keys(input, SNAPSHOT_KEYS, '$');
  if (!validPrintMetadata(input)) issues.push({ code: 'PRINT_METADATA_INVALID', path: 'printPresentation/printOperation',
    message: 'La presentación visual debe estar versionada, acotada y vinculada al RUC/sede del snapshot', category: 'INVALID' });
  keys(input.issuer, ISSUER_KEYS, 'issuer');
  keys(input.customer, PARTY_KEYS, 'customer');
  keys(input.totals, TOTAL_KEYS, 'totals');
  if (Array.isArray(input.lines)) {
    for (const [index, line] of input.lines.slice(0, 500).entries()) keys(line, LINE_KEYS, `lines[${index}]`);
  }
  return issues;
}

/** Structural check only: does NOT query registration, habido status or SEE authorization. */
export function isRucStructurallyValid(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?:10|15|16|17|20)\d{9}$/.test(value)) return false;
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const remainder = 11 - weights.reduce((sum, weight, index) => sum + Number(value[index]) * weight, 0) % 11;
  return Number(value[10]) === (remainder === 10 ? 0 : remainder === 11 ? 1 : remainder);
}

/** Date.parse alone accepts e.g. February 30. Check calendar, clock and offset first. */
export function isFiscalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?(Z|([+-])(\d\d):(\d\d))$/.exec(value);
  if (!match) return false;
  const [, yearString, monthString, dayString, hourString, minuteString, secondString, offset, , offsetHour, offsetMinute] = match;
  const year = Number(yearString), month = Number(monthString), day = Number(dayString);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 2000 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] &&
    Number(hourString) < 24 && Number(minuteString) < 60 && Number(secondString) < 60 &&
    (offset === 'Z' || (Number(offsetHour) <= 14 && Number(offsetMinute) < 60 && (Number(offsetHour) !== 14 || Number(offsetMinute) === 0))) &&
    Number.isFinite(Date.parse(value));
}

export function isFiscalCalendarDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value) && isFiscalTimestamp(`${value}T00:00:00Z`);
}

/** The same civil date used by cbc:IssueDate, including UTC/offset day changes. */
export function fiscalIssueDateInLima(value: string): string {
  if (!isFiscalTimestamp(value)) throw new Error('Fecha de emisión inválida');
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const part = (name: string) => parts.find(p => p.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * SUNAT XLSX 2026-08-26, Factura2_0 rows 855..883 (3244..3267, 3319, 2071,
 * 3461), and RS 123-2022 Annex III pp. 54..57:
 * https://www.sunat.gob.pe/legislacion/superin/2022/anexo-123-2022.pdf
 * Local rule IDs below are NOT SUNAT response codes. Absence is historical,
 * never evidence of Contado. REAL_PREPARATION requires an explicit choice on 01.
 * Local dates allow >= emission; official rule 3267 requires > for real preparation.
 */
export function validateInvoicePaymentTerms(input: unknown, options: { mode: FiscalValidationMode }): FiscalRuleIssue[] {
  const issues: FiscalRuleIssue[] = [];
  const fail = (code: string, path: string, message: string, category: FiscalRuleIssue['category'] = 'INVALID') => {
    if (issues.length < 100) issues.push({ code, path, message, category });
  };
  if (!options || !['LOCAL_DEVELOPMENT', 'REAL_PREPARATION'].includes(options.mode)) {
    fail('PROFILE_MODE', '$', 'Seleccione un modo de validación explícito'); return issues;
  }
  if (!object(input)) { fail('SNAPSHOT_SHAPE', '$', 'Se requiere un snapshot de objeto'); return issues; }
  const terms = input.paymentTerms;
  if (terms === undefined) {
    if (input.documentTypeCode === '01' && options.mode === 'REAL_PREPARATION')
      fail('PAYMENT_TERMS_REQUIRED', 'paymentTerms', 'La factura 01 requiere contado o crédito explícito; un snapshot antiguo no acredita contado');
    return issues;
  }
  if (!object(terms)) { fail('PAYMENT_TERMS_SHAPE', 'paymentTerms', 'La forma de pago debe ser un objeto'); return issues; }
  const keys = (value: ObjectValue, allowed: readonly string[], path: string) => {
    if (Object.keys(value).some(key => !allowed.includes(key)))
      fail('UNSUPPORTED_FIELDS', path, 'Datos de pago adicionales sin semántica implementada', 'UNSUPPORTED');
  };
  if (terms.type === 'CONTADO') {
    keys(terms, ['type'], 'paymentTerms');
    if (input.documentTypeCode !== '01' && input.documentTypeCode !== '03')
      fail('PAYMENT_DOCUMENT_PROFILE', 'paymentTerms', 'Contado sólo está implementado para Invoice 01/03', 'UNSUPPORTED');
    return issues;
  }
  if (terms.type !== 'CREDITO') {
    fail('PAYMENT_TYPE', 'paymentTerms.type', 'Use CONTADO o CREDITO explícito'); return issues;
  }
  keys(terms, ['type', 'currencyCode', 'pendingAmount', 'installments'], 'paymentTerms');
  if (input.documentTypeCode !== '01') {
    fail('PAYMENT_DOCUMENT_PROFILE', 'paymentTerms', 'Crédito y cuotas sólo están implementados para factura 01; boleta 03 requiere otro perfil', 'UNSUPPORTED');
    return issues;
  }
  const currency = (value: unknown, path: string) => {
    if (typeof value !== 'string' || !['PEN', 'USD'].includes(value) || value !== input.currencyCode)
      fail('PAYMENT_CURRENCY', path, 'La moneda del saldo y de cada cuota debe coincidir con la del documento PEN/USD');
  };
  const cents = (value: unknown, path: string, positive: boolean): bigint | undefined => {
    if (typeof value !== 'string' || !/^\d{1,12}(\.\d{1,2})?$/.test(value)) {
      fail('PAYMENT_DECIMAL', path, 'Importe de texto con hasta 12 enteros y dos decimales; sin redondeo ni coerción'); return;
    }
    const amount = parseDecimal(value, 2);
    if (positive && amount === 0n) { fail('PAYMENT_POSITIVE', path, 'El saldo y cada cuota deben ser mayores que cero'); return; }
    return amount;
  };
  currency(terms.currencyCode, 'paymentTerms.currencyCode');
  const pending = cents(terms.pendingAmount, 'paymentTerms.pendingAmount', true);
  const payable = cents(object(input.totals) ? input.totals.payableAmount : undefined, 'totals.payableAmount', false);
  if (pending !== undefined && payable !== undefined && pending > payable)
    fail('PAYMENT_PENDING_LIMIT', 'paymentTerms.pendingAmount', 'El saldo pendiente no puede exceder el importe total del comprobante');
  if (!Array.isArray(terms.installments) || terms.installments.length < 1 || terms.installments.length > 999) {
    fail('PAYMENT_INSTALLMENTS_COUNT', 'paymentTerms.installments', 'Crédito requiere de 1 a 999 cuotas (Cuota001..Cuota999)'); return issues;
  }
  const issueDate = isFiscalTimestamp(input.issueDate) ? fiscalIssueDateInLima(input.issueDate) : undefined;
  if (!issueDate) fail('ISSUE_DATE', 'issueDate', 'Fecha/hora de emisión con calendario y zona válidos requerida para crédito');
  let sum = 0n, allAmountsValid = true;
  for (let index = 0; index < terms.installments.length; index++) {
    const installment: unknown = terms.installments[index];
    const path = `paymentTerms.installments[${index}]`;
    if (!object(installment)) {
      fail('PAYMENT_INSTALLMENT_SHAPE', path, 'Cada cuota debe ser un objeto'); allAmountsValid = false; continue;
    }
    keys(installment, ['amount', 'dueDate', 'currencyCode'], path);
    const amount = cents(installment.amount, `${path}.amount`, true);
    if (amount === undefined) allAmountsValid = false;
    else sum += amount;
    // An omitted currency is inherited from the explicitly declared credit currency.
    if (installment.currencyCode !== undefined) currency(installment.currencyCode, `${path}.currencyCode`);
    if (!isFiscalCalendarDate(installment.dueDate))
      fail('PAYMENT_DUE_DATE', `${path}.dueDate`, 'Fecha calendario real YYYY-MM-DD requerida');
    else if (issueDate && installment.dueDate < issueDate)
      fail('PAYMENT_DUE_BEFORE_ISSUE', `${path}.dueDate`, 'La cuota no puede vencer antes de la fecha de emisión en Lima');
    else if (issueDate && installment.dueDate === issueDate && options.mode === 'REAL_PREPARATION')
      fail('PAYMENT_DUE_AFTER_ISSUE_REQUIRED', `${path}.dueDate`, 'SUNAT regla 3267 exige vencimiento posterior a la emisión para preparación real');
  }
  if (allAmountsValid && pending !== undefined && sum !== pending)
    fail('PAYMENT_INSTALLMENTS_SUM', 'paymentTerms.installments', 'La suma exacta de las cuotas debe igualar el saldo pendiente');
  return issues;
}

/** Local rule IDs intentionally are NOT SUNAT rejection codes. Never coerces input numbers. */
export function validateFiscalSnapshot(input: unknown, options: { mode: FiscalValidationMode; now?: Date }): FiscalSnapshotValidation {
  const issues: FiscalRuleIssue[] = [];
  const fail = (code: string, path: string, message: string, category: FiscalRuleIssue['category'] = 'INVALID') => {
    if (issues.length < 100) issues.push({ code, path, message, category });
  };
  const result = (): FiscalSnapshotValidation => ({ profile: FISCAL_RULE_PROFILE, sourceVersion: FISCAL_RULES_SOURCE.publishedVersion,
    valid: issues.length === 0, coverageComplete: false, transmissionAuthorized: false, issues });
  if (!options || !['LOCAL_DEVELOPMENT', 'REAL_PREPARATION'].includes(options.mode)) {
    fail('PROFILE_MODE', '$', 'Seleccione un modo de validación explícito'); return result();
  }
  const real = options.mode === 'REAL_PREPARATION';
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) { fail('INVALID_CLOCK', '$', 'Reloj de validación inválido'); return result(); }
  if (!object(input)) { fail('SNAPSHOT_SHAPE', '$', 'Se requiere un snapshot de objeto'); return result(); }
  const text = (value: unknown, path: string, max = 300) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max || xmlIllegal.test(value)) {
      fail('XML_TEXT', path, 'Texto vacío, demasiado largo o no representable en XML'); return false;
    } return true;
  };
  const money = (value: unknown, path: string, scale: 2 | 6 = 2, positive = false): bigint | undefined => {
    if (typeof value !== 'string' || value.length > 24 || !(scale === 2 ? /^\d{1,12}(\.\d{1,2})?$/ : /^\d{1,12}(\.\d{1,6})?$/).test(value)) {
      fail('DECIMAL_FORMAT', path, `Use decimal de texto no negativo, hasta ${scale} decimales`); return;
    }
    const amount = parseDecimal(value, scale);
    if (positive && amount === 0n) { fail('POSITIVE_VALUE', path, 'El perfil requiere una cantidad/precio positivo'); return; }
    return amount;
  };
  for (const issue of [...validateInvoiceSupportedFields(input), ...validateInvoicePaymentTerms(input, options)])
    fail(issue.code, issue.path, issue.message, issue.category);
  if (!['01', '03'].includes(String(input.documentTypeCode))) fail('DOCUMENT_PROFILE', 'documentTypeCode', 'Este validador sólo cubre Invoice 01/03', 'UNSUPPORTED');
  const invoice = input.documentTypeCode === '01';
  if (typeof input.documentId !== 'string' || !UUID.test(input.documentId)) fail('DOCUMENT_UUID', 'documentId', 'UUID de documento inválido');
  if (input.companyId !== undefined && (!Number.isSafeInteger(input.companyId) || Number(input.companyId) < 1)) fail('COMPANY_ID', 'companyId', 'Identificador de emisor inválido');
  if (input.branchId !== undefined && (typeof input.branchId !== 'string' || !UUID.test(input.branchId))) fail('BRANCH_UUID', 'branchId', 'UUID de sede inválido');
  if (!(real ? ['BETA', 'PRODUCTION'] : ['BETA']).includes(String(input.environment))) fail('ENVIRONMENT', 'environment', 'Ambiente no permitido en el perfil solicitado');
  if (typeof input.series !== 'string' || !(invoice ? /^F[A-Z0-9]{3}$/ : /^B[A-Z0-9]{3}$/).test(input.series)) fail('SERIES', 'series', 'La serie debe corresponder al tipo 01/03');
  if (typeof input.number !== 'string' || !/^[1-9]\d{0,7}$/.test(input.number)) fail('CORRELATIVE', 'number', 'Correlativo entre 1 y 99999999, sin ceros iniciales');
  if (input.fullNumber !== `${input.series}-${input.number}`) fail('FULL_NUMBER', 'fullNumber', 'Serie y correlativo no coinciden');
  if (!isFiscalTimestamp(input.issueDate)) fail('ISSUE_DATE', 'issueDate', 'Fecha/hora con calendario y zona válidos requerida');
  else if (Date.parse(input.issueDate) > now.getTime() + 300_000) fail('FUTURE_DATE', 'issueDate', 'Emisión posterior al reloj local; revise sincronización horaria');
  if (!['PEN', 'USD'].includes(String(input.currencyCode))) fail('CURRENCY_PROFILE', 'currencyCode', 'Moneda fuera del perfil PEN/USD', 'UNSUPPORTED');
  if (input.operationTypeCode !== '0101') fail('OPERATION_PROFILE', 'operationTypeCode', 'Sólo venta interna onerosa 0101', 'UNSUPPORTED');
  if (!object(input.issuer) || !object(input.customer)) { fail('PARTIES_SHAPE', 'issuer/customer', 'Emisor y cliente deben ser objetos'); return result(); }
  const issuer = input.issuer, customer = input.customer;
  text(issuer.legalName, 'issuer.legalName', 200); text(customer.legalName, 'customer.legalName', 200);
  if (issuer.address !== undefined) text(issuer.address, 'issuer.address');
  if (customer.address !== undefined) text(customer.address, 'customer.address');
  if (issuer.tradeName !== undefined) text(issuer.tradeName, 'issuer.tradeName', 200);
  if (issuer.identityType !== '6' || typeof issuer.identityNumber !== 'string' ||
      !(real ? isRucStructurallyValid(issuer.identityNumber) : /^00\d{9}$/.test(issuer.identityNumber)))
    fail('ISSUER_RUC', 'issuer.identityNumber', real ? 'RUC de emisor estructuralmente inválido' : 'Desarrollo exige un identificador ficticio 00 de 11 dígitos');
  if (typeof issuer.ubigeo !== 'string' || !/^\d{6}$/.test(issuer.ubigeo) || issuer.ubigeo === '000000') fail('UBIGEO_FORMAT', 'issuer.ubigeo', 'Ubigeo de seis dígitos requerido; pertenencia a catálogo pendiente');
  if (real ? typeof issuer.establishmentCode !== 'string' || !/^\d{4}$/.test(issuer.establishmentCode) : !text(issuer.establishmentCode, 'issuer.establishmentCode', 20))
    if (real) fail('ESTABLISHMENT_CODE', 'issuer.establishmentCode', 'Domicilio/local anexo debe ser código de cuatro dígitos');
  const unidentified = customer.identityType === '0' && customer.identityNumber === '0';
  const customerRuc = customer.identityType === '6' && typeof customer.identityNumber === 'string' &&
    (real ? isRucStructurallyValid(customer.identityNumber) : /^\d{11}$/.test(customer.identityNumber));
  const customerDni = customer.identityType === '1' && typeof customer.identityNumber === 'string' && /^\d{8}$/.test(customer.identityNumber) && customer.identityNumber !== '00000000';
  if (invoice ? !customerRuc : !(unidentified || customerRuc || customerDni)) fail('CUSTOMER_IDENTITY', 'customer', 'Identificación fuera del perfil 01/03; extranjeros requieren perfil dedicado');
  if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 500) { fail('LINES_COUNT', 'lines', 'Se requieren de 1 a 500 líneas'); return result(); }
  const computedTotals: Array<{ lineExtensionAmount: string; igvAmount: string; totalAmount: string }> = [];
  for (const [index, candidate] of input.lines.entries()) {
    const path = `lines[${index}]`;
    if (!object(candidate)) { fail('LINE_SHAPE', path, 'La línea debe ser un objeto'); continue; }
    if (candidate.lineNumber !== index + 1) fail('LINE_SEQUENCE', `${path}.lineNumber`, 'Líneas consecutivas desde uno');
    text(candidate.description, `${path}.description`, 500);
    if (candidate.productCode !== undefined) text(candidate.productCode, `${path}.productCode`, 64);
    if (typeof candidate.unitCode !== 'string' || !UNIT_SUBSET.has(candidate.unitCode)) fail('UNIT_PROFILE', `${path}.unitCode`, 'Unidad fuera del subconjunto GLL/LTR/NIU/KGM/M3/HUR/ZZ', 'UNSUPPORTED');
    if (candidate.taxAffectationCode !== '10' || typeof candidate.igvRate !== 'string' || !['18', '18.00'].includes(candidate.igvRate)) fail('TAX_PROFILE', path, 'Este perfil sólo calcula oneroso afectación 10 e IGV 18%', 'UNSUPPORTED');
    const decimals = [money(candidate.quantity, `${path}.quantity`, 6, true), money(candidate.unitPriceWithTax, `${path}.unitPriceWithTax`, 6, true),
      money(candidate.unitValue, `${path}.unitValue`, 6), ...['lineExtensionAmount', 'igvAmount', 'totalAmount'].map(key => money(candidate[key], `${path}.${key}`))];
    if (decimals.some(value => value === undefined) || candidate.taxAffectationCode !== '10' || typeof candidate.igvRate !== 'string' || !['18', '18.00'].includes(candidate.igvRate)) continue;
    const computed = calculateTaxLine({ quantity: candidate.quantity as string, unitPriceWithTax: candidate.unitPriceWithTax as string, igvRate: candidate.igvRate });
    if (parseDecimal(computed.totalAmount, 2) === 0n) fail('ZERO_ROUNDED_TOTAL', path, 'Línea redondeada a cero fuera del perfil oneroso');
    for (const key of ['unitValue', 'lineExtensionAmount', 'igvAmount', 'totalAmount'] as const)
      if (parseDecimal(candidate[key] as string) !== parseDecimal(computed[key])) fail('LINE_ARITHMETIC', `${path}.${key}`, 'Importe difiere del cálculo exacto por línea');
    computedTotals.push(computed);
  }
  if (!object(input.totals)) { fail('TOTALS_SHAPE', 'totals', 'Totales requeridos'); return result(); }
  const totals = input.totals;
  for (const key of ['taxableAmount', 'igvAmount', 'payableAmount']) money(totals[key], `totals.${key}`);
  if (computedTotals.length === input.lines.length) {
    const expected = { taxableAmount: addMoney(computedTotals.map(line => line.lineExtensionAmount)), igvAmount: addMoney(computedTotals.map(line => line.igvAmount)), payableAmount: addMoney(computedTotals.map(line => line.totalAmount)) };
    for (const key of ['taxableAmount', 'igvAmount', 'payableAmount'] as const) {
      const amount = money(totals[key], `totals.${key}`);
      if (amount !== undefined && amount !== parseDecimal(expected[key], 2)) fail('TOTAL_ARITHMETIC', `totals.${key}`, 'Total difiere de la suma exacta de líneas');
    }
  }
  const payable = money(totals.payableAmount, 'totals.payableAmount');
  if (!invoice && unidentified) {
    if (input.currencyCode === 'PEN' && payable !== undefined && payable > 70_000n) fail('BOLETA_ID_OVER_700', 'customer', 'Boleta superior a S/700 exige identidad del adquirente en este perfil');
    if (input.currencyCode === 'USD') fail('UNIDENTIFIED_USD', 'customer', 'Falta conversión acreditada para el umbral de identificación', 'UNSUPPORTED');
  }
  return result();
}

export function assertFiscalSnapshot(input: unknown, options: { mode: FiscalValidationMode; now?: Date }): void {
  const validation = validateFiscalSnapshot(input, options);
  if (!validation.valid) throw new Error(`Snapshot fuera del perfil ${FISCAL_RULE_PROFILE}: ${validation.issues.map(issue => `${issue.code}@${issue.path}`).join(', ')}`);
}
