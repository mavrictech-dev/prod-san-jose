'use strict';

// Phase7: actual local Kong, fictional TLS only, no existing runtime inspection.
// No pulls, published ports, existing volumes, source migrations or real data.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { realpathSync, statSync } = require('node:fs');
const { resolve, relative, isAbsolute, dirname } = require('node:path');
const { createRequire } = require('node:module');
const guard = '--isolated-synthetic-only';
if (process.argv.length !== 3 || process.argv[2] !== guard) {
  console.error(JSON.stringify({ result: 'FAIL', stage: 'explicit-synthetic-guard', realData: false }));
  process.exit(1);
}
const repo = realpathSync(resolve(__dirname, '..'));
const id = randomUUID(), prefix = 'factuez-i7-' + id.replaceAll('-', '').slice(0, 12);
const names = { network: prefix, volume: prefix + '-tls', runner: prefix + '-runner', kong: prefix + '-kong', outside: prefix + '-outside' };
const targets = new Set(Object.values(names));
const labels = ['--label', 'factuez.integration.test=' + id, '--label', 'factuez.integration.phase=7'];
let stage = 'software-preflight';
function invoke(args, timeout = 30000) {
  return spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 2 * 1024 * 1024 });
}
function docker(args, timeout) {
  const r = invoke(args, timeout);
  if (r.error || r.status !== 0) throw new Error('Isolated Docker operation failed');
  return r.stdout.trim();
}
function inspect(kind, name) {
  assert.ok(targets.has(name));
  const rows = JSON.parse(docker([kind, 'inspect', name])); assert.equal(rows.length, 1); return rows[0];
}
function owned(kind, name) {
  const value = inspect(kind, name), actual = kind === 'container' ? value.Config.Labels : value.Labels;
  assert.equal(actual['factuez.integration.test'], id); assert.equal(actual['factuez.integration.phase'], '7');
  assert.equal(kind === 'container' ? value.Name.slice(1) : value.Name, name); return value;
}
function mounted(source, target, directory = false) {
  const path = realpathSync(resolve(repo, source)), inside = relative(repo, path);
  assert.ok(inside && inside !== '..' && !inside.startsWith('..\\') && !inside.startsWith('../') && !isAbsolute(inside));
  assert.ok(directory ? statSync(path).isDirectory() : statSync(path).isFile()); assert.ok(!path.includes(','));
  return { path, target, args: ['--mount', 'type=bind,source=' + path + ',target=' + target + ',readonly'] };
}
function noPorts(c) {
  assert.equal(c.HostConfig.PublishAllPorts, false);
  assert.equal(Object.keys(c.HostConfig.PortBindings ?? {}).length, 0);
  assert.ok(Object.values(c.NetworkSettings.Ports ?? {}).every(v => v === null));
}
function summary(result, at, extra = {}) { console.log(JSON.stringify({ result, stage: at, realData: false, ...extra })); }
function checkedReport(raw) {
  const r = JSON.parse(raw);
  assert.ok(['PASS', 'FAIL'].includes(r.result)); assert.equal(r.realData, false);
  assert.match(r.stage, /^[a-z0-9-]{1,100}$/); assert.ok(Number.isSafeInteger(r.checks) && r.checks >= 0);
  if (r.httpStatus !== undefined) assert.ok(Number.isSafeInteger(r.httpStatus) && r.httpStatus >= 100 && r.httpStatus <= 599);
  return { result: r.result, stage: r.stage, checks: r.checks, ...(r.httpStatus === undefined ? {} : { httpStatus: r.httpStatus }) };
}
try {
  const softwareRequire = createRequire(resolve(repo, 'packages/evidence-core/package.json'));
  const vendor = dirname(dirname(realpathSync(softwareRequire.resolve('node-forge'))));
  const mounts = [mounted('infra/integration/private-edge.mjs', '/fixture/private-edge.mjs'),
    mounted('api-contracts/integration/private-api.openapi.v1.json', '/fixture/contract.json'),
    mounted('tests/integration-edge.runner.cjs', '/fixture/run.cjs'), mounted(vendor, '/fixture/vendor/node-forge', true)];
  const kongImage = docker(['image', 'inspect', '--format', '{{.Id}}', 'kong:3.9.3']);
  const nodeImage = docker(['image', 'inspect', '--format', '{{.Id}}', 'node:24.16.0-bookworm-slim']);
  assert.match(kongImage, /^sha256:12972ce1ab63[a-f0-9]{52}$/);
  assert.match(nodeImage, /^sha256:[a-f0-9]{64}$/);
  stage = 'new-internal-network';
  docker(['network', 'create', '--internal', ...labels, names.network]); assert.equal(owned('network', names.network).Internal, true);
  stage = 'new-ephemeral-tls-volume';
  docker(['volume', 'create', ...labels, '--driver', 'local', '--opt', 'type=tmpfs', '--opt', 'device=tmpfs',
    '--opt', 'o=size=33554432,mode=1777', names.volume]);
  const volume = owned('volume', names.volume); assert.equal(volume.Options.type, 'tmpfs'); assert.equal(volume.Options.device, 'tmpfs');
  stage = 'new-readonly-fixture';
  docker(['create', '--name', names.runner, ...labels, '--network', names.network, '--read-only', '--cap-drop=ALL',
    '--security-opt', 'no-new-privileges', '--user', '1000:1000', '--memory', '384m', '--cpus', '2', '--pids-limit', '128',
    '--mount', 'type=volume,source=' + names.volume + ',target=/run/factuez-edge',
    ...mounts.flatMap(m => m.args), '--entrypoint', '/usr/bin/env', nodeImage,
    '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'NODE_ENV=test', 'FIXTURE_RUN_ID=' + id,
    'node', '/fixture/run.cjs', 'serve', guard]);
  const runner = owned('container', names.runner); noPorts(runner);
  assert.equal(runner.HostConfig.NetworkMode, names.network); assert.equal(runner.HostConfig.ReadonlyRootfs, true);
  assert.ok(runner.HostConfig.CapDrop.includes('ALL')); assert.equal(runner.Mounts.length, mounts.length + 1);
  assert.ok(runner.Mounts.every(m => m.Type === 'volume' ? m.Name === names.volume : m.RW === false && mounts.some(x => x.target === m.Destination)));
  docker(['start', names.runner]);
  stage = 'fixture-ready';
  let ready = false;
  for (let n = 0; n < 45; n++) {
    const probe = invoke(['exec', names.runner, '/usr/bin/env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin',
      'FIXTURE_RUN_ID=' + id, 'node', '/fixture/run.cjs', 'ready', guard]);
    if (!probe.error && probe.status === 0) { const r = checkedReport(probe.stdout.trim()); assert.equal(r.result, 'PASS'); ready = true; break; }
    // Bounded waits inside the disposable test, never a host process/config poll.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  assert.equal(ready, true);
  stage = 'new-actual-kong';
  docker(['create', '--name', names.kong, ...labels, '--network', 'container:' + names.runner, '--read-only', '--cap-drop=ALL',
    '--security-opt', 'no-new-privileges', '--user', '1000:1000', '--memory', '384m', '--cpus', '2', '--pids-limit', '128',
    '--mount', 'type=volume,source=' + names.volume + ',target=/run/factuez-edge,readonly',
    '--mount', 'type=tmpfs,destination=/tmp,tmpfs-size=67108864,tmpfs-mode=1777',
    '--mount', 'type=tmpfs,destination=/tmp/kong,tmpfs-size=67108864,tmpfs-mode=1777',
    // Fixture-only startup diagnostics, sanitized below. No access/debug logs.
    '--env', 'KONG_PREFIX=/tmp/kong', '--env', 'KONG_PROXY_ERROR_LOG=/dev/stderr',
    '--env', 'KONG_NGINX_MAIN_ERROR_LOG=/dev/stderr', '--env', 'KONG_LOG_LEVEL=notice', '--entrypoint', '/bin/sh', kongImage,
    '-c', 'mkdir -p /tmp/kong && exec /docker-entrypoint.sh kong docker-start -c /run/factuez-edge/kong.conf']);
  const kong = owned('container', names.kong); noPorts(kong);
  assert.equal(kong.HostConfig.NetworkMode, 'container:' + runner.Id);
  assert.equal(kong.HostConfig.ReadonlyRootfs, true); assert.ok(kong.HostConfig.CapDrop.includes('ALL'));
  assert.equal(kong.Mounts.length, 3); assert.ok(kong.Mounts.some(m => m.Name === names.volume && !m.RW));
  assert.ok(kong.Mounts.filter(m => m.Type === 'tmpfs').every(m => ['/tmp', '/tmp/kong'].includes(m.Destination)));
  docker(['start', names.kong]);
  stage = 'synthetic-kong-security-verification';
  const verification = invoke(['exec', names.runner, '/usr/bin/env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin',
    'FIXTURE_RUN_ID=' + id, 'node', '/fixture/run.cjs', 'verify', guard], 120000);
  const report = checkedReport(verification.stdout.trim()); summary(report.result, report.stage,
    { checks: report.checks, ...(report.httpStatus === undefined ? {} : { httpStatus: report.httpStatus }) });
  if (report.result !== 'PASS') {
    const state = owned('container', names.kong).State;
    const log = invoke(['logs', names.kong]).stdout + invoke(['logs', names.kong]).stderr;
    // Only fixed diagnostic codes from our disposable process. Never raw logs.
    const categories = [
      ['DUPLICATE_DIRECTIVE', /directive is duplicate|duplicate.*directive/i],
      ['UNKNOWN_DIRECTIVE', /unknown directive/i], ['INVALID_CONFIG', /invalid configuration|invalid.*config|configuration.*invalid/i],
      ['INVALID_DECLARATIVE', /declarative.*(?:invalid|failed|error)|failed.*declarative/i],
      ['PERMISSION', /permission denied/i], ['TLS_CONFIGURATION', /ssl.*(?:failed|error)|certificate.*(?:failed|error)/i],
      ['MISSING_FILE', /No such file|not found/i], ['RESTY_PATH', /resty.*No such file/i],
      ['DECLARATIVE_MISSING', /kong\.json.*No such file/i], ['CERTIFICATE_MISSING', /\.pem.*No such file/i],
      ['UNKNOWN_USER', /whoami|cannot find name|unknown user/i], ['SYNTAX', /syntax|unexpected|invalid/i],
      ['LUA', /lua|stack traceback/i], ['NGINX', /nginx/i], ['BAD_ARGUMENT', /usage|unrecognized|unknown.*argument/i],
      ['BIND_FAILED', /bind\(\).*failed|address already in use|cannot assign requested address/i],
      ['MEMORY_FAILED', /not enough memory|cannot allocate memory|out of memory/i],
      ['THREAD_FAILED', /pthread_create|thread.*failed/i],
      ['LMDB_FAILED', /lmdb|mdb_env/i], ['OPEN_FAILED', /open\(\).*failed/i],
      ['TLS_NAME_MISMATCH', /certificate does not match|hostname mismatch|does not match.*127/i],
      ['TLS_CLIENT_REQUIRED', /certificate required|peer did not return.*certificate/i],
      ['TLS_CHAIN_VERIFY', /certificate verify failed|unable to get.*issuer|self.signed certificate/i],
      ['TLS_NO_FIRST_CERTIFICATE', /unable to verify the first certificate/i],
      ['TLS_INVALID_CA', /invalid CA certificate/i], ['TLS_PURPOSE', /unsuitable certificate purpose/i],
      ['TLS_CA_KEY_USAGE', /key usage does not include certificate signing/i],
    ].filter(([, pattern]) => pattern.test(log)).map(([code]) => code);
    const commandNames = ['kong', 'resty', 'luajit', 'nginx', 'openssl', 'env', 'lua'].filter(command =>
      new RegExp('(?:[ /‘"\\x27])' + command + '(?:[’"\\x27 :]).*(?:No such file|not found)', 'i').test(log));
    const directiveNames = [...new Set(Array.from(log.matchAll(/"([a-z_]{2,90})" directive/g), match => match[1]))];
    const softwarePaths = [...new Set(Array.from(log.matchAll(/\/(?:usr|tmp|run|bin|etc)\/[a-zA-Z0-9_./-]+/g), match => match[0]))];
    const configurationFields = ['require_content_length', 'allowed_payload_size', 'size_unit', 'ssl_verify_client', 'ssl_crl',
      'proxy_ssl_trusted_certificate', 'admin_gui_listen', 'limit_conn', 'client_max_body_size', 'proxy_listen',
      'admin_listen', 'status_listen', 'stream_listen', 'debug_listen', 'router_flavor', 'plugins', 'anonymous_reports',
      'allow_debug_header', 'headers', 'log_level', 'trusted_ips', 'real_ip_recursive', 'ssl_protocols', 'client_ssl',
      'lua_ssl_trusted_certificate', 'client_header_timeout', 'client_body_timeout', 'nginx_proxy_allow', 'nginx_proxy_deny',
      'tls_verify', 'methods', 'snis', 'paths', 'policy', 'limit_by'].filter(key => log.includes(key));
    // Schema explanations only, from this new fictitious process; never whole logs,
    // configured values, certificates, bodies, tokens or real upstream diagnostics.
    const validationReasons = log.split(/\r?\n/).filter(line => /\b(?:paths|snis|methods|tls_verify|policy|size_unit)['"]?\s*:/.test(line))
      .slice(0, 4).map(line => line.replace(/['"`]([^'"`]*)['"`]/g, (_all, value) =>
        ['paths', 'snis', 'methods', 'tls_verify', 'policy', 'size_unit'].includes(value) ? value : '[fixture-value]')
        .replace(/~?\^?\/[^\s]+/g, '[fixture-path]').replace(/[A-Za-z0-9+/=]{40,}/g, '[redacted]')
        .replace(/[^a-zA-Z _:\[\].,-]/g, '').trim().slice(0, 240));
    const tlsVerifyCodes = [...new Set(Array.from(log.matchAll(/certificate verify error:\s*\((\d{1,3}):/g), match => Number(match[1])))];
    summary('FAIL', 'kong-sanitized-diagnostic', { running: state.Running, exitCode: state.ExitCode, categories, commandNames, directiveNames, softwarePaths, configurationFields, validationReasons, tlsVerifyCodes });
  }
  assert.equal(verification.error, undefined); assert.equal(verification.status, 0); assert.equal(report.result, 'PASS');
  stage = 'actual-cidr-source-negative-probe';
  docker(['create', '--name', names.outside, ...labels, '--network', names.network, '--read-only', '--cap-drop=ALL',
    '--security-opt', 'no-new-privileges', '--user', '1000:1000', '--memory', '128m', '--cpus', '1', '--pids-limit', '64',
    '--mount', 'type=volume,source=' + names.volume + ',target=/run/factuez-edge,readonly',
    ...mounts.find(m => m.target === '/fixture/run.cjs').args, '--entrypoint', '/usr/bin/env', nodeImage,
    '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'FIXTURE_RUN_ID=' + id, 'node', '/fixture/run.cjs', 'outside', guard]);
  const outside = owned('container', names.outside); noPorts(outside); assert.equal(outside.HostConfig.NetworkMode, names.network);
  assert.equal(outside.HostConfig.ReadonlyRootfs, true); assert.ok(outside.Mounts.every(m => !m.RW));
  const probe = invoke(['start', '--attach', names.outside], 20000), negative = checkedReport(probe.stdout.trim());
  summary(negative.result, negative.stage, { checks: negative.checks }); assert.equal(probe.status, 0); assert.equal(negative.result, 'PASS');
} catch { summary('FAIL', stage); process.exitCode = 1; }
finally {
  let failed = false;
  for (const target of [names.outside, names.kong, names.runner]) {
    try { const found = docker(['container', 'ls', '--all', '--filter', 'name=^/' + target + '$', '--format', '{{.Names}}']);
      if (found) { assert.equal(found, target); owned('container', target); docker(['container', 'rm', '--force', target]); }
    } catch { failed = true; }
  }
  try { const found = docker(['volume', 'ls', '--filter', 'name=^' + names.volume + '$', '--format', '{{.Name}}']);
    if (found) { assert.equal(found, names.volume); owned('volume', names.volume); docker(['volume', 'rm', names.volume]); }
  } catch { failed = true; }
  try { const found = docker(['network', 'ls', '--filter', 'name=^' + names.network + '$', '--format', '{{.Name}}']);
    if (found) { assert.equal(found, names.network); assert.equal(Object.keys(owned('network', names.network).Containers).length, 0);
      docker(['network', 'rm', names.network]); }
  } catch { failed = true; }
  summary(failed ? 'FAIL' : 'PASS', 'cleanup-exact-labelled-resources'); if (failed) process.exitCode = 1;
}
