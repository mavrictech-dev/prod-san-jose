import type { ReceivedDocumentRow, ReceivedUploadCommand } from '@factuez/contracts';
import type { Catalog, Company, User } from './types';

export const RECEIVED_API = '/api/v1/received-documents';
export const RECEIVED_FILE_LIMIT = 4 * 1024 * 1024;
export const RECEIVED_UPLOAD_LIMIT = 12 * 1024 * 1024;
export const RECEIVED_FILE_COUNT = 10;
export const RECEIVED_XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const RECEIVED_NOTICE = 'Ingreso manual de XML o ZIP. Estado SUNAT: No consultado. La carga, la firma y el CDR adjunto no acreditan aceptación fiscal.';
export const RECEIVED_PDF_NOTICE = 'Copia de lectura no fiscal, generada desde los datos del XML. El PDF original del proveedor se descarga por separado.';
export type ReceivedFilters = { q: string; type: string; from: string; to: string; page: number };
export const EMPTY_RECEIVED_FILTERS: ReceivedFilters = { q: '', type: '', from: '', to: '', page: 1 };
export type ReceivedSelection = { company: Company; branchId?: string; dataSource?: 'BUSINESS' | 'SYNTHETIC' | 'ALL' };
export type ReceivedFileKind = 'UPLOAD' | 'PROVIDER_PDF' | 'CDR';
export type ReceivedFile = Pick<File, 'name' | 'size' | 'arrayBuffer'>;

/** The workspace catalog is already filtered by its source. Recheck assigned scope here. */
export function receivedSelection(catalog: Catalog | undefined, user: User | undefined, companyId: string, branchId: string): ReceivedSelection | undefined {
  if (!user || !catalog || !/^[1-9]\d*$/.test(companyId)) return;
  const company = catalog.companies.find(row => String(row.id) === companyId && Number.isSafeInteger(row.id));
  if (!company) return;
  if (branchId) {
    const branch = catalog.branches.find(row => row.id === branchId && row.companyId === company.id);
    if (!branch || user.scope.kind === 'ASSIGNED' && !user.scope.branchIds.includes(branchId)) return;
  } else if (user.scope.kind === 'ASSIGNED') return;
  return { company, ...(branchId ? { branchId } : {}) };
}

export function receivedRowInScope(row: ReceivedDocumentRow, selection: ReceivedSelection) {
  return row.companyId === selection.company.id && row.recipientRuc === selection.company.ruc &&
    (!selection.branchId || row.branchId === selection.branchId);
}

export function receivedQuery(selection: ReceivedSelection, filters: ReceivedFilters, exportFile = false) {
  const params = new URLSearchParams({ companyId: String(selection.company.id), q: filters.q.trim(), type: filters.type.trim(), from: filters.from, to: filters.to });
  if (selection.branchId) params.set('branchId', selection.branchId);
  params.set('dataSource', selection.dataSource ?? 'BUSINESS');
  if (!exportFile) params.set('page', String(Math.max(1, Math.floor(filters.page) || 1)));
  return `${RECEIVED_API}${exportFile ? '/export.xlsx' : ''}?${params}`;
}

export function receivedFilterError(filters: ReceivedFilters) {
  if (filters.from && filters.to && filters.from > filters.to) return 'La fecha inicial debe ser anterior o igual a la fecha final.';
}

export function receivedFileError(files: readonly ReceivedFile[], kind: ReceivedFileKind = 'UPLOAD'): string | undefined {
  if (!files.length) return 'Selecciona al menos un archivo.';
  if (files.length > (kind === 'UPLOAD' ? RECEIVED_FILE_COUNT : 1)) return kind === 'UPLOAD' ? 'Selecciona como máximo 10 archivos.' : 'Adjunta un solo original cada vez.';
  let total = 0;
  for (const file of files) {
    const allowed = kind === 'PROVIDER_PDF' ? /\.pdf$/i : /\.(xml|zip)$/i;
    if (!allowed.test(file.name)) return kind === 'PROVIDER_PDF' ? 'El original del proveedor debe ser PDF.' : 'Sólo se permiten archivos XML o ZIP.';
    if (!Number.isSafeInteger(file.size) || file.size <= 0) return `El archivo ${file.name} está vacío o tiene un tamaño inválido.`;
    if (file.size > RECEIVED_FILE_LIMIT) return `El archivo ${file.name} supera 4 MiB.`;
    total += file.size;
  }
  if (total > RECEIVED_UPLOAD_LIMIT) return 'La carga completa supera 12 MiB.';
}

/** Content lives only in this request; all files are validated before any is read. */
export async function readReceivedFiles(files: readonly ReceivedFile[], kind: ReceivedFileKind, signal: AbortSignal): Promise<ReceivedUploadCommand['files']> {
  const error = receivedFileError(files, kind);
  if (error) throw new Error(error);
  const result: ReceivedUploadCommand['files'] = [];
  for (const file of files) {
    signal.throwIfAborted();
    const bytes = new Uint8Array(await file.arrayBuffer());
    signal.throwIfAborted();
    if (bytes.byteLength !== file.size) throw new Error(`El tamaño de ${file.name} cambió durante la lectura.`);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    result.push({ fileName: file.name, contentBase64: btoa(binary) });
  }
  return result;
}

export function receivedUploadCommand(selection: ReceivedSelection | undefined, files: ReceivedUploadCommand['files']): ReceivedUploadCommand {
  if (!selection) throw new Error('Selecciona un RUC y una sede autorizada antes de cargar archivos.');
  return { companyId: selection.company.id, ...(selection.branchId ? { branchId: selection.branchId } : {}), files };
}

export function receivedRegistration(registered: boolean, erpReference: string) {
  return { registered, ...(registered ? { erpReference: erpReference.trim() } : {}) };
}

export function receivedTypeLabel(type: string) {
  return ({ '01': 'Factura · 01', '03': 'Boleta · 03', '07': 'Nota de crédito · 07', '08': 'Nota de débito · 08', '09': 'Guía remitente · 09', '31': 'Guía transportista · 31', '20': 'Retención · 20', '40': 'Percepción · 40' } as Record<string, string>)[type] ?? `Tipo ${type}`;
}

export function receivedAmount(value: string | null, currency: string | null = null) {
  return value === null || value === '' ? '—' : `${value}${currency ? ` ${currency}` : ''}`;
}

/** Owns mutations/downloads and rejects completions from old requests or scopes. */
export function createReceivedOperation() {
  let controller: AbortController | undefined;
  return {
    start() { controller?.abort(); controller = new AbortController(); return controller; },
    current(candidate: AbortController) { return candidate === controller && !candidate.signal.aborted; },
    cancel() { controller?.abort(); controller = undefined; },
  };
}

export function saveReceivedBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName.replace(/[\\/\x00-\x1f]/g, '_');
  try {
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    // Give the browser time to consume the URL, then release its memory.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
