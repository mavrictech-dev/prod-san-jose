import type { FiscalDocumentSnapshot } from '@factuez/contracts';

export const IMPLEMENTATION_CREDIT =
  'Desarrollado e implementado por www.mavrictec.com';
export type PrintFormat = 'ticket' | 'a4';
export type PrintableNote = Omit<FiscalDocumentSnapshot, 'documentTypeCode'> & {
  documentTypeCode: '07' | '08';
  reasonCode: string;
  reasonDescription: string;
  reference: { fullNumber: string; documentTypeCode: string; issueDate: string };
};

export function assertPrintFormat(format: PrintFormat): void {
  if (!['ticket', 'a4'].includes(format)) throw new Error('Formato inválido');
}

export function clean(value: string): string {
  if (typeof value !== 'string') throw new Error('Texto del snapshot inválido');
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, '');
}

/** Formatea texto decimal; nunca redondea, convierte a Number ni recalcula. */
export function money(value: string): string {
  if (typeof value !== 'string' || !/^\d{1,20}(\.\d{1,6})?$/.test(value))
    throw new Error('Importe del snapshot inválido');
  const [integer, fraction = ''] = value.split('.');
  return `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction.padEnd(2, '0')}`;
}

export function quantity(value: string): string {
  if (typeof value !== 'string' || !/^\d{1,12}(\.\d{1,6})?$/.test(value))
    throw new Error('Cantidad del snapshot inválida');
  return value;
}

export function calendarDate(value: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(`${value}T12:00:00Z`)) ||
    new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) !== value)
    throw new Error('Fecha del snapshot inválida');
  return value;
}

export function dateParts(value: string): { date: string; time?: string; isoDay: string } {
  calendarDate(value?.slice(0, 10));
  if (value.length === 10) {
    const [year, month, day] = value.split('-');
    return { date: `${day}/${month}/${year}`, isoDay: value };
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))) throw new Error('Fecha del snapshot inválida');
  const instant = new Date(value);
  const options = { timeZone: 'America/Lima' };
  return {
    date: new Intl.DateTimeFormat('es-PE', { ...options, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant),
    time: new Intl.DateTimeFormat('es-PE', { ...options, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(instant),
    isoDay: new Intl.DateTimeFormat('en-CA', { ...options, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant),
  };
}

export function visualNumber(fullNumber: string): string {
  const [series, number] = fullNumber.split('-');
  return `${series}-${number.padStart(8, '0')}`;
}

export function assertQaDigest(value: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value) ||
    Buffer.from(value, 'base64').length !== 32 || Buffer.from(value, 'base64').toString('base64') !== value)
    throw new Error('Evidencia QA inválida');
}
