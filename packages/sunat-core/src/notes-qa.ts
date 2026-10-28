import type { FiscalDocumentSnapshot, FiscalLineSnapshot } from '@factuez/contracts';
import { validateLocalInvoice } from './local-validation';
import { addMoney, calculateTaxLine, parseDecimal } from './tax';

export const NOTES_QA_PROFILE = 'LOCAL-QA-NOTES-UBL21-IGV18-PEN-v1';
export type NoteType = '07' | '08';
export type NoteRoot = 'CreditNote' | 'DebitNote';
/** Catálogos de las guías UBL 2.1; no se afirma cobertura del catálogo vigente completo. */
export const NOTES_QA_REASONS = {
  '07': [
    { code: '01', label: 'Anulación de la operación', supported: true },
    { code: '02', label: 'Anulación por error en el RUC', supported: false },
    { code: '03', label: 'Corrección por error en la descripción', supported: false },
    { code: '04', label: 'Descuento global', supported: false },
    { code: '05', label: 'Descuento por ítem', supported: false },
    { code: '06', label: 'Devolución total', supported: true },
    { code: '07', label: 'Devolución parcial', supported: true },
    { code: '08', label: 'Bonificación', supported: false },
    { code: '09', label: 'Disminución en el valor', supported: false },
  ],
  '08': [
    { code: '01', label: 'Interés por mora', supported: false },
    { code: '02', label: 'Aumento en el valor', supported: true },
  ],
} as const;

export type NoteQaInput = {
  idempotencyKey: string;
  documentTypeCode: NoteType;
  reasonCode: string;
  reasonDescription: string;
  lines?: { originalLineNumber: number; quantity: string; unitPriceWithTax?: string }[];
};
export type NoteQaSnapshot = Omit<FiscalDocumentSnapshot, 'documentTypeCode' | 'environment' | 'lines'> & {
  documentTypeCode: NoteType;
  environment: 'BETA';
  profile: typeof NOTES_QA_PROFILE;
  reasonCode: string;
  reasonDescription: string;
  reference: { documentId: string; documentTypeCode: '01' | '03'; fullNumber: string; issueDate: string };
  lines: (FiscalLineSnapshot & { originalLineNumber: number })[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fail(message: string): never { throw new Error(message); }
function text(value: unknown, maximum: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum ||
    /[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u.test(value)) fail('Texto de nota inválido');
}
function decimal(value: unknown, scale = 6) {
  if (typeof value !== 'string' || !new RegExp(`^\\d{1,12}(\\.\\d{1,${scale}})?$`).test(value)) fail('Decimal de nota inválido');
  if (parseDecimal(value as string, scale) <= 0n) fail('La cantidad y el importe deben ser positivos');
}

export function parseNoteQaInput(value: unknown): NoteQaInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Solicitud de nota inválida');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !['idempotencyKey', 'documentTypeCode', 'reasonCode', 'reasonDescription', 'lines'].includes(key))) fail('No se admiten identidades, series ni totales proporcionados por el cliente');
  if (typeof body.idempotencyKey !== 'string' || !UUID.test(body.idempotencyKey)) fail('Clave de idempotencia UUID requerida');
  if (body.documentTypeCode !== '07' && body.documentTypeCode !== '08') fail('Tipo de nota inválido');
  const type = body.documentTypeCode as NoteType;
  const reason = NOTES_QA_REASONS[type].find(item => item.code === body.reasonCode);
  if (!reason?.supported) fail('Motivo fuera del perfil local de notas; no se aproxima su tratamiento fiscal');
  text(body.reasonDescription, 250);
  const full = type === '07' && ['01', '06'].includes(String(body.reasonCode));
  if (full && body.lines !== undefined) fail('La anulación/devolución total deriva todas las líneas del original');
  if (!full) {
    if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > 100) fail('Seleccione de 1 a 100 líneas del original');
    const unique = new Set<number>();
    for (const item of body.lines as unknown[]) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) fail('Línea de nota inválida');
      const line = item as Record<string, unknown>;
      if (Object.keys(line).some(key => !['originalLineNumber', 'quantity', 'unitPriceWithTax'].includes(key))) fail('Campos de línea de nota no permitidos');
      if (!Number.isSafeInteger(line.originalLineNumber) || Number(line.originalLineNumber) < 1 || unique.has(Number(line.originalLineNumber))) fail('Referencia de línea inválida o duplicada');
      unique.add(Number(line.originalLineNumber)); decimal(line.quantity);
      if (type === '08') decimal(line.unitPriceWithTax);
      else if (line.unitPriceWithTax !== undefined) fail('La devolución utiliza el precio original, no uno editable');
    }
  }
  return JSON.parse(JSON.stringify(value)) as NoteQaInput;
}

/** Un crédito reservado por original en v1: impide sobreacreditar y ambigüedad de redondeos entre varias devoluciones. */
export function buildNoteQaSnapshot(original: FiscalDocumentSnapshot, inputValue: unknown,
  identity: { documentId: string; number: string; issueDate: string }): NoteQaSnapshot {
  validateLocalInvoice(original);
  if (!/^00\d{9}$/.test(original.issuer.identityNumber) || original.currencyCode !== 'PEN' || original.lines.length > 100) fail('Notas QA: sólo emisor ficticio, BETA, PEN, hasta 100 líneas e IGV 18%');
  const input = parseNoteQaInput(inputValue);
  if (!UUID.test(identity.documentId) || !/^[1-9]\d{0,7}$/.test(identity.number) ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(identity.issueDate) ||
    !Number.isFinite(Date.parse(identity.issueDate)) || Date.parse(identity.issueDate) < Date.parse(original.issueDate)) fail('Identidad o fecha de nota inválida');
  text(original.issuer.legalName, 200); text(original.customer.legalName, 200);
  const full = input.documentTypeCode === '07' && ['01', '06'].includes(input.reasonCode);
  const selection: NonNullable<NoteQaInput['lines']> = full ? original.lines.map(line => ({ originalLineNumber: line.lineNumber, quantity: line.quantity })) : input.lines!;
  const lines = selection.map((selectionLine, index) => {
    const source = original.lines.find(line => line.lineNumber === selectionLine.originalLineNumber);
    if (!source) fail('La línea referenciada no pertenece al comprobante original');
    text(source.description, 250);
    if (parseDecimal(selectionLine.quantity) > parseDecimal(source.quantity)) fail('Cantidad de nota superior a la del original');
    const price = input.documentTypeCode === '07' ? source.unitPriceWithTax : selectionLine.unitPriceWithTax ?? '';
    decimal(price);
    const calculated = calculateTaxLine({ quantity: selectionLine.quantity, unitPriceWithTax: price, igvRate: '18' });
    if (parseDecimal(calculated.totalAmount, 2) <= 0n) fail('El importe de la nota redondea a cero');
    if (input.documentTypeCode === '07' && (['lineExtensionAmount', 'igvAmount', 'totalAmount'] as const).some(key => parseDecimal(calculated[key], 2) > parseDecimal(source[key], 2))) fail('La devolución excede base, IGV o importe original');
    return { ...source, lineNumber: index + 1, originalLineNumber: source.lineNumber,
      quantity: selectionLine.quantity, unitPriceWithTax: price, igvRate: '18', ...calculated };
  });
  const series = `${original.documentTypeCode === '01' ? 'F' : 'B'}${input.documentTypeCode === '07' ? 'C' : 'D'}Q1`;
  return {
    companyId: original.companyId, branchId: original.branchId,
    documentId: identity.documentId, documentTypeCode: input.documentTypeCode, environment: 'BETA', profile: NOTES_QA_PROFILE,
    series, number: identity.number, fullNumber: `${series}-${identity.number}`, issueDate: identity.issueDate,
    currencyCode: 'PEN', operationTypeCode: original.operationTypeCode,
    issuer: structuredClone(original.issuer), customer: structuredClone(original.customer),
    ...(original.printPresentation ? { printPresentation: structuredClone(original.printPresentation) } : {}),
    reasonCode: input.reasonCode, reasonDescription: input.reasonDescription.trim(),
    reference: { documentId: original.documentId, documentTypeCode: original.documentTypeCode as '01' | '03', fullNumber: original.fullNumber, issueDate: original.issueDate },
    lines, totals: { taxableAmount: addMoney(lines.map(line => line.lineExtensionAmount)),
      igvAmount: addMoney(lines.map(line => line.igvAmount)), payableAmount: addMoney(lines.map(line => line.totalAmount)) },
  };
}

/** Recomputación independiente antes de firmar: no confiar en snapshot JSON persistido ni UI. */
export function validateNoteQaSnapshot(note: NoteQaSnapshot, original: FiscalDocumentSnapshot): void {
  const full = note.documentTypeCode === '07' && ['01', '06'].includes(note.reasonCode);
  const expected = buildNoteQaSnapshot(original, {
    idempotencyKey: note.documentId, documentTypeCode: note.documentTypeCode, reasonCode: note.reasonCode,
    reasonDescription: note.reasonDescription,
    ...(!full ? { lines: note.lines.map(line => ({ originalLineNumber: line.originalLineNumber, quantity: line.quantity,
      ...(note.documentTypeCode === '08' ? { unitPriceWithTax: line.unitPriceWithTax } : {}) })) } : {}),
  }, { documentId: note.documentId, number: note.number, issueDate: note.issueDate });
  // Las claves de objeto JSONB no conservan orden; comparación recursiva canónica.
  if (noteQaCanonical(note) !== noteQaCanonical(expected)) fail('La nota no coincide con su referencia y cálculo exacto');
}
export function noteQaCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(noteQaCanonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${noteQaCanonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
