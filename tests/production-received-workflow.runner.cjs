'use strict';
const assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),{dirname,join,resolve}=require('node:path');
assert.deepEqual(process.argv.slice(2),['--isolated-synthetic-only']);
const runtime=join(dirname(require.resolve('vitest/package.json')),'vitest.mjs');
const result=spawnSync(process.execPath,[runtime,'run','--config','tests/production-received-workflow.config.mts'],{cwd:resolve(__dirname,'..'),windowsHide:true,stdio:'inherit',timeout:300000,env:{...process.env,FACTUEZ_B2B_RECEIVED_OWNED_DB:'NEW_NETWORK_NONE_TMPFS_ONLY'}});
process.exitCode=result.status??1;
