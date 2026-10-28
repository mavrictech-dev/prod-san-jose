// PostgreSQL nuevo, efímero y sintético. Nunca usa la BD QA activa, .env, certificados o credenciales reales.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { Duplex } from 'node:stream';

if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--isolated-synthetic-only'])) throw new Error('ISOLATED_SYNTHETIC_ONLY_REQUIRED');
const root = fileURLToPath(new URL('..', import.meta.url));
const serviceRoot = path.join(root, 'services/billing-service');
const local = createRequire(path.join(serviceRoot, 'package.json'));
local('reflect-metadata');
const { PrismaClient } = local('./dist/generated/prisma/client');
const { PrismaPg } = local('@prisma/adapter-pg');
const { Pool } = local('pg');
const { StationAdminService } = local('./dist/application/station-admin.service');
const nonce = randomBytes(5).toString('hex');
const databaseName = `factuez_master_qa_${nonce}`, networkName = `factuez-master-qa-net-${nonce}`;
const password = randomBytes(24).toString('hex');
let containerId, networkId, client, pool, stage = 'INIT', shuttingDown = false, unexpectedPoolError = false;
const passed = [];
function command(args, input = '') {
  const result = spawnSync('docker', args, { input, encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  assert.ok(!result.error && result.status === 0, `ISOLATED_COMMAND_FAILED_${stage}`);
  return result.stdout.trim();
}
function sql(statement) {
  assert.match(containerId, /^[a-f0-9]{64}$/); assert.match(databaseName, /^factuez_master_qa_[a-f0-9]{10}$/);
  return command(['exec', '-i', containerId, 'psql', '-U', 'postgres', '-d', databaseName, '-X', '-v', 'ON_ERROR_STOP=1', '-At'], statement);
}
class IsolatedPgStream extends Duplex {
  constructor() { super({ allowHalfOpen: false }); this.closing = false; }
  setNoDelay() { return this; } setKeepAlive() { return this; } ref() { return this; } unref() { return this; }
  connect(port, host) {
    assert.equal(port, 5432); assert.equal(host, '127.0.0.1'); assert.match(containerId, /^[a-f0-9]{64}$/);
    this.child = spawn('docker', ['exec', '-i', containerId, 'nc', '127.0.0.1', '5432'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.child.stdout.on('data', bytes => { if (!this.push(bytes)) this.child.stdout.pause(); });
    this.child.stdout.on('end', () => this.push(null));
    this.child.on('error', () => this.destroy(new Error('ISOLATED_STREAM_ERROR')));
    this.child.stdin.on('error', () => this.destroy(new Error('ISOLATED_STREAM_ERROR')));
    this.child.once('spawn', () => this.emit('connect')); return this;
  }
  _read() { this.child?.stdout.resume(); }
  _write(bytes, encoding, callback) { this.child.stdin.write(bytes, encoding, callback); }
  _final(callback) { this.closing = true; this.child.stdin.end(callback); }
  _destroy(error, callback) { this.closing = true; this.child?.kill(); callback(error); }
}
async function check(label, work) { stage = label; await work(); passed.push(label); }
const actor = { user: { sub: randomUUID(), scope: { kind: 'GLOBAL' }, roles: ['ADMIN'], permissions: ['setup.manage', 'series.manage'] } };
try {
  stage = 'CREATE_INTERNAL_NETWORK';
  networkId = command(['network', 'create', '--internal', '--label', `factuez.qa.run=${nonce}`, networkName]);
  assert.equal(command(['network', 'inspect', '--format', '{{.Internal}}', networkId]), 'true');
  stage = 'CREATE_EMPTY_POSTGRES';
  containerId = command(['run', '--pull', 'never', '--rm', '-d', '--name', `factuez-master-qa-${nonce}`, '--network', networkName,
    '--tmpfs', '/var/lib/postgresql/data:rw', '--label', `factuez.qa.run=${nonce}`, '-e', `POSTGRES_PASSWORD=${password}`, '-e', `POSTGRES_DB=${databaseName}`, 'postgres:17-alpine']);
  assert.match(containerId, /^[a-f0-9]{64}$/);
  const config = JSON.parse(command(['inspect', '--format', '{{json .HostConfig}}', containerId]));
  assert.equal(Object.keys(config.PortBindings ?? {}).length, 0); assert.ok(config.Tmpfs['/var/lib/postgresql/data']);
  stage = 'WAIT_READY';
  let ready = false;
  for (let i = 0; i < 40; i++) {
    const result = spawnSync('docker', ['exec', containerId, 'pg_isready', '-U', 'postgres', '-d', databaseName], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (result.status === 0) { ready = true; break; } await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, 'EMPTY_POSTGRES_NOT_READY');
  stage = 'DDL_FROM_EMPTY_ONLY';
  const ddl = spawnSync(process.execPath, [path.join(serviceRoot, 'node_modules/prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema', 'prisma/schema.prisma', '--script'], {
    cwd: serviceRoot, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NODE_PATH: path.join(serviceRoot, 'node_modules'), DATABASE_URL: 'postgresql://build:build@localhost:5432/build', PRISMA_HIDE_UPDATE_MESSAGE: 'true' },
  });
  assert.equal(ddl.status, 0, 'EMPTY_SCHEMA_GENERATION_FAILED');
  // Simula el esquema previo al CRUD sólo dentro de la BD nueva, nunca en QA activo.
  let oldDdl = ddl.stdout.replaceAll(/\s+"masterRevision" INTEGER NOT NULL DEFAULT 1,/g, '');
  oldDdl = oldDdl.replace(/(CREATE TABLE "CompanySettings" \([\s\S]*?)(\s+"active" BOOLEAN NOT NULL DEFAULT true,)/, '$1');
  assert.equal((ddl.stdout.match(/"masterRevision" INTEGER/g) ?? []).length, 3);
  sql(oldDdl);
  sql(`INSERT INTO "CompanySettings" ("id","ruc","legalName","companyType","economicActivities","taxAddress","ubigeo","contactEmails","environment","updatedAt") VALUES (1,'00000000001','FICTICIO','QA','{}','Dirección QA','200101','{}','BETA',now());
    INSERT INTO "Branch" ("id","companyId","code","name") VALUES ('10000000-0000-4000-8000-000000000001',1,'SEDE_PREVIA','Sede previa QA');
    INSERT INTO "EmissionPoint" ("id","companyId","branchId","code","name","updatedAt") VALUES ('20000000-0000-4000-8000-000000000001',1,'10000000-0000-4000-8000-000000000001','CAJA_PREVIA','Caja previa QA',now());
    INSERT INTO "SeriesCounter" ("id","companyId","emissionPointId","documentType","series","nextNumber","updatedAt") VALUES ('40000000-0000-4000-8000-000000000001',1,'20000000-0000-4000-8000-000000000001','INVOICE','F001',25,now());
    SELECT setval(pg_get_serial_sequence('"CompanySettings"','id'),1,true);`);
  const before = sql(`SELECT md5(to_jsonb(s)::text) FROM "SeriesCounter" s;`);
  await check('ADDITIVE_MIGRATION_PRESERVES_ROWS_COUNTERS', async () => {
    const migration = readFileSync(path.join(serviceRoot, 'prisma/admin-master-crud.sql'), 'utf8');
    sql(migration); sql(migration); // idempotente
    assert.equal(sql(`SELECT md5((to_jsonb(s)-'masterRevision')::text) FROM "SeriesCounter" s;`), before);
    assert.equal(sql(`SELECT "nextNumber" FROM "SeriesCounter";`), '25');
    assert.equal(sql(`SELECT "active" FROM "CompanySettings";`), 't');
    assert.equal(sql(`SELECT "masterRevision" FROM "Branch";`), '1');
  });
  pool = new Pool({ host: '127.0.0.1', port: 5432, user: 'postgres', database: databaseName, password, stream: () => new IsolatedPgStream(), max: 4, connectionTimeoutMillis: 10000 });
  pool.on('error', () => { if (!shuttingDown) unexpectedPoolError = true; });
  client = new PrismaClient({ adapter: new PrismaPg(pool) });
  process.env.STATION_MASTER_CRUD_ENABLED = 'true';
  const service = new StationAdminService(client);
  let issuer, branch, point, counter;
  await check('CREATE_AND_READ_REAL_PRISMA_RELATIONS', async () => {
    issuer = await service.createIssuer({ ruc: '00000000002', legalName: 'FICTICIO B', taxAddress: 'Dirección ficticia', ubigeo: '200101' }, actor);
    branch = await service.createBranch({ companyId: issuer.id, code: 'QA_NUEVA', name: 'Sede nueva' }, actor);
    point = await service.createPoint(branch.id, { code: 'QA_CAJA', name: 'Caja nueva', invoiceSeries: 'F001', receiptSeries: 'B001' }, actor);
    counter = point.series.find(s => s.documentType === 'INVOICE');
    const catalog = await service.catalog(actor);
    assert.equal(catalog.series.find(s => s.id === counter.id).nextNumber, '1');
    assert.equal(catalog.series.find(s => s.companyId === 1).canRename, false);
    assert.equal(catalog.branches.find(b => b.id === branch.id).pointCount, 1);
  });
  await check('UNUSED_RENAME_CAS_AND_UNIQUENESS', async () => {
    await service.updateSeries(counter.id, { expectedRevision: 1, series: 'F002' }, actor);
    await assert.rejects(service.updateSeries(counter.id, { expectedRevision: 1, series: 'F003' }, actor), /registro cambió/);
    await assert.rejects(service.createSeries(point.id, { documentType: 'INVOICE', series: 'F002' }, actor), /ya existe/);
    await assert.rejects(service.updateSeries('40000000-0000-4000-8000-000000000001', { expectedRevision: 1, series: 'F003' }, actor), /historial/);
  });
  await check('SOFT_DELETE_EFFECTIVE_STATE_AND_HISTORY', async () => {
    await service.deactivateBranch(branch.id, { expectedRevision: 1 }, actor);
    let catalog = await service.catalog(actor); assert.equal(catalog.emissionPoints.find(p => p.id === point.id).effectiveActive, false);
    await service.updateBranch(branch.id, { expectedRevision: 2, active: true }, actor);
    catalog = await service.catalog(actor); assert.equal(catalog.series.find(s => s.id === counter.id).nextNumber, '1');
    assert.equal(await client.document.count(), 0); assert.equal(await client.outboxEvent.count(), 0);
    assert.equal(sql(`SELECT "nextNumber" FROM "SeriesCounter" WHERE "companyId"=1;`), '25');
  });
  await check('PARENT_LOCK_SERIALIZES_MASTER_EDITS', async () => {
    const held = await pool.connect(); await held.query('BEGIN'); await held.query('SELECT "id" FROM "CompanySettings" WHERE "id"=$1 FOR SHARE', [issuer.id]);
    let completed = false;
    const edit = service.updateIssuer(String(issuer.id), { expectedRevision: 1, legalName: 'FICTICIO CORREGIDO' }, actor).then(value => { completed = true; return value; });
    try { await new Promise(resolve => setTimeout(resolve, 200)); assert.equal(completed, false); await held.query('COMMIT'); await edit; }
    finally { held.release(); }
  });
  await check('OPEN_SHIFT_BLOCKS_DEACTIVATION', async () => {
    const shift = await client.shift.create({ data: { emissionPointId: point.id, openedByUserId: actor.user.sub } });
    await assert.rejects(service.deactivateIssuer(String(issuer.id), { expectedRevision: 2 }, actor), /turnos abiertos/);
    await client.shift.update({ where: { id: shift.id }, data: { status: 'CLOSED', closedAt: new Date() } });
    await service.deactivateIssuer(String(issuer.id), { expectedRevision: 2 }, actor);
    assert.equal((await service.catalog(actor)).companies.find(c => c.id === issuer.id).active, false);
  });
  assert.equal(unexpectedPoolError, false, 'ISOLATED_POOL_ERROR');
  console.log(JSON.stringify({ status: 'PASS', profile: 'ISOLATED_SYNTHETIC_ONLY', checks: passed, activeQaTouched: false }));
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', stage, reason: error instanceof Error ? error.message : 'ISOLATED_FAILURE' })); process.exitCode = 1;
} finally {
  shuttingDown = true;
  await client?.$disconnect().catch(() => { process.exitCode = 1; });
  if (pool && !pool.ended) await pool.end().catch(() => { process.exitCode = 1; });
  if (containerId) {
    assert.equal(command(['inspect', '--format', '{{index .Config.Labels "factuez.qa.run"}}', containerId]), nonce);
    command(['stop', '-t', '3', containerId]);
  }
  if (networkId) { assert.equal(command(['network', 'inspect', '--format', '{{index .Labels "factuez.qa.run"}}', networkId]), nonce); command(['network', 'rm', networkId]); }
}
