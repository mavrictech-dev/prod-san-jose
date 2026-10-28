'use strict';
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { resolve, dirname, join } = require('node:path');
const {
  LABEL, dockerExecutable, dockerArgs, isolatedEnvironment,
} = require('./helpers/b2b-received-dispatch-redis.cjs');

const workerShutdown=JSON.stringify(process.argv.slice(2))===JSON.stringify(['--isolated-synthetic-only','--worker-shutdown']);
if(!workerShutdown)assert.deepEqual(process.argv.slice(2), ['--isolated-synthetic-only'], 'EXPLICIT_NEW_REDIS_RUNNER_REQUIRED');
const testConfig=workerShutdown?'tests/b2b-worker-shutdown-redis.config.mts':'tests/b2b-received-dispatch-redis.config.mts';
const root = resolve(__dirname, '..');
const runId = randomUUID();
const name = 'factuez-b2b-received-dispatch-' + runId;
const password = 'synthetic-' + randomBytes(24).toString('hex');
const upstreamSecret = 'synthetic-' + randomBytes(24).toString('hex');
let container;
let testProcess;
let interrupted = false;
function docker(args, input) {
  const result = spawnSync(dockerExecutable, dockerArgs(args), {
    input, encoding: 'utf8', windowsHide: true, env: isolatedEnvironment(),
    timeout: 10000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, 'ISOLATED_DOCKER_COMMAND_FAILED');
  assert.equal(result.status, 0, 'ISOLATED_DOCKER_COMMAND_FAILED');
  return result.stdout.trim();
}
function inspectOwned() {
  assert.match(container, /^[a-f0-9]{64}$/);
  // Inspect only ownership/isolation facts, never a current service's config/env.
  const format = '{"id":{{json .Id}},"name":{{json .Name}},"labels":{{json .Config.Labels}},"image":{{json .Config.Image}},"host":{{json .HostConfig}},"mounts":{{json .Mounts}},"ports":{{json .NetworkSettings.Ports}}}';
  const owned = JSON.parse(docker(['inspect', '--format', format, container]));
  assert.equal(owned.id, container, 'OWNERSHIP_ID_MISMATCH');
  assert.equal(owned.name, '/' + name, 'OWNERSHIP_NAME_MISMATCH');
  assert.equal(owned.labels?.[LABEL], runId, 'OWNERSHIP_LABEL_MISMATCH');
  assert.equal(owned.image, 'redis:7-alpine');
  assert.equal(owned.host.NetworkMode, 'none');
  assert.equal(Object.keys(owned.host.PortBindings ?? {}).length, 0);
  assert.equal(owned.host.AutoRemove, true);
  assert.ok(owned.host.Tmpfs?.['/data']);
  // Docker 29 omits tmpfs entries from .Mounts; verify the actual filesystem too.
  assert.equal(docker(['exec', container, 'stat', '-f', '-c', '%T', '/data']), 'tmpfs', 'DATA_IS_NOT_TMPFS');
  assert.ok(owned.mounts.every(mount => mount.Type === 'tmpfs'), 'UNEXPECTED_PERSISTENT_MOUNT');
  assert.ok(Object.values(owned.ports ?? {}).every(binding => binding === null));
}
function interrupt() { interrupted = true; testProcess?.kill(); }
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
async function main() {
  try {
    docker(['image', 'inspect', '--format', '{{.Id}}', 'redis:7-alpine']); // Local only; never pull.
    container = docker([
      'run', '--pull=never', '--rm', '-d', '--name', name, '--label', LABEL + '=' + runId,
      '--network', 'none', '--memory', '128m', '--cpus', '1',
      '--tmpfs', '/data:rw,noexec,nosuid,size=64m',
      'redis:7-alpine', 'redis-server', '--bind', '127.0.0.1', '--port', '6379',
      '--dir', '/data', '--save', '', '--appendonly', 'no', '--requirepass', password,
    ]);
    inspectOwned();
    let ready = false;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !interrupted) {
      // Password goes via stdin, not shell interpolation or an inherited Redis URL.
      const pong = docker(['exec', '-i', container, 'redis-cli', '--raw'], 'AUTH ' + password + '\nPING\n');
      if (pong.endsWith('PONG')) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready && !interrupted, 'ISOLATED_REDIS_NOT_READY');
    const capability = { version: 1, runId, container, password, upstreamSecret };
    const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
    const status = await new Promise((resolveStatus, reject) => {
      let timedOut = false;
      let outputSize = 0;
      // Buffer until child exit: redaction remains correct across chunk boundaries.
      const output = [];
      testProcess = spawn(process.execPath, [vitest, 'run', '--config', testConfig], {
        cwd: root, env: isolatedEnvironment(capability), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const timeout = setTimeout(() => { timedOut = true; testProcess.kill(); }, 70000);
      const capture = chunk => {
        outputSize += chunk.length;
        if (outputSize <= 4 * 1024 * 1024) output.push(chunk);
        else { timedOut = true; testProcess.kill(); }
      };
      testProcess.stdout.on('data', capture);
      testProcess.stderr.on('data', capture);
      testProcess.once('error', () => { clearTimeout(timeout); reject(new Error('ISOLATED_VITEST_LAUNCH_FAILED')); });
      testProcess.once('close', code => {
        clearTimeout(timeout);
        testProcess = undefined;
        const safe = Buffer.concat(output).toString('utf8').split(password).join('[REDACTED_TEST_SECRET]').split(upstreamSecret).join('[REDACTED_TEST_SECRET]');
        process.stdout.write(safe);
        resolveStatus(timedOut || interrupted ? 1 : code ?? 1);
      });
    });
    assert.equal(status, 0, 'ISOLATED_REDIS_SUITE_FAILED');
    const logs = docker(['logs', container]);
    assert.ok(!logs.includes(password) && !logs.includes(upstreamSecret), 'REDIS_LOG_SECRET_LEAK');
    process.stdout.write('Owned Redis logs: no synthetic secret; isolation verified.\n');
  } finally {
    try {
      if (container) {
        // Re-read the full UUID label, identity and isolation immediately before removal.
        inspectOwned();
        docker(['stop', '--time', '1', container]);
        process.stdout.write('Owned Redis container stopped and removed.\n');
      }
    } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    }
  }
}
void main().catch(error => {
  // No upstream command bodies, stderr, connection strings or test secrets in logs.
  const known = error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'ISOLATED_REDIS_RUNNER_FAILED';
  process.stderr.write(known.split(password).join('[REDACTED_TEST_SECRET]').split(upstreamSecret).join('[REDACTED_TEST_SECRET]') + '\n');
  process.exitCode = 1;
});
