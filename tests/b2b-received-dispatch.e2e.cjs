'use strict';
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {resolve, dirname, join} = require('node:path');
const {mkdirSync,writeFileSync} = require('node:fs');
assert.deepEqual(process.argv.slice(2), ['--isolated-synthetic-only'], 'ISOLATED_SYNTHETIC_ONLY_REQUIRED');
const runtime = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
// Only OS/CLI essentials are inherited: no application URLs, connector flags,
// vault keys, access tokens or credentials. The helper owns its NEW target.
const env = {};
const allowed = new Set(['path','systemroot','windir','comspec','pathext','temp','tmp',
  'userprofile','appdata','localappdata','programdata','programfiles','programfiles(x86)',
  'commonprogramfiles','homedrive','homepath']);
for (const [key, value] of Object.entries(process.env)) if (allowed.has(key.toLowerCase())) env[key] = value;
env.FACTUEZ_B2B_RECEIVED_OWNED_DB = 'NEW_NETWORK_NONE_TMPFS_ONLY';
env.NODE_ENV = 'test';
env.CI = 'true';
const child = spawn(process.execPath, [runtime, 'run', '--config',
  'tests/b2b-received-dispatch.config.mts', '--reporter=json'], {
  cwd: resolve(__dirname, '..'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env,
});
let stdout = '', stderrLine = '', failed = false;
const watchdog = setTimeout(() => {failed = true; child.kill();}, 600000);
child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
child.stdout.on('data', chunk => {
  stdout += chunk;
  if (stdout.length > 8 * 1024 * 1024) {failed = true; child.kill();}
});
// Forward only our explicit synthetic SQL diagnostic marker as soon as it is
// produced; arbitrary child output and environment information stay hidden.
child.stderr.on('data', chunk => {
  stderrLine += chunk;
  const lines = stderrLine.split(/\r?\n/); stderrLine = lines.pop() ?? '';
  for (const line of lines) {
    const start = line.indexOf('B2B_RECEIVED_DISPATCH_SQL_DIAGNOSTIC ');
    if (start >= 0) console.log(line.slice(start, start + 1000));
  }
});
child.on('error', () => {failed = true; console.error('B2B_RECEIVED_DISPATCH_RUNNER_FAILED');});
child.on('close', code => {
  clearTimeout(watchdog);
  let reported = false;
  try {
    const report = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    const reportDirectory=resolve(__dirname,'../output/qa');mkdirSync(reportDirectory,{recursive:true});
    writeFileSync(join(reportDirectory,'b2b-received-dispatch-db.json'),JSON.stringify(report));
    reported = true;
    console.log(`B2B_RECEIVED_DISPATCH total=${report.numTotalTests} passed=${report.numPassedTests} failed=${report.numFailedTests} pending=${report.numPendingTests}`);
    const groups = new Map();
    for (const suite of report.testResults ?? []) {
      for (const test of suite.assertionResults ?? []) if (test.status === 'failed') {
        console.log(`FAIL ${test.fullName}`);
        for (const message of test.failureMessages ?? []) {
          // Avoid repeating the same shared-core stack for every failed case.
          const first = message.split('\n')[0];
          if (!groups.has(first)) {groups.set(first, true); console.log(message.slice(0, 2400));}
        }
      }
      if (suite.message && !(suite.assertionResults ?? []).some(test => test.status === 'failed')) console.log(suite.message.slice(0, 1200));
    }
  } catch {console.error('B2B_RECEIVED_DISPATCH_RUNNER_FAILED: no structured test report');}
  process.exitCode = failed || !reported ? 1 : code ?? 1;
});
