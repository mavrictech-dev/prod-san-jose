'use strict';
// Explicit opt-in. No arguments, URLs, host directories, existing containers or DBs.
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {randomUUID, createHash} = require('node:crypto');

if (process.argv.length !== 3 || process.argv[2] !== '--isolated-synthetic-only') {
  console.error('Uso: node tests/b2b-backup-pg-real-isolated.cjs --isolated-synthetic-only'); process.exit(2);
}
const runId = randomUUID();
const label = 'factuez.backup.pg-isolated.run';
const resources = [];
let checks = 0;
function docker(args, options = {}) {
  const r = spawnSync('docker', ['--context', 'desktop-linux', ...args], {
    input: options.input, encoding: options.binary ? null : 'utf8', timeout: 60000,
    maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  });
  if (r.error || r.status !== 0) {
    if (options.expectFailure && typeof r.status === 'number' && r.status !== 0) return r;
    throw new Error(`Docker failed (${args.slice(0, 2).join(' ')}): ${String(r.stderr || r.error || '').slice(0, 1000)}`);
  }
  if (options.expectFailure) throw new Error('Se esperaba un fallo y el comando tuvo éxito');
  return r.stdout;
}
const meta = args => docker(args).trim();
function verify(resource) {
  const c = JSON.parse(meta(['inspect', '--format', '{{json .}}', resource.id]));
  assert.equal(c.Id, resource.id); assert.equal(c.Name, '/' + resource.name);
  assert.equal(c.Config.Labels[label], runId); assert.equal(c.Config.Labels['factuez.backup.pg-isolated.role'], resource.role);
  assert.equal(c.HostConfig.NetworkMode, 'none');
  assert.equal(Object.keys(c.HostConfig.PortBindings || {}).length, 0);
  assert.equal(Object.keys(c.NetworkSettings.Ports || {}).length === 0 || Object.values(c.NetworkSettings.Ports).every(x => x === null), true);
  assert.ok(c.HostConfig.Tmpfs?.['/var/lib/postgresql/data']);
  assert.ok(c.HostConfig.Tmpfs?.['/tmp']);
  assert.ok(c.Mounts.every(m => m.Type === 'tmpfs'));
  assert.equal(c.Config.Image, image);
}
function execute(resource, args, opts) { verify(resource); return docker(['exec', ...(opts?.input ? ['-i'] : []), resource.id, ...args], opts); }
function sql(resource, db, statement, expectFailure = false) {
  return execute(resource, ['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', db], {input: statement, expectFailure});
}
async function create(role) {
  const name = `factuez-pg-restore-test-${role}-${runId}`;
  const id = meta(['run', '--pull', 'never', '--rm', '-d', '--name', name,
    '--label', `${label}=${runId}`, '--label', `factuez.backup.pg-isolated.role=${role}`,
    '--network', 'none', '--memory', '384m', '--cpus', '1', '--pids-limit', '128',
    '--tmpfs', '/var/lib/postgresql/data:rw,size=268435456', '--tmpfs', '/tmp:rw,size=33554432',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', image, 'postgres', '-c', 'listen_addresses=']);
  assert.match(id, /^[0-9a-f]{64}$/);
  const resource = {id, name, role}; resources.push(resource); verify(resource);
  let ready = false;
  for (let i = 0; i < 100; i++) {
    const r = spawnSync('docker', ['--context', 'desktop-linux', 'exec', id, 'pg_isready', '-h', '/var/run/postgresql', '-U', 'postgres'], {stdio:'ignore', timeout: 3000, windowsHide:true});
    if (r.status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(ready, 'PostgreSQL de prueba no inició');
  verify(resource);
  assert.equal(sql(resource, 'postgres', 'SHOW listen_addresses;').trim(), '');
  return resource;
}
function check(value, description) { assert.ok(value, description); checks++; }
function snapshot(resource, db) {
  return JSON.parse(sql(resource, db, `SELECT jsonb_build_object(
   'rows',(SELECT jsonb_agg(jsonb_build_array(id, customer, amount, status) ORDER BY id) FROM invoice),
   'sequence',(SELECT jsonb_build_array(last_value::text,is_called) FROM invoice_id_seq),
   'check',(SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='amount_positive'),
   'index',(SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='invoice_status_idx'),
   'trigger',(SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname='invoice_guard'),
   'function',(SELECT pg_get_functiondef('public.guard_invoice()'::regprocedure)),
   'empty',(SELECT count(*) FROM empty_table))::text;`).trim());
}
let image;
async function main() {
  assert.equal(process.platform, 'win32', 'La prueba requiere Docker Desktop local en Windows');
  assert.equal(meta(['context', 'inspect', 'desktop-linux', '--format', '{{(index .Endpoints "docker").Host}}']), 'npipe:////./pipe/dockerDesktopLinuxEngine');
  image = meta(['image', 'inspect', '--format', '{{.Id}}', 'postgres:17-alpine']);
  assert.match(image, /^sha256:[0-9a-f]{64}$/);
  const source = await create('source'), target = await create('target');
  sql(source, 'postgres', 'CREATE DATABASE synthetic_source;');
  sql(target, 'postgres', 'CREATE DATABASE synthetic_restore;');
  sql(source, 'synthetic_source', `
   CREATE TABLE invoice(id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, customer text NOT NULL,
     amount numeric(12,2) NOT NULL CONSTRAINT amount_positive CHECK(amount > 0), status text NOT NULL);
   CREATE INDEX invoice_status_idx ON invoice(status);
   CREATE TABLE empty_table(id int PRIMARY KEY);
   CREATE FUNCTION guard_invoice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
     IF NEW.status NOT IN ('PENDING','UNKNOWN') THEN RAISE EXCEPTION 'invalid status'; END IF; RETURN NEW;
   END $$;
   CREATE TRIGGER invoice_guard BEFORE INSERT OR UPDATE ON invoice FOR EACH ROW EXECUTE FUNCTION guard_invoice();
   INSERT INTO invoice(customer,amount,status) VALUES ('CLIENTE FICTICIO A',12.30,'PENDING'),('CLIENTE FICTICIO B',57.10,'UNKNOWN');
   SELECT setval('invoice_id_seq',9007199254740993,true);
  `);
  const before = snapshot(source, 'synthetic_source');
  check(before.rows.length === 2 && before.sequence[0] === '9007199254740993', 'datos ficticios y secuencia');
  check(sql(target, 'synthetic_restore', "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public';").trim() === '0', 'destino vacío');
  const dump = execute(source, ['pg_dump', '-U', 'postgres', '-d', 'synthetic_source', '--format=custom', '--compress=0'], {binary:true});
  check(Buffer.isBuffer(dump) && dump.length > 32 && dump.subarray(0,5).toString() === 'PGDMP', 'dump custom nativo');
  const toc = execute(target, ['pg_restore', '--format=custom', '--list'], {input:dump}).toString();
  check(toc.includes('TABLE DATA public invoice') && toc.includes('TRIGGER public invoice'), 'TOC con datos y trigger');
  execute(target, ['pg_restore', '-U', 'postgres', '-d', 'synthetic_restore', '--format=custom', '--single-transaction', '--exit-on-error'], {input:dump.subarray(0,64), expectFailure:true}); checks++;
  check(sql(target, 'synthetic_restore', "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public';").trim() === '0', 'archivo truncado no modifica el destino');
  execute(target, ['pg_restore', '-U', 'postgres', '-d', 'synthetic_restore', '--format=custom', '--single-transaction', '--exit-on-error'], {input:dump});
  const after = snapshot(target, 'synthetic_restore');
  assert.deepEqual(after, before); checks++;
  sql(target, 'synthetic_restore', "INSERT INTO invoice(id,customer,amount,status) VALUES (100,'FICTICIO',-1,'PENDING');", true); checks++;
  sql(target, 'synthetic_restore', "INSERT INTO invoice(id,customer,amount,status) VALUES (101,'FICTICIO',1,'INVALID');", true); checks++;
  check(sql(target, 'synthetic_restore', "INSERT INTO invoice(customer,amount,status) VALUES ('FICTICIO',1,'PENDING') RETURNING id;").trim() === '9007199254740994', 'secuencia funcional');
  check(sql(source, 'synthetic_source', 'SELECT count(*) FROM invoice;').trim() === '2', 'origen sin mutación por restore');
  const digest = createHash('sha256').update(dump).digest('hex');
  dump.fill(0);
  console.log(JSON.stringify({result:'PASS', runId, checks, postgres:'17-alpine', dumpSha256:digest,
    syntheticOnly:true, network:'none', publishedPorts:false, separateClusters:true, productionAuthorized:false}));
}
(async () => {
  let failed = false;
  try { await main(); } catch (err) { failed = true; console.error(err.stack || err); }
  for (const resource of resources.reverse()) {
    try { verify(resource); meta(['stop', '--time', '2', resource.id]); console.log(`Eliminado contenedor efímero ${resource.role}`); }
    catch (err) { failed = true; console.error(`No se pudo comprobar/eliminar el recurso ${resource.id}: ${err.message}`); }
  }
  if (failed) process.exitCode = 1;
})();