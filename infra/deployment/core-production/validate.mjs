import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(here,'../../..');
const source=readFileSync(path.join(here,'docker-compose.yml'),'utf8');
const requiredPattern=/\$\{([A-Z0-9_]+):\?[^}]+\}/g;
export const requiredVariables=[...new Set([...source.matchAll(requiredPattern)].map(m=>m[1]))].sort();
const need=(v,code)=>{if(!v)throw Error(code);};
const names=['postgres','redis','identity-service','billing-service','sunat-service','mailer-worker','realtime-service','web-pwa','kong','received-documents-service','received-sync-worker'];
export function validateKong(kong){
 need(kong._format_version==='3.0'&&kong.services?.length===7,'EXACT_NATIVE_KONG_CORE_SERVICES');
 const expected={
  'identity-service':'http://identity-service:3001','billing-service':'http://billing-service:3002','sunat-service':'http://sunat-service:3003',
  'mailer-worker':'http://mailer-worker:3004','received-documents-service':'http://received-documents-service:3006',
  'realtime-service':'http://realtime-service:3005','web-pwa':'http://web-pwa:3000',
 };
 const routes=[];
 for(const svc of kong.services){
  need(svc.url===expected[svc.name],'KONG_UPSTREAM_MUST_BE_REAL_CORE_HOST');
  for(const route of svc.routes){
   need(route.strip_path===false&&route.protocols.every(p=>['http','https'].includes(p)),'KONG_NO_PATH_REWRITE');
   need(route.paths?.length>0&&route.paths.every(p=>p==='/'||p.startsWith('~/')),'KONG_REGEX_PATH_PREFIX_REQUIRED');
   routes.push({svc:svc.name,...route});
  }
 }
 const target=(url,method='GET')=>{
  const match=routes.filter(r=>(!r.methods||r.methods.includes(method))&&r.paths.some(p=>p==='/'||p.startsWith('~')&&new RegExp('^'+p.slice(1)).test(url)))
   .sort((a,b)=>(b.regex_priority??0)-(a.regex_priority??0))[0];
  return match?.plugins?.some(p=>p.name==='request-termination')?'DENIED':match?.svc;
 };
 for(const [url,svc,method]of [
  ['/api/v1/auth/browser-session/login','identity-service','POST'],['/api/v1/users','identity-service','GET'],['/api/v1/roles','identity-service','GET'],
  ['/api/v1/documents/catalog/issuance','billing-service','GET'],['/api/v1/documents/1/production-notes','billing-service','POST'],
  ['/api/v1/stations/admin/catalog','billing-service','GET'],['/api/v1/stations/products','billing-service','POST'],
  ['/api/v1/stations/print-settings/1','billing-service','POST'],
  ['/api/v1/setup/sunat/1/PRODUCTION/readiness/validate','sunat-service','POST'],
  ['/api/v1/setup/sunat/1/PRODUCTION/dispatch','sunat-service','POST'],
  ['/api/v1/setup/sunat/1/PRODUCTION/notes/authorization','sunat-service','POST'],
  ['/api/v1/fiscal-artifacts/1/original/XML','sunat-service','GET'],['/api/v1/fiscal-evidence/1','sunat-service','GET'],
  ['/api/v1/mail-settings/1/document-activation','mailer-worker','POST'],['/api/v1/mail-settings/1/send-document','mailer-worker','POST'],
  ['/api/v1/received-documents','received-documents-service','GET'],['/socket.io/','realtime-service','GET'],['/login','web-pwa','GET'],
 ])need(target(url,method)===svc,'KONG_MISSING_REAL_ROUTE:'+url);
 for(const url of [
  '/b2b/oauth/token','/b2b/v1/me','/internal/b2b/introspect','/api/v1/b2b-admin/status',
  '/api/v1/setup/sunat/1/PRODUCTION/admission','/api/v1/setup/sunat/1/PRODUCTION/notes/admission',
  '/api/v1/setup/sunat/1/PRODUCTION/notes/original-evidence',
  '/api/v1/stations/client-intake','/api/v1/mail-qa/1','/api/v1/fiscal-circuit-qa/1','/api/v1/local-xml-validation/1','/api/v1/fiscal-batch-qa',
  '/api/v1/notes-qa/1','/api/v1/gre-qa','/api/v1/setup/company','/api/v1/products','/api/v1/customers','/api/v1/daily-summaries',
 ])for(const method of ['GET','POST'])need(target(url,method)==='DENIED','KONG_PRIVATE_LAB_OR_NONEXISTENT_ROUTE_EXPOSED:'+url);
 for(const url of ['/prefix/api/v1/documents','/prefix/internal/b2b/introspect','/prefix/b2b/oauth/token'])need(target(url)==='web-pwa','KONG_REGEX_MUST_BE_START_ANCHORED');
 for(const [file,text]of [
  ['services/billing-service/src/products.controller.ts',"api/v1/stations/products"],
  ['services/billing-service/src/print-settings.controller.ts',"api/v1/stations/print-settings"],
  ['services/billing-service/src/documents.controller.ts',"api/v1/documents"],
  ['services/billing-service/src/stations.controller.ts',"api/v1/stations"],
  ['services/sunat-service/src/production-dispatch.controller.ts',"api/v1/setup/sunat"],
  ['services/mailer-worker/src/corporate-document-controller.ts',"api/v1/mail-settings"],
 ])need(readFileSync(path.join(repo,file),'utf8').includes(text),'KONG_ROUTE_CONTROLLER_EVIDENCE_MISSING');
 return {kongRoutesChecked:routes.length,realRoutes:18,deniedPaths:18,externalNetwork:false};
}

export function validate(model,{resolved=false}={}){
 need(model&&Object.keys(model.services).length===11&&names.every(n=>model.services[n]),'EXACT_11_REAL_CORE_HOSTS_REQUIRED');
 let memory=0,cpus=0,ports=[];
 for(const [name,s]of Object.entries(model.services)){
  need(!s.build&&!s.profiles&&!s.privileged&&!s.network_mode,'NO_BUILD_PROFILES_PRIVILEGE_OR_HOST_NETWORK');
  need(s.restart==='unless-stopped'&&s.pull_policy==='never','RESTART_AND_LOCAL_APPROVED_IMAGES_REQUIRED');
  need(resolved?/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(s.image):/^\$\{CORE_[A-Z0-9_]+_IMAGE:\?[^}]+\}$/.test(s.image),'TI_IMMUTABLE_DIGEST_REQUIRED');
  need(Number.isSafeInteger(s.mem_limit)&&s.mem_limit>0&&s.memswap_limit===s.mem_limit,'EXPLICIT_BYTE_LIMIT_AND_NO_EXTRA_SWAP');
  memory+=s.mem_limit;cpus+=s.cpus;
  need(s.logging?.driver==='json-file'&&s.logging.options['max-size']==='10m'&&s.logging.options['max-file']==='3','BOUNDED_LOGS_REQUIRED');
  need(s.healthcheck?.test?.length>1&&!s.healthcheck.disable,'REAL_HEALTHCHECK_REQUIRED');
  if(name==='postgres')need(s.healthcheck.test[1]==='pg_isready'&&s.entrypoint.join(',')==='postgres'&&s.user==='postgres','PREINITIALIZED_POSTGRES_REQUIRED');
  else if(name==='redis')need(s.user==='1000:1000'&&s.command.includes('--aclfile')&&s.command.includes('noeviction')&&s.healthcheck.test.join(' ').includes('redis-cli'),'AUTHENTICATED_REDIS_REQUIRED');
  else if(name==='kong')need(s.healthcheck.test.join(' ')==='CMD kong health','KONG_NATIVE_HEALTH_REQUIRED');
  else need(s.healthcheck.test[1]==='node'&&s.healthcheck.test.join(' ').includes('fetch('),'NATIVE_NODE_FETCH_HEALTH_REQUIRED');
  ports.push(...(s.ports??[]).map(p=>({name,...p})));
  need(!s.expose,'UNNECESSARY_EXPOSE_NOT_REQUIRED');
  for(const v of s.volumes??[]){
   need(v.type==='bind'&&v.bind?.create_host_path===false,'EXPLICIT_NO_AUTO_MKDIR_BINDS_REQUIRED');
   need(!v.source.includes('/var/'),'HOST_DATA_OUTSIDE_VAR_REQUIRED');
   if(resolved&&v.source!=='./kong.yml')need(/^\/srv\/[a-zA-Z0-9/_.-]+$/.test(v.source)&&!v.source.includes('/../'),'EXISTING_SRV_ROOT_REQUIRED');
   if(v.source.includes('/config/'))need(v.read_only===true,'CONFIG_AND_PKI_READONLY_REQUIRED');
   need(!v.target.includes('docker.sock')&&!v.target.includes('docker-entrypoint-initdb.d'),'NO_DOCKER_SOCKET_OR_AUTO_INIT_SQL');
  }
  for(const [k,v]of Object.entries(s.environment??{})){
   if(/QA_ENABLED$|BETA_.*ENABLED$|B2B_.*ENABLED$|INTEGRATION_.*ENABLED$/.test(k)||['B2B_PRIVATE_ACCESS','BILLING_B2B_STANDALONE','RECEIVED_LOCAL_FIXTURE_ENABLED','RECEIVED_LIVE_READ_ALLOWED','SMTP_QA_USE_APP_KEY','RECEIVED_QA_USE_APP_KEY','LOCAL_XML_VALIDATION_ENABLED','GRE_EXTERNAL_TRANSMISSION_ENABLED'].includes(k))need(v==='false','QA_B2B_AND_UNAUTHORIZED_LIVE_DISABLED:'+k);
   need(!/RUC/.test(k)&&k!=='DATABASE_URL'&&!/^(POSTGRES_PASSWORD|SMTP_PASSWORD|SOL_PASSWORD)$/.test(k),'NO_RUC_PASSWORD_OR_DSN_IN_ENV');
  }
  for(const dep of Object.keys(s.depends_on??{}))need(Object.hasOwn(model.services,dep),'DEPENDENCY_MUST_EXIST');
 }
 need(memory<=8000000000&&memory===7700000000&&cpus<=10,'TOTAL_RESOURCE_BUDGET_EXCEEDED');
 need(ports.length===1&&ports[0].name==='kong'&&ports[0].host_ip==='127.0.0.1'&&ports[0].published==='9000'&&ports[0].target===8000,'ONLY_LOOPBACK_9000_PUBLISHED');
 need(model.networks['private-db'].internal===true&&model.networks.core.internal===true&&model.networks.edge.internal===true&&model.networks.egress.internal===false,'PRIVATE_DB_CORE_EDGE_AND_EXPLICIT_EGRESS_REQUIRED');
 for(const n of ['postgres','redis'])need(model.services[n].networks.join(',')==='private-db','DB_NO_PUBLIC_OR_EGRESS_NETWORK');
 need(model.services.kong.networks.join(',')==='edge,core'&&model.services['web-pwa'].networks.join(',')==='edge','EDGE_CANNOT_ATTACH_DB');
 for(const n of names)need(model.services[n].networks.includes('egress')===['sunat-service','mailer-worker'].includes(n),'EGRESS_ONLY_SUNAT_SMTP');
 for(const [svc,flag]of [['billing-service','BILLING_PRODUCTION_ISSUANCE_ENABLED'],['billing-service','BILLING_PRODUCTION_NOTES_ENABLED'],['sunat-service','SUNAT_PRODUCTION_WORKFLOW_ENABLED'],['sunat-service','SUNAT_PRODUCTION_NOTES_ENABLED'],['mailer-worker','SERVER_SMTP_ENABLED'],['mailer-worker','SERVER_SMTP_DOCUMENTS_ENABLED']])
  need(model.services[svc].environment[flag]==='true','EXPLICIT_INSTALLED_CONTROLLER_FLAG_REQUIRED:'+flag);
 const identity=model.services['identity-service'],adminUser=identity.environment.INITIAL_ADMIN_USERNAME,adminName=identity.environment.INITIAL_ADMIN_FULL_NAME;
 need(resolved?/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(adminUser):/^\$\{CORE_INITIAL_ADMIN_USERNAME:\?[^}]+\}$/.test(adminUser),'TI_INITIAL_HUMAN_USERNAME_REQUIRED');
 need(resolved?typeof adminName==='string'&&adminName.trim().length>0&&adminName.length<=160:/^\$\{CORE_INITIAL_ADMIN_FULL_NAME:\?[^}]+\}$/.test(adminName),'TI_INITIAL_HUMAN_FULL_NAME_REQUIRED');
 need(identity.environment.INITIAL_ADMIN_PASSWORD_FILE==='/run/secrets/initial_admin_password','TI_INITIAL_ADMIN_PASSWORD_FILE_REQUIRED');
 const initial=identity.secrets.find(x=>typeof x==='object'&&x.source==='initial_admin_password');
 need(initial?.target==='initial_admin_password'&&initial.mode===384&&model.secrets.initial_admin_password.file.endsWith('/secrets/initial_admin_password'),'TI_INITIAL_ADMIN_PASSWORD_SECRET_MODE_0600_REQUIRED');
 need(model.services.kong.volumes.some(v=>v.source==='./kong.yml'&&v.target==='/run/factuez/kong.yml'&&v.read_only&&v.bind.create_host_path===false),'INCLUDED_REAL_KONG_DECLARATIVE_REQUIRED');
 validateKong(JSON.parse(readFileSync(path.join(here,'kong.yml'),'utf8')));
 for(const n of ['billing-service','sunat-service']){
  need(model.services[n].environment.PRODUCTION_NOTES_OWNER_KEY_FILE==='/run/secrets/production_notes_owner_key','SHARED_ABSOLUTE_NOTES_OWNER_KEY_REQUIRED');
  const key=model.services[n].secrets.find(x=>typeof x==='object'&&x.source==='production_notes_owner_key');
  need(key?.target==='production_notes_owner_key'&&key.mode===384,'OWNER_KEY_SECRET_MODE_0600_REQUIRED');
 }
 need(model.secrets.production_notes_owner_key.file.endsWith('/secrets/production_notes_owner_key')&&
  model.secrets.production_notes_owner_key.file!==model.secrets.smtp_settings_key.file,'NOTES_AND_SMTP_KEYS_MUST_BE_DEDICATED');
 const sunat=model.services['sunat-service'];
 need(sunat.volumes.filter(v=>v.source.includes('/config/pki/')).length===3,'EXPLICIT_PINNED_PUBLIC_PKI_FILES');
 need(sunat.volumes.some(v=>v.target==='/workspace/services/sunat-service/assets/sunat/xsd-20220228.zip'&&v.read_only),'ACTUAL_XSD_ARCHIVE_PATH_REQUIRED');
 for(const n of ['identity-service','billing-service','sunat-service','mailer-worker','realtime-service','received-documents-service']){
  need(model.services[n].command.join(' ')==='node services/'+n+'/dist/main.js','ACTUAL_NATIVE_MAIN_REQUIRED');
  const entry=readFileSync(path.join(repo,'services',n,'src/main.ts'),'utf8');need(entry.includes('bootstrap')||entry.includes('main('),'ENTRYPOINT_SOURCE_REQUIRED');
 }
 need(model.services['received-sync-worker'].command.at(-1)==='services/received-documents-service/dist/automation.worker.js','ACTUAL_RECEIVED_WORKER_REQUIRED');
 need(readFileSync(path.join(repo,'services/received-documents-service/src/automation.worker.ts'),'utf8').includes("health.listen(3007"),'WORKER_HEALTH_PORT_MUST_EXIST');
 for(const n of ['identity-service','billing-service','sunat-service'])
  need(readFileSync(path.join(repo,'services',n,'src/health.controller.ts'),'utf8').includes("Controller('health')"),'HEALTH_PATH_MUST_EXIST');
 for(const n of ['mailer-worker','realtime-service'])
  need(readFileSync(path.join(repo,'services',n,'src/main.ts'),'utf8').includes("Controller('health')"),'HEALTH_PATH_MUST_EXIST');
 need(readFileSync(path.join(repo,'services/received-documents-service/src/app.module.ts'),'utf8').includes("Controller('health')"),'RECEIVED_DB_HEALTH_MUST_EXIST');
 for(const [name,secret]of Object.entries(model.secrets)){
  need(secret.file.endsWith('/secrets/'+name),'EXPLICIT_NAMED_SECRET_FILE_REQUIRED');
  if(resolved)need(secret.file.startsWith('/srv/'),'SECRET_ROOT_MUST_BE_SRV');
 }
 return {valid:true,services:11,memoryBytes:memory,cpuLimit:cpus,published:'127.0.0.1:9000',containersStarted:false,networkUsed:false,databaseUsed:false,
  readiness:'Not probed; empty fresh grants and authenticated readiness are prerequisites',images:resolved?'DIGEST_SYNTAX_VALIDATED_TI_APPROVAL_NOT_PROVEN':'TI_APPROVED_DIGEST_VARIABLES_REQUIRED'};
}
export function resolvePublicVariables(vars){
 need(vars&&typeof vars==='object'&&!Array.isArray(vars),'PUBLIC_VARIABLE_MAP_REQUIRED');
 for(const n of requiredVariables)need(typeof vars[n]==='string'&&vars[n].length>0&&!/[\r\n\x00]/.test(vars[n]),'MISSING_OR_INVALID_PUBLIC_VAR:'+n);
 need(/^\/srv\/[a-zA-Z0-9/_-]+$/.test(vars.CORE_ROOT)&&!vars.CORE_ROOT.includes('/../'),'NEW_EXISTING_SRV_ROOT_REQUIRED');
 const u=new URL(vars.CORE_HTTPS_ORIGIN);need(u.protocol==='https:'&&u.origin===vars.CORE_HTTPS_ORIGIN&&!u.username&&!u.password,'CANONICAL_HTTPS_BROWSER_ORIGIN_REQUIRED');
 for(const n of requiredVariables.filter(n=>n.endsWith('_SHA256')))need(/^[a-f0-9]{64}$/.test(vars[n]),'PUBLIC_SHA256_INVALID:'+n);
 const wsdl=new URL(vars.CORE_SUNAT_PRODUCTION_WSDL);need(wsdl.protocol==='https:'&&/(^|\.)sunat\.gob\.pe$/.test(wsdl.hostname)&&!wsdl.username&&!wsdl.password,'TI_OFFICIAL_SUNAT_HTTPS_ENDPOINT_REQUIRED');
 need(/^[a-z][a-z0-9_]{0,62}$/.test(vars.CORE_PG_ADMIN_USER),'PG_ADMIN_IDENTIFIER_REQUIRED');
 need(/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(vars.CORE_INITIAL_ADMIN_USERNAME)&&vars.CORE_INITIAL_ADMIN_FULL_NAME.trim().length>0&&vars.CORE_INITIAL_ADMIN_FULL_NAME.length<=160,'EXPLICIT_TI_HUMAN_IDENTITY_REQUIRED');
 need(vars.CORE_SMTP_APPROVED_HOSTS.split(',').every(h=>/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(h)&&h.includes('.')),'EXPLICIT_SMTP_DNS_ALLOWLIST_REQUIRED');
 return JSON.parse(source.replace(requiredPattern,(_all,n)=>JSON.stringify(vars[n]).slice(1,-1)));
}
function selfTest(){
 const model=JSON.parse(source);validate(model);
 for(const mutate of [
  m=>m.services.postgres.ports=[{target:5432,published:'9001',host_ip:'127.0.0.1'}],
  m=>m.services.kong.ports[0].host_ip='0.0.0.0',m=>m.services.redis.mem_limit=8000000001,
  m=>m.services['sunat-service'].environment.SUNAT_PRODUCTION_WORKFLOW_ENABLED='false',
  m=>m.services['sunat-service'].volumes[2].read_only=false,m=>m.services.postgres.networks.push('egress'),
  m=>m.services['identity-service'].environment.INITIAL_ADMIN_USERNAME='',
  m=>m.services['billing-service'].profiles=['production'],m=>m.services['mailer-worker'].environment.SERVER_SMTP_DOCUMENTS_ENABLED='false',
  m=>m.services['billing-service'].environment.CLIENT_INTAKE_QA_ENABLED='true',m=>m.services['web-pwa'].image='node:latest',
  m=>delete m.services['sunat-service'].environment.PRODUCTION_NOTES_OWNER_KEY_FILE,
 ]){const m=JSON.parse(source);mutate(m);assert.throws(()=>validate(m));}
 const fixture=Object.fromEntries(requiredVariables.map(n=>[n,n.endsWith('_IMAGE')?'fixture.invalid/core@sha256:'+'a'.repeat(64):
  n.endsWith('_SHA256')?'b'.repeat(64):n==='CORE_ROOT'?'/srv/fixture-core-never-started':n==='CORE_HTTPS_ORIGIN'?'https://fixture.invalid':
   n==='CORE_INITIAL_ADMIN_USERNAME'?'ti-human-fixture-only':n==='CORE_INITIAL_ADMIN_FULL_NAME'?'TI Human Fixture Only':n==='CORE_PG_ADMIN_USER'?'review_admin':n==='CORE_SMTP_APPROVED_HOSTS'?'smtp.fixture.invalid':'https://e-factura.sunat.gob.pe/ol-ti-itcpfegem/billService?wsdl']));
 validate(resolvePublicVariables(fixture),{resolved:true});
 assert.throws(()=>resolvePublicVariables({...fixture,CORE_ROOT:'/var/lib/core'}));
 assert.throws(()=>resolvePublicVariables({...fixture,CORE_HTTPS_ORIGIN:'http://fixture.invalid'}));
 assert.throws(()=>validate(resolvePublicVariables({...fixture,CORE_KONG_IMAGE:'kong:latest'}),{resolved:true}));
 const badKong=JSON.parse(readFileSync(path.join(here,'kong.yml'),'utf8'));badKong.services.find(s=>s.name==='billing-service').routes[0].paths.push('~/api/v1/products(?:/|$)');assert.throws(()=>validateKong(badKong));
 const invalidPrefix=JSON.parse(readFileSync(path.join(here,'kong.yml'),'utf8'));invalidPrefix.services[0].routes[0].paths=['~^/api/v1/auth'];assert.throws(()=>validateKong(invalidPrefix),/KONG_REGEX_PATH_PREFIX_REQUIRED/);
 return {selfTestsPassed:18,kong:validateKong(JSON.parse(readFileSync(path.join(here,'kong.yml'),'utf8'))),externalNetwork:false,containers:false,fixtureImages:'TEST_ONLY_NOT_APPROVED_NOT_EXECUTED'};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const args=process.argv.slice(2);
  if(args.length===1&&args[0]==='--test')console.log(JSON.stringify(selfTest()));
  else if(args.length===2&&args[0]==='--variables'){
   const st=JSON.parse(readFileSync(path.resolve(args[1]),'utf8'));console.log(JSON.stringify(validate(resolvePublicVariables(st),{resolved:true})));
  }else if(!args.length)console.log(JSON.stringify({...validate(JSON.parse(source)),requiredPublicVariables:requiredVariables}));
  else throw Error('USAGE_node_validate.mjs_[--test|--variables_PUBLIC_JSON]');
 }catch(e){console.error(JSON.stringify({valid:false,code:e.message}));process.exitCode=1;}
}
