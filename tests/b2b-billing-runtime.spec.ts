import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { B2bOwnerDrain } from '../packages/service-access/src/b2b-owner-drain';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createBillingB2bRuntime, type BillingB2bRuntimeDependencies } from '../services/billing-service/src/b2b/runtime';
import { BatchCreditHistoryVersionBridge } from '../services/billing-service/src/b2b/batch-credit-history-version-bridge';
import { createBillingB2bRuntimeApplication } from '../services/billing-service/src/b2b/runtime-http';
import { BillingRuntimeLifecycle } from '../services/billing-service/src/b2b/runtime-lifecycle';
import { billingRuntimeStorageSql } from '../services/billing-service/src/b2b/runtime-storage';
import { B2bCorrectionProducer } from '../services/billing-service/src/b2b/correction-producer';
import { PrismaB2bContextRepository } from '../services/billing-service/src/b2b/context';
import { B2bBillingReads } from '../services/billing-service/src/b2b/read';
import { b2bCertificates, fingerprint } from './b2b-tls.fixture';
import { b2bReadFixture, invoiceBinding as originalInvoiceBinding } from './b2b-read.fixture';

import { draftFixture } from './b2b-drafts.fixture';
import { GUIDE_RUC } from './helpers/b2b-guide.fixture';
const invoiceBinding = { ...originalInvoiceBinding, issuerRuc: GUIDE_RUC };
const expectedCapabilities = ['READ','DRAFTS','COMMERCIAL','CORRECTIONS','GUIDES','CARRIER','BATCHES','BUSINESS','REPORTS','PRIVILEGED_ADMIN'].sort();
let tls: ReturnType<typeof b2bCertificates>;
let applications: NestExpressApplication[] = [];
const cleanups: (() => unknown)[] = [];
beforeAll(() => { tls = b2bCertificates(); }, 30000);
afterEach(async () => { for (const app of applications) await app.close(); applications = []; });
afterAll(async () => { for (const close of cleanups) await close(); });
const deny = async (): Promise<never> => { throw Error('SYNTHETIC_UNCONFIGURED_CAPABILITY'); };
function defer() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

/** Explicit synthetic DB transport; exercises concrete owner assemblies, not PostgreSQL persistence.
 * Unconfigured owner SQL/crypto/admin operations reject. Nothing here certifies fiscal acceptance. */
async function dependencies() {
  const fixture = await b2bReadFixture([invoiceBinding, { ...invoiceBinding, documentType: '03', seriesId: '30000000-0000-4000-8000-000000000002' }]); cleanups.push(fixture.close);
  const sql: string[] = [], pgSql: string[] = [];
  const queryRaw = vi.fn(async (statement: string) => {
    sql.push(statement);
    if (/^SELECT\b[\s\S]*WHERE false$/.test(statement)) return [];
    throw Error('SYNTHETIC_SQL_UNCONFIGURED');
  });
  const executeRaw = vi.fn(async () => 0);
  const prisma: any = {
    $queryRawUnsafe: queryRaw, $executeRawUnsafe: executeRaw,
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(prisma)),
    seriesCounter: {
      findFirst: vi.fn(async ({ where }: any) => {
        const binding = [invoiceBinding, { ...invoiceBinding, documentType: '03', seriesId: '30000000-0000-4000-8000-000000000002' }]
          .find(b => b.seriesId === where.id);
        if (!binding) return null;
        const value = (await fixture.repository.contexts([binding as typeof invoiceBinding]))[0];
        return { id: binding.seriesId, series: value.series.label, company: { ...value.issuer, ruc: binding.issuerRuc },
          emissionPoint: { ...value.point, branch: value.branch } };
      }),
      findMany: vi.fn(async () => []),
    },
    fuelProduct: { findMany: fixture.repository.products },
  };
  const pool = () => {
    const query = vi.fn(async (statement: string) => { pgSql.push(statement); return { rows: [], rowCount: 0 }; });
    const release = vi.fn();
    return { connect: vi.fn(async () => ({ query, release })), end: vi.fn(async () => {}), query, release };
  };
  const masters = Object.fromEntries(['catalog','createIssuer','updateIssuer','createBranch','updateBranch','createPoint','updatePoint','createSeries','updateSeries'].map(name => [name, vi.fn(deny)]));
  const branding = { ...fixture.printing, settings: vi.fn(deny), save: vi.fn(deny), preview: vi.fn(deny) };
  const resource = [fingerprint(tls.resource)], ownerTls = { ca: tls.ca, cert: tls.server, key: tls.key };
  const businessPool = pool(), reportsPool = pool(), batchPool = pool();
  const legacyLifecycle = { ADMISSION: vi.fn(async () => {}), PRODUCERS: vi.fn(async () => {}), WORKERS: vi.fn(async () => {}), STORAGE: vi.fn(async () => {}) };
  const correctionBinding = { reference: invoiceBinding, noteType: '07' as const, noteSeriesId: randomUUID() };
  const deps: BillingB2bRuntimeDependencies = {
    prisma, issueDocument: { executeWithinTransaction: vi.fn(deny) } as any,
    stationAdmin: masters as any, printBranding: branding as any,
    identity: fixture.identity, identityHttp: { post: vi.fn(deny) }, fiscalHttp: { post: vi.fn(deny) },
    allowedRucs: [invoiceBinding.issuerRuc], deploymentId: randomUUID(), instanceId: randomUUID(),
    peers: { callers: resource, registrar: resource, administrators: resource, status: resource, evidence: resource },
    tls: ownerTls, maintenance: { enabled: true, operatorPeers: [fingerprint(tls.edge)], tls: ownerTls }, legacyLifecycle, ownerDrain: new B2bOwnerDrain({enabled:true}),
    establishmentAdmin: { verify: vi.fn(deny) }, carrierReferenceValidator: { verify: vi.fn(deny) },
    business: { pool: businessPool, permissions: { authorizeCurrent: vi.fn(deny) } },
    batches: { pool: batchPool, evidence: { verifySignedVersion: vi.fn(deny) }, memberIdentity: { current: vi.fn(deny) }, policyAdmin: { authorizeStepUp: vi.fn(deny) } },
    reports: { pool: reportsPool, guideMetadata: { origin: 'https://127.0.0.1:1', tls: { ca: tls.ca, cert: tls.resource, key: tls.key } },
      corrections: { bindings: [correctionBinding], authority: { current: vi.fn(deny) } },
      guides: { bindings: [{ draft: { anchor: invoiceBinding, guideType: '09', guideSeriesId: randomUUID() }, fiscalSeriesId: randomUUID() }] } },
    privilegedAdmin: { authority: { authorize: vi.fn(deny) }, liveIdentity: { current: vi.fn(deny) } },
  };
  return { deps, fixture, prisma, sql, pgSql, businessPool, reportsPool, batchPool, legacyLifecycle, correctionBinding };
}
async function start(configure?: (f: Awaited<ReturnType<typeof dependencies>>) => void) {
  const f = await dependencies(); configure?.(f);
  const runtime = createBillingB2bRuntime(f.deps);
  const app = await createBillingB2bRuntimeApplication(runtime); applications.push(app);
  await app.listen(0, '127.0.0.1');
  return { ...f, runtime, app, port: app.getHttpServer().address().port as number };
}
function send(port: number, path: string, body: unknown, token?: string, peer: 'resource'|'edge'|'other'|null = 'resource', method = 'POST') {
  const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise<{ status: number; body: any; headers: any }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, agent: false, ca: tls.ca,
      ...(peer ? { cert: tls[peer], key: tls.key } : {}), rejectUnauthorized: true, timeout: 10000,
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) } }, res => {
      const chunks: Buffer[] = []; res.on('data', b => chunks.push(b)); res.on('error', reject);
      res.on('end', () => { try { resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()), headers: res.headers }); } catch (error) { reject(error); } });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(Error('TEST_TIMEOUT'))); req.end(data);
  });
}

describe('Billing B2B explicit runtime assembly', () => {
  it('protects private credit history with mTLS, bearer and a strict request envelope', async () => {
    const f=await start(),path='/internal/b2b/batch-credit-history';
    expect((await send(f.port,path,{kind:'SERVICE',request:{}})).status).toBe(401);
    expect((await send(f.port,path,{kind:'SERVICE',request:{}},f.fixture.token,'other')).status).toBe(403);
    expect((await send(f.port,path,{kind:'SERVICE',request:{},accepted:true},f.fixture.token)).status).toBe(400);
    const result=await send(f.port,path,{kind:'SERVICE',request:{}},f.fixture.token);
    expect(result.status).toBe(400);expect(result.headers['cache-control']).toBe('private, no-store');
    expect(JSON.stringify(result.body)).not.toContain(f.fixture.token);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it('constructs real local owners, a fresh correction producer per request and no constructor I/O', async () => {
    const f = await dependencies(), r = createBillingB2bRuntime(f.deps);
    expect(r.cores.context).toBeInstanceOf(PrismaB2bContextRepository); expect(r.cores.reads).toBeInstanceOf(B2bBillingReads);
    expect(r.cores.creditHistory).toBeInstanceOf(BatchCreditHistoryVersionBridge);
    expect(r.cores.commercial.conversionConfigured).toBe(true);
    const a = r.cores.correctionFactory('one', 'SERVICE', f.correctionBinding), b = r.cores.correctionFactory('two', 'USER', f.correctionBinding);
    expect(a).toBeInstanceOf(B2bCorrectionProducer); expect(b).toBeInstanceOf(B2bCorrectionProducer); expect(a).not.toBe(b);
    expect(f.prisma.$transaction).not.toHaveBeenCalled(); expect(f.businessPool.connect).not.toHaveBeenCalled();
    expect(f.deps.identityHttp.post).not.toHaveBeenCalled(); expect(f.deps.fiscalHttp.post).not.toHaveBeenCalled();
    expect(r.status.capabilities.slice().sort()).toEqual(expectedCapabilities);
    expect(r.maintenance.snapshot().instance.bootId).toBe(r.status.bootId);
  });
  it('rejects missing real crypto, admin, lifecycle, pools and explicit report maps at construction', async () => {
    const f = await dependencies();
    for (const key of ['ownerDrain','legacyLifecycle','carrierReferenceValidator','establishmentAdmin','privilegedAdmin','business','batches','reports','issueDocument','stationAdmin','printBranding'] as const)
      expect(() => createBillingB2bRuntime({ ...f.deps, [key]: undefined } as any)).toThrow();
    expect(() => createBillingB2bRuntime({ ...f.deps, reports: { ...f.deps.reports, corrections: { ...f.deps.reports.corrections, bindings: [] } } })).toThrow('REPORT_SOURCE_MAPS_REQUIRED');
    expect(() => createBillingB2bRuntime({ ...f.deps, allowedRucs: [] })).toThrow('ALLOWLIST_REQUIRED');
    expect(() => createBillingB2bRuntime({ ...f.deps, maintenance: { ...f.deps.maintenance, operatorPeers: f.deps.peers.callers } })).toThrow('SEPARATE_OPERATOR');
  });
  it('reports installed capabilities after fixed metadata probes, with sanitized failures and released connections', async () => {
    const f = await dependencies(), r = createBillingB2bRuntime(f.deps), status = await r.status.inspect();
    expect(status.capabilities).toEqual(expectedCapabilities); expect(status.fiscalActivation).toBe(false);
    expect(f.sql).toEqual(billingRuntimeStorageSql.prisma);
    expect(f.businessPool.release).toHaveBeenCalledTimes(1); expect(f.reportsPool.release).toHaveBeenCalledTimes(1); expect(f.batchPool.release).toHaveBeenCalledTimes(1);
    for (const group of Object.values(billingRuntimeStorageSql)) for (const sql of group) expect(sql).toMatch(/^SELECT\b[\s\S]*WHERE false$/);
    f.reportsPool.query.mockRejectedValueOnce(Error('secret-host-sql-password'));
    await expect(r.status.inspect()).rejects.toThrow('BILLING_RUNTIME_STORAGE_NOT_READY');
    expect(f.reportsPool.release).toHaveBeenCalledTimes(2);
  });
  it('serves actual catalog and context cores through a real loopback mTLS Nest host', async () => {
    const f = await start();
    const status = await send(f.port, '/internal/b2b/runtime-status', {});
    expect(status.status).toBe(200); expect(status.body.deploymentId).toBe(f.deps.deploymentId); expect(status.body.bootId).toBe(f.runtime.status.bootId);
    const catalog = await send(f.port, '/internal/b2b/read', { action: 'catalog', args: { environment: 'BETA' }, kind: 'SERVICE' }, f.fixture.token);
    expect(catalog.status).toBe(200); expect(catalog.body.items).toHaveLength(2); expect(f.prisma.seriesCounter.findFirst).toHaveBeenCalled();
    const context = await send(f.port, '/internal/b2b/context', { binding: invoiceBinding, kind: 'SERVICE' }, f.fixture.token);
    expect(context.status).toBe(200); expect(context.body.binding).toEqual(invoiceBinding);
    expect(catalog.headers['cache-control']).toBe('private, no-store');
  });
  it('enforces socket identities, no certificate, exact status request and nonpublic routes', async () => {
    const f = await start(); f.fixture.identity.authenticate.mockClear();
    expect((await send(f.port, '/internal/b2b/runtime-status', {}, undefined, 'other')).status).toBe(403);
    await expect(send(f.port, '/internal/b2b/runtime-status', {}, undefined, null)).rejects.toThrow();
    expect((await send(f.port, '/internal/b2b/runtime-status', {}, 'unexpected')).status).toBe(400);
    expect((await send(f.port, '/internal/b2b/runtime-status', { enabled: true })).status).toBe(400);
    expect((await send(f.port, '/internal/b2b/runtime-status?x=1', {})).status).toBe(400);
    expect((await send(f.port, '/b2b/v1/documents', {})).status).toBe(404);
    expect(f.fixture.identity.authenticate).not.toHaveBeenCalled();
  });
  it('installs every owner route, including the establishment raw-body reader, without fake success', async () => {
    const f = await start();
    for (const path of ['drafts','commercial','correction-producer','guides','issue-guide','read-guide-issuance','prepare-guide','carrier-guides','batch-operations','phase8-business','phase8-reports','owner-admin','validate-guide-bindings','validate-guide-issue-bindings','validate-correction-bindings','correction-evidence-authorize','guide-establishments/read','guide-goods/read']) {
      const response = await send(f.port, '/internal/b2b/' + path, {}, f.fixture.token);
      expect(response.status, path).not.toBe(404); expect(response.status, path).toBeGreaterThanOrEqual(400);
    }
    const response = await send(f.port, '/internal/b2b/guide-establishments/read', { companyId: 1 }, f.fixture.token);
    expect(response.status).toBe(503); expect(f.sql.some(s => s.includes('B2bGuideEstablishmentRate'))).toBe(true);
  });
  it('drains a real in-flight HTTP producer while retaining internal read/auth, then closes storage last', async () => {
    const f = await start(), entered = defer(), release = defer();
    const authenticate = f.fixture.identity.authenticate.getMockImplementation()!;
    f.fixture.identity.authenticate.mockImplementation(async (token, scopes, kind) => {
      if (scopes.includes('b2b:drafts:write')) { entered.resolve(); await release.promise; }
      return authenticate(token, scopes, kind);
    });
    const pending = send(f.port, '/internal/b2b/drafts', { kind: 'SERVICE', action: 'CREATE', args: { issuerId: '1', id: null, key: 'synthetic-key-0000001', body: {} } }, f.fixture.token);
    await entered.promise;
    const request = { runId: randomUUID(), deploymentId: f.deps.deploymentId, inventorySha256: 'a'.repeat(64), instance: f.runtime.maintenance.snapshot().instance };
    const stopping = f.runtime.maintenance.advance('ADMISSION', request);
    expect((await send(f.port, '/internal/b2b/context', { kind: 'SERVICE', binding: invoiceBinding }, f.fixture.token)).status).toBe(200);
    expect(f.legacyLifecycle.PRODUCERS).not.toHaveBeenCalled(); expect(f.legacyLifecycle.STORAGE).not.toHaveBeenCalled();
    expect((await send(f.port, '/internal/b2b/drafts', { kind: 'SERVICE', action: 'CREATE', args: {} }, f.fixture.token)).status).toBe(503);
    release.resolve(); expect((await pending).status).toBeGreaterThanOrEqual(400); await stopping;
    await f.runtime.maintenance.advance('PRODUCERS', request);
    await f.runtime.maintenance.advance('WORKERS', request); await f.runtime.maintenance.advance('STORAGE', request);
    expect(f.legacyLifecycle.PRODUCERS).toHaveBeenCalledTimes(1); expect(f.legacyLifecycle.STORAGE).toHaveBeenCalledTimes(1);
    await expect(send(f.port, '/internal/b2b/read', {}, f.fixture.token)).rejects.toThrow();
    expect(f.runtime.maintenance.snapshot().storageClosed).toBe(true);
  }, 30000);
  it('retains the SQL-owning controller after client abort and never closes pools on an incomplete drain', async () => {
    const draft = await draftFixture(), entered = defer(), release = defer();
    const f = await start(f => {
      f.deps.identity = draft.identity;
      f.prisma.$queryRawUnsafe.mockImplementation(async (sql: string) => {
        if (sql.includes('pg_advisory_xact_lock')) { entered.resolve(); await release.promise; }
        throw Error('SYNTHETIC_SQL_STOPPED_AFTER_RELEASE');
      });
    });
    const payload = Buffer.from(JSON.stringify({ kind: 'SERVICE', action: 'CREATE', args: { issuerId: '1', id: null, key: 'synthetic-key-0000002', body: {} } }));
    const req = request({ hostname: '127.0.0.1', port: f.port, path: '/internal/b2b/drafts', method: 'POST', agent: false,
      ca: tls.ca, cert: tls.resource, key: tls.key, rejectUnauthorized: true,
      headers: { Authorization: 'Bearer ' + draft.token, 'Content-Type': 'application/json', 'Content-Length': payload.length } });
    req.on('error', () => {}); req.end(payload);
    await entered.promise; req.destroy();
    await vi.waitFor(() => expect(f.deps.ownerDrain.snapshot().aborted).toBe(1));
    expect(f.deps.ownerDrain.snapshot().commands).toBe(1);
    const drain = f.deps.ownerDrain.drain.bind(f.deps.ownerDrain);
    vi.spyOn(f.deps.ownerDrain, 'drain').mockImplementation(which => drain(which, 0));
    const input = { runId: randomUUID(), deploymentId: f.deps.deploymentId, inventorySha256: 'c'.repeat(64), instance: f.runtime.maintenance.snapshot().instance };
    try {
      await expect(f.runtime.maintenance.advance('ADMISSION', input)).rejects.toThrow('MAINTENANCE_HOOK_FAILED');
      expect(f.runtime.maintenance.snapshot().state).toBe('FAILED');
      expect(f.legacyLifecycle.STORAGE).not.toHaveBeenCalled(); expect(f.businessPool.end).not.toHaveBeenCalled();
      expect(f.deps.ownerDrain.snapshot().commands).toBe(1);
    } finally { release.resolve(); }
    await vi.waitFor(() => expect(f.deps.ownerDrain.snapshot().active).toBe(0));
  });
  it('blocks new admission before awaiting active reads and closes HTTP before legacy storage', async () => {
    const f = await start(), entered = defer(), release = defer();
    const first = f.prisma.seriesCounter.findFirst.getMockImplementation()!;
    f.prisma.seriesCounter.findFirst.mockImplementation(async (input: unknown) => { entered.resolve(); await release.promise; return first(input); });
    const reading = send(f.port, '/internal/b2b/context', { kind: 'SERVICE', binding: invoiceBinding }, f.fixture.token);
    await entered.promise;
    const input = { runId: randomUUID(), deploymentId: f.deps.deploymentId, inventorySha256: 'd'.repeat(64), instance: f.runtime.maintenance.snapshot().instance };
    await f.runtime.maintenance.advance('ADMISSION', input); await f.runtime.maintenance.advance('PRODUCERS', input); await f.runtime.maintenance.advance('WORKERS', input);
    const parking = f.runtime.maintenance.advance('STORAGE', input);
    expect((await send(f.port, '/internal/b2b/context', { kind: 'SERVICE', binding: invoiceBinding }, f.fixture.token)).status).toBe(503);
    expect(f.legacyLifecycle.STORAGE).not.toHaveBeenCalled();
    release.resolve(); expect((await reading).status).toBe(200); await parking;
    expect(f.app.getHttpServer().listening).toBe(false); expect(f.legacyLifecycle.STORAGE).toHaveBeenCalledTimes(1);
  });
  it('operator mTLS port uses the same actual deployment and boot context and rejects caller identity', async () => {
    const f = await dependencies(), runtime = createBillingB2bRuntime(f.deps);
    const address = await runtime.listenOperator('127.0.0.1', 0); cleanups.push(() => runtime.maintenance.closeListener());
    const port = (address as { port: number }).port;
    const status = await send(port, '/internal/maintenance/status', undefined, undefined, 'edge', 'GET');
    expect(status.status).toBe(200); expect(status.body.deploymentId).toBe(runtime.status.deploymentId); expect(status.body.instance.bootId).toBe(runtime.status.bootId);
    expect((await send(port, '/internal/maintenance/status', undefined, undefined, 'resource', 'GET')).status).toBe(403);
    const wrong = { runId: randomUUID(), deploymentId: f.deps.deploymentId, inventorySha256: 'a'.repeat(64), instance: { ...status.body.instance, bootId: randomUUID() } };
    expect((await send(port, '/internal/maintenance/advance', { phase: 'ADMISSION', request: wrong }, undefined, 'edge')).status).toBe(409);
  });
  it('requires the tracked host and propagates failed legacy drain without closing storage', async () => {
    const f = await dependencies(), gate = new BillingRuntimeLifecycle(f.deps.ownerDrain);
    expect(() => gate.authorize()).toThrow('HTTP_TRACKING_REQUIRED');
    f.legacyLifecycle.PRODUCERS.mockRejectedValueOnce(Error('legacy still active'));
    const runtime = createBillingB2bRuntime(f.deps), input = { runId: randomUUID(), deploymentId: f.deps.deploymentId, inventorySha256: 'b'.repeat(64), instance: runtime.maintenance.snapshot().instance };
    await runtime.maintenance.advance('ADMISSION', input);
    await expect(runtime.maintenance.advance('PRODUCERS', input)).rejects.toThrow('MAINTENANCE_HOOK_FAILED');
    await expect(runtime.maintenance.advance('STORAGE', input)).rejects.toThrow(); expect(f.legacyLifecycle.STORAGE).not.toHaveBeenCalled();
  });
});
