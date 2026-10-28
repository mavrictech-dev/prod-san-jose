'use strict';
// Explicit synthetic-only Redis RDB test. No external server, ports or persistent volumes.
const {spawnSync}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const assert=require('node:assert/strict');
if(process.argv.length!==3||process.argv[2]!=='--isolated-synthetic-only')throw Error('EXPLICIT_SYNTHETIC_TEST_REQUIRED');
const run=randomUUID(), label='factuez.redis.restore.test', containers=[];
function docker(args,input){const r=spawnSync('docker',['--context','desktop-linux',...args],{input,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:8*1024*1024});if(r.status!==0)throw Error('REDIS_SYNTHETIC_DOCKER_FAILED');return r.stdout.trim();}
function start(name,command){const id=docker(['run','--pull','never','--rm','-d','--name',name,'--label',`${label}=${run}`,'--network','none','--memory','128m','--tmpfs','/data:rw,noexec,nosuid,size=32m','redis:7.4-alpine','sh','-c',command]);containers.push(id);const c=JSON.parse(docker(['inspect','--format','{{json .HostConfig}}',id]));assert.equal(c.NetworkMode,'none');assert.equal(Object.keys(c.PortBindings||{}).length,0);assert.ok(c.Tmpfs['/data']);return id;}
function exec(id,...args){return docker(['exec',id,...args]);}
async function ready(id){for(let i=0;i<80;i++){try{if(exec(id,'redis-cli','PING')==='PONG')return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('REDIS_SYNTHETIC_NOT_READY');}
(async()=>{try{
 assert.equal(process.platform,'win32','LOCAL_DOCKER_DESKTOP_REQUIRED');
 assert.equal(docker(['context','inspect','desktop-linux','--format','{{(index .Endpoints "docker").Host}}']),'npipe:////./pipe/dockerDesktopLinuxEngine');
 docker(['image','inspect','redis:7.4-alpine']);
 const source=start(`factuez-rdb-source-${run.slice(0,8)}`,'exec redis-server --dir /data --save "" --appendonly no');await ready(source);
 assert.equal(exec(source,'redis-cli','SET','synthetic:fixture','demo-only'),'OK');
 assert.equal(exec(source,'redis-cli','SADD','synthetic:queue','item-1','item-2'),'2');
 assert.equal(exec(source,'redis-cli','SAVE'),'OK');
 const data=exec(source,'base64','/data/dump.rdb');assert.ok(data.length>20);
 const target=start(`factuez-rdb-target-${run.slice(0,8)}`,'while [ ! -f /data/import-ready ]; do sleep 0.2; done; exec redis-server --dir /data --save "" --appendonly no');
 docker(['exec','-i',target,'sh','-c','base64 -d > /data/dump.rdb && touch /data/import-ready'],data+'\n');await ready(target);
 assert.equal(exec(target,'redis-cli','GET','synthetic:fixture'),'demo-only');
 assert.deepEqual(exec(target,'redis-cli','SMEMBERS','synthetic:queue').split('\n').sort(),['item-1','item-2']);
 console.log('PASS: Redis RDB synthetic save and restore in two isolated ephemeral containers');
 }finally{for(const id of containers.reverse()) {const labels=JSON.parse(docker(['inspect','--format','{{json .Config.Labels}}',id]));assert.equal(labels[label],run);docker(['stop','--time','1',id]);}}})().catch(e=>{process.stderr.write(`${e.message}\n`);process.exitCode=1;});
