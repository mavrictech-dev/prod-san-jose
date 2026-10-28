import { describe,it,expect } from 'vitest';
import { model } from '../infra/b2b/ubuntu-vps/generate-review.mjs';
import { requiredPaths,validateMetadata,containerdStorageFromDump,parseContainerdArgs,confirmContainerdLiveRoot } from '../infra/b2b/ubuntu-vps/preflight.mjs';
const NOW=Date.parse('2026-10-26T15:00:00Z');
function evidence(){
  const m:any={version:1,capturedAt:new Date(NOW).toISOString(),platform:'linux',arch:'x64',os:{id:'ubuntu',versionId:'24.04'},daemon:{DockerRootDir:'/srv/docker',endpoint:'unix:///var/run/docker.sock',rootless:false},limits:{memory:true,swap:true,cpu:true,pids:true},containerd:[{pid:42,root:'/srv/containerd',effective:true,liveRootConfirmed:true,externalStores:false}],varDeviceId:'1',paths:[]};
  m.paths=requiredPaths(model,m).map((p:any)=>({path:p.path,exists:true,realpath:p.path,kind:p.kind,deviceId:'2',freeBytes:80_000_000_000,mount:{source:'/dev/review-only',target:'/srv',fstype:'ext4'}}));return m;
}
const review=(m:any)=>validateMetadata(model,m,{now:NOW});
const reject=(change:(m:any)=>void,code?:string)=>{const m=evidence();change(m);const r=review(m);expect(r.status).toBe('BLOCKED');expect(r.activationAllowed).toBe(false);if(code)expect(r.errors.map((e:any)=>e.code)).toContain(code);};
describe('B2B VPS metadata preflight without a daemon connection',()=>{
  it('valid synthetic storage metadata passes only metadata checks, never activation',()=>{
    const r=review(evidence());expect(r.errors).toEqual([]);expect(r.status).toBe('METADATA_CHECKS_PASSED_REVIEW_ONLY');expect(r.activationAllowed).toBe(false);
  });
  it.each(['/var/lib/docker','/var/docker','/srv/../var/docker',undefined,''])('blocks daemon store %s',p=>reject(m=>m.daemon.DockerRootDir=p,'DOCKER_STORAGE_UNKNOWN_OR_VAR'));
  it('blocks Docker 29 independent containerd under /var even with relocated Docker root',()=>reject(m=>m.containerd[0].root='/var/lib/containerd','CONTAINERD_STORAGE_UNKNOWN_OR_VAR'));
  it('requires all running containerd roots and refuses unknown or proxy stores',()=>{
    reject(m=>m.containerd=[],'CONTAINERD_UNKNOWN');reject(m=>delete m.containerd);
    reject(m=>m.containerd[0].effective=false,'CONTAINERD_STORAGE_UNKNOWN_OR_VAR');reject(m=>m.containerd[0].externalStores=true,'CONTAINERD_STORAGE_UNKNOWN_OR_VAR');
    reject(m=>delete m.containerd[0].liveRootConfirmed,'CONTAINERD_STORAGE_UNKNOWN_OR_VAR');
    reject(m=>m.containerd.push({pid:43,root:'/var/lib/containerd',effective:true,externalStores:false}),'CONTAINERD_STORAGE_UNKNOWN_OR_VAR');
  });
  it.each(['memory','swap','cpu','pids'])('requires actual daemon support for %s limits',key=>{
    reject(m=>m.limits[key]=false,'DAEMON_RESOURCE_LIMITS_UNKNOWN_OR_UNSUPPORTED');reject(m=>delete m.limits[key],'DAEMON_RESOURCE_LIMITS_UNKNOWN_OR_UNSUPPORTED');
  });
  it('rejects duplicate containerd identity or identical persistent roots',()=>{
    reject(m=>m.containerd.push({...m.containerd[0]}),'CONTAINERD_ROOT_OR_PID_CONTRADICTION');
    reject(m=>m.containerd[0].root=m.daemon.DockerRootDir,'CONTAINERD_ROOT_OR_PID_CONTRADICTION');
  });
  it.each(['tcp://host.invalid:2376','ssh://host.invalid',undefined])('rejects remote/unknown daemon %s',endpoint=>reject(m=>m.daemon.endpoint=endpoint,'DOCKER_STORAGE_UNKNOWN_OR_VAR'));
  it('blocks unsupported OS, unknown rootless status and stale or future observations',()=>{
    reject(m=>m.os.versionId='22.04','HOST_UNKNOWN_OR_UNSUPPORTED');reject(m=>delete m.daemon.rootless,'DOCKER_STORAGE_UNKNOWN_OR_VAR');
    reject(m=>m.capturedAt=new Date(NOW-300001).toISOString(),'METADATA_STALE_OR_UNKNOWN');reject(m=>m.capturedAt=new Date(NOW+30001).toISOString(),'METADATA_STALE_OR_UNKNOWN');reject(m=>delete m.capturedAt,'METADATA_STALE_OR_UNKNOWN');
  });
  it('blocks symlinks resolving into /var, including a secret metadata path',()=>{
    reject(m=>m.paths[0].realpath='/var/lib/docker','REALPATH_UNKNOWN_OR_VAR');
    reject(m=>m.paths.find((p:any)=>p.path.includes('/secrets/')).realpath='/var/private/password','REALPATH_UNKNOWN_OR_VAR');
  });
  it('blocks /srv sharing the actual /var filesystem even if path looks safe',()=>reject(m=>m.paths[0].deviceId=m.varDeviceId,'VAR_FILESYSTEM_SHARED_OR_UNKNOWN'));
  it.each(['realpath','deviceId','freeBytes','mount','kind','exists'])('blocks unknown path metadata %s',key=>reject(m=>delete m.paths[0][key]));
  it('rejects missing, duplicate, nonexistent and wrong-kind binds',()=>{
    reject(m=>m.paths.pop(),'PATH_UNKNOWN');reject(m=>m.paths.push({...m.paths[0]}));
    reject(m=>m.paths[0].exists=false,'REALPATH_UNKNOWN_OR_VAR');reject(m=>m.paths[0].kind='file','REALPATH_UNKNOWN_OR_VAR');
  });
  it('blocks unknown filesystem types and routes that do not contain resolved path',()=>{
    reject(m=>m.paths[0].mount.fstype='overlay','DISK_ROUTE_UNKNOWN');reject(m=>m.paths[0].mount.target='/other','DISK_ROUTE_UNKNOWN');
    reject(m=>m.paths[0].mount.source='','DISK_ROUTE_UNKNOWN');reject(m=>m.paths[0].mount.source='/dev/contradiction','DISK_ROUTE_CONTRADICTION');
  });
  it('aggregates image/data/backup budgets once per real filesystem',()=>{
    // 12GB Docker + 12GB containerd + 16GB data + 16GB backups + 1GB config.
    const m=evidence();m.paths.forEach((p:any)=>p.freeBytes=57_000_000_000);expect(review(m).errors).toEqual([]);
    m.paths.forEach((p:any)=>p.freeBytes=56_999_999_999);expect(review(m).errors.map((e:any)=>e.code)).toContain('DISK_CAPACITY_INSUFFICIENT');
  });
  it('reserves each independent containerd instance and detects same physical data bind',()=>{
    const m=evidence();m.containerd.push({pid:43,root:'/srv/containerd-two',effective:true,liveRootConfirmed:true,externalStores:false});m.paths.push({...m.paths[0],path:'/srv/containerd-two',realpath:'/srv/containerd-two'});m.paths.forEach((p:any)=>p.freeBytes=60_000_000_000);expect(review(m).status).toBe('BLOCKED');
    reject(m=>m.paths.find((p:any)=>p.path.endsWith('/data/redis')).realpath=m.paths.find((p:any)=>p.path.endsWith('/data/postgres')).realpath,'PHYSICAL_BIND_COLLISION');
  });
  it.each([null,{},[],{containerd:'unknown'}])('malformed evidence remains blocked %s',m=>expect(review(m).status).toBe('BLOCKED'));
  it('derives effective root using explicit CLI override and daemon config dump',()=>{
    expect(containerdStorageFromDump(['containerd','--config','/etc/containerd/config.toml'],'version = 3\nroot = "/srv/containerd"\nstate = "/run/containerd"\n')).toEqual({root:'/srv/containerd',externalStores:false});
    expect(containerdStorageFromDump(['containerd','--root=/srv/containerd'],'root = "/var/lib/containerd"\n').root).toBe('/srv/containerd');
    expect(parseContainerdArgs(['containerd','-r','/srv/containerd','-c','/etc/containerd/config.toml'])).toEqual({root:'/srv/containerd',config:'/etc/containerd/config.toml'});
    expect(parseContainerdArgs(['containerd','-r=/srv/containerd','-c=/etc/containerd/config.toml'])).toEqual({root:'/srv/containerd',config:'/etc/containerd/config.toml'});
  });
  it('requires a live persistent metadata descriptor matching the physical store',()=>{
    const storage={root:'/srv/containerd',externalStores:false},suffix='/io.containerd.metadata.v1.bolt/meta.db';
    expect(confirmContainerdLiveRoot(storage,['socket:[1]',storage.root+suffix])).toMatchObject({effective:true,liveRootConfirmed:true});
    expect(confirmContainerdLiveRoot(storage,['/disk/containerd'+suffix],'/disk/containerd')).toMatchObject({effective:true});
    for(const targets of [[],['/var/lib/containerd'+suffix],[storage.root+suffix,'/srv/other'+suffix],[storage.root+suffix+' (deleted)']])expect(()=>confirmContainerdLiveRoot(storage,targets)).toThrow();
  });
  it.each([
    [['containerd'],'root = "/var/lib/containerd"\n'],
    [['containerd'],'version = 3\n'],
    [['containerd'],'root = "/srv/containerd"\nroot = "/srv/other"\n'],
    [['containerd'],'root = "/srv/containerd"\n[proxy_plugins.external]\n'],
    [['containerd'],'root = "/srv/containerd"\n  root_path = "/var/snapshots"\n'],
    [['containerd','--root','/srv/a','--root','/srv/b'],'root = "/srv/containerd"\n'],
    [['containerd','--config','relative.toml'],'root = "/srv/containerd"\n'],
    [['containerd','-r=/var/lib/containerd'],'root = "/srv/containerd"\n'],
    [['containerd','-r/var/lib/containerd'],'root = "/srv/containerd"\n'],
  ])('unknown or contradictory containerd config is blocked', (args:any,dump:any)=>expect(()=>containerdStorageFromDump(args,dump)).toThrow());
});
