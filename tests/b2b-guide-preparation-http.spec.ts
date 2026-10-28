import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '../services/billing-service/node_modules/@nestjs/core';
import { METHOD_METADATA, PATH_METADATA } from '../services/billing-service/node_modules/@nestjs/common/constants';
import { B2bSecurityError, type B2bPrincipal, type B2bIdentityScope } from '../packages/contracts/src/b2b-security';
import type { B2bGuideBinding } from '../packages/contracts/src/b2b-guide-security';
import { correctionEvidenceHash } from '../packages/service-access/src/b2b-correction-evidence-wire';
import { prepareGuide09 } from '../packages/sunat-core/src/fiscal-guide-preparation';
import { guidePreparationInput } from './helpers/guide-preparation.fixture';
import { BillingGuidePreparationController, BillingGuidePreparationModule } from '../services/billing-service/src/b2b/guide-preparation-http';
import { BillingGuideHttpErrorFilter } from '../services/billing-service/src/b2b/guide-http';
import { B2bGuidePreparations, B2bGuidePreparationController, B2bGuidePreparationModule, HttpB2bGuidePreparationOwner } from '../services/b2b-api-service/src/guide-preparation';
import { B2bGuideHttpErrorFilter } from '../services/b2b-api-service/src/guides';
import { createB2bDraftApplication } from '../services/b2b-api-service/src/draft-application';
import { B2bReads } from '../services/b2b-api-service/src/read';
import { b2bCertificates, fingerprint } from './b2b-tls.fixture';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TOKEN = 'synthetic-guide-preparation-token', REVISION = '"v2"';
const required: B2bIdentityScope[] = ['b2b:guides:read', 'b2b:documents:read'];
const binding: B2bGuideBinding = { anchor: { issuerId: 99, issuerRuc: '20000000001', environment: 'BETA',
  branchId: id(1), pointId: id(2), seriesId: id(3), documentType: '01' }, guideSeriesId: id(4), guideType: '09' };
const GATES = ['NUMBER_RESERVATION', 'ESTABLISHMENT_MAPPING', 'CATALOGUES_AND_REGULATED_GOODS', 'OFFICIAL_XSL_RULES',
  'XSD_ON_SIGNED_XML', 'SIGNATURE_AND_PKI', 'SUNAT_TRANSPORT_AND_CDR'];
const input = () => ({ ...guidePreparationInput(), draftId: id(10), draftRevision: REVISION });
const result = (): any => ({ schemaVersion: 'factuez.b2b.guide-preparation.v1', binding: structuredClone(binding), plan: prepareGuide09(input()),
  gates: [...GATES], candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false, authorizedForTransfer: false });
const principal = (kind: 'SERVICE' | 'USER'): B2bPrincipal => ({ kind, clientId: id(90), revision: 1,
  subjectId: kind === 'USER' ? id(91) : null, userAuthRevision: kind === 'USER' ? 2 : null, environment: 'BETA',
  scopes: [...required], bindings: [structuredClone(binding.anchor)] });
const publicPath = `/b2b/v1/guide-drafts/${id(10)}/preparation`, privatePath = '/internal/b2b/prepare-guide';
const envelope = () => ({ kind: 'SERVICE', binding: structuredClone(binding), id: id(10), ifMatch: REVISION });

/** Two independent real loopback HTTPS hosts, ephemeral test PKI, fictitious business doubles only. */
describe('read-only guide preparation HTTP', () => {
  let tls: ReturnType<typeof b2bCertificates>, billing: any, facade: any, billingPort: number, facadePort: number;
  let preparations: B2bGuidePreparations;
  const authenticate = async (token: string, _scopes: B2bIdentityScope[], kind: 'SERVICE' | 'USER') => {
    if (token !== TOKEN) throw new B2bSecurityError(401, 'INVALID_TOKEN');
    return principal(kind);
  };
  const identity = { authenticate: vi.fn(authenticate) };
  const core = { prepare: vi.fn(async (_token: string, _kind: 'SERVICE' | 'USER', _binding: B2bGuideBinding, _id: string, _ifMatch: string): Promise<unknown> => result()) };
  type Options = { method?: string; body?: unknown; raw?: string; peer?: 'edge' | 'resource' | 'other' | null;
    trust?: boolean; port?: number; headers?: Record<string, string | string[] | undefined> };
  async function send(target: 'billing' | 'facade', path: string, options: Options = {}) {
    const peer = options.peer === undefined ? target === 'billing' ? 'resource' : 'edge' : options.peer;
    const bytes = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    const headers: Record<string, string | string[]> = { Authorization: `Bearer ${TOKEN}`, 'X-Factuez-Actor-Kind': 'SERVICE',
      'If-Match': REVISION, ...(bytes === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(bytes)) }) };
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      const previous = Object.keys(headers).find(key => key.toLowerCase() === name.toLowerCase());
      if (previous) delete headers[previous];
      if (value !== undefined) headers[name] = value;
    }
    return new Promise<{ status: number; body: any; headers: any }>((resolve, reject) => {
      const req = httpsRequest({ hostname: '127.0.0.1', port: options.port ?? (target === 'billing' ? billingPort : facadePort), path,
        method: options.method ?? 'POST', rejectUnauthorized: true, timeout: 5000,
        ...(options.trust === false ? {} : { ca: tls.ca }), ...(peer ? { cert: tls[peer], key: tls.key } : {}), headers,
      }, res => {
        const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
        res.on('end', () => { try { resolve({ status: res.statusCode!, headers: res.headers,
          body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null }); } catch (error) { reject(error); } });
      });
      req.on('error', reject); req.on('timeout', () => req.destroy(new Error('SYNTHETIC_LOOPBACK_TIMEOUT'))); req.end(bytes);
    });
  }
  const rpc = async (path: string, body: unknown, token?: string) => {
    const r = await send('billing', path, { body, headers: { Authorization: `Bearer ${token}` } });
    if (r.status !== 200) throw new B2bSecurityError(r.status, r.body.code);
    return r.body;
  };
  const transport = { post: vi.fn(rpc) };
  const prepare = (options: Options = {}, path = publicPath) => send('facade', path, { body: { binding }, ...options });

  beforeAll(async () => {
    tls = b2bCertificates();
    const httpsOptions = { ca: tls.ca, cert: tls.server, key: tls.key, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' as const };
    billing = await NestFactory.create(BillingGuidePreparationModule.isolated(core, [fingerprint(tls.resource)]), { logger: false, bodyParser: false, httpsOptions });
    billing.useBodyParser('json', { limit: 128 * 1024, strict: true }); billing.useGlobalFilters(new BillingGuideHttpErrorFilter());
    await billing.listen(0, '127.0.0.1'); billingPort = (billing.getHttpServer().address() as AddressInfo).port;
    preparations = new B2bGuidePreparations(identity, new HttpB2bGuidePreparationOwner(transport));
    facade = await NestFactory.create(B2bGuidePreparationModule.isolated(preparations, [fingerprint(tls.edge)]), { logger: false, bodyParser: false, httpsOptions });
    facade.useBodyParser('json', { limit: 128 * 1024, strict: true }); facade.useGlobalFilters(new B2bGuideHttpErrorFilter());
    await facade.listen(0, '127.0.0.1'); facadePort = (facade.getHttpServer().address() as AddressInfo).port;
  }, 30000);
  afterAll(async () => { await facade?.close(); await billing?.close(); });
  beforeEach(() => {
    identity.authenticate.mockReset().mockImplementation(authenticate);
    core.prepare.mockReset().mockImplementation(async () => result());
    transport.post.mockReset().mockImplementation(rpc);
  });

  it('declares exactly one POST on each controller', () => {
    for (const [controller, path] of [[BillingGuidePreparationController, 'prepare-guide'], [B2bGuidePreparationController, 'guide-drafts/:id/preparation']] as const) {
      const routes = Object.getOwnPropertyNames(controller.prototype).filter(name => Reflect.hasMetadata(METHOD_METADATA, (controller.prototype as any)[name]));
      expect(routes).toEqual(['prepare']);
      expect(Reflect.getMetadata(PATH_METADATA, controller.prototype.prepare)).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, controller.prototype.prepare)).toBe(1);
    }
  });
  it.each(['SERVICE', 'USER'] as const)('prepares for %s through both hosts without an idempotency key', async kind => {
    const r = await prepare({ headers: { 'X-Factuez-Actor-Kind': kind } });
    expect(r.status).toBe(200); expect(r.body).toEqual(result()); expect(r.headers.etag).toBe(REVISION);
    expect(r.headers['cache-control']).toBe('private, no-store'); expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['idempotency-key']).toBeUndefined(); expect(r.headers['x-operation-id']).toBeUndefined();
    expect(core.prepare).toHaveBeenCalledExactlyOnceWith(TOKEN, kind, binding, id(10), REVISION);
    expect(transport.post).toHaveBeenCalledExactlyOnceWith(privatePath, { ...envelope(), kind }, TOKEN);
    expect(identity.authenticate).toHaveBeenCalledTimes(2);
    for (const call of identity.authenticate.mock.calls) expect(call).toEqual([TOKEN, required, kind]);
  });
  it('allows repeated preflights with no command or replay state', async () => {
    expect((await prepare()).body).toEqual((await prepare()).body);
    expect(core.prepare).toHaveBeenCalledTimes(2); expect(identity.authenticate).toHaveBeenCalledTimes(4);
  });
  it('requires If-Match with 428 before calling any owner', async () => {
    expect((await prepare({ headers: { 'If-Match': undefined } })).status).toBe(428);
    expect(identity.authenticate).not.toHaveBeenCalled(); expect(core.prepare).not.toHaveBeenCalled();
  });
  it.each(['W/"v2"', '*', '"v2", "v3"', 'v2', '"v0"', '"v1000000000"', ''])('rejects non-strong revision %s', async revision => {
    expect((await prepare({ headers: { 'If-Match': revision } })).status).toBe(400);
    expect(core.prepare).not.toHaveBeenCalled();
  });
  it.each([{}, { binding, body: {} }, { binding, key: 'synthetic-extra-key' }, { binding, kind: 'USER' }, { binding, ifMatch: REVISION }, []])('requires exact public body %j', async body => {
    expect((await prepare({ body })).status).toBe(400); expect(core.prepare).not.toHaveBeenCalled();
  });
  it.each(['?', '?ignored=1', '?binding=anything'])('rejects public and private query suffix %s', async suffix => {
    expect((await prepare({}, publicPath + suffix)).status).toBe(400);
    expect((await send('billing', privatePath + suffix, { body: envelope() })).status).toBe(400);
    expect(core.prepare).not.toHaveBeenCalled();
  });
  it.each(['authorization', 'x-factuez-actor-kind', 'if-match', 'idempotency-key', 'x-extra'])('rejects duplicate public header %s over HTTPS', async name => {
    const value = name === 'authorization' ? `Bearer ${TOKEN}` : name === 'x-factuez-actor-kind' ? 'SERVICE' : name === 'if-match' ? REVISION : 'duplicate';
    expect((await prepare({ headers: { [name]: [value, value] } })).status).toBe(name === 'authorization' || name === 'x-factuez-actor-kind' ? 401 : 400);
    expect(core.prepare).not.toHaveBeenCalled();
  });
  it.each(['billing', 'facade'] as const)('%s enforces trust and the certificate pin', async target => {
    const path = target === 'billing' ? privatePath : publicPath, body = target === 'billing' ? envelope() : { binding };
    await expect(send(target, path, { body, peer: null })).rejects.toThrow();
    await expect(send(target, path, { body, trust: false })).rejects.toThrow();
    const r = await send(target, path, { body, peer: 'other', headers: { 'X-Forwarded-Client-Cert': 'trusted', 'X-User-Role': 'ADMIN_GENERAL' } });
    expect(r.status).toBe(403); expect(r.body.code).toBe('PRIVATE_PEER_REQUIRED'); expect(core.prepare).not.toHaveBeenCalled();
  });
  it.each(['billing', 'facade'] as const)('%s checks pinned TLS and Bearer before touching a body getter', async target => {
    const getter = vi.fn(() => { throw new Error('BODY_MUST_NOT_BE_READ'); });
    const req: any = { headers: {}, socket: { encrypted: false } }, res: any = { setHeader: vi.fn() };
    Object.defineProperty(req, 'body', { get: getter });
    const invoke = () => target === 'billing' ? new BillingGuidePreparationController(core, [fingerprint(tls.resource)]).prepare(req, res)
      : new B2bGuidePreparationController(preparations, [fingerprint(tls.edge)]).prepare(req, res, id(10));
    await expect(invoke()).rejects.toMatchObject({ code: 'PRIVATE_PEER_REQUIRED' });
    req.socket = { encrypted: true, authorized: true, getPeerCertificate: () => ({ fingerprint256: fingerprint(tls[target === 'billing' ? 'resource' : 'edge']) }) };
    await expect(invoke()).rejects.toMatchObject({ code: 'INVALID_TOKEN' }); expect(getter).not.toHaveBeenCalled();
  });
  it.each([undefined, 'ADMIN', '', 'service'])('requires explicit actor kind %s', async kind => {
    expect((await prepare({ headers: { 'X-Factuez-Actor-Kind': kind } })).status).toBe(401);
    expect(identity.authenticate).not.toHaveBeenCalled();
  });
  it.each(['Basic synthetic', 'Bearer', 'Bearer a b', 'bearer token', 'Bearer a/b'])('rejects Bearer format %s on both hosts', async authorization => {
    for (const target of ['billing', 'facade'] as const) {
      expect((await send(target, target === 'billing' ? privatePath : publicPath, {
        body: target === 'billing' ? envelope() : { binding }, headers: { Authorization: authorization },
      })).status).toBe(401);
    }
    expect(core.prepare).not.toHaveBeenCalled();
  });
  it.each(['billing', 'facade'] as const)('%s bounds request bytes to 128 KiB and sanitizes JSON parser failures', async target => {
    const path = target === 'billing' ? privatePath : publicPath;
    for (const [raw, status] of [['{"SECRET_PARSER_DATA":', 400], [JSON.stringify({ binding, extra: 'x'.repeat(128 * 1024) }), 413]] as const) {
      const r = await send(target, path, { raw }); expect(r.status).toBe(status);
      expect(JSON.stringify(r.body)).not.toContain('SECRET_PARSER_DATA'); expect(r.headers['cache-control']).toBe('private, no-store');
    }
    expect(core.prepare).not.toHaveBeenCalled();
  });
  it.each(['kind', 'binding', 'id', 'ifMatch', 'extra'])('validates private envelope field %s', async key => {
    const body: any = envelope(); body[key] = key === 'extra' ? true : key === 'ifMatch' ? 'W/"v2"' : 'invalid';
    expect((await send('billing', privatePath, { body })).status).toBe(400); expect(core.prepare).not.toHaveBeenCalled();
  });
  it.each(['authorization', 'if-match', 'x-extra'])('rejects duplicate private header %s', async name => {
    const value = name === 'authorization' ? `Bearer ${TOKEN}` : REVISION;
    const r = await send('billing', privatePath, { body: envelope(), headers: { [name]: [value, value] } });
    expect(r.status).toBe(name === 'authorization' ? 401 : 400); expect(core.prepare).not.toHaveBeenCalled();
  });
  it.each(['guideSeriesId', 'guideType', 'issuerId', 'issuerRuc', 'branchId', 'pointId', 'seriesId', 'documentType', 'environment'])('rejects an invalid binding field %s', async field => {
    const pair: any = structuredClone(binding);
    if (field === 'guideSeriesId' || field === 'guideType') pair[field] = 'invalid';
    else pair.anchor[field] = 'invalid';
    expect((await prepare({ body: { binding: pair } })).status).toBe(400); expect(core.prepare).not.toHaveBeenCalled();
  });
  it('rejects malformed draft identifiers before owner access', async () => {
    expect((await prepare({}, '/b2b/v1/guide-drafts/invalid/preparation')).status).toBe(400);
    expect(core.prepare).not.toHaveBeenCalled();
  });
  it('checks exact anchor tuples instead of combining grants', async () => {
    identity.authenticate.mockImplementation(async (_token, _required, kind) => ({ ...principal(kind), bindings: [
      { ...binding.anchor, pointId: id(20) }, { ...binding.anchor, branchId: id(21) }, { ...binding.anchor, seriesId: id(22) },
    ] }));
    expect((await prepare()).status).toBe(404); expect(core.prepare).not.toHaveBeenCalled();
  });
  it.each(['kind', 'scope', 'revision', 'binding', 'subject', 'revoked'])('withholds a result after identity changes: %s', async change => {
    identity.authenticate.mockImplementationOnce(authenticate).mockImplementationOnce(async (_token, _scopes, kind) => {
      if (change === 'revoked') throw new B2bSecurityError(401, 'INVALID_TOKEN');
      const p = principal(kind);
      if (change === 'kind') p.kind = 'USER';
      if (change === 'scope') p.scopes = ['b2b:documents:read'];
      if (change === 'revision') p.revision++;
      if (change === 'binding') p.bindings = [{ ...binding.anchor, seriesId: id(30) }];
      if (change === 'subject') { p.kind = 'USER'; p.subjectId = id(31); p.userAuthRevision = 1; }
      return p;
    });
    const r = await prepare(); expect(r.status).toBe(401); expect(r.body.plan).toBeUndefined();
    expect(core.prepare).toHaveBeenCalledTimes(1); expect(identity.authenticate).toHaveBeenCalledTimes(2);
  });
  it('rejects an initial kind mismatch or missing read scope before the owner', async () => {
    identity.authenticate.mockImplementation(async () => principal('USER'));
    expect((await prepare()).status).toBe(401);
    identity.authenticate.mockImplementation(async () => ({ ...principal('SERVICE'), scopes: ['b2b:guides:read'] }));
    expect((await prepare()).status).toBe(401); expect(core.prepare).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404, 409, 412, 428, 429] as const)('preserves owner denial %s without returning a plan', async status => {
    core.prepare.mockRejectedValue(new B2bSecurityError(status, 'SYNTHETIC_OWNER_DENIED'));
    const r = await prepare(); expect(r.status).toBe(status); expect(r.body.plan).toBeUndefined();
    if (status === 429) expect(r.headers['retry-after']).toBe('60');
    if (status === 401) expect(r.headers['www-authenticate']).toBe('Bearer');
  });
  it.each([
    ['schema', (v: any) => { v.schemaVersion = 'unknown'; }],
    ['extra field', (v: any) => { v.xml = '<unsafe/>'; }],
    ['binding', (v: any) => { v.binding.guideSeriesId = id(50); }],
    ['anchor', (v: any) => { v.binding.anchor.branchId = id(50); }],
    ['guide type', (v: any) => { v.binding.guideType = '31'; }],
    ['candidate', (v: any) => { v.candidateOnly = false; }],
    ['execution', (v: any) => { v.fiscalExecutionEnabled = true; }],
    ['transmission', (v: any) => { v.transmissionAuthorized = true; }],
    ['transfer', (v: any) => { v.authorizedForTransfer = true; }],
    ['gates order', (v: any) => { v.gates.reverse(); }],
    ['missing gate', (v: any) => { v.gates.pop(); }],
    ['plan hash', (v: any) => { v.plan.planSha256 = '0'.repeat(64); }],
    ['body hash', (v: any) => { v.plan.body.grossWeight = '2'; }],
    ['nested flag', (v: any) => { v.plan.numberReserved = true; }],
    ['nested authority', (v: any) => { v.plan.authorizedForTransfer = true; }],
    ['plan profile', (v: any) => { v.plan.profile = 'unknown'; }],
    ['source id', (v: any) => { const i = input(); i.draftId = id(50); v.plan = prepareGuide09(i); }],
    ['source revision', (v: any) => { const i = input(); i.draftRevision = '"v3"'; v.plan = prepareGuide09(i); }],
    ['issuer RUC', (v: any) => { const i = input(); i.issuer.ruc = i.body.sender.ruc = i.body.recipient.ruc = '20000000010';
      i.draftBodySha256 = correctionEvidenceHash(i.body); v.plan = prepareGuide09(i); }],
  ] as const)('rejects inconsistent owner response: %s', async (_name, mutate) => {
    const v = result(); mutate(v); core.prepare.mockResolvedValue(v);
    const r = await prepare(); expect(r.status).toBe(503); expect(r.body.code).toBe('INCONSISTENT_OWNER_RESPONSE'); expect(r.body.plan).toBeUndefined();
  });
  it('validates canonical hashes regardless of JSON key order', async () => {
    const reverse = (v: any): any => Array.isArray(v) ? v.map(reverse) : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).reverse().map(([key, value]) => [key, reverse(value)])) : v;
    core.prepare.mockResolvedValue(reverse(result()));
    expect((await prepare()).status).toBe(200);
  });
  it('rejects oversized or executable owner responses without invoking hooks', async () => {
    const getter = vi.fn(() => { throw new Error('UNSAFE_GETTER'); });
    const v = result(); Object.defineProperty(v.plan, 'planSha256', { enumerable: true, get: getter });
    transport.post.mockResolvedValue(v);
    await expect(preparations.prepare(TOKEN, 'SERVICE', binding, id(10), REVISION)).rejects.toMatchObject({ status: 503 });
    expect(getter).not.toHaveBeenCalled();
    transport.post.mockResolvedValue({ ...result(), secret: 'x'.repeat(512 * 1024) });
    await expect(preparations.prepare(TOKEN, 'SERVICE', binding, id(10), REVISION)).rejects.toMatchObject({ status: 503 });
    core.prepare.mockResolvedValue({ ...result(), secret: 'x'.repeat(512 * 1024) });
    expect((await send('billing', privatePath, { body: envelope() })).status).toBe(503);
  });
  it('rejects unsafe bindings and proxies before property access', async () => {
    const getter = vi.fn(), trap = vi.fn();
    const unsafe = { ...binding }; Object.defineProperty(unsafe, 'anchor', { enumerable: true, get: getter });
    const proxy = new Proxy(binding, { get: trap });
    for (const value of [unsafe, proxy]) await expect(preparations.prepare(TOKEN, 'SERVICE', value, id(10), REVISION)).rejects.toMatchObject({ status: 400 });
    expect(getter).not.toHaveBeenCalled(); expect(trap).not.toHaveBeenCalled(); expect(core.prepare).not.toHaveBeenCalled();
  });
  it('sanitizes unexpected owner failures', async () => {
    core.prepare.mockRejectedValue(new Error('SECRET_DATABASE_CONNECTION'));
    const r = await prepare(); expect(r.status).toBe(503); expect(JSON.stringify(r.body)).not.toContain('SECRET_DATABASE_CONNECTION');
  });
  it('exposes no XML, signing, numbering, transfer or transport routes', async () => {
    for (const suffix of ['/xml', '/sign', '/reserve', '/transfer', '/send']) expect((await prepare({}, publicPath + suffix)).status).toBe(404);
    expect((await prepare({ method: 'GET', body: undefined })).status).toBe(404); expect(core.prepare).not.toHaveBeenCalled();
  });
  it('requires explicit unique certificate pins in both modules', () => {
    for (const peers of [[], ['invalid'], [fingerprint(tls.edge), fingerprint(tls.edge)], Array(101).fill('a'.repeat(64))]) {
      expect(() => BillingGuidePreparationModule.isolated(core, peers)).toThrow();
      expect(() => B2bGuidePreparationModule.isolated(preparations, peers)).toThrow();
    }
  });
  it.each([false, true])('actual candidate factory gates preparation POST and capability when configured=%s', async configured => {
    identity.authenticate.mockImplementation(async (token, scopes, kind) => ({
      ...await authenticate(token, scopes, kind), scopes: [...required, 'b2b:context:read'],
    }));
    const reads = new B2bReads(identity, {} as never, {} as never);
    const app = await createB2bDraftApplication(reads, { issuanceConfigured: false } as never,
      [fingerprint(tls.edge)], { ca: tls.ca, cert: tls.server, key: tls.key },
      undefined, undefined, undefined, undefined, undefined, configured ? preparations : undefined);
    try {
      await app.listen(0, '127.0.0.1');
      const port = (app.getHttpServer().address() as AddressInfo).port;
      const r = await prepare({ port });
      expect(r.status).toBe(configured ? 200 : 400);
      expect(core.prepare).toHaveBeenCalledTimes(configured ? 1 : 0);
      expect(transport.post).toHaveBeenCalledTimes(configured ? 1 : 0);
      expect(identity.authenticate).toHaveBeenCalledTimes(configured ? 2 : 0);
      if (configured) {
        expect(r.body).toEqual(result()); expect(r.headers.etag).toBe(REVISION);
        expect(r.body.gates).toEqual(GATES); expect(r.body.authorizedForTransfer).toBe(false);
      } else expect(r.body.code).toBe('DRAFT_COMMANDS_ONLY');
      const caps = await send('facade', '/b2b/v1/capabilities?environment=BETA', { port, method: 'GET' });
      expect(caps.status).toBe(200); expect(caps.body.fiscalActivation).toBe(false);
      const feature = caps.body.features.filter((f: { id: string }) => f.id === 'guide-preparation');
      expect(feature).toHaveLength(configured ? 1 : 0);
      if (configured) expect(feature[0].state).toBe('ENABLED');
    } finally { await app.close(); }
  });
});
