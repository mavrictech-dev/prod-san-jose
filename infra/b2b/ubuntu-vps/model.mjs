import { posix } from 'node:path';
import { inventory,model as referenceModel } from './generate-review.mjs';
export const MEMORY_BUDGET=8_000_000_000;
export const CPU_BUDGET=9;
export const isRecord=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export const outsideVar=p=>typeof p==='string'&&p.startsWith('/')&&!p.startsWith('//')&&posix.normalize(p)===p&&!/[\x00-\x20\\$]/.test(p)&&p!=='/var'&&!p.startsWith('/var/')&&p!=='/';
export const immutableImage=v=>typeof v==='string'&&/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(v)&&!/@sha256:([a-f0-9])\1{63}$/.test(v);
export const requiredRef=v=>typeof v==='string'&&/^\$\{B2B_[A-Z0-9_]+:\?[^{}\r\n]+\}$/.test(v);
const keys=(v,allowed)=>isRecord(v)&&Object.keys(v).every(k=>allowed.includes(k));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const expectedNames=inventory.map(r=>r[0]);
const serviceKeys=['image','platform','pull_policy','restart','mem_limit','memswap_limit','cpus','pids_limit','logging','networks','security_opt','entrypoint','command','healthcheck','volumes','environment','x-runtime','profiles','secrets','ports','depends_on'];
function inspectModel(m,{resolvedImages=false}={}){
  const errors=[];let memoryBytes=0,cpus=0;
  const fail=(code,at)=>errors.push({code,at});
  if(!keys(m,['name','x-review','services','networks','secrets']))fail('TOP_LEVEL_UNSUPPORTED','compose');
  if(!isRecord(m))return {valid:false,errors,memoryBytes,cpus,activationAllowed:false};
  if(m.name!=='factuez-b2b-vps-review')fail('PROJECT_NAME','name');
  if(!isRecord(m['x-review'])||m['x-review'].status!=='BLOCKED'||m['x-review'].activationAllowed!==false||m['x-review'].memoryBudgetBytes!==MEMORY_BUDGET)fail('REVIEW_GATE','x-review');
  if(!same(m.networks,{'factuez-vps':{driver:'bridge'}}))fail('NETWORK_POLICY','networks');
  if(!isRecord(m.services)||!same(Object.keys(m.services).sort(),[...expectedNames].sort()))fail('SERVICE_INVENTORY','services');
  if(!isRecord(m.secrets)||!Object.keys(m.secrets).length)fail('SECRET_INVENTORY','secrets');
  if(!same(m.secrets,referenceModel.secrets))fail('SECRET_INVENTORY','secrets');
  for(const [n,s] of Object.entries(isRecord(m.secrets)?m.secrets:{})){
    if(!/^[a-z_]+$/.test(n)||!keys(s,['file'])||!outsideVar(s.file)||!s.file.startsWith('/srv/factuez-vps/secrets/'))fail('SECRET_SOURCE',n);
  }
  const published=new Set(),writableSources=new Set(),secretSources=new Set();
  for(const s of Object.values(isRecord(m.secrets)?m.secrets:{})){
    if(secretSources.has(s.file))fail('SECRET_SOURCE_COLLISION','secrets');secretSources.add(s.file);
  }
  for(const [n,s] of Object.entries(isRecord(m.services)?m.services:{})){
    if(!keys(s,serviceKeys)){fail('SERVICE_UNSUPPORTED',n);if(!isRecord(s))continue;}
    if(!Number.isSafeInteger(s.mem_limit)||s.mem_limit<16*1048576)fail('MEMORY_LIMIT',n);else memoryBytes+=s.mem_limit;
    if(s.memswap_limit!==s.mem_limit)fail('SWAP_LIMIT',n);
    if(typeof s.cpus!=='number'||!Number.isFinite(s.cpus)||s.cpus<=0||s.cpus>2)fail('CPU_LIMIT',n);else cpus+=s.cpus;
    if(!Number.isInteger(s.pids_limit)||s.pids_limit<16||s.pids_limit>256)fail('PID_LIMIT',n);
    if(s.restart!=='unless-stopped')fail('RESTART_POLICY',n);
    if(!same(s.logging,{driver:'json-file',options:{'max-size':'10m','max-file':'3'}}))fail('LOGGING_POLICY',n);
    if(s.platform!=='linux/amd64'||s.pull_policy!=='never')fail('IMAGE_POLICY',n);
    const variable='B2B_'+n.toUpperCase().replaceAll('-','_')+'_IMAGE';
    if(!immutableImage(s.image)&&!(resolvedImages===false&&requiredRef(s.image)&&s.image.startsWith('${'+variable+':?')))fail('IMMUTABLE_IMAGE_REQUIRED',n);
    if(!same(s.networks,['factuez-vps'])||!same(s.security_opt,['no-new-privileges:true']))fail('SERVICE_ISOLATION',n);
    if(!same(s.entrypoint,['/bin/sh','/review/review-blocked.sh'])||!same(s.command,[])||!same(s.healthcheck,{disable:true}))fail('STARTUP_GATE',n);
    const runtime=s['x-runtime'];
    if(!keys(runtime,['status','source','executableVerified','proposedCommand','reason'])||runtime.status!=='BLOCKED'||runtime.executableVerified!==false||runtime.proposedCommand!==null||typeof runtime.source!=='string'||!runtime.source||typeof runtime.reason!=='string'||!runtime.reason)fail('RUNTIME_METADATA',n);
    const expectedProfile=inventory.find(r=>r[0]===n)?.[3];
    if(expectedProfile?!same(s.profiles,[expectedProfile]):s.profiles!==undefined)fail('PROFILE_POLICY',n);
    if(!isRecord(s.environment)||s.environment.B2B_REVIEW_ONLY!=='true'||(!requiredRef(s.environment.B2B_TI_REVIEW_REFERENCE)&&!/^TI-[A-Za-z0-9._-]{1,80}$/.test(s.environment.B2B_TI_REVIEW_REFERENCE??'')))fail('TI_CONFIGURATION',n);
    const reference=referenceModel.services[n];
    if(reference&&(!isRecord(s.environment)||!same(Object.keys(s.environment).sort(),Object.keys(reference.environment).sort())))fail('ENVIRONMENT_INVENTORY',n);
    for(const [k,v] of Object.entries(isRecord(s.environment)?s.environment:{})){
      if(typeof v!=='string'||/[\r\n\x00]/.test(v)||(/\$/.test(v)&&!requiredRef(v)))fail('ENVIRONMENT_FORMAT',n+'.'+k);
      if(/(?:PASSWORD|TOKEN|PRIVATE_KEY|MASTER_KEY|SETTINGS_KEY|DB_USER|ADMIN_USER|RUC)/.test(k)&&!k.endsWith('_FILE')&&!requiredRef(v))fail('INLINE_CREDENTIAL_OR_IDENTITY',n+'.'+k);
      if(k.endsWith('_FILE')&&(!/^\/run\/secrets\/[a-z_]+$/.test(v)||!s.secrets?.includes(v.slice('/run/secrets/'.length))))fail('SECRET_REFERENCE',n+'.'+k);
      if(/(?:MOCK|FIXTURE|QA_USE|LIVE_READ_ALLOWED)/.test(k)&&v!=='false')fail('UNSAFE_RUNTIME_FLAG',n+'.'+k);
      if(k==='B2B_API_ENABLED'&&v!=='false')fail('UNSAFE_RUNTIME_FLAG',n+'.'+k);
    }
    if(s.secrets!==undefined&&(!Array.isArray(s.secrets)||new Set(s.secrets).size!==s.secrets.length||s.secrets.some(ref=>typeof ref!=='string'||!Object.hasOwn(m.secrets??{},ref))))fail('SECRET_REFERENCE',n);
    if(reference&&!same(s.secrets,reference.secrets))fail('SERVICE_SECRET_INVENTORY',n);
    const targets=[];let blocker=false;
    if(!Array.isArray(s.volumes)||!s.volumes.length)fail('BIND_REQUIRED',n);
    for(const v of Array.isArray(s.volumes)?s.volumes:[]){
      if(!keys(v,['type','source','target','read_only','bind'])||v.type!=='bind'||!outsideVar(v.source)||!v.source.startsWith('/srv/factuez-vps/')||!same(v.bind,{create_host_path:false})||typeof v.read_only!=='boolean')fail('BIND_POLICY',n);
      if(typeof v.target!=='string'||!v.target.startsWith('/')||posix.normalize(v.target)!==v.target||/[\s\\$]/.test(v.target)||v.target==='/'||v.target==='/run'||v.target.startsWith('/run/')||v.target==='/proc'||v.target.startsWith('/proc/')||v.target==='/sys'||v.target.startsWith('/sys/')||v.target==='/dev'||v.target.startsWith('/dev/'))fail('BIND_TARGET',n);
      if(targets.some(t=>t===v.target||t.startsWith(v.target+'/')||v.target?.startsWith(t+'/')))fail('BIND_CONTRADICTION',n);
      targets.push(v.target);
      if(v.target==='/review/review-blocked.sh'&&v.source==='/srv/factuez-vps/config/review-blocked.sh'&&v.read_only===true)blocker=true;
      if(v.source?.startsWith('/srv/factuez-vps/config/')&&v.read_only!==true)fail('CONFIG_WRITABLE',n);
      if(v.read_only===false){if(writableSources.has(v.source))fail('WRITABLE_SOURCE_COLLISION',n);writableSources.add(v.source);}
    }
    if(!blocker)fail('BLOCKER_BIND_MISSING',n);
    if(reference&&!same(s.volumes,reference.volumes))fail('BIND_INVENTORY',n);
    if(s.depends_on!==undefined&&!isRecord(s.depends_on))fail('DEPENDENCY_FORMAT',n);
    for(const [dep,config] of Object.entries(isRecord(s.depends_on)?s.depends_on:{})){
      if(dep===n||!Object.hasOwn(m.services??{},dep)||!same(config,{condition:'service_started'})||m.services[dep]?.profiles)fail('DEPENDENCY_POLICY',n+'.'+dep);
    }
    if(s.ports!==undefined&&!Array.isArray(s.ports))fail('PORT_FORMAT',n);
    for(const p of Array.isArray(s.ports)?s.ports:[]){
      const allowed=n==='kong'&&p?.published==='9000'&&p?.target===8000||n==='postgres'&&p?.published==='9001'&&p?.target===5432;
      if(!keys(p,['target','published','host_ip','protocol'])||p.host_ip!=='127.0.0.1'||p.protocol!=='tcp'||!/^90[0-9]{2}$/.test(p.published)||!allowed)fail('PORT_POLICY',n);
      const key=String(p?.published);if(published.has(key))fail('PORT_COLLISION',n);published.add(key);
    }
    if(n==='kong'&&!same(s.ports,[{target:8000,published:'9000',host_ip:'127.0.0.1',protocol:'tcp'}]))fail('GATEWAY_PORT',n);
  }
  if(!Number.isSafeInteger(memoryBytes)||memoryBytes>MEMORY_BUDGET)fail('ALL_PROFILES_MEMORY_BUDGET','services');
  cpus=Math.round(cpus*1000)/1000;if(cpus>CPU_BUDGET)fail('ALL_PROFILES_CPU_BUDGET','services');
  return {valid:errors.length===0,errors,memoryBytes,cpus,activationAllowed:false};
}
export function validateModel(model,options){
  try{return inspectModel(model,options);}
  catch{return {valid:false,errors:[{code:'MODEL_SHAPE_INVALID',at:'compose'}],memoryBytes:0,cpus:0,activationAllowed:false};}
}
export function withPostgresOverride(model,override){
  if(!keys(override,['services'])||!keys(override.services,['postgres'])||!keys(override.services.postgres,['ports'])||!same(override.services.postgres.ports,[{target:5432,published:'9001',host_ip:'127.0.0.1',protocol:'tcp'}]))throw new Error('POSTGRES_OVERRIDE_REJECTED');
  const copy=structuredClone(model);
  if(copy.services.postgres.ports!==undefined)throw new Error('POSTGRES_PORTS_ALREADY_PRESENT');
  copy.services.postgres.ports=structuredClone(override.services.postgres.ports);return copy;
}
// Reject duplicate JSON keys (including escaped equivalents) before JSON.parse
// can erase a contradictory value. These artifacts intentionally use JSON/YAML.
export function parseStrictJson(input){
  if(typeof input!=='string'||input.length>1024*1024)throw new Error('JSON_SIZE');
  let i=0;const ws=()=>{while(/[\x20\t\r\n]/.test(input[i]??'!'))i++;};
  const string=()=>{const start=i++;while(i<input.length){if(input[i]==='\\'){i+=2;continue;}if(input[i++]==='"')return JSON.parse(input.slice(start,i));}throw new Error('JSON_STRING');};
  function value(depth=0){
    if(depth>40)throw new Error('JSON_DEPTH');ws();
    if(input[i]==='{'){
      i++;ws();const seen=new Set();if(input[i]==='}'){i++;return;}
      while(true){ws();if(input[i]!=='"')throw new Error('JSON_KEY');const k=string();if(seen.has(k)||['__proto__','constructor','prototype'].includes(k))throw new Error('JSON_DUPLICATE_OR_UNSAFE_KEY');seen.add(k);ws();if(input[i++]!==':')throw new Error('JSON_COLON');value(depth+1);ws();const c=input[i++];if(c==='}')return;if(c!==',')throw new Error('JSON_OBJECT');}
    }
    if(input[i]==='['){i++;ws();if(input[i]===']'){i++;return;}while(true){value(depth+1);ws();const c=input[i++];if(c===']')return;if(c!==',')throw new Error('JSON_ARRAY');}}
    if(input[i]==='"'){string();return;}
    const match=/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(input.slice(i));if(!match)throw new Error('JSON_VALUE');i+=match[0].length;
  }
  value();ws();if(i!==input.length)throw new Error('JSON_TRAILING');return JSON.parse(input);
}
