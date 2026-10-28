import 'reflect-metadata';
import { NestFactory } from '../services/sunat-service/node_modules/@nestjs/core';
import { BatchMemberEvidenceModule } from '../services/sunat-service/src/b2b/batch-member-evidence-http';
import { createPrismaBatchMemberLedgerReader } from '../services/sunat-service/src/b2b/batch-member-evidence-assembly';
import { HttpBatchMemberEvidence } from '../services/billing-service/src/b2b/batch-member-evidence-http';
import { billingAuthoritySchema } from '../services/billing-service/src/b2b/host-permissions-wire';

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

async function builtinSetup(){
  for(const k of envKeys)vi.stubEnv(k,undefined);
  const {config,credentials}=configuration(),order:string[]=[],deps=await suppliedOwners(order);
  credentials.authorityTls={ca:pki.ca,cert:pki.other,key:pki.key};
  config.builtin={identityServerSha256:fingerprint(pki.server),fiscalServerSha256:fingerprint(pki.server),masterBindings:[binding],batchPolicyBindings:[{
    anchor:binding,member:{environment:'BETA',issuerRuc:binding.issuerRuc,companyId:binding.issuerId,branchId:binding.branchId,pointId:binding.pointId,seriesId:binding.seriesId,documentType:binding.documentType,series:'F001'}}]};
  const remoteCalls:{path:string;peer:string}[]=[];
  // Explicit fictitious remote status/data only. Actual OIDC/MFA authority execution
  // is independently exercised in b2b-batch-policy-administration.spec.ts.
  const identity=createServer({ca:pki.ca,cert:pki.server,key:pki.key,requestCert:true,rejectUnauthorized:true},async(req,res)=>{
    const peer=(req.socket as any).getPeerCertificate().fingerprint256.replace(/:/g,'').toLowerCase();remoteCalls.push({path:req.url!,peer});
    const chunks:Buffer[]=[];for await(const b of req)chunks.push(Buffer.from(b));const body=JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','private, no-store');
    if(req.url==='/internal/b2b/owner-authority/status'&&peer===fingerprint(pki.other))res.end(JSON.stringify({schemaVersion:'factuez.b2b.owner-authority.v1',environment:'BETA',owner:'billing',state:'ASSEMBLED'}));
    else if(req.url==='/internal/b2b/billing-authority'&&peer===fingerprint(pki.other)&&body.action==='STATUS')res.end(JSON.stringify({schemaVersion:billingAuthoritySchema,environment:'BETA',state:'ASSEMBLED'}));
    else if(req.url==='/internal/b2b/introspect'&&peer===fingerprint(pki.resource)){
      try{res.end(JSON.stringify(await deps.f.identity.authenticate(String(req.headers.authorization).slice(7),body.requiredScopes,body.kind)));}catch{res.statusCode=403;res.end('{}');}
    }else{res.statusCode=403;res.end('{}');}
  });
  await new Promise<void>(r=>identity.listen(0,'127.0.0.1',r));cleanup.push(()=>new Promise<void>((r,j)=>identity.close(e=>e?j(e):r())));
  config.identityOrigin='https://127.0.0.1:'+(identity.address() as any).port;
  let schema=true;const queries:string[]=[];
  const crypto:any={artifacts:{read:deny},certificates:{load:deny},trust:{evaluate:deny},cdr:{verify:deny}};
  const reader=createPrismaBatchMemberLedgerReader({$queryRawUnsafe:async(sql:string)=>{
    queries.push(sql);if(!schema)throw Error('FICTITIOUS_SCHEMA_MISSING');
    if(!sql.startsWith('SELECT owner_handle,document_id,version,snapshot_sha256,payload,payload_sha256 FROM b2b_sunat_batch_member_evidence_version WHERE '))throw Error('UNEXPECTED_SQL');
    return [];
  }} as any,crypto);
  const fiscal=await NestFactory.create(BatchMemberEvidenceModule.isolated(reader,{billing:[fingerprint(pki.resource)]}),{logger:false,httpsOptions:{ca:pki.ca,cert:pki.server,key:pki.key,requestCert:true,rejectUnauthorized:true}});
  await fiscal.listen(0,'127.0.0.1');cleanup.push(()=>fiscal.close());config.fiscalOrigin='https://127.0.0.1:'+fiscal.getHttpServer().address().port;
  return {config,credentials,order,deps,remoteCalls,reader,queries,setSchema:(v:boolean)=>{schema=v;}};
}
describe('Billing builtin executable composition and exact SUNAT ledger reader',()=>{
  it('starts with actual builtin ports and wrappers, serves read01 and closes in owner order',async()=>{
    const x=await builtinSetup(),host=await startBillingB2bHost(x.config,x.credentials,undefined,x.deps.owners);cleanup.push(host.close);
    expect(x.remoteCalls.filter(c=>c.path.includes('authority')).every(c=>c.peer===fingerprint(pki.other))).toBe(true);
    expect(x.queries.every(q=>q.endsWith('WHERE false'))).toBe(true);
    const port=host.app.getHttpServer().address().port;
    const catalog=await post(port,'/internal/b2b/read',{kind:'SERVICE',action:'catalog',args:{environment:'BETA'}},x.deps.f.token);
    expect(catalog.status).toBe(200);expect(catalog.body.items).toHaveLength(1);
    await expect(host.runtime.cores.batches.owner.setLocalGrant('caller-boolean-is-not-a-handle',{} as any)).rejects.toBeDefined();
    const status=await post(port,'/internal/b2b/runtime-status',{});expect(status.status).toBe(200);expect(status.body.fiscalActivation).toBe(false);
    await host.close();expect(x.order).toEqual(['storage-init','status-start','publisher-close','consumer-close','prisma-close']);
    expect(process.env.DATABASE_URL).toBeUndefined();
  });
  it('reports read-only original coverage, never a completed history source, and rejects absent handles',async()=>{
    const x=await builtinSetup(),client=new HttpBatchMemberEvidence({enabled:true,origin:x.config.fiscalOrigin,sunatPeerSha256:fingerprint(pki.server),tls:x.credentials.fiscalTls});
    const result=await client.readiness();expect(result).toMatchObject({state:'EXACT_LEDGER_READ_ONLY',supportedDocumentTypes:['01','03'],sourceCapture:'NOT_ASSEMBLED',noteHistory:'UNAVAILABLE'});
    await expect(client.verifySignedVersion('unknown-exact-version',new Date().toISOString())).rejects.toMatchObject({code:'BATCH_EVIDENCE_VERSION_MISSING'});
    expect(x.queries.some(q=>q.endsWith('WHERE owner_handle=$1'))).toBe(true);
  });
  it('does not start storage/consumer/listeners if the actual ledger schema is unavailable',async()=>{
    const x=await builtinSetup();x.setSchema(false);
    await expect(startBillingB2bHost(x.config,x.credentials,undefined,x.deps.owners)).rejects.toThrow('AUTHORITY_INFRASTRUCTURE_UNAVAILABLE');
    expect(x.deps.owners.initializeStorage).not.toHaveBeenCalled();expect(x.deps.owners.startStatusConsumer).not.toHaveBeenCalled();expect(process.env.DATABASE_URL).toBeUndefined();
  });
  it('rejects missing builtin mount, wrong pins, reused authority certificate and foreign policy boundaries',async()=>{
    const x=await builtinSetup();
    expect(()=>requireBuiltinBillingHostImplementations({...x.config,builtin:undefined},x.credentials,x.deps.db)).toThrow();
    const bad=structuredClone(x.config);bad.builtin!.identityServerSha256=fingerprint(pki.edge);
    const adapters=requireBuiltinBillingHostImplementations(bad,x.credentials,x.deps.db);
    await expect(adapters.assertInfrastructure()).rejects.toBeDefined();await adapters.close();
    expect(()=>validateBillingHostCredentials({...x.credentials,authorityTls:x.credentials.identityTls})).toThrow();
    const foreign=structuredClone(x.config);foreign.builtin!.batchPolicyBindings[0].member.seriesId=randomUUID();expect(()=>validateBillingHostConfig(foreign)).toThrow();
  });
  it('registers policy command under the runtime drain and refuses it while commands are paused',async()=>{
    const x=await builtinSetup(),host=await startBillingB2bHost(x.config,x.credentials,undefined,x.deps.owners);cleanup.push(host.close);
    const port=host.app.getHttpServer().address().port;
    const unauth=await post(port,'/internal/b2b/batch-policy',{policy:{}});expect(unauth.status).toBe(401);
    host.runtime.lifecycle.ownerDrain.pauseCommands();
    const paused=await post(port,'/internal/b2b/batch-policy',{policy:{}},'synthetic-not-authorized');expect(paused.status).toBe(503);
  });
});
