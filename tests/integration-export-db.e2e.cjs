'use strict';
const assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),{resolve}=require('node:path'),{randomUUID,randomBytes}=require('node:crypto');
if(process.argv.length!==3||process.argv[2]!=='--isolated-synthetic-only')throw new Error('Explicit isolated fictitious scope required');
const repo=resolve(__dirname,'..'),id=randomUUID(),name='factuez-i5-'+id.slice(0,8),db=name+'-db',runner=name+'-runner',label='factuez.integration.test='+id;
const targets=new Set([name,db,runner]);let network=false,created=false,stage='image-preflight';
function docker(args){const r=spawnSync('docker',args,{encoding:'utf8',timeout:30000,windowsHide:true});if(r.status!==0)throw new Error('Isolated Docker operation failed');return r.stdout.trim();}
function mount(source,target){return ['--mount','type=bind,source='+resolve(repo,source)+',target='+target+',readonly'];}
function owned(kind,target){assert.ok(targets.has(target));const key=kind==='network'?'.Labels':'.Config.Labels';
 const labels=JSON.parse(docker([kind,'inspect','--format','{{json '+key+'}}',target]));assert.equal(labels['factuez.integration.test'],id);}
try{
 docker(['image','inspect','postgres:17-alpine']);docker(['image','inspect','factuez-stage2-qa/billing-service:local']);
 stage='new-internal-network';docker(['network','create','--internal','--label',label,name]);network=true;
 const password=randomBytes(32).toString('base64url');stage='new-empty-database';
 docker(['create','--name',db,'--label',label,'--network',name,'--memory','256m','--cpus','1',
  '--mount','type=tmpfs,destination=/var/lib/postgresql/data,tmpfs-size=134217728','--env','POSTGRES_USER=integration_fixture',
  '--env','POSTGRES_DB=integration_fixture','--env','POSTGRES_PASSWORD='+password,'postgres:17-alpine']);created=true;docker(['start',db]);
 assert.equal(docker(['inspect','--format','{{json .HostConfig.PortBindings}}',db]),'{}');stage='new-fictitious-runner';
 const r=spawnSync('docker',['run','--name',runner,'--label',label,'--network',name,'--read-only','--cap-drop=ALL','--security-opt','no-new-privileges',
  '--memory','512m','--cpus','2','--entrypoint','node','--env','FIXTURE_DATABASE_HOST='+db,'--env','FIXTURE_DATABASE_PASSWORD='+password,
  ...mount('services/integration-export-service/dist','/workspace/services/billing-service/dist/integration-export'),
  ...mount('services/billing-service/dist/integration','/workspace/services/billing-service/dist/integration'),
  ...mount('packages/contracts/dist','/workspace/packages/contracts/dist'),...mount('packages/contracts/package.json','/workspace/packages/contracts/package.json'),
  ...mount('packages/service-access/dist','/workspace/packages/service-access/dist'),
  ...mount('services/integration-export-service/sql/integration-export.sql','/fixture/export.sql'),...mount('tests/integration-export-db.runner.cjs','/fixture/run.cjs'),
  'factuez-stage2-qa/billing-service:local','/fixture/run.cjs'],{encoding:'utf8',timeout:60000,windowsHide:true});
 for(const line of r.stdout.trim().split('\n').filter(Boolean)){const summary=JSON.parse(line);assert.ok(['PASS','FAIL'].includes(summary.result));console.log(JSON.stringify(summary));}
 if(r.status!==0||!r.stdout.includes('"result":"PASS"'))throw new Error('Isolated fixture failed');
}catch{console.error(JSON.stringify({result:'FAIL',stage,realData:false}));process.exitCode=1;}
finally{
 for(const target of [runner,...(created?[db]:[])]){const r=spawnSync('docker',['container','inspect','--format','{{.Id}}',target],{encoding:'utf8',windowsHide:true});
  if(r.status===0){owned('container',target);docker(['container','rm','--force',target]);}}
 if(network){owned('network',name);docker(['network','rm',name]);}
 console.log('Disposed only labelled phase5 fictitious resources; existing QA, history and originals untouched.');
}
