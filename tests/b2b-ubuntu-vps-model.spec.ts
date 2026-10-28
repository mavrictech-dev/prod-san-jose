import { describe,it,expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { model as generated } from '../infra/b2b/ubuntu-vps/generate-review.mjs';
import { validateModel,withPostgresOverride,parseStrictJson,immutableImage,MEMORY_BUDGET } from '../infra/b2b/ubuntu-vps/model.mjs';
const read=(n:string)=>parseStrictJson(readFileSync(new URL('../infra/b2b/ubuntu-vps/'+n,import.meta.url),'utf8'));
const draft=()=>read('docker-compose.yml');
const override=()=>read('postgres-loopback.override.yml');
const reject=(change:(m:any)=>void,code?:string)=>{const m=draft();change(m);const r=validateModel(m);expect(r.valid).toBe(false);expect(r.activationAllowed).toBe(false);if(code)expect(r.errors.map((e:any)=>e.code)).toContain(code);};
describe('B2B Ubuntu VPS complete review model, all profiles counted',()=>{
  it('checked-in JSON/YAML equals generator and budgets every service',()=>{
    const m=draft(),r=validateModel(m);expect(m).toEqual(generated);expect(r.errors).toEqual([]);expect(Object.keys(m.services)).toHaveLength(18);
    expect(r.memoryBytes).toBe(6_912_212_992);expect(r.memoryBytes).toBeLessThanOrEqual(MEMORY_BUDGET);expect(r.cpus).toBe(8.2);expect(r.activationAllowed).toBe(false);
    expect(m.services).not.toHaveProperty('reporting-service');expect(m.services.postgres).not.toHaveProperty('ports');
  });
  it('default profile cannot conceal overbudget optional services',()=>reject(m=>m.services['backup-tools'].mem_limit=m.services['backup-tools'].memswap_limit=2_000_000_000,'ALL_PROFILES_MEMORY_BUDGET'));
  it('accepts exactly the decimal cap, rejects one byte more',()=>{
    const m=draft(),delta=MEMORY_BUDGET-validateModel(m).memoryBytes;m.services.postgres.mem_limit+=delta;m.services.postgres.memswap_limit+=delta;
    expect(validateModel(m).valid).toBe(true);m.services.postgres.mem_limit++;m.services.postgres.memswap_limit++;expect(validateModel(m).valid).toBe(false);
  });
  it.each(['8g','8GB',-1,0,NaN,Infinity,undefined])('rejects ambiguous/invalid memory %s',v=>reject(m=>m.services.postgres.mem_limit=v,'MEMORY_LIMIT'));
  it.each([-1,0,'.5',3,NaN,Infinity])('rejects CPU %s',v=>reject(m=>m.services.postgres.cpus=v,'CPU_LIMIT'));
  it('rejects total CPU exceeding shared-host reserve',()=>reject(m=>{m.services.postgres.cpus=2;m.services.redis.cpus=2;},'ALL_PROFILES_CPU_BUDGET'));
  it.each(['restart','logging','memswap_limit','pids_limit','platform','pull_policy'])('requires %s even on backup profile',k=>reject(m=>delete m.services['backup-tools'][k]));
  it('rejects unlimited swap and expanded log retention',()=>{
    reject(m=>m.services.postgres.memswap_limit=-1,'SWAP_LIMIT');reject(m=>m.services.kong.logging.options['max-file']='30','LOGGING_POLICY');
  });
  it.each(['build','extends','deploy','scale','network_mode','privileged','volumes_from','devices','env_file','tmpfs','post_start','provider','cap_add','pid','use_api_socket','develop','container_name'])('rejects alternate resource/startup path %s',key=>reject(m=>m.services.postgres[key]=key==='scale'?2:{},'SERVICE_UNSUPPORTED'));
  it.each(['volumes','include','configs'])('rejects top-level bypass %s',key=>reject(m=>m[key]={},'TOP_LEVEL_UNSUPPORTED'));
  it.each([80,443,5432,8000,8081,8443,8091,8999,9100])('rejects host port %i',p=>reject(m=>m.services.kong.ports[0].published=String(p),'PORT_POLICY'));
  it.each(['0.0.0.0','::','localhost',undefined])('requires numeric IPv4 loopback %s',ip=>reject(m=>m.services.kong.ports[0].host_ip=ip,'PORT_POLICY'));
  it('rejects short ports, ranges, UDP, duplicated published ports and extra ingress',()=>{
    reject(m=>m.services.kong.ports=['9000:8000']);reject(m=>m.services.kong.ports[0].published='9000-9002');reject(m=>m.services.kong.ports[0].protocol='udp');
    reject(m=>m.services.kong.ports.push({...m.services.kong.ports[0]}),'PORT_COLLISION');reject(m=>m.services['b2b-api-service'].ports=[{host_ip:'127.0.0.1',published:'9002',target:3008,protocol:'tcp'}],'PORT_POLICY');
  });
  it('permits only the explicit PostgreSQL loopback override',()=>{
    const m=withPostgresOverride(draft(),override());expect(validateModel(m).valid).toBe(true);expect(m.services.postgres.ports[0]).toEqual({host_ip:'127.0.0.1',published:'9001',target:5432,protocol:'tcp'});
    for(const edit of [(o:any)=>o.services.postgres.ports[0].host_ip='0.0.0.0',(o:any)=>o.services.postgres.mem_limit=1,(o:any)=>o.services.redis={}]){const o=override();edit(o);expect(()=>withPostgresOverride(draft(),o)).toThrow();}
    expect(()=>withPostgresOverride(m,override())).toThrow();
  });
  it.each(['/var/lib/postgresql','/srv/../var/lib/data','relative/data','postgres_data','/srv/factuez-vps//data','/srv/factuez-vps/./data','${DATA_ROOT}/postgres','C:\\data','/various/data'])('rejects unapproved/noncanonical bind %s',source=>reject(m=>m.services.postgres.volumes[1].source=source,'BIND_POLICY'));
  it('requires bind type and prevents host directory creation',()=>{
    reject(m=>m.services.postgres.volumes[1].type='volume','BIND_POLICY');reject(m=>m.services.postgres.volumes[1].bind.create_host_path=true,'BIND_POLICY');reject(m=>m.services.postgres.volumes=['data:/data']);
  });
  it('rejects conflicting/overlapping targets and shared writable stores',()=>{
    reject(m=>m.services.postgres.volumes.push({...m.services.postgres.volumes[1]}),'BIND_CONTRADICTION');
    reject(m=>m.services.postgres.volumes.push({...m.services.postgres.volumes[1],target:'/var/lib/postgresql/data/other'}),'BIND_CONTRADICTION');
    reject(m=>m.services.redis.volumes[1].source=m.services.postgres.volumes[1].source,'WRITABLE_SOURCE_COLLISION');
    reject(m=>m.services.postgres.volumes[1].target='/run/docker.sock','BIND_TARGET');
  });
  it('rejects silently removed stores, secret mounts and owner config',()=>{
    reject(m=>m.services.postgres.volumes.pop(),'BIND_INVENTORY');
    reject(m=>m.services.postgres.volumes[1].source='/srv/factuez-vps/secrets/postgres_admin_password','BIND_INVENTORY');
    reject(m=>delete m.services['identity-service'].environment.DB_PASSWORD_FILE,'ENVIRONMENT_INVENTORY');
    reject(m=>m.services.postgres.secrets=[],'SERVICE_SECRET_INVENTORY');
    reject(m=>delete m.secrets.postgres_admin_password,'SECRET_INVENTORY');
  });
  it('requires permanent startup gate and explicit unverified runtime metadata',()=>{
    reject(m=>m.services.postgres.entrypoint=['postgres'],'STARTUP_GATE');reject(m=>m.services['b2b-api-service']['x-runtime'].executableVerified=true,'RUNTIME_METADATA');
    reject(m=>m.services['backup-tools']['x-runtime'].proposedCommand=['node','recovery-bundle.mjs'],'RUNTIME_METADATA');reject(m=>m['x-review'].activationAllowed=true,'REVIEW_GATE');
  });
  it('protects read-only review script/config and profile/dependency invariants',()=>{
    reject(m=>m.services.postgres.volumes[0].read_only=false,'CONFIG_WRITABLE');reject(m=>m.services.operations.profiles=['other'],'PROFILE_POLICY');
    reject(m=>m.services.kong.depends_on={'reporting-service':{condition:'service_started'}},'DEPENDENCY_POLICY');
    reject(m=>m.services.kong.depends_on={'b2b-api-service':{condition:'service_started'}},'DEPENDENCY_POLICY');
  });
  it('rejects fabricated reporting service, inline credentials and mock flags',()=>{
    reject(m=>m.services['reporting-service']=structuredClone(m.services['billing-service']),'SERVICE_INVENTORY');
    reject(m=>m.services.postgres.environment.POSTGRES_PASSWORD='synthetic-but-inline','INLINE_CREDENTIAL_OR_IDENTITY');
    reject(m=>m.services['received-sync-worker'].environment.RECEIVED_LOCAL_FIXTURE_ENABLED='true','UNSAFE_RUNTIME_FLAG');
    reject(m=>m.services['b2b-api-service'].environment.B2B_API_ENABLED='true','UNSAFE_RUNTIME_FLAG');
    reject(m=>m.services.postgres.environment.POSTGRES_PASSWORD_FILE='/run/secrets/unknown','SECRET_REFERENCE');
    reject(m=>m.services.postgres.environment.B2B_TI_REVIEW_REFERENCE='approved','TI_CONFIGURATION');
  });
  it('requires real image digests in resolved mode, permits only required symbolic refs in review',()=>{
    expect(validateModel(draft(),{resolvedImages:true}).errors.filter((e:any)=>e.code==='IMMUTABLE_IMAGE_REQUIRED')).toHaveLength(18);
    for(const image of ['postgres:17','registry.invalid/app:latest','app@sha256:'+'0'.repeat(64),'${IMAGE:-local}','${B2B_REDIS_IMAGE:?wrong service}'])reject(m=>m.services.postgres.image=image,'IMMUTABLE_IMAGE_REQUIRED');
    expect(immutableImage('registry.example.invalid/review/app@sha256:'+'ab'.repeat(32))).toBe(true);
  });
  it.each([null,[],{services:null},{services:{postgres:null}},{services:{postgres:{volumes:[null]}}}])('malformed input stays blocked %s',m=>expect(validateModel(m).valid).toBe(false));
  it.each(['{"a":1,"a":2}','{"a":1,"\\u0061":2}','{"x":{"mem_limit":1,"mem_limit":2}}','{"__proto__":{}}','{} trailing','{"a":NaN}'])('rejects contradictory JSON %s',s=>expect(()=>parseStrictJson(s)).toThrow());
  it('accepts normal strict JSON',()=>expect(parseStrictJson('{"a":[true,false,null,-1.2e3,"x\\\"y"]}')).toEqual({a:[true,false,null,-1200,'x"y']}));
});
