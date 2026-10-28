import 'reflect-metadata';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NestFactory } from '../services/b2b-api-service/node_modules/@nestjs/core';
import { METHOD_METADATA, PATH_METADATA } from '../services/b2b-api-service/node_modules/@nestjs/common/constants';
import { B2bSecurityError, type B2bPrincipal } from '../packages/contracts/src/b2b-security';
import { IntegrationReadError } from '../packages/service-access/src/integration';
import { b2bGuideIssueScopes, b2bGuideIssueReadScopes } from '../packages/contracts/src/b2b-guide-security';
import { B2bGuideIssuances, B2bGuideIssuanceController, B2bGuideIssueModule, B2bGuideIssueHttpErrorFilter, HttpB2bGuideIssueOwner } from '../services/b2b-api-service/src/guide-issue';
import { addB2bGuideIssueOpenApi } from '../packages/contracts/src/b2b-guide-issue-openapi';
import { addB2bGuideDraftRoutes } from '../packages/contracts/src/b2b-guide-openapi';
import { guideIssueFixture } from './helpers/guide-issue.fixture';

const TOKEN = 'synthetic-issue-token', PIN = 'a'.repeat(64);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** Real loopback HTTP/parser/controllers/frame/wire. The socket identity below is
 * an in-memory transport double: these tests do not claim a TLS handshake test
 * and never read or create certificates, secrets or external service data. */
describe('isolated guide issuance HTTP candidate', () => {
  let app: any, port: number, fixture: ReturnType<typeof guideIssueFixture>, issued: any;
  const principal = (kind: 'SERVICE' | 'USER'): B2bPrincipal => ({ kind, clientId: id(90), revision: 1,
    subjectId: kind === 'USER' ? id(91) : null, userAuthRevision: kind === 'USER' ? 2 : null, environment: 'BETA',
    scopes: [...new Set([...b2bGuideIssueScopes, ...b2bGuideIssueReadScopes])], bindings: [structuredClone(fixture.binding.draft.anchor)] });
  const identity = { authenticate: vi.fn(async (_token: string, _scopes: any, kind: 'SERVICE' | 'USER') => principal(kind)) };
  const post = vi.fn(async (path: string, _body: unknown, _token?: string) => ({ ...structuredClone(issued), replayed: path.endsWith('read-guide-issuance') ? null : issued.replayed }));
  const core = new B2bGuideIssuances(identity, new HttpB2bGuideIssueOwner({ post }));
  const issuePath = () => `/b2b/v1/guide-drafts/${fixture.request.draftId}/issuance`;
  const query = () => new URLSearchParams(Object.entries({ ...fixture.binding.draft.anchor, guideSeriesId: fixture.binding.draft.guideSeriesId,
    guideType: fixture.binding.draft.guideType, fiscalSeriesId: fixture.binding.fiscalSeriesId }).map(([k, v]) => [k, String(v)])).toString();
  const readPath = () => `/b2b/v1/guide-drafts/${fixture.request.draftId}/issuances/${issued.operationId}?${query()}`;
  type Options = { method?: string; body?: unknown; raw?: string; peer?: string; headers?: Record<string, string | string[] | undefined> };
  async function send(path: string, options: Options = {}) {
    const method = options.method ?? 'POST', bytes = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    const headers: Record<string, string | string[]> = { Authorization: `Bearer ${TOKEN}`, 'X-FactuEz-Actor-Kind': 'SERVICE',
      'X-Synthetic-Peer': options.peer ?? 'pinned', ...(method === 'POST' ? { 'If-Match': '"v2"', 'Idempotency-Key': fixture.request.idempotencyKey } : {}),
      ...(bytes === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(bytes)) }) };
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      const old = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase()); if (old) delete headers[old];
      if (value !== undefined) headers[name] = value;
    }
    return new Promise<{ status: number; body: any; headers: any }>((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, method, path, headers, timeout: 5000 }, res => {
        const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
        res.on('end', () => { try { resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()), headers: res.headers }); } catch (e) { reject(e); } });
      });
      req.on('error', reject); req.on('timeout', () => req.destroy(new Error('SYNTHETIC_TIMEOUT'))); req.end(bytes);
    });
  }
  const issue = (options: Options = {}, path = issuePath()) => send(path, { body: { binding: fixture.binding }, ...options });
  const read = (options: Options = {}, path = readPath()) => send(path, { method: 'GET', ...options });
  beforeAll(async () => {
    app = await NestFactory.create(B2bGuideIssueModule.isolated(core, [PIN]), { logger: false, bodyParser: false });
    app.use((req: any, _res: any, next: () => void) => {
      req.socket.encrypted = req.headers['x-synthetic-peer'] !== 'plaintext';
      req.socket.authorized = req.headers['x-synthetic-peer'] !== 'untrusted';
      req.socket.getPeerCertificate = () => ({ fingerprint256: req.headers['x-synthetic-peer'] === 'other' ? 'b'.repeat(64) : PIN });
      next();
    });
    app.useBodyParser('json', { limit: 128 * 1024, strict: true }); app.useGlobalFilters(new B2bGuideIssueHttpErrorFilter());
    await app.listen(0, '127.0.0.1'); port = (app.getHttpServer().address() as AddressInfo).port;
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    fixture = guideIssueFixture(); const result = await fixture.issue();
    issued = { schemaVersion: 'factuez.b2b.guide-issuance.v1', operationId: result.receipt.id, draftId: fixture.request.draftId,
      binding: fixture.binding, snapshot: result.receipt.snapshot, snapshotSha256: result.receipt.snapshotSha256, replayed: false };
    identity.authenticate.mockReset().mockImplementation(async (_token, _scopes, kind) => principal(kind));
    post.mockReset().mockImplementation(async path => ({ ...structuredClone(issued), replayed: path.endsWith('read-guide-issuance') ? null : issued.replayed }));
  });
  it('declares only the two agreed routes on the exported inventory controller', () => {
    const p = B2bGuideIssuanceController.prototype;
    const names = Object.getOwnPropertyNames(p).filter(n => Reflect.hasMetadata(METHOD_METADATA, (p as any)[n]));
    expect(names).toEqual(['issue', 'read']);
    expect(Reflect.getMetadata(PATH_METADATA, p.issue)).toBe('guide-drafts/:id/issuance');
    expect(Reflect.getMetadata(PATH_METADATA, p.read)).toBe('guide-drafts/:id/issuances/:operationId');
    expect(Reflect.getMetadata(METHOD_METADATA, p.issue)).toBe(1); expect(Reflect.getMetadata(METHOD_METADATA, p.read)).toBe(0);
  });
  it.each(['SERVICE', 'USER'] as const)('constructs the exact POST request and GET RPC envelope for %s', async kind => {
    const r = await issue({ headers: { 'X-FactuEz-Actor-Kind': kind } }); expect(r.status).toBe(200); expect(r.body).toEqual(issued);
    expect(post).toHaveBeenCalledExactlyOnceWith('/internal/b2b/issue-guide', { kind, request: fixture.request }, TOKEN);
    expect(r.headers.etag).toBe('"v2"'); expect(r.headers['x-idempotent-replay']).toBe('false'); expect(r.headers['x-operation-id']).toBe(issued.operationId);
    expect(r.headers['cache-control']).toBe('private, no-store'); expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(identity.authenticate.mock.calls).toEqual([[TOKEN, [...b2bGuideIssueScopes], kind], [TOKEN, [...b2bGuideIssueScopes], kind]]);
    identity.authenticate.mockClear(); post.mockClear();
    const g = await read({ headers: { 'X-FactuEz-Actor-Kind': kind } }); expect(g.status).toBe(200); expect(g.body).toEqual({ ...issued, replayed: null });
    expect(post).toHaveBeenCalledExactlyOnceWith('/internal/b2b/read-guide-issuance', { kind, binding: fixture.binding, draftId: fixture.request.draftId, operationId: issued.operationId }, TOKEN);
    expect(identity.authenticate.mock.calls).toEqual([[TOKEN, [...b2bGuideIssueReadScopes], kind], [TOKEN, [...b2bGuideIssueReadScopes], kind]]);
  });
  it('exposes replay status without any internal receipt or digest of the key', async () => {
    issued.replayed = true; const r = await issue(); expect(r.status).toBe(200); expect(r.body.replayed).toBe(true);
    expect(r.headers['x-idempotent-replay']).toBe('true'); expect(r.body).not.toHaveProperty('receipt');
    expect(JSON.stringify(r.body)).not.toMatch(/keySha256|requestSha256|synthetic-issue-token/);
  });
  it.each(['plaintext', 'untrusted', 'other'])('rejects synthetic peer state %s before identity and owner', async peer => {
    expect((await issue({ peer })).status).toBe(403); expect(post).not.toHaveBeenCalled(); expect(identity.authenticate).not.toHaveBeenCalled();
  });
  it.each([undefined, '', 'ADMIN', 'service'])('requires explicit actor kind %s', async kind => {
    expect((await issue({ headers: { 'X-FactuEz-Actor-Kind': kind } })).status).toBe(401); expect(post).not.toHaveBeenCalled();
  });
  it.each(['Basic token', 'Bearer a b', 'bearer token', 'Bearer a/b'])('rejects malformed authorization %s', async value => {
    expect((await issue({ headers: { Authorization: value } })).status).toBe(401); expect(post).not.toHaveBeenCalled();
  });
  it.each(['authorization', 'x-factuez-actor-kind', 'idempotency-key', 'if-match', 'x-extra'])('rejects duplicate header %s', async name => {
    const value = name === 'authorization' ? `Bearer ${TOKEN}` : name === 'x-factuez-actor-kind' ? 'SERVICE' : name === 'if-match' ? '"v2"' : fixture.request.idempotencyKey;
    expect((await issue({ headers: { [name]: [value, value] } })).status).toBe(['authorization', 'x-factuez-actor-kind'].includes(name) ? 401 : 400);
    expect(post).not.toHaveBeenCalled();
  });
  it.each(['Idempotency_Key', 'IdempotencyKey', 'If_Match', 'IfMatch', 'X_Factuez_Actor_Kind'])('rejects header alias %s', async name => {
    expect((await issue({ headers: { [name]: 'synthetic_alias' } })).status).toBe(400); expect(post).not.toHaveBeenCalled();
  });
  it('requires strong If-Match and a canonical idempotency key', async () => {
    expect((await issue({ headers: { 'If-Match': undefined } })).status).toBe(428);
    for (const value of ['*', 'W/"v2"', '"v0"', '"v2", "v3"', '"v1000000000"']) expect((await issue({ headers: { 'If-Match': value } })).status).toBe(400);
    for (const value of [undefined, 'short', 'invalid key with whitespace']) expect((await issue({ headers: { 'Idempotency-Key': value } })).status).toBe(400);
    expect(post).not.toHaveBeenCalled();
  });
  it.each([{}, [], { binding: {}, extra: true }, { binding: null }, { binding: {}, expectedRevision: '"v2"' }])('rejects public body %j', async body => {
    expect((await issue({ body })).status).toBe(400); expect(post).not.toHaveBeenCalled();
  });
  it.each(['?', '?x=1', '?binding=x'])('rejects POST query suffix %s', async suffix => {
    expect((await issue({}, issuePath() + suffix)).status).toBe(400); expect(post).not.toHaveBeenCalled();
  });
  it('rejects malformed ids and strict GET query/body attacks before owner access', async () => {
    expect((await issue({}, '/b2b/v1/guide-drafts/invalid/issuance')).status).toBe(400);
    expect((await read({}, readPath().replace(issued.operationId, 'invalid'))).status).toBe(400);
    for (const key of new URLSearchParams(query()).keys()) {
      expect((await read({}, readPath() + `&${key}=duplicate`)).status).toBe(400);
      const q = new URLSearchParams(query()); q.delete(key);
      expect((await read({}, readPath().split('?')[0] + '?' + q)).status).toBe(400);
    }
    for (const suffix of ['&binding=x', '&anchor[issuerId]=1', '&issuerId[]=1', '&fiscalSeriesId=extra', '&%69ssuerId=1']) expect((await read({}, readPath() + suffix)).status).toBe(400);
    expect((await read({ body: {} })).status).toBe(400); expect((await read({ raw: 'null' })).status).toBe(400);
    expect(post).not.toHaveBeenCalled();
  });
  it('sanitizes parser errors and enforces the 128 KiB request limit', async () => {
    const invalid = await issue({ raw: '{"SYNTHETIC_PRIVATE":' }); expect(invalid.status).toBe(400); expect(JSON.stringify(invalid.body)).not.toContain('SYNTHETIC_PRIVATE');
    const big = await issue({ body: { binding: fixture.binding, extra: 'x'.repeat(128 * 1024) } }); expect(big.status).toBe(413); expect(post).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403, 404, 409, 412, 413, 422, 428, 429, 503, 599, NaN])('maps owner status %s and raw codes to a finite safe envelope', async status => {
    post.mockRejectedValue(new B2bSecurityError(status, 'SYNTHETIC_PRIVATE_OWNER_OUTPUT'));
    const r = await issue(); expect(r.status).toBe([400, 401, 403, 404, 409, 412, 413, 422, 428, 429, 503].includes(status) ? status : 503);
    expect(JSON.stringify(r.body)).not.toContain('SYNTHETIC_PRIVATE'); expect(r.body.snapshot).toBeUndefined();
    if (status === 401) expect(r.headers['www-authenticate']).toBe('Bearer'); if (status === 429) expect(r.headers['retry-after']).toBe('60');
  });
  it('withholds invalid owner aggregates, oversized responses and post-call revocation', async () => {
    for (const result of [{ receipt: { keySha256: 'SYNTHETIC_PRIVATE' } }, { ...issued, replayed: null },
      { ...issued, snapshotSha256: '0'.repeat(64) }, { ...issued, extra: 'x'.repeat(512 * 1024) }]) {
      post.mockResolvedValueOnce(result); const r = await issue(); expect(r.status).toBe(503); expect(JSON.stringify(r.body)).not.toContain('SYNTHETIC_PRIVATE');
    }
    identity.authenticate.mockImplementationOnce(async () => principal('SERVICE')).mockImplementationOnce(async () => ({ ...principal('SERVICE'), revision: 2 }));
    expect((await issue()).status).toBe(401);
    post.mockRejectedValueOnce(new Error('SYNTHETIC_PRIVATE')); const failure = await issue(); expect(failure.status).toBe(503); expect(JSON.stringify(failure.body)).not.toContain('SYNTHETIC_PRIVATE');
  });
  it('does not duck-type owner exceptions or trust another adapter error vocabulary', async () => {
    const inspect = vi.fn(() => { throw new Error('SYNTHETIC_PRIVATE'); });
    const accessor = Object.defineProperty(new Error('SYNTHETIC_PRIVATE'), 'status', { get: inspect });
    for (const error of [{ status: 400, code: 'SYNTHETIC_PRIVATE' }, new IntegrationReadError(400, 'SYNTHETIC_PRIVATE' as never),
      new B2bSecurityError('503' as never, 'SYNTHETIC_PRIVATE'), accessor]) {
      post.mockRejectedValueOnce(error); const r = await issue(); expect(r.status).toBe(503);
      expect(r.body.code).toBe('OWNER_UNAVAILABLE'); expect(JSON.stringify(r.body)).not.toContain('SYNTHETIC_PRIVATE');
    }
    expect(inspect).not.toHaveBeenCalled();
  });
  it('adds exact closed schemas and two inactive guideissuance paths without modifying the entrypoint', () => {
    const api: any = { components: { schemas: { Context: { properties: {
      issuerId: { type: 'integer' }, issuerRuc: { type: 'string' }, environment: { const: 'BETA' }, branchId: { type: 'string' },
      pointId: { type: 'string' }, seriesId: { type: 'string' }, documentType: { enum: ['01', '03'] },
    } } } }, info: { description: '0 operaciones' }, paths: {} };
    addB2bGuideDraftRoutes(api); const before = Object.keys(api.paths); addB2bGuideIssueOpenApi(api);
    expect(Object.keys(api.paths).filter(p => !before.includes(p))).toEqual(['/b2b/v1/guide-drafts/{id}/issuance', '/b2b/v1/guide-drafts/{id}/issuances/{operationId}']);
    const post = api.paths['/b2b/v1/guide-drafts/{id}/issuance'].post, get = api.paths['/b2b/v1/guide-drafts/{id}/issuances/{operationId}'].get;
    expect(post['x-runtime-enabled']).toBe(false); expect(post['x-required-scopes']).toEqual([...b2bGuideIssueScopes]);
    expect(get['x-required-scopes']).toEqual([...b2bGuideIssueReadScopes]); expect(get.parameters.filter((p: any) => p.in === 'query')).toHaveLength(10);
    expect(get).not.toHaveProperty('requestBody'); expect(api.components.schemas.GuideIssuanceRead.properties.replayed).toEqual({ type: 'null' });
    expect(api.components.schemas.GuideIssuance.additionalProperties).toBe(false); expect(api.components.schemas.GuideIssuePublicRequest.required).toEqual(['binding']);
    expect(api.components.schemas.GuideIssuedSnapshot.properties.numberReserved.const).toBe(true);
    expect(api.tags.find((t: any) => t.name === 'guideissuance')).toBeDefined();
  });
});
