import 'reflect-metadata';
import { request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { NestFactory } from '../services/b2b-api-service/node_modules/@nestjs/core';
import { B2bPrivateHttp } from '../packages/service-access/src/b2b';
import { b2bGuideIssueScopes, b2bGuideIssueReadScopes } from '../packages/contracts/src/b2b-guide-security';
import { BillingCarrierGuideModule, BillingCarrierGuideHttpErrorFilter } from '../services/billing-service/src/b2b/carrier-guide-http';
import { B2bCarrierGuideModule, B2bCarrierGuideOperations, HttpB2bCarrierGuideOwner } from '../services/b2b-api-service/src/carrier-guide-operations';
import { B2bGuideIssueHttpErrorFilter } from '../services/b2b-api-service/src/guide-issue';
import { b2bCertificates, fingerprint } from './b2b-tls.fixture';
import { carrierGuideHttpFixture } from './helpers/carrier-guide-http.fixture';

/** Real two-hop HTTPS + verified pinned mTLS on both apps and real private HTTP
 * client. Only owner persistence/identity are explicit in-memory port doubles;
 * the separate DB runner exercises the actual CarrierGuideOwner unchanged. */
describe('GT31 consumer HTTPS → public facade → fixed private mTLS owner RPC', () => {
  let tls: ReturnType<typeof b2bCertificates>, publicApp: any, privateApp: any, port: number, privatePort: number;
  let f = carrierGuideHttpFixture(), revision = 1;
  const principal = (kind: 'SERVICE' | 'USER') => ({ kind, clientId: '00000000-0000-4000-8000-000000000090', revision,
    subjectId: kind === 'USER' ? '00000000-0000-4000-8000-000000000091' : null, userAuthRevision: kind === 'USER' ? 2 : null,
    environment: 'BETA', scopes: [...new Set([...b2bGuideIssueScopes, ...b2bGuideIssueReadScopes])], bindings: [f.binding.draft.anchor] });
  const identity = { authenticate: vi.fn(async (_token: string, _scopes: any, kind: 'SERVICE' | 'USER') => principal(kind) as any) };
  const owner = {
    persistReadyDraft: vi.fn(async () => structuredClone(f.readyResponse)),
    issue: vi.fn(async () => structuredClone(f.issuance)),
    read: vi.fn(async () => structuredClone(f.issuance)),
    artifactCurrent: vi.fn(async () => structuredClone(f.owned)),
  };
  let client: HttpB2bCarrierGuideOwner;
  beforeAll(async () => {
    tls = b2bCertificates();
    const httpsOptions = { ca: tls.ca, cert: tls.server, key: tls.key, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' as const };
    privateApp = await NestFactory.create(BillingCarrierGuideModule.isolated(owner as any, [fingerprint(tls.resource)]),
      { logger: false, bodyParser: false, httpsOptions });
    privateApp.useBodyParser('json', { limit: 128 * 1024, strict: true }); privateApp.useGlobalFilters(new BillingCarrierGuideHttpErrorFilter());
    await privateApp.listen(0, '127.0.0.1'); privatePort = (privateApp.getHttpServer().address() as AddressInfo).port;
    client = new HttpB2bCarrierGuideOwner(new B2bPrivateHttp(`https://127.0.0.1:${privatePort}`, { ca: tls.ca, cert: tls.resource, key: tls.key }));
    publicApp = await NestFactory.create(B2bCarrierGuideModule.isolated(new B2bCarrierGuideOperations(identity, client), [fingerprint(tls.edge)]),
      { logger: false, bodyParser: false, httpsOptions });
    publicApp.useBodyParser('json', { limit: 128 * 1024, strict: true }); publicApp.useGlobalFilters(new B2bGuideIssueHttpErrorFilter());
    await publicApp.listen(0, '127.0.0.1'); port = (publicApp.getHttpServer().address() as AddressInfo).port;
  }, 30000);
  afterAll(async () => { await publicApp?.close(); await privateApp?.close(); });
  beforeEach(() => {
    f = carrierGuideHttpFixture(); revision = 1;
    owner.persistReadyDraft.mockReset().mockImplementation(async () => structuredClone(f.readyResponse));
    owner.issue.mockReset().mockImplementation(async () => structuredClone(f.issuance));
    owner.read.mockReset().mockImplementation(async () => structuredClone(f.issuance));
    owner.artifactCurrent.mockReset().mockImplementation(async () => structuredClone(f.owned));
    identity.authenticate.mockReset().mockImplementation(async (_token, _scopes, kind) => principal(kind) as any);
  });
  type Options = { method?: string; body?: unknown; raw?: string; private?: boolean; peer?: 'edge' | 'resource' | 'other'; headers?: Record<string, string | string[] | undefined> };
  function send(path: string, options: Options = {}) {
    const method = options.method ?? 'POST', bytes = options.raw === undefined ? options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body)) : Buffer.from(options.raw);
    const headers: Record<string, string | string[]> = { Authorization: 'Bearer synthetic_carrier_http_access', 'X-FactuEz-Actor-Kind': 'SERVICE',
      ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) } : {}) };
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      const old = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase()); if (old) delete headers[old];
      if (value !== undefined) headers[name] = value;
    }
    return new Promise<{ status: number; body: any; headers: any }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: options.private ? privatePort : port, path, method, ca: tls.ca,
        cert: tls[options.peer ?? (options.private ? 'resource' : 'edge')], key: tls.key, rejectUnauthorized: true, timeout: 5000, headers }, res => {
        const parts: Buffer[] = []; res.on('data', c => parts.push(c)); res.on('error', reject);
        res.on('end', () => { try { resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(parts).toString('utf8')), headers: res.headers }); } catch (e) { reject(e); } });
      }); req.on('error', reject); req.on('timeout', () => req.destroy(new Error('SYNTHETIC_TIMEOUT'))); req.end(bytes);
    });
  }
  const base = () => `/b2b/v1/carrier-guide-drafts/${f.ready.draftId}`;
  const query = () => new URLSearchParams(Object.entries({ ...f.binding.draft.anchor, guideSeriesId: f.binding.draft.guideSeriesId,
    guideType: '31', fiscalSeriesId: f.binding.fiscalSeriesId }).map(([k, v]) => [k, String(v)])).toString();
  const ready = (options: Options = {}) => send(base() + '/ready', { body: { binding: f.binding, body: f.body }, ...options });
  const issue = (options: Options = {}) => send(base() + '/issuance', { body: { binding: f.binding }, ...options,
    headers: { 'If-Match': '"v1"', 'Idempotency-Key': f.request.idempotencyKey, ...options.headers } });
  const read = (options: Options = {}, suffix = '') => send(base() + `/issuances/${f.scope.operationId}?` + query() + suffix, { method: 'GET', ...options });
  const privateCall = (body: unknown, options: Options = {}) => send('/internal/b2b/carrier-guides', { private: true, body, ...options });
  it.each(['SERVICE', 'USER'] as const)('forwards complete ready/issue/read for %s without leaking private reference or proof', async kind => {
    const headers = { 'X-FactuEz-Actor-Kind': kind };
    const r = await ready({ headers }); expect(r.status).toBe(200); expect(r.body).toEqual(f.readyResponse); expect(r.headers.etag).toBe('"v1"');
    expect(owner.persistReadyDraft).toHaveBeenCalledWith('synthetic_carrier_http_access', kind, f.ready);
    expect(identity.authenticate.mock.calls).toEqual([['synthetic_carrier_http_access', [...b2bGuideIssueScopes], kind], ['synthetic_carrier_http_access', [...b2bGuideIssueScopes], kind]]);
    const i = await issue({ headers }); expect(i.status).toBe(200); expect(i.body).toEqual(f.issuance);
    expect(owner.issue).toHaveBeenCalledWith('synthetic_carrier_http_access', kind, f.request);
    expect(i.headers['x-operation-id']).toBe(f.issuance.operationId); expect(i.headers['x-idempotent-replay']).toBe('false');
    identity.authenticate.mockClear();
    const g = await read({ headers }); expect(g.status).toBe(200); expect(g.body).toEqual(f.issuance);
    expect(owner.read).toHaveBeenCalledWith('synthetic_carrier_http_access', kind, f.scope);
    expect(identity.authenticate.mock.calls).toEqual([['synthetic_carrier_http_access', [...b2bGuideIssueReadScopes], kind], ['synthetic_carrier_http_access', [...b2bGuideIssueReadScopes], kind]]);
    expect(g.headers['cache-control']).toBe('private, no-store'); expect(g.headers['x-content-type-options']).toBe('nosniff');
    expect(JSON.stringify(g.body)).not.toMatch(/authorizationSha256|cdrSha256|privateKey|certificatePem|PRIVATE KEY|synthetic_carrier_http_access/);
    expect(owner.artifactCurrent).not.toHaveBeenCalled();
  });
  it.each(['READ', 'ISSUE'] as const)('private artifact owner receives explicit independent %s and exact private reply', async permission => {
    const response = await privateCall({ action: 'ARTIFACT_OWNER', kind: 'SERVICE', scope: f.scope, permission });
    expect(response.status).toBe(200); expect(response.body).toEqual(f.owned);
    expect(Object.keys(response.body).sort()).toEqual(['authorizationSha256', 'issuance', 'reference']);
    expect(owner.artifactCurrent).toHaveBeenCalledWith(f.scope, { token: 'synthetic_carrier_http_access', kind: 'SERVICE' }, permission);
    expect(await client.artifactCurrent(f.scope, { token: 'synthetic_carrier_http_access', kind: 'SERVICE' }, permission)).toEqual(f.owned);
  });
  it('withholds public routes for private reference and refuses a different trusted peer before owner/identity', async () => {
    expect((await send(base() + '/artifact-owner', { body: {} })).status).toBe(404);
    expect((await ready({ peer: 'other' })).status).toBe(403);
    expect((await privateCall({ action: 'READY', kind: 'SERVICE', request: f.ready }, { peer: 'edge' })).status).toBe(403);
    expect(owner.persistReadyDraft).not.toHaveBeenCalled(); expect(identity.authenticate).not.toHaveBeenCalled();
  });
  it.each(['authorization', 'x-factuez-actor-kind', 'if-match', 'idempotency-key', 'x-extra'])(
    'rejects duplicate public header %s before owner', async name => {
      expect((await issue({ headers: { [name]: ['duplicated', 'duplicated'] } })).status).toBe(['authorization', 'x-factuez-actor-kind'].includes(name) ? 401 : 400);
      expect(owner.issue).not.toHaveBeenCalled();
    });
  it.each(['If_Match', 'IfMatch', 'IdempotencyKey', 'Idempotency_Key', 'X_Factuez_Actor_Kind'])(
    'rejects public security alias %s', async name => { expect((await issue({ headers: { [name]: 'alias' } })).status).toBe(400); expect(owner.issue).not.toHaveBeenCalled(); });
  it('requires explicit kind/Bearer and strong If-Match/idempotency headers', async () => {
    for (const kind of [undefined, 'ADMIN', 'service']) expect((await ready({ headers: { 'X-FactuEz-Actor-Kind': kind } })).status).toBe(401);
    for (const auth of [undefined, 'Basic x', 'Bearer a b']) expect((await ready({ headers: { Authorization: auth } })).status).toBe(401);
    expect((await issue({ headers: { 'If-Match': undefined } })).status).toBe(428);
    for (const m of ['*', 'W/"v1"', '"v0"', '"v1", "v2"']) expect((await issue({ headers: { 'If-Match': m } })).status).toBe(400);
    expect((await issue({ headers: { 'Idempotency-Key': 'short' } })).status).toBe(400); expect(owner.issue).not.toHaveBeenCalled();
  });
  it('rejects client XML/proof, incomplete body, wrong type and request query before owner', async () => {
    for (const body of [{ binding: f.binding, body: f.body, xml: '<fake/>' }, { binding: f.binding, body: f.body, reference: f.owned.reference },
      { binding: f.binding, body: {} }, { binding: f.binding, body: f.body, accepted: true }]) expect((await ready({ body })).status).toBe(400);
    const wrong = structuredClone(f.binding); wrong.draft.guideType = '09'; expect((await ready({ body: { binding: wrong, body: f.body } })).status).toBe(400);
    expect((await send(base() + '/ready?', { body: { binding: f.binding, body: f.body } })).status).toBe(400);
    expect((await ready({ headers: { 'Content-Type': 'text/plain' } })).status).toBe(400);
    expect(owner.persistReadyDraft).not.toHaveBeenCalled();
  });
  it('strictly parses all ten read query keys without body, duplicates or aliases', async () => {
    for (const name of new URLSearchParams(query()).keys()) expect((await read({}, `&${name}=duplicate`)).status).toBe(400);
    for (const extra of ['&%69ssuerId=1', '&issuer_id=1', '&binding=x', '&permission=ISSUE']) expect((await read({}, extra)).status).toBe(400);
    expect((await read({ body: {} })).status).toBe(400);
    expect((await send(base() + `/issuances/${f.scope.operationId}?issuerId=1`, { method: 'GET' })).status).toBe(400);
    expect(owner.read).not.toHaveBeenCalled();
  });
  it.each(['unknown-action', 'missing-permission', 'unknown-permission', 'extra-proof', 'wrong-type', 'missing-kind', 'duplicate-header', 'query'])(
    'rejects private envelope attack %s before owner', async scenario => {
      const body: any = { action: 'ARTIFACT_OWNER', kind: 'SERVICE', scope: structuredClone(f.scope), permission: 'READ' };
      if (scenario === 'unknown-action') body.action = 'SIGN'; if (scenario === 'missing-permission') delete body.permission;
      if (scenario === 'unknown-permission') body.permission = 'ADMIN'; if (scenario === 'extra-proof') body.reference = f.owned.reference;
      if (scenario === 'wrong-type') body.scope.binding.draft.guideType = '09'; if (scenario === 'missing-kind') delete body.kind;
      const r = scenario === 'query' ? await send('/internal/b2b/carrier-guides?x=1', { private: true, body }) :
        await privateCall(body, scenario === 'duplicate-header' ? { headers: { 'X-Extra': ['x', 'x'] } } : {});
      expect(r.status).toBe(400); expect(owner.artifactCurrent).not.toHaveBeenCalled();
    });
  it('bounds/sanitizes malformed and oversized JSON at both real parsers', async () => {
    for (const privateTarget of [false, true]) {
      const path = privateTarget ? '/internal/b2b/carrier-guides' : base() + '/ready';
      const malformed = await send(path, { private: privateTarget, raw: '{"PRIVATE_SECRET":' }); expect(malformed.status).toBe(400);
      expect(JSON.stringify(malformed.body)).not.toContain('PRIVATE_SECRET');
      const large = await send(path, { private: privateTarget, body: { text: 'x'.repeat(129 * 1024) } }); expect(large.status).toBe(413);
    }
    expect(owner.persistReadyDraft).not.toHaveBeenCalled();
  });
  it('withholds changed authority, inconsistent owner and arbitrary dependency messages', async () => {
    owner.issue.mockImplementationOnce(async () => { revision++; return structuredClone(f.issuance); });
    expect((await issue()).status).toBe(401);
    revision = 1; owner.read.mockResolvedValueOnce({ ...f.issuance, privateKey: 'PRIVATE_SECRET' } as any);
    const corrupt = await read(); expect(corrupt.status).toBe(503); expect(JSON.stringify(corrupt.body)).not.toContain('PRIVATE_SECRET');
    owner.persistReadyDraft.mockRejectedValueOnce(new Error('PRIVATE_SECRET'));
    const failure = await ready(); expect(failure.status).toBe(503); expect(JSON.stringify(failure.body)).not.toContain('PRIVATE_SECRET');
    owner.artifactCurrent.mockResolvedValueOnce({ ...f.owned, authorizationSha256: 'bad' });
    expect((await privateCall({ action: 'ARTIFACT_OWNER', kind: 'SERVICE', scope: f.scope, permission: 'READ' })).status).toBe(503);
  });
});
