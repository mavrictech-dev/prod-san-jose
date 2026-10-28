'use strict';
const assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),{resolve,dirname,join}=require('node:path');
assert.deepEqual(process.argv.slice(2),['--isolated-synthetic-only']);
const allowed=new Set(['path','systemroot','windir','comspec','pathext','temp','tmp','userprofile','appdata','localappdata','programdata','programfiles','programfiles(x86)','homedrive','homepath']);
const env={};for(const [k,v] of Object.entries(process.env))if(allowed.has(k.toLowerCase()))env[k]=v;
Object.assign(env,{NODE_ENV:'test',CI:'true'});
const r=spawnSync(process.execPath,[join(dirname(require.resolve('vitest/package.json')),'vitest.mjs'),'run','--config','tests/b2b-worker-shutdown-db.config.mts','--reporter=json','--outputFile=output/qa/b2b-phase9-worker-shutdown-db.json'],{cwd:resolve(__dirname,'..'),env,windowsHide:true,stdio:'inherit',timeout:240000});
process.exitCode=r.error?1:r.status??1;
