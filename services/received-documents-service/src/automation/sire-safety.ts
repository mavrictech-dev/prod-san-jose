/** Local policy limits, not SUNAT service limits. Everything stays in memory. */
export const SIRE_LIMITS = Object.freeze({
  requestTimeoutMs: 10_000,
  periodTimeoutMs: 120_000,
  jsonBytes: 256 * 1024,
  downloadBytes: 4 * 1024 * 1024,
  totalDownloadBytes: 12 * 1024 * 1024,
  expandedBytes: 16 * 1024 * 1024,
  entryBytes: 4 * 1024 * 1024,
  zipEntries: 100,
  compressionRatio: 200,
  reportFiles: 10,
  rows: 20_000,
  columns: 80,
  fieldChars: 2_000,
  headerChars: 200,
  ticketPolls: 6,
  pollDelayMs: 1_000,
  rateRetries: 2,
  retryBaseMs: 500,
  retryMaxMs: 5_000,
});

export type SireErrorCode = 'LIVE_DISABLED' | 'INPUT' | 'READ_ONLY' | 'REDIRECT' |
  'TIMEOUT' | 'NETWORK' | 'HTTP' | 'RATE_LIMIT' | 'SIZE' | 'RESPONSE' |
  'TICKET' | 'TICKET_PENDING' | 'ARCHIVE' | 'FORMAT' | 'IDENTITY' | 'UNSUPPORTED_RECORD';

/** Never attach upstream text, URL, record values, credentials, token or cause. */
export class SireError extends Error {
  constructor(readonly code: SireErrorCode, readonly status?: number) {
    super(`SIRE ${code}${status === undefined ? '' : ` (HTTP ${status})`}`);
    this.name = 'SireError';
  }
}

export function sireEnsure(value: unknown, code: SireErrorCode): asserts value {
  if (!value) throw new SireError(code);
}

export function validateSireContext(ruc: string, period: string): void {
  sireEnsure(typeof ruc === 'string' && /^\d{11}$/.test(ruc), 'INPUT');
  sireEnsure(typeof period === 'string' && /^[1-9]\d{3}(?:0[1-9]|1[0-2])$/.test(period), 'INPUT');
}

export function sireUtf8(bytes: Uint8Array, code: SireErrorCode = 'FORMAT'): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new SireError(code); }
}

export function validateSireFileName(name: unknown, extension: RegExp): asserts name is string {
  sireEnsure(typeof name === 'string' && name.length > 0 && name.length <= 255 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..') &&
    !/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(name) && extension.test(name), 'ARCHIVE');
}
