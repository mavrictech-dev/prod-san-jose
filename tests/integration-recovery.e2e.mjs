/** Opt-in, NEW PostgreSQL/tmpfs only. No existing DB/volume/config discovery. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { sealSyntheticRecovery, openSyntheticRecovery } from '../infra/integration/synthetic-recovery.mjs';
const guard = '--isolated-synthetic-only', runId = randomUUID(), prefix = 'factuez-i8r-' + runId.replaceAll('-', '').slice(0, 12);
const network = prefix, db = prefix + '-db', targets = new Set([network, db]);
const labels = ['--label', 'factuez.integration.test=' + runId, '--label', 'factuez.integration.phase=8-recovery'];
const databases = new Set(['integration_fixture', 'integration_restore_fixture']);
let stage = 'guard', checks = 0, createdNetwork = false, createdDb = false;
const pass = () => { checks++; };
const sha = b => createHash('sha256').update(b).digest('hex');
function invoke(args, input, timeout = 30000) {
  return spawnSync('docker.exe', ['--context', 'desktop-linux', ...args], { input, timeout, windowsHide: true,
    maxBuffer: 20 * 1024 * 1024, encoding: null });
}
function docker(args, input, timeout) {
  const r = invoke(args, input, timeout); if (r.error || r.status !== 0) throw new Error('SYNTHETIC_OPERATION_FAILED'); return r.stdout;
}
function owned(kind, target) {
  assert.ok(targets.has(target)); const rows = JSON.parse(docker([kind, 'inspect', target]).toString()); assert.equal(rows.length, 1);
  const row = rows[0], actual = kind === 'network' ? row.Labels : row.Config.Labels;
  assert.equal(actual['factuez.integration.test'], runId); assert.equal(actual['factuez.integration.phase'], '8-recovery');
  assert.equal(kind === 'network' ? row.Name : row.Name.slice(1), target); return row;
}
function sql(name, statement, succeeds = true) {
  assert.ok(databases.has(name)); owned('container', db);
  const r = invoke(['exec', '-i', db, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'integration_fixture', '-d', name], Buffer.from(statement));
  assert.equal(Boolean(r.error), false); if (succeeds) assert.equal(r.status, 0); else assert.notEqual(r.status, 0);
  return r.stdout.toString().trim();
}
const empty = name => assert.equal(sql(name, "SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p','v','m','S');"), '0');
const tables = ['FixtureControl', 'FixtureHistory', 'FixtureArtifact', 'IntegrationExportRecord', 'IntegrationExportAudit', 'IntegrationChangeDelivery', 'IntegrationChangeDeliveryAudit'];
function inventory(name) {
  return JSON.parse(sql(name, 'SELECT json_build_object(' + tables.map(t => "'" + t + "',(SELECT COALESCE(json_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::json) FROM public.\"" + t + '\" r)').join(',') + ');'));
}
function reader(name) {
  sql(name, 'REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO fixture_reader; GRANT SELECT ON "FixtureHistory","FixtureArtifact" TO fixture_reader;');
  assert.equal(sql(name, 'SET ROLE fixture_reader; SELECT count(*) FROM "FixtureHistory";'), '2'); pass();
  sql(name, 'SET ROLE fixture_reader; UPDATE "FixtureHistory" SET "originId"=\'changed\';', false); pass();
  sql(name, 'SET ROLE fixture_reader; DELETE FROM "FixtureHistory";', false); pass();
  sql(name, 'SET ROLE fixture_reader; SELECT * FROM "IntegrationExportRecord";', false); pass();
  sql(name, 'UPDATE "FixtureHistory" SET "originId"=\'changed\';', false); pass();
}
try {
  assert.equal(process.platform, 'win32'); assert.equal(process.argv.length, 3); assert.equal(process.argv[2], guard);
  const context = spawnSync('docker.exe', ['context', 'inspect', 'desktop-linux', '--format', '{{(index .Endpoints "docker").Host}}'],
    { windowsHide: true, timeout: 5000, encoding: 'utf8', maxBuffer: 4096 });
  assert.equal(context.status, 0); assert.equal(context.stdout.trim(), 'npipe:////./pipe/dockerDesktopLinuxEngine'); pass();
  stage = 'local-reviewed-software';
  const image = docker(['image', 'inspect', '--format', '{{.Id}}', 'postgres:17-alpine']).toString().trim(); assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const { ExportVault } = createRequire(import.meta.url)(resolve('services/integration-export-service/dist/vault.js'));
  const key = randomBytes(32), backupKey = randomBytes(32), vault = new ExportVault(key), sourceEpoch = randomUUID();
  const artifact = Buffer.from('<Fixture>SYNTHETIC-NOT-SIGNED-NOT-OFFICIAL</Fixture>\n');
  const documentId = randomUUID(), clientId = randomUUID(), exportId = randomUUID(), deliveryId = randomUUID();
  const content = vault.seal(Buffer.from('SYNTHETIC EXPORT CONTENT'), exportId);
  const checkpoint = vault.sealJson({ sourceEpoch, checkpoint: 'FICTITIOUS-NOT-A-REAL-CHECKPOINT' }, deliveryId);
  stage = 'new-internal-network'; docker(['network', 'create', '--internal', ...labels, network]); createdNetwork = true;
  assert.equal(owned('network', network).Internal, true); pass();
  stage = 'new-tmpfs-postgresql';
  docker(['create', '--name', db, ...labels, '--network', network, '--memory', '384m', '--cpus', '1', '--pids-limit', '128',
    '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data,tmpfs-size=201326592',
    '--mount', 'type=tmpfs,destination=/tmp,tmpfs-size=67108864,tmpfs-mode=1777',
    '--env', 'POSTGRES_USER=integration_fixture', '--env', 'POSTGRES_DB=integration_fixture',
    '--env', 'POSTGRES_PASSWORD=' + randomBytes(32).toString('base64url'), image]); createdDb = true;
  const postgres = owned('container', db); assert.equal(postgres.HostConfig.PublishAllPorts, false);
  assert.equal(Object.keys(postgres.HostConfig.PortBindings ?? {}).length, 0); assert.equal(postgres.Mounts.length, 2);
  assert.ok(postgres.Mounts.every(m => m.Type === 'tmpfs')); pass(); docker(['start', db]);
  let ready = false;
  for (let i = 0; i < 60; i++) { const probe = invoke(['exec', db, 'pg_isready', '-U', 'integration_fixture', '-d', 'integration_fixture']);
    if (!probe.error && probe.status === 0) { ready = true; break; } await new Promise(done => setTimeout(done, 200)); }
  assert.equal(ready, true); empty('integration_fixture'); pass();
  stage = 'synthetic-schema-only';
  sql('integration_fixture', readFileSync(resolve('services/integration-export-service/sql/integration-export.sql'), 'utf8'));
  sql('integration_fixture', readFileSync(resolve('services/integration-export-service/sql/integration-changes.sql'), 'utf8'));
  sql('integration_fixture', `
    CREATE TABLE "FixtureControl" (id integer PRIMARY KEY CHECK(id=1), mode text NOT NULL CHECK(mode='SYNTHETIC'), epoch uuid NOT NULL);
    CREATE TABLE "FixtureHistory" (id uuid PRIMARY KEY,"fiscalKey" text UNIQUE NOT NULL,"originId" text UNIQUE NOT NULL,snapshot jsonb NOT NULL);
    CREATE TABLE "FixtureArtifact" (id uuid PRIMARY KEY,name text UNIQUE NOT NULL,sha256 char(64) NOT NULL,bytes integer NOT NULL);
    CREATE FUNCTION fixture_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_IMMUTABLE'; END $$;
    CREATE TRIGGER fixture_immutable BEFORE UPDATE OR DELETE ON "FixtureHistory" FOR EACH ROW EXECUTE FUNCTION fixture_immutable();
    INSERT INTO "FixtureControl" VALUES(1,'SYNTHETIC','${sourceEpoch}');
    INSERT INTO "FixtureHistory" VALUES('${documentId}','20555555555-01-FQ01-1','SYNTHETIC-1','{"fixture":true}'),
      ('${randomUUID()}','20555555555-03-BQ01-1','SYNTHETIC-2','{"fixture":true}');
    INSERT INTO "FixtureArtifact" VALUES('${randomUUID()}','document.xml','${sha(artifact)}',${artifact.length});
    INSERT INTO "IntegrationExportRecord"(id,kind,"clientId","contextSha256","issuerRuc","keyHash","requestSha256","createdAt","expiresAt",state,payload,content,"contentSha256","manifestSha256")
      VALUES('${exportId}','EXPORT','${clientId}','${'a'.repeat(64)}','20555555555','${'b'.repeat(64)}','${'c'.repeat(64)}',now(),now()+interval '1 day','READY',
        decode('${content.toString('hex')}','hex'),decode('${content.toString('hex')}','hex'),'${sha(Buffer.from('SYNTHETIC EXPORT CONTENT'))}','${'d'.repeat(64)}');
    INSERT INTO "IntegrationExportAudit"(id,"requestId","clientId",revision,"recordId",operation) VALUES('${randomUUID()}','${randomUUID()}','${clientId}',1,'${exportId}','CREATE');
    INSERT INTO "IntegrationChangeDelivery"(id,"clientId","contextSha256","issuerRuc","checkpointKey","createdAt","expiresAt",payload)
      VALUES('${deliveryId}','${clientId}','${'a'.repeat(64)}','20555555555','${'b'.repeat(64)}',now(),now()+interval '1 day',decode('${checkpoint.toString('hex')}','hex'));
    INSERT INTO "IntegrationChangeDeliveryAudit"(id,"clientId",revision,"recordId",operation) VALUES('${randomUUID()}','${clientId}',1,'${deliveryId}','POLL');
    CREATE ROLE fixture_reader NOLOGIN;
    COPY(SELECT '<Fixture>SYNTHETIC-NOT-SIGNED-NOT-OFFICIAL</Fixture>') TO '/tmp/factuez-i8-original.xml';
  `);
  assert.equal(sql('integration_fixture', "SELECT string_agg(tablename,',' ORDER BY tablename) FROM pg_tables WHERE schemaname='public';"), [...tables].sort().join(',')); pass();
  reader('integration_fixture');
  const originalFile = docker(['exec', db, 'cat', '/tmp/factuez-i8-original.xml']); assert.deepEqual(originalFile, artifact); pass();
  const baseline = inventory('integration_fixture'), baselineSha = sha(Buffer.from(JSON.stringify(baseline)));
  stage = 'read-only-dump-and-encrypted-inventory';
  const dump = docker(['exec', db, 'pg_dump', '-U', 'integration_fixture', '-d', 'integration_fixture', '-Fc', '--no-owner', '--no-acl']);
  const counts = { history: 2, exports: 1, exportAudits: 1, deliveries: 1, deliveryAudits: 1 };
  const backup = sealSyntheticRecovery({ runId, sourceMode: 'SYNTHETIC', environment: 'BETA', epoch: sourceEpoch, counts,
    databaseDump: dump, originals: [{ name: 'document.xml', bytes: originalFile }] }, backupKey);
  assert.ok(!backup.includes(artifact) && !backup.includes(Buffer.from('PGDMP'))); pass();
  const backupSha = sha(backup); assert.throws(() => openSyntheticRecovery(backup, randomBytes(32), runId)); pass();
  const altered = Buffer.from(backup); altered[altered.length - 1] ^= 1; assert.throws(() => openSyntheticRecovery(altered, backupKey, runId)); pass();
  assert.throws(() => openSyntheticRecovery(backup, backupKey, randomUUID())); pass();
  assert.equal(sha(backup), backupSha); const recovered = openSyntheticRecovery(backup, backupKey, runId); pass();
  assert.deepEqual(recovered.counts, counts); assert.deepEqual(recovered.databaseDump, dump); assert.deepEqual(recovered.originals[0].bytes, originalFile); pass();
  stage = 'restore-new-empty-database'; sql('integration_fixture', 'CREATE DATABASE integration_restore_fixture;'); empty('integration_restore_fixture'); pass();
  owned('container', db);
  docker(['exec', '-i', db, 'pg_restore', '-U', 'integration_fixture', '-d', 'integration_restore_fixture', '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl'], recovered.databaseDump);
  assert.equal(sha(Buffer.from(JSON.stringify(inventory('integration_restore_fixture')))), baselineSha); pass();
  reader('integration_restore_fixture');
  assert.equal(sql('integration_restore_fixture', 'SELECT count(*) FROM pg_trigger WHERE tgname=\'fixture_immutable\' AND tgenabled=\'O\';'), '1'); pass();
  const restoredContent = Buffer.from(sql('integration_restore_fixture', 'SELECT encode(content,\'hex\') FROM "IntegrationExportRecord";'), 'hex');
  assert.equal(new ExportVault(key).open(restoredContent, exportId).toString(), 'SYNTHETIC EXPORT CONTENT'); pass();
  assert.throws(() => new ExportVault(randomBytes(32)).open(restoredContent, exportId)); pass();
  const restoredCheckpoint = Buffer.from(sql('integration_restore_fixture', 'SELECT encode(payload,\'hex\') FROM "IntegrationChangeDelivery";'), 'hex');
  assert.equal(new ExportVault(key).openJson(restoredCheckpoint, deliveryId).sourceEpoch, sourceEpoch); pass();
  assert.deepEqual(recovered.originals[0].bytes, artifact);
  sql('integration_restore_fixture', "COPY(SELECT '<Fixture>SYNTHETIC-NOT-SIGNED-NOT-OFFICIAL</Fixture>') TO '/tmp/factuez-i8-restored.xml';");
  assert.equal(sha(docker(['exec', db, 'cat', '/tmp/factuez-i8-restored.xml'])), sha(artifact)); pass();
  stage = 'isolated-epoch-rotation-no-fiscal-counter';
  const newEpoch = randomUUID();
  sql('integration_restore_fixture', `BEGIN; LOCK TABLE "FixtureControl" IN ACCESS EXCLUSIVE MODE; UPDATE "FixtureControl" SET epoch='${newEpoch}'; COMMIT;`);
  assert.equal(sql('integration_restore_fixture', 'SELECT epoch FROM "FixtureControl";'), newEpoch); assert.notEqual(newEpoch, sourceEpoch); pass();
  // Fixture control demonstrates the restore boundary. Actual owner journals and
  // ERP checkpoint invalidation require their separate authorized restore procedure.
  assert.equal(sha(Buffer.from(JSON.stringify(inventory('integration_fixture')))), baselineSha); pass();
  assert.equal(sql('integration_restore_fixture', 'SELECT count(*) FROM "FixtureHistory";'), '2'); pass();
  console.log(JSON.stringify({ result: 'PASS', stage, checks, realData: false, databases: 2,
    dumpAndOriginalsVerified: true, customerBackup: false, ownerJournalRestore: 'NOT_REHEARSED_HERE' }));
} catch {
  process.exitCode = 1; console.error(JSON.stringify({ result: 'FAIL', stage, checks, realData: false }));
} finally {
  let failed = false;
  if (createdDb) { try { owned('container', db); docker(['container', 'rm', '--force', db]); } catch { failed = true; } }
  if (createdNetwork) { try { assert.equal(Object.keys(owned('network', network).Containers).length, 0); docker(['network', 'rm', network]); } catch { failed = true; } }
  console.log(JSON.stringify({ result: failed ? 'FAIL' : 'PASS', stage: 'cleanup-exact-labelled-resources', realData: false }));
  if (failed) process.exitCode = 1;
}
