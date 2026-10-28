/** Read-only VPS preflight. Never starts containers, reads secret contents, changes files or sends HTTP. */
import {lstatSync,readFileSync,realpathSync,statfsSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {arch,platform,cpus} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolvePublicVariables,validate,requiredVariables} from './validate.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const outsideVar=p=>typeof p==='string'&&path.posix.isAbsolute(p)&&p!=='/'&&!['/var','/run','/tmp','/proc','/sys','/dev'].some(x=>p===x||p.startsWith(x+'/'));
export function assessHost(s){
 const checks=[];const check=(id,ok)=>checks.push({id,ok:Boolean(ok)});
 check('LINUX_X86_64',s.platform==='linux'&&s.arch==='x64');
 check('HOST_CPU_BUDGET',Number.isInteger(s.cpuCount)&&s.cpuCount>=9);
 check('DOCKER_RESOURCE_LIMITS_SUPPORTED',s.resourceLimitsSupported===true);
 check('NATIVE_UID_MAPPING',s.nativeUidMapping===true);
 check('LOCAL_DOCKER_ENGINE',s.localDocker===true&&s.dockerOs==='linux'&&['x86_64','amd64'].includes(s.dockerArch));
 check('DOCKER_STORE_OUTSIDE_VAR',outsideVar(s.dockerRoot));
 check('CONTAINERD_STORE_VERIFIED_OUTSIDE_VAR',s.containerdRootVerified===true&&outsideVar(s.containerdRoot));
 check('HOST_AVAILABLE_MEMORY',Number.isSafeInteger(s.availableMemory)&&s.availableMemory>=8_700_000_000);
 check('DATA_ROOT_NOT_SYMLINKED',s.dataRootReal===s.dataRoot&&outsideVar(s.dataRoot));
 check('DATA_DISK_FREE',Number.isFinite(s.dataFree)&&s.dataFree>=10_000_000_000);
 check('DOCKER_DISK_FREE',Number.isFinite(s.dockerFree)&&s.dockerFree>=10_000_000_000);
 check('LOOPBACK_PORT_9000_AVAILABLE',s.port9000Free===true);
 check('PUBLIC_BINDINGS_PRESENT',Array.isArray(s.bindings)&&s.bindings.length>=10&&s.bindings.every(x=>x.ok===true));
 check('SECRETS_METADATA_VALID',Array.isArray(s.secrets)&&s.secrets.length===15&&s.secrets.every(x=>x.ok===true));
 check('PUBLIC_PKI_HASHES_MATCH',Array.isArray(s.pki)&&s.pki.length===3&&s.pki.every(x=>x.ok===true));
 check('OFFICIAL_XSD_HASH_MATCH',s.xsdValid===true);
 check('POSTGRES_CLUSTER_17_PRESENT',s.postgresVersion==='17');
 check('APPROVED_IMAGES_LOCAL',Array.isArray(s.images)&&s.images.length===10&&s.images.every(x=>x.ok===true));
 return {result:checks.every(x=>x.ok)?'PASS':'BLOCKED',checks,prerequisitesNotProbed:['Database schemas, roles and SQL grants','Secret syntax and credential validity','PKI trust, CRL validity and SUNAT registration','TLS public origin and reverse proxy','RUC activation and pilot acceptance'],containersStarted:false,filesChanged:false,secretContentsRead:false,externalRequests:0};
}
function run(binary,args,max=1_048_576){try{return execFileSync(binary,args,{encoding:'utf8',timeout:15000,maxBuffer:max,stdio:['ignore','pipe','pipe']}).trim();}catch{throw Error('HOST_METADATA_UNAVAILABLE');}}
function plainFile(p,max=1_048_576){const s=lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size<1||s.size>max)throw Error('PUBLIC_FILE_INVALID');return readFileSync(p);}
function noLinks(p){let cur=path.parse(p).root;for(const part of p.slice(cur.length).split(path.sep).filter(Boolean)){cur=path.join(cur,part);if(lstatSync(cur).isSymbolicLink())return false;}return true;}
function free(p){const s=statfsSync(p);return Number(s.bavail)*Number(s.bsize);}
function containerdStore(){
 // Ask the running service for PID, then honor --root/--config overrides of that daemon.
 const pid=run('systemctl',['show','containerd','--property=MainPID','--value'],64);
 if(!/^[1-9]\d{0,9}$/.test(pid))throw Error('CONTAINERD_METADATA_UNAVAILABLE');
 const args=readFileSync('/proc/'+pid+'/cmdline').toString().split('\0').filter(Boolean);
 if(!args[0]?.endsWith('/containerd'))throw Error('CONTAINERD_PROCESS_MISMATCH');
 const option=names=>{for(let i=1;i<args.length;i++){for(const n of names){if(args[i]===n)return args[i+1];if(args[i].startsWith(n+'='))return args[i].slice(n.length+1);}}};
 const override=option(['--root']);if(override)return realpathSync(override);
 const config=option(['--config','-c'])??'/etc/containerd/config.toml';
 if(!existsSync(config))return realpathSync('/var/lib/containerd');
 // The daemon's own parser resolves defaults/imports; captured output is never logged.
 const resolved=run('containerd',['--config',config,'config','dump']);
 const top=resolved.split(/^\[/m,1)[0],match=/^root\s*=\s*"([^"\r\n]+)"\s*$/m.exec(top);
 if(!match)throw Error('CONTAINERD_ROOT_UNVERIFIED');return realpathSync(match[1]);
}
export function secretMetadata(name,file,io={lstat:lstatSync,noLinks}){
 let ok=false;try{const st=io.lstat(file);
  ok=io.noLinks(file)&&st.isFile()&&st.nlink===1&&st.size>0&&st.size<=65536&&st.uid===1000&&(st.mode&0o777)===0o600;
  if(['smtp_settings_key','production_notes_owner_key','reception_settings_key','app_master_key'].includes(name))ok=ok&&st.size>=43&&st.size<=128;
 }catch{}return{name,ok};
}
export function portAvailable(sockets){return !sockets.split('\n').some(l=>/^\s*LISTEN\s+\S+\s+\S+\s+\S*:9000\s/.test(l));}
export function availableMemory(meminfo){const m=/^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(meminfo);if(!m)throw Error('HOST_MEMORY_UNVERIFIED');return Number(m[1])*1024;}
export function inspectHost(vars){
 if(platform()!=='linux'||arch()!=='x64')throw Error('RUN_READONLY_PREFLIGHT_ON_LINUX_X86_64_VPS');
 const model=resolvePublicVariables(vars);validate(model,{resolved:true});
 const context=run('docker',['context','show'],128);
 const endpoint=run('docker',['context','inspect',context,'--format','{{.Endpoints.docker.Host}}'],512);
 if(!/^unix:\/\//.test(endpoint))throw Error('REMOTE_DOCKER_NOT_ALLOWED');
 const docker=JSON.parse(run('docker',['info','--format','{{json .}}']));
 const root=vars.CORE_ROOT,rootReal=realpathSync(root);
 const bindings=[];
 for(const [service,s]of Object.entries(model.services))for(const b of s.volumes??[]){
  let ok=false;try{const source=path.isAbsolute(b.source)?b.source:path.resolve(here,b.source),st=lstatSync(source);
   ok=noLinks(source)&&(st.isDirectory()||st.isFile())&&realpathSync(source)===source;
   if(!b.read_only&&service!=='postgres')ok=ok&&st.isDirectory()&&st.uid===1000&&(st.mode&0o700)===0o700&&(st.mode&0o002)===0;
  }catch{}bindings.push({service,target:b.target,ok});
 }
 const secrets=Object.entries(model.secrets).map(([name,s])=>secretMetadata(name,s.file));
 const pki=['issuer-roots','crls','cdr-signers'].map((name,i)=>{let ok=false;try{const b=plainFile(path.join(root,'config/pki',name+'.pem'),5*1024*1024);
  ok=createHash('sha256').update(b).digest('hex')===vars[['CORE_ISSUER_ROOTS_SHA256','CORE_CRLS_SHA256','CORE_CDR_SIGNERS_SHA256'][i]];
 }catch{}return{name,ok};});
 let xsdValid=false;try{const b=plainFile(path.join(root,'config/xsd/xsd-20220228.zip'));xsdValid=b.length===609363&&createHash('sha256').update(b).digest('hex')==='5cac9d9353521340fbc15d23f465a4946b004535b9ff411541c87da01694dbd5';}catch{}
 const images=requiredVariables.filter(n=>n.endsWith('_IMAGE')).map(variable=>{let ok=false;try{const a=JSON.parse(run('docker',['image','inspect',vars[variable],'--format','{{json .}}']));
  ok=a.Os==='linux'&&a.Architecture==='amd64'&&a.RepoDigests?.includes(vars[variable]);}catch{}return{variable,ok};});
 let containerdRoot,containerdRootVerified=false;try{containerdRoot=containerdStore();containerdRootVerified=true;}catch{}
 let postgresVersion;try{postgresVersion=plainFile(path.join(root,'data/postgres/PG_VERSION'),16).toString().trim();}catch{}
 const sockets=run('ss',['-H','-ltn']);
 const port9000Free=portAvailable(sockets);
 const s={platform:platform(),arch:arch(),cpuCount:cpus().length,resourceLimitsSupported:docker.MemoryLimit===true&&docker.SwapLimit===true&&docker.CpuCfsQuota===true,nativeUidMapping:!docker.SecurityOptions?.some(x=>/rootless|userns/i.test(x)),localDocker:true,dockerOs:docker.OSType,dockerArch:docker.Architecture,
  dockerRoot:realpathSync(docker.DockerRootDir),containerdRoot,containerdRootVerified,availableMemory:availableMemory(readFileSync('/proc/meminfo','utf8')),
  dataRoot:root,dataRootReal:rootReal,dataFree:free(root),dockerFree:free(docker.DockerRootDir),port9000Free,bindings,secrets,pki,xsdValid,postgresVersion,images};
 return {...assessHost(s),details:{bindings,secrets,pki,images}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const args=process.argv.slice(2);
  if(args.length!==2||args[0]!=='--read-only')throw Error('Usage: node preflight.mjs --read-only /absolute/path/core-public.json');
  const file=args[1];if(!path.isAbsolute(file)||!noLinks(file))throw Error('PUBLIC_JSON_ABSOLUTE_REGULAR_PATH_REQUIRED');
  const vars=JSON.parse(plainFile(file,65536).toString('utf8'));
  const result=inspectHost(vars);console.log(JSON.stringify(result,null,2));if(result.result!=='PASS')process.exitCode=1;
 }catch(e){console.error(JSON.stringify({result:'BLOCKED',code:/^[A-Z_]+$/.test(e.message)?e.message:'HOST_PREFLIGHT_FAILED',containersStarted:false,filesChanged:false,secretContentsRead:false,externalRequests:0}));process.exitCode=1;}
}
