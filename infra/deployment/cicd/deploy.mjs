import {readFileSync,writeFileSync,mkdirSync,lstatSync,realpathSync,openSync,closeSync,unlinkSync,renameSync,existsSync,statfsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {digest,validateRelease,releaseEnvironment,services,variables} from './release.mjs';
export const apps=[...services,'received-sync-worker'];
export const allServices=['postgres','redis','kong',...apps];
const fail=code=>{throw Error(code);};
export function checkApproval(approval,releaseBytes,now=Date.now()){
 if(approval?.releaseSha256!==digest(releaseBytes)||approval.schemaCompatible!==true||approval.rollbackCompatible!==true||approval.backupVerified!==true||
 !Number.isFinite(Date.parse(approval.expiresAt))||Date.parse(approval.expiresAt)<=now||Date.parse(approval.expiresAt)>now+2*3600000||
 !Number.isFinite(Date.parse(approval.backupVerifiedAt))||now-Date.parse(approval.backupVerifiedAt)>86400000||Date.parse(approval.backupVerifiedAt)>now||
 typeof approval.backupReference!=='string'||!approval.backupReference.startsWith('/srv/')||approval.backupReference.split('/').includes('..'))fail('EXACT_APPROVAL_AND_VERIFIED_BACKUP_REQUIRED');
 return approval;
}
export function planDeployment(config,release,bytes){
 validateRelease(release,config.registryPrefix);
 if(config.format!=='factuez.core.delivery-config.v1'||!/^factuez-[a-z0-9-]{1,40}$/.test(config.project)||config.schemaSha256!==release.schemaSha256||config.composeSha256!==release.composeSha256||config.kongSha256!==release.kongSha256)fail('SCHEMA_OR_COMPOSE_REQUIRES_TI_REVIEW');
 for(const p of [config.directory,config.composeFile,config.kongFile,config.publicEnv,config.currentImages])if(typeof p!=='string'||!p.startsWith('/srv/')||path.posix.normalize(p)!==p||p.includes('\n'))fail('EXPLICIT_SRV_PATHS_REQUIRED');
 return {id:digest(bytes),imagesEnvironment:releaseEnvironment(release),services:apps,project:config.project};
}
function regular(file,limit=131072){
 const absolute=path.resolve(file);let current=path.parse(absolute).root;
 for(const part of absolute.slice(current.length).split(path.sep)){current=path.join(current,part);if(lstatSync(current).isSymbolicLink())fail('SYMLINK_NOT_ALLOWED');}
 const st=lstatSync(file);if(!st.isFile()||st.nlink!==1||st.size>limit||realpathSync(file)!==absolute)fail('REGULAR_FILE_REQUIRED');
 return readFileSync(file);
}
function secureDirectory(dir){if(realpathSync(dir)!==dir||!lstatSync(dir).isDirectory()||(lstatSync(dir).mode&0o022))fail('PRIVATE_DELIVERY_DIRECTORY_REQUIRED');}
function envValues(bytes){
 const result={};for(const line of bytes.toString('utf8').split(/\r?\n/)){if(!line||line.startsWith('#'))continue;const m=/^([A-Z][A-Z0-9_]*)=([^\r\n]*)$/.exec(line);if(!m||m[2].includes('$')||m[2].includes('`')||Object.hasOwn(result,m[1]))fail('PLAIN_PUBLIC_ENV_REQUIRED');result[m[1]]=m[2];}return result;
}
export function verifyCoreModel(model){
 if(Object.keys(model.services??{}).sort().join('|')!==[...allServices].sort().join('|'))fail('EXACT_CORE_REQUIRED');
 let memory=0;for(const [name,s]of Object.entries(model.services)){
 memory+=Number(s.mem_limit);if(!Number.isSafeInteger(s.mem_limit)||s.mem_limit<=0||s.memswap_limit!==s.mem_limit||s.restart!=='unless-stopped'||s.logging?.options?.['max-size']!=='10m'||s.logging?.options?.['max-file']!=='3'||s.build||s.privileged)fail('CORE_RESOURCE_CONTRACT');
 const ports=s.ports??[];if(name==='kong'){if(ports.length!==1||ports[0].host_ip!=='127.0.0.1'||String(ports[0].published)!=='9000'||ports[0].target!==8000)fail('LOOPBACK_PORT_REQUIRED');}else if(ports.length)fail('UNEXPECTED_PUBLISHED_PORT');
 if(!s.healthcheck||s.healthcheck.disable)fail('HEALTHCHECK_REQUIRED');
 }if(memory>8000000000)fail('MEMORY_BUDGET_EXCEEDED');return true;
}
/** Dependency-injected transaction is tested without Docker, SSH, a registry or fiscal calls. */
export async function performUpdate(io){
 await io.preflight();await io.pull();let changed=false;
 try{changed=true;await io.stop();await io.startNew();await io.healthNew();await io.commit();return 'DEPLOYED';}
 catch{if(changed){try{await io.stop();await io.startPrevious();await io.healthPrevious();}catch{fail('UPDATE_FAILED_ROLLBACK_FAILED_MANUAL_RECOVERY_REQUIRED');}fail('UPDATE_FAILED_PREVIOUS_IMAGES_RESTORED');}fail('UPDATE_FAILED');}
}
function docker(args,timeout=60000){
 const r=spawnSync('docker',['--host','unix:///var/run/docker.sock',...args],{encoding:'utf8',timeout,maxBuffer:4*1024*1024,env:{PATH:process.env.PATH,HOME:process.env.HOME,DOCKER_CONFIG:process.env.DOCKER_CONFIG??path.join(process.env.HOME??'/nonexistent','.docker')}});
 if(r.status!==0||r.error)fail('DOCKER_OPERATION_FAILED');return r.stdout;
}
export async function deploy(configFile,bytes){
 if(process.platform!=='linux'||process.arch!=='x64'||bytes.length>65536)fail('LOCAL_LINUX_AMD64_REQUIRED');
 const config=JSON.parse(regular(configFile)),r=JSON.parse(bytes.toString('utf8')),plan=planDeployment(config,r,bytes);
 secureDirectory(config.directory);for(const part of ['approvals','receipts','releases'])secureDirectory(path.join(config.directory,part));const lock=path.join(config.directory,'deployment.lock');let fd;
 try{fd=openSync(lock,'wx',0o600);}catch{fail('DEPLOYMENT_LOCKED');}
 try{
  if(digest(regular(config.composeFile))!==r.composeSha256||digest(regular(config.kongFile))!==r.kongSha256||path.dirname(config.composeFile)!==path.dirname(config.kongFile))fail('INSTALLED_COMPOSE_DRIFT');
  const publicVars=envValues(regular(config.publicEnv));if(Object.keys(publicVars).some(k=>!k.startsWith('CORE_')))fail('ONLY_CORE_PUBLIC_VARIABLES_ALLOWED');if(!publicVars.CORE_ROOT?.startsWith('/srv/')||publicVars.CORE_ROOT.includes('..'))fail('DATA_ROOT_REQUIRED');
  const previous=regular(config.currentImages),previousVars=envValues(previous);
  if(Object.keys(previousVars).sort().join('|')!==Object.values(variables).sort().join('|'))fail('BASELINE_IMAGES_REQUIRED');
  for(const s of services)validateRelease({...r,images:{...r.images,[s]:previousVars[variables[s]]}},config.registryPrefix);
  const approvalPath=path.join(config.directory,'approvals',plan.id+'.json');
  const approval=checkApproval(JSON.parse(regular(approvalPath)),bytes);regular(approval.backupReference,1024*1024);
  const receipt=path.join(config.directory,'receipts',plan.id+'.json');if(existsSync(receipt))fail('RELEASE_ALREADY_ATTEMPTED_REVIEW_REQUIRED');
  const releaseDir=path.join(config.directory,'releases',plan.id);mkdirSync(releaseDir,{mode:0o700});
  const newEnv=path.join(releaseDir,'images.env'),oldEnv=path.join(releaseDir,'previous.env');
  writeFileSync(newEnv,plan.imagesEnvironment,{flag:'wx',mode:0o600});writeFileSync(oldEnv,previous,{flag:'wx',mode:0o600});writeFileSync(path.join(releaseDir,'release.json'),bytes,{flag:'wx',mode:0o600});
  const compose=(imageEnv,args)=>docker(['compose','--project-name',config.project,'--env-file',config.publicEnv,'--env-file',imageEnv,'-f',config.composeFile,...args],args[0]==='up'?300000:args[0]==='stop'?180000:60000);
  const oldModel=JSON.parse(compose(oldEnv,['config','--format','json'])),newModel=JSON.parse(compose(newEnv,['config','--format','json']));verifyCoreModel(oldModel);verifyCoreModel(newModel);
  const infrastructure=['postgres','redis','kong'];for(const s of infrastructure)if(JSON.stringify(oldModel.services[s])!==JSON.stringify(newModel.services[s]))fail('INFRASTRUCTURE_CHANGE_FORBIDDEN');
  const expectedImages=model=>Object.fromEntries(allServices.map(s=>[s,model.services[s].image]));
  const health=async(env,expected)=>{
   for(const s of allServices){const ids=compose(env,['ps','--all','--quiet',s]).trim().split(/\s+/);if(ids.length!==1||!/^([a-f0-9]{12}|[a-f0-9]{64})$/.test(ids[0]))fail('EXACT_CONTAINER_REQUIRED');const state=JSON.parse(docker(['inspect','--format','{{json .}}',ids[0]]));if(!state.State.Running||state.State.Health?.Status!=='healthy'||state.Config.Image!==expected[s])fail('CONTAINER_HEALTH_OR_IMAGE_MISMATCH');}
   const response=await fetch('http://127.0.0.1:9000/login',{redirect:'error',signal:AbortSignal.timeout(15000)});if(response.status!==200)fail('PWA_SMOKE_FAILED');await response.body?.cancel();
  };
  let outcome='FAILED';try{outcome=await performUpdate({
   preflight:async()=>{const info=JSON.parse(docker(['info','--format','{{json .}}']));if(info.OSType!=='linux'||info.MemoryLimit!==true||info.SwapLimit!==true||info.CpuCfsQuota!==true||!info.DockerRootDir.startsWith('/srv/'))fail('DOCKER_STORAGE_OUTSIDE_SRV');const disk=statfsSync(config.directory);if(Number(disk.bavail)*Number(disk.bsize)<4*1024**3)fail('INSUFFICIENT_DELIVERY_DISK');await health(oldEnv,expectedImages(oldModel));},
   pull:async()=>{for(const s of services)docker(['pull',r.images[s]],180000);},
   stop:async()=>{compose(oldEnv,['stop','--timeout','90',...apps]);},
   startNew:async()=>{compose(newEnv,['up','--detach','--no-deps','--no-build','--pull','never','--wait','--wait-timeout','180',...apps]);},
   healthNew:()=>health(newEnv,expectedImages(newModel)),
   startPrevious:async()=>{compose(oldEnv,['up','--detach','--no-deps','--no-build','--pull','never','--wait','--wait-timeout','180',...apps]);},
   healthPrevious:()=>health(oldEnv,expectedImages(oldModel)),
   commit:async()=>{const target=config.currentImages+'.next';writeFileSync(target,plan.imagesEnvironment,{flag:'wx',mode:0o600});renameSync(target,config.currentImages);}
  });}catch(e){outcome=/^[A-Z_]+$/.test(e.message)?e.message:'FAILED';throw e;}finally{writeFileSync(receipt,JSON.stringify({releaseSha256:plan.id,commit:r.commit,outcome,at:new Date().toISOString(),schemaChanged:false,officialTestRequests:0})+'\n',{flag:'wx',mode:0o600});}
  return outcome;
 }finally{closeSync(fd);unlinkSync(lock);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{if(process.argv.length!==4||process.argv[2]!=='--stdin')fail('USE_STDIN_AND_LOCAL_CONFIG');let size=0,parts=[];for await(const b of process.stdin){size+=b.length;if(size>65536)fail('RELEASE_TOO_LARGE');parts.push(b);}console.log(await deploy(process.argv[3],Buffer.concat(parts)));}catch(e){console.error(/^[A-Z_]+$/.test(e.message)?e.message:'DEPLOYMENT_FAILED');process.exitCode=1;}
}
