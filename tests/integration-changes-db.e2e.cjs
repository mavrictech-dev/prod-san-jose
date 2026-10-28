'use strict';

// Manual, synthetic-only phase6 verification. Main must compile the interfaces
// before invoking this file. No build, pull, migration or existing DB discovery.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { realpathSync, statSync } = require('node:fs');
const { resolve, relative, isAbsolute } = require('node:path');

const guard = '--isolated-synthetic-only';
if (process.argv.length !== 3 || process.argv[2] !== guard) {
  console.error(JSON.stringify({ result: 'FAIL', stage: 'explicit-synthetic-guard', realData: false }));
  process.exit(1);
}

const repo = realpathSync(resolve(__dirname, '..'));
const id = randomUUID();
const name = 'factuez-i6-' + id.replaceAll('-', '').slice(0, 12);
const db = name + '-db', runner = name + '-runner';
const labels = ['--label', 'factuez.integration.test=' + id, '--label', 'factuez.integration.phase=6'];
const targets = new Set([name, db, runner]);
let stage = 'compiled-software-preflight';

function invoke(args, timeout = 30000) {
  return spawnSync('docker', args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 1024 * 1024 });
}
function docker(args) {
  const result = invoke(args);
  if (result.error || result.status !== 0) throw new Error('Isolated Docker operation failed');
  return result.stdout.trim();
}
function inspect(kind, target) {
  assert.ok(targets.has(target));
  const value = JSON.parse(docker([kind, 'inspect', target]));
  assert.equal(value.length, 1);
  return value[0];
}
function owned(kind, target) {
  const value = inspect(kind, target);
  const actual = kind === 'network' ? value.Labels : value.Config.Labels;
  assert.equal(actual['factuez.integration.test'], id);
  assert.equal(actual['factuez.integration.phase'], '6');
  assert.equal(kind === 'network' ? value.Name : value.Name.slice(1), target);
  return value;
}
function mounted(source, target) {
  const path = realpathSync(resolve(repo, source));
  const inside = relative(repo, path);
  assert.ok(inside && inside !== '..' && !inside.startsWith('..\\') && !inside.startsWith('../') && !isAbsolute(inside));
  assert.ok(statSync(path).isFile());
  assert.ok(!path.includes(','));
  return { path, target, args: ['--mount', 'type=bind,source=' + path + ',target=' + target + ',readonly'] };
}
function noPorts(value) {
  assert.equal(value.HostConfig.PublishAllPorts, false);
  assert.equal(Object.keys(value.HostConfig.PortBindings ?? {}).length, 0);
  assert.ok(Object.values(value.NetworkSettings.Ports ?? {}).every(bindings => bindings === null));
}
function summary(result, at, extra = {}) {
  console.log(JSON.stringify({ result, stage: at, realData: false, ...extra }));
}

try {
  // Bind only the compiled dependency closure, three SQL blueprints and this
  // new runner. In particular: no .env, QA config, credentials, volumes or repo.
  const mounts = [
    ['packages/contracts/package.json', '/workspace/packages/contracts/package.json'],
    ['packages/contracts/dist/integration-extraction.js', '/workspace/packages/contracts/dist/integration-extraction.js'],
    ['packages/service-access/dist/integration.js', '/workspace/packages/service-access/dist/integration.js'],
    ['packages/service-access/dist/integration-journal.js', '/workspace/packages/service-access/dist/integration-journal.js'],
    ['services/billing-service/dist/integration/capture-repository.js', '/workspace/services/billing-service/dist/integration/capture-repository.js'],
    ['services/billing-service/dist/integration/capture.js', '/workspace/services/billing-service/dist/integration/capture.js'],
    ['services/billing-service/dist/integration/read.js', '/workspace/services/billing-service/dist/integration/read.js'],
    ['services/integration-export-service/dist/change-store.js', '/workspace/services/billing-service/dist/integration-export/change-store.js'],
    ['services/integration-export-service/dist/vault.js', '/workspace/services/billing-service/dist/integration-export/vault.js'],
    ['services/integration-export-service/dist/model.js', '/workspace/services/billing-service/dist/integration-export/model.js'],
    ['services/billing-service/prisma/integration-changes.sql', '/fixture/billing.sql'],
    ['services/sunat-service/prisma/integration-changes.sql', '/fixture/sunat.sql'],
    ['services/integration-export-service/sql/integration-changes.sql', '/fixture/delivery.sql'],
    ['tests/integration-changes-db.runner.cjs', '/fixture/run.cjs'],
  ].map(([source, target]) => mounted(source, target));

  stage = 'software-image-preflight';
  const postgresImage = docker(['image', 'inspect', '--format', '{{.Id}}', 'postgres:17-alpine']);
  const softwareImage = docker(['image', 'inspect', '--format', '{{.Id}}', 'factuez-stage2-qa/billing-service:local']);
  assert.match(postgresImage, /^sha256:[a-f0-9]{64}$/);
  assert.match(softwareImage, /^sha256:[a-f0-9]{64}$/);

  stage = 'new-internal-network';
  docker(['network', 'create', '--internal', ...labels, name]);
  assert.equal(owned('network', name).Internal, true);

  stage = 'new-tmpfs-postgresql';
  const password = randomBytes(32).toString('base64url');
  docker(['create', '--name', db, ...labels, '--network', name, '--memory', '384m', '--cpus', '1', '--pids-limit', '128',
    '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data,tmpfs-size=201326592',
    '--env', 'POSTGRES_USER=integration_fixture', '--env', 'POSTGRES_DB=integration_fixture',
    '--env', 'POSTGRES_PASSWORD=' + password, postgresImage]);
  const postgres = owned('container', db);
  noPorts(postgres);
  assert.equal(postgres.HostConfig.NetworkMode, name);
  assert.equal(postgres.Mounts.length, 1);
  assert.equal(postgres.Mounts[0].Type, 'tmpfs');
  assert.equal(postgres.Mounts[0].Destination, '/var/lib/postgresql/data');
  docker(['start', db]);

  stage = 'new-readonly-runner';
  // env -i discards the image's service/QA environment. Only ephemeral fixture
  // connection details reach Node. The image supplies Node/pg/Prisma software.
  docker(['create', '--name', runner, ...labels, '--network', name, '--read-only', '--cap-drop=ALL',
    '--security-opt', 'no-new-privileges', '--user', '65534:65534', '--memory', '512m', '--cpus', '2', '--pids-limit', '128',
    '--entrypoint', '/usr/bin/env', ...mounts.flatMap(m => m.args), softwareImage,
    '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'NODE_ENV=test', 'FIXTURE_RUN_ID=' + id,
    'FIXTURE_DATABASE_HOST=' + db, 'FIXTURE_DATABASE_PASSWORD=' + password, 'node', '/fixture/run.cjs', guard]);
  const fixture = owned('container', runner);
  noPorts(fixture);
  assert.equal(fixture.HostConfig.NetworkMode, name);
  assert.equal(fixture.HostConfig.ReadonlyRootfs, true);
  assert.ok(fixture.HostConfig.CapDrop.includes('ALL'));
  assert.ok(fixture.HostConfig.SecurityOpt.some(option => option.startsWith('no-new-privileges')));
  assert.equal(fixture.Mounts.length, mounts.length);
  assert.ok(fixture.Mounts.every(m => m.Type === 'bind' && m.RW === false && mounts.some(expected => expected.target === m.Destination)));
  assert.deepEqual(Object.keys(owned('network', name).Containers).sort(), [postgres.Id].sort());

  stage = 'synthetic-phase6-verification';
  const result = invoke(['start', '--attach', runner], 120000);
  // Whitelist output fields. Never forward stderr, diagnostics, SQL or values.
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1);
  const report = JSON.parse(lines[0]);
  assert.ok(['PASS', 'FAIL'].includes(report.result));
  assert.equal(report.realData, false);
  assert.ok(Number.isSafeInteger(report.checks) && report.checks >= 0);
  assert.ok(typeof report.stage === 'string' && /^[a-z0-9-]{1,80}$/.test(report.stage));
  summary(report.result, report.stage, { checks: report.checks });
  const completed = owned('container', runner);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(completed.State.ExitCode, 0);
  assert.equal(report.result, 'PASS');
} catch {
  summary('FAIL', stage);
  process.exitCode = 1;
} finally {
  // Inspect exact random names and both ownership labels before every removal.
  // A mismatch leaves that resource intact and makes cleanup visibly fail.
  let cleanupFailed = false;
  for (const target of [runner, db]) {
    try {
      const listed = docker(['container', 'ls', '--all', '--filter', 'name=^/' + target + '$', '--format', '{{.Names}}']);
      if (!listed) continue;
      assert.equal(listed, target);
      owned('container', target);
      docker(['container', 'rm', '--force', target]);
    } catch { cleanupFailed = true; }
  }
  try {
    const listed = docker(['network', 'ls', '--filter', 'name=^' + name + '$', '--format', '{{.Name}}']);
    if (listed) {
      assert.equal(listed, name);
      assert.equal(Object.keys(owned('network', name).Containers).length, 0);
      docker(['network', 'rm', name]);
    }
  } catch { cleanupFailed = true; }
  summary(cleanupFailed ? 'FAIL' : 'PASS', 'cleanup-exact-labelled-resources');
  if (cleanupFailed) process.exitCode = 1;
}
