'use strict';
// Fictitious test runner only, never accepts arbitrary database endpoints.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { randomUUID, randomBytes, generateKeyPairSync } = require('node:crypto');
const { createRequire } = require('node:module');
assert.match(process.env.FIXTURE_RUN_ID ?? '', /^[a-f0-9-]{36}$/);
assert.equal(process.env.FIXTURE_DATABASE_HOST, 'factuez-i3-test-' + process.env.FIXTURE_RUN_ID);
assert.match(process.env.FIXTURE_DATABASE_PASSWORD ?? '', /^[A-Za-z0-9_-]{43}$/);
const repo = '/workspace';
const { Pool } = createRequire(resolve(repo, 'services/identity-service/package.json'))('pg');
const { PostgresIntegrationStore } = require(resolve(repo, 'services/identity-service/dist/integration/postgres-store.js'));
const { IntegrationIdentity } = require(resolve(repo, 'services/identity-service/dist/integration/service.js'));
const { IntegrationTokenCodec } = require(resolve(repo, 'services/identity-service/dist/integration/token.js'));
const { validateCatalogue } = require(resolve(repo, 'services/identity-service/dist/integration/catalogue.js'));
const { PrismaService } = require(resolve(repo, 'services/identity-service/dist/infrastructure/prisma.service.js'));
const connection = { host: process.env.FIXTURE_DATABASE_HOST, port: 5432,
 user: 'integration_fixture', database: 'integration_fixture', password: process.env.FIXTURE_DATABASE_PASSWORD,
 max: 8, connectionTimeoutMillis: 1000 };
let pool = new Pool(connection), verified = 0, stage = 'wait-fixture-database';
process.env.DATABASE_URL = 'postgresql://integration_fixture:' + encodeURIComponent(connection.password) + '@' + connection.host + ':5432/integration_fixture';
const prisma = new PrismaService();
async function main() {
  let ready = false, lastCode = 'NOT_READY';
  for (let i = 0; i < 40; i++) {
    try { await pool.query('SELECT 1'); ready = true; break; } catch (error) {
      lastCode = /^[A-Z0-9_]{1,32}$/.test(error.code ?? '') ? error.code : 'CONNECTION_NOT_READY';
      await new Promise(r => setTimeout(r, 300));
    }
  }
  if (!ready) { const error = new Error('Fixture unavailable'); error.code = lastCode; throw error; }
  stage = 'fixture-schema'; await pool.query(readFileSync('/fixture/schema.sql', 'utf8'));
  await prisma.$connect();
  await new PostgresIntegrationStore(prisma).ready();
  const ok = () => verified++;
  stage = 'persistent-client-checks';
  const branch = randomUUID(), point = randomUUID(), series = randomUUID(), actor = randomUUID();
  const grant = { issuerRuc: '20555555555', environment: 'BETA', documentTypes: ['01'], branches: { kind: 'IDS', ids: [branch] },
    points: { kind: 'IDS', ids: [point] }, series: { kind: 'IDS', ids: [series] } };
  const catalogue = { companies: [{ id: 1, ruc: grant.issuerRuc, environment: 'BETA', source: 'BUSINESS' }],
    branches: [{ id: branch, companyId: 1, source: 'BUSINESS' }],
    emissionPoints: [{ id: point, branchId: branch, companyId: 1, source: 'BUSINESS', series: [{ id: series, documentType: 'INVOICE' }] }] };
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' });
  const codec = new IntegrationTokenCodec(Buffer.from(key), 'https://fixture.factuez.invalid');
  const pepper = randomBytes(32);
  const build = () => new IntegrationIdentity(new PostgresIntegrationStore(prisma), codec, pepper,
    { verify: async token => { assert.equal(token, 'fictitious-admin'); return { id: actor }; } },
    { validate: async (_token, values) => validateCatalogue(catalogue, values) });
  let core = build();
  const ctx = () => ({ requestId: randomUUID(), peer: 'isolated-fictitious-peer' });
  const made = await core.create('fictitious-admin', { label: 'Isolated fake ERP', scopes: ['integration:documents:read'], grants: [grant] }, ctx());
  assert.equal((await core.list('fictitious-admin')).length, 1); ok();
  assert.ok(!JSON.stringify(await core.list('fictitious-admin')).includes(made.clientSecret)); ok();
  const basic = secret => 'Basic ' + Buffer.from(made.client.id + ':' + secret).toString('base64');
  const issue = secret => core.token(basic(secret), { grant_type: 'client_credentials', scope: 'integration:documents:read' }, ctx());
  const token = await issue(made.clientSecret);
  assert.equal((await core.authenticate(token.access_token, ['integration:documents:read'], ctx())).clientId, made.client.id); ok();
  // New connection/repository process state still sees data saved by PostgreSQL.
  await prisma.$disconnect(); await prisma.$connect(); core = build();
  assert.equal((await core.list('fictitious-admin'))[0].id, made.client.id); ok();
  const changes = await Promise.allSettled([1,2].map(() => core.change('fictitious-admin', made.client.id, { expectedRevision: 1 }, ctx(), true)));
  assert.equal(changes.filter(v => v.status === 'fulfilled').length, 1); ok();
  const changed = changes.find(v => v.status === 'fulfilled').value;
  assert.equal(changes.find(v => v.status === 'rejected').reason.code, 'REVISION_CONFLICT'); ok();
  await assert.rejects(() => core.authenticate(token.access_token, [], ctx()), e => e.code === 'invalid_token'); ok();
  await assert.rejects(() => issue(made.clientSecret), e => e.code === 'invalid_client'); ok();
  assert.ok((await issue(changed.clientSecret)).access_token); ok();
  // A DB-side audit failure must roll the entire rotation back, including secret/revision.
  await pool.query(`ALTER TABLE "IntegrationAudit" ADD CONSTRAINT "fixture_fail_rotate" CHECK ("action" <> 'ROTATE') NOT VALID`);
  await assert.rejects(() => core.change('fictitious-admin', made.client.id, { expectedRevision: 2 }, ctx(), true), e => e.status === 503); ok();
  assert.equal((await core.list('fictitious-admin'))[0].revision, 2); ok();
  assert.ok((await issue(changed.clientSecret)).access_token); ok();
  await pool.query(`ALTER TABLE "IntegrationAudit" DROP CONSTRAINT "fixture_fail_rotate"`);
  const next = await issue(changed.clientSecret);
  await core.change('fictitious-admin', made.client.id, { expectedRevision: 2, enabled: false }, ctx());
  await assert.rejects(() => core.authenticate(next.access_token, [], ctx()), e => e.status === 401); ok();
  await core.change('fictitious-admin', made.client.id, { expectedRevision: 3, enabled: true }, ctx());
  await assert.rejects(() => core.authenticate(next.access_token, [], ctx()), e => e.status === 401); ok();
  const repository = new PostgresIntegrationStore(prisma);
  const rate = await Promise.all(Array.from({ length: 12 }, () => repository.rate('a'.repeat(64), 10, 5)));
  assert.equal(rate.filter(Boolean).length, 5); ok();
  assert.equal(await repository.rate('a'.repeat(64), 11, 5), true); ok();
  assert.equal(await repository.rate('a'.repeat(64), 10, 5), false); ok();
  const audit = await pool.query('SELECT "action","outcome","revision","peerHash" FROM "IntegrationAudit"');
  assert.equal(audit.rows.filter(v => v.action === 'ROTATE').length, 1); ok();
  assert.ok(!JSON.stringify(audit.rows).includes(made.clientSecret)); ok();
  await assert.rejects(() => pool.query(`UPDATE "IntegrationClient" SET "environment"='PRODUCTION' WHERE "id"=$1`, [made.client.id])); ok();
  const tables = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name");
  assert.deepEqual(tables.rows.map(r => r.table_name), ['IntegrationAudit','IntegrationClient','IntegrationRateBucket']); ok();
  console.log(JSON.stringify({ result: 'PASS', checks: verified, environment: 'ISOLATED_SYNTHETIC', realData: false, existingRuntimeChanged: false }));
}
main().catch(error => {
 console.log(JSON.stringify({ result: 'FAIL', stage, verified,
 code: /^[A-Z0-9_]{1,32}$/.test(error.code ?? '') ? error.code : 'ISOLATED_TEST_FAILURE' }));
 process.exitCode = 1;
}).finally(async () => { await prisma.$disconnect(); await pool.end(); });
