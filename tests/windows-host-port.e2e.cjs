'use strict';
// New disposable network/HTTP fixtures only. No installed stack, DB, credentials or official calls.
const assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),{randomUUID}=require('node:crypto');
assert.deepEqual(process.argv.slice(2),['--isolated-synthetic-only']);
const token=randomUUID(),prefix='factuez-hostport-'+token.slice(0,8),createdContainers=[],createdNetworks=[];
function docker(args,allow=false){const r=spawnSync('docker',['--context','desktop-linux',...args],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1048576});if(!allow)assert.equal(r.status,0,'SYNTHETIC_DOCKER_OPERATION_FAILED');return r;}
function network(name,internal){const id=docker(['network','create','--label','factuez.hostport-test='+token,...(internal?['--internal']:[]),name]).stdout.trim();createdNetworks.push(id);return id;}
function inspect(id){return JSON.parse(docker(['inspect',id,'--format','{{json .}}']).stdout);}
async function http(port){for(let i=0;i<30;i++){try{const r=await fetch('http://127.0.0.1:'+port+'/login',{signal:AbortSignal.timeout(1000)});if(r.status===200&&await r.text()==='SYNTHETIC_HOST_PORT_OK')return true;}catch{}await new Promise(r=>setTimeout(r,100));}return false;}
(async()=>{try{
 const image=docker(['image','inspect','factuez-stage2-qa/identity-service:prepared-v2-20261028','--format','{{.Id}}']).stdout.trim();assert.match(image,/^sha256:[a-f0-9]{64}$/);
 const internal=network(prefix+'-internal',true),edge=network(prefix+'-host',false),script="require('node:http').createServer((q,s)=>s.end('SYNTHETIC_HOST_PORT_OK')).listen(8000,'0.0.0.0')";
 const make=net=>{const id=docker(['run','--detach','--pull','never','--label','factuez.hostport-test='+token,'--network',net,'--publish','127.0.0.1::8000','--memory','128m','--cpus','0.25','--read-only','--cap-drop','ALL','--entrypoint','node',image,'-e',script]).stdout.trim();createdContainers.push(id);return id;};
 const before=make(internal),unpublished=inspect(before).NetworkSettings.Ports?.['8000/tcp'];assert.ok(!unpublished||unpublished.length===0,'EXPECTED_INTERNAL_ONLY_MAPPING_ABSENT');
 const after=make(edge);docker(['network','connect',internal,after]);const binding=inspect(after).NetworkSettings.Ports?.['8000/tcp'];assert.equal(binding.length,1);assert.equal(binding[0].HostIp,'127.0.0.1');assert.ok(await http(binding[0].HostPort),'FIXED_HOST_HTTP_NOT_REACHABLE');
 console.log(JSON.stringify({result:'PASS',internalOnlyReproducesMissingPort:true,hostBridgePublishesLoopback:true,http200:true,installedStackTouched:false,databasesUsed:false}));
 }catch(e){console.error('HOST_PORT_REHEARSAL_FAILED '+e.message);process.exitCode=1;}finally{
 for(const id of createdContainers){assert.equal(inspect(id).Config.Labels['factuez.hostport-test'],token);docker(['rm','--force',id]);}
 for(const id of createdNetworks){const n=JSON.parse(docker(['network','inspect',id,'--format','{{json .}}']).stdout);assert.equal(n.Labels['factuez.hostport-test'],token);docker(['network','rm',id]);}
 }})();
