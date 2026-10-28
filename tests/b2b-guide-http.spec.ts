import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '../services/billing-service/node_modules/@nestjs/core';
import { METHOD_METADATA, PATH_METADATA } from '../services/billing-service/node_modules/@nestjs/common/constants';
import { B2bSecurityError, type B2bPrincipal, type B2bIdentityScope } from '../packages/contracts/src/b2b-security';
import type { B2bGuideBinding } from '../packages/contracts/src/b2b-guide-security';
import { correctionEvidenceHash } from '../packages/service-access/src/b2b-correction-evidence-wire';
import { BillingGuideController, BillingGuideHttpErrorFilter, BillingGuideModule } from '../services/billing-service/src/b2b/guide-http';
import { B2bGuideCommands, B2bGuideController, B2bGuideHttpErrorFilter, B2bGuideModule, HttpB2bGuideOwner, type B2bGuideAction } from '../services/b2b-api-service/src/guides';
import { createB2bDraftApplication } from '../services/b2b-api-service/src/draft-application';
import { B2bReads } from '../services/b2b-api-service/src/read';
import { b2bCertificates, fingerprint } from './b2b-tls.fixture';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TOKEN = 'synthetic-guide-http-token', KEY = 'synthetic-guide-command-0001';
const scopes: B2bIdentityScope[] = ['b2b:guides:read', 'b2b:guides:write', 'b2b:documents:read', 'b2b:guide-operations:read'];
const binding: B2bGuideBinding = { anchor: { issuerId: 99, issuerRuc: '20000000001', environment: 'BETA', branchId: id(1), pointId: id(2), seriesId: id(3), documentType: '01' }, guideSeriesId: id(4), guideType: '09' };
const body = () => ({ description: 'FICTITIOUS DRAFT ONLY', items: [{ description: 'Synthetic item', quantity: '1' }] });
const draft = (pair = binding, action = 'CREATE') => ({ schemaVersion: 'factuez.b2b.guide-draft.v1', id: id(10), binding: structuredClone(pair),
  revision: action === 'CREATE' ? '"v1"' : '"v2"', state: action === 'READY' ? 'READY' : action === 'CANCEL' ? 'CANCELLED' : 'DRAFT', body: body(),
  bodySha256: correctionEvidenceHash(body()), createdAt: '2026-10-21T10:00:00.000Z', updatedAt: '2026-10-21T10:00:00.000Z',
  candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false, authorizedForTransfer: false, referenceVerification: 'NOT_VERIFIED' });
const operation = (pair = binding, action = 'CREATE') => ({ operationId: id(11), requestId: id(12), draftId: id(10), action, state: 'SUCCEEDED_LOCAL',
  binding: structuredClone(pair), candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false });
const commandResult = (pair = binding, action = 'CREATE') => ({ response: draft(pair, action), operation: operation(pair, action), replayed: false });
const principal = (kind: 'SERVICE' | 'USER'): B2bPrincipal => ({ kind, clientId: id(90), revision: 1,
  subjectId: kind === 'USER' ? id(91) : null, userAuthRevision: kind === 'USER' ? 2 : null, environment: 'BETA', scopes: [...scopes], bindings: [structuredClone(binding.anchor)] });
const query = (pair = binding) => new URLSearchParams({ ...Object.fromEntries(Object.entries(pair.anchor).map(([k, v]) => [k, String(v)])), guideSeriesId: pair.guideSeriesId, guideType: pair.guideType }).toString();
const commandArgs = (action = 'CREATE') => ({ binding: structuredClone(binding), id: action === 'CREATE' ? null : id(10), key: KEY,
  ifMatch: action === 'CREATE' ? null : '"v1"', body: ['CREATE', 'PATCH'].includes(action) ? body() : {} });

/** Independent actual HTTPS Nest hosts with throwaway mTLS PKI. Billing core is deliberately a double:
 * no DB, fiscal numbering, XML/CDR, real company data or external SUNAT traffic. */
describe('B2B-07 draft-only HTTP facades', () => {
  let tls: ReturnType<typeof b2bCertificates>, billing: any, facade: any, billingPort: number, facadePort: number;
  let commands: B2bGuideCommands;
  const state = { denied: false, limited: false, ownerDenied: false };
  const authenticate = async (token: string, _required: B2bIdentityScope[], kind: 'SERVICE' | 'USER') => {
    if (state.limited) throw new B2bSecurityError(429, 'RATE_LIMITED');
    if (state.denied || token !== TOKEN) throw new B2bSecurityError(401, 'INVALID_TOKEN');
    return principal(kind);
  };
  const identity = { authenticate: vi.fn(authenticate) };
  const core = {
    command: vi.fn(async (_token: string, _kind: string, pair: B2bGuideBinding, action: string) => {
      if (state.ownerDenied) throw new B2bSecurityError(404, 'GUIDE_NOT_OWNED');
      return commandResult(pair, action);
    }),
    read: vi.fn(async (_token: string, _kind: string, pair: B2bGuideBinding) => draft(pair)),
    list: vi.fn(async (_token: string, _kind: string, pair: B2bGuideBinding, limit: number) => ({ items: [draft(pair)], page: { limit, hasMore: false, nextAfter: null, consistency: 'LIVE_KEYSET_NOT_A_SNAPSHOT' } })),
    operation: vi.fn(async (_token: string, _kind: string, pair: B2bGuideBinding) => operation(pair)),
  };
  // Explicit loopback transport for these tests; production's fixed RPC allowlist belongs to the main integration.
  const owner = { execute: vi.fn(async (token: string, kind: 'SERVICE' | 'USER', action: B2bGuideAction, args: unknown) => {
    const r = await send('billing', '/internal/b2b/guides', { body: { kind, action, args }, token });
    if (r.status !== 200) throw new B2bSecurityError(r.status, r.body.code);
    return r.body;
  }) };
  const coreDefaults = Object.fromEntries(Object.entries(core).map(([name, mock]) => [name, mock.getMockImplementation()]));
  const ownerDefault = owner.execute.getMockImplementation()!;
  type Options = { method?: string; body?: unknown; raw?: string; peer?: 'edge' | 'resource' | 'other' | null; trust?: boolean; token?: string; headers?: Record<string, string>; port?: number };
  async function send(target: 'billing' | 'facade', path: string, options: Options = {}) {
    const peer = options.peer === undefined ? target === 'billing' ? 'resource' : 'edge' : options.peer;
    const bytes = options.raw !== undefined ? options.raw : options.body === undefined ? undefined : JSON.stringify(options.body);
    return new Promise<{ status: number; body: any; headers: any }>((resolve, reject) => {
      const request = httpsRequest({ hostname: '127.0.0.1', port: options.port ?? (target === 'billing' ? billingPort : facadePort), path,
        method: options.method ?? (bytes === undefined ? 'GET' : 'POST'), rejectUnauthorized: true, timeout: 5000,
        ...(options.trust === false ? {} : { ca: tls.ca }), ...(peer ? { cert: tls[peer], key: tls.key } : {}),
        headers: { Authorization: 'Bearer ' + (options.token ?? TOKEN), 'X-Factuez-Actor-Kind': 'SERVICE',
          ...(bytes === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(bytes)) }), ...options.headers },
      }, response => {
        const chunks: Buffer[] = []; response.on('data', c => chunks.push(c)); response.on('error', reject);
        response.on('end', () => { try { resolve({ status: response.statusCode!, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null, headers: response.headers }); } catch (error) { reject(error); } });
      });
      request.on('error', reject); request.on('timeout', () => request.destroy(new Error('SYNTHETIC_LOOPBACK_TIMEOUT'))); request.end(bytes);
    });
  }
  const write = (action: string, pair = binding) => send('facade', '/b2b/v1/guide-drafts' + (action === 'CREATE' ? '' : '/' + id(10) + (action === 'PATCH' ? '' : '/' + action.toLowerCase())), {
    method: action === 'PATCH' ? 'PATCH' : 'POST', body: ['CREATE', 'PATCH'].includes(action) ? { binding: pair, body: body() } : { binding: pair },
    headers: { 'Idempotency-Key': KEY, ...(action === 'CREATE' ? {} : { 'If-Match': '"v1"' }) },
  });

  beforeAll(async () => {
    tls = b2bCertificates();
    const httpsOptions = { ca: tls.ca, cert: tls.server, key: tls.key, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' as const };
    billing = await NestFactory.create(BillingGuideModule.isolated(core as any, [fingerprint(tls.resource)]), { logger: false, bodyParser: false, httpsOptions });
    billing.useBodyParser('json', { limit: '256kb', strict: true }); billing.useGlobalFilters(new BillingGuideHttpErrorFilter()); await billing.listen(0, '127.0.0.1');
    billingPort = (billing.getHttpServer().address() as AddressInfo).port;
    commands = new B2bGuideCommands(identity, owner);
    facade = await NestFactory.create(B2bGuideModule.isolated(commands, [fingerprint(tls.edge)]), { logger: false, bodyParser: false, httpsOptions });
    facade.useBodyParser('json', { limit: '256kb', strict: true }); facade.useGlobalFilters(new B2bGuideHttpErrorFilter()); await facade.listen(0, '127.0.0.1');
    facadePort = (facade.getHttpServer().address() as AddressInfo).port;
  }, 30000);
  afterAll(async () => { await facade?.close(); await billing?.close(); });
  beforeEach(() => {
    vi.restoreAllMocks(); vi.clearAllMocks(); identity.authenticate.mockReset().mockImplementation(authenticate);
    for (const [name, mock] of Object.entries(core)) mock.mockReset().mockImplementation(coreDefaults[name] as any);
    owner.execute.mockReset().mockImplementation(ownerDefault);
    Object.assign(state, { denied: false, limited: false, ownerDenied: false });
  });

  it('declares exactly seven public routes and one private RPC, no emission/download routes', () => {
    const routes = (controller: any) => Object.getOwnPropertyNames(controller.prototype).filter(name => Reflect.hasMetadata(PATH_METADATA, controller.prototype[name]) && Reflect.hasMetadata(METHOD_METADATA, controller.prototype[name]))
      .map(name => Reflect.getMetadata(PATH_METADATA, controller.prototype[name]));
    expect(routes(B2bGuideController)).toEqual(['guide-drafts', 'guide-drafts', 'guide-drafts/:id', 'guide-drafts/:id', 'guide-drafts/:id/ready', 'guide-drafts/:id/cancel', 'guide-operations/:id']);
    expect(routes(BillingGuideController)).toEqual(['guides']);
  });

  it.each(['SERVICE', 'USER'] as const)('creates over both mTLS hosts with two fresh identity checks for %s', async kind => {
    const r = await send('facade', '/b2b/v1/guide-drafts', { body: { binding, body: body() }, headers: { 'Idempotency-Key': KEY, 'X-Factuez-Actor-Kind': kind } });
    expect(r.status).toBe(201); expect(r.body).toEqual(draft());
    expect(r.headers.etag).toBe('"v1"'); expect(r.headers['idempotency-key']).toBe(KEY); expect(r.headers['x-operation-id']).toBe(id(11)); expect(r.headers['x-idempotent-replay']).toBe('false');
    expect(identity.authenticate).toHaveBeenCalledTimes(2);
    expect(identity.authenticate).toHaveBeenNthCalledWith(1, TOKEN, ['b2b:guides:write', 'b2b:documents:read'], kind);
    expect(core.command).toHaveBeenCalledWith(TOKEN, kind, binding, 'CREATE', null, KEY, undefined, body());
  });

  it.each(['PATCH', 'READY', 'CANCEL'])('%s passes optimistic concurrency and never grants transfer authority', async action => {
    const r = await write(action); expect(r.status).toBe(200); expect(r.body).toEqual(draft(binding, action)); expect(r.headers.etag).toBe('"v2"');
    expect(core.command).toHaveBeenCalledWith(TOKEN, 'SERVICE', binding, action, id(10), KEY, '"v1"', action === 'PATCH' ? body() : {});
    expect(r.body.authorizedForTransfer).toBe(false); expect(r.body.referenceVerification).toBe('NOT_VERIFIED');
  });

  it('reads one draft, lists with bounded cursor, and consults operations using the explicit full tuple', async () => {
    const r = await send('facade', `/b2b/v1/guide-drafts/${id(10)}?${query()}`); expect(r.status).toBe(200); expect(r.headers.etag).toBe('"v1"');
    expect(identity.authenticate.mock.calls[0][1]).toEqual(['b2b:guides:read', 'b2b:documents:read']);
    const l = await send('facade', `/b2b/v1/guide-drafts?${query()}&limit=5&after=${id(9)}`); expect(l.status).toBe(200);
    expect(core.list).toHaveBeenCalledWith(TOKEN, 'SERVICE', binding, 5, id(9));
    const o = await send('facade', `/b2b/v1/guide-operations/${id(11)}?${query()}`); expect(o.status).toBe(200); expect(o.body).toEqual(operation());
    expect(identity.authenticate.mock.calls.at(-1)?.[1]).toEqual(['b2b:guides:read', 'b2b:documents:read', 'b2b:guide-operations:read']);
  });

  it.each([['01', '09'], ['03', '09'], ['01', '31'], ['03', '31']] as const)('keeps independent anchor %s and draft type %s without widening the principal', async (documentType, guideType) => {
    const pair = { ...structuredClone(binding), guideType, anchor: { ...binding.anchor, documentType } };
    identity.authenticate.mockImplementation(async (_token, _required, kind) => ({ ...principal(kind), bindings: [pair.anchor] }));
    const r = await write('CREATE', pair); expect(r.status).toBe(201); expect(r.body.binding).toEqual(pair);
    expect(r.body.fiscalExecutionEnabled).toBe(false); expect(r.body.transmissionAuthorized).toBe(false);
  });

  it('returns replay headers without manufacturing a new operation or a fiscal number', async () => {
    vi.spyOn(core, 'command').mockResolvedValue({ ...commandResult(), replayed: true });
    const r = await write('CREATE'); expect(r.status).toBe(200); expect(r.headers['x-idempotent-replay']).toBe('true'); expect(r.headers['x-operation-id']).toBe(id(11));
    expect(Object.keys(r.body)).not.toContain('number'); expect(Object.keys(r.body)).not.toContain('xml');
  });

  it.each(['billing', 'facade'] as const)('%s requires trusted TLS and pinned peers independently', async target => {
    const path = target === 'billing' ? '/internal/b2b/guides' : '/b2b/v1/guide-drafts';
    const payload = target === 'billing' ? { kind: 'SERVICE', action: 'CREATE', args: commandArgs() } : { binding, body: body() };
    await expect(send(target, path, { body: payload, peer: null })).rejects.toThrow();
    await expect(send(target, path, { body: payload, trust: false })).rejects.toThrow();
    const r = await send(target, path, { body: payload, peer: 'other', headers: { 'X-User-Role': 'ADMIN_GENERAL', 'X-Forwarded-Client-Cert': 'trusted' } });
    expect(r.status).toBe(403); expect(r.body.code).toBe('PRIVATE_PEER_REQUIRED'); expect(core.command).not.toHaveBeenCalled(); expect(identity.authenticate).not.toHaveBeenCalled();
  });

  it.each(['billing', 'facade'] as const)('%s checks peer and Bearer before inspecting the body', async target => {
    const response: any = { setHeader: vi.fn() }, getter = vi.fn(() => { throw new Error('BODY_MUST_NOT_BE_READ'); });
    const req: any = { headers: {}, socket: { encrypted: false } }; Object.defineProperty(req, 'body', { get: getter });
    const controller = target === 'billing' ? new BillingGuideController(core as any, [fingerprint(tls.resource)]) : new B2bGuideController(commands, [fingerprint(tls.edge)]);
    const invoke = () => target === 'billing' ? (controller as BillingGuideController).call(req, response) : (controller as B2bGuideController).create(req, response);
    await expect(invoke()).rejects.toMatchObject({ code: 'PRIVATE_PEER_REQUIRED' });
    req.socket = { encrypted: true, authorized: true, getPeerCertificate: () => ({ fingerprint256: fingerprint(tls[target === 'billing' ? 'resource' : 'edge']) }) };
    await expect(invoke()).rejects.toMatchObject({ code: 'INVALID_TOKEN' }); expect(getter).not.toHaveBeenCalled();
  });

  it.each(['Basic secret', 'Bearer', 'Bearer a b', 'bearer token', 'Bearer a/b'])('rejects malformed Bearer %s on both facades', async authorization => {
    for (const target of ['billing', 'facade'] as const) {
      const r = await send(target, target === 'billing' ? '/internal/b2b/guides' : '/b2b/v1/guide-drafts', {
        body: target === 'billing' ? { kind: 'SERVICE', action: 'CREATE', args: commandArgs() } : { binding, body: body() }, headers: { Authorization: authorization },
      }); expect(r.status).toBe(401);
    }
    expect(core.command).not.toHaveBeenCalled();
  });

  it.each(['ADMIN', '', 'SERVICE, USER'])('requires explicit valid public actor kind %s', async kind => {
    expect((await send('facade', '/b2b/v1/guide-drafts', { body: { binding, body: body() }, headers: { 'X-Factuez-Actor-Kind': kind, 'Idempotency-Key': KEY } })).status).toBe(401);
    expect(owner.execute).not.toHaveBeenCalled();
  });

  it.each(['issuerId', 'issuerRuc', 'branchId', 'pointId', 'seriesId', 'documentType'])('rejects a different whole anchor: %s', async field => {
    const pair: any = structuredClone(binding); pair.anchor[field] = field === 'issuerId' ? 100 : field === 'issuerRuc' ? '20000000002' : field === 'documentType' ? '03' : id(70);
    expect((await write('CREATE', pair)).status).toBe(404); expect(owner.execute).not.toHaveBeenCalled();
  });

  it('does not combine cross-grant branches, points and series', async () => {
    identity.authenticate.mockImplementation(async (_t, _r, kind) => ({ ...principal(kind), bindings: [
      { ...binding.anchor, seriesId: id(80) }, { ...binding.anchor, branchId: id(81) },
    ] }));
    expect((await write('CREATE')).status).toBe(404); expect(owner.execute).not.toHaveBeenCalled();
  });

  it.each(['b2b:guides:write', 'b2b:documents:read'] as B2bIdentityScope[])('requires write scope %s without forwarding', async missing => {
    identity.authenticate.mockImplementation(async (_t, _r, kind) => ({ ...principal(kind), scopes: scopes.filter(s => s !== missing) }));
    expect((await write('CREATE')).status).toBe(401); expect(owner.execute).not.toHaveBeenCalled();
  });
  it.each(['b2b:guides:read', 'b2b:documents:read', 'b2b:guide-operations:read'] as B2bIdentityScope[])('requires operation scope %s without forwarding', async missing => {
    identity.authenticate.mockImplementation(async (_t, _r, kind) => ({ ...principal(kind), scopes: scopes.filter(s => s !== missing) }));
    expect((await send('facade', `/b2b/v1/guide-operations/${id(11)}?${query()}`)).status).toBe(401); expect(owner.execute).not.toHaveBeenCalled();
  });
  it('does not substitute the legacy operations scope for the dedicated guide permission', async () => {
    identity.authenticate.mockImplementation(async (_t, _r, kind) => ({ ...principal(kind),
      scopes: [...scopes.filter(s => s !== 'b2b:guide-operations:read'), 'b2b:operations:read'],
    }));
    expect((await send('facade', `/b2b/v1/guide-operations/${id(11)}?${query()}`)).status).toBe(401);
    expect(owner.execute).not.toHaveBeenCalled();
  });

  it.each(['revision', 'subject', 'scope', 'binding', 'revoked'])('withholds owner response after authority changes: %s', async change => {
    let calls = 0;
    identity.authenticate.mockImplementation(async (_t, _r, kind) => {
      const p = principal(kind); if (++calls === 1) return p;
      if (change === 'revoked') throw new B2bSecurityError(401, 'INVALID_TOKEN');
      if (change === 'revision') p.revision++;
      if (change === 'subject') { p.kind = 'USER'; p.subjectId = id(91); p.userAuthRevision = 2; }
      if (change === 'scope') p.scopes = p.scopes.filter(s => s !== 'b2b:guides:write');
      if (change === 'binding') p.bindings[0].pointId = id(70);
      return p;
    });
    const r = await write('CREATE'); expect(r.status).toBe(401); expect(core.command).toHaveBeenCalledTimes(1); expect(r.body.id).toBeUndefined();
  });

  it('preserves explicit paired owner denial instead of inferring a guide-series grant from the anchor', async () => {
    state.ownerDenied = true; const r = await write('CREATE'); expect(r.status).toBe(404); expect(r.body.code).toBe('GUIDE_NOT_OWNED');
  });
  it('handles quota denial without invoking the owner', async () => {
    state.limited = true; const r = await write('CREATE'); expect(r.status).toBe(429); expect(r.headers['retry-after']).toBe('60'); expect(owner.execute).not.toHaveBeenCalled();
  });

  it.each(['missing', 'unknown', 'duplicate', 'production', 'anchor09', 'guide01', 'same-series', 'invalid-id', 'json-binding', 'secret', 'limit-zero', 'limit-large', 'limit-array', 'after-invalid'])('rejects invalid explicit list query %s', async mode => {
    let q = query();
    if (mode === 'missing') q = q.replace('&guideType=09', '');
    if (mode === 'unknown') q += '&unknown=x';
    if (mode === 'duplicate') q += '&issuerId=99';
    if (mode === 'production') q = q.replace('environment=BETA', 'environment=PRODUCTION');
    if (mode === 'anchor09') q = q.replace('documentType=01', 'documentType=09');
    if (mode === 'guide01') q = q.replace('guideType=09', 'guideType=01');
    if (mode === 'same-series') q = q.replace(encodeURIComponent(binding.guideSeriesId), encodeURIComponent(binding.anchor.seriesId));
    if (mode === 'invalid-id') q = q.replace('issuerId=99', 'issuerId=099');
    if (mode === 'json-binding') q = 'binding=' + encodeURIComponent(JSON.stringify(binding));
    if (mode === 'secret') q += '&token=' + TOKEN;
    if (mode === 'limit-zero') q += '&limit=0';
    if (mode === 'limit-large') q += '&limit=101';
    if (mode === 'limit-array') q += '&limit=2&limit=3';
    if (mode === 'after-invalid') q += '&after=bad';
    expect((await send('facade', '/b2b/v1/guide-drafts?' + q)).status).toBe(400); expect(owner.execute).not.toHaveBeenCalled();
  });

  it.each(['extra-envelope', 'bad-kind', 'bad-action', 'extra-args', 'missing-binding', 'production', 'array-type', 'caller-number', 'bad-key', 'create-etag', 'missing-etag', 'wildcard-etag', 'ready-body', 'bad-id', 'bad-limit'])('rejects exact private wire %s before the owner core', async mode => {
    const value: any = { kind: 'SERVICE', action: 'CREATE', args: commandArgs() };
    if (mode === 'extra-envelope') value.token = TOKEN;
    if (mode === 'bad-kind') value.kind = ['SERVICE'];
    if (mode === 'bad-action') value.action = 'EMIT';
    if (mode === 'extra-args' || mode === 'caller-number') value.args.number = '1234';
    if (mode === 'missing-binding') delete value.args.binding;
    if (mode === 'production') value.args.binding.anchor.environment = 'PRODUCTION';
    if (mode === 'array-type') value.args.binding.anchor.documentType = ['01'];
    if (mode === 'bad-key') value.args.key = 'short';
    if (mode === 'create-etag') value.args.ifMatch = '"v1"';
    if (['missing-etag', 'wildcard-etag', 'ready-body', 'bad-id'].includes(mode)) {
      value.action = 'READY'; value.args = commandArgs('READY');
      if (mode === 'missing-etag') value.args.ifMatch = null;
      if (mode === 'wildcard-etag') value.args.ifMatch = '*';
      if (mode === 'ready-body') value.args.body = { number: '1' };
      if (mode === 'bad-id') value.args.id = 'invalid';
    }
    if (mode === 'bad-limit') { value.action = 'LIST'; value.args = { binding, limit: 101, after: null }; }
    const r = await send('billing', '/internal/b2b/guides', { body: value }); expect(mode === 'missing-etag' ? [428] : [400]).toContain(r.status);
    expect(core.command).not.toHaveBeenCalled(); expect(core.list).not.toHaveBeenCalled();
  });

  it('rejects queries on writes/private RPC, GET bodies, unexpected envelope fields and missing If-Match', async () => {
    expect((await send('facade', '/b2b/v1/guide-drafts?environment=BETA', { body: { binding, body: body() }, headers: { 'Idempotency-Key': KEY } })).status).toBe(400);
    expect((await send('billing', '/internal/b2b/guides?environment=BETA', { body: { kind: 'SERVICE', action: 'CREATE', args: commandArgs() } })).status).toBe(400);
    expect((await send('facade', '/b2b/v1/guide-drafts?' + query(), { method: 'GET', body: {} })).status).toBe(400);
    expect((await send('facade', '/b2b/v1/guide-drafts', { body: { binding, body: body(), number: '123' }, headers: { 'Idempotency-Key': KEY } })).status).toBe(400);
    expect((await send('facade', `/b2b/v1/guide-drafts/${id(10)}/ready`, { body: { binding }, headers: { 'Idempotency-Key': KEY } })).status).toBe(428);
    expect((await send('facade', `/b2b/v1/guide-drafts/${id(10)}/cancel`, { body: { binding, body: {} }, headers: { 'Idempotency-Key': KEY, 'If-Match': '"v1"' } })).status).toBe(400);
    expect(owner.execute).not.toHaveBeenCalled();
  });

  it.each(['binding', 'guide-series', 'guide-type', 'id', 'schema', 'hash', 'state', 'revision', 'time', 'fiscal', 'transmit', 'transfer', 'reference', 'client-context', 'xml', 'nested-flags', 'operation-binding', 'operation-draft', 'operation-action', 'operation-id', 'operation-request', 'operation-fiscal', 'replayed'])('withholds forged owner result: %s', async mode => {
    const value: any = commandResult();
    if (mode === 'binding') value.response.binding.anchor.pointId = id(70);
    if (mode === 'guide-series') value.response.binding.guideSeriesId = id(70);
    if (mode === 'guide-type') value.response.binding.guideType = '31';
    if (mode === 'id') value.response.id = 'invalid';
    if (mode === 'schema') value.response.schemaVersion = 'fiscal.v1';
    if (mode === 'hash') value.response.bodySha256 = 'a'.repeat(64);
    if (mode === 'state') value.response.state = 'ACCEPTED';
    if (mode === 'revision') value.response.revision = '*';
    if (mode === 'time') value.response.updatedAt = '2020-01-01T00:00:00Z';
    if (mode === 'fiscal') value.response.fiscalExecutionEnabled = true;
    if (mode === 'transmit') value.response.transmissionAuthorized = true;
    if (mode === 'transfer') value.response.authorizedForTransfer = true;
    if (mode === 'reference') value.response.referenceVerification = 'VERIFIED';
    if (mode === 'client-context') value.response.clientId = id(90);
    if (mode === 'xml') value.response.xml = '<Invoice/>';
    if (mode === 'nested-flags') { value.response.body.items[0].fiscalExecutionEnabled = true; value.response.bodySha256 = correctionEvidenceHash(value.response.body); }
    if (mode === 'operation-binding') value.operation.binding.anchor.branchId = id(70);
    if (mode === 'operation-draft') value.operation.draftId = id(70);
    if (mode === 'operation-action') value.operation.action = 'CANCEL';
    if (mode === 'operation-id') value.operation.operationId = '../secret';
    if (mode === 'operation-request') value.operation.requestId = 'invalid';
    if (mode === 'operation-fiscal') value.operation.transmissionAuthorized = true;
    if (mode === 'replayed') value.replayed = 'true';
    vi.spyOn(owner, 'execute').mockResolvedValue(value);
    const r = await write('CREATE'); expect(r.status).toBe(503); expect(r.body.code).toBe('INCONSISTENT_OWNER_RESPONSE'); expect(r.body.response).toBeUndefined();
  });

  it.each(['foreign-item', 'duplicate-item', 'page-limit', 'cursor', 'excess-items', 'forged-flags'])('validates every list item and pagination: %s', async mode => {
    const value: any = { items: [draft()], page: { limit: 1, hasMore: false, nextAfter: null, consistency: 'LIVE_KEYSET_NOT_A_SNAPSHOT' } };
    if (mode === 'foreign-item') value.items[0].binding.anchor.seriesId = id(70);
    if (mode === 'duplicate-item') { value.items.push(draft()); value.page.limit = 2; }
    if (mode === 'page-limit') value.page.limit = 20;
    if (mode === 'cursor') value.page.nextAfter = id(10);
    if (mode === 'excess-items') value.items.push({ ...draft(), id: id(70) });
    if (mode === 'forged-flags') value.items[0].authorizedForTransfer = true;
    vi.spyOn(owner, 'execute').mockResolvedValue(value);
    expect((await send('facade', '/b2b/v1/guide-drafts?' + query() + '&limit=' + (mode === 'duplicate-item' ? '2' : '1'))).status).toBe(503);
  });

  it('rejects read/operation IDs mismatched in owner responses', async () => {
    vi.spyOn(owner, 'execute').mockResolvedValue({ ...draft(), id: id(70) });
    expect((await send('facade', `/b2b/v1/guide-drafts/${id(10)}?${query()}`)).status).toBe(503);
    vi.spyOn(owner, 'execute').mockResolvedValue({ ...operation(), operationId: id(70) });
    expect((await send('facade', `/b2b/v1/guide-operations/${id(11)}?${query()}`)).status).toBe(503);
  });

  it('defaults to ten guides and rejects limit eleven on both public and private interfaces', async () => {
    const r = await send('facade', '/b2b/v1/guide-drafts?' + query()); expect(r.status).toBe(200); expect(r.body.page.limit).toBe(10);
    expect(core.list).toHaveBeenCalledWith(TOKEN, 'SERVICE', binding, 10, null);
    core.list.mockClear();
    expect((await send('facade', '/b2b/v1/guide-drafts?' + query() + '&limit=11')).status).toBe(400);
    expect((await send('billing', '/internal/b2b/guides', { body: { kind: 'SERVICE', action: 'LIST', args: { binding, limit: 11, after: null } } })).status).toBe(400);
    expect(core.list).not.toHaveBeenCalled();
  });

  it('accepts bounded multi-guide responses larger than the 256 KiB request budget', async () => {
    const items = Array.from({ length: 10 }, (_, index) => {
      const v = draft(); v.id = id(100 + index); v.body.items[0].description = 'é'.repeat(48000);
      v.bodySha256 = correctionEvidenceHash(v.body); return v;
    });
    const page = { limit: 10, hasMore: true, nextAfter: items.at(-1)!.id, consistency: 'LIVE_KEYSET_NOT_A_SNAPSHOT' };
    expect(Buffer.byteLength(JSON.stringify({ items, page }))).toBeGreaterThan(256 * 1024);
    vi.spyOn(owner, 'execute').mockResolvedValue({ items, page });
    const r = await send('facade', '/b2b/v1/guide-drafts?' + query()); expect(r.status).toBe(200); expect(r.body.items).toHaveLength(10);
    expect(r.body.page.nextAfter).toBe(items.at(-1)!.id);
  });

  it('rejects owner response over 2 MiB without serializing its body into an error', async () => {
    const v = draft(); v.body.items[0].description = 'x'.repeat(2100000);
    vi.spyOn(owner, 'execute').mockResolvedValue(v);
    const r = await send('facade', `/b2b/v1/guide-drafts/${id(10)}?${query()}`);
    expect(r.status).toBe(503); expect(r.body.code).toBe('INCONSISTENT_OWNER_RESPONSE'); expect(JSON.stringify(r.body).length).toBeLessThan(1000);
  });

  it.each(['stale-etag', 'wrong-state', 'wrong-draft'])('does not use invalid owner values as optimistic concurrency proof: %s', async mode => {
    const value = commandResult(binding, 'READY');
    if (mode === 'stale-etag') value.response.revision = '"v1"';
    if (mode === 'wrong-state') value.response.state = 'DRAFT';
    if (mode === 'wrong-draft') value.response.id = id(70);
    vi.spyOn(owner, 'execute').mockResolvedValue(value);
    expect((await write('READY')).status).toBe(503);
  });

  it('rejects unsorted pages and cursors which move backwards', async () => {
    vi.spyOn(owner, 'execute').mockResolvedValue({ items: [{ ...draft(), id: id(20) }, draft()], page: {
      limit: 2, hasMore: false, nextAfter: null, consistency: 'LIVE_KEYSET_NOT_A_SNAPSHOT',
    } });
    expect((await send('facade', '/b2b/v1/guide-drafts?' + query() + '&limit=2')).status).toBe(503);
    vi.spyOn(owner, 'execute').mockResolvedValue({ items: [draft()], page: {
      limit: 1, hasMore: false, nextAfter: null, consistency: 'LIVE_KEYSET_NOT_A_SNAPSHOT',
    } });
    expect((await send('facade', '/b2b/v1/guide-drafts?' + query() + '&limit=1&after=' + id(20))).status).toBe(503);
  });

  it.each(['authorization', 'x-factuez-actor-kind', 'idempotency-key', 'if-match'])('rejects duplicate security/concurrency header %s before reading public bodies', async header => {
    const getter = vi.fn(() => { throw new Error('BODY_MUST_NOT_BE_READ'); });
    const req: any = { headers: { authorization: 'Bearer ' + TOKEN, 'x-factuez-actor-kind': 'SERVICE' }, rawHeaders: [header, 'a', header.toUpperCase(), 'b'],
      socket: { encrypted: true, authorized: true, getPeerCertificate: () => ({ fingerprint256: fingerprint(tls.edge) }) } };
    Object.defineProperty(req, 'body', { get: getter });
    await expect(new B2bGuideController(commands, [fingerprint(tls.edge)]).create(req, { setHeader: vi.fn() })).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
    expect(getter).not.toHaveBeenCalled(); expect(owner.execute).not.toHaveBeenCalled();
  });

  it.each(['billing', 'facade'] as const)('%s sanitizes unknown failures and parser errors, preserving safe headers', async target => {
    const path = target === 'billing' ? '/internal/b2b/guides' : '/b2b/v1/guide-drafts';
    for (const [raw, status] of [['{"SECRET_PRIVATE_CREDENTIAL":', 400], [JSON.stringify({ secret: 'x'.repeat(270000) }), 413]] as const) {
      const r = await send(target, path, { raw }); expect(r.status).toBe(status); expect(JSON.stringify(r.body)).not.toContain('SECRET_PRIVATE_CREDENTIAL');
      expect(r.headers['cache-control']).toBe('private, no-store'); expect(r.headers['x-content-type-options']).toBe('nosniff');
    }
    vi.spyOn(core, 'command').mockRejectedValue(new Error('SECRET_DB_CONNECTION_STRING'));
    const r = target === 'billing' ? await send(target, path, { body: { kind: 'SERVICE', action: 'CREATE', args: commandArgs() } }) : await write('CREATE');
    expect(r.status).toBe(503); expect(JSON.stringify(r.body)).not.toContain('SECRET_DB_CONNECTION_STRING'); expect(r.headers['cache-control']).toBe('private, no-store');
  });

  it('rejects unsafe JS objects without executing getters or forwarding to Billing', async () => {
    const getter = vi.fn(() => { throw new Error('UNSAFE_GETTER'); });
    const args: any = { ...commandArgs() }; Object.defineProperty(args, 'extra', { enumerable: true, get: getter });
    await expect(commands.call(TOKEN, 'SERVICE', 'CREATE', args)).rejects.toMatchObject({ status: 400 }); expect(getter).not.toHaveBeenCalled();
    const circular: any = commandArgs(); circular.body.circular = circular;
    await expect(commands.call(TOKEN, 'SERVICE', 'CREATE', circular)).rejects.toMatchObject({ status: 400 }); expect(owner.execute).not.toHaveBeenCalled();
  });

  it('forwards only the fixed private path and bounded draft arguments through the transport adapter', async () => {
    const http = { post: vi.fn(async () => commandResult()) }, adapter = new HttpB2bGuideOwner(http);
    await adapter.execute(TOKEN, 'SERVICE', 'CREATE', commandArgs());
    expect(http.post).toHaveBeenCalledWith('/internal/b2b/guides', { kind: 'SERVICE', action: 'CREATE', args: commandArgs() }, TOKEN);
  });

  it('does not expose unplanned routes or activate fiscal or transfer endpoints', async () => {
    for (const path of ['/b2b/v1/guide-drafts/' + id(10) + '/emit', '/b2b/v1/guide-drafts/' + id(10) + '/xml', '/b2b/v1/guides', '/internal/b2b/guides/emit']) {
      expect((await send(path.startsWith('/internal') ? 'billing' : 'facade', path, { body: {} })).status).toBe(404);
    }
    expect(core.command).not.toHaveBeenCalled();
  });

  it('rejects empty, duplicate or malformed peer allowlists', () => {
    for (const peers of [[], ['invalid'], [fingerprint(tls.edge), fingerprint(tls.edge)]]) {
      expect(() => B2bGuideModule.isolated(commands, peers)).toThrow(); expect(() => BillingGuideModule.isolated(core as any, peers)).toThrow();
    }
  });

  it.each([false, true])('actual candidate factory gates guide POST/PATCH and capabilities when configured=%s', async configured => {
    identity.authenticate.mockImplementation(async (token, required, kind) => ({
      ...await authenticate(token, required, kind), scopes: [...scopes, 'b2b:context:read'],
    }));
    // Real capability projection and factory; unused non-guide owners are deliberately unbound.
    const reads = new B2bReads(identity, {} as never, {} as never);
    const app = await createB2bDraftApplication(reads, { issuanceConfigured: false } as never,
      [fingerprint(tls.edge)], { ca: tls.ca, cert: tls.server, key: tls.key },
      undefined, undefined, undefined, undefined, configured ? commands : undefined);
    try {
      await app.listen(0, '127.0.0.1'); const port = (app.getHttpServer().address() as AddressInfo).port;
      for (const action of ['CREATE', 'PATCH', 'READY', 'CANCEL']) {
        const path = '/b2b/v1/guide-drafts' + (action === 'CREATE' ? '' : '/' + id(10) + (action === 'PATCH' ? '' : '/' + action.toLowerCase()));
        const r = await send('facade', path, { port, method: action === 'PATCH' ? 'PATCH' : 'POST',
          body: ['CREATE', 'PATCH'].includes(action) ? { binding, body: body() } : { binding },
          headers: { 'Idempotency-Key': KEY, ...(action === 'CREATE' ? {} : { 'If-Match': '"v1"' }) },
        });
        expect(r.status).toBe(configured ? action === 'CREATE' ? 201 : 200 : 400);
        if (configured) { expect(r.body).toEqual(draft(binding, action)); expect(r.headers.etag).toBe(draft(binding, action).revision); }
        else expect(r.body.code).toBe('DRAFT_COMMANDS_ONLY');
      }
      expect(core.command).toHaveBeenCalledTimes(configured ? 4 : 0);
      if (!configured) { expect(owner.execute).not.toHaveBeenCalled(); expect(identity.authenticate).not.toHaveBeenCalled(); }
      const caps = await send('facade', '/b2b/v1/capabilities?environment=BETA', { port });
      expect(caps.status).toBe(200); expect(caps.body.fiscalActivation).toBe(false);
      const guides = caps.body.features.filter((feature: { id: string }) => feature.id === 'guide-drafts');
      expect(guides).toHaveLength(configured ? 1 : 0);
      if (configured) expect(guides[0].state).toBe('ENABLED');
    } finally { await app.close(); }
  });
});
