'use strict';
const assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),{resolve,dirname,join}=require('node:path');
assert.deepEqual(process.argv.slice(2),['--isolated-synthetic-only'],'EXPLICIT_NEW_REDIS_RUNNER_REQUIRED');
const result=spawnSync(process.execPath,[join(dirname(require.resolve('vitest/package.json')),'vitest.mjs'),'run','--config','tests/b2b-admin-bff-redis.config.mts'],{cwd:resolve(__dirname,'..'),stdio:'inherit',windowsHide:true,timeout:240000,env:{...process.env,FACTUEZ_ADMIN_BFF_NEW_REDIS_ONLY:'NEW_NETWORK_NONE_TMPFS_ONLY'}});
process.exitCode=result.error?1:result.status??1;
