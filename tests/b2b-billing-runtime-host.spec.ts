import 'reflect-metadata';
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request, type Server } from 'node:https';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve,sep,basename } from 'node:path';
import { validateBillingHostConfig, validateBillingHostCredentials, type BillingHostConfig, type BillingHostCredentials } from '../services/billing-service/src/b2b/host-config';
import { requireBuiltinBillingHostImplementations, validateBillingHostImplementations, BillingHostMissingImplementations, billingHostRequiredImplementations, type BillingHostImplementations } from '../services/billing-service/src/b2b/host-implementations';
import { installBillingHostEnvironment } from '../services/billing-service/src/b2b/host-environment';
import { startBillingB2bHost } from '../services/billing-service/src/b2b/host';
import type { BillingHostOwners } from '../services/billing-service/src/b2b/host-di';
import { b2bCertificates, fingerprint } from './b2b-tls.fixture';
import { b2bReadFixture, invoiceBinding as originalBinding } from './b2b-read.fixture';
import { GUIDE_RUC } from './helpers/b2b-guide.fixture';

let pki: ReturnType<typeof b2bCertificates>, operatorPki: ReturnType<typeof b2bCertificates>;
const cleanup: (() => Promise<unknown> | unknown)[] = [];
beforeAll(() => { pki = b2bCertificates(); operatorPki = b2bCertificates(); }, 30000);
afterEach(async () => { for (const done of cleanup.splice(0).reverse()) await done(); vi.unstubAllEnvs(); });
const binding = { ...originalBinding, issuerRuc: GUIDE_RUC };
const envKeys = ['DATABASE_URL','REDIS_HOST','REDIS_PORT','REDIS_PASSWORD_FILE','PRINT_SETTINGS_ENABLED','PRINT_BRANDING_ROOT','STATION_MASTER_CRUD_ENABLED'];
function configuration() {
  const dir = mkdtempSync(join(tmpdir(), 'factuez-billing-host-synthetic-')); cleanup.push(() => {
    if(!resolve(dir).startsWith(resolve(tmpdir())+sep)||!basename(dir).startsWith('factuez-billing-host-synthetic-'))throw Error('TEST_CLEANUP_OUTSIDE_OWNED_ROOT');
    rmSync(dir, { recursive: true, force: true });
  });
  const redisPassword = Buffer.from('SYNTHETIC-NOT-A-DEPLOYMENT-SECRET');
  writeFileSync(join(dir, 'redis.bin'), redisPassword, { mode: 0o600 });
  const peers = [fingerprint(pki.resource)];
  const config: BillingHostConfig = {
    schemaVersion: 'factuez.b2b.billing-host.v1', enabled: true, environment: 'BETA', deploymentId: randomUUID(), instanceId: randomUUID(),
    api: { host: '127.0.0.1', port: 0 }, operator: { host: '127.0.0.1', port: 0 }, identityOrigin: 'https://127.0.0.1:1', fiscalOrigin: 'https://127.0.0.1:1',
    allowedRucs: [GUIDE_RUC], peers: { callers: peers, registrar: peers, administrators: peers, status: peers, evidence: peers, operators: [fingerprint(pki.edge)] },
    reports: { corrections: [{ reference: binding, noteType: '07', noteSeriesId: randomUUID() }], guides: [{ draft: { anchor: binding, guideType: '09', guideSeriesId: randomUUID() }, fiscalSeriesId: randomUUID() }] },
    redis: { host: '127.0.0.1', port: 1 }, printRoot: join(dir, 'printing'), legacyOutboxDispatch: false,
  };
  const credentials: BillingHostCredentials = { databaseUrl: 'postgresql://synthetic:never-connect@127.0.0.1:1/synthetic_billing_beta', databaseCa:pki.ca,redisPassword, redisPasswordFile: join(dir, 'redis.bin'),
    apiTls: { ca: pki.ca, cert: pki.server, key: pki.key }, operatorTls: { ca: pki.ca, cert: operatorPki.server, key: operatorPki.key },
    identityTls: { ca: pki.ca, cert: pki.resource, key: pki.key }, fiscalTls: { ca: pki.ca, cert: pki.resource, key: pki.key } };
  return { dir, config, credentials };
}
const deny = async (): Promise<never> => { throw Error('SYNTHETIC_UNCONFIGURED_AUTHORITY'); };
function implementations(order: string[] = []): BillingHostImplementations {
  // Explicit test doubles only. No production implementation returns these decisions.
  return { establishmentAdmin: { verify: vi.fn(deny) }, businessPermissions: { authorizeCurrent: vi.fn(deny) }, carrierReferenceValidator: { verify: vi.fn(deny) },
    batchEvidence: { verifySignedVersion: vi.fn(deny) }, batchMemberIdentity: { current: vi.fn(deny) }, batchPolicyAdmin: { authorizeStepUp: vi.fn(deny) },
    privilegedAdmin: { authority: { authorize: vi.fn(deny) }, liveIdentity: { current: vi.fn(deny) } },
    assertInfrastructure: vi.fn(async () => {}), close: vi.fn(async () => { order.push('adapters-close'); }) };
}
async function suppliedOwners(order: string[]) {
  const f = await b2bReadFixture([binding]); cleanup.push(f.close);
  const db: any = {
    $queryRawUnsafe: vi.fn(async (sql: string) => { if (!/^SELECT\b[\s\S]*WHERE false$/.test(sql)) throw Error('SYNTHETIC_SQL_UNCONFIGURED'); return []; }),
    $executeRawUnsafe: vi.fn(async () => 0),
    $transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(db)),
    companySettings: { findMany: vi.fn(async () => [{ ruc: GUIDE_RUC }]) },
    seriesCounter: { findFirst: vi.fn(async () => ({ id: binding.seriesId, series: 'F001', company: { id: 1, ruc: GUIDE_RUC, legalName: 'SYNTHETIC' }, emissionPoint: { id: binding.pointId, code: 'QA', name: 'QA', branch: { id: binding.branchId, code: 'QA', name: 'QA' } } })) },
  };
  const pool = () => ({ connect: vi.fn(async () => ({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })), release: vi.fn() })), end: vi.fn(async () => {}) });
  const masters = Object.fromEntries(['catalog','createIssuer','updateIssuer','createBranch','updateBranch','createPoint','updatePoint','createSeries','updateSeries'].map(k => [k, vi.fn(deny)]));
  const owners: BillingHostOwners = { prisma: db, printBranding: { ...f.printing, settings: vi.fn(deny), save: vi.fn(deny), preview: vi.fn(deny) } as any,
    issueDocument: { executeWithinTransaction: vi.fn(deny) } as any, stationAdmin: masters as any, businessPool: pool(), reportsPool: pool(), batchesPool: pool(),
    initializeStorage: vi.fn(async () => { order.push('storage-init'); }), assertBetaOwners: vi.fn(async () => {}), startStatusConsumer: vi.fn(() => { order.push('status-start'); }),
    stopProducers: vi.fn(async () => { order.push('publisher-close'); }), stopWorkers: vi.fn(async () => { order.push('consumer-close'); }), closeStorage: vi.fn(async () => { order.push('prisma-close'); }) };
  return { f, owners, db };
}
async function identityServer(f: Awaited<ReturnType<typeof b2bReadFixture>>) {
  const server = createServer({ ca: pki.ca, cert: pki.server, key: pki.key, requestCert: true, rejectUnauthorized: true }, async (req, res) => {
    try {
      if (req.url !== '/internal/b2b/introspect') throw Error();
      const chunks: Buffer[] = []; for await (const b of req) chunks.push(Buffer.from(b));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const principal = await f.identity.authenticate(String(req.headers.authorization).slice(7), body.requiredScopes, body.kind);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(principal));
    } catch { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return `https://127.0.0.1:${(server.address() as { port: number }).port}`;
}
function post(port: number, path: string, body: unknown, token?: string) {
  const bytes = Buffer.from(JSON.stringify(body));
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: 'POST', agent: false, ca: pki.ca, cert: pki.resource, key: pki.key,
      headers: { 'Content-Type': 'application/json', 'Content-Length': bytes.length, ...(token ? { Authorization: 'Bearer ' + token } : {}) } }, res => {
      const chunks: Buffer[] = []; res.on('data', b => chunks.push(b)); res.on('error', reject); res.on('end', () => { try { resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (error) { reject(error); } });
    }); req.on('error', reject); req.end(bytes);
  });
}

describe('Billing standalone host explicit mounting', () => {
  it('accepts only BETA, exact maps, separate operator TLS and no legacy fiscal dispatch', () => {
    const { config, credentials } = configuration(); expect(validateBillingHostConfig(config)).toEqual(config);
    expect(validateBillingHostCredentials(credentials).apiTls.cert).toEqual(pki.server);
    for (const change of [{ environment: 'PRODUCTION' }, { enabled: false }, { legacyOutboxDispatch: true }, { extra: 'implicit' }, { allowedRucs: [] }])
      expect(() => validateBillingHostConfig({ ...config, ...change })).toThrow('EXPLICIT_BETA');
    expect(() => validateBillingHostCredentials({ ...credentials, operatorTls: credentials.apiTls })).toThrow('MOUNTED_CREDENTIALS');
    expect(() => validateBillingHostCredentials({ ...credentials, databaseUrl: 'postgresql://localhost/no-password' })).toThrow();
  });
  it('enumerates absent genuine implementations and rejects before owner construction/connections', async () => {
    const { config, credentials } = configuration();
    expect(() => validateBillingHostImplementations({})).toThrow(BillingHostMissingImplementations);
    await expect(startBillingB2bHost(config, credentials, {} as any)).rejects.toMatchObject({ missing: billingHostRequiredImplementations });
    expect(() => requireBuiltinBillingHostImplementations()).toThrow('BILLING_HOST_SOFTWARE_INCOMPLETE');
  });
  it('requires concrete builtin configuration and never a customer plugin', () => {
    try { requireBuiltinBillingHostImplementations(); throw Error('unexpected readiness'); }
    catch (error) { expect(error).toBeInstanceOf(BillingHostMissingImplementations); expect((error as BillingHostMissingImplementations).missing).toEqual(['builtin.config','builtin.credentials','builtin.billingOwner']); }
    const { config } = configuration();
    expect(() => validateBillingHostConfig({ ...config, implementations: { path: 'external-plugin.cjs' } })).toThrow('EXPLICIT_BETA');
  });
  it('projects only mounted legacy constructor settings, rejects conflicts and restores previous environment', () => {
    const { config, credentials } = configuration(), env: NodeJS.ProcessEnv = { KEEP: 'original' };
    const restore = installBillingHostEnvironment(config, credentials, env);
    try { expect(env.DATABASE_URL).toBe(credentials.databaseUrl); expect(env.REDIS_HOST).toBe(config.redis.host); expect(env.PRINT_BRANDING_ROOT).toBe(config.printRoot); }
    finally { restore(); }
    expect(env).toEqual({ KEEP: 'original' });
    expect(() => installBillingHostEnvironment(config, credentials, { DATABASE_URL: 'another-deployment' })).toThrow('ENVIRONMENT_CONFLICT:DATABASE_URL');
  });
  it('mounts real runtime/Nest/mTLS/Identity HTTP and closes publisher then consumer before Prisma', async () => {
    for (const k of envKeys) vi.stubEnv(k, undefined);
    const { config, credentials } = configuration(), order: string[] = [], deps = await suppliedOwners(order), caps = implementations(order);
    config.identityOrigin = await identityServer(deps.f);
    const host = await startBillingB2bHost(config, credentials, caps, deps.owners); cleanup.push(host.close);
    const port = host.app.getHttpServer().address().port;
    const status = await post(port, '/internal/b2b/runtime-status', {});
    expect(status.status).toBe(200); expect(status.body.bootId).toBe(host.runtime.maintenance.snapshot().instance.bootId); expect(status.body.fiscalActivation).toBe(false);
    const catalog = await post(port, '/internal/b2b/read', { kind: 'SERVICE', action: 'catalog', args: { environment: 'BETA' } }, deps.f.token);
    expect(catalog.status).toBe(200); expect(catalog.body.items).toHaveLength(1);
    expect(deps.f.identity.authenticate).toHaveBeenCalled();
    await host.close();
    expect(order).toEqual(['storage-init','status-start','publisher-close','consumer-close','adapters-close','prisma-close']);
    expect(host.runtime.maintenance.snapshot().state).toBe('PARKED'); expect(host.app.getHttpServer().listening).toBe(false);
    expect(process.env.DATABASE_URL).toBeUndefined();
  });
  it('fails before readiness/listeners when actual authority infrastructure rejects', async () => {
    const { config, credentials } = configuration(), order: string[] = [], deps = await suppliedOwners(order), caps = implementations(order);
    vi.mocked(caps.assertInfrastructure).mockRejectedValue(Error('secret infrastructure diagnostics'));
    await expect(startBillingB2bHost(config, credentials, caps, deps.owners)).rejects.toThrow('AUTHORITY_INFRASTRUCTURE_UNAVAILABLE');
    expect(deps.owners.initializeStorage).not.toHaveBeenCalled(); expect(caps.close).toHaveBeenCalledTimes(1);
  });
  it('failed startup metadata closes producers and workers before storage without exposing a listener', async () => {
    for (const k of envKeys) vi.stubEnv(k, undefined);
    const { config, credentials } = configuration(), order: string[] = [], deps = await suppliedOwners(order), caps = implementations(order);
    deps.db.$queryRawUnsafe.mockRejectedValue(Error('synthetic-missing-schema'));
    await expect(startBillingB2bHost(config, credentials, caps, deps.owners)).rejects.toThrow('BILLING_HOST_STARTUP_FAILED');
    expect(deps.owners.startStatusConsumer).not.toHaveBeenCalled();
    expect(order).toEqual(['storage-init','publisher-close','consumer-close','adapters-close','prisma-close']);
    expect(process.env.DATABASE_URL).toBeUndefined();
  });
  it('failed publisher drain preserves storage and never invokes Prisma close', async () => {
    for (const k of envKeys) vi.stubEnv(k, undefined);
    const { config, credentials } = configuration(), order: string[] = [], deps = await suppliedOwners(order), caps = implementations(order);
    const host = await startBillingB2bHost(config, credentials, caps, deps.owners);
    vi.mocked(deps.owners.stopProducers).mockRejectedValue(Error('pending actual publisher'));
    await expect(host.close()).rejects.toThrow('MAINTENANCE_HOOK_FAILED');
    expect(deps.owners.closeStorage).not.toHaveBeenCalled(); expect(deps.owners.stopWorkers).not.toHaveBeenCalled();
    // Test-only cleanup after assertions. The failed production shutdown does not force-close anything.
    host.runtime.lifecycle.ownerDrain.closeAdmission(); await host.runtime.lifecycle.ownerDrain.drain('ALL');
    await host.app.close(); await host.runtime.maintenance.closeListener();
    // This isolated test file restores its stubbed env in afterEach. Production retains the lease after a failed drain.
  });
});
