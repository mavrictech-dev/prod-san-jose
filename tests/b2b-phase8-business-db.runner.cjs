'use strict';
// Explicit invocation only: node tests/b2b-phase8-business-db.runner.cjs --isolated-synthetic-only
// Never reads .env, accepts a database URL, builds shared packages, runs migrations or contacts existing services.
const assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const {randomUUID,randomBytes}=require('node:crypto'),{resolve}=require('node:path');
if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['--isolated-synthetic-only'])){
 console.error('ISOLATED_SYNTHETIC_ONLY_REQUIRED');process.exitCode=1;
}else{
 const root=resolve(__dirname,'..'),run=randomUUID(),name='factuez-p8-business-'+run.slice(0,8),password=randomBytes(24).toString('hex');let container=null;
 const docker=(args)=>{const r=spawnSync('docker',args,{encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(r.status,0,'ISOLATED_DOCKER_FAILED');return r.stdout.trim();};
 try{
  docker(['image','inspect','postgres:17-alpine']);
  container=docker(['run','--pull','never','--rm','-d','--name',name,'--label','factuez.phase8.business.test='+run,'--network','none',
   '--memory','256m','--cpus','1','--tmpfs','/var/lib/postgresql/data:rw','-e','POSTGRES_DB=phase8_business_synthetic','-e','POSTGRES_PASSWORD='+password,'postgres:17-alpine']);
  assert.match(container,/^[a-f0-9]{64}$/);
  const inspect=JSON.parse(docker(['inspect','--format','{{json .}}',container]));
  assert.equal(inspect.Config.Labels['factuez.phase8.business.test'],run);assert.equal(inspect.HostConfig.NetworkMode,'none');assert.deepEqual(inspect.HostConfig.PortBindings??{},{});
  assert.ok(inspect.Mounts.every(m=>m.Type==='tmpfs'));
  let ready=false;for(let i=0;i<45;i++){
   const r=spawnSync('docker',['exec',container,'pg_isready','-U','postgres','-d','phase8_business_synthetic'],{encoding:'utf8',windowsHide:true,timeout:3000});if(r.status===0){ready=true;break;}
   spawnSync(process.execPath,['-e','setTimeout(()=>{},200)'],{windowsHide:true,timeout:1500});
  }assert.ok(ready,'ISOLATED_DB_NOT_READY');
  const result=spawnSync(process.execPath,[resolve(root,'node_modules/vitest/vitest.mjs'),'run','--config','tests/b2b-phase8-business-db.config.mts'],
   {cwd:root,windowsHide:true,stdio:'inherit',timeout:240000,env:{...process.env,FACTUEZ_P8_ISOLATED_ONLY:'yes',FACTUEZ_P8_TEST_RUN:run,FACTUEZ_P8_TEST_CONTAINER:container,FACTUEZ_P8_TEST_PASSWORD:password}});
  assert.equal(result.status,0,'ISOLATED_BUSINESS_TESTS_FAILED');
  console.log(JSON.stringify({result:'PASS',target:'NEW_ISOLATED_POSTGRESQL',schema:'CANDIDATE_ONLY',network:'none',existingDatabasesTouched:false}));
 }catch(e){console.error(e.message);process.exitCode=1;}
 finally{if(container){const labels=JSON.parse(docker(['inspect','--format','{{json .Config.Labels}}',container]));assert.equal(labels['factuez.phase8.business.test'],run);docker(['stop','--time','1',container]);}}
}
