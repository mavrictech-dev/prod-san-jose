import test from 'node:test';
import assert from 'node:assert/strict';
import {assessHost,secretMetadata,portAvailable,availableMemory} from '../infra/deployment/core-production/preflight.mjs';
const valid=()=>({platform:'linux',arch:'x64',cpuCount:10,resourceLimitsSupported:true,nativeUidMapping:true,localDocker:true,dockerOs:'linux',dockerArch:'x86_64',dockerRoot:'/srv/docker',containerdRoot:'/srv/containerd',containerdRootVerified:true,
 availableMemory:17_000_000_000,dataRoot:'/srv/factuez',dataRootReal:'/srv/factuez',dataFree:50_000_000_000,dockerFree:50_000_000_000,port9000Free:true,
 bindings:Array.from({length:12},()=>({ok:true})),secrets:Array.from({length:15},()=>({ok:true})),pki:Array.from({length:3},()=>({ok:true})),xsdValid:true,postgresVersion:'17',images:Array.from({length:10},()=>({ok:true}))});
test('complete preparation remains a host preflight, never fiscal approval',()=>{
 const r=assessHost(valid());assert.equal(r.result,'PASS');assert.equal(r.containersStarted,false);assert.equal(r.filesChanged,false);assert.equal(r.secretContentsRead,false);assert.equal(r.externalRequests,0);assert.ok(r.prerequisitesNotProbed.some(x=>x.includes('pilot')));
});
for(const [name,mutation] of Object.entries({
 lowCpu:s=>s.cpuCount=8,noCgroups:s=>s.resourceLimitsSupported=false,remappedUsers:s=>s.nativeUidMapping=false,windows:s=>s.platform='win32',arm:s=>s.arch='arm64',remote:s=>s.localDocker=false,windowsDocker:s=>s.dockerOs='windows',
 varDocker:s=>s.dockerRoot='/var/lib/docker',varContainerd:s=>s.containerdRoot='/var/lib/containerd',unverifiedContainerd:s=>s.containerdRootVerified=false,
 lowMemory:s=>s.availableMemory=8_000_000_000,symlinkData:s=>s.dataRootReal='/var/lib/factuez',diskFull:s=>s.dataFree=9_000_000_000,dockerDiskFull:s=>s.dockerFree=9_000_000_000,
 busyPort:s=>s.port9000Free=false,missingMount:s=>s.bindings[0].ok=false,missingSecret:s=>s.secrets.pop(),unsafeSecret:s=>s.secrets[0].ok=false,
 pkiMismatch:s=>s.pki[0].ok=false,missingXsd:s=>s.xsdValid=false,wrongPostgres:s=>s.postgresVersion='16',missingImage:s=>s.images[0].ok=false,
})){test('blocks '+name,()=>{const s=valid();mutation(s);assert.equal(assessHost(s).result,'BLOCKED');});}
test('secret metadata has no capability to read secret contents',()=>{
 let stats=0;const info={isFile:()=>true,nlink:1,size:65,uid:1000,mode:0o100600};
 const io={lstat:p=>{stats++;assert.equal(p,'/srv/synthetic/secrets/production_notes_owner_key');return info;},noLinks:()=>true};
 assert.deepEqual(secretMetadata('production_notes_owner_key','/srv/synthetic/secrets/production_notes_owner_key',io),{name:'production_notes_owner_key',ok:true});assert.equal(stats,1);
 for(const update of [{mode:0o100644},{uid:0},{nlink:2},{size:0},{size:129}])assert.equal(secretMetadata('production_notes_owner_key','x',{lstat:()=>({...info,...update}),noLinks:()=>true}).ok,false);
 assert.equal(secretMetadata('smtp_settings_key','x',{lstat:()=>info,noLinks:()=>false}).ok,false);
});
test('ss parser distinguishes exact port, wildcard and both IPv6 forms',()=>{
 for(const ip of ['127.0.0.1','0.0.0.0','*','[::]','::'])assert.equal(portAvailable(`LISTEN 0 128 ${ip}:9000 0.0.0.0:*\n`),false);
 assert.equal(portAvailable('LISTEN 0 128 127.0.0.1:90001 0.0.0.0:*\nLISTEN 0 128 127.0.0.1:9001 0.0.0.0:*'),true);
});
test('MemAvailable includes reclaimable memory and rejects absent data',()=>{
 assert.equal(availableMemory('MemFree: 1024 kB\nMemAvailable: 17000000 kB\nCached: 12000 kB\n'),17_408_000_000);assert.throws(()=>availableMemory('MemFree: 1024 kB'));
});
