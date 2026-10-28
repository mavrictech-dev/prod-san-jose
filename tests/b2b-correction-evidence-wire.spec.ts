import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { fiscalSnapshotSha256 } from '../packages/sunat-core/src/fiscal-note';
import { correctionEvidenceRequest, correctionEvidenceFreeze, correctionEvidenceHash, correctionEvidenceResponse,
  verifyCorrectionEvidenceResponse, type CorrectionEvidenceRequest } from '../packages/service-access/src/b2b-correction-evidence-wire';

const mocked = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('node:https', () => ({ request: mocked.request }));
import { B2bPrivateHttp } from '../packages/service-access/src/b2b';

const AS_OF = '2026-10-21T18:00:00.000Z';
const NOW = '2026-10-21T18:00:10.000Z';
const HASH = 'a'.repeat(64);
const LIMIT = 2 * 1024 * 1024;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture(): CorrectionEvidenceRequest {
  return { schemaVersion: 'factuez.b2b.correction-evidence-request.v1', requestId: id(1), kind: 'SERVICE', action: 'ORIGINAL',
    binding: { reference: { issuerId: 1, issuerRuc: '20000000001', environment: 'BETA', branchId: id(2), pointId: id(3),
      seriesId: id(4), documentType: '01' }, noteSeriesId: id(5), noteType: '07' }, asOf: AS_OF, payload: { documentId: id(6) } };
}
const response = (request = fixture()) => correctionEvidenceResponse(request, HASH, { evidence: ['opaque', { verified: false }] }, NOW);
function safeError(run: () => unknown, status = 400) {
  try { run(); throw new Error('Expected rejection'); } catch (error) {
    expect(error).toHaveProperty('status', status);
    expect(error).toHaveProperty('code', status === 400 ? 'INVALID_EVIDENCE_REQUEST' : 'INVALID_EVIDENCE_RESPONSE');
  }
}

describe('correction evidence bounded detached JSON', () => {
  it('detaches and freezes every nested node without freezing or retaining caller objects', () => {
    const input = { item: [{ n: 1 }], nullable: null };
    const output = correctionEvidenceFreeze(input);
    expect(output).toEqual(input); expect(output).not.toBe(input); expect(output.item).not.toBe(input.item);
    expect(Object.isFrozen(output)).toBe(true); expect(Object.isFrozen(output.item)).toBe(true);
    expect(Object.isFrozen(output.item[0])).toBe(true); expect(Object.isFrozen(input)).toBe(false);
    input.item[0].n = 2; expect(output.item[0].n).toBe(1);
  });
  it.each([null, true, false, 0, -0, 1.25, '', 'á🚀\u0000\n'])('accepts JSON scalar %j', value => {
    expect(correctionEvidenceFreeze(value)).toEqual(value === 0 ? 0 : value);
  });
  it('accepts null-prototype records but returns detached ordinary JSON', () => {
    const input = Object.assign(Object.create(null), { ok: [1] });
    const output = correctionEvidenceFreeze(input);
    expect(output).toEqual({ ok: [1] }); expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
  });
  it.each([undefined, NaN, Infinity, -Infinity, 1n, () => 1, Symbol('unsafe'), new Date(), new Map(), new Set(), /x/, Buffer.from('x')])(
    'rejects non-JSON input %s', value => safeError(() => correctionEvidenceFreeze(value)));
  it('never invokes proxy traps, including revoked proxies', () => {
    const trap = vi.fn(() => { throw new Error('executed'); });
    const proxy = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap });
    safeError(() => correctionEvidenceFreeze(proxy));
    const revoked = Proxy.revocable({}, {}); revoked.revoke(); safeError(() => correctionEvidenceHash(revoked.proxy));
    expect(trap).not.toHaveBeenCalled();
  });
  it('never invokes getters or JSON hooks', () => {
    const getter = vi.fn(() => 'secret'), toJSON = vi.fn(() => ({}));
    safeError(() => correctionEvidenceFreeze(Object.defineProperty({}, 'secret', { enumerable: true, get: getter })));
    safeError(() => correctionEvidenceFreeze({ toJSON }));
    expect(getter).not.toHaveBeenCalled(); expect(toJSON).not.toHaveBeenCalled();
  });
  it('rejects inherited/custom-prototype state, symbols and hidden properties', () => {
    safeError(() => correctionEvidenceFreeze(Object.create({ hidden: 1 })));
    safeError(() => correctionEvidenceFreeze({ [Symbol('hidden')]: 1 }));
    safeError(() => correctionEvidenceFreeze(Object.defineProperty({}, 'secret', { value: 1 })));
  });
  it.each(['__proto__', 'constructor', 'prototype'])('rejects prototype-control key %s', key => {
    safeError(() => correctionEvidenceFreeze(JSON.parse(`{"${key}":{}}`)));
  });
  it('rejects cycles but supports detached repeated references', () => {
    const cycle: any = {}; cycle.self = cycle; safeError(() => correctionEvidenceFreeze(cycle));
    const shared = { a: 1 }; const output = correctionEvidenceFreeze([shared, shared]);
    expect(output).toEqual([shared, shared]); expect(output[0]).not.toBe(output[1]);
  });
  it('rejects sparse, decorated and accessor arrays without executing accessors', () => {
    safeError(() => correctionEvidenceFreeze(Array(2)));
    const decorated: any = [1]; decorated.secret = 2; safeError(() => correctionEvidenceFreeze(decorated));
    const getter = vi.fn(() => 1), array = [1]; Object.defineProperty(array, '0', { enumerable: true, get: getter });
    safeError(() => correctionEvidenceFreeze(array)); expect(getter).not.toHaveBeenCalled();
    const disguised: any = Array(1); disguised.extra = 1; safeError(() => correctionEvidenceFreeze(disguised));
  });
  it('enforces depth 32 at the root and the complete 100,000-node budget', () => {
    let allowed: unknown = 1;
    for (let i = 0; i < 32; i++) allowed = [allowed];
    expect(correctionEvidenceFreeze(allowed)).toEqual(allowed);
    safeError(() => correctionEvidenceFreeze([allowed]));
    expect(correctionEvidenceFreeze(Array(99999).fill(null))).toHaveLength(99999);
    safeError(() => correctionEvidenceFreeze(Array(100000).fill(null)));
  });
  it('counts the full UTF-8 serialized JSON, including escapes, keys and punctuation', () => {
    expect(correctionEvidenceFreeze('a'.repeat(LIMIT - 2))).toHaveLength(LIMIT - 2);
    safeError(() => correctionEvidenceFreeze('a'.repeat(LIMIT - 1)));
    expect(correctionEvidenceFreeze('\u0000'.repeat(Math.floor(LIMIT / 6)))).toHaveLength(Math.floor(LIMIT / 6));
    safeError(() => correctionEvidenceFreeze('\u0000'.repeat(Math.floor(LIMIT / 6) + 1)));
    safeError(() => correctionEvidenceFreeze('🚀'.repeat(LIMIT / 4)));
    const key = 'x'.repeat(LIMIT - 6);
    expect(correctionEvidenceFreeze({ [key]: 0 })).toHaveProperty(key, 0);
    safeError(() => correctionEvidenceFreeze({ [key + 'x']: 0 }));
  });
  it('hashes canonical sorted JSON identically to fiscalSnapshotSha256', () => {
    const first = { z: ['á', 2, -0, null], a: { '10': 10, '2': 2, empty: {}, boolean: true }, '🚀': false };
    const other = { '🚀': false, a: { boolean: true, empty: {}, '2': 2, '10': 10 }, z: ['á', 2, 0, null] };
    expect(correctionEvidenceHash(first)).toBe(fiscalSnapshotSha256(first));
    expect(correctionEvidenceHash(first)).toBe(correctionEvidenceHash(other));
    expect(correctionEvidenceHash([1, 2])).not.toBe(correctionEvidenceHash([2, 1]));
    expect(correctionEvidenceHash('x')).toBe(createHash('sha256').update('"x"').digest('hex'));
  });
});

describe('correction evidence request', () => {
  it.each(['ORIGINAL', 'PREREQUISITES', 'OUTCOME'] as const)('accepts action %s without interpreting payload', action => {
    const input = fixture(); input.action = action; input.payload = { cdrSignatureVerified: false, unexpectedToOwner: ['opaque'] };
    const output = correctionEvidenceRequest(input);
    expect(output).toEqual(input); expect(output).not.toBe(input); expect(Object.isFrozen(output.binding.reference)).toBe(true);
  });
  it.each(['SERVICE', 'USER'] as const)('accepts typed caller %s', kind => {
    expect(correctionEvidenceRequest({ ...fixture(), kind }).kind).toBe(kind);
  });
  it('accepts lowercase RFC UUID versions including v7, not uppercase or a nil request ID', () => {
    expect(correctionEvidenceRequest({ ...fixture(), requestId: 'abcdef00-0000-7000-8000-000000000001' }).requestId)
      .toBe('abcdef00-0000-7000-8000-000000000001');
    safeError(() => correctionEvidenceRequest({ ...fixture(), requestId: 'ABCDEF00-0000-7000-8000-000000000001' }));
    safeError(() => correctionEvidenceRequest({ ...fixture(), requestId: '00000000-0000-0000-0000-000000000000' }));
  });
  it.each(['01', '03'] as const)('accepts original %s with explicit distinct note grant', documentType => {
    const input = fixture(); input.binding.reference.documentType = documentType; input.binding.noteType = '08';
    expect(correctionEvidenceRequest(input).binding.noteType).toBe('08');
  });
  it.each(['2026-10-21T18:00:00Z', AS_OF, '2024-02-29T23:59:59.999Z'])('accepts canonical UTC timestamp %s', asOf => {
    expect(correctionEvidenceRequest({ ...fixture(), asOf }).asOf).toBe(asOf);
  });
  it.each(['2026-02-29T18:00:00Z', '2026-04-31T18:00:00Z', '2026-10-21T24:00:00Z', '2026-10-21T18:00:60Z',
    '2026-10-21T18:00:00+00:00', '2026-10-21T18:00:00.0Z', '2026-10-21', 'not a date'])('rejects invalid/noncanonical date %s', asOf => {
    safeError(() => correctionEvidenceRequest({ ...fixture(), asOf }));
  });
  it.each(['password', 'credentials', 'certificate', 'token', 'authoritySha256'])('rejects extra root field %s', key => {
    safeError(() => correctionEvidenceRequest({ ...fixture(), [key]: 'secret' }));
  });
  it.each(Object.keys(fixture()))('rejects missing root field %s', key => {
    const input: any = fixture(); delete input[key]; safeError(() => correctionEvidenceRequest(input));
  });
  it.each([
    { schemaVersion: 'v2' }, { requestId: id(1).toUpperCase().replace('00000000', 'ABCDEF00') }, { requestId: 'bad' },
    { kind: 'ADMIN' }, { kind: { toString: 'invalid' } }, { action: 'SIGN' }, { action: { toString: 'invalid' } }, { binding: null },
  ])('rejects malformed request patch %j', patch => safeError(() => correctionEvidenceRequest({ ...fixture(), ...patch })));
  it('rejects production, implicit or malformed paired bindings', () => {
    const changes: ((input: any) => void)[] = [
      i => { i.binding.reference.environment = 'PRODUCTION'; }, i => { i.binding.environment = 'BETA'; },
      i => { i.binding.noteSeriesId = i.binding.reference.seriesId; }, i => { i.binding.noteType = '01'; },
      i => { i.binding.reference.documentType = '07'; }, i => { i.binding.reference.documentType = { toString: 'bad' }; },
      i => { i.binding.reference.issuerId = 0; }, i => { i.binding.reference.issuerRuc = '123'; },
    ];
    for (const change of changes) { const input = fixture(); change(input); safeError(() => correctionEvidenceRequest(input)); }
  });
  it('charges the envelope against the same complete size and depth budget', () => {
    safeError(() => correctionEvidenceRequest({ ...fixture(), payload: 'a'.repeat(LIMIT) }));
    let payload: any = 0; for (let i = 0; i < 32; i++) payload = [payload];
    safeError(() => correctionEvidenceRequest({ ...fixture(), payload }));
  });
});

describe('correction evidence response', () => {
  it('binds exact request bytes semantically, metadata and permanently closed activation flags', () => {
    const request = fixture(), value = response(request);
    expect(Object.keys(value).sort()).toEqual(['schemaVersion', 'requestId', 'requestSha256', 'checkedAt', 'verifiedAt',
      'authoritySha256', 'result', 'candidateOnly', 'fiscalExecutionEnabled', 'transmissionAuthorized'].sort());
    expect(value.requestSha256).toBe(correctionEvidenceHash(request));
    expect(verifyCorrectionEvidenceResponse(value, request, NOW)).toEqual(value);
    expect(Object.isFrozen(value.result)).toBe(true);
    expect(value).toMatchObject({ candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false });
  });
  it('does not assert the meaning, PKI or provenance of opaque owner results', () => {
    const result = { arbitrary: true, cdrSignatureVerified: false };
    const value = correctionEvidenceResponse(fixture(), HASH, result, NOW);
    expect(verifyCorrectionEvidenceResponse(value, fixture(), NOW).result).toEqual(result);
  });
  it.each(['schemaVersion', 'requestId', 'requestSha256', 'checkedAt', 'verifiedAt', 'authoritySha256', 'result',
    'candidateOnly', 'fiscalExecutionEnabled', 'transmissionAuthorized'])('rejects missing response field %s', key => {
    const value: any = { ...response() }; delete value[key];
    safeError(() => verifyCorrectionEvidenceResponse(value, fixture(), NOW), 503);
  });
  it.each([
    { schemaVersion: 'v2' }, { requestId: id(9) }, { requestSha256: 'b'.repeat(64) }, { checkedAt: '2026-10-21T18:00:00Z' },
    { authoritySha256: 'A'.repeat(64) }, { authoritySha256: 'a'.repeat(63) }, { candidateOnly: false },
    { fiscalExecutionEnabled: true }, { transmissionAuthorized: true }, { password: 'extra' },
  ])('rejects response mismatch %j', patch => safeError(() => verifyCorrectionEvidenceResponse({ ...response(), ...patch }, fixture(), NOW), 503));
  it('detects changed payload, action, identity and paired authority', () => {
    const value = response();
    for (const patch of [{ payload: { different: true } }, { kind: 'USER' }, { action: 'OUTCOME' }]) {
      safeError(() => verifyCorrectionEvidenceResponse(value, { ...fixture(), ...patch } as any, NOW), 503);
    }
    const request = fixture(); request.binding.noteType = '08';
    safeError(() => verifyCorrectionEvidenceResponse(value, request, NOW), 503);
  });
  it('accepts exact 30-second age and rejects an older request', () => {
    expect(verifyCorrectionEvidenceResponse(response(), fixture(), '2026-10-21T18:00:30.000Z')).toBeDefined();
    safeError(() => verifyCorrectionEvidenceResponse(response(), fixture(), '2026-10-21T18:00:30.001Z'), 503);
  });
  it('allows at most two seconds clock skew for request and verification, never verification before asOf', () => {
    const value = correctionEvidenceResponse(fixture(), HASH, null, AS_OF);
    expect(verifyCorrectionEvidenceResponse(value, fixture(), '2026-10-21T17:59:58.000Z')).toBeDefined();
    safeError(() => verifyCorrectionEvidenceResponse(value, fixture(), '2026-10-21T17:59:57.999Z'), 503);
    expect(verifyCorrectionEvidenceResponse(response(), fixture(), '2026-10-21T18:00:08.000Z')).toBeDefined();
    safeError(() => verifyCorrectionEvidenceResponse(response(), fixture(), '2026-10-21T18:00:07.999Z'), 503);
    safeError(() => correctionEvidenceResponse(fixture(), HASH, null, '2026-10-21T17:59:59.999Z'), 503);
  });
  it.each(['2026-02-30T18:00:10Z', '2026-10-21T18:00:10+00:00', 'invalid'])('rejects invalid verification/current clock %s', date => {
    safeError(() => correctionEvidenceResponse(fixture(), HASH, null, date), 503);
    safeError(() => verifyCorrectionEvidenceResponse(response(), fixture(), date), 503);
  });
  it('rejects invalid request, result, authority and executable response with safe 503 errors', () => {
    safeError(() => correctionEvidenceResponse({ ...fixture(), kind: 'ADMIN' } as any, HASH, null, NOW), 503);
    safeError(() => correctionEvidenceResponse(fixture(), HASH, { secret: undefined }, NOW), 503);
    safeError(() => correctionEvidenceResponse(fixture(), 'bad', null, NOW), 503);
    safeError(() => correctionEvidenceResponse(fixture(), HASH, 'x'.repeat(LIMIT), NOW), 503);
    const trap = vi.fn();
    safeError(() => verifyCorrectionEvidenceResponse(new Proxy({}, { get: trap }), fixture(), NOW), 503);
    expect(trap).not.toHaveBeenCalled();
    expect(() => correctionEvidenceRequest({})).toThrow(/INVALID_EVIDENCE_REQUEST/);
  });
});

describe('private HTTP evidence paths retain isolated limits and timeout', () => {
  let body = Buffer.from('{}'), options: any, sent: Buffer;
  beforeEach(() => {
    body = Buffer.from('{}'); mocked.request.mockReset();
    mocked.request.mockImplementation((_url: URL, settings: any, callback: (res: any) => void) => {
      options = settings;
      let destroyed = false;
      const req: any = new EventEmitter();
      req.destroy = (error: Error) => { destroyed = true; req.emit('error', error); return req; };
      req.end = (bytes: Buffer) => {
        sent = bytes;
        queueMicrotask(() => {
          const res: any = new EventEmitter(); res.statusCode = 200; res.headers = { 'content-type': 'application/json' };
          callback(res); res.emit('data', body); if (!destroyed) res.emit('end');
        });
      };
      return req;
    });
  });
  afterEach(() => vi.clearAllMocks());
  const client = () => new B2bPrivateHttp('https://owner.invalid', { ca: Buffer.from('synthetic-ca'), cert: Buffer.from('synthetic-cert'), key: Buffer.from('synthetic-key') });
  it.each(['/internal/b2b/correction-evidence', '/internal/b2b/correction-evidence-authorize'])('allows %s with 2MiB request/response and 30s TLS timeout', async path => {
    const input = { payload: 'x'.repeat(LIMIT - 14) }; // Exactly 2MiB including JSON envelope.
    body = Buffer.from(JSON.stringify('x'.repeat(LIMIT - 2)));
    expect(await client().post(path, input, 'synthetic.token')).toHaveLength(LIMIT - 2);
    expect(sent.length).toBe(LIMIT); expect(options.timeout).toBe(30000);
    expect(options.rejectUnauthorized).toBe(true); expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toBe('Bearer synthetic.token');
    await expect(client().post(path, { payload: input.payload + 'x' })).rejects.toMatchObject({ status: 400 });
    body = Buffer.from(JSON.stringify('x'.repeat(LIMIT - 1)));
    await expect(client().post(path, {})).rejects.toMatchObject({ status: 503 });
  });
  it('does not expand any other existing request/response or timeout policy', async () => {
    await expect(client().post('/internal/b2b/introspect', { payload: 'x'.repeat(256 * 1024) })).rejects.toMatchObject({ status: 400 });
    await client().post('/internal/b2b/introspect', {}); expect(options.timeout).toBe(5000);
    body = Buffer.from(JSON.stringify('x'.repeat(256 * 1024)));
    await expect(client().post('/internal/b2b/introspect', {})).rejects.toMatchObject({ status: 503 });
    body = Buffer.from('{}');
    await client().post('/internal/b2b/exports', { action: 'create' }); expect(options.timeout).toBe(240000);
    await client().post('/internal/b2b/webhooks', { action: 'VERIFY' }); expect(options.timeout).toBe(20000);
    await client().post('/internal/b2b/read', { action: 'extract:reauthorize', payload: 'x'.repeat(3 * 1024 * 1024) });
    expect(options.timeout).toBe(20000);
  });
  it('does not allow similar paths, query parameters or invalid bearer material', async () => {
    for (const path of ['/internal/b2b/correction-evidence/', '/internal/b2b/correction-evidence?all=true', '/internal/b2b/correction-write']) {
      await expect(client().post(path, {})).rejects.toMatchObject({ status: 400 });
    }
    await expect(client().post('/internal/b2b/correction-evidence', {}, 'bad token')).rejects.toMatchObject({ status: 400 });
    expect(mocked.request).not.toHaveBeenCalled();
  });
});
