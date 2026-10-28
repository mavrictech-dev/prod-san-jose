import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import * as cacheExports from '../packages/pdf-renderer/src/pdf-cache';
import { PdfCacheBusyError, PdfCacheClosedError, PdfCacheResultTooLargeError, PdfPreviewCache,
  type PdfPreviewCacheOptions } from '../packages/pdf-renderer/src/pdf-cache';

const MIB = 1024 * 1024;
const caches: PdfPreviewCache[] = [];
const key = (value: string) => createHash('sha256').update(value).digest('hex');

function cache(options: PdfPreviewCacheOptions = {}): PdfPreviewCache {
  const value = new PdfPreviewCache({ ttlMs: 1000, maxBytes: 64, maxEntries: 4,
    maxEntryBytes: 8, maxInFlight: 4, maxRenderedBytes: 12, ...options });
  caches.push(value);
  return value;
}

function deferred() {
  let resolve!: (buffer: Buffer) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Buffer>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Inspect ownership only to verify idle expiry, backing allocations and total memory bounds.
function state(value: PdfPreviewCache) {
  return value as unknown as {
    options: Required<PdfPreviewCacheOptions>;
    entries: Map<string, { buffer: Buffer; expiresAt: number }>;
    inFlight: Map<string, { ready: Promise<void>; buffer?: Buffer; reservedBytes: number }>;
    cachedBytes: number;
    reservedBytes: number;
    timer?: ReturnType<typeof setTimeout>;
  };
}

function expectBudget(value: PdfPreviewCache, maxBytes: number) {
  const owned = state(value);
  expect(owned.cachedBytes).toBeGreaterThanOrEqual(0);
  expect(owned.reservedBytes).toBeGreaterThanOrEqual(0);
  expect(owned.cachedBytes + owned.reservedBytes).toBeLessThanOrEqual(maxBytes);
}

afterEach(() => {
  for (const value of caches.splice(0)) value.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('PdfPreviewCache: contrato y límites', () => {
  it('exporta la API y la versión sin cargar ni ejecutar el renderer', () => {
    const source = readFileSync(new URL('../packages/pdf-renderer/src/index.ts', import.meta.url), 'utf8');
    const output = transpileModule(source, { compilerOptions: {
      module: ModuleKind.CommonJS, target: ScriptTarget.ES2023,
    } }).outputText;
    const exported: Record<string, unknown> = {};
    runInNewContext(output, { exports: exported, require: (id: string) => {
      if (id === './pdf-cache') return cacheExports;
      if (['qrcode', './layout', './reference-sales', './presentation', './types', './gre'].includes(id)) return {};
      throw new Error('Unexpected renderer dependency');
    } });
    expect(exported.PdfPreviewCache).toBe(PdfPreviewCache);
    expect(exported.PdfCacheBusyError).toBe(PdfCacheBusyError);
    expect(exported.PdfCacheClosedError).toBe(PdfCacheClosedError);
    expect(exported.PdfCacheResultTooLargeError).toBe(PdfCacheResultTooLargeError);
    expect(exported.PDF_RENDERER_VERSION).toBe('factuez.pdf-renderer.v4');
  });

  it('usa los valores predeterminados acordados y reloj monotónico', () => {
    const value = new PdfPreviewCache(); caches.push(value);
    expect(state(value).options).toMatchObject({ ttlMs: 120_000, maxBytes: 32 * MIB,
      maxEntries: 64, maxEntryBytes: 8 * MIB, maxInFlight: 4, maxRenderedBytes: 12 * MIB });
    expect(state(value).options.now()).toBeGreaterThanOrEqual(0);
    expect(state(value).timer).toBeUndefined();
  });

  it.each(['ttlMs', 'maxBytes', 'maxEntries', 'maxEntryBytes', 'maxInFlight', 'maxRenderedBytes'] as const)(
    'rechaza valores no positivos, no enteros o no finitos en %s', option => {
      for (const invalid of [0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '8', null])
        expect(() => cache({ [option]: invalid } as PdfPreviewCacheOptions)).toThrow(RangeError);
    });

  it('valida relaciones entre límites y el máximo del temporizador', () => {
    expect(() => cache({ maxEntryBytes: 13 })).toThrow(RangeError);
    expect(() => cache({ maxBytes: 11 })).toThrow(RangeError);
    expect(() => cache({ ttlMs: 2_147_483_648 })).toThrow(RangeError);
    expect(() => cache({ maxRenderedBytes: 12 * MIB + 1, maxBytes: 32 * MIB })).toThrow(RangeError);
    const value = cache({ ttlMs: 2_147_483_647, maxRenderedBytes: 12 * MIB, maxBytes: 32 * MIB });
    expect(state(value).options.ttlMs).toBe(2_147_483_647);
  });

  it('rechaza opciones y relojes inválidos', () => {
    for (const options of [null, [], 1, 'options'])
      expect(() => new PdfPreviewCache(options as unknown as PdfPreviewCacheOptions)).toThrow(TypeError);
    for (const now of [null, 1, 'now'])
      expect(() => cache({ now } as unknown as PdfPreviewCacheOptions)).toThrow(TypeError);
  });

  it('sólo admite claves SHA-256 hex64 canónicas sin incluir su valor en el error', async () => {
    const value = cache(), producer = vi.fn(async () => Buffer.from('ok'));
    for (const invalid of ['', 'cliente-identificable', 'a'.repeat(63), 'a'.repeat(65),
      'a'.repeat(64) + '\n', 'A'.repeat(64), 'g'.repeat(64), null, 123]) {
      await expect(value.getOrRender(invalid as string, producer)).rejects.toMatchObject({
        name: 'TypeError', message: 'PDF cache key must be a lowercase SHA-256 hex digest',
      });
    }
    expect(producer).not.toHaveBeenCalled();
    await expect(value.getOrRender(key('valid'), producer)).resolves.toEqual(Buffer.from('ok'));
    await expect(value.getOrRender(key('valid'), null as unknown as () => Promise<Buffer>)).rejects.toThrow(TypeError);
  });
});

describe('PdfPreviewCache: copias y single-flight', () => {
  it('aísla el Buffer del productor, la escritura interna y cada lectura', async () => {
    const value = cache(), source = Buffer.from('data'), producer = vi.fn(async () => source);
    const first = await value.getOrRender(key('copies'), producer);
    source.fill(0); first.fill(1);
    const second = await value.getOrRender(key('copies'), producer);
    expect(second.toString()).toBe('data');
    second.fill(2);
    expect((await value.getOrRender(key('copies'), producer)).toString()).toBe('data');
    expect(producer).toHaveBeenCalledTimes(1);
    const internal = state(value).entries.get(key('copies'))!.buffer;
    expect(internal.buffer.byteLength).toBe(internal.length);
    expect(first.buffer).not.toBe(source.buffer);
    expect(second.buffer).not.toBe(internal.buffer);
  });

  it('comparte productor por clave y entrega copias distintas a todos los consumidores', async () => {
    const value = cache(), pending = deferred(), producer = vi.fn(() => pending.promise);
    const unused = vi.fn(async () => Buffer.from('bad'));
    const first = value.getOrRender(key('single'), producer);
    const second = value.getOrRender(key('single'), unused);
    await Promise.resolve();
    expect(producer).toHaveBeenCalledTimes(1); expect(unused).not.toHaveBeenCalled();
    expect(state(value).inFlight.size).toBe(1);
    const ready = state(value).inFlight.get(key('single'))!.ready;
    const source = Buffer.from('same'); pending.resolve(source);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b); expect(a).not.toBe(b); expect(a.buffer).not.toBe(b.buffer);
    a.fill(0); source.fill(1); expect(b.toString()).toBe('same');
    await expect(ready).resolves.toBeUndefined();
    expect(state(value).inFlight.size).toBe(0); expect(state(value).reservedBytes).toBe(0);
    expect((await value.getOrRender(key('single'), unused)).toString()).toBe('same');
    expect(unused).not.toHaveBeenCalled();
  });

  it('no comparte trabajo ni contenido entre claves o instancias', async () => {
    const value = cache(), other = cache(), producer = vi.fn(async () => Buffer.from('a'));
    await value.getOrRender(key('a'), producer);
    expect((await value.getOrRender(key('b'), async () => Buffer.from('b'))).toString()).toBe('b');
    expect((await other.getOrRender(key('a'), async () => Buffer.from('c'))).toString()).toBe('c');
    expect(producer).toHaveBeenCalledTimes(1);
  });

  it('propaga el rechazo a quienes esperan y permite reintentar sin cachear errores', async () => {
    const value = cache(), pending = deferred(), error = new Error('render failed');
    const first = value.getOrRender(key('failure'), () => pending.promise);
    const second = value.getOrRender(key('failure'), async () => Buffer.from('unused'));
    const settled = Promise.allSettled([first, second]); pending.reject(error);
    expect(await settled).toEqual([{ status: 'rejected', reason: error }, { status: 'rejected', reason: error }]);
    expect(state(value).entries.size).toBe(0); expect(state(value).inFlight.size).toBe(0);
    expect(state(value).reservedBytes).toBe(0);
    await expect(value.getOrRender(key('failure'), async () => Buffer.from('retry'))).resolves.toEqual(Buffer.from('retry'));
  });

  it('libera reservas tras excepciones síncronas o resultados que no son Buffer', async () => {
    const value = cache({ maxInFlight: 1 });
    await expect(value.getOrRender(key('sync'), () => { throw new Error('sync'); })).rejects.toThrow('sync');
    for (const output of [null, 'text', new Uint8Array(2)]) {
      await expect(value.getOrRender(key('type'), async () => output as Buffer)).rejects.toThrow(TypeError);
      expect(state(value).reservedBytes).toBe(0); expect(state(value).inFlight.size).toBe(0);
    }
    await expect(value.getOrRender(key('sync'), async () => Buffer.from('ok'))).resolves.toEqual(Buffer.from('ok'));
  });
});

describe('PdfPreviewCache: TTL estricto y LRU', () => {
  it('expira exactamente en TTL aunque el temporizador no haya ejecutado y las lecturas no lo prolongan', async () => {
    let now = 0;
    const value = cache({ now: () => now }), producer = vi.fn(async () => Buffer.from('data'));
    await value.getOrRender(key('ttl'), producer);
    now = 999; await value.getOrRender(key('ttl'), producer);
    expect(producer).toHaveBeenCalledTimes(1);
    now = 1000; await value.getOrRender(key('ttl'), producer);
    expect(producer).toHaveBeenCalledTimes(2);
    expectBudget(value, 64);
  });

  it('inicia TTL al terminar el productor', async () => {
    let now = 0;
    const value = cache({ now: () => now }), pending = deferred(), unused = vi.fn(async () => Buffer.from('new'));
    const result = value.getOrRender(key('slow'), () => pending.promise);
    now = 5000; pending.resolve(Buffer.from('old')); await result;
    now = 5999; expect((await value.getOrRender(key('slow'), unused)).toString()).toBe('old');
    now = 6000; expect((await value.getOrRender(key('slow'), unused)).toString()).toBe('new');
    expect(unused).toHaveBeenCalledTimes(1);
  });

  it('libera Buffers vencidos sin solicitudes y usa un solo timer unref', async () => {
    vi.useFakeTimers();
    const value = cache({ now: () => Date.now() });
    await value.getOrRender(key('idle-a'), async () => Buffer.from('1234'));
    await value.getOrRender(key('idle-b'), async () => Buffer.from('5678'));
    expect(state(value).cachedBytes).toBe(8);
    expect(state(value).timer!.hasRef()).toBe(false); expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(999); expect(state(value).entries.size).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(state(value).entries.size).toBe(0); expect(state(value).cachedBytes).toBe(0);
    expect(state(value).timer).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });

  it('programa el vencimiento más cercano aunque LRU cambie el orden', async () => {
    vi.useFakeTimers();
    const value = cache({ now: () => Date.now() }), unused = vi.fn(async () => Buffer.from('bad'));
    await value.getOrRender(key('early'), async () => Buffer.from('a'));
    await vi.advanceTimersByTimeAsync(500);
    await value.getOrRender(key('late'), async () => Buffer.from('b'));
    await value.getOrRender(key('early'), unused);
    await vi.advanceTimersByTimeAsync(500);
    expect([...state(value).entries.keys()]).toEqual([key('late')]); expect(state(value).cachedBytes).toBe(1);
    expect(vi.getTimerCount()).toBe(1); expect(unused).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500); expect(state(value).cachedBytes).toBe(0);
  });

  it('evicta la entrada menos reciente al alcanzar maxEntries', async () => {
    const value = cache({ maxEntries: 2 }), unused = vi.fn(async () => Buffer.from('bad'));
    await value.getOrRender(key('a'), async () => Buffer.from('a'));
    await value.getOrRender(key('b'), async () => Buffer.from('b'));
    await value.getOrRender(key('a'), unused);
    await value.getOrRender(key('c'), async () => Buffer.from('c'));
    expect([...state(value).entries.keys()]).toEqual([key('a'), key('c')]);
    expect(state(value).cachedBytes).toBe(2);
    await value.getOrRender(key('a'), unused); expect(unused).not.toHaveBeenCalled();
    await value.getOrRender(key('b'), unused); expect(unused).toHaveBeenCalledTimes(1);
  });

  it('aplica LRU también al presupuesto de bytes y conserva entradas que caben exactamente', async () => {
    const value = cache({ maxBytes: 12, maxEntryBytes: 4, maxRenderedBytes: 6, maxEntries: 20 });
    const unused = vi.fn(async () => Buffer.from('bad'));
    for (const id of ['a', 'b', 'c']) await value.getOrRender(key(id), async () => Buffer.from(id.repeat(4)));
    expect(state(value).cachedBytes).toBe(12);
    await value.getOrRender(key('a'), unused);
    await value.getOrRender(key('d'), async () => Buffer.from('dddd'));
    expect([...state(value).entries.keys()]).toEqual([key('c'), key('a'), key('d')]);
    expect(state(value).cachedBytes).toBe(12); expectBudget(value, 12);
    await value.getOrRender(key('c'), unused); expect(unused).not.toHaveBeenCalled();
  });

  it('limita también el número de Buffers vacíos', async () => {
    const value = cache({ maxEntries: 2 });
    for (const id of ['a', 'b', 'c']) await value.getOrRender(key(id), async () => Buffer.alloc(0));
    expect([...state(value).entries.keys()]).toEqual([key('b'), key('c')]);
    expect(state(value).cachedBytes).toBe(0); expect(state(value).reservedBytes).toBe(0);
  });
});

describe('PdfPreviewCache: sobrecarga y tamaños', () => {
  it('permite cuatro productores por defecto, rechaza el quinto sin cola y admite mismo key', async () => {
    const value = new PdfPreviewCache(); caches.push(value);
    const pending = Array.from({ length: 4 }, deferred);
    const results = pending.map((item, index) => value.getOrRender(key(String(index)), () => item.promise));
    const unused = vi.fn(async () => Buffer.from('bad'));
    await expect(value.getOrRender(key('fifth'), unused)).rejects.toMatchObject({
      name: 'PdfCacheBusyError', code: 'PDF_CACHE_BUSY',
    });
    const joined = value.getOrRender(key('0'), unused);
    expect(state(value).inFlight.size).toBe(4); expect(state(value).reservedBytes).toBe(32 * MIB);
    pending.forEach(item => item.resolve(Buffer.from('ok')));
    await Promise.all([...results, joined]); expect(unused).not.toHaveBeenCalled();
    await value.getOrRender(key('fifth'), unused); expect(unused).toHaveBeenCalledTimes(1);
    expectBudget(value, 32 * MIB);
  });

  it('incluye reservas en vuelo en maxBytes y evicta caché antes de admitir trabajo', async () => {
    const value = cache({ maxBytes: 12, maxEntryBytes: 4, maxRenderedBytes: 6, maxEntries: 20 });
    await value.getOrRender(key('old-a'), async () => Buffer.from('aaaa'));
    await value.getOrRender(key('old-b'), async () => Buffer.from('bbbb'));
    const pending = Array.from({ length: 3 }, deferred);
    const results = pending.map((item, index) => value.getOrRender(key(String(index)), () => item.promise));
    expect(state(value).entries.size).toBe(0); expect(state(value).reservedBytes).toBe(12);
    const unused = vi.fn(async () => Buffer.from('bad'));
    await expect(value.getOrRender(key('over-budget'), unused)).rejects.toBeInstanceOf(PdfCacheBusyError);
    const joined = value.getOrRender(key('0'), unused);
    expectBudget(value, 12); expect(unused).not.toHaveBeenCalled();
    pending[0].resolve(Buffer.from('cccc')); await results[0];
    expect(state(value).cachedBytes).toBe(4); expect(state(value).reservedBytes).toBe(8); expectBudget(value, 12);
    pending[1].resolve(Buffer.from('dddd')); pending[2].resolve(Buffer.from('eeee'));
    await Promise.all([...results, joined]);
    expect(state(value).cachedBytes).toBe(12); expect(state(value).reservedBytes).toBe(0); expectBudget(value, 12);
  });

  it('aplica maxInFlight configurable aun cuando quede memoria', async () => {
    const value = cache({ maxInFlight: 1 }), pending = deferred(), unused = vi.fn(async () => Buffer.from('bad'));
    const result = value.getOrRender(key('pending'), () => pending.promise);
    await expect(value.getOrRender(key('other'), unused)).rejects.toBeInstanceOf(PdfCacheBusyError);
    pending.resolve(Buffer.from('ok')); await result;
    await value.getOrRender(key('other'), unused); expect(unused).toHaveBeenCalledTimes(1);
  });

  it('entrega resultados oversized con copias defensivas y single-flight, sin cachearlos', async () => {
    const value = cache({ maxEntryBytes: 4, maxRenderedBytes: 6 }), pending = deferred();
    const producer = vi.fn(() => pending.promise), unused = vi.fn(async () => Buffer.from('12345'));
    const first = value.getOrRender(key('large'), producer), second = value.getOrRender(key('large'), unused);
    const source = Buffer.from('12345'); pending.resolve(source);
    const [a, b] = await Promise.all([first, second]);
    source.fill(0); a.fill(1); expect(b.toString()).toBe('12345');
    expect(producer).toHaveBeenCalledTimes(1); expect(unused).not.toHaveBeenCalled();
    expect(state(value).entries.size).toBe(0); expect(state(value).cachedBytes).toBe(0);
    expect(state(value).reservedBytes).toBe(0); expect(state(value).inFlight.size).toBe(0);
    await value.getOrRender(key('large'), unused); expect(unused).toHaveBeenCalledTimes(1);
  });

  it('aumenta reserva para oversized, rechaza si no cabe y libera el slot para reintentar', async () => {
    const value = cache({ maxBytes: 12, maxEntryBytes: 4, maxRenderedBytes: 6 });
    const pending = Array.from({ length: 3 }, deferred);
    const results = pending.map((item, index) => value.getOrRender(key(String(index)), () => item.promise));
    const failed = expect(results[0]).rejects.toBeInstanceOf(PdfCacheBusyError);
    pending[0].resolve(Buffer.from('12345')); await failed;
    expect(state(value).reservedBytes).toBe(8); expectBudget(value, 12);
    pending[1].resolve(Buffer.from('1')); await results[1];
    pending[2].resolve(Buffer.from('123456')); expect((await results[2]).length).toBe(6);
    expectBudget(value, 12);
    expect((await value.getOrRender(key('0'), async () => Buffer.from('12345'))).length).toBe(5);
    expect(state(value).inFlight.size).toBe(0); expect(state(value).reservedBytes).toBe(0);
  });

  it('expulsa entradas LRU si un resultado oversized necesita más bytes que la reserva', async () => {
    const value = cache({ maxBytes: 12, maxEntryBytes: 4, maxRenderedBytes: 6 });
    await value.getOrRender(key('a'), async () => Buffer.from('aaaa'));
    await value.getOrRender(key('b'), async () => Buffer.from('bbbb'));
    await value.getOrRender(key('large'), async () => Buffer.from('123456'));
    expect([...state(value).entries.keys()]).toEqual([key('b')]);
    expect(state(value).cachedBytes).toBe(4); expectBudget(value, 12);
  });

  it('rechaza outputs mayores que maxRenderedBytes antes de copiarlos y permite reintento', async () => {
    const value = cache({ maxEntryBytes: 4, maxRenderedBytes: 6 });
    const copy = vi.spyOn(Buffer, 'allocUnsafeSlow');
    await expect(value.getOrRender(key('too-large'), async () => Buffer.alloc(7))).rejects.toMatchObject({
      name: 'PdfCacheResultTooLargeError', code: 'PDF_CACHE_RESULT_TOO_LARGE', maxRenderedBytes: 6,
    });
    expect(copy).not.toHaveBeenCalled(); expect(state(value).entries.size).toBe(0);
    expect(state(value).reservedBytes).toBe(0); expect(state(value).inFlight.size).toBe(0);
    await value.getOrRender(key('too-large'), async () => Buffer.from('ok'));
    expect(state(value).entries.size).toBe(1);
  });

  it('admite exactamente 12 MiB por defecto sin retenerlo y rechaza un byte más', async () => {
    const value = new PdfPreviewCache(); caches.push(value);
    const result = await value.getOrRender(key('hard-limit'), async () => Buffer.alloc(12 * MIB));
    expect(result.length).toBe(12 * MIB); expect(state(value).entries.size).toBe(0);
    await expect(value.getOrRender(key('hard-limit'), async () => Buffer.alloc(12 * MIB + 1)))
      .rejects.toBeInstanceOf(PdfCacheResultTooLargeError);
    expect(state(value).reservedBytes).toBe(0);
  });
});

describe('PdfPreviewCache: cierre', () => {
  it('close es idempotente, libera mapas/timer y nunca reinserta un productor pendiente', async () => {
    vi.useFakeTimers();
    const value = cache({ now: () => Date.now() });
    await value.getOrRender(key('cached'), async () => Buffer.from('data'));
    const pending = deferred(), producer = vi.fn(() => pending.promise);
    const result = value.getOrRender(key('pending'), producer);
    const joined = value.getOrRender(key('pending'), async () => Buffer.from('unused'));
    const settled = Promise.allSettled([result, joined]);
    await Promise.resolve(); expect(producer).toHaveBeenCalledTimes(1);
    value.close(); value.close();
    expect(state(value).entries.size).toBe(0); expect(state(value).inFlight.size).toBe(0);
    expect(state(value).cachedBytes).toBe(0); expect(state(value).reservedBytes).toBe(0);
    expect(state(value).timer).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
    pending.resolve(Buffer.from('late'));
    for (const output of await settled) {
      expect(output.status).toBe('rejected');
      if (output.status === 'rejected') expect(output.reason).toBeInstanceOf(PdfCacheClosedError);
    }
    const unused = vi.fn(async () => Buffer.from('bad'));
    await expect(value.getOrRender(key('cached'), unused)).rejects.toMatchObject({ code: 'PDF_CACHE_CLOSED' });
    expect(unused).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    expect(state(value).entries.size).toBe(0); expectBudget(value, 64);
  });

  it('no inicia un productor si close ocurre antes de su primer microtask', async () => {
    const value = cache(), producer = vi.fn(async () => Buffer.from('unused'));
    const result = value.getOrRender(key('never-started'), producer); value.close();
    await expect(result).rejects.toBeInstanceOf(PdfCacheClosedError);
    expect(producer).not.toHaveBeenCalled(); expect(state(value).reservedBytes).toBe(0);
  });
});
