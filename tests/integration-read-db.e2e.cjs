'use strict';
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {resolve}=require('node:path');
const {randomUUID,randomBytes}=require('node:crypto');
if(process.argv.length!==3 || process.argv[2]!=='--isolated-synthetic-only') throw new Error('Explicit isolated synthetic scope required');
const repo=resolve(__dirname,'..'),id=randomUUID(),name='factuez-i4-'+id.slice(0,8),label='factuez.integration.test='+id;
const targets=new Set(),created=[];let network=false,stage='image-preflight';
function docker(args) {const r=spawnSync('docker',args,{encoding:'utf8',timeout:30000,windowsHide:true});if(r.status!==0) throw new Error('Isolated Docker operation failed');return r.stdout.trim();}
function mount(path,target){return ['--mount','type=bind,source='+resolve(repo,path)+',target='+target+',readonly'];}
function owned(kind,target) {assert.ok(targets.has(target));const key=kind==='network'?'.Labels':'.Config.Labels';
 const labels=JSON.parse(docker([kind,'inspect','--format','{{json '+key+'}}',target]));assert.equal(labels['factuez.integration.test'],id);}
try{
 docker(['image','inspect','postgres:17-alpine']);for(const owner of ['billing-service','sunat-service']) docker(['image','inspect','factuez-stage2-qa/'+owner+':local']);
 stage='new-internal-network';targets.add(name);docker(['network','create','--internal','--label',label,name]);network=true;
 for(const owner of ['billing-service','sunat-service']) {
  const db=name+'-'+owner.split('-')[0],runner=db+'-runner',password=randomBytes(32).toString('base64url');targets.add(db);targets.add(runner);
  stage='new-empty-'+owner+'-database';
  docker(['create','--name',db,'--label',label,'--network',name,'--memory','256m','--cpus','1',
   '--mount','type=tmpfs,destination=/var/lib/postgresql/data,tmpfs-size=134217728','--env','POSTGRES_USER=integration_fixture',
   '--env','POSTGRES_DB=integration_fixture','--env','POSTGRES_PASSWORD='+password,'postgres:17-alpine']);created.push(db);docker(['start',db]);
  assert.equal(docker(['inspect','--format','{{json .HostConfig.PortBindings}}',db]),'{}');
  stage='isolated-'+owner+'-runner';created.push(runner);
  const r=spawnSync('docker',['run','--name',runner,'--label',label,'--network',name,'--read-only','--cap-drop=ALL',
   '--security-opt','no-new-privileges','--memory','256m','--cpus','1','--entrypoint','node','--env','FIXTURE_OWNER='+owner,
   '--env','FIXTURE_DATABASE_HOST='+db,'--env','FIXTURE_DATABASE_PASSWORD='+password,
   ...mount('services/'+owner+'/dist/integration','/workspace/services/'+owner+'/dist/integration'),
   ...mount('packages/contracts/dist','/workspace/packages/contracts/dist'),...mount('packages/contracts/package.json','/workspace/packages/contracts/package.json'),
   ...mount('packages/service-access/dist','/workspace/packages/service-access/dist'),
   ...mount('tests/integration-read-db.runner.cjs','/fixture/run.cjs'),...mount('services/sunat-service/prisma/integration-read.sql','/fixture/audit.sql'),
   'factuez-stage2-qa/'+owner+':local','/fixture/run.cjs'],{encoding:'utf8',timeout:30000,windowsHide:true});
  for(const line of r.stdout.trim().split('\n').filter(Boolean)) {const result=JSON.parse(line);assert.ok(['PASS','FAIL'].includes(result.result));console.log(JSON.stringify(result));}
  if(r.status!==0 || !r.stdout.includes('"result":"PASS"')) throw new Error('Isolated owner test failed');
 }
}catch{console.error(JSON.stringify({result:'FAIL',stage,realData:false}));process.exitCode=1;}
finally{
 for(const target of created.reverse()) {const r=spawnSync('docker',['container','inspect',target],{encoding:'utf8',windowsHide:true});
  if(r.status===0) {owned('container',target);docker(['container','rm','--force',target]);}}
 if(network) {owned('network',name);docker(['network','rm',name]);}
 console.log('Disposed only labelled fictitious phase4 resources; no existing history or QA runtime was changed.');
}
