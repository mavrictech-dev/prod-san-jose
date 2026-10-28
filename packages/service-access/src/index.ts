import { validScope, type AccessTokenClaims, type FiscalDocumentSnapshot } from '@factuez/contracts';
import { Queue } from 'bullmq';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export class AccessError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function bearer(token: unknown) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_.-]{1,8192}$/.test(token)) throw new AccessError(401, 'Sesión inválida');
  return `Bearer ${token}`;
}
export async function privateJson<T>(base: string, path: string, authorization: string): Promise<T> {
  let response: Response;
  try { response = await fetch(`${base}${path}`, { headers: { Authorization: authorization, Accept: 'application/json', 'Cache-Control': 'no-store' }, redirect: 'error', signal: AbortSignal.timeout(5000) }); }
  catch { throw new AccessError(503, 'Servicio interno no disponible'); }
  if (!response.ok) { await response.body?.cancel(); throw new AccessError([401,403,404].includes(response.status) ? response.status : 503, 'Acceso no disponible'); }
  if (!response.headers.get('content-type')?.startsWith('application/json')) { await response.body?.cancel(); throw new AccessError(503, 'Respuesta interna inválida'); }
  const reader = response.body?.getReader(); if (!reader) throw new AccessError(503, 'Respuesta vacía');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 2 * 1024 * 1024) throw new Error(); chunks.push(part.value); }
    return JSON.parse(Buffer.concat(chunks).toString()) as T;
  } catch { await reader.cancel().catch(() => {}); throw new AccessError(503, 'Respuesta interna inválida'); }
}
export async function identity(authorization: string, permission = 'document.view') {
  if (!/^Bearer [A-Za-z0-9_.-]{1,8192}$/i.test(authorization)) throw new AccessError(401, 'Inicie sesión');
  const user = await privateJson<AccessTokenClaims>(process.env.IDENTITY_INTERNAL_URL ?? 'http://identity-service:3001', '/api/v1/auth/me', authorization);
  if (!user.sub || !UUID.test(user.sub) || !Array.isArray(user.roles) || !Array.isArray(user.permissions) ||
    !validScope(user.scope, user.roles) || !Number.isFinite(user.exp) || user.exp * 1000 <= Date.now()) throw new AccessError(401, 'Sesión vencida o inválida');
  if (!user.permissions.some(code => code === permission)) throw new AccessError(403, 'Permiso insuficiente');
  return user;
}
export async function authorizedDocument(id: string, authorization: string) {
  if (!UUID.test(id)) throw new AccessError(400, 'Documento inválido');
  return privateJson<{ id: string; fullNumber: string; immutableSnapshot: FiscalDocumentSnapshot }>(
    process.env.BILLING_INTERNAL_URL ?? 'http://billing-service:3002', `/api/v1/documents/${id}`, authorization);
}
export function redisConnection() {
  return { host: process.env.REDIS_HOST ?? 'redis', port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD_FILE ? readFileSync(process.env.REDIS_PASSWORD_FILE, 'utf8').trim() : undefined };
}
export const LIVE_QUEUE = 'workspace-live-notifications-v1';
/** Aviso mínimo/best-effort; PostgreSQL + consultas REST siguen siendo la fuente de verdad. */
export class LivePublisher {
  private queue?: Queue;
  async changed(documentId: string) {
    if (process.env.WORKSPACE_LIVE_ENABLED !== 'true' || !UUID.test(documentId)) return;
    try {
      if (!this.queue) {
        this.queue = new Queue(LIVE_QUEUE, { connection: { ...redisConnection(), maxRetriesPerRequest: 1, connectTimeout: 2000 } });
        this.queue.on('error', () => {});
      }
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          this.queue.add('document.changed.v1', { documentId }, { jobId: randomUUID(), attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 100, removeOnFail: 100 }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Aviso no disponible')), 2500); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
    } catch { /* Sin datos ni secretos en logs. El cliente conserva fallback REST. */ }
  }
  async close() { await this.queue?.close(); }
}
