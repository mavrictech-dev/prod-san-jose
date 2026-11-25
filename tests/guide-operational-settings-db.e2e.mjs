// Real PostgreSQL and HTTP, isolated synthetic-only. No existing database or application config.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes, randomUUID, generateKeyPairSync, createSign } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { Duplex } from 'node:stream';
import { createServer } from 'node:http';

if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--isolated-synthetic-only'])) throw Error('ISOLATED_SYNTHETIC_ONLY_REQUIRED');
const root = fileURLToPath(new URL('..', import.meta.url));
const serviceRoot = path.join(root, 'services/billing-service');
const local = createRequire(path.join(serviceRoot, 'package.json'));
local('reflect-metadata');
const { PrismaClient } = local('./dist/generated/prisma/client');
const { PrismaPg } = local('@prisma/adapter-pg');
const { Pool } = local('pg');
const { GuideOperationalSettingsService } = local('./dist/application/guide-operational-settings.service');
const { GuideOperationalSettingsController } = local('./dist/guide-operational-settings.controller');
const { JwtPermissionGuard } = local('./dist/auth/jwt-permission.guard');
const { NestFactory, Reflector } = local('@nestjs/core');
const { Module } = local('@nestjs/common');
const nonce = randomBytes(5).toString('hex');
const databaseName = `factuez_guide_settings_${nonce}`, networkName = `factuez-guide-settings-net-${nonce}`;
const password = randomBytes(24).toString('hex');
let containerId, networkId, client, pool, app, identity, temp, stage = 'INIT';
const passed = [], output = path.join(root, 'output/guide-settings');
mkdirSync(output, { recursive: true });
function command(args, input = '') {
  const result = spawnSync('docker', args, { input, encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  assert.ok(!result.error && result.status === 0, `ISOLATED_COMMAND_FAILED_${stage}`); return result.stdout.trim();
}
function sql(statement) {
  assert.match(containerId, /^[a-f0-9]{64}$/); assert.match(databaseName, /^factuez_guide_settings_[a-f0-9]{10}$/);
  return command(['exec', '-i', containerId, 'psql', '-U', 'postgres', '-d', databaseName, '-X', '-v', 'ON_ERROR_STOP=1', '-At'], statement);
}
class IsolatedPgStream extends Duplex {
  constructor() { super({ allowHalfOpen: false }); }
  setNoDelay() { return this; } setKeepAlive() { return this; } ref() { return this; } unref() { return this; }
  connect(port, host) {
    assert.equal(port, 5432); assert.equal(host, '127.0.0.1'); assert.match(containerId, /^[a-f0-9]{64}$/);
    this.child = spawn('docker', ['exec', '-i', containerId, 'nc', '127.0.0.1', '5432'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.child.stdout.on('data', bytes => { if (!this.push(bytes)) this.child.stdout.pause(); });
    this.child.stdout.on('end', () => this.push(null));
    this.child.on('error', () => this.destroy(Error('ISOLATED_STREAM_ERROR')));
    this.child.stdin.on('error', () => this.destroy(Error('ISOLATED_STREAM_ERROR')));
    this.child.once('spawn', () => this.emit('connect')); return this;
  }
  _read() { this.child?.stdout.resume(); }
  _write(bytes, encoding, callback) { this.child.stdin.write(bytes, encoding, callback); }
  _final(callback) { this.child.stdin.end(callback); }
  _destroy(error, callback) { this.child?.kill(); callback(error); }
}
async function check(label, work) { stage = label; await work(); passed.push(label); }
const actorId = randomUUID();
const point = () => ({ address: 'Dirección ficticia 123', ubigeo: '150101', department: 'Lima', province: 'Lima', district: 'Lima', establishmentCode: '0001' });
const draft = (role = 'AMBOS') => ({ expectedRevision: 0, settings: { role, products: [{ id: randomUUID(), name: 'Diésel B5 S-50 sintético', type: 'FUEL', unit: 'GLL', commercialCode: 'TEST-ONLY' }], routes: [{ id: randomUUID(), name: 'Ruta sintética', origin: point(), destination: { ...point(), address: 'Destino ficticio 456' } }] } });
try {
  stage = 'CREATE_INTERNAL_NETWORK';
  networkId = command(['network', 'create', '--internal', '--subnet', `10.252.${parseInt(nonce.slice(0,2),16)}.0/28`, '--label', `factuez.qa.run=${nonce}`, networkName]);
  assert.equal(command(['network', 'inspect', '--format', '{{.Internal}}', networkId]), 'true');
  stage = 'CREATE_EMPTY_POSTGRES';
  containerId = command(['run', '--pull', 'never', '--rm', '-d', '--name', `factuez-guide-settings-${nonce}`, '--network', networkName, '--tmpfs', '/var/lib/postgresql/data:rw', '--label', `factuez.qa.run=${nonce}`, '-e', `POSTGRES_PASSWORD=${password}`, '-e', `POSTGRES_DB=${databaseName}`, 'postgres:17-alpine']);
  assert.match(containerId, /^[a-f0-9]{64}$/);
  const config = JSON.parse(command(['inspect', '--format', '{{json .HostConfig}}', containerId]));
  assert.equal(Object.keys(config.PortBindings ?? {}).length, 0); assert.ok(config.Tmpfs['/var/lib/postgresql/data']);
  for (let i = 0; i < 40; i++) {
    const ready = spawnSync('docker', ['exec', containerId, 'pg_isready', '-U', 'postgres', '-d', databaseName], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (ready.status === 0) break; if (i === 39) throw Error('POSTGRES_NOT_READY'); await new Promise(resolve => setTimeout(resolve, 250));
  }
  stage = 'SCHEMA_FROM_EMPTY';
  const ddl = spawnSync(process.execPath, [path.join(serviceRoot, 'node_modules/prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema', 'prisma/schema.prisma', '--script'], { cwd: serviceRoot, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 16 * 1024 * 1024, env: { NODE_PATH: path.join(serviceRoot, 'node_modules'), PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, DATABASE_URL: 'postgresql://offline:offline@127.0.0.1:1/offline', PRISMA_HIDE_UPDATE_MESSAGE: 'true' } });
  assert.equal(ddl.status, 0, 'EMPTY_SCHEMA_GENERATION_FAILED: ' + ddl.stderr);
  sql(ddl.stdout.replace(/CREATE TABLE "GuideOperationalSettings" \([\s\S]*?\n\);/, '').replace(/ALTER TABLE "GuideOperationalSettings"[\s\S]*?;/g, ''));
  sql(`INSERT INTO "CompanySettings" ("id","ruc","legalName","companyType","economicActivities","taxAddress","ubigeo","contactEmails","environment","updatedAt") VALUES (1,'00000000001','EMISOR FICTICIO A','QA','{}','Dirección QA','150101','{}','PRODUCTION',now()),(2,'00000000002','EMISOR FICTICIO B','QA','{}','Dirección QA','200101','{}','BETA',now());`);
  const before = sql(`SELECT md5(jsonb_agg(to_jsonb(c) ORDER BY id)::text) FROM "CompanySettings" c;`);
  pool = new Pool({ host: '127.0.0.1', port: 5432, user: 'postgres', database: databaseName, password, stream: () => new IsolatedPgStream(), max: 6, connectionTimeoutMillis: 10000 });
  pool.on('error', () => {});
  client = new PrismaClient({ adapter: new PrismaPg(pool) });
  const service = new GuideOperationalSettingsService(client);
  const request = { headers: {}, user: { sub: actorId, scope: { kind: 'GLOBAL' }, roles: ['ADMIN'], permissions: ['setup.manage'] } };
  delete process.env.BILLING_PRODUCTION_ISSUANCE_ENABLED; delete process.env.SUNAT_PRODUCTION_WORKFLOW_ENABLED; delete process.env.STATION_MASTER_CRUD_ENABLED;
  await check('MISSING_SCHEMA_SAFE_503', async () => { await assert.rejects(service.get('1', request), error => { if (typeof error.getStatus !== 'function') throw Error(JSON.stringify({name:error.name,code:error.code,meta:error.meta,message:error.message})); return error.getStatus() === 503 && !/SELECT|42P01|prisma/i.test(error.message); }); });
  await check('ADDITIVE_DDL_IDEMPOTENT', async () => { const migration = readFileSync(path.join(serviceRoot, 'prisma/guide-operational-settings.sql'), 'utf8'); sql(migration); sql(migration); const fuelMigration=readFileSync(path.join(serviceRoot,'prisma/guide-fuel-settings.sql'),'utf8'); sql(fuelMigration); sql(fuelMigration); assert.equal(sql(`SELECT md5(jsonb_agg(to_jsonb(c) ORDER BY id)::text) FROM "CompanySettings" c;`), before); });
  await check('GET_PUT_GET_PRODUCTION_ISSUER_WITHOUT_ISSUANCE_FLAGS', async () => {
    const empty = await service.get('1', request); assert.equal(empty.revision, 0); assert.equal(empty.settings, null); assert.equal(empty.fiscalTransmission, false);
    const input = draft(); const saved = await service.put('1', input, request); const read = await service.get('1', request);
    assert.deepEqual(saved, read); assert.deepEqual(read.settings, input.settings); assert.equal(read.updatedBy, actorId); assert.equal(read.ruc, '00000000001'); assert.equal(read.revision, 1); assert.equal(read.status, 'PROFILE_REVIEW_PENDING');
  });
  await check('COMPANY_ISOLATION_AND_STALE_CAS', async () => {
    assert.equal((await service.get('2', request)).settings, null);
    const input = draft(); input.expectedRevision = 1; await service.put('1', input, request);
    await assert.rejects(service.put('1', input, request), error => error.getStatus() === 409);
    assert.equal((await service.get('1', request)).revision, 2);
  });
  await check('CONCURRENT_FIRST_SAVE_EXACTLY_ONE_WINS', async () => {
    const results = await Promise.allSettled([service.put('2', draft('TRANSPORTISTA'), request), service.put('2', draft('REMITENTE'), request)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.find(r => r.status === 'rejected').reason.getStatus(), 409);
    assert.equal((await service.get('2', request)).revision, 1);
  });
  await check('CONCURRENT_UPDATE_EXACTLY_ONE_WINS', async () => {
    const a = { ...draft(), expectedRevision: 2 }, b = { ...draft(), expectedRevision: 2 };
    const results = await Promise.allSettled([service.put('1', a, request), service.put('1', b, request)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.find(r => r.status === 'rejected').reason.getStatus(), 409);
    assert.equal((await service.get('1', request)).revision, 3);
  });
  await check('AUDIT_FAILURE_ROLLS_BACK_SETTINGS', async () => {
    sql(`ALTER TABLE "ConfigurationAudit" ADD CONSTRAINT "synthetic_reject_audit" CHECK (action <> 'guide-operational-settings.saved') NOT VALID;`);
    await assert.rejects(service.put('1', { ...draft(), expectedRevision: 3 }, request));
    assert.equal((await service.get('1', request)).revision, 3);
    sql(`ALTER TABLE "ConfigurationAudit" DROP CONSTRAINT "synthetic_reject_audit";`);
  });
  await check('NATIVE_ADMIN_AND_ACTIVE_EXISTING_COMPANY', async () => {
    for (const user of [undefined, { ...request.user, roles: ['AUDITOR'] }, { ...request.user, permissions: [] }, { ...request.user, scope: { kind: 'ASSIGNED' } }]) assert.throws(() => service.get('1', { headers: {}, user }), error => error.getStatus() === 403);
    await assert.rejects(service.get('9999', request), error => error.getStatus() === 404);
    sql(`UPDATE "CompanySettings" SET active=false WHERE id=2;`);
    await assert.rejects(service.put('2', { ...draft(), expectedRevision: 1 }, request), error => error.getStatus() === 403);
    sql(`UPDATE "CompanySettings" SET active=true WHERE id=2;`);
  });
  stage = 'START_REAL_HTTP_WITH_SYNTHETIC_IDENTITY';
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 }); temp = mkdtempSync(path.join(tmpdir(), 'factuez-guide-settings-'));
  const keyfile = path.join(temp, 'synthetic-public.pem'); writeFileSync(keyfile, keys.publicKey.export({ type: 'spki', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_FILE = keyfile; process.env.JWT_ISSUER = 'factuez-synthetic-identity'; process.env.JWT_AUDIENCE = 'factuez-synthetic-services';
  let revoked = false;
  identity = createServer((req, res) => { res.writeHead(revoked ? 401 : 200, { 'content-type': 'application/json' }); res.end('{}'); });
  await new Promise(resolve => identity.listen(0, '127.0.0.1', resolve)); process.env.IDENTITY_INTERNAL_URL = `http://127.0.0.1:${identity.address().port}`;
  const token = (patch = {}) => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ ...request.user, username: 'synthetic-only', authVersion: 1, iss: process.env.JWT_ISSUER, aud: process.env.JWT_AUDIENCE, exp: Math.floor(Date.now()/1000)+600, ...patch })).toString('base64url');
    return `${header}.${payload}.${createSign('RSA-SHA256').update(`${header}.${payload}`).sign(keys.privateKey).toString('base64url')}`;
  };
  class TestModule {} Module({ controllers: [GuideOperationalSettingsController], providers: [{ provide: GuideOperationalSettingsService, useValue: service }, { provide: JwtPermissionGuard, useValue: new JwtPermissionGuard(new Reflector()) }] })(TestModule);
  app = await NestFactory.create(TestModule, { logger: false }); app.useBodyParser('json', { limit: '512kb' }); await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
  const checkedCacheHeaders = new Map();
  async function http(method = 'GET', body, bearer = token(), id = '1') {
    const res = await fetch(`${base}/api/v1/stations/issuers/${id}/guide-settings`, { method, headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (res.ok) {
      assert.equal(res.headers.get('cache-control'), 'private, no-store', `${method} must prevent caching of operational settings`);
      checkedCacheHeaders.set(method, res.headers.get('cache-control'));
    }
    return { status: res.status, body: await res.json() };
  }
  await check('HTTP_401_403_REVOKED_TOKEN_DENIED', async () => {
    assert.equal((await http('GET', undefined, '')).status, 401);
    assert.equal((await http('GET', undefined, token({ permissions: [] }))).status, 403);
    assert.equal((await http('GET', undefined, token({ roles: ['AUDITOR'], scope: { kind: 'ASSIGNED', branchIds: [], emissionPointIds: [], series: [] } }))).status, 403);
    revoked = true; assert.equal((await http()).status, 401); revoked = false;
  });
  await check('HTTP_SPOOFED_RUC_ACTOR_GRANT_REJECTED_AND_VALID_PUT_PERSISTS', async () => {
    for (const key of ['ruc', 'actor', 'grant', 'environment', 'counters', 'fiscalTransmission']) assert.equal((await http('PUT', { ...draft(), expectedRevision: 3, [key]: 'spoofed' })).status, 400);
    const input = { ...draft(), expectedRevision: 3 }; input.settings.products[0].type = 'OTHER_REGULATED';
    const put = await http('PUT', input); assert.equal(put.status, 200); assert.equal(put.body.revision, 4); assert.equal(put.body.updatedBy, actorId); assert.equal(put.body.fiscalTransmission, false); assert.equal(put.body.settings.products[0].type, 'OTHER_REGULATED');
    assert.deepEqual((await http()).body, put.body); assert.equal((await http('PUT', input)).status, 409);
    assert.equal((await http('PUT', { ...input, expectedRevision: 4, extra: 'x'.repeat(140000) })).status, 400);
    assert.equal((await http('PUT', { ...input, expectedRevision: 4, extra: 'x'.repeat(600000) })).status, 413);
  });
  await check('HTTP_FUEL_PROFILE_ROUND_TRIP_AND_SCOP_NOT_STATIC', async () => {
    const input=draft();input.expectedRevision=4;
    input.settings.fuelProfile={version:'factuez.guide-fuel-settings.v1',hydrocarbonRegistry:'REGISTRO-SINTETICO',products:[{productId:input.settings.products[0].id,family:'DIESEL'}],routes:[{routeId:input.settings.routes[0].id,regime:'ORDINARY_GRE',transportMode:'01',reasonCode:'01',scop:'REQUIRED'}]};
    const saved=await http('PUT',input);assert.equal(saved.status,200);assert.equal(saved.body.revision,5);
    assert.deepEqual((await http()).body.settings,input.settings);assert.equal(saved.body.fiscalTransmission,false);
    const spoof=structuredClone(input);spoof.expectedRevision=5;spoof.settings.fuelProfile.scopCode='STATIC-SCOP';
    assert.equal((await http('PUT',spoof)).status,400);assert.equal((await http()).body.revision,5);
    assert.equal(sql(`SELECT count(*) FROM "ConfigurationAudit" WHERE action='guide-operational-settings.saved' AND metadata->'changedFields' ? 'fuelProfile';`),'1');
  });
  await check('HTTP_SAFE_503_NO_RUNTIME_DDL', async () => {
    sql(`ALTER TABLE "GuideOperationalSettings" RENAME TO "GuideOperationalSettings_held";`);
    const result = await http(); assert.equal(result.status, 503); assert.ok(result.body.message.includes('almacenamiento')); assert.ok(!JSON.stringify(result.body).match(/SELECT|42P01|prisma|GuideOperationalSettings/));
    assert.equal(sql(`SELECT count(*) FROM pg_tables WHERE tablename='GuideOperationalSettings';`), '0');
    sql(`ALTER TABLE "GuideOperationalSettings_held" RENAME TO "GuideOperationalSettings";`);
  });
  await check('HTTP_GET_PUT_PRIVATE_NO_STORE', async () => {
    assert.deepEqual(Object.fromEntries(checkedCacheHeaders), { PUT: 'private, no-store', GET: 'private, no-store' });
  });
  await check('ONLY_OPERATIONAL_TABLE_AND_ATOMIC_BILLING_AUDIT_CHANGED', async () => {
    assert.equal(sql(`SELECT md5(jsonb_agg(to_jsonb(c) ORDER BY id)::text) FROM "CompanySettings" c;`), before);
    assert.equal(sql(`SELECT count(*) FROM "ConfigurationAudit" WHERE action='guide-operational-settings.saved';`), '6');
    for (const table of ['SeriesCounter', 'Document', 'OutboxEvent']) assert.equal(sql(`SELECT count(*) FROM "${table}";`), '0');
    assert.equal(sql(`SELECT count(*) FROM pg_constraint WHERE conrelid='"GuideOperationalSettings"'::regclass AND contype='f';`), '1');
  });
  await check('NEW_INSTALL_EXPORTED_SCHEMA_INCLUDES_TABLE_FK_AND_CHECKS', async () => {
    // Offline bundle produced by the documented exporter, applied only inside this new container.
    const fresh = databaseName + '_new'; assert.match(fresh, /^factuez_guide_settings_[a-f0-9]{10}_new$/);
    command(['exec', '-i', containerId, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1'], `CREATE DATABASE "${fresh}";`);
    const bundle = readFileSync(path.join(root, 'output/fuel-profile/new-install-schema/billing-service.sql'), 'utf8');
    command(['exec', '-i', containerId, 'psql', '-U', 'postgres', '-d', fresh, '-X', '-v', 'ON_ERROR_STOP=1'], `SET factuez.schema_target='${fresh}';\n` + bundle);
    const constraints = command(['exec', '-i', containerId, 'psql', '-U', 'postgres', '-d', fresh, '-X', '-v', 'ON_ERROR_STOP=1', '-At'], `SELECT count(*) FROM pg_constraint WHERE conrelid='"GuideOperationalSettings"'::regclass;`);
    assert.equal(constraints, '4'); // primary key, Billing company FK, payload and revision checks
  });
  const report = { status: 'PASS', profile: 'ISOLATED_SYNTHETIC_ONLY', realPostgres: true, realNestHttp: true, mockedIdentity: true, productionDataTouched: false, cacheControl: Object.fromEntries(checkedCacheHeaders), checks: passed };
  writeFileSync(path.join(output, 'backend-db-http.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  const report = { status: 'FAIL', stage, reason: error instanceof Error ? error.message : 'ISOLATED_FAILURE', passed };
  writeFileSync(path.join(output, 'backend-db-http-failure.json'), JSON.stringify(report, null, 2)); console.error(JSON.stringify(report)); process.exitCode = 1;
} finally {
  await app?.close(); if (identity) await new Promise(resolve => identity.close(resolve));
  await client?.$disconnect(); if (pool && !pool.ended) await pool.end();
  if (containerId) { assert.equal(command(['inspect', '--format', '{{index .Config.Labels "factuez.qa.run"}}', containerId]), nonce); command(['stop', '-t', '3', containerId]); }
  if (networkId) { assert.equal(command(['network', 'inspect', '--format', '{{index .Labels "factuez.qa.run"}}', networkId]), nonce); command(['network', 'rm', networkId]); }
  if (temp) { assert.ok(path.resolve(temp).startsWith(path.resolve(tmpdir()) + path.sep)); rmSync(temp, { recursive: true }); }
}
