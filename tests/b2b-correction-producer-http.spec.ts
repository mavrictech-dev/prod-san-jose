import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '../services/billing-service/node_modules/@nestjs/core';
import { B2bSecurityError, b2bCorrectionBindingKey, type B2bPrincipal, type B2bIdentityScope } from '../packages/contracts/src/b2b-security';
import { B2bPrivateHttp } from '../packages/service-access/src/b2b';
import { B2bCorrectionProducer } from '../services/billing-service/src/b2b/correction-producer';
import { BillingCorrectionProducerController, BillingCorrectionProducerModule } from '../services/billing-service/src/b2b/correction-producer-http';
import { B2bCorrectionController, B2bCorrectionHttpErrorFilter, B2bCorrectionModule, B2bCorrections, HttpB2bCorrectionOwner } from '../services/b2b-api-service/src/corrections';
import { createB2bDraftApplication } from '../services/b2b-api-service/src/draft-application';
import { b2bCertificates, fingerprint } from './b2b-tls.fixture';
import { supplementCommandFixture, supplementUuid as id } from './helpers/fiscal-supplement.fixture';

const TOKEN = 'synthetic-correction-http-token';
const scopes: B2bIdentityScope[] = ['b2b:corrections:read', 'b2b:corrections:write', 'b2b:documents:read', 'b2b:documents:issue'];

/** Two actual Nest HTTPS applications and pinned mTLS, using an actual producer facade.
 * Identity/catalogue/draft/execution ports are test doubles: no DB, external traffic, PKI fiscal trust or official CDR. */
describe('isolated B2B correction producer HTTP connection', () => {
  const f = supplementCommandFixture(), binding = { reference: { issuerId: f.doc.companyId!, issuerRuc: f.doc.issuer.identityNumber,
    environment: 'BETA' as const, branchId: f.doc.branchId!, pointId: id(101), seriesId: id(102), documentType: '01' as const },
    noteSeriesId: id(103), noteType: '07' as const };
  const input = () => ({ schemaVersion: 'factuez.b2b.correction-create.v1', binding: structuredClone(binding), originalDocumentId: f.doc.documentId,
    idempotencyKey: 'synthetic-http-correction-0001', externalReference: { namespace: 'fixture.erp', value: 'correction-0001' },
    note: structuredClone(f.note.adjustment), issueDate: f.note.issueDate });
  const result = () => ({ operationId: f.command.payload.operationId, binding: structuredClone(binding), state: 'RESERVED',
    candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false });
  const principal = (kind: 'SERVICE' | 'USER'): B2bPrincipal => ({ kind, clientId: id(150), revision: 1,
    subjectId: kind === 'USER' ? id(151) : null, userAuthRevision: kind === 'USER' ? 2 : null,
    scopes: [...scopes], bindings: [structuredClone(binding.reference)], environment: 'BETA' });
  const state = { revoked: false, limited: false, grant: 1, clientRevision: 1, ownerDenied: false, identityScopes: [...scopes], bindings: [structuredClone(binding.reference)] };
  const identity = { authenticate: vi.fn(async (token: string, required: B2bIdentityScope[], kind: 'SERVICE' | 'USER') => {
    if (state.limited) throw new B2bSecurityError(429, 'RATE_LIMITED');
    if (token !== TOKEN || state.revoked) throw new B2bSecurityError(401, 'INVALID_TOKEN');
    return { ...principal(kind), revision: state.clientRevision, scopes: [...state.identityScopes], bindings: structuredClone(state.bindings) };
  }) };
  const authority = { current: vi.fn(async (token: string, kind: 'SERVICE' | 'USER', pair: typeof binding) => {
    if (token !== TOKEN || state.revoked) throw new B2bSecurityError(401, 'INVALID_TOKEN');
    if (state.ownerDenied || b2bCorrectionBindingKey(pair) !== b2bCorrectionBindingKey(binding)) throw new B2bSecurityError(404, 'OPERATION_NOT_OWNED');
    return { grantRevision: state.grant, clientRevision: state.clientRevision, actor: {
      userId: kind === 'USER' ? id(151) : null,
      scope: { kind: 'ASSIGNED' as const, branchIds: [binding.reference.branchId], emissionPointIds: [binding.reference.pointId], series: [binding.reference.seriesId, binding.noteSeriesId] },
      b2b: { kind, clientId: id(150), revision: state.clientRevision, subjectId: kind === 'USER' ? id(151) : null, userAuthRevision: kind === 'USER' ? 2 : null },
    } };
  }) };
  const drafts = { prepare: vi.fn(async () => structuredClone(f.command)), replay: vi.fn(async () => null),
    operation: vi.fn(async (pair: typeof binding, operationId: string) => {
      if (state.ownerDenied || operationId !== f.command.payload.operationId || b2bCorrectionBindingKey(pair) !== b2bCorrectionBindingKey(binding))
        throw new B2bSecurityError(404, 'OPERATION_NOT_OWNED');
    }) };
  const execution = { reserve: vi.fn(async () => result()), status: vi.fn(async () => result()), settle: vi.fn(async () => ({ ...result(), state: 'SETTLED' })) };
  const factory = vi.fn(async (_token: string, _kind: 'SERVICE' | 'USER', _binding: typeof binding) => new B2bCorrectionProducer(authority, drafts, execution));
  let tls: ReturnType<typeof b2bCertificates>, billing: any, facade: any, billingPort: number, facadePort: number;
  let owner: HttpB2bCorrectionOwner, core: B2bCorrections, rpc: B2bPrivateHttp;
  const query = (pair = binding) => new URLSearchParams({ ...Object.fromEntries(Object.entries(pair.reference).map(([key, value]) => [key, String(value)])),
    noteSeriesId: pair.noteSeriesId, noteType: pair.noteType }).toString();
  const privateBody = (action = 'CREATE', args: unknown = input(), kind = 'SERVICE') => ({ action, kind, args });

  beforeAll(async () => {
    tls = b2bCertificates();
    const httpsOptions = { ca: tls.ca, cert: tls.server, key: tls.key, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' as const };
    billing = await NestFactory.create(BillingCorrectionProducerModule.isolated(factory, [fingerprint(tls.resource)]), { logger: false, bodyParser: false, httpsOptions });
    billing.useBodyParser('json', { limit: '256kb', strict: true }); billing.useGlobalFilters(new B2bCorrectionHttpErrorFilter()); await billing.listen(0, '127.0.0.1');
    billingPort = (billing.getHttpServer().address() as AddressInfo).port;
    rpc = new B2bPrivateHttp(`https://127.0.0.1:${billingPort}`, { ca: tls.ca, cert: tls.resource, key: tls.key });
    owner = new HttpB2bCorrectionOwner(rpc); core = new B2bCorrections(identity, owner);
    facade = await NestFactory.create(B2bCorrectionModule.isolated(core, [fingerprint(tls.edge)]), { logger: false, bodyParser: false, httpsOptions });
    facade.useBodyParser('json', { limit: '256kb', strict: true }); facade.useGlobalFilters(new B2bCorrectionHttpErrorFilter()); await facade.listen(0, '127.0.0.1');
    facadePort = (facade.getHttpServer().address() as AddressInfo).port;
  }, 30000);
  afterAll(async () => { await facade?.close(); await billing?.close(); });
  beforeEach(() => {
    vi.restoreAllMocks(); vi.clearAllMocks();
    Object.assign(state, { revoked: false, limited: false, grant: 1, clientRevision: 1, ownerDenied: false, identityScopes: [...scopes], bindings: [structuredClone(binding.reference)] });
  });

  async function send(target: 'billing' | 'facade', path: string, options: {
    method?: string; body?: unknown; raw?: string; peer?: 'edge' | 'resource' | 'other' | null; trust?: boolean;
    headers?: Record<string, string>; token?: string; port?: number;
  } = {}) {
    const peer = options.peer === undefined ? target === 'billing' ? 'resource' : 'edge' : options.peer;
    const bytes = options.raw !== undefined ? options.raw : options.body === undefined ? undefined : JSON.stringify(options.body);
    return new Promise<{ status: number; body: any; headers: any }>((resolve, reject) => {
      const request = httpsRequest({ hostname: '127.0.0.1', port: options.port ?? (target === 'billing' ? billingPort : facadePort), path,
        method: options.method ?? (bytes === undefined ? 'GET' : 'POST'), rejectUnauthorized: true, timeout: 5000,
        ...(options.trust === false ? {} : { ca: tls.ca }), ...(peer ? { cert: tls[peer], key: tls.key } : {}),
        headers: { Authorization: 'Bearer ' + (options.token ?? TOKEN), ...(bytes === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(bytes)) }), ...options.headers },
      }, response => {
        const chunks: Buffer[] = []; response.on('data', c => chunks.push(c)); response.on('error', reject);
        response.on('end', () => { try { resolve({ status: response.statusCode!, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null, headers: response.headers }); } catch (error) { reject(error); } });
      });
      request.on('error', reject); request.on('timeout', () => request.destroy(new Error('SYNTHETIC_LOOPBACK_TIMEOUT'))); request.end(bytes);
    });
  }

  it.each(['SERVICE', 'USER'] as const)('creates through real mTLS facade → Billing for %s with fresh owner and identity checks', async kind => {
    const response = await send('facade', '/b2b/v1/correction-notes', { body: input(), headers: { 'X-Factuez-Actor-Kind': kind } });
    expect(response.status).toBe(202); expect(response.body).toMatchObject({ operationId: f.command.payload.operationId, binding,
      candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false });
    expect(identity.authenticate).toHaveBeenCalledTimes(2); expect(authority.current).toHaveBeenCalledTimes(5);
    expect(identity.authenticate.mock.calls.every(([token, required, k]) => token === TOKEN && k === kind && required.includes('b2b:corrections:write') && required.includes('b2b:documents:issue'))).toBe(true);
    expect(factory).toHaveBeenCalledWith(TOKEN, kind, binding); expect(execution.reserve).toHaveBeenCalledTimes(1);
    expect(drafts.operation).toHaveBeenCalledTimes(2); expect(JSON.stringify(response.body)).not.toContain(TOKEN);
    expect(JSON.stringify(response.body)).not.toContain('BEGIN CERTIFICATE');
  });

  it('supports GET status with explicit full tuple and POST settle without credentials in URLs', async () => {
    const path = `/b2b/v1/correction-notes/${id(3)}`;
    const read = await send('facade', path + '?' + query()); expect(read.status).toBe(200); expect(read.body.result.state).toBe('RESERVED');
    expect(identity.authenticate.mock.calls[0][1]).toEqual(['b2b:corrections:read', 'b2b:corrections:write', 'b2b:documents:read', 'b2b:documents:issue']);
    const settled = await send('facade', path + '/settle', { body: { binding } }); expect(settled.status).toBe(200); expect(settled.body.result.state).toBe('SETTLED');
    expect(execution.status).toHaveBeenCalledTimes(1); expect(execution.settle).toHaveBeenCalledTimes(1); expect(drafts.prepare).not.toHaveBeenCalled();
  });

  it.each(['billing', 'facade'] as const)('%s endpoint requires trusted TLS client and pinned peer, ignoring spoofed headers', async target => {
    const path = target === 'billing' ? '/internal/b2b/correction-producer' : '/b2b/v1/correction-notes', body = target === 'billing' ? privateBody() : input();
    await expect(send(target, path, { body, peer: null })).rejects.toThrow();
    await expect(send(target, path, { body, trust: false })).rejects.toThrow();
    const r = await send(target, path, { body, peer: 'other', headers: { 'X-Forwarded-Client-Cert': 'ADMIN', 'X-User-Role': 'ADMIN_GENERAL' } });
    expect(r.status).toBe(403); expect(r.body.code).toBe('PRIVATE_PEER_REQUIRED');
    expect(factory).not.toHaveBeenCalled(); expect(identity.authenticate).not.toHaveBeenCalled();
  });

  it('does not interchange the edge and owner transport identities', async () => {
    expect((await send('billing', '/internal/b2b/correction-producer', { body: privateBody(), peer: 'edge' })).status).toBe(403);
    expect((await send('facade', '/b2b/v1/correction-notes', { body: input(), peer: 'resource' })).status).toBe(403);
    expect(factory).not.toHaveBeenCalled();
  });

  it.each(['billing', 'facade'] as const)('%s successful and denied responses prohibit caching/sniffing', async target => {
    const path = target === 'billing' ? '/internal/b2b/correction-producer' : '/b2b/v1/correction-notes', body = target === 'billing' ? privateBody() : input();
    for (const peer of [undefined, 'other'] as const) {
      const r = await send(target, path, { body, peer }); expect(r.headers['cache-control']).toBe('private, no-store'); expect(r.headers['x-content-type-options']).toBe('nosniff');
    }
  });

  it.each(['billing', 'facade'] as const)('%s checks peer and Bearer BEFORE accessing req.body or invoking any core', async target => {
    const response: any = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() };
    const controller = target === 'billing' ? new BillingCorrectionProducerController(factory, [fingerprint(tls.resource)]) : new B2bCorrectionController(core, [fingerprint(tls.edge)]);
    const body = vi.fn(() => { throw new Error('BODY_MUST_NOT_BE_READ'); });
    const req: any = { headers: {}, socket: { encrypted: false } }; Object.defineProperty(req, 'body', { get: body });
    await expect(target === 'billing' ? (controller as BillingCorrectionProducerController).call(req, response) : (controller as B2bCorrectionController).create(req, response)).rejects.toMatchObject({ code: 'PRIVATE_PEER_REQUIRED' });
    req.socket = { encrypted: true, authorized: true, getPeerCertificate: () => ({ fingerprint256: fingerprint(tls[target === 'billing' ? 'resource' : 'edge']) }) };
    await expect(target === 'billing' ? (controller as BillingCorrectionProducerController).call(req, response) : (controller as B2bCorrectionController).create(req, response)).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
    expect(body).not.toHaveBeenCalled(); expect(factory).not.toHaveBeenCalled(); expect(identity.authenticate).not.toHaveBeenCalled();
  });

  it.each(['Basic secret', 'Bearer', 'Bearer a b', 'bearer lowercase', 'Bearer a/b', 'Bearer a%20b'])('rejects malformed Authorization %s before core access', async authorization => {
    for (const target of ['billing', 'facade'] as const) {
      const r = await send(target, target === 'billing' ? '/internal/b2b/correction-producer' : '/b2b/v1/correction-notes',
        { body: target === 'billing' ? privateBody() : input(), headers: { Authorization: authorization } }); expect(r.status).toBe(401);
    }
    expect(factory).not.toHaveBeenCalled(); expect(identity.authenticate).not.toHaveBeenCalled();
  });

  it('rejects duplicate Bearer header metadata and invalid actor kind before body access', async () => {
    const response: any = { setHeader: vi.fn() }, req: any = { headers: { authorization: 'Bearer ' + TOKEN },
      rawHeaders: ['Authorization', 'Bearer ' + TOKEN, 'authorization', 'Bearer other'],
      socket: { encrypted: true, authorized: true, getPeerCertificate: () => ({ fingerprint256: fingerprint(tls.resource) }) } };
    Object.defineProperty(req, 'body', { get: () => { throw new Error('BODY_MUST_NOT_BE_READ'); } });
    await expect(new BillingCorrectionProducerController(factory, [fingerprint(tls.resource)]).call(req, response)).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
    expect((await send('facade', '/b2b/v1/correction-notes', { body: input(), headers: { 'X-Factuez-Actor-Kind': 'ADMIN' } })).status).toBe(401);
    expect(factory).not.toHaveBeenCalled();
  });

  it.each(['extra-envelope', 'unknown-action', 'bad-kind', 'array-action', 'array-kind', 'array-reason', 'extra-args', 'missing-binding', 'production', 'bad-id', 'batch', 'caller-evidence', 'caller-number'])('strictly rejects private payload %s before factory', async mode => {
    const body: any = privateBody();
    if (mode === 'extra-envelope') body.evidence = true;
    if (mode === 'unknown-action') body.action = 'TRANSMIT';
    if (mode === 'bad-kind') body.kind = 'ADMIN';
    if (mode === 'array-action') { body.action = ['STATUS']; body.args = { binding, operationId: id(3) }; }
    if (mode === 'array-kind') body.kind = ['SERVICE'];
    if (mode === 'array-reason') body.args.note.reasonCode = ['07'];
    if (mode === 'extra-args') { body.action = 'STATUS'; body.args = { binding, operationId: id(3), extra: true }; }
    if (mode === 'missing-binding') { body.action = 'SETTLE'; body.args = { operationId: id(3) }; }
    if (mode === 'production') body.args.binding.reference.environment = 'PRODUCTION';
    if (mode === 'bad-id') { body.action = 'STATUS'; body.args = { binding, operationId: 'bad-id' }; }
    if (mode === 'batch') body.args.binding.reference.documentType = '03';
    if (mode === 'caller-evidence') body.args.note.evidence = { trusted: true };
    if (mode === 'caller-number') body.args.number = '1';
    const r = await send('billing', '/internal/b2b/correction-producer', { body }); expect([400, 409]).toContain(r.status);
    expect(factory).not.toHaveBeenCalled(); expect(execution.reserve).not.toHaveBeenCalled();
    expect(execution.settle).not.toHaveBeenCalled(); expect(execution.status).not.toHaveBeenCalled();
  });

  it.each(['number', 'command', 'evidence', 'actor', 'url', 'unknown'])('rejects public injected field %s without contacting Billing', async field => {
    const r = await send('facade', '/b2b/v1/correction-notes', { body: { ...input(), [field]: 'injected' } }); expect(r.status).toBe(400);
    expect(identity.authenticate).not.toHaveBeenCalled(); expect(factory).not.toHaveBeenCalled();
  });

  it.each(['missing', 'unknown', 'duplicate', 'json-binding', 'secret', 'production', 'bad-issuer', 'bad-type', 'bad-id'])('rejects malformed explicit GET tuple: %s', async mode => {
    let q = query(), operationId = id(3);
    if (mode === 'missing') q = q.replace(/&noteType=07/, '');
    if (mode === 'unknown') q += '&extra=1';
    if (mode === 'duplicate') q += '&issuerId=99';
    if (mode === 'json-binding') q = 'binding=' + encodeURIComponent(JSON.stringify(binding));
    if (mode === 'secret') q += '&access_token=' + TOKEN;
    if (mode === 'production') q = q.replace('environment=BETA', 'environment=PRODUCTION');
    if (mode === 'bad-issuer') q = q.replace('issuerId=99', 'issuerId=099');
    if (mode === 'bad-type') q = q.replace('documentType=01', 'documentType=03');
    if (mode === 'bad-id') operationId = 'not-uuid';
    const r = await send('facade', `/b2b/v1/correction-notes/${operationId}?${q}`); expect([400, 409]).toContain(r.status);
    expect(identity.authenticate).not.toHaveBeenCalled(); expect(factory).not.toHaveBeenCalled(); expect(JSON.stringify(r.body)).not.toContain(TOKEN);
  });

  it('rejects GET bodies, POST query fields and settle body extras', async () => {
    const path = `/b2b/v1/correction-notes/${id(3)}`;
    expect((await send('facade', path + '?' + query(), { method: 'GET', body: {} })).status).toBe(400);
    expect((await send('facade', '/b2b/v1/correction-notes?environment=BETA', { body: input() })).status).toBe(400);
    expect((await send('facade', path + '/settle', { body: { binding, operationId: id(3) } })).status).toBe(400);
    expect((await send('billing', '/internal/b2b/correction-producer?token=secret', { body: privateBody() })).status).toBe(400);
    expect(factory).not.toHaveBeenCalled();
  });

  it.each(['ruc', 'company', 'branch', 'point', 'series'])('requires the whole original tuple; rejects crossed %s before owner', async mode => {
    const r = input();
    if (mode === 'ruc') r.binding.reference.issuerRuc = '20131312955'; if (mode === 'company') r.binding.reference.issuerId = 100;
    if (mode === 'branch') r.binding.reference.branchId = id(999); if (mode === 'point') r.binding.reference.pointId = id(999); if (mode === 'series') r.binding.reference.seriesId = id(999);
    const response = await send('facade', '/b2b/v1/correction-notes', { body: r }); expect(response.status).toBe(404); expect(factory).not.toHaveBeenCalled();
  });

  it('does not authorize a Cartesian combination of individually granted series/points', async () => {
    state.bindings = [{ ...binding.reference, pointId: id(998) }, { ...binding.reference, seriesId: id(999) }];
    expect((await send('facade', '/b2b/v1/correction-notes', { body: input() })).status).toBe(404); expect(factory).not.toHaveBeenCalled();
  });

  it('leaves note-series pairing to Billing authority, never inferring a note grant from the original grant', async () => {
    const r = input(); r.binding.noteSeriesId = id(999);
    const response = await send('facade', '/b2b/v1/correction-notes', { body: r }); expect(response.status).toBe(404);
    expect(factory).toHaveBeenCalledTimes(1); expect(drafts.prepare).not.toHaveBeenCalled(); expect(execution.reserve).not.toHaveBeenCalled();
  });

  it('honors missing scopes, revocation and quota failure without owner fallback', async () => {
    state.identityScopes = ['b2b:documents:read']; expect((await send('facade', '/b2b/v1/correction-notes', { body: input() })).status).toBe(401);
    state.identityScopes = [...scopes]; state.revoked = true; expect((await send('facade', '/b2b/v1/correction-notes', { body: input() })).status).toBe(401);
    state.revoked = false; state.limited = true; const limited = await send('facade', '/b2b/v1/correction-notes', { body: input() });
    expect(limited.status).toBe(429); expect(limited.headers['retry-after']).toBe('60'); expect(factory).not.toHaveBeenCalled();
  });

  it('denies read-only status before forwarding because the current paired owner authority requires issue/write too', async () => {
    state.identityScopes = ['b2b:corrections:read', 'b2b:documents:read'];
    const r = await send('facade', `/b2b/v1/correction-notes/${id(3)}?${query()}`);
    expect(r.status).toBe(401); expect(factory).not.toHaveBeenCalled(); expect(execution.status).not.toHaveBeenCalled();
  });

  it('withholds a result when Identity changes after owner execution', async () => {
    const normal = identity.authenticate.getMockImplementation()!; let n = 0;
    identity.authenticate.mockImplementationOnce(normal).mockImplementationOnce(async (...args) => { n++; state.clientRevision++; return normal(...args); });
    const response = await send('facade', '/b2b/v1/correction-notes', { body: input() }); expect(response.status).toBe(401); expect(response.body.code).toBe('ACCESS_CHANGED');
    expect(n).toBe(1); expect(execution.reserve).toHaveBeenCalledTimes(1); expect(response.body.result).toBeUndefined();
  });

  it('requires operation ownership before status/settlement, not just a valid grant', async () => {
    const path = `/b2b/v1/correction-notes/${id(999)}`;
    expect((await send('facade', path + '?' + query())).status).toBe(404);
    expect((await send('facade', path + '/settle', { body: { binding } })).status).toBe(404);
    expect(execution.status).not.toHaveBeenCalled(); expect(execution.settle).not.toHaveBeenCalled();
  });

  it.each(['binding', 'operationId', 'candidateOnly', 'fiscalExecutionEnabled', 'transmissionAuthorized', 'extra', 'nested-operation', 'nested-flag', 'getter'])('rejects corrupted remote receipt %s before returning data', async mode => {
    const receipt: any = { operationId: id(3), binding: structuredClone(binding), result: result(), candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false };
    if (mode === 'binding') receipt.binding.noteSeriesId = id(999); if (mode === 'operationId') receipt.operationId = id(999);
    if (mode === 'candidateOnly') receipt.candidateOnly = false; if (mode === 'fiscalExecutionEnabled') receipt.fiscalExecutionEnabled = true;
    if (mode === 'transmissionAuthorized') receipt.transmissionAuthorized = true; if (mode === 'extra') receipt.secret = 'MUST_NOT_LEAK';
    if (mode === 'nested-operation') receipt.result.operationId = id(999); if (mode === 'nested-flag') receipt.result.transmissionAuthorized = true;
    const getter = vi.fn(() => { throw new Error('MUST_NOT_RUN'); }); if (mode === 'getter') Object.defineProperty(receipt, 'secret', { get: getter, enumerable: true });
    const injected = new B2bCorrections(identity, { execute: async () => receipt });
    await expect(injected.status(TOKEN, 'SERVICE', binding, id(3))).rejects.toMatchObject({ code: 'INCONSISTENT_OWNER_RESPONSE' }); expect(getter).not.toHaveBeenCalled();
  });

  it('uses exactly one fixed private route and never sends authentication in args or query', async () => {
    const http = { post: vi.fn(async () => ({}) ) }, adapter = new HttpB2bCorrectionOwner(http);
    await adapter.execute(TOKEN, 'USER', 'STATUS', { binding, operationId: id(3) });
    expect(http.post).toHaveBeenCalledWith('/internal/b2b/correction-producer', { action: 'STATUS', kind: 'USER', args: { binding, operationId: id(3) } }, TOKEN);
    expect(JSON.stringify(http.post.mock.calls[0][1])).not.toContain(TOKEN);
  });

  it('bounds body parsing and rejects malformed JSON without calling owner ports', async () => {
    const malformed = await send('facade', '/b2b/v1/correction-notes', { raw: '{invalid' }); expect(malformed.status).toBe(400);
    const huge = await send('facade', '/b2b/v1/correction-notes', { body: { ...input(), padding: 'x'.repeat(256 * 1024) } }); expect(huge.status).toBe(413);
    expect(factory).not.toHaveBeenCalled(); expect(identity.authenticate).not.toHaveBeenCalled();
  });

  it('sanitizes unknown owner failures and does not return credentials/paths', async () => {
    drafts.prepare.mockRejectedValueOnce(new Error('SECRET_TOKEN_INTERNAL_PATH_20615878481'));
    const response = await send('facade', '/b2b/v1/correction-notes', { body: input() }); expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toMatch(/SECRET|INTERNAL_PATH|20615878481|ECONN/); expect(response.body.result).toBeUndefined();
  });

  it('exports isolated modules with copied peer allowlists and no production, signing or arbitrary routes', async () => {
    const peers = [fingerprint(tls.edge)], module = B2bCorrectionModule.isolated(core, peers); peers[0] = fingerprint(tls.other);
    expect((module.providers![1] as any).useValue).toEqual([fingerprint(tls.edge)]); expect(Object.isFrozen((module.providers![1] as any).useValue)).toBe(true);
    expect(() => B2bCorrectionModule.isolated(core, [])).toThrow(); expect(() => BillingCorrectionProducerModule.isolated(factory, ['bad'])).toThrow();
    for (const path of ['/internal/b2b/production', '/internal/b2b/sign', '/internal/b2b/sendBill', '/b2b/v1/invoices', '/b2b/v1/correction-notes/' + id(3) + '/transmit']) {
      expect((await send('facade', path, { body: {} })).status).toBe(404);
    }
    expect(factory).not.toHaveBeenCalled(); expect(identity.authenticate).not.toHaveBeenCalled();
  });

  it.each([false, true])('actual candidate application body guard only exposes corrections when configured=%s', async configured => {
    // Other modules are deliberately unbound stubs: this test exercises only optional module selection and the HTTP body guard.
    const app = await createB2bDraftApplication({} as never, { issuanceConfigured: false } as never,
      [fingerprint(tls.edge)], { ca: tls.ca, cert: tls.server, key: tls.key }, undefined, undefined, undefined, configured ? core : undefined);
    try {
      await app.listen(0, '127.0.0.1'); const port = (app.getHttpServer().address() as AddressInfo).port;
      const created = await send('facade', '/b2b/v1/correction-notes', { port, body: input() });
      expect(created.status).toBe(configured ? 202 : 400);
      if (configured) {
        const read = await send('facade', `/b2b/v1/correction-notes/${id(3)}?${query()}`, { port }); expect(read.status).toBe(200);
        const settled = await send('facade', `/b2b/v1/correction-notes/${id(3)}/settle`, { port, body: { binding } }); expect(settled.status).toBe(200);
        expect(execution.reserve).toHaveBeenCalledTimes(1); expect(execution.status).toHaveBeenCalledTimes(1); expect(execution.settle).toHaveBeenCalledTimes(1);
      } else {
        expect(created.body.code).toBe('DRAFT_COMMANDS_ONLY'); expect(factory).not.toHaveBeenCalled(); expect(identity.authenticate).not.toHaveBeenCalled();
      }
    } finally { await app.close(); }
  });
});
