import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { fiscalSnapshotSha256 } from '../packages/sunat-core/src/fiscal-note';
import {
  assertGuideReferenceCodes, GuideCatalogueError, validateGuideReferenceCatalogue,
  type GuideReferenceCatalogue,
} from '../packages/sunat-core/src/fiscal-guide-catalogues';

// Synthetic local references: no official catalogue contents, services or network.
function bundle(overrides: Record<string, unknown> = {}): GuideReferenceCatalogue {
  const unsigned = {
    schemaVersion: 'factuez.guide-reference-catalogue.v1', version: 'synthetic-1.0',
    sourceUrl: 'https://www.sunat.gob.pe/synthetic/reference.json', sourceSha256: 'a'.repeat(64),
    units: ['A0', 'ZZZ'], weightUnits: ['KGM', 'TNE'], ubigeos: ['000001', '999999'],
    referenceStatus: 'LOCAL_REFERENCE_NOT_OFFICIAL', ...overrides,
  };
  return { ...unsigned, sha256: fiscalSnapshotSha256(unsigned) } as GuideReferenceCatalogue;
}
const body = () => ({ origin: { ubigeo: '000001' }, destination: { ubigeo: '999999' },
  weightUnit: 'KGM', items: [{ unitCode: 'A0' }, { unitCode: 'ZZZ' }] });
function rejects(call: () => unknown, code = 'INVALID_GUIDE_REFERENCE_CATALOGUE') {
  let error: unknown;
  try { call(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(GuideCatalogueError);
  expect(error).toMatchObject({ code, message: code });
}
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
function hostileValues(): unknown[] {
  const sparse = new Array(2), decorated = ['A0'];
  Object.defineProperty(decorated, 'extra', { value: 1 });
  const symbol = { [Symbol('extra')]: 1 }, hidden = {};
  Object.defineProperty(hidden, 'hidden', { value: 1 });
  const cyclic: any = {}; cyclic.self = cyclic;
  let deep: unknown = null;
  for (let i = 0; i < 66; i++) deep = { deep };
  return [undefined, () => 1, 1n, NaN, Infinity, new Date(0), Object.create({ inherited: 1 }),
    sparse, decorated, symbol, hidden, cyclic, deep, 'x'.repeat(16385),
    Array(1001).fill(null), Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, null])),
    JSON.parse('{"__proto__":{}}'), { constructor: 'unsafe' }, { prototype: 'unsafe' },
    { ['k'.repeat(121)]: null }, Array(40).fill('x'.repeat(16384)),
    Array.from({ length: 60 }, () => Array(900).fill(null))];
}

describe('local guide reference catalogue', () => {
  it('preserves the provided hash, independently hashes all other fields, and detaches every list', () => {
    const input = frozen(bundle()), { sha256, ...unsigned } = input;
    expect(sha256).toBe(createHash('sha256').update(canonical(unsigned)).digest('hex'));
    const output = validateGuideReferenceCatalogue(input);
    expect(output).toEqual(input); expect(output).not.toBe(input);
    for (const key of ['units', 'weightUnits', 'ubigeos'] as const) {
      expect(output[key]).not.toBe(input[key]); output[key].push('detached');
      expect(input[key]).not.toContain('detached');
    }
    const mutable = bundle(), detached = validateGuideReferenceCatalogue(mutable);
    mutable.units[0] = 'XX'; expect(detached.units[0]).toBe('A0');
  });
  it('accepts key reordering, null prototypes, version boundaries and provenance without trust', () => {
    const input = bundle({ version: 'A' + '._-9'.repeat(19) + 'abc', sourceSha256: '0'.repeat(64) });
    expect(input.version).toHaveLength(80);
    const reordered = Object.fromEntries(Object.entries(input).reverse());
    expect(validateGuideReferenceCatalogue(reordered)).toEqual(input);
    expect(validateGuideReferenceCatalogue(Object.assign(Object.create(null), input))).toEqual(input);
    expect(validateGuideReferenceCatalogue(bundle({ version: '0' })).version).toBe('0');
  });
  it.each([
    ['schemaVersion', 'factuez.guide-reference-catalogue.v2'], ['referenceStatus', 'OFFICIAL'],
    ['version', ''], ['version', '.v1'], ['version', 'a'.repeat(81)], ['version', 'v 1'],
    ['version', 'v1\n'], ['version', 'é'], ['sourceSha256', 'A'.repeat(64)],
    ['sourceSha256', 'a'.repeat(63)], ['sourceSha256', 'a'.repeat(64) + '\n'],
    ['units', []], ['units', ['a0']], ['units', [' A0']], ['units', ['A']],
    ['units', ['AAAA']], ['units', ['A0\n']], ['units', ['A0', 'A0']], ['units', ['ZZZ', 'A0']],
    ['units', [12]], ['units', 'A0'], ['weightUnits', []], ['weightUnits', ['LB']],
    ['weightUnits', ['KGM', 'KGM']], ['weightUnits', ['TNE', 'KGM']], ['weightUnits', ['KGM\n']],
    ['ubigeos', []], ['ubigeos', ['00001']], ['ubigeos', ['0000001']], ['ubigeos', ['000001\n']],
    ['ubigeos', ['１２３４５６']], ['ubigeos', [1]], ['ubigeos', ['999999', '000001']],
    ['ubigeos', ['000001', '000001']], ['extra', true],
  ])('rejects malformed or noncanonical %s: %j even with a matching hash', (key, value) => {
    rejects(() => validateGuideReferenceCatalogue(bundle({ [key]: value })));
  });
  it('requires every field and an exact object, and never repairs hash drift', () => {
    for (const key of Object.keys(bundle())) {
      const input: any = bundle(); delete input[key]; rejects(() => validateGuideReferenceCatalogue(input));
    }
    for (const input of [null, true, 1, 'bundle', [], ...hostileValues()]) rejects(() => validateGuideReferenceCatalogue(input));
    for (const sha256 of ['b'.repeat(64), 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(64) + '\n', null]) {
      const input = { ...bundle(), sha256 }, before = structuredClone(input);
      rejects(() => validateGuideReferenceCatalogue(input)); expect(input).toEqual(before);
    }
    for (const patch of [{ version: 'changed' }, { sourceSha256: 'b'.repeat(64) }, { units: ['A0'] }]) {
      rejects(() => validateGuideReferenceCatalogue({ ...bundle(), ...patch }));
    }
  });
  it('enforces list bounds, allowing any synthetic codes that satisfy the profile', () => {
    const units = Array.from({ length: 201 }, (_, i) => `A${i.toString(36).toUpperCase().padStart(2, '0')}`).sort();
    const ubigeos = Array.from({ length: 501 }, (_, i) => String(i).padStart(6, '0'));
    expect(validateGuideReferenceCatalogue(bundle({ units: units.slice(0, 200), ubigeos: ubigeos.slice(0, 500) })).units).toHaveLength(200);
    rejects(() => validateGuideReferenceCatalogue(bundle({ units })));
    rejects(() => validateGuideReferenceCatalogue(bundle({ ubigeos })));
    for (const weightUnits of [['KGM'], ['TNE']]) {
      expect(validateGuideReferenceCatalogue(bundle({ units: ['A0'], ubigeos: ['000001'], weightUnits })).weightUnits).toEqual(weightUnits);
    }
  });
  it.each([
    'http://www.sunat.gob.pe/a', 'https://sunat.gob.pe/a', 'https://evil.test/a',
    'https://www.sunat.gob.pe.evil.test/a', 'https://evil.sunat.gob.pe/a',
    'https://user@www.sunat.gob.pe/a', 'https://@www.sunat.gob.pe/a',
    'https://user:pass@cpe.sunat.gob.pe/a', 'https://www.sunat.gob.pe:444/a',
    'https://www.sunat.gob.pe/a?q=1', 'https://www.sunat.gob.pe/a?',
    'https://www.sunat.gob.pe/a#fragment', 'https://www.sunat.gob.pe/a#',
    ' https://www.sunat.gob.pe/a', 'https://www.sunat.gob.pe/a\n',
    'https://www.sunat.gob.pe/a\\b', 'https://www.sunat.gob.pe/%00',
    'https://www.sunat.gob.pe/%0a', 'https://www.sunat.gob.pe/%1F',
    'https://www.sunat.gob.pe/%7f', 'https://www.sunat.gob.pe/%C2%85',
    'https://www.sunat.gob.pe/%250A', 'https://www.sunat.gob.pe/%25250d',
    'https://www.sunat.gob.pe/%zz', 'https://www.sunat.gob.pe/%FF',
    'https://www.sunat.gob.pe/' + 'a'.repeat(501 - 'https://www.sunat.gob.pe/'.length),
  ])('rejects unsafe source URL %j', sourceUrl => rejects(() => validateGuideReferenceCatalogue(bundle({ sourceUrl }))));
  it.each(['https://www.sunat.gob.pe', 'https://cpe.sunat.gob.pe/a%20b.pdf',
    'https://cpe.sunat.gob.pe:443/a', 'https://www.sunat.gob.pe/%C3%A9',
    'https://www.sunat.gob.pe/' + 'a'.repeat(500 - 'https://www.sunat.gob.pe/'.length)])('accepts a bounded HTTPS provenance URL %j', sourceUrl => {
    expect(validateGuideReferenceCatalogue(bundle({ sourceUrl })).sourceUrl).toBe(sourceUrl);
  });
  it('rejects getters, toJSON and proxies without executing them, including revoked proxies', () => {
    const effect = vi.fn(() => { throw new Error('must not execute'); });
    const getter = bundle(); Object.defineProperty(getter, 'version', { get: effect, enumerable: true });
    const list = ['A0']; Object.defineProperty(list, '0', { get: effect, enumerable: true });
    const proxy = new Proxy({}, { get: effect, ownKeys: effect, getPrototypeOf: effect });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const input of [getter, { ...bundle(), units: list }, proxy, revoked.proxy,
      { ...bundle(), units: proxy }, { ...bundle(), toJSON: effect }]) rejects(() => validateGuideReferenceCatalogue(input));
    expect(effect).not.toHaveBeenCalled();
  });
});

describe('local reference code membership', () => {
  const check = (value: unknown) => rejects(() => assertGuideReferenceCodes(bundle(), value), 'GUIDE_REFERENCE_CODE_NOT_ENABLED');
  it('checks all requested codes, ignores unrelated safe fields and returns a detached bundle', () => {
    const catalogue = frozen(bundle()), input = frozen({ ...body(), transport: { arbitrary: true },
      origin: { ubigeo: '000001', address: 'synthetic' }, items: [{ unitCode: 'A0', description: 'synthetic' }] });
    const result = assertGuideReferenceCodes(catalogue, input);
    expect(result).toEqual(catalogue); expect(result).not.toBe(catalogue);
    result.units.push('XX'); expect(catalogue.units).not.toContain('XX');
    expect(assertGuideReferenceCodes(catalogue, { ...body(), weightUnit: 'TNE' })).toEqual(catalogue);
    expect(assertGuideReferenceCodes(catalogue, { ...body(), items: Array(100).fill({ unitCode: 'A0' }) })).toEqual(catalogue);
  });
  it('validates the bundle first, preserving its error code without inspecting the body', () => {
    const effect = vi.fn(); const input = new Proxy({}, { get: effect });
    rejects(() => assertGuideReferenceCodes({ ...bundle(), sha256: '0'.repeat(64) }, input));
    expect(effect).not.toHaveBeenCalled();
  });
  it('rejects missing/malformed bodies, locations, items and unknown codes at either end', () => {
    for (const input of [null, [], 'body', {}, ...hostileValues()]) check(input);
    for (const key of ['origin', 'destination', 'weightUnit', 'items']) {
      const input: any = body(); delete input[key]; check(input);
    }
    for (const key of ['origin', 'destination']) {
      for (const location of [null, [], {}, { ubigeo: 1 }, { ubigeo: '000001\n' }, { ubigeo: '000002' }]) check({ ...body(), [key]: location });
    }
    for (const weightUnit of [null, 1, '', 'LB', 'kgm', 'KGM\n']) check({ ...body(), weightUnit });
    rejects(() => assertGuideReferenceCodes(bundle({ weightUnits: ['KGM'] }), { ...body(), weightUnit: 'TNE' }), 'GUIDE_REFERENCE_CODE_NOT_ENABLED');
    for (const items of [null, {}, [], Array(101).fill({ unitCode: 'A0' }), [null], [[]], [{}],
      [{ unitCode: 1 }], [{ unitCode: 'A0\n' }], [{ unitCode: 'XX' }], [{ unitCode: 'A0' }, { unitCode: 'XX' }]]) check({ ...body(), items });
  });
  it('rejects unsafe values even in ignored body fields, without invoking executable inputs', () => {
    for (const unsafe of hostileValues()) check({ ...body(), ignored: unsafe });
    const effect = vi.fn(() => { throw new Error('must not execute'); });
    const getter = { ...body() }; Object.defineProperty(getter, 'origin', { get: effect, enumerable: true });
    const location = {}; Object.defineProperty(location, 'ubigeo', { get: effect, enumerable: true });
    const item = {}; Object.defineProperty(item, 'unitCode', { get: effect, enumerable: true });
    const proxy = new Proxy({}, { get: effect, ownKeys: effect, getPrototypeOf: effect });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const input of [getter, { ...body(), origin: location }, { ...body(), items: [item] },
      proxy, revoked.proxy, { ...body(), items: proxy }, { ...body(), ignored: proxy },
      { ...body(), toJSON: effect }]) check(input);
    expect(effect).not.toHaveBeenCalled();
  });
});
