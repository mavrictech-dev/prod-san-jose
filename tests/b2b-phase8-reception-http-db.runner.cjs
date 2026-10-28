'use strict';
const assert=require('node:assert/strict');const {spawnSync}=require('node:child_process');const {join,dirname,resolve}=require('node:path');
assert.deepEqual(process.argv.slice(2),['--isolated-synthetic-only'],'ISOLATED_SYNTHETIC_ONLY_REQUIRED');
const r=spawnSync(process.execPath,[join(dirname(require.resolve('vitest/package.json')),'vitest.mjs'),'run','--config','tests/b2b-phase8-reception-http-db.config.mts'],{cwd:resolve(__dirname,'..'),stdio:'inherit',windowsHide:true,timeout:240000,env:{...process.env,FACTUEZ_B2B_RECEIVED_OWNED_DB:'NEW_NETWORK_NONE_TMPFS_ONLY'}});
if(r.error){console.error('ISOLATED_RECEPTION_HTTP_TEST_FAILED');process.exitCode=1;}else process.exitCode=r.status??1;
