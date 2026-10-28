'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { resolve, dirname, join } = require('node:path');
assert.deepEqual(process.argv.slice(2), ['--isolated-synthetic-only'], 'ISOLATED_SYNTHETIC_ONLY_REQUIRED');
const runtime = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const result = spawnSync(process.execPath, [runtime, 'run', '--config', 'tests/vitest.carrier-guide-http-db.config.mts'], {
  cwd: resolve(__dirname, '..'), windowsHide: true, stdio: 'inherit', timeout: 300000,
  env: { ...process.env, FACTUEZ_CARRIER_HTTP_OWNED_DB: 'NEW_NETWORK_NONE_TMPFS_ONLY' },
});
if (result.error) { console.error('CARRIER_GUIDE_HTTP_DB_RUNNER_FAILED'); process.exitCode = 1; }
else process.exitCode = result.status ?? 1;
