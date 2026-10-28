import { AccessError } from '@factuez/service-access';
import type { ReceivedUploadCommand } from '@factuez/contracts';
export function decodeUpload(value: unknown): Buffer {
  if (typeof value !== 'string' || !value.length || value.length > 5_592_408 || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value))
    throw new AccessError(400, 'Contenido base64 inválido o archivo mayor de 4 MiB');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > 4 * 1024 * 1024 || bytes.toString('base64') !== value) throw new AccessError(400, 'Contenido base64 inválido');
  return bytes;
}
export function uploadCommand(body: unknown): ReceivedUploadCommand {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AccessError(400, 'Carga inválida');
  const b = body as ReceivedUploadCommand;
  if (!Number.isSafeInteger(b.companyId) || b.companyId < 1 || !Array.isArray(b.files) || b.files.length < 1 || b.files.length > 10 ||
    b.files.some(f => !f || typeof f.fileName !== 'string' || typeof f.contentBase64 !== 'string')) throw new AccessError(400, 'Seleccione empresa y de 1 a 10 archivos');
  return b;
}
export function safeArtifactName(name: unknown): string {
  if (typeof name !== 'string' || name.length < 1 || name.length > 150 || /[\x00-\x1f\x7f<>:"/\\|?*%]/.test(name) ||
    name !== name.trim() || name.includes('..') || /[. ]$/.test(name)) throw new AccessError(400, 'Nombre de adjunto inválido (máximo 150 caracteres)');
  return name;
}
const date = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
export function receptionFilters(query: Record<string, unknown>) {
  for (const value of Object.values(query)) if (typeof value !== 'string') throw new AccessError(400, 'Filtro inválido');
  const q = String(query.q ?? '').trim(), type = String(query.type ?? ''), from = String(query.from ?? ''), to = String(query.to ?? ''), pageRaw = String(query.page ?? '1');
  const dataSource = String(query.dataSource ?? 'BUSINESS');
  if (q.length > 100 || type && !/^\d{2}$/.test(type) || from && !date(from) || to && !date(to) || from && to && from > to ||
    !/^[1-9]\d{0,4}$/.test(pageRaw) || !['BUSINESS', 'SYNTHETIC', 'ALL'].includes(dataSource)) throw new AccessError(400, 'Revise fechas, tipo de documento y paginación');
  return { q, type, from, to, page: Number(pageRaw), dataSource };
}
