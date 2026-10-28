import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import { addMoney, calculateTaxLine, parseDecimal } from './tax';
import { fiscalIssueDateInLima, isFiscalTimestamp, validateInvoicePaymentTerms, validateInvoiceSupportedFields } from './fiscal-rules';

export const LOCAL_XML_PROFILE = 'LOCAL-QA-UBL21-RSA256-v1';

/**
 * Perfil histórico local: contado/forma de pago ausente, oneroso, IGV 18%.
 * Invoice puede habilitar crédito explícitamente; los llamadores actuales de notas
 * conservan el cierre por defecto porque no implementan actualización del saldo.
 * No es XSD ni validación SUNAT.
 */
export function validateLocalInvoice(document: FiscalDocumentSnapshot, options: { allowCredit?: boolean } = {}): void {
  const fail = () => { throw new Error('Snapshot fuera del perfil local: revise identidad, líneas e importes'); };
  const profileIssues = [...validateInvoiceSupportedFields(document), ...validateInvoicePaymentTerms(document, { mode: 'LOCAL_DEVELOPMENT' })];
  if (profileIssues.length) throw new Error(`Snapshot fuera del perfil local: ${profileIssues.map(issue => `${issue.code}@${issue.path}`).join(', ')}`);
  if (document.paymentTerms?.type === 'CREDITO' && options.allowCredit !== true)
    throw new Error('Crédito requiere validación Invoice explícita; notas QA no implementan actualización del saldo pendiente');
  const text = (value: unknown, max = 300) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max ||
      /[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u.test(value)) fail();
  };
  const decimal = (value: string, positive = false) => {
    if (typeof value !== 'string' || value.length > 24 || !/^\d{1,12}(\.\d{1,6})?$/.test(value)) fail();
    const amount = parseDecimal(value); if (amount < 0n || (positive && amount === 0n)) fail();
  };
  if (!['01', '03'].includes(document.documentTypeCode) || document.environment !== 'BETA' ||
      !/^[0-9a-f-]{36}$/i.test(document.documentId) || !/^\d{11}$/.test(document.issuer.identityNumber) ||
      document.issuer.identityType !== '6' || !/^\d{6}$/.test(document.issuer.ubigeo) ||
      !['PEN', 'USD'].includes(document.currencyCode) || document.operationTypeCode !== '0101' ||
      !(document.documentTypeCode === '01' ? /^F[A-Z0-9]{3}$/ : /^B[A-Z0-9]{3}$/).test(document.series) ||
      !/^[1-9]\d{0,7}$/.test(document.number) || document.fullNumber !== `${document.series}-${document.number}` ||
      !isFiscalTimestamp(document.issueDate) || !document.lines?.length || document.lines.length > 500) fail();
  text(document.issuer.legalName, 200); text(document.issuer.establishmentCode, 20);
  if (document.issuer.address !== undefined) text(document.issuer.address);
  text(document.customer.legalName, 200);
  if (document.documentTypeCode === '01' && (document.customer.identityType !== '6' || !/^\d{11}$/.test(document.customer.identityNumber))) fail();
  if (document.documentTypeCode === '03' && !(
    (document.customer.identityType === '0' && document.customer.identityNumber === '0') ||
    (document.customer.identityType === '1' && /^\d{8}$/.test(document.customer.identityNumber)) ||
    (document.customer.identityType === '6' && /^\d{11}$/.test(document.customer.identityNumber)))) fail();
  for (const [index, line] of document.lines.entries()) {
    text(line.description, 500); if (!/^[A-Z0-9]{2,3}$/.test(line.unitCode) || line.lineNumber !== index + 1 ||
      line.taxAffectationCode !== '10' || !['18', '18.00'].includes(line.igvRate)) fail();
    decimal(line.quantity, true); decimal(line.unitPriceWithTax, true); decimal(line.unitValue);
    const computed = calculateTaxLine(line);
    for (const key of ['unitValue', 'lineExtensionAmount', 'igvAmount', 'totalAmount'] as const) {
      decimal(line[key]); if (parseDecimal(computed[key]) !== parseDecimal(line[key])) fail();
    }
  }
  const totals = { taxableAmount: addMoney(document.lines.map(l => l.lineExtensionAmount)),
    igvAmount: addMoney(document.lines.map(l => l.igvAmount)), payableAmount: addMoney(document.lines.map(l => l.totalAmount)) };
  for (const key of ['taxableAmount', 'igvAmount', 'payableAmount'] as const) {
    decimal(document.totals[key]); if (parseDecimal(document.totals[key]) !== parseDecimal(totals[key])) fail();
  }
}

export function limaIssueDate(value: string): string {
  return fiscalIssueDateInLima(value);
}
