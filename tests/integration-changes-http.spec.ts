import 'reflect-metadata';
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomUUID, X509Certificate } from 'node:crypto';
import { request } from 'node:https';
import { NestFactory } from '../services/integration-export-service/node_modules/@nestjs/core';
import type { NestExpressApplication } from '../services/integration-export-service/node_modules/@nestjs/platform-express';
import { PrivateReadFilter, privateReadBoundary } from '../packages/service-access/src/integration-http';
import { deny, PrivateReadHttp, RemoteReadIdentity, type ReadPrincipal } from '../packages/service-access/src/integration';
import { OwnerChanges } from '../packages/service-access/src/integration-owner-changes';
import type { JournalPosition } from '../packages/service-access/src/integration-journal';
import { IntegrationIdentityModule, IntegrationErrorFilter } from '../services/identity-service/src/integration/http';
import { BillingReadModule, billingCapturePostPaths } from '../services/billing-service/src/integration/http';
import { BillingCapture } from '../services/billing-service/src/integration/capture';
import { BillingRead } from '../services/billing-service/src/integration/read';
import { SunatReadModule } from '../services/sunat-service/src/integration/http';
import { SunatRead, RemoteBillingOwner } from '../services/sunat-service/src/integration/read';
import { IntegrationReadModule } from '../services/integration-service/src/http';
import { IntegrationReads } from '../services/integration-service/src/read';
import { IntegrationExports } from '../services/integration-export-service/src/core';
import { IntegrationChanges } from '../services/integration-export-service/src/changes';
import { IntegrationExportModule, exportPostPaths } from '../services/integration-export-service/src/http';
import { changesFixture } from './integration-changes.fixture';
import { fixture, basic, ctx } from './integration-identity.fixture';
import { issuerRuc, documentId, secondId, batchId, summaryId, branchId } from './integration-read.fixture';

const forge = createRequire(resolve('packages/evidence-core/package.json'))('node-forge');
function certificates() {
  const pki = forge.pki, root = pki.rsa.generateKeyPair(2048), pair = pki.rsa.generateKeyPair(2048), ca = pki.createCertificate();
  ca.publicKey = root.publicKey; ca.serialNumber = '01';
  ca.validity.notBefore = new Date(Date.now() - 60000); ca.validity.notAfter = new Date(Date.now() + 3600000);
  ca.setSubject([{ name: 'commonName', value: 'Fictitious changes CA' }]); ca.setIssuer(ca.subject.attributes);
  ca.setExtensions([{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true }]);
  ca.sign(root.privateKey, forge.md.sha256.create());
  const leaf = (serial: string, server = false) => {
    const c = pki.createCertificate(); c.publicKey = pair.publicKey; c.serialNumber = serial; c.validity = ca.validity;
    c.setSubject([{ name: 'commonName', value: server ? 'localhost' : 'fictitious-' + serial }]); c.setIssuer(ca.subject.attributes);
    c.setExtensions([{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: server, clientAuth: !server },
      ...(server ? [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] }] : [])]);
    c.sign(root.privateKey, forge.md.sha256.create()); return Buffer.from(pki.certificateToPem(c));
  };
  return { ca: Buffer.from(pki.certificateToPem(ca)), key: Buffer.from(pki.privateKeyToPem(pair.privateKey)),
    server: leaf('02', true), client: leaf('03'), resource: leaf('04'), rejected: leaf('05') };
}

describe('Phase6 actual five-service HTTPS/mTLS changes pipeline with fictitious repositories', () => {
  type Source = 'BILLING' | 'SUNAT';
  const sources: Source[] = ['BILLING', 'SUNAT'];
  const f = changesFixture(), id = fixture(), apps: NestExpressApplication[] = [];
  const initial = { rows: structuredClone(f.rows), docs: structuredClone(f.docs),
    batches: structuredClone(f.batches), summaries: structuredClone(f.summaries) };
  let tls: ReturnType<typeof certificates>, origin: string, token: string, core: IntegrationExports;
  let identity: RemoteReadIdentity, billing: PrivateReadHttp, sunat: PrivateReadHttp;
  let made: Awaited<ReturnType<typeof id.core.create>>, captureHook: (() => void) | undefined;
  const fp = (b: Buffer) => new X509Certificate(b).fingerprint256.replace(/:/g, '').toLowerCase();
  const journalRepository = (source: Source) => ({
    read: vi.fn(async (ruc: string, after: JournalPosition | null, limit = 500) => {
      if (ruc !== issuerRuc) return deny(404, 'RESOURCE_NOT_FOUND');
      const s = f.journals[source];
      if (after && (after.epoch !== s.epoch || BigInt(after.sequence) < s.floor || BigInt(after.sequence) > s.head))
        return deny(410, 'CURSOR_EXPIRED');
      const events = after === null ? [] : s.events.filter(e => BigInt(e.sequence) > BigInt(after.sequence)).slice(0, limit);
      return { epoch: s.epoch, head: s.head.toString(), floor: s.floor.toString(),
        position: { epoch: s.epoch, sequence: events.at(-1)?.sequence ?? after?.sequence ?? s.head.toString() },
        events: structuredClone(events) };
    }),
  });
  const journals = { BILLING: journalRepository('BILLING'), SUNAT: journalRepository('SUNAT') };
  const captureRepository = {
    capture: vi.fn(async (filters: any, principal: ReadPrincipal) => {
      const rows = structuredClone([...f.rows.values()].filter(r => r.type !== 'DRAFT' && filters.types.includes(r.immutableSnapshot.documentTypeCode)));
      const captured = Object.assign(rows, { changeBarrier: { epoch: f.journals.BILLING.epoch, sequence: f.journals.BILLING.head.toString() },
        snapshotAt: new Date(f.now()).toISOString() });
      captureHook?.(); return captured;
    }),
    reauthorize: vi.fn(async (ruc: string, ids: string[]) => ruc === issuerRuc ?
      structuredClone(ids.map(key => f.rows.get(key)).filter(Boolean)) : []),
  };
  async function start(module: any, posts: Record<string, number> = {}, isIdentity = false) {
    const app = await NestFactory.create<NestExpressApplication>(module, { logger: false, bodyParser: false,
      httpsOptions: { cert: tls.server, key: tls.key, ca: tls.ca, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' } });
    apps.push(app);
    if (isIdentity) { app.useBodyParser('json', { limit: '32kb', strict: true }); app.useGlobalFilters(new IntegrationErrorFilter()); }
    else {
      app.use(privateReadBoundary(posts));
      if (Object.keys(posts).length) app.useBodyParser('json', { limit: '4mb', strict: true });
      app.useGlobalFilters(new PrivateReadFilter());
    }
    await app.listen(0, '127.0.0.1'); return 'https://127.0.0.1:' + app.getHttpServer().address().port;
  }
  async function client(scopes = f.p.scopes, grants = f.p.grants) {
    const created = await id.core.create('human-fixture', { label: 'ERP fictitious changes', scopes, grants }, ctx());
    const bearer = (await id.core.token(basic(created.client.id, created.clientSecret),
      { grant_type: 'client_credentials', scope: scopes.join(' ') }, ctx())).access_token;
    return { made: created, token: bearer };
  }
  beforeAll(async () => {
    tls = certificates();
    const identityOrigin = await start(IntegrationIdentityModule.isolated(id.core,
      { token: [fp(tls.client)], admin: [fp(tls.resource)], resource: [fp(tls.resource)] }), {}, true);
    const transport = { ca: tls.ca, cert: tls.resource, key: tls.key };
    identity = new RemoteReadIdentity(new PrivateReadHttp(identityOrigin, transport));
    const billingOrigin = await start(BillingReadModule.isolated(new BillingRead(f.billingRepo, identity), [fp(tls.resource)],
      new BillingCapture(captureRepository, identity, f.now), new OwnerChanges(journals.BILLING, identity)), billingCapturePostPaths);
    billing = new PrivateReadHttp(billingOrigin, transport);
    // Only fictitious in-memory bytes; no runtime fiscal filesystem or SUNAT connection.
    const sunatOrigin = await start(SunatReadModule.isolated(new SunatRead(f.sunatRepo, identity,
      new RemoteBillingOwner(billing), { read: async () => Buffer.from(f.bytes) }), [fp(tls.resource)], new OwnerChanges(journals.SUNAT, identity)));
    sunat = new PrivateReadHttp(sunatOrigin, transport);
    const feed = new IntegrationChanges(f.changeStore, f.vault, identity, billing, sunat, f.now);
    core = new IntegrationExports(f.store, f.vault, identity, billing, sunat, f.now, feed);
    const exportOrigin = await start(IntegrationExportModule.isolated(core, identity, billing, [fp(tls.resource)]), exportPostPaths);
    origin = await start(IntegrationReadModule.isolated(new IntegrationReads(identity, billing, sunat, f.now,
      new PrivateReadHttp(exportOrigin, transport)), [fp(tls.client)]), { '/integration/v1/exports': 16384 });
  }, 30000);
  function restore<T>(target: Map<string, T>, baseline: Map<string, T>) {
    target.clear(); for (const [key, value] of baseline) target.set(key, structuredClone(value));
  }
  beforeEach(async () => {
    vi.restoreAllMocks(); captureHook = undefined;
    restore(f.rows, initial.rows); restore(f.docs, initial.docs); restore(f.batches, initial.batches); restore(f.summaries, initial.summaries);
    for (const source of sources) {
      Object.assign(f.journals[source], { epoch: randomUUID(), head: 0n, floor: 0n, events: [] }); journals[source].read.mockClear();
    }
    f.store.records.clear(); f.store.leases.clear(); f.store.events.length = 0;
    f.changeStore.records.clear(); f.changeStore.audit.mockReset(); f.changeStore.audit.mockImplementation(async () => {});
    captureRepository.capture.mockClear(); captureRepository.reauthorize.mockClear(); f.identity.authenticate.mockClear();
    ({ made, token } = await client());
  });
  afterAll(async () => { for (const app of [...apps].reverse()) await app.close(); }, 30000);
  function send(path: string, options: { method?: string; body?: unknown; bearer?: string | null; peer?: 'client' | 'rejected' | null } = {}) {
    return new Promise<{ status: number; body: any; bytes: Buffer; headers: any }>((resolveResult, reject) => {
      const data = options.body === undefined ? undefined : JSON.stringify(options.body), peer = options.peer === undefined ? 'client' : options.peer;
      const req = request(origin + path, { method: options.method ?? 'GET', ca: tls.ca, rejectUnauthorized: true,
        ...(peer ? { cert: tls[peer], key: tls.key } : {}), timeout: 15000,
        headers: { ...(options.bearer === null ? {} : { Authorization: 'Bearer ' + (options.bearer ?? token) }),
          ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }) } }, res => {
        const chunks: Buffer[] = []; res.on('data', c => chunks.push(c)); res.on('error', reject);
        res.on('end', () => {
          const bytes = Buffer.concat(chunks); let body: any;
          try { body = JSON.parse(bytes.toString()); } catch {}
          resolveResult({ status: res.statusCode!, body, bytes, headers: res.headers });
        });
      });
      req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Fixture request timeout'))); req.end(data);
    });
  }
  const listQuery = `issuerRuc=${issuerRuc}&from=2026-01-01&to=2026-01-01&types=01,03&limit=1`;
  const path = (checkpoint: string, limit = '100') => '/integration/v1/changes?' + new URLSearchParams({ issuerRuc, checkpoint, limit });
  async function checkpoint(query = listQuery, bearer = token): Promise<string> {
    const r = await send('/integration/v1/documents?' + query, { bearer });
    expect(r.status).toBe(200); expect(r.body.page.changeCheckpoint).toMatch(/^[A-Za-z0-9_-]{16,4096}$/);
    return r.body.page.changeCheckpoint;
  }
  function noData(r: { body: any }) { expect(r.body).not.toHaveProperty('items'); expect(r.body).not.toHaveProperty('nextCheckpoint'); }

  it('reports READY only after both real owner journal endpoints authorize readiness', async () => {
    const r = await send(`/integration/v1/capabilities?issuerRuc=${issuerRuc}`);
    expect(apps).toHaveLength(5); expect(r.status).toBe(200);
    expect(r.body.consistency).toBe('SNAPSHOT_READY'); expect(r.body.changes).toBe('READY');
    for (const source of sources) expect(journals[source].read).toHaveBeenCalledWith(issuerRuc, null, 1);
    expect(f.identity.authenticate).not.toHaveBeenCalled();
  });

  it('never advertises READY when either source journal is unavailable', async () => {
    for (const source of sources) {
      journals[source].read.mockRejectedValueOnce(new Error('fictitious owner unavailable'));
      const r = await send(`/integration/v1/capabilities?issuerRuc=${issuerRuc}`);
      expect(r.status).toBe(503); expect(r.body.changes).not.toBe('READY');
      expect(r.bytes.toString()).not.toContain('fictitious owner unavailable');
    }
    expect((await send(`/integration/v1/capabilities?issuerRuc=${issuerRuc}`)).body.changes).toBe('READY');
  });

  it('links every snapshot page to the same checkpoint and the actual remote client principal', async () => {
    const first = await send('/integration/v1/documents?' + listQuery);
    expect(first.status).toBe(200); expect(first.body.items[0].id).toBe(documentId);
    const next = await send('/integration/v1/documents?' + listQuery + '&cursor=' + first.body.page.nextCursor);
    expect(next.status).toBe(200); expect(next.body.items[0].id).toBe(secondId);
    expect(next.body.page.snapshotId).toBe(first.body.page.snapshotId);
    expect(next.body.page.changeCheckpoint).toBe(first.body.page.changeCheckpoint);
    const cp = f.vault.openJson<any>(Buffer.from(first.body.page.changeCheckpoint, 'base64url'), 'factuez.changes.checkpoint.v1');
    const principal = await identity.authenticate(token, ['integration:documents:read', 'integration:changes:read']);
    expect(principal.clientId).toBe(made.client.id); expect(principal.clientId).not.toBe(f.p.clientId);
    expect(cp.clientId).toBe(principal.clientId); expect(captureRepository.capture.mock.calls[0][1].clientId).toBe(principal.clientId);
    expect(cp.positions).toEqual({ BILLING: { epoch: f.journals.BILLING.epoch, sequence: '0' }, SUNAT: { epoch: f.journals.SUNAT.epoch, sequence: '0' } });
    expect(first.body.page.snapshotAt).toBe(new Date(f.now()).toISOString());
  });

  it('delivers post-cut appends from Billing and SUNAT through the public feed proxy', async () => {
    f.append('BILLING'); f.append('SUNAT'); const cp = await checkpoint();
    const b = f.append('BILLING', 'DOCUMENT_CREATED'), s = f.append('SUNAT', 'ARTIFACT_ADDED', secondId);
    const r = await send(path(cp)); expect(r.status).toBe(200); expect(r.body.hasMore).toBe(false);
    expect(r.body.items.map((e: any) => [e.documentId, e.kind, e.sequence])).toEqual([
      [documentId, 'DOCUMENT_CREATED', '1'], [secondId, 'ARTIFACT_ADDED', '2'],
    ]);
    expect(new Set(r.body.items.map((e: any) => e.eventId)).size).toBe(2);
    for (const e of r.body.items) { expect(e.version).toMatch(/^[a-f0-9]{64}$/); expect(e.resource.issuerRuc).toBe(issuerRuc); }
    expect(r.bytes.toString()).not.toContain(b.id); expect(r.bytes.toString()).not.toContain(s.id);
    expect(r.headers['cache-control']).toBe('private, no-store'); expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers).not.toHaveProperty('access-control-allow-origin');
    expect((await send(path(r.body.nextCheckpoint))).body.items).toEqual([]);
  });

  it('keeps the SUNAT lower bound before Billing capture so an overlapping append is delivered', async () => {
    f.append('BILLING'); captureHook = () => { f.append('SUNAT', 'DOCUMENT_RECONCILED'); };
    const cp = await checkpoint(); captureHook = undefined;
    const r = await send(path(cp)); expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1); expect(r.body.items[0]).toMatchObject({ documentId, kind: 'DOCUMENT_RECONCILED', sequence: '1' });
  });

  it('replays a durable nonempty page after recreating the core even when current row state changes', async () => {
    const cp = await checkpoint(); f.append('BILLING');
    const first = await send(path(cp)); expect(first.status).toBe(200); expect(first.body.items).toHaveLength(1);
    expect(f.changeStore.records.size).toBe(1); expect([...f.changeStore.records.values()][0].clientId).toBe(made.client.id);
    const row = f.rows.get(documentId)!; row.status = 'CANCELLED'; row.updatedAt = new Date(f.now()); f.append('BILLING');
    const current = await send(`/integration/v1/documents/${documentId}?issuerRuc=${issuerRuc}`);
    expect(current.status).toBe(200); expect(current.body.resourceVersion).not.toBe(first.body.items[0].version);
    const restarted = new IntegrationExports(f.store, f.vault, identity, billing, sunat, f.now,
      new IntegrationChanges(f.changeStore, f.vault, identity, billing, sunat, f.now));
    const delegate = vi.spyOn(core, 'changes').mockImplementationOnce((bearer, query) => restarted.changes(bearer, query));
    const retry = await send(path(cp)); delegate.mockRestore();
    expect(retry.status).toBe(200); expect(retry.bytes.equals(first.bytes)).toBe(true); expect(f.changeStore.records.size).toBe(1);
    const next = await send(path(first.body.nextCheckpoint)); expect(next.status).toBe(200);
    expect(next.body.items[0]).toMatchObject({ documentId, sequence: '2', version: current.body.resourceVersion });
    expect(next.body.items[0].eventId).not.toBe(first.body.items[0].eventId);
  });

  it('returns an empty advancing checkpoint without storing a delivery and later sees a new append', async () => {
    const cp = await checkpoint(), empty = await send(path(cp));
    expect(empty.status).toBe(200); expect(empty.body.items).toEqual([]); expect(empty.body.hasMore).toBe(false);
    expect(empty.body.nextCheckpoint).not.toBe(cp); expect(f.changeStore.records.size).toBe(0);
    f.append('SUNAT'); const next = await send(path(empty.body.nextCheckpoint));
    expect(next.status).toBe(200); expect(next.body.items).toHaveLength(1); expect(next.body.items[0].sequence).toBe('1');
  });

  it('rejects malformed checkpoints, limits and attempts to broaden checkpoint filters', async () => {
    const cp = await checkpoint();
    const invalid = ['/integration/v1/changes', `/integration/v1/changes?issuerRuc=${issuerRuc}`,
      path('short'), path('a'.repeat(64)), ...['0', '501', '1e2', '01', ''].map(limit => path(cp, limit)),
      path(cp) + '&from=2026-01-01', path(cp) + '&environment=PRODUCTION'];
    for (const query of invalid) {
      const r = await send(query); expect(r.status, query).toBe(400); expect(r.body.error.code).toBe('INVALID_QUERY'); noData(r);
    }
    expect(f.changeStore.records.size).toBe(0);
  });

  it('rejects duplicate issuer, checkpoint and limit query parameters', async () => {
    const cp = await checkpoint();
    for (const duplicate of [`issuerRuc=${issuerRuc}`, 'checkpoint=' + cp, 'limit=1']) {
      const r = await send(path(cp) + '&' + duplicate); expect(r.status).toBe(400); expect(r.body.error.code).toBe('INVALID_QUERY'); noData(r);
    }
  });

  it('rejects a body on GET and POST to the changes endpoint', async () => {
    const cp = await checkpoint();
    for (const method of ['GET', 'POST']) {
      const r = await send(path(cp), { method, body: { emit: true } });
      expect(r.status).toBe(400); expect(r.body.error.code).toBe('INVALID_REQUEST'); noData(r);
    }
    expect(f.changeStore.records.size).toBe(0);
  });

  it('requires a client certificate and rejects a CA-signed peer outside the allowlist', async () => {
    const cp = await checkpoint(), denied = await send(path(cp), { peer: 'rejected' });
    expect(denied.status).toBe(403); noData(denied);
    await expect(send(path(cp), { peer: null })).rejects.toThrow(); expect(f.changeStore.records.size).toBe(0);
  });

  it('rejects missing, human and fabricated bearer credentials with the M2M challenge', async () => {
    const cp = await checkpoint();
    for (const bearer of [null, 'human-fixture', 'bogus']) {
      const r = await send(path(cp), { bearer }); expect(r.status).toBe(401);
      expect(r.headers['www-authenticate']).toBe('Bearer realm="factuez-integration"'); noData(r);
    }
    expect(f.changeStore.records.size).toBe(0);
  });

  it('denies an actual M2M token missing the changes scope', async () => {
    const cp = await checkpoint(), scopes = f.p.scopes.filter(s => s !== 'integration:changes:read');
    const limited = (await id.core.token(basic(made.client.id, made.clientSecret),
      { grant_type: 'client_credentials', scope: scopes.join(' ') }, ctx())).access_token;
    const r = await send(path(cp), { bearer: limited }); expect(r.status).toBe(403); expect(r.body.error.code).toBe('INSUFFICIENT_SCOPE'); noData(r);
    expect(f.changeStore.records.size).toBe(0);
  });

  it('returns 410 for a cached delivery after either owner epoch changes', async () => {
    const cp = await checkpoint(); f.append('BILLING'); const first = await send(path(cp));
    expect(first.status).toBe(200); expect(first.body.items).toHaveLength(1);
    for (const source of sources) {
      const epoch = f.journals[source].epoch; f.journals[source].epoch = randomUUID();
      try { const r = await send(path(cp)); expect(r.status).toBe(410); expect(r.body.error.code).toBe('CURSOR_EXPIRED'); noData(r); }
      finally { f.journals[source].epoch = epoch; }
    }
    const retry = await send(path(cp)); expect(retry.status).toBe(200); expect(retry.bytes.equals(first.bytes)).toBe(true);
  });

  it('expires a cached delivery when its source position falls below the retention floor', async () => {
    const cp = await checkpoint(); f.append('BILLING'); expect((await send(path(cp))).body.items).toHaveLength(1);
    f.append('BILLING'); f.journals.BILLING.floor = f.journals.BILLING.head;
    const r = await send(path(cp)); expect(r.status).toBe(410); expect(r.body.error.code).toBe('CURSOR_EXPIRED'); noData(r);
    expect(f.changeStore.records.size).toBe(1);
  });

  it('exposes no batch data when any member is unauthorized, even outside the cut type filter', async () => {
    const blocked = structuredClone(f.rows.get(secondId)!), blockedId = randomUUID(), blockedBranch = randomUUID();
    blocked.id = blockedId; blocked.immutableSnapshot.documentId = blockedId;
    blocked.immutableSnapshot.branchId = blockedBranch; blocked.emissionPoint.branchId = blockedBranch; f.rows.set(blockedId, blocked);
    const batch = f.batches.get(batchId)!;
    batch.immutablePayload = { environment: 'BETA', issuer: { identityNumber: issuerRuc }, identifier: batch.identifier, kind: 'RC',
      input: { kind: 'RC', entries: [f.rows.get(secondId)!, blocked].map(row => ({ document: { snapshot: structuredClone(row.immutableSnapshot) }, conditionCode: '1' })) } };
    f.summaries.set(summaryId, { identifier: batch.identifier, items: [secondId, blockedId].map(id => ({ documentId: id, conditionCode: '1' })) });
    const restricted = await client(f.p.scopes, [{ ...f.p.grants[0], branches: { kind: 'IDS', ids: [branchId] } }]);
    const cp = await checkpoint(listQuery.replace('types=01,03', 'types=01'), restricted.token);
    f.append('SUNAT', 'DOCUMENT_STATE_CHANGED', batchId, 'BATCH');
    await expect(sunat.json(`/internal/integration/batches/${batchId}?issuerRuc=${issuerRuc}`, restricted.token)).rejects.toMatchObject({ status: 404 });
    const r = await send(path(cp), { bearer: restricted.token }); expect(r.status).toBe(200); expect(r.body.items).toEqual([]);
    for (const secret of [batchId, summaryId, secondId, blockedId, blockedBranch]) expect(r.bytes.toString()).not.toContain(secret);
    expect(f.changeStore.records.size).toBe(0);
  });

  it('sanitizes audit failures before fresh or cached delivery data can reach HTTP', async () => {
    const cp = await checkpoint(); f.append('BILLING');
    for (const stage of ['fresh', 'cached']) {
      f.changeStore.audit.mockRejectedValueOnce(new Error('sensitive-password-fake ' + token));
      const r = await send(path(cp)); expect(r.status, stage).toBe(503); expect(r.body.error.code).toBe('UPSTREAM_UNAVAILABLE');
      expect(r.body.error.retryable).toBe(true); noData(r);
      for (const secret of ['sensitive-password', token, documentId, 'Error:', 'stack']) expect(r.bytes.toString()).not.toContain(secret);
      const retry = await send(path(cp)); expect(retry.status).toBe(200); expect(retry.body.items).toHaveLength(1);
    }
    expect(f.changeStore.records.size).toBe(1);
  });

  it('invalidates cached delivery immediately after permissions change in the actual identity core', async () => {
    const cp = await checkpoint(); f.append('BILLING'); expect((await send(path(cp))).body.items).toHaveLength(1);
    const scopes = f.p.scopes.filter(s => s !== 'integration:changes:read');
    await id.core.change('human-fixture', made.client.id, { expectedRevision: 1, scopes }, ctx(), false);
    const stale = await send(path(cp)); expect(stale.status).toBe(401); noData(stale);
    const current = (await id.core.token(basic(made.client.id, made.clientSecret),
      { grant_type: 'client_credentials', scope: scopes.join(' ') }, ctx())).access_token;
    const denied = await send(path(cp), { bearer: current }); expect(denied.status).toBe(403); noData(denied);
    expect(f.changeStore.records.size).toBe(1);
  });

  it('denies cached delivery immediately when the actual identity core disables the client', async () => {
    const cp = await checkpoint(); f.append('BILLING'); expect((await send(path(cp))).body.items).toHaveLength(1);
    await id.core.change('human-fixture', made.client.id, { expectedRevision: 1, enabled: false }, ctx(), false);
    const r = await send(path(cp)); expect(r.status).toBe(401); noData(r); expect(f.changeStore.records.size).toBe(1);
  });

  it('does not expose another actual client\'s checkpoint or cached delivery', async () => {
    const cp = await checkpoint(); f.append('BILLING'); expect((await send(path(cp))).body.items).toHaveLength(1);
    const other = await client(), r = await send(path(cp), { bearer: other.token });
    expect(r.status).toBe(404); expect(r.body.error.code).toBe('RESOURCE_NOT_FOUND'); noData(r);
    expect(f.changeStore.records.size).toBe(1); expect([...f.changeStore.records.values()][0].clientId).toBe(made.client.id);
  });
});
