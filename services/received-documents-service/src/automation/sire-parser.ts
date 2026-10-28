import type { SirePurchase } from './sire-client';
import { SIRE_LIMITS, SireError, sireEnsure, sireUtf8, validateSireContext } from './sire-safety';

export type SirePurchaseIncident = {
  ordinal: number;
  code: 'SUPPLIER_IDENTITY_NOT_RUC' | 'CONSOLIDATED_RANGE' | 'DOCUMENT_IDENTITY' | 'RECORD_VALUE';
  rawRecord: Record<string, string>;
};
export type SirePurchaseBatch = { purchases: SirePurchase[]; incidents: SirePurchaseIncident[] };

/**
 * RCE proposal, Anexo 8 (RS 112-2021, incorporated by RS 040-2022), fields 1..26:
 * https://www.sunat.gob.pe/legislacion/superin/2022/anexo-040-2022.pdf
 * 1 recipient RUC, 2 recipient name, 3 period, 4 CAR, 5 issue date, 6 due date,
 * 7 CP type, 8 series, 9 customs year, 10 initial number, 11 final range number,
 * 12 supplier identity type, 13 supplier identity, 14 supplier name,
 * 15..24 tax bases/taxes, 25 Total CP, 26 Moneda; field 27 is exchange rate.
 * Manual API Compras v28 §§5.31/5.32/5.34 documents transport, NOT a reduced
 * invented record layout. Require headers and validate their official positions;
 * never infer columns from data or use the different PLE/RVIE layout.
 * Additional columns (up to 80) are retained as raw data, not fiscal evidence.
 */
export const SIRE_RCE_HEADERS = Object.freeze([
  'RUC', 'ID', 'Periodo', 'CAR SUNAT', 'Fecha de emisión', 'Fecha Vcto/Pago',
  'Tipo CP/Doc.', 'Serie del CDP', 'Año', 'Nro CP o Doc. Nro Inicial (Rango)',
  'Nro Final (Rango)', 'Tipo Doc Identidad', 'Nro Doc Identidad',
  'Apellidos Nombres/ Razón Social', 'BI Gravado DG', 'IGV / IPM DG',
  'BI Gravado DGNG', 'IGV / IPM DGNG', 'BI Gravado DNG', 'IGV / IPM DNG',
  'Valor Adq. NG', 'ISC', 'ICBPER', 'Otros Trib/ Cargos', 'Total CP', 'Moneda',
]);

const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]/g, '');
const aliases: readonly (readonly string[])[] = [
  ['RUC del Generador'], ['Apellidos y Nombres o Razón social', 'Razón Social'], [], [],
  ['Fecha de Emisión'], ['Fecha Vcto / Pago', 'Fecha de vencimiento'],
  ['Tipo CP/Doc', 'Tipo de CP o Doc.'], ['Serie del CP', 'Serie del comprobante'],
  ['Año de emisión de la DUA o DSI', 'Año de DAM o DSI o LC'],
  ['Nro CP o Doc. Nro Inicial (Rango) o DAM/DSI'], [],
  ['Tipo Doc. Identidad'], ['Nro Doc. Identidad'],
  ['Apellidos y Nombres o Razón Social del proveedor'], [], [], [], [], [], [], [], [], [],
  ['Otros Tributos', 'Otros Trib. Cargos'], ['Importe Total', 'Total del CP'],
  ['Código de Moneda'],
];
const allowedHeaders = SIRE_RCE_HEADERS.map((name, i) => new Set([name, ...aliases[i]].map(normalize)));

/** Strict quoted CSV/TXT reader, including quoted separators, quotes and newlines. */
function records(text: string, delimiter: string): string[][] {
  const result: string[][] = []; let row: string[] = [], field = '', quoted = false, closed = false;
  const addField = () => { row.push(field); field = ''; closed = false; sireEnsure(row.length <= SIRE_LIMITS.columns + 1, 'SIZE'); };
  const addRow = () => {
    addField();
    if (row.some(value => value !== '')) result.push(row);
    sireEnsure(result.length <= SIRE_LIMITS.rows + 1, 'SIZE'); row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; }
      } else field += char;
    } else if (char === delimiter) addField();
    else if (char === '\r' || char === '\n') { addRow(); if (char === '\r' && text[i + 1] === '\n') i++; }
    else if (char === '"') { sireEnsure(field === '' && !closed, 'FORMAT'); quoted = true; }
    else { sireEnsure(!closed, 'FORMAT'); field += char; }
    sireEnsure(field.length <= SIRE_LIMITS.fieldChars, 'SIZE');
  }
  sireEnsure(!quoted, 'FORMAT');
  if (field !== '' || row.length || closed) addRow();
  return result;
}

function issueDate(value: string): string {
  const date = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  sireEnsure(date || iso, 'FORMAT');
  const [year, month, day] = date ? [date[3], date[2], date[1]] : iso!.slice(1);
  const normalized = `${year}-${month}-${day}`;
  const parsed = new Date(`${normalized}T00:00:00Z`);
  sireEnsure(Number(year) >= 1000 && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === normalized, 'FORMAT');
  return normalized;
}

/** UTF-8 (optional BOM), pipe TXT or comma/semicolon CSV. No I/O or fiscal status. */
export function parseSirePurchaseBatch(bytes: Uint8Array, recipientRuc: string, period: string): SirePurchaseBatch {
  validateSireContext(recipientRuc, period);
  sireEnsure(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= SIRE_LIMITS.entryBytes, 'SIZE');
  const text = sireUtf8(bytes).replace(/^\uFEFF/, '');
  sireEnsure(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text), 'FORMAT');
  const firstLine = text.split(/\r?\n/, 1)[0];
  // The first official header is RUC, so separator detection is unambiguous.
  const delimiter = /^\s*"?RUC(?: del Generador)?"?\s*([|,;])/i.exec(firstLine)?.[1];
  sireEnsure(delimiter, 'FORMAT');
  const rows = records(text, delimiter), headers = rows.shift();
  // Strip one explicit terminator; never pad a truncated data row.
  if (delimiter === '|' && headers?.at(-1) === '') headers.pop();
  sireEnsure(headers && headers.length >= 26 && headers.length <= SIRE_LIMITS.columns, 'FORMAT');
  const keys = headers.map(normalize);
  sireEnsure(headers.every(h => h.length <= SIRE_LIMITS.headerChars) && keys.every(Boolean) && new Set(keys).size === keys.length, 'FORMAT');
  for (let i = 0; i < allowedHeaders.length; i++) sireEnsure(allowedHeaders[i].has(keys[i]), 'FORMAT');
  if (headers.length > 26) sireEnsure(keys[26] === normalize('Tipo de Cambio'), 'FORMAT');
  const column = (name: string) => {
    const canonical = SIRE_RCE_HEADERS.indexOf(name), allowed = allowedHeaders[canonical];
    const index = keys.findIndex(key => allowed.has(key));
    sireEnsure(index === canonical, 'FORMAT'); return index;
  };
  const indexes = {
    recipient: column('RUC'), period: column('Periodo'), date: column('Fecha de emisión'),
    type: column('Tipo CP/Doc.'), series: column('Serie del CDP'), number: column('Nro CP o Doc. Nro Inicial (Rango)'),
    range: column('Nro Final (Rango)'), identityType: column('Tipo Doc Identidad'),
    supplier: column('Nro Doc Identidad'), name: column('Apellidos Nombres/ Razón Social'),
    amount: column('Total CP'), currency: column('Moneda'),
  };
  const purchases: SirePurchase[] = [], incidents: SirePurchaseIncident[] = [];
  rows.forEach((row, ordinal) => {
    if (delimiter === '|' && row.length === headers.length + 1 && row.at(-1) === '') row.pop();
    sireEnsure(row.length === headers.length, 'FORMAT');
    const get = (index: number) => row[index].trim();
    sireEnsure(get(indexes.recipient) === recipientRuc && get(indexes.period) === period, 'IDENTITY');
    const rawRecord: Record<string, string> = Object.create(null);
    headers.forEach((header, i) => { rawRecord[header] = row[i]; }); Object.freeze(rawRecord);
    const incident = (code: SirePurchaseIncident['code']) => { incidents.push({ ordinal: ordinal + 1, code, rawRecord }); };
    // Unsupported fiscal records remain visible; never make up a supplier RUC,
    // split a consolidated range or impose the parent's narrower XML key limits.
    if (get(indexes.identityType) !== '6' || !/^\d{11}$/.test(get(indexes.supplier))) { incident('SUPPLIER_IDENTITY_NOT_RUC'); return; }
    if (get(indexes.range) !== '') { incident('CONSOLIDATED_RANGE'); return; }
    const type = get(indexes.type), series = get(indexes.series), number = get(indexes.number);
    if (!/^[A-Z0-9]{2}$/.test(type) || !/^[A-Za-z0-9]{1,20}$/.test(series) || !/^[A-Za-z0-9]{1,20}$/.test(number)) { incident('DOCUMENT_IDENTITY'); return; }
    const amount = get(indexes.amount), currency = get(indexes.currency);
    if (!(amount === '' || /^-?\d{1,12}(?:\.\d{1,2})?$/.test(amount)) || !(currency === '' || /^[A-Z]{3}$/.test(currency))) { incident('RECORD_VALUE'); return; }
    let date: string;
    try { date = issueDate(get(indexes.date)); }
    catch (error) { if (!(error instanceof SireError)) throw error; incident('RECORD_VALUE'); return; }
    purchases.push({
      recipientRuc, period, supplierRuc: get(indexes.supplier), supplierName: get(indexes.name) || null,
      documentType: type, series, number, fullNumber: `${series}-${number}`,
      issueDate: date, currencyCode: currency || null, amount: amount || null, rawRecord,
    });
  });
  return { purchases, incidents };
}

/** Legacy array API refuses partial results. Use the batch API to handle incidents. */
export function parseSirePurchases(bytes: Uint8Array, recipientRuc: string, period: string): SirePurchase[] {
  const batch = parseSirePurchaseBatch(bytes, recipientRuc, period);
  sireEnsure(batch.incidents.length === 0, 'UNSUPPORTED_RECORD'); return batch.purchases;
}
