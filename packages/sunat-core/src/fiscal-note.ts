import { createHash } from 'node:crypto';
import type { FiscalDocumentSnapshot, FiscalLineSnapshot, FiscalPartySnapshot } from '@factuez/contracts';
import { addMoney, calculateTaxLine, formatScaled, parseDecimal } from './tax';

/**
 * Preparación pura BETA, sin firma, transporte, persistencia ni cambio de identidad.
 * Fuentes primarias (consultadas 2026-10-02): guías SUNAT NC/ND UBL 2.1,
 * catálogo 09/10 y oficio 102-2005 (mora inafecta). No implementa todo el catálogo
 * ni sustituye XSD/reglas vigentes, validación criptográfica del CDR o habilitación SEE.
 * El caller obtiene evidencia de un verificador confiable y reserva atómicamente
 * TODOS los créditos aceptados o en curso; complete:true no prueba esa integridad.
 * No se permite ampliar saldo con débitos ni descontar créditos rechazados aquí.
 * Perfil: originales 01/03 BETA/PEN/0101/IGV18, <=100 líneas, contado explícito en
 * 01; 03 permite pago ausente histórico. Crédito/cuotas, descuentos del ORIGINAL,
 * anticipos, otros impuestos, gratuitos y regímenes especiales fallan cerrados.
 * 07-01/06 copia íntegra; 07-07 devuelve cantidad a precio original; 07-05/09
 * ajusta un DELTA unitario positivo sobre la cantidad original (05 sólo factura).
 * Devoluciones posteriores a descuentos/disminuciones y ajustes posteriores a
 * devoluciones se bloquean: no se inventa reparto de un saldo mixto ni redondeos.
 * 08-02 agrega un DELTA, no un nuevo precio absoluto. 08-01 exclusivamente mora
 * declarada y sustentada por caller, importe PEN explícito e inafecto 30/9998;
 * no calcula tasas/días, no aproxima intereses compensatorios ni cuotas.
 */
export const FISCAL_NOTE_PROFILE = 'FACTUEZ-BETA-NOTES-PEN-IGV18-MORA30-v1';
export const FISCAL_NOTE_SOURCES = Object.freeze({
  index: 'https://cpe.sunat.gob.pe/guias-y-manuales',
  credit: 'https://cpe.sunat.gob.pe/sites/default/files/inline-files/guia%2Bxml%2Bnota%20de%20cr%C3%A9dito%2Bversion%202-1%2B1%2B0_0_0%20(2).pdf',
  debit: 'https://cpe.sunat.gob.pe/sites/default/files/inline-files/guia%2Bxml%2Bnota%20de%20d%C3%A9bito%2Bversion%202-1%2B1%2B0_0_0%20(2).pdf',
  taxCatalog: 'https://www.sunat.gob.pe/legislacion/superin/2014/anexo8-300-2014.pdf',
  debitCatalog: 'https://www.sunat.gob.pe/legislacion/superin/2015/anexoD-357-2015.pdf',
  lateInterest: 'https://www.sunat.gob.pe/legislacion/oficios/2005/oficios/o1022005.htm',
});

export type FiscalNoteInput =
  | { documentTypeCode: '07'; reasonCode: '01' | '06'; reasonDescription: string }
  | { documentTypeCode: '07'; reasonCode: '07'; reasonDescription: string;
      lines: { originalLineNumber: number; quantity: string }[] }
  | { documentTypeCode: '07'; reasonCode: '05' | '09'; reasonDescription: string;
      lines: { originalLineNumber: number; unitPriceAdjustmentWithTax: string }[] }
  | { documentTypeCode: '08'; reasonCode: '02'; reasonDescription: string;
      lines: { originalLineNumber: number; unitPriceAdjustmentWithTax: string }[] }
  | { documentTypeCode: '08'; reasonCode: '01'; reasonDescription: string;
      interestNature: 'MORATORIO'; interestBasis: string;
      lines: { originalLineNumber: number; interestAmount: string }[] };

export type FiscalDocumentIdentity = { documentId: string; series: string; number: string; issueDate: string };
export type FiscalAcceptanceEvidence = {
  environment: 'BETA'; issuerRuc: string; documentId: string;
  documentTypeCode: '01' | '03' | '07' | '08'; fullNumber: string;
  snapshotSha256: string; cdrSha256: string;
  status: 'ACCEPTED' | 'ACCEPTED_WITH_OBSERVATIONS'; responseCode: '0'; acceptedAt: string;
  source: { kind: 'CDR_DOCUMENT' } | {
    kind: 'CDR_SUMMARY'; identifier: string; referenceDate: string; lineNumber: number; conditionCode: '1' | '2';
  };
};
export type FiscalNoteSnapshot = Omit<FiscalDocumentSnapshot, 'documentTypeCode' | 'environment' | 'lines' | 'totals' | 'paymentTerms'> & {
  documentTypeCode: '07' | '08'; environment: 'BETA'; profile: typeof FISCAL_NOTE_PROFILE;
  reasonCode: string; reasonDescription: string; adjustment: FiscalNoteInput;
  reference: { documentId: string; documentTypeCode: '01' | '03'; fullNumber: string; issueDate: string; snapshotSha256: string };
  originalAcceptance: FiscalAcceptanceEvidence;
  creditHistoryIds: string[];
  lines: (FiscalLineSnapshot & { originalLineNumber: number })[];
  totals: FiscalDocumentSnapshot['totals'] & { unaffectedAmount: string };
};
export type FiscalNoteContext = {
  original: FiscalDocumentSnapshot; acceptance: FiscalAcceptanceEvidence; asOf: string;
  creditHistory: { complete: true; entries: { state: 'ACCEPTED' | 'RESERVED'; note: FiscalNoteSnapshot }[] };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOCUMENT_KEYS = ['companyId', 'branchId', 'environment', 'documentId', 'documentTypeCode', 'series', 'number', 'fullNumber', 'issueDate', 'currencyCode', 'paymentTerms', 'operationTypeCode', 'issuer', 'customer', 'lines', 'totals'];
const LINE_KEYS = ['lineNumber', 'productCode', 'description', 'unitCode', 'quantity', 'unitValue', 'unitPriceWithTax', 'taxAffectationCode', 'igvRate', 'lineExtensionAmount', 'igvAmount', 'totalAmount'];
const PARTY_KEYS = ['identityType', 'identityNumber', 'legalName', 'address'];
const MONEY_KEYS = ['taxableAmount', 'igvAmount', 'payableAmount'] as const;
export function fiscalFail(message: string): never { throw new Error(message); }
export function fiscalObject(value: unknown, allowed: readonly string[], path: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key)))
    fiscalFail(`${path}: objeto/campos fuera del perfil fiscal`);
}
export function fiscalText(value: unknown, maximum: number, path: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum ||
    /[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u.test(value))
    fiscalFail(`${path}: texto XML inválido`);
}
export function fiscalArray(value: unknown, maximum: number, path: string): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > maximum || Object.getPrototypeOf(value) !== Array.prototype ||
    Object.keys(value).length !== value.length || Reflect.ownKeys(value).some(key => key !== 'length' &&
      (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)))
    fiscalFail(`${path}: array denso sin campos adicionales requerido`);
}
export function fiscalUuid(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) fiscalFail(`${path}: UUID inválido`);
}
export function fiscalDecimal(value: unknown, scale: number, positive: boolean, path: string): bigint {
  if (typeof value !== 'string' || !new RegExp(`^(?:0|[1-9]\\d{0,11})(?:\\.\\d{1,${scale}})?$`).test(value))
    fiscalFail(`${path}: decimal exacto inválido`);
  const parsed = parseDecimal(value, scale);
  if (positive && parsed === 0n) fiscalFail(`${path}: debe ser positivo`);
  return parsed;
}
export function fiscalRuc(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !/^(?:10|15|16|17|20)\d{9}$/.test(value)) fiscalFail(`${path}: RUC real inválido`);
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const check = 11 - weights.reduce((sum, weight, i) => sum + Number(value[i]) * weight, 0) % 11;
  if (Number(value[10]) !== (check === 10 ? 0 : check === 11 ? 1 : check)) fiscalFail(`${path}: dígito de RUC inválido`);
}
export function fiscalDate(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value) || Number(value.slice(0, 4)) < 2000)
    fiscalFail(`${path}: fecha calendario inválida`);
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) fiscalFail(`${path}: fecha calendario inválida`);
}
export function fiscalTimestamp(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string') fiscalFail(`${path}: fecha/hora inválida`);
  const match = /^(\d{4}-\d\d-\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?(Z|[+-](\d\d):(\d\d))$/.exec(value);
  if (!match) fiscalFail(`${path}: zona horaria explícita requerida`);
  fiscalDate(match[1], path);
  if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59 ||
    (match[5] !== 'Z' && (Number(match[6]) > 14 || Number(match[7]) > 59 || (Number(match[6]) === 14 && Number(match[7]) !== 0))) ||
    !Number.isFinite(Date.parse(value))) fiscalFail(`${path}: fecha/hora inválida`);
}
export function fiscalLimaDate(value: string): string {
  fiscalTimestamp(value, 'issueDate');
  const result = new Date(Date.parse(value) - 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
  fiscalDate(result, 'fecha Lima'); return result;
}
export function fiscalCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(fiscalCanonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${fiscalCanonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
/** Huella de JSON canónico: claves ordenadas, arrays conservan orden; opcionales undefined se omiten. */
export function fiscalSnapshotSha256(snapshot: unknown): string {
  return createHash('sha256').update(fiscalCanonical(snapshot)).digest('hex');
}
export function fiscalEqual(actual: unknown, expected: unknown, path: string): void {
  if (fiscalCanonical(actual) !== fiscalCanonical(expected)) fiscalFail(`${path}: no coincide con snapshot/referencia/cálculo exacto`);
}
export function fiscalXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
export function fiscalIdentity(identity: FiscalDocumentIdentity, prefix: 'F' | 'B', asOf: string): void {
  fiscalObject(identity, ['documentId', 'series', 'number', 'issueDate'], 'identity');
  fiscalUuid(identity.documentId, 'documentId'); fiscalTimestamp(identity.issueDate, 'issueDate'); fiscalTimestamp(asOf, 'asOf');
  if (typeof identity.series !== 'string' || typeof identity.number !== 'string' || !new RegExp(`^${prefix}[A-Z0-9]{3}$`).test(identity.series) || !/^[1-9]\d{0,7}$/.test(identity.number) ||
    Date.parse(identity.issueDate) > Date.parse(asOf)) fiscalFail('Serie, correlativo o fecha futura fuera del perfil');
}
function validateParty(party: FiscalPartySnapshot, issuer: boolean): void {
  fiscalObject(party, issuer ? [...PARTY_KEYS, 'tradeName', 'ubigeo', 'establishmentCode'] : PARTY_KEYS, issuer ? 'issuer' : 'customer');
  fiscalText(party.legalName, 200, 'legalName');
  if (party.address !== undefined) fiscalText(party.address, 300, 'address');
  if (party.identityType === '6') fiscalRuc(party.identityNumber, 'identityNumber');
  else if (!(typeof party.identityNumber === 'string' && ((party.identityType === '1' && /^\d{8}$/.test(party.identityNumber) && party.identityNumber !== '00000000') ||
    (party.identityType === '0' && party.identityNumber === '0')))) fiscalFail('Cliente fuera del perfil RUC/DNI/sin identificar');
}
/** Validador propio, sin invocar/adaptar gates QA. RUC estructural no implica consulta a SUNAT. */
export function validateFiscalOriginal(original: FiscalDocumentSnapshot, asOf: string): void {
  fiscalObject(original, DOCUMENT_KEYS, 'original');
  if (!['01', '03'].includes(original.documentTypeCode) || original.environment !== 'BETA' ||
    original.currencyCode !== 'PEN' || original.operationTypeCode !== '0101') fiscalFail('Original fuera de BETA/PEN/01-03/IGV18');
  fiscalIdentity({ documentId: original.documentId, series: original.series, number: original.number, issueDate: original.issueDate }, original.documentTypeCode === '01' ? 'F' : 'B', asOf);
  if (original.fullNumber !== `${original.series}-${original.number}`) fiscalFail('fullNumber no coincide con serie/correlativo');
  if (original.companyId !== undefined && (!Number.isSafeInteger(original.companyId) || original.companyId < 1)) fiscalFail('companyId inválido');
  if (original.branchId !== undefined) fiscalUuid(original.branchId, 'branchId');
  validateParty(original.issuer, true); validateParty(original.customer, false);
  if (original.issuer.identityType !== '6' || typeof original.issuer.ubigeo !== 'string' || !/^\d{6}$/.test(original.issuer.ubigeo) || original.issuer.ubigeo === '000000' ||
    typeof original.issuer.establishmentCode !== 'string' || !/^\d{4}$/.test(original.issuer.establishmentCode)) fiscalFail('Emisor/ubigeo/establecimiento inválido');
  if (original.issuer.tradeName !== undefined) fiscalText(original.issuer.tradeName, 200, 'tradeName');
  fiscalText(original.issuer.address, 300, 'issuer.address');
  if (original.documentTypeCode === '01' && original.customer.identityType !== '6') fiscalFail('Factura requiere cliente RUC');
  if (original.paymentTerms !== undefined) {
    fiscalObject(original.paymentTerms, ['type'], 'paymentTerms');
    if (original.paymentTerms.type !== 'CONTADO') fiscalFail('Crédito/cuotas sin semántica de ajuste soportada');
  } else if (original.documentTypeCode === '01') fiscalFail('Factura requiere contado explícito; pago ausente no acredita contado');
  fiscalArray(original.lines, 100, 'original.lines');
  if (!original.lines.length) fiscalFail('Original requiere 1..100 líneas');
  for (const [i, line] of original.lines.entries()) {
    fiscalObject(line, LINE_KEYS, `lines[${i}]`); fiscalText(line.description, 500, 'description');
    if (line.productCode !== undefined) fiscalText(line.productCode, 100, 'productCode');
    if (line.lineNumber !== i + 1 || !['GLL', 'LTR', 'NIU', 'KGM', 'M3', 'HUR', 'ZZ'].includes(line.unitCode) ||
      line.taxAffectationCode !== '10' || !['18', '18.00'].includes(line.igvRate)) fiscalFail('Línea/unidad/IGV fuera del perfil');
    fiscalDecimal(line.quantity, 6, true, 'quantity'); fiscalDecimal(line.unitPriceWithTax, 6, true, 'unitPriceWithTax');
    const calculated = calculateTaxLine(line);
    for (const key of ['unitValue', 'lineExtensionAmount', 'igvAmount', 'totalAmount'] as const) {
      const scale = key === 'unitValue' ? 6 : 2;
      if (fiscalDecimal(line[key], scale, key === 'totalAmount', key) !== parseDecimal(calculated[key], scale)) fiscalFail(`${key}: cálculo original inválido`);
    }
  }
  fiscalObject(original.totals, MONEY_KEYS, 'totals');
  const expected = totalsFor(original.lines);
  for (const key of MONEY_KEYS) if (fiscalDecimal(original.totals[key], 2, key === 'payableAmount', key) !== parseDecimal(expected[key], 2)) fiscalFail(`${key}: suma original inválida`);
  if (original.customer.identityType === '0' && parseDecimal(original.totals.payableAmount, 2) > 70000n) fiscalFail('Boleta superior a PEN700 requiere identificación');
}

/** Evidencia explícita de un CDR ya verificado por caller; no verifica su firma ni sus bytes aquí. */
export function validateFiscalAcceptance(document: FiscalDocumentSnapshot | FiscalNoteSnapshot, evidence: FiscalAcceptanceEvidence, asOf: string): void {
  fiscalObject(evidence, ['environment', 'issuerRuc', 'documentId', 'documentTypeCode', 'fullNumber', 'snapshotSha256', 'cdrSha256', 'status', 'responseCode', 'acceptedAt', 'source'], 'acceptance');
  if (evidence.environment !== 'BETA' || document.environment !== 'BETA' || evidence.issuerRuc !== document.issuer.identityNumber ||
    evidence.documentId !== document.documentId || evidence.documentTypeCode !== document.documentTypeCode || evidence.fullNumber !== document.fullNumber ||
    evidence.snapshotSha256 !== fiscalSnapshotSha256(document) || !/^[a-f0-9]{64}$/.test(evidence.cdrSha256) ||
    !['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS'].includes(evidence.status) || evidence.responseCode !== '0') fiscalFail('Se requiere original aceptado con evidencia explícita ligada al snapshot');
  fiscalTimestamp(evidence.acceptedAt, 'acceptedAt'); fiscalTimestamp(asOf, 'asOf');
  if (Date.parse(evidence.acceptedAt) < Date.parse(document.issueDate) || Date.parse(evidence.acceptedAt) > Date.parse(asOf)) fiscalFail('Fecha de aceptación inválida');
  const source = evidence.source;
  const isReceipt = document.documentTypeCode === '03' || (document.documentTypeCode !== '01' && document.series.startsWith('B'));
  fiscalObject(source, isReceipt ? ['kind', 'identifier', 'referenceDate', 'lineNumber', 'conditionCode'] : ['kind'], 'acceptance.source');
  if (!isReceipt) {
    if (source.kind !== 'CDR_DOCUMENT') fiscalFail('Factura/nota F requiere CDR de documento');
  } else {
    if (source.kind !== 'CDR_SUMMARY' || !/^RC-\d{8}-[1-9]\d{0,4}$/.test(source.identifier) ||
      !Number.isSafeInteger(source.lineNumber) || source.lineNumber < 1 || source.lineNumber > 500 || !['1', '2'].includes(source.conditionCode))
      fiscalFail('Boleta/nota B requiere evidencia de pertenencia a RC aceptado');
    fiscalDate(source.referenceDate, 'acceptance.referenceDate');
    const compact = source.identifier.slice(3, 11), issue = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6)}`;
    fiscalDate(issue, 'acceptance.identifier');
    if (source.referenceDate !== fiscalLimaDate(document.issueDate) || issue < source.referenceDate || issue > fiscalLimaDate(evidence.acceptedAt)) fiscalFail('RC aceptado no corresponde a fecha del documento');
  }
}
function totalsFor(lines: FiscalLineSnapshot[]): FiscalNoteSnapshot['totals'] {
  return { taxableAmount: addMoney(lines.filter(l => l.taxAffectationCode === '10').map(l => l.lineExtensionAmount)),
    unaffectedAmount: addMoney(lines.filter(l => l.taxAffectationCode === '30').map(l => l.lineExtensionAmount)),
    igvAmount: addMoney(lines.map(l => l.igvAmount)), payableAmount: addMoney(lines.map(l => l.totalAmount)) };
}
function parseAdjustment(value: unknown): FiscalNoteInput {
  fiscalObject(value, ['documentTypeCode', 'reasonCode', 'reasonDescription', 'lines', 'interestNature', 'interestBasis'], 'adjustment');
  const credit = value.documentTypeCode === '07', debit = value.documentTypeCode === '08';
  if (!(credit && ['01', '06', '07', '05', '09'].includes(String(value.reasonCode))) && !(debit && ['01', '02'].includes(String(value.reasonCode))))
    fiscalFail('Motivo fuera del perfil fiscal; no se aproxima su semántica');
  fiscalText(value.reasonDescription, 250, 'reasonDescription');
  const full = credit && ['01', '06'].includes(String(value.reasonCode)), mora = debit && value.reasonCode === '01';
  fiscalObject(value, ['documentTypeCode', 'reasonCode', 'reasonDescription', ...(!full ? ['lines'] : []), ...(mora ? ['interestNature', 'interestBasis'] : [])], 'adjustment');
  if (mora) {
    if (value.interestNature !== 'MORATORIO') fiscalFail('Mora requiere naturaleza MORATORIO explícita');
    fiscalText(value.interestBasis, 500, 'interestBasis');
  }
  if (!full) {
    fiscalArray(value.lines, 100, 'adjustment.lines');
    if (!value.lines.length) fiscalFail('Ajuste requiere 1..100 líneas');
    const seen = new Set<number>();
    for (const line of value.lines) {
      const field = mora ? 'interestAmount' : credit && value.reasonCode === '07' ? 'quantity' : 'unitPriceAdjustmentWithTax';
      fiscalObject(line, ['originalLineNumber', field], 'adjustment.line');
      if (!Number.isSafeInteger(line.originalLineNumber) || Number(line.originalLineNumber) < 1 || seen.has(Number(line.originalLineNumber))) fiscalFail('Referencia de línea inválida/duplicada');
      seen.add(Number(line.originalLineNumber)); fiscalDecimal(line[field], mora ? 2 : 6, true, field);
    }
  }
  return structuredClone(value) as FiscalNoteInput;
}

/** Suma por línea de créditos validados, tanto reservados como aceptados. No netea débitos. */
export function assertFiscalCreditCapacity(original: FiscalDocumentSnapshot, credits: FiscalNoteSnapshot[]): void {
  const ids = new Set<string>(), numbers = new Set<string>();
  for (const note of credits) {
    if (note.documentTypeCode !== '07' || note.reference.documentId !== original.documentId || note.reference.snapshotSha256 !== fiscalSnapshotSha256(original) ||
      note.issuer.identityNumber !== original.issuer.identityNumber || ids.has(note.documentId) || numbers.has(note.fullNumber)) fiscalFail('Historial de créditos duplicado o ajeno al original');
    ids.add(note.documentId); numbers.add(note.fullNumber);
  }
  for (const source of original.lines) {
    const items = credits.flatMap(note => note.lines.filter(l => l.originalLineNumber === source.lineNumber).map(line => ({ note, line })));
    const returns = items.filter(({ note }) => ['01', '06', '07'].includes(note.reasonCode));
    const reductions = items.filter(({ note }) => ['05', '09'].includes(note.reasonCode));
    if (returns.length && reductions.length) fiscalFail('Mezcla de devolución y ajuste de valor sin semántica de saldo soportada');
    if (returns.reduce((sum, { line }) => sum + parseDecimal(line.quantity), 0n) > parseDecimal(source.quantity)) fiscalFail('Sobreacreditación de cantidad original');
    for (const key of ['lineExtensionAmount', 'igvAmount', 'totalAmount'] as const)
      if (items.reduce((sum, { line }) => sum + parseDecimal(line[key], 2), 0n) > parseDecimal(source[key], 2)) fiscalFail(`Sobreacreditación de ${key} original`);
    if (reductions.reduce((sum, { line }) => sum + parseDecimal(line.unitPriceWithTax), 0n) > parseDecimal(source.unitPriceWithTax)) fiscalFail('Sobreacreditación de valor unitario original');
  }
  for (const key of MONEY_KEYS) if (credits.reduce((sum, note) => sum + parseDecimal(note.totals[key], 2), 0n) > parseDecimal(original.totals[key], 2)) fiscalFail(`Sobreacreditación de ${key} total`);
}
function buildNote(context: FiscalNoteContext, input: FiscalNoteInput, identity: FiscalDocumentIdentity, prior: FiscalNoteSnapshot[]): FiscalNoteSnapshot {
  const original = context.original;
  fiscalIdentity(identity, original.documentTypeCode === '01' ? 'F' : 'B', context.asOf);
  if (identity.documentId === original.documentId || Date.parse(identity.issueDate) < Date.parse(context.acceptance.acceptedAt) ||
    prior.some(note => note.documentId === identity.documentId || (input.documentTypeCode === '07' && note.fullNumber === `${identity.series}-${identity.number}`) || Date.parse(note.issueDate) > Date.parse(identity.issueDate)))
    fiscalFail('Identidad/fecha de nota no corresponde al original aceptado e historial');
  if (input.documentTypeCode === '07' && input.reasonCode === '05' && original.documentTypeCode !== '01') fiscalFail('Motivo 05 sólo admite factura 01');
  const full = input.documentTypeCode === '07' && ['01', '06'].includes(input.reasonCode);
  const selection = full ? original.lines.map(l => ({ originalLineNumber: l.lineNumber })) : 'lines' in input ? input.lines : [];
  const lines = selection.map((selected, index) => {
    const source = original.lines.find(l => l.lineNumber === selected.originalLineNumber);
    if (!source) fiscalFail('Referencia de línea no pertenece al original');
    const item = selected as { quantity?: string; unitPriceAdjustmentWithTax?: string; interestAmount?: string };
    let quantity = source.quantity, price = source.unitPriceWithTax;
    const mora = input.documentTypeCode === '08' && input.reasonCode === '01';
    if (mora) { quantity = '1'; price = item.interestAmount!; }
    else if (!full && input.documentTypeCode === '07' && input.reasonCode === '07') {
      quantity = item.quantity!;
      if (parseDecimal(quantity) > parseDecimal(source.quantity)) fiscalFail('Cantidad superior a la original');
    } else if (!full) {
      price = item.unitPriceAdjustmentWithTax!;
      if (input.documentTypeCode === '07' && parseDecimal(price) > parseDecimal(source.unitPriceWithTax)) fiscalFail('Reducción superior al precio original');
    }
    const calculated = full ? { unitValue: source.unitValue, lineExtensionAmount: source.lineExtensionAmount, igvAmount: source.igvAmount, totalAmount: source.totalAmount } :
      mora ? { unitValue: formatScaled(parseDecimal(price), 6), lineExtensionAmount: formatScaled(parseDecimal(price, 2), 2), igvAmount: '0.00', totalAmount: formatScaled(parseDecimal(price, 2), 2) } :
      calculateTaxLine({ quantity, unitPriceWithTax: price, igvRate: '18' });
    fiscalDecimal(calculated.totalAmount, 2, true, 'totalAmount');
    fiscalDecimal(calculated.lineExtensionAmount, 2, false, 'lineExtensionAmount'); fiscalDecimal(calculated.igvAmount, 2, false, 'igvAmount');
    return { ...(mora ? { description: `Intereses moratorios: ${source.description}`, unitCode: 'ZZ' } : { ...(source.productCode === undefined ? {} : { productCode: source.productCode }), description: source.description, unitCode: source.unitCode }),
      lineNumber: index + 1, originalLineNumber: source.lineNumber, quantity, unitPriceWithTax: price,
      taxAffectationCode: mora ? '30' : '10', igvRate: mora ? '0' : '18', ...calculated };
  });
  const note: FiscalNoteSnapshot = {
    ...(original.companyId !== undefined ? { companyId: original.companyId } : {}), ...(original.branchId !== undefined ? { branchId: original.branchId } : {}),
    documentId: identity.documentId, documentTypeCode: input.documentTypeCode, environment: 'BETA', profile: FISCAL_NOTE_PROFILE,
    series: identity.series, number: identity.number, fullNumber: `${identity.series}-${identity.number}`, issueDate: identity.issueDate,
    currencyCode: 'PEN', operationTypeCode: '0101', issuer: structuredClone(original.issuer), customer: structuredClone(original.customer),
    reasonCode: input.reasonCode, reasonDescription: input.reasonDescription, adjustment: structuredClone(input),
    reference: { documentId: original.documentId, documentTypeCode: original.documentTypeCode as '01' | '03', fullNumber: original.fullNumber, issueDate: original.issueDate, snapshotSha256: fiscalSnapshotSha256(original) },
    originalAcceptance: structuredClone(context.acceptance), creditHistoryIds: prior.map(n => n.documentId), lines, totals: totalsFor(lines),
  };
  if (input.documentTypeCode === '07' && input.reasonCode === '07' &&
    lines.length === original.lines.length && lines.every(l => parseDecimal(l.quantity) === parseDecimal(original.lines[l.originalLineNumber - 1].quantity)))
    fiscalFail('Devolución parcial 07 debe ser parcial; use motivo 06 para devolución total');
  for (const key of [...MONEY_KEYS, 'unaffectedAmount'] as const) fiscalDecimal(note.totals[key], 2, key === 'payableAmount', key);
  if (note.documentTypeCode === '07') assertFiscalCreditCapacity(original, [...prior, note]);
  return note;
}
function validateNoteShape(note: FiscalNoteSnapshot): void {
  fiscalObject(note, [...DOCUMENT_KEYS.filter(k => k !== 'paymentTerms'), 'profile', 'reasonCode', 'reasonDescription', 'adjustment', 'reference', 'originalAcceptance', 'creditHistoryIds'], 'note');
  fiscalArray(note.lines, 100, 'note.lines'); fiscalArray(note.creditHistoryIds, 100, 'note.creditHistoryIds');
  if (!['07', '08'].includes(note.documentTypeCode) || note.profile !== FISCAL_NOTE_PROFILE || !note.lines.length) fiscalFail('Snapshot de nota fuera del perfil');
  fiscalObject(note.reference, ['documentId', 'documentTypeCode', 'fullNumber', 'issueDate', 'snapshotSha256'], 'reference');
  fiscalObject(note.totals, [...MONEY_KEYS, 'unaffectedAmount'], 'note.totals');
  for (const line of note.lines) fiscalObject(line, [...LINE_KEYS, 'originalLineNumber'], 'note.line');
  validateParty(note.issuer, true); validateParty(note.customer, false);
}
function validateContext(context: FiscalNoteContext): FiscalNoteSnapshot[] {
  fiscalObject(context, ['original', 'acceptance', 'asOf', 'creditHistory'], 'context');
  validateFiscalOriginal(context.original, context.asOf); validateFiscalAcceptance(context.original, context.acceptance, context.asOf);
  fiscalObject(context.creditHistory, ['complete', 'entries'], 'creditHistory');
  fiscalArray(context.creditHistory.entries, 100, 'creditHistory.entries');
  if (context.creditHistory.complete !== true) fiscalFail('Historial completo explícito de créditos requerido (máx.100)');
  const prior: FiscalNoteSnapshot[] = [];
  for (const entry of context.creditHistory.entries) {
    fiscalObject(entry, ['state', 'note'], 'creditHistory.entry');
    if (!['ACCEPTED', 'RESERVED'].includes(entry.state)) fiscalFail('Historial sólo admite créditos aceptados o reservados');
    validateNoteShape(entry.note);
    if (entry.note.documentTypeCode !== '07') fiscalFail('Historial requiere notas de crédito');
    const expected = buildNote(context, parseAdjustment(entry.note.adjustment), noteIdentity(entry.note), prior);
    fiscalEqual(entry.note, expected, 'creditHistory.note'); prior.push(expected);
  }
  return prior;
}
function noteIdentity(note: FiscalNoteSnapshot): FiscalDocumentIdentity {
  return { documentId: note.documentId, series: note.series, number: note.number, issueDate: note.issueDate };
}
export function buildFiscalNoteSnapshot(context: FiscalNoteContext, input: FiscalNoteInput, identity: FiscalDocumentIdentity): FiscalNoteSnapshot {
  const prior = validateContext(context); return buildNote(context, parseAdjustment(input), identity, prior);
}
export function validateFiscalNoteSnapshot(note: FiscalNoteSnapshot, context: FiscalNoteContext): void {
  validateNoteShape(note);
  fiscalEqual(note, buildFiscalNoteSnapshot(context, note.adjustment, noteIdentity(note)), 'note');
}

export const FISCAL_XML_NAMESPACES = 'xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"';
export const FISCAL_XML_EXTENSION = '<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions>';
export function fiscalSignatureXml(issuer: FiscalDocumentSnapshot['issuer']): string {
  return `<cac:Signature><cbc:ID>signatureFactuEz</cbc:ID><cac:SignatoryParty><cac:PartyIdentification><cbc:ID>${issuer.identityNumber}</cbc:ID></cac:PartyIdentification><cac:PartyName><cbc:Name>${fiscalXml(issuer.legalName)}</cbc:Name></cac:PartyName></cac:SignatoryParty><cac:DigitalSignatureAttachment><cac:ExternalReference><cbc:URI>#signatureFactuEz</cbc:URI></cac:ExternalReference></cac:DigitalSignatureAttachment></cac:Signature>`;
}
export function fiscalAmountXml(tag: string, value: string): string { return `<cbc:${tag} currencyID="PEN">${value}</cbc:${tag}>`; }
export function fiscalTaxXml(base: string, tax: string, unaffected: boolean, line = false): string {
  const scheme = unaffected ? ['9998', 'INA', 'FRE'] : ['1000', 'IGV', 'VAT'];
  return `<cac:TaxTotal>${fiscalAmountXml('TaxAmount', tax)}<cac:TaxSubtotal>${fiscalAmountXml('TaxableAmount', base)}${fiscalAmountXml('TaxAmount', tax)}<cac:TaxCategory>${line ? `<cbc:Percent>${unaffected ? '0' : '18'}</cbc:Percent><cbc:TaxExemptionReasonCode listAgencyName="PE:SUNAT" listName="Afectacion del IGV" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo07">${unaffected ? '30' : '10'}</cbc:TaxExemptionReasonCode>` : ''}<cac:TaxScheme><cbc:ID schemeAgencyName="PE:SUNAT" schemeName="Codigo de tributos" schemeURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo05">${scheme[0]}</cbc:ID><cbc:Name>${scheme[1]}</cbc:Name><cbc:TaxTypeCode>${scheme[2]}</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>`;
}
export function fiscalBillingReferenceXml(reference: FiscalNoteSnapshot['reference']): string {
  return `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${fiscalXml(reference.fullNumber)}</cbc:ID><cbc:DocumentTypeCode listAgencyName="PE:SUNAT" listName="Tipo de Documento" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo01">${reference.documentTypeCode}</cbc:DocumentTypeCode></cac:InvoiceDocumentReference></cac:BillingReference>`;
}
/** XML REAL sin firmar. ExtensionContent vacío es el punto de firma, no evidencia de firma. */
export function buildFiscalNoteUbl(note: FiscalNoteSnapshot, context: FiscalNoteContext): string {
  validateFiscalNoteSnapshot(note, context);
  const root = note.documentTypeCode === '07' ? 'CreditNote' : 'DebitNote';
  const quantityTag = note.documentTypeCode === '07' ? 'CreditedQuantity' : 'DebitedQuantity';
  const monetary = note.documentTypeCode === '07' ? 'LegalMonetaryTotal' : 'RequestedMonetaryTotal';
  const party = (kind: string, value: FiscalPartySnapshot, supplier = false) => `<cac:${kind}><cac:Party><cac:PartyIdentification><cbc:ID schemeID="${value.identityType}" schemeName="Documento de Identidad" schemeAgencyName="PE:SUNAT" schemeURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo06">${value.identityNumber}</cbc:ID></cac:PartyIdentification><cac:PartyLegalEntity><cbc:RegistrationName>${fiscalXml(value.legalName)}</cbc:RegistrationName>${supplier ? `<cac:RegistrationAddress><cbc:ID schemeAgencyName="PE:INEI" schemeName="Ubigeos">${note.issuer.ubigeo}</cbc:ID><cbc:AddressTypeCode>${note.issuer.establishmentCode}</cbc:AddressTypeCode>${note.issuer.address ? `<cac:AddressLine><cbc:Line>${fiscalXml(note.issuer.address)}</cbc:Line></cac:AddressLine>` : ''}<cac:Country><cbc:IdentificationCode>PE</cbc:IdentificationCode></cac:Country></cac:RegistrationAddress>` : ''}</cac:PartyLegalEntity></cac:Party></cac:${kind}>`;
  const lines = note.lines.map(line => `<cac:${root}Line><cbc:ID>${line.lineNumber}</cbc:ID><cbc:${quantityTag} unitCode="${line.unitCode}">${line.quantity}</cbc:${quantityTag}>${fiscalAmountXml('LineExtensionAmount', line.lineExtensionAmount)}<cac:PricingReference><cac:AlternativeConditionPrice>${fiscalAmountXml('PriceAmount', line.unitPriceWithTax)}<cbc:PriceTypeCode>01</cbc:PriceTypeCode></cac:AlternativeConditionPrice></cac:PricingReference>${fiscalTaxXml(line.lineExtensionAmount, line.igvAmount, line.taxAffectationCode === '30', true)}<cac:Item><cbc:Description>${fiscalXml(line.description)}</cbc:Description>${line.productCode !== undefined ? `<cac:SellersItemIdentification><cbc:ID>${fiscalXml(line.productCode)}</cbc:ID></cac:SellersItemIdentification>` : ''}</cac:Item><cac:Price>${fiscalAmountXml('PriceAmount', line.unitValue)}</cac:Price></cac:${root}Line>`).join('');
  const unaffected = note.documentTypeCode === '08' && note.reasonCode === '01';
  const base = addMoney([note.totals.taxableAmount, note.totals.unaffectedAmount]);
  return `<?xml version="1.0" encoding="UTF-8"?><${root} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2" ${FISCAL_XML_NAMESPACES}>${FISCAL_XML_EXTENSION}<cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:CustomizationID>2.0</cbc:CustomizationID><cbc:ID>${note.fullNumber}</cbc:ID><cbc:IssueDate>${fiscalLimaDate(note.issueDate)}</cbc:IssueDate><cbc:DocumentCurrencyCode listID="ISO 4217" listName="Currency" listAgencyName="United Nations Economic Commission for Europe">PEN</cbc:DocumentCurrencyCode><cac:DiscrepancyResponse><cbc:ReferenceID>${note.reference.fullNumber}</cbc:ReferenceID><cbc:ResponseCode listAgencyName="PE:SUNAT" listName="${note.documentTypeCode === '07' ? 'Tipo de nota de credito' : 'Tipo de nota de debito'}" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo${note.documentTypeCode === '07' ? '09' : '10'}">${note.reasonCode}</cbc:ResponseCode><cbc:Description>${fiscalXml(note.reasonDescription)}</cbc:Description></cac:DiscrepancyResponse>${fiscalBillingReferenceXml(note.reference)}${fiscalSignatureXml(note.issuer)}${party('AccountingSupplierParty', note.issuer, true)}${party('AccountingCustomerParty', note.customer)}${fiscalTaxXml(base, note.totals.igvAmount, unaffected)}<cac:${monetary}>${fiscalAmountXml('LineExtensionAmount', base)}${fiscalAmountXml('TaxExclusiveAmount', base)}${fiscalAmountXml('TaxInclusiveAmount', note.totals.payableAmount)}${fiscalAmountXml('PayableAmount', note.totals.payableAmount)}</cac:${monetary}>${lines}</${root}>`;
}
