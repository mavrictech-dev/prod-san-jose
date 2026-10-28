'use strict';
const assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),{resolve,dirname,join}=require('node:path');
assert.deepEqual(process.argv.slice(2),['--isolated-synthetic-only']);
const allowed=new Set(['path','systemroot','windir','comspec','pathext','temp','tmp','userprofile','appdata','localappdata','programdata','programfiles','programfiles(x86)','homedrive','homepath']);
const env={};for(const [key,value]of Object.entries(process.env))if(allowed.has(key.toLowerCase()))env[key]=value;
Object.assign(env,{FACTUEZ_B2B_RECEIVED_OWNED_DB:'NEW_NETWORK_NONE_TMPFS_ONLY',NODE_ENV:'test',CI:'true'});
const result=spawnSync(process.execPath,[join(dirname(require.resolve('vitest/package.json')),'vitest.mjs'),'run','--config','tests/b2b-received-read-only.config.mts','--reporter=json','--outputFile=output/qa/b2b-received-read-only-db.json'],{cwd:resolve(__dirname,'..'),windowsHide:true,stdio:'inherit',env,timeout:600000});
process.exitCode=result.error?1:result.status??1;
