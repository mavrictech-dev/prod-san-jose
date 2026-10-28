import { SIRE_LIMITS, SireError, sireEnsure, validateSireContext, validateSireFileName } from './sire-safety';

export const SIRE_ORIGIN = 'https://api-sire.sunat.gob.pe';
export const SIRE_MASSIVE_PATH = '/v1/contribuyente/migeigv/libros/rvierce/gestionprocesosmasivos/web/masivo/';
export const sireTokenUrl = (clientId: string) => `https://api-seguridad.sunat.gob.pe/v1/clientessol/${clientId}/oauth2/token/`;
export const sireExportUrl = (period: string) => `${SIRE_ORIGIN}/v1/contribuyente/migeigv/libros/rce/propuesta/web/propuesta/${period}/exportacioncomprobantepropuesta?codTipoArchivo=0&codOrigenEnvio=2&numSerieCDP=&numCDP=`;

/** No caller-configured origin, arbitrary endpoint, write method or extra query. */
export function assertSireReadRequest(address: string, method: string): void {
  let url: URL;
  try { url = new URL(address); } catch { throw new SireError('READ_ONLY'); }
  sireEnsure(url.protocol === 'https:' && !url.username && !url.password && !url.hash &&
    !url.port && url.href === address, 'READ_ONLY');
  if (url.origin === 'https://api-seguridad.sunat.gob.pe') {
    sireEnsure(method === 'POST' && /^\/v1\/clientessol\/[A-Za-z0-9-]{1,128}\/oauth2\/token\/$/.test(url.pathname) && !url.search, 'READ_ONLY');
    return;
  }
  sireEnsure(url.origin === SIRE_ORIGIN && method === 'GET', 'READ_ONLY');
  const params = url.searchParams;
  const exactKeys = (keys: string[]) => {
    const actual = [...params.keys()];
    sireEnsure(actual.length === keys.length && keys.every(key => params.has(key)) && new Set(actual).size === actual.length, 'READ_ONLY');
  };
  const exportMatch = /^\/v1\/contribuyente\/migeigv\/libros\/rce\/propuesta\/web\/propuesta\/(\d{6})\/exportacioncomprobantepropuesta$/.exec(url.pathname);
  if (exportMatch) {
    validateSireContext('00000000000', exportMatch[1]);
    exactKeys(['codTipoArchivo', 'codOrigenEnvio', 'numSerieCDP', 'numCDP']);
    sireEnsure(params.get('codTipoArchivo') === '0' && params.get('codOrigenEnvio') === '2' &&
      params.get('numSerieCDP') === '' && params.get('numCDP') === '', 'READ_ONLY'); return;
  }
  if (url.pathname === `${SIRE_MASSIVE_PATH}consultaestadotickets`) {
    exactKeys(['perIni', 'perFin', 'page', 'perPage', 'numTicket', 'codLibro', 'codOrigenEnvio']);
    validateSireContext('00000000000', params.get('perIni')!);
    sireEnsure(params.get('perFin') === params.get('perIni') && /^(?:[1-9]\d?|100)$/.test(params.get('page')!) && params.get('perPage') === '20' &&
      /^\d{14}$/.test(params.get('numTicket')!) && params.get('codLibro') === '080000' && params.get('codOrigenEnvio') === '2', 'READ_ONLY'); return;
  }
  sireEnsure(url.pathname === `${SIRE_MASSIVE_PATH}archivoreporte`, 'READ_ONLY');
  exactKeys(['nomArchivoReporte', 'codTipoArchivoReporte', 'perTributario', 'codProceso', 'numTicket', 'codLibro']);
  validateSireContext('00000000000', params.get('perTributario')!);
  validateSireFileName(params.get('nomArchivoReporte'), /\.zip$/i);
  sireEnsure(/^(?:\d{1,2}|null)$/.test(params.get('codTipoArchivoReporte')!) && params.get('codProceso') === '10' &&
    /^\d{14}$/.test(params.get('numTicket')!) && params.get('codLibro') === '080000', 'READ_ONLY');
}

function discard(response: Response): void { void response.body?.cancel().catch(() => {}); }
export async function sireDelay(ms: number, deadline: number): Promise<void> {
  sireEnsure(Date.now() + ms < deadline, 'TIMEOUT');
  await new Promise<void>(resolve => setTimeout(resolve, ms));
}
function retryDelay(value: string | null, retry: number): number {
  const baseline = SIRE_LIMITS.retryBaseMs * 2 ** retry;
  if (!value || value.length > 128) return baseline;
  const seconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(seconds) ? Math.min(SIRE_LIMITS.retryMaxMs, Math.max(baseline, seconds)) : baseline;
}

/** Deadline covers fetch AND streaming body, even if an injected fetch ignores abort. */
export async function sireRequest(fetcher: typeof fetch, address: string, init: RequestInit, limit: number, deadline: number): Promise<Buffer> {
  assertSireReadRequest(address, init.method!);
  for (let retry = 0; retry <= SIRE_LIMITS.rateRetries; retry++) {
    const remaining = Math.min(SIRE_LIMITS.requestTimeoutMs, deadline - Date.now());
    sireEnsure(remaining > 0, 'TIMEOUT');
    const controller = new AbortController(); let response: Response | undefined, timedOut = false;
    let cancelActive = () => { if (response) discard(response); };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { timedOut = true; controller.abort(); cancelActive(); reject(new SireError('TIMEOUT')); }, remaining);
    });
    try {
      const work: Promise<{ bytes: Buffer } | { retryMs: number }> = (async () => {
        // Node @types/20 RequestInit omits cache, but Node's fetch accepts it.
        const requestInit: RequestInit & { cache: 'no-store' } = { ...init, redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: controller.signal };
        response = await fetcher(address, requestInit);
        if (timedOut) { discard(response); throw new SireError('TIMEOUT'); }
        sireEnsure(!response.redirected && !(response.status >= 300 && response.status < 400) &&
          (!response.url || response.url === address), 'REDIRECT');
        if (response.status === 429) return { retryMs: retryDelay(response.headers.get('retry-after'), retry) };
        if (response.status !== 200) throw new SireError('HTTP', response.status);
        const declared = response.headers.get('content-length');
        sireEnsure(declared === null || /^\d+$/.test(declared) && Number(declared) <= limit, 'SIZE');
        sireEnsure(response.body, 'RESPONSE');
        const reader = response.body.getReader(), chunks: Buffer[] = []; let length = 0;
        cancelActive = () => { void reader.cancel().catch(() => {}); };
        try {
          for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            sireEnsure(value instanceof Uint8Array, 'RESPONSE');
            sireEnsure(!timedOut, 'TIMEOUT'); length += value.byteLength; sireEnsure(length <= limit, 'SIZE');
            chunks.push(Buffer.from(value));
          }
        } finally { if (timedOut || length > limit) cancelActive(); reader.releaseLock(); cancelActive = () => { if (response) discard(response); }; }
        return { bytes: Buffer.concat(chunks, length) };
      })();
      const result = await Promise.race([work, timeout]);
      if (timer) clearTimeout(timer);
      if ('bytes' in result) return result.bytes;
      if (response) discard(response);
      if (retry === SIRE_LIMITS.rateRetries) throw new SireError('RATE_LIMIT', 429);
      await sireDelay(result.retryMs, deadline);
    } catch (error) {
      controller.abort(); cancelActive();
      if (timedOut) throw new SireError('TIMEOUT');
      if (error instanceof SireError) throw error;
      throw new SireError('NETWORK');
    } finally { if (timer) clearTimeout(timer); }
  }
  throw new SireError('RATE_LIMIT', 429);
}
