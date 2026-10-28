// Read-only host metadata. Importing this module does not inspect the host.
import { readFileSync, readlinkSync, realpathSync, statSync, statfsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { posix } from 'node:path';
import { isRecord, outsideVar, parseStrictJson, validateModel } from './model.mjs';
const run=(file,args)=>execFileSync(file,args,{encoding:'utf8',timeout:10000,maxBuffer:2*1024*1024,stdio:['ignore','pipe','pipe']});
export function requiredPaths(model,metadata){
  const result=new Map();
  const add=(path,kind,reserve)=>{
    const previous=result.get(path);
    if(previous&&previous.kind!==kind)throw new Error('PATH_KIND_CONTRADICTION');
    result.set(path,{path,kind,reserveBytes:Math.max(previous?.reserveBytes??0,reserve)});
  };
  add(metadata.daemon.DockerRootDir,'directory',12_000_000_000);
  for(const d of metadata.containerd)add(d.root,'directory',12_000_000_000);
  for(const s of Object.values(model.services))for(const v of s.volumes){
    const config=v.source.startsWith('/srv/factuez-vps/config/');
    add(v.source,config?'file':'directory',0);
  }
  for(const s of Object.values(model.secrets))add(s.file,'file',0);
  // Reserve per root once, then aggregate by the actual filesystem, never by
  // the spelling of a path. This is a review minimum, not a retention estimate.
  add('/srv/factuez-vps/data','directory',16_000_000_000);
  add('/srv/factuez-vps/backups','directory',16_000_000_000);
  add('/srv/factuez-vps/config','directory',1_000_000_000);
  return [...result.values()];
}
export function validateMetadata(model,metadata,{now=Date.now()}={}){
  const errors=[];const fail=(code,at)=>errors.push({code,at});
  try{
    if(!validateModel(model).valid)fail('MODEL_INVALID','compose');
    if(!isRecord(metadata)||metadata.version!==1||metadata.platform!=='linux'||metadata.arch!=='x64'||metadata.os?.id!=='ubuntu'||metadata.os?.versionId!=='24.04')fail('HOST_UNKNOWN_OR_UNSUPPORTED','host');
    const age=now-Date.parse(metadata.capturedAt);if(!Number.isFinite(age)||age< -30000||age>300000)fail('METADATA_STALE_OR_UNKNOWN','capturedAt');
    if(metadata.daemon?.endpoint!=='unix:///var/run/docker.sock'||metadata.daemon?.rootless!==false||!outsideVar(metadata.daemon?.DockerRootDir))fail('DOCKER_STORAGE_UNKNOWN_OR_VAR','DockerRootDir');
    if(!isRecord(metadata.limits)||['memory','swap','cpu','pids'].some(k=>metadata.limits[k]!==true))fail('DAEMON_RESOURCE_LIMITS_UNKNOWN_OR_UNSUPPORTED','limits');
    if(!Array.isArray(metadata.containerd)||!metadata.containerd.length||metadata.containerd.length>16)fail('CONTAINERD_UNKNOWN','containerd');
    const roots=new Set([metadata.daemon?.DockerRootDir]),pids=new Set();
    for(const d of metadata.containerd??[]){
      if(!Number.isSafeInteger(d.pid)||d.pid<=0||d.effective!==true||d.liveRootConfirmed!==true||d.externalStores!==false||!outsideVar(d.root))fail('CONTAINERD_STORAGE_UNKNOWN_OR_VAR','containerd');
      if(roots.has(d.root)||pids.has(d.pid))fail('CONTAINERD_ROOT_OR_PID_CONTRADICTION','containerd');roots.add(d.root);pids.add(d.pid);
    }
    if(typeof metadata.varDeviceId!=='string'||!/^\d+$/.test(metadata.varDeviceId))fail('VAR_FILESYSTEM_UNKNOWN','var');
    if(!Array.isArray(metadata.paths))throw new Error('PATH_EVIDENCE_UNKNOWN');
    const byPath=new Map();
    for(const p of metadata.paths){if(!isRecord(p)||byPath.has(p.path))throw new Error('DUPLICATE_OR_INVALID_PATH_EVIDENCE');byPath.set(p.path,p);}
    const disks=new Map(),physicalWrites=new Set();
    const writablePaths=new Set(Object.values(model.services).flatMap(s=>s.volumes.filter(v=>!v.read_only).map(v=>v.source)));
    for(const needed of requiredPaths(model,metadata)){
      const p=byPath.get(needed.path);
      if(!p){fail('PATH_UNKNOWN',needed.path);continue;}
      if(!outsideVar(needed.path)||!outsideVar(p.realpath)||p.kind!==needed.kind||p.exists!==true)fail('REALPATH_UNKNOWN_OR_VAR',needed.path);
      if(writablePaths.has(needed.path)){
        if([...physicalWrites].some(path=>path===p.realpath||path.startsWith(p.realpath+'/')||p.realpath?.startsWith(path+'/')))fail('PHYSICAL_BIND_COLLISION',needed.path);physicalWrites.add(p.realpath);
      }
      const mount=p.mount;
      if(!isRecord(mount)||typeof mount.source!=='string'||!mount.source||!['ext4','xfs','btrfs','zfs'].includes(mount.fstype)||typeof mount.target!=='string'||!mount.target.startsWith('/')||posix.normalize(mount.target)!==mount.target||(mount.target!=='/'&&p.realpath!==mount.target&&!p.realpath?.startsWith(mount.target+'/')))fail('DISK_ROUTE_UNKNOWN',needed.path);
      if(typeof p.deviceId!=='string'||!/^\d+$/.test(p.deviceId)||p.deviceId===metadata.varDeviceId)fail('VAR_FILESYSTEM_SHARED_OR_UNKNOWN',needed.path);
      if(!Number.isSafeInteger(p.freeBytes)||p.freeBytes<0)fail('DISK_FREE_UNKNOWN',needed.path);
      const disk=disks.get(p.deviceId)??{freeBytes:p.freeBytes,reserveBytes:0,source:mount?.source};
      if(disk.source!==mount?.source)fail('DISK_ROUTE_CONTRADICTION',needed.path);
      disk.freeBytes=Math.min(disk.freeBytes,p.freeBytes);disk.reserveBytes+=needed.reserveBytes;disks.set(p.deviceId,disk);
    }
    for(const [id,disk] of disks)if(!Number.isSafeInteger(disk.reserveBytes)||disk.freeBytes<disk.reserveBytes)fail('DISK_CAPACITY_INSUFFICIENT',id);
  }catch{fail('METADATA_INCOMPLETE_OR_CONTRADICTORY','metadata');}
  return {status:errors.length?'BLOCKED':'METADATA_CHECKS_PASSED_REVIEW_ONLY',errors,activationAllowed:false};
}
export function parseContainerdArgs(argv){
  let root,config;
  for(let i=1;i<argv.length;i++){
    const a=argv[i];let key,value;
    if(/^(--root|-r|--config|-c)$/.test(a)){key=a;value=argv[++i];}
    else if(/^(?:--root|--config|-r|-c)=/.test(a)){[key,...value]=a.split('=');value=value.join('=');}
    else if(/^-(?:r|c)./.test(a)||a==='--')throw new Error('CONTAINERD_ARGUMENT_FORM_UNKNOWN');
    else continue;
    if(!value||!outsideVar(value)&&!(key==='--config'||key==='-c'))throw new Error('CONTAINERD_ARG_UNKNOWN_OR_VAR');
    if(key==='--root'||key==='-r'){if(root!==undefined)throw new Error('CONTAINERD_ROOT_CONTRADICTION');root=value;}
    else {if(config!==undefined||!value.startsWith('/'))throw new Error('CONTAINERD_CONFIG_CONTRADICTION');config=value;}
  }
  return {root,config};
}
export function containerdStorageFromDump(argv,dump){
  const flags=parseContainerdArgs(argv);
  const roots=[...dump.matchAll(/^root\s*=\s*"([^"\r\n]+)"\s*$/gm)];
  if(roots.length!==1||/^\s*\[proxy_plugins(?:\.|\])/m.test(dump))throw new Error('CONTAINERD_STORE_UNKNOWN');
  // Non-default plugin stores/proxy snapshotters need a separate audited route.
  if(/^\s+(?:root|root_path|upperdir|workdir)\s*=\s*"[^"\r\n]+"/m.test(dump))throw new Error('CONTAINERD_EXTERNAL_STORE_UNKNOWN');
  const root=flags.root??roots[0][1];
  if(!outsideVar(root))throw new Error('CONTAINERD_STORE_UNDER_VAR');
  return {root,externalStores:false};
}
export function confirmContainerdLiveRoot(storage,fdTargets,physicalRoot=storage.root){
  if(!Array.isArray(fdTargets)||!outsideVar(physicalRoot))throw new Error('CONTAINERD_LIVE_STORE_UNKNOWN');
  const suffix='/io.containerd.metadata.v1.bolt/meta.db';
  const roots=new Set(fdTargets.filter(p=>typeof p==='string'&&p.endsWith(suffix)).map(p=>p.slice(0,-suffix.length)));
  if(roots.size!==1||!roots.has(physicalRoot))throw new Error('CONTAINERD_LIVE_STORE_UNKNOWN_OR_CONTRADICTORY');
  return {...storage,effective:true,liveRootConfirmed:true};
}
function inspectPath(path){
  // Filesystem metadata only; never read file contents, keys, DBs or certificates.
  const physical=realpathSync(path),s=statSync(physical),fs=statfsSync(physical);
  const found=parseStrictJson(run('findmnt',['--json','--target',physical,'--output','TARGET,SOURCE,FSTYPE']));
  if(found.filesystems?.length!==1)throw new Error('DISK_ROUTE_UNKNOWN');
  const f=found.filesystems[0];
  return {path,exists:true,realpath:physical,kind:s.isDirectory()?'directory':s.isFile()?'file':'unsupported',deviceId:String(s.dev),freeBytes:fs.bavail*fs.bsize,mount:{target:f.target,source:f.source,fstype:f.fstype}};
}
export function collectLocalMetadata(model){
  if(process.platform!=='linux'||process.arch!=='x64')throw new Error('UBUNTU_LOCAL_METADATA_ONLY');
  if(process.env.DOCKER_HOST||process.env.DOCKER_CONTEXT)throw new Error('DOCKER_ENDPOINT_OVERRIDE_REJECTED');
  // Do not inherit the Docker context. This endpoint cannot address a VPS.
  const info=parseStrictJson(run('docker',['--host','unix:///var/run/docker.sock','info','--format','{{json .}}']));
  if(info.OSType!=='linux'||typeof info.DockerRootDir!=='string')throw new Error('DOCKER_METADATA_UNKNOWN');
  const os=readFileSync('/etc/os-release','utf8');
  const field=key=>new RegExp('^'+key+'=(?:"([^"\\r\\n]+)"|([^\\r\\n]+))$','m').exec(os)?.slice(1).find(Boolean);
  const metadata={version:1,capturedAt:new Date().toISOString(),platform:process.platform,arch:process.arch,os:{id:field('ID'),versionId:field('VERSION_ID')},daemon:{DockerRootDir:info.DockerRootDir,endpoint:'unix:///var/run/docker.sock',rootless:info.SecurityOptions?.some(v=>v.includes('rootless'))??true},limits:{memory:info.MemoryLimit,swap:info.SwapLimit,cpu:info.CpuCfsQuota,pids:info.PidsLimit},containerd:[],varDeviceId:String(statSync(realpathSync('/var')).dev),paths:[]};
  for(const pid of readdirSync('/proc').filter(p=>/^\d+$/.test(p))){
    let args;
    try{args=readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0').filter(Boolean);}catch(error){if(error.code==='ENOENT'||error.code==='ESRCH')continue;throw new Error('PROCESS_METADATA_UNREADABLE');}
    if(!args.length||posix.basename(args[0])!=='containerd')continue;
    const flags=parseContainerdArgs(args);
    const dump=run('/proc/'+pid+'/exe',[...(flags.config?['--config',flags.config]:[]),'config','dump']);
    const storage=containerdStorageFromDump(args,dump);
    // Read symlink metadata for descriptors already opened by containerd; do
    // not open the database, secrets or certificate files behind them.
    const descriptors=readdirSync('/proc/'+pid+'/fd');
    if(descriptors.length>4096)throw new Error('CONTAINERD_DESCRIPTOR_INVENTORY_UNKNOWN');
    const targets=descriptors.map(fd=>readlinkSync('/proc/'+pid+'/fd/'+fd));
    const confirmed=confirmContainerdLiveRoot(storage,targets,realpathSync(storage.root));
    if(readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0').filter(Boolean).join('\0')!==args.join('\0'))throw new Error('CONTAINERD_PROCESS_CHANGED');
    metadata.containerd.push({pid:Number(pid),...confirmed});
  }
  if(!metadata.containerd.length)throw new Error('CONTAINERD_METADATA_UNKNOWN');
  for(const p of requiredPaths(model,metadata))metadata.paths.push(inspectPath(p.path));
  return metadata;
}
export function runPreflight(args){
  const model=parseStrictJson(readFileSync(new URL('docker-compose.yml',import.meta.url),'utf8'));
  let metadata;
  if(args.length===1&&args[0]==='--collect-local')metadata=collectLocalMetadata(model);
  else if(args.length===2&&args[0]==='--metadata'&&args[1].endsWith('.metadata.json'))metadata=parseStrictJson(readFileSync(args[1],'utf8'));
  else throw new Error('USE_COLLECT_LOCAL_OR_EXPLICIT_METADATA_JSON');
  return validateMetadata(model,metadata);
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  try{const result=runPreflight(process.argv.slice(2));console.log(JSON.stringify(result,null,2));process.exitCode=result.errors.length?2:0;}
  catch{console.log(JSON.stringify({status:'BLOCKED',code:'METADATA_UNAVAILABLE_OR_UNSAFE',activationAllowed:false}));process.exitCode=2;}
}
