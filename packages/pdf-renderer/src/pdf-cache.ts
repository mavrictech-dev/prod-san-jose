const MIB = 1024 * 1024;
const MAX_RENDERED_BYTES = 12 * MIB;
const MAX_TIMER_MS = 2_147_483_647;

export interface PdfPreviewCacheOptions {
  ttlMs?: number;
  /** Budget for cache-owned buffers and reservations, excluding producer/caller allocations. */
  maxBytes?: number;
  maxEntries?: number;
  maxEntryBytes?: number;
  maxInFlight?: number;
  /** Output limit, at most 12 MiB; larger results fail before copying. */
  maxRenderedBytes?: number;
  /** Monotonic milliseconds. Defaults to performance.now(); injectable for tests. */
  now?: () => number;
}

export class PdfCacheBusyError extends Error {
  readonly code = 'PDF_CACHE_BUSY';
  constructor() {
    super('PDF preview cache capacity exhausted');
    this.name = 'PdfCacheBusyError';
  }
}

export class PdfCacheClosedError extends Error {
  readonly code = 'PDF_CACHE_CLOSED';
  constructor() {
    super('PDF preview cache is closed');
    this.name = 'PdfCacheClosedError';
  }
}

export class PdfCacheResultTooLargeError extends Error {
  readonly code = 'PDF_CACHE_RESULT_TOO_LARGE';
  constructor(readonly maxRenderedBytes: number) {
    super('PDF preview exceeds maxRenderedBytes');
    this.name = 'PdfCacheResultTooLargeError';
  }
}

type Entry = { buffer: Buffer; expiresAt: number };
type Flight = {
  ready: Promise<void>;
  buffer?: Buffer;
  expiresAt: number;
  reservedBytes: number;
  consumers: number;
};

function positiveInteger(name: string, value: number | undefined, fallback: number, upper = Number.MAX_SAFE_INTEGER): number {
  const limit = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > upper)
    throw new RangeError(`Invalid PDF cache option: ${name}`);
  return limit;
}

// An unpooled copy makes retained-byte accounting independent of Buffer slab sizes.
function copyBuffer(buffer: Buffer): Buffer {
  const copy = Buffer.allocUnsafeSlow(buffer.length);
  buffer.copy(copy);
  return copy;
}

/** Process-local, temporary cache. Authorization and input/version selection belong to the caller. */
export class PdfPreviewCache {
  private readonly options: Required<PdfPreviewCacheOptions>;
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Flight>();
  private cachedBytes = 0;
  private reservedBytes = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(options: PdfPreviewCacheOptions = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options))
      throw new TypeError('PDF cache options must be an object');
    this.options = {
      ttlMs: positiveInteger('ttlMs', options.ttlMs, 120_000, MAX_TIMER_MS),
      maxBytes: positiveInteger('maxBytes', options.maxBytes, 32 * MIB),
      maxEntries: positiveInteger('maxEntries', options.maxEntries, 64),
      maxEntryBytes: positiveInteger('maxEntryBytes', options.maxEntryBytes, 8 * MIB),
      maxInFlight: positiveInteger('maxInFlight', options.maxInFlight, 4),
      maxRenderedBytes: positiveInteger('maxRenderedBytes', options.maxRenderedBytes, MAX_RENDERED_BYTES, MAX_RENDERED_BYTES),
      now: options.now === undefined ? () => performance.now() : options.now,
    };
    if (this.options.maxEntryBytes > this.options.maxRenderedBytes ||
      this.options.maxRenderedBytes > this.options.maxBytes)
      throw new RangeError('PDF cache requires maxEntryBytes <= maxRenderedBytes <= maxBytes');
    if (typeof this.options.now !== 'function')
      throw new TypeError('PDF cache now must be a function');
  }

  async getOrRender(key: string, producer: () => Promise<Buffer>): Promise<Buffer> {
    if (this.closed) throw new PdfCacheClosedError();
    if (typeof key !== 'string' || key.length !== 64 || !/^[a-f0-9]{64}$/.test(key))
      throw new TypeError('PDF cache key must be a lowercase SHA-256 hex digest');
    if (typeof producer !== 'function') throw new TypeError('PDF cache producer must be a function');

    this.expire(this.options.now());
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
      return copyBuffer(entry.buffer);
    }

    let flight = this.inFlight.get(key);
    if (!flight) {
      // Reserve a cacheable result before starting work. No waiting queue is retained.
      if (this.inFlight.size >= this.options.maxInFlight || !this.makeRoom(this.options.maxEntryBytes))
        throw new PdfCacheBusyError();
      flight = {
        ready: Promise.resolve(), expiresAt: 0,
        reservedBytes: this.options.maxEntryBytes, consumers: 0,
      };
      this.reservedBytes += flight.reservedBytes;
      this.inFlight.set(key, flight);
      const started = flight;
      started.ready = Promise.resolve().then(() => {
        if (this.closed) throw new PdfCacheClosedError();
        return producer();
      }).then(buffer => {
        if (this.closed) throw new PdfCacheClosedError();
        if (!Buffer.isBuffer(buffer)) throw new TypeError('PDF cache producer must return a Buffer');
        if (buffer.length > this.options.maxRenderedBytes)
          throw new PdfCacheResultTooLargeError(this.options.maxRenderedBytes);
        this.expire(this.options.now());
        const extraBytes = buffer.length - started.reservedBytes;
        if (extraBytes > 0 && !this.makeRoom(extraBytes)) throw new PdfCacheBusyError();
        this.reservedBytes += extraBytes;
        started.reservedBytes = buffer.length;
        started.buffer = copyBuffer(buffer);
        started.expiresAt = this.options.now() + this.options.ttlMs;
        this.scheduleExpiry();
      });
      this.scheduleExpiry();
    }

    flight.consumers++;
    try {
      await flight.ready;
      if (this.closed) throw new PdfCacheClosedError();
      return copyBuffer(flight.buffer!);
    } finally {
      this.release(key, flight);
    }
  }

  /** Idempotent. Pending calls reject when they settle; producers already running cannot be cancelled. */
  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.entries.clear();
    for (const flight of this.inFlight.values()) flight.buffer = undefined;
    this.inFlight.clear();
    this.cachedBytes = 0;
    this.reservedBytes = 0;
  }

  private release(key: string, flight: Flight): void {
    if (--flight.consumers !== 0) return;
    const buffer = flight.buffer;
    flight.buffer = undefined;
    if (this.inFlight.get(key) !== flight) return;
    this.inFlight.delete(key);
    this.reservedBytes -= flight.reservedBytes;
    const now = this.options.now();
    this.expire(now);
    if (!this.closed && buffer && buffer.length <= this.options.maxEntryBytes && now < flight.expiresAt) {
      while (this.entries.size >= this.options.maxEntries) this.evictOldest();
      // Transfer the same owned buffer; settled promises carry no Buffer references.
      this.entries.set(key, { buffer, expiresAt: flight.expiresAt });
      this.cachedBytes += buffer.length;
    }
    this.scheduleExpiry();
  }

  private makeRoom(additionalBytes: number): boolean {
    if (this.reservedBytes + additionalBytes > this.options.maxBytes) return false;
    while (this.cachedBytes + this.reservedBytes + additionalBytes > this.options.maxBytes)
      this.evictOldest();
    return true;
  }

  private evictOldest(): void {
    const key = this.entries.keys().next().value!;
    const entry = this.entries.get(key)!;
    this.entries.delete(key);
    this.cachedBytes -= entry.buffer.length;
  }

  private expire(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        this.cachedBytes -= entry.buffer.length;
      }
    }
  }

  private scheduleExpiry(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed || !this.entries.size) return;
    let earliest = Infinity;
    for (const entry of this.entries.values()) earliest = Math.min(earliest, entry.expiresAt);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.expire(this.options.now());
      this.scheduleExpiry();
    }, Math.max(1, Math.ceil(earliest - this.options.now())));
    this.timer.unref();
  }
}
