'use strict';
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {resolve,dirname,join} = require('node:path');
assert.deepEqual(process.argv.slice(2),['--isolated-synthetic-only'],'ISOLATED_SYNTHETIC_ONLY_REQUIRED');
const runtime = join(dirname(require.resolve('vitest/package.json')),'vitest.mjs');
const r = spawnSync(process.execPath,[runtime,'run','--config','tests/vitest.phase7-crypto.config.mts'],{
  cwd:resolve(__dirname,'..'),windowsHide:true,stdio:'inherit',timeout:300000,
  env:{...process.env,FACTUEZ_PHASE7_OWNED_CRYPTO_DB:'NEW_NETWORK_NONE_TMPFS_ONLY'},
});
if(r.error) { console.error('PHASE7_CRYPTO_DB_RUNNER_FAILED'); process.exitCode=1; }
else process.exitCode=r.status??1;
