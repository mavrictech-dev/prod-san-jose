import type { AuthorizedAdminHttpClient } from './integration-admin-remote';

const BASE = '/bff/b2b-admin';
const SOURCE = '/b2b/v1/admin/applications';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SESSION_BYTES = 16 * 1024;
const RESPONSE_BYTES = 16 * 1024 * 1024;
const WRITE_BYTES = 128 * 1024;

export type AdminBrowserErrorCode =
  | 'ADMIN_BFF_DISABLED' | 'HTTPS_REQUIRED' | 'SESSION_EXPIRED' | 'ACCESS_DENIED'
  | 'INVALID_REQUEST' | 'INVALID_RESPONSE' | 'RESPONSE_TOO_LARGE' | 'REQUEST_TOO_LARGE'
  | 'INVALID_AUTHORIZE_URL' | 'REVISION_CONFLICT' | 'NOT_FOUND' | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE' | 'NETWORK_ERROR' | 'REQUEST_CANCELLED' | 'SESSION_CLOSED';

export class AdminBrowserError extends Error {
  constructor(readonly status: number, readonly code: AdminBrowserErrorCode) {
    super(code);
    this.name = 'AdminBrowserError';
  }
}
export interface AdminSessionSnapshot {
  phase: 'disabled' | 'checking' | 'anonymous' | 'authenticated' | 'expired' | 'error' | 'closed';
  enabled: boolean;
  busy: boolean;
  error: AdminBrowserErrorCode | null;
}
export interface AdminBrowserWindow {
  location: { readonly origin: string; readonly search?: string; assign(url: string): void };
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}
/** Explicit dependencies are for SSR and isolated browser tests. Production derives
 * the only BFF origin from window.location.origin; there is no configurable API URL. */
export interface AdminBrowserDependencies {
  window?: AdminBrowserWindow;
  fetch?: typeof fetch;
}
export interface AdminBrowserClient extends AuthorizedAdminHttpClient {
  getSnapshot(): AdminSessionSnapshot;
  subscribe(listener: () => void): () => void;
  status(): Promise<AdminSessionSnapshot>;
  start(): Promise<void>;
  logout(): Promise<void>;
  invalidate(): void;
  close(): void;
}

export const adminSsoServerSnapshot: AdminSessionSnapshot = Object.freeze({
  phase: 'disabled', enabled: false, busy: false, error: null,
});
function fail(status: number, code: AdminBrowserErrorCode): never { throw new AdminBrowserError(status, code); }
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).sort().join(',') === keys.sort().join(',');
}
function safeError(error: unknown): AdminBrowserError {
  return error instanceof AdminBrowserError ? error : new AdminBrowserError(503, 'NETWORK_ERROR');
}
function httpError(status: number): AdminBrowserError {
  switch (status) {
    case 400: return new AdminBrowserError(400, 'INVALID_REQUEST');
    case 401: return new AdminBrowserError(401, 'SESSION_EXPIRED');
    case 403: return new AdminBrowserError(403, 'ACCESS_DENIED');
    case 404: return new AdminBrowserError(404, 'NOT_FOUND');
    case 409: return new AdminBrowserError(409, 'REVISION_CONFLICT');
    case 429: return new AdminBrowserError(429, 'RATE_LIMITED');
    default: return new AdminBrowserError(503, 'SERVICE_UNAVAILABLE');
  }
}

function applicationTarget(path: string, method: string): string {
  if (typeof path !== 'string' || path.length > 2048 || /[%#\\\s]/.test(path)) fail(400, 'INVALID_REQUEST');
  const parts = path.split('?');
  if (parts.length !== 2 || !parts[1]) fail(400, 'INVALID_REQUEST');
  const pathname = parts[0];
  if (pathname !== SOURCE && !pathname.startsWith(SOURCE + '/')) fail(400, 'INVALID_REQUEST');
  const tail = pathname === SOURCE ? [] : pathname.slice(SOURCE.length + 1).split('/');
  const collection = tail.length === 0;
  const detail = tail.length === 1 && UUID.test(tail[0]);
  const rotate = tail.length === 2 && UUID.test(tail[0]) && tail[1] === 'rotate-secret';
  if (!(method === 'GET' && (collection || detail) || method === 'POST' && (collection || rotate) || method === 'PATCH' && detail)) fail(400, 'INVALID_REQUEST');
  const query = new Map<string, string>();
  for (const part of parts[1].split('&')) {
    const pair = part.split('=');
    if (pair.length !== 2 || query.has(pair[0])) fail(400, 'INVALID_REQUEST');
    const [key, value] = pair;
    if (key === 'environment' ? value !== 'BETA' :
      key === 'limit' ? !(collection && method === 'GET' && /^(?:[1-9]|[1-4][0-9]|50)$/.test(value)) :
      key === 'after' ? !(collection && method === 'GET' && UUID.test(value)) : true) fail(400, 'INVALID_REQUEST');
    query.set(key, value);
  }
  if (query.get('environment') !== 'BETA') fail(400, 'INVALID_REQUEST');
  return BASE + '/applications' + pathname.slice(SOURCE.length) + '?' + parts[1];
}

function authorizeTarget(value: unknown): string {
  if (typeof value !== 'string' || value.length > 16 * 1024 ||
      !value.startsWith('https://') || /[\\\s\x00-\x1f\x7f#]/.test(value)) fail(503, 'INVALID_AUTHORIZE_URL');
  let url: URL;
  try { url = new URL(value); } catch { return fail(503, 'INVALID_AUTHORIZE_URL'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash ||
      value.slice(8).split(/[/?]/, 1)[0].includes('@')) fail(503, 'INVALID_AUTHORIZE_URL');
  // Only the BFF returns this destination, constructed against its bound issuer.
  // No caller-supplied redirect/return target is accepted by start().
  return url.href;
}

async function boundedJson(response: Response, maximum: number): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) fail(503, 'RESPONSE_TOO_LARGE');
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) fail(503, 'INVALID_RESPONSE');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) fail(503, 'RESPONSE_TOO_LARGE');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    try { return JSON.parse(text); } catch { return fail(503, 'INVALID_RESPONSE'); }
  } catch (error) {
    try { await reader.cancel(); } catch { /* Already aborted. */ }
    if (error instanceof AdminBrowserError) throw error;
    return fail(503, 'INVALID_RESPONSE');
  } finally { reader.releaseLock(); }
}

export function createAdminBrowserClient(dependencies: AdminBrowserDependencies = {}): AdminBrowserClient {
  const browser = dependencies.window ?? (typeof window === 'undefined' ? undefined : window);
  const fetcher = dependencies.fetch ?? (typeof window === 'undefined' ? undefined : window.fetch.bind(window));
  let origin: string | null = null;
  try {
    const candidate = browser?.location.origin;
    if (candidate) {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'https:' && parsed.origin === candidate && !parsed.username && !parsed.password) origin = candidate;
    }
  } catch { /* An unavailable or insecure origin keeps the host disabled. */ }
  let snapshot: AdminSessionSnapshot = origin && fetcher ? Object.freeze({
    phase: 'checking', enabled: false, busy: false, error: null,
  }) : Object.freeze({ ...adminSsoServerSnapshot, error: browser ? 'HTTPS_REQUIRED' : null });
  const listeners = new Set<() => void>(), pending = new Set<AbortController>();
  let csrf: string | null = null, expires = 0, generation = 0, closed = false, listening = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const publish = (next: AdminSessionSnapshot) => {
    snapshot = Object.freeze(next);
    listeners.forEach(listener => listener());
  };
  const reset = () => {
    ++generation;
    csrf = null; expires = 0;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pending.forEach(controller => controller.abort());
    pending.clear();
  };
  const invalidate = (code: AdminBrowserErrorCode = 'SESSION_EXPIRED') => {
    if (closed) return;
    reset();
    publish({ phase: 'expired', enabled: snapshot.enabled, busy: false, error: code });
  };
  const current = (ticket: number) => {
    if (closed || ticket !== generation) fail(401, 'REQUEST_CANCELLED');
  };
  const authenticated = () => {
    if (closed) fail(401, 'SESSION_CLOSED');
    if (csrf && expires <= Date.now()) invalidate();
    if (!csrf || snapshot.phase !== 'authenticated') fail(401, 'SESSION_EXPIRED');
  };
  const armExpiry = () => {
    const remaining = expires - Date.now();
    if (remaining <= 0) { invalidate(); return; }
    timer = setTimeout(() => {
      timer = undefined;
      if (csrf) armExpiry();
    }, Math.min(remaining, 2_147_483_647));
  };
  const workspaceLogout = () => {
    const token = csrf;
    client.close();
    if (token && origin && fetcher) {
      // Deliberately detached: clearing the workspace unmounts the host. No
      // session AbortSignal may cancel cookie revocation during that teardown.
      try {
        void fetcher(origin + BASE + '/session/logout', {
          method: 'POST', body: '{}', cache: 'no-store', credentials: 'same-origin',
          redirect: 'error', keepalive: true,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-FactuEz-CSRF': token },
        }).then(response => response.body?.cancel()).catch(() => {});
      } catch { /* Best effort only; local access is already closed. */ }
    }
  };
  const available = () => {
    if (closed) fail(401, 'SESSION_CLOSED');
    if (!origin || !fetcher) fail(503, 'HTTPS_REQUIRED');
    if (!listening && browser) {
      browser.addEventListener('factuez:workspace-logout', workspaceLogout);
      listening = true;
    }
  };
  const exchange = async (target: string, method: string, body: string | undefined, token: string | null, maximum: number, ticket: number, requiresSession = false): Promise<unknown> => {
    available(); current(ticket);
    const controller = new AbortController();
    pending.add(controller);
    try {
      const response = await fetcher!(origin! + target, {
        method, cache: 'no-store', credentials: 'same-origin', redirect: 'error',
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { 'X-FactuEz-CSRF': token } : {}) },
        ...(body === undefined ? {} : { body }), signal: controller.signal,
      });
      current(ticket);
      if (requiresSession) authenticated();
      if (response.status === 401 || response.status === 403) {
        const error = httpError(response.status);
        invalidate(error.code);
        throw error;
      }
      if (response.redirected || response.status >= 300 && response.status < 400) fail(503, 'INVALID_RESPONSE');
      if (!response.ok) {
        const error = httpError(response.status);
        // Error payloads never escape this boundary. Recognize only the disabled code.
        if (response.status === 503) {
          try {
            const value = await boundedJson(response, SESSION_BYTES);
            current(ticket);
            if (record(value) && (value.code === 'ADMIN_BFF_DISABLED' || record(value.error) && value.error.code === 'ADMIN_BFF_DISABLED')) fail(503, 'ADMIN_BFF_DISABLED');
          } catch (readError) {
            if (readError instanceof AdminBrowserError && (readError.code === 'ADMIN_BFF_DISABLED' || readError.code === 'REQUEST_CANCELLED')) throw readError;
          }
        }
        throw error;
      }
      const value = await boundedJson(response, maximum);
      current(ticket);
      if (requiresSession) authenticated();
      return value;
    } catch (error) {
      if (closed || ticket !== generation) {
        // Keep the initiating authorization failure finite; stale successes/errors
        // from every other request must never affect a replacement session.
        if (error instanceof AdminBrowserError && (error.code === 'SESSION_EXPIRED' || error.code === 'ACCESS_DENIED')) throw error;
        return fail(401, 'REQUEST_CANCELLED');
      }
      throw safeError(error);
    } finally { controller.abort(); pending.delete(controller); }
  };
  const operationFailure = (error: unknown, ticket: number) => {
    const safe = safeError(error);
    if (!closed && ticket === generation) {
      reset();
      publish({ phase: safe.code === 'ADMIN_BFF_DISABLED' ? 'disabled' : 'error',
        enabled: safe.code === 'ADMIN_BFF_DISABLED' ? false : snapshot.enabled, busy: false, error: safe.code });
    }
    return safe;
  };
  const client: AdminBrowserClient = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async status() {
      available();
      if (snapshot.busy) return snapshot;
      reset();
      const ticket = generation;
      publish({ phase: 'checking', enabled: snapshot.enabled, busy: true, error: null });
      try {
        const value = await exchange(BASE + '/session', 'GET', undefined, null, SESSION_BYTES, ticket);
        current(ticket);
        if (!record(value) || value.enabled !== true || value.environment !== 'BETA' || typeof value.authenticated !== 'boolean') fail(503, 'INVALID_RESPONSE');
        if (!value.authenticated) {
          if (!exact(value, ['enabled', 'environment', 'authenticated'])) fail(503, 'INVALID_RESPONSE');
          publish({ phase: 'anonymous', enabled: true, busy: false, error: null });
        } else {
          if (!exact(value, ['enabled', 'environment', 'authenticated', 'csrfToken', 'expiresAt']) ||
              typeof value.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.csrfToken) ||
              typeof value.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.expiresAt) ||
              !Number.isFinite(Date.parse(value.expiresAt))) fail(503, 'INVALID_RESPONSE');
          if (Date.parse(value.expiresAt) <= Date.now()) {
            invalidate(); fail(401, 'SESSION_EXPIRED');
          }
          csrf = value.csrfToken; expires = Date.parse(value.expiresAt);
          publish({ phase: 'authenticated', enabled: true, busy: false, error: null });
          armExpiry();
        }
        return snapshot;
      } catch (error) { throw operationFailure(error, ticket); }
    },
    async start() {
      available();
      if (snapshot.busy) return;
      if (!snapshot.enabled || !['anonymous', 'expired', 'error'].includes(snapshot.phase)) fail(400, 'INVALID_REQUEST');
      reset();
      const ticket = generation;
      publish({ phase: 'anonymous', enabled: true, busy: true, error: null });
      try {
        const value = await exchange(BASE + '/session/start', 'POST', '{}', null, SESSION_BYTES, ticket);
        current(ticket);
        if (!exact(value, ['authorizeUrl'])) fail(503, 'INVALID_RESPONSE');
        const url = authorizeTarget(value.authorizeUrl);
        current(ticket);
        browser!.location.assign(url);
        publish({ phase: 'anonymous', enabled: true, busy: false, error: null });
      } catch (error) { throw operationFailure(error, ticket); }
    },
    async logout() {
      available();
      if (snapshot.busy) return;
      authenticated();
      const token = csrf;
      reset();
      const ticket = generation;
      publish({ phase: 'anonymous', enabled: true, busy: true, error: null });
      try {
        const value = await exchange(BASE + '/session/logout', 'POST', '{}', token, SESSION_BYTES, ticket);
        current(ticket);
        if (!exact(value, ['loggedOut']) || value.loggedOut !== true) fail(503, 'INVALID_RESPONSE');
        publish({ phase: 'anonymous', enabled: true, busy: false, error: null });
      } catch (error) { throw operationFailure(error, ticket); }
    },
    async request<T>(path: string, init?: { method: 'POST' | 'PATCH'; body: unknown }): Promise<T> {
      available(); authenticated();
      if (init !== undefined && (!exact(init, ['method', 'body']) || !['POST', 'PATCH'].includes(init.method))) fail(400, 'INVALID_REQUEST');
      const method = init?.method ?? 'GET', target = applicationTarget(path, method);
      const ticket = generation, token = csrf;
      let body: string | undefined;
      if (init) {
        try { body = JSON.stringify(init.body); } catch { return fail(400, 'INVALID_REQUEST'); }
        if (body === undefined) fail(400, 'INVALID_REQUEST');
        if (new TextEncoder().encode(body).byteLength > WRITE_BYTES) fail(400, 'REQUEST_TOO_LARGE');
      }
      current(ticket); authenticated();
      return await exchange(target, method, body, token, RESPONSE_BYTES, ticket, true) as T;
    },
    invalidate: () => invalidate(),
    close() {
      if (closed) return;
      closed = true; reset();
      if (listening && browser) browser.removeEventListener('factuez:workspace-logout', workspaceLogout);
      listening = false;
      publish({ phase: 'closed', enabled: false, busy: false, error: null });
      listeners.clear();
    },
  };
  return client;
}

