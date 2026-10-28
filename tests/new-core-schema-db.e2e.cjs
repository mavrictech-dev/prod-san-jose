/* Validates a reviewed NEW offline bundle in a NEW disposable PostgreSQL; no existing DB access. */
'use strict';
const assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),{readFileSync,realpathSync}=require('node:fs'),{resolve,join,relative}=require('node:path'),{randomUUID,createHash}=require('node:crypto');
assert.equal(process.argv[2],'--isolated-synthetic-only');assert.equal(process.argv.length,4);
const root=resolve(__dirname,'..'),bundle=realpathSync(process.argv[3]);assert.ok(relative(join(root,'output','install'),bundle)&&!relative(join(root,'output','install'),bundle).startsWith('..'));
const manifest=JSON.parse(readFileSync(join(bundle,'manifest.json'),'utf8'));assert.equal(manifest.schemaVersion,'factuez.new-core-schema.v1');assert.notEqual(manifest.status,'SUPERSEDED_DO_NOT_INSTALL');
const services=['identity-service','billing-service','sunat-service','mailer-worker','received-documents-service'];assert.deepEqual(manifest.files.map(f=>f.service),services);
const files=manifest.files.map(f=>{assert.equal(f.name,f.service+'.sql');const b=readFileSync(join(bundle,f.name));assert.equal(b.length,f.bytes);assert.equal(createHash('sha256').update(b).digest('hex'),f.sha256);return b.toString();});
const run=randomUUID(),name='factuez-core-schema-'+run;let created=false;
function docker(args,input,allow=false){const r=spawnSync('docker',['--context','desktop-linux',...args],{input,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:2*1024*1024});if(r.error||(!allow&&r.status!==0))throw Error('NEW_SCHEMA_TEST_OPERATION_FAILED');return r;}
function sql(db,body,allow=false){return docker(['exec','-i',name,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',db],body,allow);}
(async()=>{try{
 const host=docker(['context','inspect','desktop-linux','--format','{{.Endpoints.docker.Host}}']).stdout.trim();assert.match(host,/^npipe:.*dockerDesktopLinuxEngine$/);
 const image=docker(['image','inspect','postgres:17-alpine','--format','{{.Id}}']).stdout.trim();assert.match(image,/^sha256:[a-f0-9]{64}$/);
 docker(['run','--pull','never','-d','--name',name,'--label','factuez.schema-test='+run,'--network','none','--memory','512m','--cpus','1','--tmpfs','/var/lib/postgresql/data:rw,nosuid,nodev,size=320m','-e','POSTGRES_HOST_AUTH_METHOD=trust',image,'postgres','-c','listen_addresses=']);created=true;
 const check=JSON.parse(docker(['inspect',name,'--format','{{json .}}']).stdout);assert.equal(check.Config.Labels['factuez.schema-test'],run);assert.equal(check.HostConfig.NetworkMode,'none');assert.equal(Object.keys(check.HostConfig.PortBindings??{}).length,0);assert.ok(check.Mounts.every(m=>m.Type==='tmpfs'));
 let ready=false;for(let i=0;i<80;i++){if(docker(['exec',name,'pg_isready','-U','postgres'],undefined,true).status===0){ready=true;break;}await new Promise(r=>setTimeout(r,150));}assert.ok(ready);
 sql('postgres','CREATE ROLE isolated_other_owner;');
 const checks=[];
 for(let i=0;i<services.length;i++){
  const db='new_core_'+i;sql('postgres','CREATE DATABASE '+db+';');
  assert.notEqual(sql(db,files[i],true).status,0,'Unconfirmed database must refuse DDL');
  assert.notEqual(sql(db,"SET ROLE isolated_other_owner; SET factuez.schema_target='"+db+"';\n"+files[i],true).status,0,'Wrong owner must refuse DDL');
  sql(db,"SET factuez.schema_target='"+db+"';\n"+files[i]);
  const names=sql(db,"SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;").stdout.trim().split('\n');assert.ok(names.length>3);
  const data=sql(db,'SELECT '+names.map(n=>'(SELECT count(*) FROM "'+n+'")').join('+')+';').stdout.trim();assert.equal(data,'0','No seed, user, RUC, grant or document may be installed');
  assert.notEqual(sql(db,"SET factuez.schema_target='"+db+"';\n"+files[i],true).status,0,'Existing database must refuse reinstall');
  checks.push({service:services[i],tables:names.length,rows:0,unconfirmedTargetRejected:true,wrongOwnerRejected:true,reinstallRejected:true});
 }
 console.log(JSON.stringify({result:'PASS',scope:'NEW isolated schema installation',checks,externalRequests:0,existingDataTouched:false,publishedPorts:0}));
 }catch(e){console.error('NEW_CORE_SCHEMA_REHEARSAL_FAILED '+e.message);process.exitCode=1;}
 finally{if(created){assert.equal(docker(['inspect',name,'--format','{{index .Config.Labels "factuez.schema-test"}}']).stdout.trim(),run);docker(['rm','-f',name]);}}
})();
