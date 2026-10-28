import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '../services/billing-service/node_modules/@nestjs/core';
import { METHOD_METADATA, PATH_METADATA } from '../services/billing-service/node_modules/@nestjs/common/constants';
import { B2bSecurityError } from '../packages/contracts/src/b2b-security';
import type { EstablishmentContext } from '../services/billing-service/src/b2b/guide-establishments';
import { BillingGuideEstablishmentController, BillingGuideEstablishmentModule } from '../services/billing-service/src/b2b/guide-establishment-http';
import { b2bCertificates, fingerprint } from './b2b-tls.fixture';

const TOKEN = 'synthetic-human-admin-token', BASE = '/internal/b2b/guide-establishments';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const input = () => ({ expectedRevision: 0, expectedIssuerRevision: 2, entries: [{ branchId: id(1), branchRevision: 3,
  establishmentCode: '0001', ubigeo: '150101', address: 'SYNTHETIC LOCAL ADDRESS' }] });
const result = (): any => ({ schemaVersion: 'factuez.guide-establishment-registry.v1', companyId: 99, issuerRuc: '20000000001',
  issuerRevision: 2, revision: 1, snapshot: { schemaVersion: 'factuez.guide-establishments.v1', companyId: 99,
    issuerRuc: '20000000001', issuerRevision: 2, revision: 1, entries: input().entries, actorId: id(90), authRevision: 7,
    at: '2026-10-22T00:00:00.000Z', source: 'ADMIN_LOCAL_CONFIGURATION', sha256: 'a'.repeat(64) },
  stale: false, candidateOnly: true, officialValidation: false, fiscalExecutionEnabled: false, transmissionAuthorized: false });

/** Actual Nest HTTPS loopback + ephemeral PKI. Explicit core doubles, no DB or production auth is created.
 * These tests verify transport/delegation; human GLOBAL/permissions/step-up verification is the core's job.
 */
describe('private local guide establishment registry HTTP', () => {
  let tls: ReturnType<typeof b2bCertificates>, app: any, port: number;
  const core = {
    read: vi.fn(async (_token: string, _companyId: number, _ctx: EstablishmentContext): Promise<unknown> => result()),
    replace: vi.fn(async (_token: string, _companyId: number, _input: unknown, _ctx: EstablishmentContext): Promise<unknown> => result()),
  };
  type Options = { method?: string; body?: unknown; raw?: string; peer?: 'resource' | 'other' | null; trust?: boolean;
    chunked?: boolean; incomplete?: boolean; headers?: Record<string, string | string[] | undefined> };
  function send(action = 'read', options: Options = {}) {
    const peer = options.peer === undefined ? 'resource' : options.peer;
    const bytes = options.raw ?? JSON.stringify(options.body ?? (action === 'replace' ? { companyId: 99, input: input() } : { companyId: 99 }));
    const headers: Record<string, string | string[]> = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json',
      ...(options.chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': String(Buffer.byteLength(bytes)) }) };
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      const previous = Object.keys(headers).find(key => key.toLowerCase() === name.toLowerCase());
      if (previous) delete headers[previous];
      if (value !== undefined) headers[name] = value;
    }
    return new Promise<{ status: number; body: any; headers: any }>((resolve, reject) => {
      const req = httpsRequest({ hostname: '127.0.0.1', port, path: `${BASE}/${action}`, method: options.method ?? 'POST',
        rejectUnauthorized: true, timeout: options.incomplete ? 14000 : 5000, ...(options.trust === false ? {} : { ca: tls.ca }),
        ...(peer ? { cert: tls[peer], key: tls.key } : {}), headers }, res => {
        const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
        res.on('end', () => { try { resolve({ status: res.statusCode!, headers: res.headers,
          body: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (error) { reject(error); }
          finally { if (options.incomplete) req.destroy(); } });
      });
      req.on('error', reject); req.on('timeout', () => req.destroy(new Error('SYNTHETIC_LOOPBACK_TIMEOUT')));
      if (options.incomplete) req.write(bytes);
      else if (options.chunked) { for (let offset = 0; offset < bytes.length; offset += 8192) req.write(bytes.slice(offset, offset + 8192)); req.end(); }
      else req.end(bytes);
    });
  }
  function direct(body: unknown = { companyId: 99 }) {
    const req: any = { url: `${BASE}/read`, rawHeaders: ['Authorization', `Bearer ${TOKEN}`], body,
      socket: { encrypted: true, authorized: true, getPeerCertificate: () => ({ fingerprint256: fingerprint(tls.resource) }) } };
    const res: any = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    return { req, res, controller: new BillingGuideEstablishmentController(core, [fingerprint(tls.resource)]) };
  }
  const untouched = () => { expect(core.read).not.toHaveBeenCalled(); expect(core.replace).not.toHaveBeenCalled(); };
  function safeError(r: { status: number; body: any; headers: any }, status: number, code?: string) {
    expect(r.status).toBe(status);
    expect(Object.keys(r.body).sort()).toEqual(['code', 'message', 'requestId', 'retryable', 'schemaVersion']);
    expect(r.body.schemaVersion).toBe('factuez.b2b.v1'); expect(r.body.requestId).toMatch(UUID);
    expect(r.body.message).toBe(r.body.code); if (code) expect(r.body.code).toBe(code);
    expect(r.body.retryable).toBe(status === 429 || status === 503);
    expect(r.headers['cache-control']).toBe('private, no-store'); expect(r.headers['x-content-type-options']).toBe('nosniff');
  }
  beforeAll(async () => {
    tls = b2bCertificates();
    // The module owns parsing, pin validation runs before JSON.parse even on malformed/oversized bodies.
    app = await NestFactory.create(BillingGuideEstablishmentModule.isolated(core, [fingerprint(tls.resource)]), {
      logger: false, bodyParser: false,
      httpsOptions: { ca: tls.ca, cert: tls.server, key: tls.key, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    });
    await app.listen(0, '127.0.0.1'); port = (app.getHttpServer().address() as AddressInfo).port;
  }, 30000);
  afterAll(async () => { await app?.close(); });
  beforeEach(() => {
    core.read.mockReset().mockImplementation(async () => result()); core.replace.mockReset().mockImplementation(async () => result());
  });

  it('declares one controller with exactly two fixed private POSTs', () => {
    expect(Reflect.getMetadata(PATH_METADATA, BillingGuideEstablishmentController)).toBe('internal/b2b/guide-establishments');
    const routes = Object.getOwnPropertyNames(BillingGuideEstablishmentController.prototype)
      .filter(name => Reflect.hasMetadata(METHOD_METADATA, (BillingGuideEstablishmentController.prototype as any)[name]));
    expect(routes).toEqual(['read', 'replace']);
    for (const route of routes) {
      const handler = (BillingGuideEstablishmentController.prototype as any)[route];
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(route); expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(1);
    }
  });
  it.each(['read', 'replace'] as const)('delegates %s with fresh server context and retains privileged local map data', async action => {
    const r = await send(action, { headers: { 'X-Request-Id': id(70), 'X-Peer': 'caller-peer', 'X-Factuez-Actor-Kind': 'SERVICE',
      'X-User-Role': 'GLOBAL', 'X-Step-Up-Verified': 'true' } });
    expect(r.status).toBe(200); expect(r.body).toEqual(result());
    expect(r.headers['cache-control']).toBe('private, no-store'); expect(r.headers['x-content-type-options']).toBe('nosniff');
    const calls = core[action].mock.calls; expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 2)).toEqual([TOKEN, 99]);
    if (action === 'replace') expect(calls[0][2]).toEqual(input());
    const ctx = calls[0].at(-1) as EstablishmentContext;
    expect(Object.keys(ctx).sort()).toEqual(['peer', 'requestId']); expect(ctx.requestId).toMatch(UUID);
    expect(ctx.requestId).not.toBe(id(70)); expect(ctx.peer).toBe(fingerprint(tls.resource)); expect(Object.isFrozen(ctx)).toBe(true);
    expect(core[action === 'read' ? 'replace' : 'read']).not.toHaveBeenCalled();
  });
  it('generates a new UUID per call and accepts chunked bounded JSON', async () => {
    expect((await send()).status).toBe(200); expect((await send('read', { chunked: true })).status).toBe(200);
    expect(core.read.mock.calls[0][2].requestId).not.toBe(core.read.mock.calls[1][2].requestId);
  });
  it.each([1, 2147483647])('accepts positive int32 company %s without selecting by RUC', async companyId => {
    expect((await send('read', { body: { companyId } })).status).toBe(200);
    expect(core.read.mock.calls[0][1]).toBe(companyId);
  });
  it.each([0, -1, 1.5, 2147483648, '99', null, true, {}, []])('rejects non-positive-int32 company %j', async companyId => {
    safeError(await send('read', { body: { companyId } }), 400); untouched();
  });
  it.each(['read', 'replace'])('requires exact %s envelope and rejects caller authority/context/secrets/environment', async action => {
    const base = action === 'read' ? { companyId: 99 } : { companyId: 99, input: input() };
    for (const key of ['actor', 'actorId', 'permissions', 'stepUpVerified', 'ctx', 'requestId', 'peer', 'ruc', 'issuerRuc',
      'certificate', 'cert', 'password', 'pass', 'environment']) {
      safeError(await send(action, { body: { ...base, [key]: key === 'environment' ? 'PRODUCTION' : 'caller-claim' } }), 400);
    }
    untouched();
  });
  it.each([{}, [], { input: input() }, { companyId: 99, input: {} }, { companyId: 99, input: null },
    { companyId: 99, input: { ...input(), cert: 'forbidden' } },
    { companyId: 99, input: { ...input(), environment: 'PRODUCTION' } },
    { companyId: 99, input: { ...input(), entries: [{ ...input().entries[0], password: 'forbidden' }] } },
  ])('rejects malformed replacement or secret-bearing input %j', async body => {
    safeError(await send('replace', { body }), 400); untouched();
  });
  it.each(['?', '?ruc=20000000001', '?companyId=99', '?environment=PRODUCTION'])('rejects query suffix %s', async suffix => {
    for (const action of ['read', 'replace']) safeError(await send(action + suffix), 400);
    untouched();
  });
  it.each([undefined, '', 'Basic secret', 'Bearer ', 'bearer token', 'Bearer a,b', 'Bearer a b', 'Bearer ' + 'x'.repeat(8193)])('rejects malformed Bearer case %#', async authorization => {
    safeError(await send('read', { raw: '{', headers: { Authorization: authorization } }), 401, 'INVALID_TOKEN'); untouched();
  });
  it.each(['authorization', 'x-extra', 'content-type', 'x-user-role'])('rejects duplicate %s before parsing', async name => {
    const value = name === 'authorization' ? `Bearer ${TOKEN}` : name === 'content-type' ? 'application/json' : 'caller-value';
    safeError(await send('read', { raw: '{', headers: { [name]: [value, value] } }), name === 'authorization' ? 401 : 400); untouched();
  });
  it('requires a verified TLS client certificate and trusted server', async () => {
    await expect(send('read', { peer: null })).rejects.toThrow(); await expect(send('read', { trust: false })).rejects.toThrow(); untouched();
  });
  it.each(['{', 'x'.repeat(128 * 1024 + 1)])('rejects an unpinned peer before parsing or body-size inspection', async raw => {
    safeError(await send('read', { raw, peer: 'other', headers: { 'X-Forwarded-Client-Cert': fingerprint(tls.resource),
      'X-Client-Cert': 'synthetic-spoof', 'X-User-Role': 'GLOBAL' } }), 403, 'PRIVATE_PEER_REQUIRED'); untouched();
  });
  it.each(['{', '[]', 'null', '"scalar"', '{"companyId":99} trailing'])('sanitizes malformed/invalid JSON %s globally', async raw => {
    safeError(await send('read', { raw }), 400); untouched();
  });
  it.each([false, true])('bounds actual wire bytes to 128 KiB, chunked=%s', async chunked => {
    safeError(await send('read', { raw: ' '.repeat(128 * 1024) + '{', chunked }), 413); untouched();
  });
  it('counts whitespace on wire and accepts exactly 128 KiB', async () => {
    const json = '{"companyId":99}';
    expect((await send('read', { raw: json + ' '.repeat(128 * 1024 - Buffer.byteLength(json)) })).status).toBe(200);
  });
  it('returns sanitized 408 and closes a body that never finishes within the total 10-second deadline', async () => {
    const started = Date.now();
    const r = await send('read', { raw: '{"companyId":', chunked: true, incomplete: true });
    safeError(r, 408, 'ESTABLISHMENT_BODY_TIMEOUT'); expect(r.headers.connection).toBe('close');
    expect(Date.now() - started).toBeGreaterThanOrEqual(9000); untouched();
  });
  it('clears body timers after HTTPS completion, parse failure and streaming size failure', async () => {
    const schedule = vi.spyOn(globalThis, 'setTimeout'), cancel = vi.spyOn(globalThis, 'clearTimeout');
    try {
      expect((await send()).status).toBe(200);
      safeError(await send('read', { raw: '{' }), 400);
      safeError(await send('read', { raw: ' '.repeat(128 * 1024 + 1), chunked: true }), 413);
      const timers = schedule.mock.calls.flatMap((args, index) => args[1] === 10000 ? [schedule.mock.results[index].value] : []);
      expect(timers).toHaveLength(3);
      for (const timer of timers) expect(cancel.mock.calls.some(args => args[0] === timer)).toBe(true);
    } finally { schedule.mockRestore(); cancel.mockRestore(); }
  });
  it.each([{ 'Content-Type': 'text/plain' }, { 'Content-Type': undefined }, { 'Content-Encoding': 'gzip' }])('rejects unsupported body headers %j', async headers => {
    safeError(await send('read', { headers }), 400); untouched();
  });
  it.each(['read', 'replace'] as const)('checks peer and Bearer before body getters on direct %s calls', async action => {
    const { req, res, controller } = direct(), getter = vi.fn(() => { throw new Error('BODY_SECRET'); });
    Object.defineProperty(req, 'body', { get: getter });
    req.socket.encrypted = false;
    await expect(controller[action](req, res)).rejects.toMatchObject({ status: 403, code: 'PRIVATE_PEER_REQUIRED' });
    req.socket.encrypted = true; req.socket.authorized = false;
    await expect(controller[action](req, res)).rejects.toMatchObject({ status: 403 });
    req.socket.authorized = true; req.rawHeaders = [];
    await expect(controller[action](req, res)).rejects.toMatchObject({ status: 401 });
    req.rawHeaders = ['Authorization', `Bearer ${TOKEN}`];
    await expect(controller[action](req, res)).rejects.toMatchObject({ status: 400 });
    expect(getter).not.toHaveBeenCalled(); untouched();
  });
  it('rejects raw header getters and missing raw headers without evaluating them', async () => {
    const { req, res, controller } = direct(), getter = vi.fn();
    delete req.rawHeaders; await expect(controller.read(req, res)).rejects.toMatchObject({ status: 400 });
    Object.defineProperty(req, 'rawHeaders', { get: getter });
    await expect(controller.read(req, res)).rejects.toMatchObject({ status: 400 }); expect(getter).not.toHaveBeenCalled(); untouched();
  });
  it('rejects direct unsafe body objects without getters, hooks or proxy traps', async () => {
    const hook = vi.fn(), accessor = { companyId: 99 }, cycle: any = { companyId: 99 }; cycle.self = cycle;
    Object.defineProperty(accessor, 'companyId', { enumerable: true, get: hook });
    for (const body of [accessor, new Proxy({ companyId: 99 }, { get: hook, ownKeys: hook }),
      { companyId: 99, toJSON: hook }, cycle, { companyId: 99, input: { get entries() { return hook(); } } }]) {
      const { req, res, controller } = direct(body);
      await expect(controller.read(req, res)).rejects.toMatchObject({ status: 400 });
    }
    expect(hook).not.toHaveBeenCalled(); untouched();
  });
  it('bounds direct-call JSON as well', async () => {
    const { req, res, controller } = direct({ companyId: 99, padding: 'x'.repeat(128 * 1024) });
    await expect(controller.read(req, res)).rejects.toMatchObject({ status: 413 }); untouched();
  });
  it('passes a detached frozen replacement to the core and returns a detached frozen local map', async () => {
    const source = result(); core.replace.mockResolvedValue(source);
    const body = { companyId: 99, input: input() }, { req, res, controller } = direct(body);
    await controller.replace(req, res);
    const forwarded: any = core.replace.mock.calls[0][2], returned = res.json.mock.calls[0][0];
    expect(forwarded).toEqual(body.input); expect(forwarded).not.toBe(body.input);
    expect(Object.isFrozen(forwarded.entries[0])).toBe(true); expect(Object.isFrozen(returned.snapshot.entries[0])).toBe(true);
    expect(returned).toEqual(source); expect(returned).not.toBe(source); expect(returned.snapshot).not.toBe(source.snapshot);
    body.input.entries[0].address = 'CHANGED REQUEST'; source.snapshot.entries[0].address = 'CHANGED RESPONSE';
    expect(forwarded.entries[0].address).toBe('SYNTHETIC LOCAL ADDRESS'); expect(returned.snapshot.entries[0].address).toBe('SYNTHETIC LOCAL ADDRESS');
  });
  it.each(['read', 'replace'] as const)('forwards core auth/conflict/rate denials safely for %s', async action => {
    for (const [status, code] of [[401, 'INVALID_TOKEN'], [403, 'ESTABLISHMENT_ADMIN_REQUIRED'], [404, 'ESTABLISHMENT_ISSUER_NOT_FOUND'],
      [409, 'ESTABLISHMENT_AUTHORITY_CHANGED'], [412, 'SYNTHETIC_PRECONDITION'], [428, 'SYNTHETIC_STEP_UP_REQUIRED'],
      [429, 'RATE_LIMITED'], [503, 'ADMIN_AUTHORITY_UNAVAILABLE']] as const) {
      core[action].mockRejectedValue(new B2bSecurityError(status, code)); const r = await send(action); safeError(r, status, code);
      if (status === 401) expect(r.headers['www-authenticate']).toBe('Bearer');
      if (status === 429) expect(r.headers['retry-after']).toBe('60');
      expect(r.body.snapshot).toBeUndefined();
    }
  });
  it.each(['read', 'replace'] as const)('sanitizes unexpected core errors for %s', async action => {
    core[action].mockRejectedValue(new Error('SECRET_DATABASE_CONNECTION_AND_PASSWORD'));
    const r = await send(action); safeError(r, 503, 'OWNER_UNAVAILABLE'); expect(JSON.stringify(r.body)).not.toContain('SECRET');
  });
  it('allows bounded privileged responses over 128 KiB through 512 KiB', async () => {
    const value = result(); value.snapshot.entries[0].address = 'x'.repeat(200 * 1024);
    core.read.mockResolvedValue(value); expect((await send()).body).toEqual(value);
    const small = { padding: '' }, size = Buffer.byteLength(JSON.stringify(small));
    core.read.mockResolvedValue({ padding: 'x'.repeat(512 * 1024 - size) }); expect((await send()).status).toBe(200);
  });
  it.each(['read', 'replace'] as const)('rejects oversized/executable %s results without exposing local data', async action => {
    const hook = vi.fn(), accessor = result(), cycle: any = {}; cycle.self = cycle;
    Object.defineProperty(accessor.snapshot, 'entries', { enumerable: true, get: hook });
    const proxy = new Proxy(result(), {
      // Promise resolution itself reads `then`; only data inspection is under the adapter's control.
      get(target, key, receiver) { if (key === 'then') return undefined; hook(); return Reflect.get(target, key, receiver); },
      ownKeys(target) { hook(); return Reflect.ownKeys(target); },
    });
    for (const value of [{ padding: 'x'.repeat(512 * 1024) }, accessor, proxy,
      { ...result(), toJSON: hook }, cycle, undefined, NaN, new Date()]) {
      core[action].mockResolvedValue(value); safeError(await send(action), 503, 'INCONSISTENT_OWNER_RESPONSE');
    }
    expect(hook).not.toHaveBeenCalled();
  });
  it('has no GET, RUC lookup, public API or fiscal execution routes', async () => {
    for (const action of ['read', 'replace']) safeError(await send(action, { method: 'GET' }), 404);
    for (const action of ['ruc/20000000001', 'read/99', 'sign', 'send', 'reserve', 'production', '../../../b2b/v1/guide-establishments'])
      safeError(await send(action), 404);
    untouched();
  });
  it('requires explicit core methods and unique bounded lowercase admin peer pins', () => {
    for (const peers of [[], ['invalid'], ['A'.repeat(64)], [fingerprint(tls.resource), fingerprint(tls.resource)],
      Array.from({ length: 101 }, (_, i) => i.toString(16).padStart(64, '0')), [null]])
      expect(() => BillingGuideEstablishmentModule.isolated(core, peers as any)).toThrow();
    for (const owner of [null, {}, { read: vi.fn() }, { replace: vi.fn() }])
      expect(() => BillingGuideEstablishmentModule.isolated(owner as any, [fingerprint(tls.resource)])).toThrow();
  });
  it('snapshots and freezes configured pins against subsequent caller mutation', () => {
    const peers = [fingerprint(tls.resource)], module = BillingGuideEstablishmentModule.isolated(core, peers);
    peers[0] = fingerprint(tls.other); peers.push('a'.repeat(64));
    const provider: any = module.providers!.find((value: any) => Array.isArray(value.useValue));
    expect(provider.useValue).toEqual([fingerprint(tls.resource)]); expect(Object.isFrozen(provider.useValue)).toBe(true);
    expect(module.imports).toBeUndefined(); expect(module.exports).toBeUndefined();
  });
});
