import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';

export class HistoryError extends Error {
  constructor(readonly code: string) { super(`Historial aislado: ${code}`); delete this.stack; }
}
export function assertHistory(ok: unknown, code: string): asserts ok { if (!ok) throw new HistoryError(code); }
export const HISTORY_FULL_LIMITS = Object.freeze({ rows: 2_000, items: 100, mappings: 1_000, batchSize: 50,
  jsonBytes: 16 * 1024 * 1024, artifactBytes: 16 * 1024 * 1024, totalArtifactBytes: 128 * 1024 * 1024 });

/** Bounded detached JSON BEFORE any serialization/hash. Accessors/proxies never execute. */
export function historyJson(input: unknown): any {
  let nodes = 0, bytes = 0;
  function visit(value: unknown, depth: number): any {
    assertHistory(depth <= 12 && ++nodes <= 400_000, 'JSON_LIMIT');
    if (value === null || typeof value === 'boolean') { bytes += 5; return value; }
    if (typeof value === 'number') { assertHistory(Number.isSafeInteger(value), 'INVALID_NUMBER'); bytes += 24; return value; }
    if (typeof value === 'string') {
      assertHistory(value.length <= 16_000, 'JSON_LIMIT');
      bytes += Buffer.byteLength(JSON.stringify(value), 'utf8');
      assertHistory(bytes <= HISTORY_FULL_LIMITS.jsonBytes, 'JSON_LIMIT'); return value; }
    assertHistory(value && typeof value === 'object' && !isProxy(value), 'INVALID_JSON');
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    assertHistory(array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null, 'INVALID_JSON');
    const keys = Reflect.ownKeys(value);
    if (array) assertHistory((value as unknown[]).length <= 10_000 && keys.length === (value as unknown[]).length + 1, 'INVALID_ARRAY');
    const out: any = array ? [] : Object.create(null);
    for (const key of keys) {
      if (array && key === 'length') continue;
      assertHistory(typeof key === 'string' && key.length <= 100 && !['__proto__', 'constructor', 'prototype'].includes(key), 'INVALID_JSON');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      assertHistory(descriptor?.enumerable && 'value' in descriptor, 'INVALID_JSON');
      if (array) assertHistory(/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < (value as unknown[]).length, 'INVALID_ARRAY');
      bytes += Buffer.byteLength(JSON.stringify(key)) + 2; out[key] = visit(descriptor.value, depth + 1);
    }
    assertHistory(bytes <= HISTORY_FULL_LIMITS.jsonBytes, 'JSON_LIMIT');
    return out;
  }
  return visit(input, 0);
}
export function historyObject(value: any, keys: readonly string[]): Record<string, any> {
  assertHistory(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)), 'INVALID_FIELDS'); return value;
}
export function historyText(value: unknown, max: number, expression?: RegExp): string {
  assertHistory(typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim() &&
    !/[\x00-\x1f\x7f]/.test(value) && (!expression || expression.test(value)), 'INVALID_TEXT'); return value;
}
export const historyUuid = (v: unknown) => historyText(v, 36, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i).toLowerCase();
export const historySha = (v: unknown) => historyText(v, 64, /^[0-9a-f]{64}$/i).toLowerCase();
export function historyInteger(v: unknown, max: number, min = 1): number {
  assertHistory(typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max, 'INVALID_INTEGER'); return v;
}
function list(v: unknown, max: number): any[] { assertHistory(Array.isArray(v) && v.length <= max, 'INVALID_LIST'); return v; }
function nullable(v: unknown, max: number): string | null { return v === null ? null : historyText(v, max); }
function decimal(v: unknown, scale = 2, positive = false): string {
  const value = historyText(v, 25, scale === 2 ? /^(0|[1-9][0-9]{0,15})(\.[0-9]{1,2})?$/ : /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/);
  const [whole, fraction = ''] = value.split('.'), normalized = `${whole}.${fraction.padEnd(scale, '0')}`;
  if (positive) assertHistory(BigInt(whole + fraction.padEnd(scale, '0')) > 0n, 'ZERO_QUANTITY'); return normalized;
}
const cents = (v: string) => BigInt(v.replace('.', ''));
export const AMOUNT_KEYS = ['taxableAmount', 'exemptAmount', 'unaffectedAmount', 'freeAmount', 'discountTotal', 'igvAmount', 'iscAmount', 'otherTaxesAmount', 'payableAmount'] as const;
export type HistoricalAmounts = Readonly<Record<typeof AMOUNT_KEYS[number], string>>;
function amounts(v: any): HistoricalAmounts {
  historyObject(v, AMOUNT_KEYS);
  const result = Object.fromEntries(AMOUNT_KEYS.map(k => [k, decimal(v[k])])) as Record<typeof AMOUNT_KEYS[number], string>;
  assertHistory(cents(result.payableAmount) === ['taxableAmount', 'exemptAmount', 'unaffectedAmount', 'igvAmount', 'iscAmount', 'otherTaxesAmount']
    .reduce((sum, k) => sum + cents(result[k as keyof HistoricalAmounts]), 0n), 'PAYABLE_MISMATCH'); return result;
}
function date(v: unknown, withZone = true): string {
  const value = historyText(v, 35, withZone ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/ : /^\d{4}-\d{2}-\d{2}$/);
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  assertHistory(year >= 1900 && calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day, 'INVALID_DATE');
  if (withZone) {
    const hour = Number(value.slice(11, 13)), minute = Number(value.slice(14, 16)), second = Number(value.slice(17, 19));
    const zone = value.match(/([+-])(\d{2}):(\d{2})$/);
    assertHistory(hour <= 23 && minute <= 59 && second <= 59 && Number.isFinite(Date.parse(value)) &&
      (!zone || Number(zone[2]) <= 14 && Number(zone[3]) <= 59 && (Number(zone[2]) !== 14 || Number(zone[3]) === 0)), 'INVALID_DATE');
  }
  return value;
}
export const HISTORY_TYPES = ['01', '03', '07', '08'] as const;
export type HistoricalType = typeof HISTORY_TYPES[number];
function type(v: unknown): HistoricalType { assertHistory(HISTORY_TYPES.includes(v as HistoricalType), 'INVALID_TYPE'); return v as HistoricalType; }
function series(v: unknown, t: HistoricalType) {
  const s = historyText(v, 4, /^[FB][A-Z0-9]{3}$/); assertHistory(t !== '01' || s.startsWith('F'), 'SERIES_TYPE');
  assertHistory(t !== '03' || s.startsWith('B'), 'SERIES_TYPE'); return s;
}
function ruc(v: unknown) { return historyText(v, 11, /^00000000[0-9]{3}$/); } // Synthetic namespace ONLY, not SUNAT RUC validation.
function number(v: unknown) { return historyText(v, 8, /^[1-9][0-9]{0,7}$/); }
const mappingKeys = ['mappingId', 'issuerRuc', 'companyId', 'branchId', 'emissionPointId', 'seriesCounterId', 'documentTypeCode', 'series'] as const;
function mapping(v: any) {
  historyObject(v, mappingKeys); const documentTypeCode = type(v.documentTypeCode);
  return { mappingId: historyUuid(v.mappingId), issuerRuc: ruc(v.issuerRuc), companyId: historyInteger(v.companyId, 2_147_483_647),
    branchId: historyUuid(v.branchId), emissionPointId: historyUuid(v.emissionPointId), seriesCounterId: historyUuid(v.seriesCounterId),
    documentTypeCode, series: series(v.series, documentTypeCode) };
}
export type HistoryOwnerMapping = Readonly<ReturnType<typeof mapping>>;
export const HISTORY_ARTIFACT_KINDS = ['UNSIGNED_XML', 'SIGNED_XML', 'SUBMISSION_ZIP', 'CDR_XML', 'CDR_ZIP', 'PDF_TICKET_80MM', 'PDF_A4', 'DELIVERY_ZIP'] as const;
function artifact(v: any) {
  historyObject(v, ['kind', 'originalName', 'sha256', 'sizeBytes']);
  assertHistory(HISTORY_ARTIFACT_KINDS.includes(v.kind), 'INVALID_ARTIFACT');
  const kind: typeof HISTORY_ARTIFACT_KINDS[number] = v.kind, originalName = historyText(v.originalName, 255);
  const extension = kind.endsWith('_XML') ? '.xml' : kind.startsWith('PDF_') ? '.pdf' : '.zip';
  assertHistory(originalName.toLowerCase().endsWith(extension) && !/[\\/:*?"<>|]/.test(originalName) && !/[. ]$/.test(originalName) &&
    !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(originalName) &&
    !/(secret|password|credential|certificate|certificado)/i.test(originalName), 'INVALID_ARTIFACT_NAME');
  return { kind, originalName, sha256: historySha(v.sha256), sizeBytes: historyInteger(v.sizeBytes, HISTORY_FULL_LIMITS.artifactBytes) };
}
export type HistoricalArtifact = Readonly<ReturnType<typeof artifact>>;
const snapshotKeys = ['schemaVersion', 'environment', 'ownership', 'sourceDocumentId', 'originSystem', 'originId', 'number', 'issueDate', 'currencyCode', 'operationTypeCode',
  'issuer', 'customer', 'items', 'tax', 'amounts', 'paymentTerms', 'reference', 'vehiclePlate', 'amountInWords', 'observations', 'sourceEvidence', 'artifacts'] as const;
function snapshot(v: any) {
  historyObject(v, snapshotKeys);
  assertHistory(v.schemaVersion === 'factuez.history-document.v1' && v.environment === 'BETA' && v.originSystem === 'RESTOAPP', 'HISTORY_PROFILE_BLOCKED');
  const ownership = mapping(v.ownership), sourceDocumentId = historyUuid(v.sourceDocumentId), originId = historyText(v.originId, 120);
  const issueDate = date(v.issueDate), currencyCode = historyText(v.currencyCode, 3, /^(PEN|USD)$/), operationTypeCode = historyText(v.operationTypeCode, 4, /^[0-9]{4}$/);
  historyObject(v.issuer, ['ruc', 'legalName', 'tradeName', 'address', 'ubigeo', 'establishmentCode']);
  const issuer = { ruc: ruc(v.issuer.ruc), legalName: historyText(v.issuer.legalName, 200), tradeName: nullable(v.issuer.tradeName, 200),
    address: historyText(v.issuer.address, 300), ubigeo: historyText(v.issuer.ubigeo, 6, /^[0-9]{6}$/), establishmentCode: historyText(v.issuer.establishmentCode, 4, /^[0-9]{4}$/) };
  assertHistory(issuer.ruc === ownership.issuerRuc, 'ISSUER_MISMATCH');
  historyObject(v.customer, ['identityType', 'identityNumber', 'legalName', 'address', 'email']);
  const customer = { identityType: historyText(v.customer.identityType, 1, /^[01467AB]$/), identityNumber: historyText(v.customer.identityNumber, 15, /^[A-Z0-9-]+$/),
    legalName: historyText(v.customer.legalName, 250), address: nullable(v.customer.address, 300), email: nullable(v.customer.email, 254) };
  if (customer.email) assertHistory(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email), 'INVALID_EMAIL');
  const items = list(v.items, HISTORY_FULL_LIMITS.items).map((item, index) => {
    historyObject(item, ['lineNumber', 'productCode', 'description', 'unitCode', 'quantity', 'unitValue', 'unitPriceWithTax', 'taxAffectationCode', 'igvRate', 'amounts']);
    assertHistory(item.lineNumber === index + 1, 'LINE_ORDER');
    return { lineNumber: index + 1, productCode: nullable(item.productCode, 40), description: historyText(item.description, 250), unitCode: historyText(item.unitCode, 3, /^[A-Z0-9]{2,3}$/),
      quantity: decimal(item.quantity, 6, true), unitValue: decimal(item.unitValue, 6), unitPriceWithTax: decimal(item.unitPriceWithTax, 6),
      taxAffectationCode: historyText(item.taxAffectationCode, 2, /^[0-9]{2}$/), igvRate: decimal(item.igvRate), amounts: amounts(item.amounts) };
  });
  assertHistory(items.length > 0, 'EMPTY_ITEMS');
  const totals = amounts(v.amounts);
  for (const k of AMOUNT_KEYS) assertHistory(items.reduce((sum, item) => sum + cents(item.amounts[k]), 0n) === cents(totals[k]), 'LINE_TOTAL_MISMATCH');
  const tax = list(v.tax, 16).map(t => { historyObject(t, ['taxSchemeId', 'taxName', 'taxableAmount', 'taxAmount']);
    return { taxSchemeId: historyText(t.taxSchemeId, 4, /^[0-9]{4}$/), taxName: historyText(t.taxName, 20), taxableAmount: decimal(t.taxableAmount), taxAmount: decimal(t.taxAmount) }; }).sort((a,b) => a.taxSchemeId.localeCompare(b.taxSchemeId));
  assertHistory(new Set(tax.map(t => t.taxSchemeId)).size === tax.length && tax.reduce((sum,t) => sum + cents(t.taxAmount), 0n) ===
    cents(totals.igvAmount) + cents(totals.iscAmount) + cents(totals.otherTaxesAmount), 'TAX_TOTAL_MISMATCH');
  historyObject(v.paymentTerms, v.paymentTerms?.type === 'CONTADO' ? ['type'] : ['type', 'currencyCode', 'pendingAmount', 'installments']);
  const paymentTerms = v.paymentTerms.type === 'CONTADO' ? { type: 'CONTADO' as const } : (() => {
    assertHistory(v.paymentTerms.type === 'CREDITO' && v.paymentTerms.currencyCode === currencyCode, 'INVALID_PAYMENT');
    const pendingAmount = decimal(v.paymentTerms.pendingAmount), installments = list(v.paymentTerms.installments, 100).map(i => {
      historyObject(i, ['amount', 'dueDate']); return { amount: decimal(i.amount), dueDate: date(i.dueDate, false) }; });
    assertHistory(installments.length > 0 && cents(pendingAmount) > 0n && cents(pendingAmount) <= cents(totals.payableAmount) &&
      installments.every(i => cents(i.amount) > 0n) && installments.reduce((sum,i) => sum + cents(i.amount), 0n) === cents(pendingAmount), 'INSTALLMENTS_MISMATCH');
    return { type: 'CREDITO' as const, currencyCode, pendingAmount, installments };
  })();
  const reference = v.reference === null ? null : (() => {
    historyObject(v.reference, ['issuerRuc', 'documentTypeCode', 'series', 'number', 'reasonCode', 'reason']);
    const t = type(v.reference.documentTypeCode); assertHistory(t === '01' || t === '03', 'REFERENCE_TYPE');
    assertHistory(v.reference.issuerRuc === ownership.issuerRuc, 'REFERENCE_ISSUER');
    return { issuerRuc: ownership.issuerRuc, documentTypeCode: t, series: series(v.reference.series,t), number: number(v.reference.number), reasonCode: historyText(v.reference.reasonCode,2,/^[0-9]{2}$/), reason: historyText(v.reference.reason,250) };
  })();
  assertHistory(['07','08'].includes(ownership.documentTypeCode) ? reference !== null : reference === null, 'REFERENCE_REQUIRED');
  historyObject(v.sourceEvidence, ['declaredStatus', 'responseCode', 'description', 'authenticity']);
  assertHistory(['NOT_DECLARED', 'DECLARED_ACCEPTED', 'DECLARED_REJECTED', 'DECLARED_VOIDED'].includes(v.sourceEvidence.declaredStatus) && v.sourceEvidence.authenticity === 'NOT_VERIFIED', 'EVIDENCE_UNTRUSTED');
  const sourceEvidence = { declaredStatus: v.sourceEvidence.declaredStatus as string, responseCode: nullable(v.sourceEvidence.responseCode,20),
    description: nullable(v.sourceEvidence.description,1_000), authenticity: 'NOT_VERIFIED' as const };
  const artifacts = list(v.artifacts, 8).map(artifact).sort((a,b) => a.kind.localeCompare(b.kind));
  assertHistory(new Set(artifacts.map(a => a.kind)).size === artifacts.length, 'DUPLICATE_ARTIFACT_KIND');
  return { schemaVersion: 'factuez.history-document.v1' as const, environment: 'BETA' as const, ownership, sourceDocumentId,
    originSystem: 'RESTOAPP' as const, originId, number: number(v.number), issueDate, currencyCode, operationTypeCode,
    issuer, customer, items, tax, amounts: totals, paymentTerms, reference, vehiclePlate: nullable(v.vehiclePlate,15),
    amountInWords: nullable(v.amountInWords,500), observations: nullable(v.observations,2_000), sourceEvidence, artifacts };
}
export type HistoricalDocumentSnapshotV1 = Readonly<ReturnType<typeof snapshot>>;
function canonical(v: any): string { return Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ?
  `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v); }
/** Hash only detached JSON, validated by the function itself. */
export function historicalSha256(value: unknown) { return createHash('sha256').update(canonical(historyJson(value))).digest('hex'); }
function frozen<T>(v: T): T { if (v && typeof v === 'object') { Object.values(v).forEach(frozen); Object.freeze(v); } return v; }
export function validateHistoricalSnapshot(value: unknown) { return frozen(snapshot(historyJson(value))); }
export function prepareHistoricalImport(value: unknown) {
  const input = historyJson(value);
  historyObject(input, ['schemaVersion', 'environment', 'datasetClass', 'exportId', 'originSystem', 'mappings', 'documents']);
  assertHistory(input.schemaVersion === 'factuez.history-full.v1' && input.environment === 'BETA' && input.datasetClass === 'SYNTHETIC' && input.originSystem === 'RESTOAPP', 'HISTORY_PROFILE_BLOCKED');
  const exportId = historyUuid(input.exportId), mappings = list(input.mappings, HISTORY_FULL_LIMITS.mappings).map(mapping).sort((a,b) => a.mappingId.localeCompare(b.mappingId));
  const owners = new Map<string, string>(), mappingIds = new Map<string, HistoryOwnerMapping>();
  function owner(key: string, value: unknown) { const sha = historicalSha256(value); assertHistory(!owners.has(key) || owners.get(key) === sha, 'MAPPING_CONFLICT'); owners.set(key,sha); }
  for (const m of mappings) {
    assertHistory(!mappingIds.has(m.mappingId), 'DUPLICATE_MAPPING'); mappingIds.set(m.mappingId, m);
    owner(`company:${m.companyId}`, m.issuerRuc); owner(`ruc:${m.issuerRuc}`,m.companyId);
    owner(`branch:${m.branchId}`, [m.companyId,m.issuerRuc]); owner(`point:${m.emissionPointId}`,[m.branchId,m.companyId]);
    owner(`counter:${m.seriesCounterId}`,[m.emissionPointId,m.documentTypeCode,m.series]);
    owner(`series:${m.companyId}:${m.documentTypeCode}:${m.series}`,m.mappingId);
  }
  const documents = list(input.documents, HISTORY_FULL_LIMITS.rows).map(snapshot).sort((a,b) =>
    JSON.stringify([a.ownership.issuerRuc,a.ownership.documentTypeCode,a.ownership.series]).localeCompare(JSON.stringify([b.ownership.issuerRuc,b.ownership.documentTypeCode,b.ownership.series])) || Number(a.number) - Number(b.number));
  assertHistory(documents.length > 0 && mappings.length > 0, 'EMPTY_EXPORT');
  const fiscal = new Set<string>(), origin = new Set<string>(); let bytes = 0;
  const records = documents.map(document => {
    assertHistory(historicalSha256(mappingIds.get(document.ownership.mappingId) ?? null) === historicalSha256(document.ownership), 'MAPPING_MISMATCH');
    const fiscalKey = JSON.stringify([document.ownership.issuerRuc,document.ownership.documentTypeCode,document.ownership.series,document.number]);
    const originKey = JSON.stringify([document.ownership.companyId,document.originSystem,document.originId]);
    assertHistory(!fiscal.has(fiscalKey) && !origin.has(originKey), 'DUPLICATE_IDENTITY'); fiscal.add(fiscalKey); origin.add(originKey);
    for (const a of document.artifacts) bytes += a.sizeBytes;
    assertHistory(bytes <= HISTORY_FULL_LIMITS.totalArtifactBytes, 'ARTIFACT_BYTES_LIMIT');
    return { recordId: historicalSha256({ fiscalKey,originKey }), snapshotSha256: historicalSha256(document), snapshot: document };
  });
  const normalized = { schemaVersion: 'factuez.history-full.v1' as const, environment: 'BETA' as const, datasetClass: 'SYNTHETIC' as const,
    exportId, originSystem: 'RESTOAPP' as const, mappings, documents };
  const inputSha256 = historicalSha256(normalized), mappingSha256 = historicalSha256(mappings), batches = [];
  for (let i = 0; i < records.length; i += HISTORY_FULL_LIMITS.batchSize) {
    const batchRecords = records.slice(i,i + HISTORY_FULL_LIMITS.batchSize);
    batches.push({ index: batches.length, startOrdinal: i, count: batchRecords.length,
      recordsSha256: historicalSha256(batchRecords.map(r => ({ recordId: r.recordId, snapshotSha256: r.snapshotSha256 }))), records: batchRecords });
  }
  const planSha256 = historicalSha256({ inputSha256, mappingSha256, batchSize: HISTORY_FULL_LIMITS.batchSize,
    batches: batches.map(({records,...b}) => b), purpose: 'SYNTHETIC_QUARANTINED_ARCHIVE' });
  return frozen({ normalized, records, batches, inputSha256, mappingSha256, planSha256, jobId: exportId,
    candidateOnly: true as const, fiscalAuthority: false as const, cdrAuthenticityVerified: false as const, transmission: false as const, countersChanged: false as const });
}
export type HistoricalImportPlan = ReturnType<typeof prepareHistoricalImport>;
export { summarizeHistoricalSelection, compareHistoricalTotals } from './reconciliation';
export type { HistoryReconciliation } from './reconciliation';
