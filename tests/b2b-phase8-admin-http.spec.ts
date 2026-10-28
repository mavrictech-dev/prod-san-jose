import 'reflect-metadata';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {request} from 'node:https';
import type {IncomingHttpHeaders} from 'node:http';
import {Module} from '../services/b2b-api-service/node_modules/@nestjs/common';
import {NestFactory} from '../services/b2b-api-service/node_modules/@nestjs/core';
import type {NestExpressApplication} from '../services/b2b-api-service/node_modules/@nestjs/platform-express';
import type {AccessTokenClaims} from '../packages/contracts/src';
import {B2bSecurityError, type B2bPrincipal, type B2bIdentityScope} from '../packages/contracts/src/b2b-security';
import {B2bPrivateHttp} from '../packages/service-access/src/b2b';
import {Phase8AdminOwnerModule, type Phase8AdminOwnerExecutor} from '../packages/service-access/src/b2b-phase8-admin-http';
import {Phase8AdminCapabilities, phase8AdminPolicy, type Phase8AdminAction,
  type Phase8AdminDependencies} from '../packages/service-access/src/b2b-phase8-admin-wire';
import {B2bPhase8Admin, HttpPrivilegedOwner} from '../services/b2b-api-service/src/phase8-admin';
import {createB2bDraftApplication} from '../services/b2b-api-service/src/draft-application';
import {B2bReads} from '../services/b2b-api-service/src/read';
import {B2bCommands} from '../services/b2b-api-service/src/commands';
import type {B2bReceivedReads} from '../services/b2b-api-service/src/received';
import {B2bPhase8BillingAdmin, BillingPhase8AdminBindingOwner} from '../services/billing-service/src/b2b/phase8-admin';
import {StationAdminService} from '../services/billing-service/src/application/station-admin.service';
import {B2bPhase8FiscalAdmin} from '../services/sunat-service/src/b2b/phase8-admin';
import {FiscalConfigurationService} from '../services/sunat-service/src/application/fiscal-configuration.service';
import {SecretVault} from '../services/sunat-service/src/infrastructure/crypto/secret-vault';
import {b2bCertificates, fingerprint} from './b2b-tls.fixture';
import {FactuEzB2bOwnerAdminClient} from '../packages/b2b-sdk/src';

const uid = '10000000-0000-4000-8000-000000000001';
const branch = '20000000-0000-4000-8000-000000000001';
const point = '30000000-0000-4000-8000-000000000001';
const series = '40000000-0000-4000-8000-000000000001';
const foreignId = '90000000-0000-4000-8000-000000000001';
const binding = {issuerId:1, issuerRuc:'00000000001', environment:'BETA' as const,
  branchId:branch, pointId:point, seriesId:series, documentType:'01' as const};
const token = 'synthetic.delegated.admin';
const query = (value:Record<string, unknown> = binding) => '?' + new URLSearchParams(
  Object.entries(value).map(([key, value]) => [key, String(value)])).toString();
const input = () => ({binding, payload:{}});
const rpcBody = (action = 'MASTERS_READ', kind = 'USER') => ({kind, action, input:input()});

class AdminOwnerHarness {}
Module({})(AdminOwnerHarness);

// Only persistence is in memory. Authorization, binding resolution, projections,
// optimistic revision checks and owner errors run through the actual owner cores.
function fixture() {
  const now = Math.floor(Date.now() / 1000);
  const claims:AccessTokenClaims = {sub:uid, username:'synthetic-human', roles:['ADMIN'],
    permissions:['setup.manage', 'series.manage', 'sunat.configure'], scope:{kind:'GLOBAL'},
    authVersion:4, iss:'synthetic-identity', aud:'synthetic-owner', iat:now, exp:now + 3600};
  const principal:B2bPrincipal = {kind:'USER', clientId:'50000000-0000-4000-8000-000000000001',
    revision:1, subjectId:uid, userAuthRevision:4, environment:'BETA', bindings:[binding],
    scopes:[...new Set(Object.values(phase8AdminPolicy).map(value => value[0]))]};
  const identity = {authenticate:vi.fn(async (value:string, scopes:B2bIdentityScope[], kind:'USER'|'SERVICE') => {
    if (value !== token || kind !== 'USER' || scopes.some(scope => !principal.scopes.includes(scope)))
      throw new B2bSecurityError(401, 'INVALID_TOKEN');
    return structuredClone(principal);
  })};
  const authority = {authorize:vi.fn(async () => ({claims:structuredClone(claims),
    policyRevision:'synthetic-policy-1', stepUpVerified:true as const, expiresAt:Date.now() + 60000}))};
  const liveIdentity = {current:vi.fn(async () => structuredClone(claims))};
  const state:any = {
    companySettings:[{id:1, ruc:binding.issuerRuc, legalName:'SYNTHETIC ONE', taxAddress:'LOCAL',
      ubigeo:'200101', environment:'BETA', active:true, configVersion:1, contactEmails:[], secretHash:'NEVER_RETURN'},
      {id:2, ruc:'00000000002', legalName:'FOREIGN ISSUER', taxAddress:'OTHER', ubigeo:'200101',
        environment:'BETA', active:true, configVersion:1, contactEmails:[]}],
    branch:[{id:branch, companyId:1, code:'BR', name:'SYNTHETIC BRANCH', active:true, masterRevision:1},
      {id:foreignId, companyId:2, code:'OTHER', name:'FOREIGN BRANCH', active:true, masterRevision:1}],
    emissionPoint:[{id:point, companyId:1, branchId:branch, code:'POINT', name:'SYNTHETIC POINT', active:true, masterRevision:1}],
    seriesCounter:[{id:series, companyId:1, emissionPointId:point, documentType:'INVOICE', series:'F001',
      nextNumber:2n, active:true, masterRevision:1}], configurationAudit:[],
  };
  const matches = (row:any, where:any = {}) => Object.entries(where).every(([key, value]:any) =>
    value && typeof value === 'object' && 'in' in value ? value.in.includes(row[key]) : row[key] === value);
  const output = (row:any, args:any) => !row ? null : args.select
    ? Object.fromEntries(Object.keys(args.select).map(key => [key, structuredClone(row[key])]))
    : {...structuredClone(row), ...(args.include ? {_count:{emissionPoints:1, shifts:0, documents:1}} : {})};
  const tx:any = {$queryRawUnsafe:vi.fn(async () => [])};
  for (const table of Object.keys(state)) tx[table] = {
    findUnique:vi.fn(async (args:any) => output(state[table].find((row:any) => matches(row, args.where)), args)),
    findUniqueOrThrow:vi.fn(async (args:any) => {
      const row = state[table].find((row:any) => matches(row, args.where));
      if (!row) throw new Error('SYNTHETIC_ROW_MISSING');
      return output(row, args);
    }),
    findMany:vi.fn(async (args:any) => state[table].filter((row:any) => matches(row, args.where)).map((row:any) => output(row, args))),
    update:vi.fn(async (args:any) => {
      const row = state[table].find((row:any) => matches(row, args.where));
      if (!row) throw new Error('SYNTHETIC_ROW_MISSING');
      for (const [key, value] of Object.entries(args.data) as any)
        row[key] = value && typeof value === 'object' && 'increment' in value ? row[key] + value.increment : value;
      return output(row, args);
    }),
    create:vi.fn(async (args:any) => {state[table].push(structuredClone(args.data)); return structuredClone(args.data);}),
  };
  const prisma:any = {...tx, $transaction:vi.fn(async (work:any) => {
    const saved = structuredClone(state);
    try {return await work(tx);} catch (error) {Object.assign(state, saved); throw error;}
  })};
  const deps:Phase8AdminDependencies = {identity, authority, liveIdentity, enabled:true,
    bindingOwner:new BillingPhase8AdminBindingOwner(prisma)};
  const station = new StationAdminService(prisma);
  const billingOwners:{masters?:StationAdminService} = {masters:station};
  const billing = new B2bPhase8BillingAdmin(deps, billingOwners);

  // Synthetic stored metadata only; readiness/audit never decrypt or inspect it.
  const fiscalRow = {issuerRuc:binding.issuerRuc, environment:'BETA', revision:4,
    updatedAt:new Date('2026-01-01T00:00:00Z'), certificateCipher:'NEVER_RETURN_CERTIFICATE_CIPHER',
    certificateStorageKey:'NEVER_RETURN_STORAGE_KEY', certificateFingerprint:'a'.repeat(64),
    certificateExpiresAt:new Date('2099-01-01T00:00:00Z'), certificateSelfSigned:true,
    solUsernameCipher:'NEVER_RETURN_SOL_USER', solPasswordCipher:'NEVER_RETURN_SOL_PASSWORD',
    greClientIdCipher:'NEVER_RETURN_GRE_ID', greClientSecretCipher:'NEVER_RETURN_GRE_SECRET'};
  const fiscalAudits = Array.from({length:12}, (_, index) => ({id:`synthetic-audit-${index + 1}`,
    issuerRuc:binding.issuerRuc, environment:'BETA', actorId:uid, fields:['sol'], revision:12 - index,
    occurredAt:new Date(Date.UTC(2026, 0, 12 - index)), privateDetail:'NEVER_RETURN_AUDIT_DETAIL'}));
  const foreignAudit = {...fiscalAudits[0], id:'foreign-audit', issuerRuc:'00000000002'};
  const auditRows = [...fiscalAudits, foreignAudit];
  const fiscalDb:any = {sunatCredentials:{findUnique:vi.fn(async (args:any) =>
    matches(fiscalRow, args.where.issuerRuc_environment) ? structuredClone(fiscalRow) : null)},
    fiscalConfigurationAudit:{
      count:vi.fn(async (args:any) => auditRows.filter(row => matches(row, args.where)).length),
      findMany:vi.fn(async (args:any) => auditRows.filter(row => matches(row, args.where))
        .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
        .slice(args.skip, args.skip + args.take).map(row => output(row, args))),
    }, $transaction:vi.fn(async (work:any[]) => Promise.all(work))};
  const caps = new Phase8AdminCapabilities(), vault = new SecretVault();
  const seal = vi.spyOn(vault, 'seal'), open = vi.spyOn(vault, 'open');
  const inspector = {inspect:vi.fn(async () => {throw new Error('CERTIFICATE_INSPECTION_FORBIDDEN');})};
  const fiscalService = FiscalConfigurationService.createWithOwnerContext(fiscalDb, vault, inspector as never, caps);
  const fiscal = new B2bPhase8FiscalAdmin(deps, fiscalService, caps);
  return {claims, principal, identity, authority, liveIdentity, deps, state, tx, station, billingOwners,
    billing, fiscal, fiscalDb, fiscalRow, fiscalAudits, fiscalService, seal, open, inspector};
}

type Reply = {status:number; body:any; headers:IncomingHttpHeaders; text:string};
describe('phase8 privileged admin: draft HTTPS mTLS facade to real owners over fixed private RPC', () => {
  let tls:ReturnType<typeof b2bCertificates>, f:ReturnType<typeof fixture>;
  let app:Awaited<ReturnType<typeof createB2bDraftApplication>>;
  let listeners:Array<{close():Promise<void>}> = [];
  let port:number, billingPort:number, fiscalPort:number;
  let billingHttp:B2bPrivateHttp, billingRemote:HttpPrivilegedOwner;
  let billingExecute:ReturnType<typeof vi.spyOn>, fiscalExecute:ReturnType<typeof vi.spyOn>;
  let forbidden:ReturnType<typeof vi.fn>, fetchGuard:ReturnType<typeof vi.fn>;

  beforeAll(() => {tls = b2bCertificates();}, 30000);
  beforeEach(async () => {
    vi.stubEnv('STATION_MASTER_CRUD_ENABLED', 'true');
    fetchGuard = vi.fn(() => {throw new Error('EXTERNAL_NETWORK_FORBIDDEN');});
    vi.stubGlobal('fetch', fetchGuard);
    f = fixture(); listeners = [];
    billingExecute = vi.spyOn(f.billing, 'execute'); fiscalExecute = vi.spyOn(f.fiscal, 'execute');
    const serverTls = {ca:tls.ca, cert:tls.server, key:tls.key};
    const startOwner = async (core:Phase8AdminOwnerExecutor, actions:Phase8AdminAction[]) => {
      const owner = await NestFactory.create<NestExpressApplication>({module:AdminOwnerHarness,
        imports:[Phase8AdminOwnerModule.isolated(core, actions, [fingerprint(tls.resource)])]},
      {logger:false, bodyParser:false, httpsOptions:{...serverTls, requestCert:true, rejectUnauthorized:true}});
      listeners.push(owner);
      owner.useBodyParser('json', {limit:'1mb'});
      await owner.listen(0, '127.0.0.1');
      return owner.getHttpServer().address().port as number;
    };
    billingPort = await startOwner(f.billing, ['MASTERS_READ', 'ISSUER_UPDATE']);
    fiscalPort = await startOwner(f.fiscal, ['FISCAL_READ', 'FISCAL_AUDIT']);
    const client = (ownerPort:number) => new B2bPrivateHttp(`https://127.0.0.1:${ownerPort}`,
      {ca:tls.ca, cert:tls.resource, key:tls.key});
    billingHttp = client(billingPort); billingRemote = new HttpPrivilegedOwner(billingHttp);
    const absent = {execute:async () => {throw new B2bSecurityError(503, 'ADMIN_OWNER_UNAVAILABLE');}};
    const privileged = new B2bPhase8Admin(f.identity, {billing:billingRemote,
      fiscal:new HttpPrivilegedOwner(client(fiscalPort)), identity:absent, smtp:absent});
    forbidden = vi.fn(async () => {throw new Error('UNCONFIGURED_ROUTE');});
    const unused = {execute:forbidden, file:forbidden};
    const received = {list:forbidden, detail:forbidden, artifacts:forbidden, content:forbidden} as unknown as B2bReceivedReads;
    app = await createB2bDraftApplication(new B2bReads(f.identity, unused as never, unused as never),
      new B2bCommands(f.identity, unused as never), [fingerprint(tls.edge)], serverTls,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, {received, privileged});
    listeners.push(app); await app.listen(0, '127.0.0.1'); port = app.getHttpServer().address().port;
  }, 30000);
  afterEach(async () => {
    try {
      await Promise.all(listeners.map(listener => listener.close()));
      expect(fetchGuard).not.toHaveBeenCalled(); expect(forbidden).not.toHaveBeenCalled();
      expect(f.seal).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
      expect(f.inspector.inspect).not.toHaveBeenCalled();
    } finally {vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();}
  });
  function send(path:string, options:{target?:number; cert?:Buffer|null; kind?:string; method?:string; body?:unknown} = {}):Promise<Reply> {
    const bytes = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
    return new Promise((resolve, reject) => {
      const req = request({hostname:'127.0.0.1', port:options.target ?? port, path,
        method:options.method ?? 'GET', ca:tls.ca, rejectUnauthorized:true, agent:false,
        ...(options.cert === null ? {} : {cert:options.cert ?? tls.edge, key:tls.key}),
        headers:{Authorization:'Bearer ' + token, 'X-FactuEz-Actor-Kind':options.kind ?? 'USER',
          ...(bytes ? {'Content-Type':'application/json', 'Content-Length':String(bytes.length)} : {})}}, res => {
        const chunks:Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
        res.on('end', () => {try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({status:res.statusCode!, headers:res.headers, text, body:JSON.parse(text)});
        } catch (error) {reject(error);}});
      });
      req.setTimeout(5000, () => req.destroy(new Error('LOOPBACK_TEST_TIMEOUT')));
      req.on('error', reject); req.end(bytes);
    });
  }
  const rpc = (body:unknown, cert?:Buffer) => send('/internal/b2b/owner-admin',
    {target:billingPort, cert:cert ?? tls.resource, method:'POST', body});
  function headers(reply:Reply) {
    expect(reply.headers['cache-control']).toBe('private, no-store');
    expect(reply.headers['x-content-type-options']).toBe('nosniff');
    expect(reply.headers['content-type']).toMatch(/^application\/json/);
  }
  function denied(reply:Reply, status:number, code:string) {
    expect(reply.status).toBe(status); headers(reply);
    expect(reply.body).toEqual({schemaVersion:'factuez.b2b.v1', requestId:expect.any(String),
      code, message:code, retryable:status === 503 || status === 429});
    expect(reply.body.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(reply.text).not.toMatch(/NEVER_RETURN|synthetic\.delegated|stack|password|Cipher|StorageKey/);
  }
  function envelope(reply:Reply, action:Phase8AdminAction) {
    expect(reply.status).toBe(200); headers(reply);
    expect(reply.body).toMatchObject({schemaVersion:'factuez.b2b.owner-admin.v1', action, binding,
      candidateOnly:true, environment:'BETA', fiscalExecutionEnabled:false});
    expect(reply.text).not.toMatch(/NEVER_RETURN|FOREIGN|secretHash|Cipher|StorageKey|privateDetail/);
  }

  it('public owner SDK reads real catalogue/readiness/audit and performs a revision-checked master update',async()=>{
    // Persisted audit IDs are UUIDs; keep this in-memory owner fixture realistic.
    f.fiscalAudits.forEach((row,i)=>row.id=`60000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`);
    const sdk=new FactuEzB2bOwnerAdminClient({origin:'https://127.0.0.1:'+port,
      tls:{ca:tls.ca,cert:tls.edge,key:tls.key,serverCertificateSha256:fingerprint(tls.server)},
      bearer:async()=>({token,actorKind:'USER'})});
    const masters=await sdk.readMasters(binding);expect(masters.data.companies.map(x=>x.id)).toEqual([1]);
    expect((await sdk.readFiscalConfiguration(binding)).data).toMatchObject({revision:4,fiscalTransmission:false,certificate:{configured:true,trustAndRucVerified:false}});
    expect((await sdk.readFiscalAudit(binding,'2')).data).toMatchObject({page:2,total:12});
    const updated=await sdk.updateIssuer(binding,{expectedRevision:1,legalName:'SYNTHETIC SDK NAME'});
    expect(updated.data).toMatchObject({legalName:'SYNTHETIC SDK NAME',revision:2});
    expect(f.state.configurationAudit).toHaveLength(1);
    await expect(sdk.updateIssuer(binding,{expectedRevision:1,legalName:'STALE SDK NAME'})).rejects.toMatchObject({code:'REMOTE_REQUEST_FAILED',status:409});
  });
  it('GET masters uses the actual scoped catalogue and exact fixed RPC payload', async () => {
    const post = vi.spyOn(billingHttp, 'post');
    const reply = await send('/b2b/v1/admin/masters' + query()); envelope(reply, 'MASTERS_READ');
    expect(reply.body.data.companies).toEqual([expect.objectContaining({id:1, ruc:binding.issuerRuc, revision:1})]);
    expect(reply.body.data.branches).toEqual([expect.objectContaining({id:branch})]);
    expect(reply.body.data.emissionPoints).toEqual([expect.objectContaining({id:point})]);
    expect(reply.body.data.series).toEqual([expect.objectContaining({id:series, nextNumber:'2', canRename:false})]);
    expect(post).toHaveBeenCalledExactlyOnceWith('/internal/b2b/owner-admin', rpcBody(), token);
    expect(billingExecute).toHaveBeenCalledExactlyOnceWith({token, kind:'USER'}, 'MASTERS_READ', input());
    expect(fiscalExecute).not.toHaveBeenCalled();
  });
  it('GET readiness projects real fiscal metadata without opening stored secrets', async () => {
    const reply = await send('/b2b/v1/admin/fiscal-config/1/readiness' + query()); envelope(reply, 'FISCAL_READ');
    expect(reply.body.data).toMatchObject({ruc:binding.issuerRuc, revision:4, solConfigured:true,
      greConfigured:true, fiscalTransmission:false, certificate:{configured:true, selfSigned:true, trustAndRucVerified:false}});
    expect(f.fiscalDb.sunatCredentials.findUnique).toHaveBeenCalledWith({where:{issuerRuc_environment:{issuerRuc:binding.issuerRuc, environment:'BETA'}}});
    expect(billingExecute).not.toHaveBeenCalled();
  });
  it('GET fiscal audit forwards page 2 and preserves owner pagination and issuer scope', async () => {
    const reply = await send('/b2b/v1/admin/fiscal-config/1/audit' + query({...binding, page:2})); envelope(reply, 'FISCAL_AUDIT');
    expect(reply.body.data).toMatchObject({page:2, pageSize:10, total:12});
    expect(reply.body.data.items).toEqual(f.fiscalAudits.slice(10).map(({id, actorId, fields, revision, occurredAt}) =>
      ({id, actorId, fields, revision, occurredAt:occurredAt.toISOString()})));
    expect(f.fiscalDb.fiscalConfigurationAudit.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where:{issuerRuc:binding.issuerRuc, environment:'BETA'}, skip:10, take:10}));
  });
  it('private fiscal RPC independently executes real audit pagination with the opaque owner capability', async () => {
    const reply = await send('/internal/b2b/owner-admin', {target:fiscalPort, cert:tls.resource,
      method:'POST', body:{kind:'USER', action:'FISCAL_AUDIT', input:{binding, payload:{page:'2'}}}});
    expect(reply.status).toBe(200); headers(reply);
    expect(reply.body).toEqual({candidateOnly:true, environment:'BETA', fiscalExecutionEnabled:false,
      data:{ruc:binding.issuerRuc, environment:'BETA', page:2, pageSize:10, total:12,
        items:f.fiscalAudits.slice(10).map(({id, actorId, fields, revision, occurredAt}) =>
          ({id, actorId, fields, revision, occurredAt:occurredAt.toISOString()}))}});
    expect(fiscalExecute).toHaveBeenCalledExactlyOnceWith({token, kind:'USER'}, 'FISCAL_AUDIT', {binding, payload:{page:'2'}});
    expect(reply.text).not.toMatch(/NEVER_RETURN|foreign-audit|Cipher|StorageKey/);
  });
  it('private fiscal RPC rejects invalid audit pages in the real owner before querying persistence', async () => {
    const reply = await send('/internal/b2b/owner-admin', {target:fiscalPort, cert:tls.resource,
      method:'POST', body:{kind:'USER', action:'FISCAL_AUDIT', input:{binding, payload:{page:'0'}}}});
    expect(reply.status).toBe(400); headers(reply); expect(reply.body).toEqual({code:'ADMIN_REQUEST_DENIED'});
    expect(f.fiscalDb.fiscalConfigurationAudit.count).not.toHaveBeenCalled();
    expect(f.fiscalDb.fiscalConfigurationAudit.findMany).not.toHaveBeenCalled();
  });
  it('defaults fiscal audit to page 1', async () => {
    const reply = await send('/b2b/v1/admin/fiscal-config/1/audit' + query()); envelope(reply, 'FISCAL_AUDIT');
    expect(reply.body.data).toMatchObject({page:1, pageSize:10, total:12}); expect(reply.body.data.items).toHaveLength(10);
    expect(fiscalExecute).toHaveBeenCalledWith({token, kind:'USER'}, 'FISCAL_AUDIT', {binding, payload:{page:'1'}});
  });
  it.each(['0', '-1', 'abc', '1000000'])('fails closed on invalid fiscal audit page %s', async page => {
    denied(await send('/b2b/v1/admin/fiscal-config/1/audit' + query({...binding, page})), 400, 'OWNER_REQUEST_DENIED');
    expect(f.fiscalDb.fiscalConfigurationAudit.findMany).not.toHaveBeenCalled();
  });
  it('PATCH issuer commits the actual CAS/audit and rejects a stale revision without a second write', async () => {
    const path = '/b2b/v1/admin/issuers/1' + query();
    const reply = await send(path, {method:'PATCH', body:{expectedRevision:1, legalName:'UPDATED SYNTHETIC'}});
    envelope(reply, 'ISSUER_UPDATE'); expect(reply.body.data).toMatchObject({id:1, revision:2, legalName:'UPDATED SYNTHETIC'});
    expect(f.state.configurationAudit).toEqual([expect.objectContaining({actorId:uid, action:'issuer.updated'})]);
    denied(await send(path, {method:'PATCH', body:{expectedRevision:1, legalName:'STALE'}}), 409, 'OWNER_REQUEST_DENIED');
    expect(f.tx.companySettings.update).toHaveBeenCalledTimes(1); expect(f.state.configurationAudit).toHaveLength(1);
    const read = await send('/b2b/v1/admin/masters' + query()); envelope(read, 'MASTERS_READ');
    expect(read.body.data.companies[0]).toMatchObject({revision:2, legalName:'UPDATED SYNTHETIC'});
  });
  it('rejects SERVICE on public reads and writes before identity or owner dispatch', async () => {
    denied(await send('/b2b/v1/admin/masters' + query(), {kind:'SERVICE'}), 403, 'DELEGATED_HUMAN_REQUIRED');
    denied(await send('/b2b/v1/admin/issuers/1' + query(), {kind:'SERVICE', method:'PATCH',
      body:{expectedRevision:1, legalName:'FORBIDDEN'}}), 403, 'DELEGATED_HUMAN_REQUIRED');
    expect(f.identity.authenticate).not.toHaveBeenCalled(); expect(billingExecute).not.toHaveBeenCalled();
    expect(f.state.configurationAudit).toEqual([]);
  });
  it.each([{issuerRuc:'00000000002'}, {branchId:foreignId}, {seriesId:foreignId}])('rejects foreign binding %j before RPC', async foreign => {
    denied(await send('/b2b/v1/admin/masters' + query({...binding, ...foreign})), 404, 'RESOURCE_NOT_FOUND');
    expect(billingExecute).not.toHaveBeenCalled();
  });
  it('rejects issuer path/query mismatch before fiscal owner dispatch', async () => {
    denied(await send('/b2b/v1/admin/fiscal-config/2/readiness' + query()), 404, 'RESOURCE_NOT_FOUND');
    expect(fiscalExecute).not.toHaveBeenCalled(); expect(f.identity.authenticate).not.toHaveBeenCalled();
  });
  it('rejects an issuer changed in the actual binding catalogue despite an unchanged delegated token', async () => {
    f.state.companySettings[0].ruc = '00000000002'; const catalog = vi.spyOn(f.station, 'catalog');
    denied(await send('/b2b/v1/admin/masters' + query()), 403, 'OWNER_REQUEST_DENIED');
    expect(billingExecute).toHaveBeenCalledOnce(); expect(catalog).not.toHaveBeenCalled();
  });
  it('rejects live human revocation before accessing fiscal data', async () => {
    f.claims.authVersion++;
    denied(await send('/b2b/v1/admin/fiscal-config/1/readiness' + query()), 403, 'OWNER_REQUEST_DENIED');
    expect(f.fiscalDb.sunatCredentials.findUnique).not.toHaveBeenCalled();
  });
  it('suppresses a real owner result when the human is revoked during the read', async () => {
    f.fiscalDb.sunatCredentials.findUnique.mockImplementation(async () => {
      f.claims.authVersion++; return structuredClone(f.fiscalRow);
    });
    const reply = await send('/b2b/v1/admin/fiscal-config/1/readiness' + query());
    denied(reply, 403, 'OWNER_REQUEST_DENIED'); expect(reply.body).not.toHaveProperty('data');
  });
  it('revalidates the public identity after the actual RPC result', async () => {
    const execute = billingRemote.execute.bind(billingRemote);
    vi.spyOn(billingRemote, 'execute').mockImplementation(async (...args) => {
      const result = await execute(...args); f.principal.revision++; return result;
    });
    denied(await send('/b2b/v1/admin/masters' + query()), 401, 'ACCESS_CHANGED');
    expect(billingExecute).toHaveBeenCalledOnce();
  });
  it('rejects a CA-signed but unlisted public peer', async () => {
    denied(await send('/b2b/v1/admin/masters' + query(), {cert:tls.other}), 403, 'PRIVATE_PEER_REQUIRED');
    expect(f.identity.authenticate).not.toHaveBeenCalled(); expect(billingExecute).not.toHaveBeenCalled();
  });
  it('requires client certificates at both HTTPS listeners', async () => {
    await expect(send('/b2b/v1/admin/masters' + query(), {cert:null})).rejects.toThrow();
    await expect(send('/internal/b2b/owner-admin', {target:billingPort, cert:null, method:'POST', body:rpcBody()})).rejects.toThrow();
    expect(billingExecute).not.toHaveBeenCalled();
  });
  it('rejects a CA-signed but unlisted private RPC peer', async () => {
    const reply = await rpc(rpcBody(), tls.other); expect(reply.status).toBe(403); headers(reply);
    expect(reply.body).toEqual({code:'ADMIN_REQUEST_DENIED'}); expect(billingExecute).not.toHaveBeenCalled();
  });
  it.each([rpcBody('MASTERS_READ', 'SERVICE'), rpcBody('FISCAL_READ'), rpcBody('ARBITRARY_ACTION'),
    {...rpcBody(), claims:{roles:['ADMIN']}}])('RPC denies SERVICE, unlisted actions and forged envelopes: %j', async body => {
    const reply = await rpc(body); expect(reply.status).toBe(403); headers(reply);
    expect(reply.body).toEqual({code:'ADMIN_REQUEST_DENIED'}); expect(billingExecute).not.toHaveBeenCalled();
  });
  it('does not fabricate success when the actual master owner is absent', async () => {
    delete f.billingOwners.masters;
    denied(await send('/b2b/v1/admin/masters' + query()), 503, 'OWNER_REQUEST_DENIED');
    expect(billingExecute).toHaveBeenCalledOnce(); expect(f.tx.companySettings.findMany).not.toHaveBeenCalled();
  });
  it('sanitizes internal exceptions at both private RPC and public HTTP boundaries', async () => {
    vi.spyOn(f.station, 'catalog').mockRejectedValue(new Error('NEVER_RETURN_PASSWORD_CIPHER_KEY_PATH_STACK'));
    denied(await send('/b2b/v1/admin/masters' + query()), 503, 'OWNER_REQUEST_DENIED');
    const reply = await rpc(rpcBody()); expect(reply.status).toBe(503); headers(reply);
    expect(reply.body).toEqual({code:'ADMIN_OWNER_UNAVAILABLE'}); expect(reply.text).not.toContain('NEVER_RETURN');
  });
  it('rejects an owner response that tries to enable fiscal execution', async () => {
    vi.spyOn(billingRemote, 'execute').mockResolvedValue({candidateOnly:true, data:{}, environment:'BETA', fiscalExecutionEnabled:true});
    denied(await send('/b2b/v1/admin/masters' + query()), 503, 'INVALID_ADMIN_OWNER_RESPONSE');
  });
  it.each(['?environment=BETA', query() + '&issuerId=1', query() + '&page=2'])('rejects malformed public query %s', async suffix => {
    denied(await send('/b2b/v1/admin/masters' + suffix), 400, 'INVALID_QUERY');
    expect(billingExecute).not.toHaveBeenCalled();
  });
  it('rejects caller-supplied binding authority in the mutation payload', async () => {
    denied(await send('/b2b/v1/admin/issuers/1' + query(), {method:'PATCH',
      body:{binding, expectedRevision:1, legalName:'FORGED'}}), 400, 'INVALID_ADMIN_PAYLOAD');
    expect(billingExecute).not.toHaveBeenCalled(); expect(f.state.configurationAudit).toEqual([]);
  });
});
