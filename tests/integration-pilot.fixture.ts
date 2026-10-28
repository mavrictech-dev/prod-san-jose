/** Phase8 fixture ONLY: real five-app HTTPS, synthetic in-memory repositories.
 * Never imported by runtime; no database, filesystem originals, SUNAT or Docker.
 */
import 'reflect-metadata';
import { vi } from 'vitest';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { request } from 'node:https';
import { NestFactory } from '../services/integration-export-service/node_modules/@nestjs/core';
import type { NestExpressApplication } from '../services/integration-export-service/node_modules/@nestjs/platform-express';
import { PrivateReadFilter, privateReadBoundary } from '../packages/service-access/src/integration-http';
import { deny, PrivateReadHttp, RemoteReadIdentity } from '../packages/service-access/src/integration';
import { OwnerChanges } from '../packages/service-access/src/integration-owner-changes';
import type { JournalPosition } from '../packages/service-access/src/integration-journal';
import { IntegrationIdentityModule, IntegrationErrorFilter } from '../services/identity-service/src/integration/http';
import { BillingReadModule, billingCapturePostPaths } from '../services/billing-service/src/integration/http';
import { BillingCapture } from '../services/billing-service/src/integration/capture';
import { BillingRead } from '../services/billing-service/src/integration/read';
import { SunatReadModule } from '../services/sunat-service/src/integration/http';
import { SunatRead, RemoteBillingOwner, type StoredArtifact } from '../services/sunat-service/src/integration/read';
import { IntegrationReadModule } from '../services/integration-service/src/http';
import { IntegrationReads } from '../services/integration-service/src/read';
import { IntegrationExports } from '../services/integration-export-service/src/core';
import { IntegrationChanges } from '../services/integration-export-service/src/changes';
import { IntegrationExportModule, exportPostPaths } from '../services/integration-export-service/src/http';
import { ExportVault } from '../services/integration-export-service/src/vault';
import { changesFixture } from './integration-changes.fixture';
import { fixture, basic, ctx } from './integration-identity.fixture';
import { issuerRuc, documentId, secondId, batchId, sale } from './integration-read.fixture';

type Role = 'edge' | 'facade' | 'exporter' | 'billing' | 'sunat' | 'admin' | 'unapproved';
type AppName = 'identity' | 'billing' | 'sunat' | 'exporter' | 'facade';
type Source = 'BILLING' | 'SUNAT';
const forge = createRequire(resolve('packages/evidence-core/package.json'))('node-forge');
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
function certificates() {
  const pki = forge.pki, root = pki.rsa.generateKeyPair(2048), ca = pki.createCertificate();
  ca.publicKey = root.publicKey; ca.serialNumber = '01';
  ca.validity.notBefore = new Date(Date.now() - 60000); ca.validity.notAfter = new Date(Date.now() + 3600000);
  ca.setSubject([{ name: 'commonName', value: 'SYNTHETIC Phase8 CA' }]); ca.setIssuer(ca.subject.attributes);
  ca.setExtensions([{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true }]);
  ca.sign(root.privateKey, forge.md.sha256.create()); let serial = 2;
  const leaf = (name: string, server = false) => {
    // Each server/role gets an independent private key, never a fiscal key.
    const pair = pki.rsa.generateKeyPair(2048), cert = pki.createCertificate();
    cert.publicKey = pair.publicKey; cert.serialNumber = (serial++).toString(16).padStart(2, '0'); cert.validity = ca.validity;
    cert.setSubject([{ name: 'commonName', value: 'synthetic-' + name }]); cert.setIssuer(ca.subject.attributes);
    cert.setExtensions([{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: server, clientAuth: !server },
      ...(server ? [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] }] : [])]);
    cert.sign(root.privateKey, forge.md.sha256.create());
    return { cert: Buffer.from(pki.certificateToPem(cert)), key: Buffer.from(pki.privateKeyToPem(pair.privateKey)) };
  };
  const roles = Object.fromEntries(['edge', 'facade', 'exporter', 'billing', 'sunat', 'admin', 'unapproved'].map(name => [name, leaf(name)])) as Record<Role, ReturnType<typeof leaf>>;
  const servers = Object.fromEntries(['identity', 'billing', 'sunat', 'exporter', 'facade'].map(name => [name, leaf(name, true)])) as Record<AppName, ReturnType<typeof leaf>>;
  return { ca: Buffer.from(pki.certificateToPem(ca)), roles, servers };
}
export interface PilotReply { status: number; body: any; bytes: Buffer; headers: any }
export async function pilotFixture() {
  const f = changesFixture(), id = fixture(), tls = certificates();
  const apps = new Map<AppName, NestExpressApplication>(), origins = new Map<AppName, string>();
  const bytes = new Map<string, Buffer>(), artifactOwners = new Map<string, string>();
  const fp = (role: Role) => new X509Certificate(tls.roles[role].cert).fingerprint256.replace(/:/g, '').toLowerCase();
  const transport = (role: Role) => ({ ca: tls.ca, ...tls.roles[role] });
  const artifacts = (row: ReturnType<typeof sale>) => {
    const kinds = ['SIGNED_XML', 'CDR_XML'];
    return kinds.map(kind => {
      const owner = row.immutableSnapshot.documentTypeCode === '03' && kind === 'CDR_XML' ? batchId : row.id;
      const artifact: StoredArtifact = { id: randomUUID(), kind, storageKey: kind + '-' + row.id + '.xml', mediaType: 'application/xml',
        sizeBytes: 0, sha256: '', createdAt: new Date(f.now()) };
      const body = Buffer.from(`<?xml version="1.0"?><${kind === 'SIGNED_XML' ? 'Invoice' : 'ApplicationResponse'}><Fixture>SYNTHETIC-NOT-SIGNED-NOT-OFFICIAL</Fixture><ID>${row.fullNumber}</ID><Type>${row.immutableSnapshot.documentTypeCode}</Type></${kind === 'SIGNED_XML' ? 'Invoice' : 'ApplicationResponse'}>`);
      artifact.sizeBytes = body.length; artifact.sha256 = hash(body);
      bytes.set(owner + ':' + artifact.storageKey, body); artifactOwners.set(artifact.id, owner);
      return artifact;
    });
  };
  function installRow(row: ReturnType<typeof sale>) {
    f.rows.set(row.id, row);
    f.docs.set(row.id, { documentId: row.id, issuerRuc, environment: 'BETA', documentType: row.immutableSnapshot.documentTypeCode,
      series: row.series, number: row.number, immutablePayload: structuredClone(row.immutableSnapshot), artifacts: artifacts(row) });
  }
  for (const row of [...f.rows.values()]) installRow(row);
  for (const type of ['07', '08'] as const) {
    const row = sale(type, randomUUID());
    row.immutableSnapshot.reference = { documentId, documentTypeCode: '01', fullNumber: 'F001-00000001' }; installRow(row);
  }
  const receiptCdr = f.docs.get(secondId)!.artifacts.find(a => a.kind === 'CDR_XML')!;
  f.batches.get(batchId)!.artifacts = [structuredClone(receiptCdr)];
  f.sunatRepo.sharedCdr.mockImplementation(async (...args: unknown[]) => {
    const artifact = args[1] as StoredArtifact | undefined;
    return args[2] === secondId && artifact?.kind === 'CDR_XML' ? [{ artifact: structuredClone(receiptCdr), batchId }] : [];
  });
  const sourceHash = () => hash(Buffer.from(JSON.stringify({ rows: [...f.rows], docs: [...f.docs], batches: [...f.batches],
    summaries: [...f.summaries], bytes: [...bytes].map(([k, v]) => [k, v.toString('base64')]) }, (_k, v) => typeof v === 'bigint' ? v.toString() : v)));
  const initial = { rows: structuredClone(f.rows), docs: structuredClone(f.docs), batches: structuredClone(f.batches), summaries: structuredClone(f.summaries),
    bytes: new Map([...bytes].map(([k, v]) => [k, Buffer.from(v)])) };
  const sourceStore = { read: vi.fn(async (owner: string, artifact: StoredArtifact) => {
    const body = bytes.get(owner + ':' + artifact.storageKey); if (!body) throw Object.assign(new Error('missing synthetic artifact'), { code: 'ENOENT' });
    return Buffer.from(body);
  }) };
  const journalRepo = (source: Source) => ({ read: vi.fn(async (ruc: string, after: JournalPosition | null, limit = 500) => {
    if (ruc !== issuerRuc) return deny(404, 'RESOURCE_NOT_FOUND'); const j = f.journals[source];
    if (after && (after.epoch !== j.epoch || BigInt(after.sequence) < j.floor || BigInt(after.sequence) > j.head)) return deny(410, 'CURSOR_EXPIRED');
    const events = after ? j.events.filter(e => BigInt(e.sequence) > BigInt(after.sequence)).slice(0, limit) : [];
    return { epoch: j.epoch, head: j.head.toString(), floor: j.floor.toString(), position: { epoch: j.epoch,
      sequence: events.at(-1)?.sequence ?? after?.sequence ?? j.head.toString() }, events: structuredClone(events) };
  }) });
  const journals = { BILLING: journalRepo('BILLING'), SUNAT: journalRepo('SUNAT') };
  const captureRepository = { capture: vi.fn(async (filters: any) => Object.assign(structuredClone([...f.rows.values()].filter(row =>
    filters.types.includes(row.immutableSnapshot.documentTypeCode))), { changeBarrier: { epoch: f.journals.BILLING.epoch, sequence: f.journals.BILLING.head.toString() },
    snapshotAt: new Date(f.now()).toISOString() })),
    reauthorize: vi.fn(async (ruc: string, ids: string[]) => ruc === issuerRuc ? structuredClone(ids.map(key => f.rows.get(key)).filter(Boolean)) : []) };
  async function start(name: AppName, module: any, posts: Record<string, number> = {}) {
    const httpsOptions = { ...tls.servers[name], ca: tls.ca, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' as const };
    const app = await NestFactory.create<NestExpressApplication>(module, { logger: false, bodyParser: false,
      httpsOptions });
    apps.set(name, app);
    if (name === 'identity') {
      app.useBodyParser('json', { limit: '32kb', strict: true });
      app.useBodyParser('urlencoded', { limit: '2kb', extended: false }); app.useGlobalFilters(new IntegrationErrorFilter());
    } else {
      app.use(privateReadBoundary(posts)); if (Object.keys(posts).length) app.useBodyParser('json', { limit: '4mb', strict: true });
      app.useGlobalFilters(new PrivateReadFilter());
    }
    const old = origins.get(name), port = old ? Number(new URL(old).port) : 0;
    await app.listen(port, '127.0.0.1'); const address = app.getHttpServer().address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1') throw new Error('FIXTURE_LOOPBACK_REQUIRED');
    const origin = 'https://127.0.0.1:' + address.port;
    origins.set(name, origin); return origin;
  }
  async function stop(name: AppName) {
    const app = apps.get(name); if (app) { app.getHttpServer().closeAllConnections(); await app.close(); apps.delete(name); }
  }
  let identity: RemoteReadIdentity, billing: PrivateReadHttp, sunat: PrivateReadHttp, core: IntegrationExports;
  const makeCore = (vault = f.vault) => new IntegrationExports(f.store, vault, identity, billing, sunat, f.now,
    new IntegrationChanges(f.changeStore, vault, identity, billing, sunat, f.now));
  const startSunat = () => start('sunat', SunatReadModule.isolated(new SunatRead(f.sunatRepo,
    new RemoteReadIdentity(new PrivateReadHttp(origins.get('identity')!, transport('sunat'))),
    new RemoteBillingOwner(new PrivateReadHttp(origins.get('billing')!, transport('sunat'))), sourceStore),
    [fp('facade'), fp('exporter')], new OwnerChanges(journals.SUNAT, new RemoteReadIdentity(new PrivateReadHttp(origins.get('identity')!, transport('sunat'))))));
  const startExporter = () => start('exporter', IntegrationExportModule.isolated(core, identity, billing, [fp('facade')]), exportPostPaths);
  async function close() { for (const name of ['facade', 'exporter', 'sunat', 'billing', 'identity'] as AppName[]) await stop(name); }
  try {
    await start('identity', IntegrationIdentityModule.isolated(id.core, { token: [fp('edge')], admin: [fp('admin')],
      resource: [fp('facade'), fp('exporter'), fp('billing'), fp('sunat')] }));
    const billingIdentity = new RemoteReadIdentity(new PrivateReadHttp(origins.get('identity')!, transport('billing')));
    await start('billing', BillingReadModule.isolated(new BillingRead(f.billingRepo, billingIdentity),
      [fp('facade'), fp('exporter'), fp('sunat')], new BillingCapture(captureRepository, billingIdentity, f.now),
      new OwnerChanges(journals.BILLING, billingIdentity)), billingCapturePostPaths);
    await startSunat();
    identity = new RemoteReadIdentity(new PrivateReadHttp(origins.get('identity')!, transport('exporter')));
    billing = new PrivateReadHttp(origins.get('billing')!, transport('exporter')); sunat = new PrivateReadHttp(origins.get('sunat')!, transport('exporter'));
    core = makeCore(); await startExporter();
    await start('facade', IntegrationReadModule.isolated(new IntegrationReads(new RemoteReadIdentity(new PrivateReadHttp(origins.get('identity')!, transport('facade'))),
      new PrivateReadHttp(origins.get('billing')!, transport('facade')), new PrivateReadHttp(origins.get('sunat')!, transport('facade')), f.now,
      new PrivateReadHttp(origins.get('exporter')!, transport('facade'))), [fp('edge')]), { '/integration/v1/exports': 16384 });
  } catch (error) { await close(); throw error; }
  async function send(path: string, options: { app?: AppName; role?: Role | null; method?: string; body?: unknown; raw?: string;
    contentType?: string; authorization?: string | null; key?: string } = {}): Promise<PilotReply> {
    const data = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    const role = options.role === undefined ? 'edge' : options.role;
    return new Promise((done, reject) => {
      const req = request(origins.get(options.app ?? 'facade')! + path, { ca: tls.ca, rejectUnauthorized: true, minVersion: 'TLSv1.2',
        ...(role ? tls.roles[role] : {}), method: options.method ?? 'GET', timeout: 15000, headers: {
          ...(options.authorization ? { Authorization: options.authorization } : {}), ...(options.key ? { 'Idempotency-Key': options.key } : {}),
          ...(data !== undefined ? { 'Content-Type': options.contentType ?? 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, response => {
        const chunks: Buffer[] = []; let length = 0;
        response.on('data', chunk => { length += chunk.length; if (length > 64 * 1024 * 1024) req.destroy(new Error('FIXTURE_RESPONSE_LIMIT')); else chunks.push(chunk); });
        response.on('error', reject); response.on('end', () => {
          const bytes = Buffer.concat(chunks); let body: any; try { body = JSON.parse(bytes.toString()); } catch {}
          done({ status: response.statusCode!, bytes, body, headers: response.headers });
        });
      }); req.on('error', reject); req.on('timeout', () => req.destroy(new Error('FIXTURE_TIMEOUT'))); req.end(data);
    });
  }
  async function client(scopes = f.p.scopes, grants = f.p.grants) {
    const made = await id.core.create('human-fixture', { label: 'SYNTHETIC Phase8 ERP', scopes, grants }, ctx());
    const reply = await send('/integration/oauth/token', { app: 'identity', method: 'POST', authorization: basic(made.client.id, made.clientSecret),
      contentType: 'application/x-www-form-urlencoded', raw: new URLSearchParams({ grant_type: 'client_credentials', scope: scopes.join(' ') }).toString() });
    if (reply.status !== 200) throw new Error('FIXTURE_OAUTH_HTTP_FAILED');
    return { made, token: reply.body.access_token as string, reply };
  }
  function reset() {
    vi.restoreAllMocks();
    for (const [map, baseline] of [[f.rows, initial.rows], [f.docs, initial.docs], [f.batches, initial.batches], [f.summaries, initial.summaries]] as any[]) {
      map.clear(); for (const [k, v] of baseline) map.set(k, structuredClone(v));
    }
    bytes.clear(); for (const [k, v] of initial.bytes) bytes.set(k, Buffer.from(v));
    for (const source of ['BILLING', 'SUNAT'] as const) Object.assign(f.journals[source], { epoch: randomUUID(), head: 0n, floor: 0n, events: [] });
    f.store.records.clear(); f.store.leases.clear(); f.store.events.length = 0; f.store.audit.mockClear();
    f.changeStore.records.clear(); f.changeStore.audit.mockClear(); f.sunatRepo.audit.mockClear(); sourceStore.read.mockClear();
    id.store.clients.clear(); id.store.buckets.clear(); id.store.audits.length = 0; id.store.failAudit = false; id.store.down = false;
  }
  return { f, id, send, client, reset, close, sourceHash, bytes, sourceStore, artifactOwners, captureRepository, journals,
    get core() { return core; }, origins, tls,
    advance(ms: number) { f.advance(ms); id.advance(ms); },
    installInvoices(count: number) { for (let n = 2; n <= count; n++) {
      const row = sale('01', randomUUID()); row.number = BigInt(n); row.fullNumber = 'F001-' + String(n).padStart(8, '0');
      Object.assign(row.immutableSnapshot, { number: String(n).padStart(8, '0'), fullNumber: row.fullNumber }); installRow(row);
    } },
    async restartExporter(vault?: ExportVault) { await stop('exporter'); core = makeCore(vault); await startExporter(); },
    stopSunat: () => stop('sunat'), startSunat,
  };
}
