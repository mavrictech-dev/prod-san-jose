// Writes only review artifacts beside this file. No Docker/daemon/network calls.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export const inventory = [
  ['postgres',768,1,null,'postgres: upstream entrypoint; initialization/roles need TI plan'],
  ['redis',256,.5,null,'redis-server: upstream; password file and ACL need TI plan'],
  ['kong',256,.5,null,'kong: upstream; reviewed declarative configuration required'],
  ['web-pwa',512,.75,null,'apps/web-pwa: Next runtime/image contract pending'],
  ['identity-service',384,.5,null,'services/identity-service/src/main.ts: legacy main; B2B owners not assembled'],
  ['billing-service',512,.75,null,'services/billing-service/src/main.ts: legacy main; B2B owners not assembled'],
  ['sunat-service',768,1,null,'services/sunat-service/src/main.ts: legacy main; B2B owners not assembled'],
  ['mailer-worker',320,.5,null,'services/mailer-worker/src/main.ts: legacy main; corporate B2B owner not assembled'],
  ['received-documents-service',512,.5,null,'services/received-documents-service/src/main.ts: legacy main; B2B owners not assembled'],
  ['received-sync-worker',320,.25,null,'services/received-documents-service/src/automation.worker.ts: legacy worker; B2B LOCAL/READ_ONLY composition pending'],
  ['realtime-service',192,.25,null,'services/realtime-service/src/main.ts: existing main; approved origin needed'],
  ['history-service',320,.25,'b2b','FACTORY_ONLY: services/history-service/src/b2b/http.ts; no main'],
  ['b2b-api-service',320,.5,'b2b','MAIN_SOURCE_UNVERIFIED: src/main.ts bootstrapB2bApi is opt-in, requires PAUSED policy and eight-owner readiness; runtime-assembly.ts builds HTTP graph; owner bootstraps/image/VPS unverified'],
  ['webhook-service',256,.25,'b2b','FACTORY_ONLY: createWebhookApplication/WebhookWorker; no main'],
  ['integration-export-service',320,.25,'b2b','services/integration-export-service/src/main.ts: BETA DB guard, mTLS and container-loopback listener; B2B composition pending'],
  ['integration-service',192,.25,'b2b','services/integration-service/src/main.ts: gated mTLS container-loopback listener; B2B composition pending'],
  ['operations',128,.1,'operations','METADATA_ONLY: B2bDeploymentMaintenance/B2bMaintenanceNode and B2bOperationalControl are libraries; no composed operator daemon/image'],
  ['backup-tools',256,.1,'backup','METADATA_ONLY: recovery-bundle.mjs is SYNTHETIC/BETA only; no full backup runtime/image'],
];
const root='/srv/factuez-vps';
const bind=(source,target,read_only=false)=>({type:'bind',source,target,read_only,bind:{create_host_path:false}});
const secretNames=['postgres_admin_password','redis_password','identity_db_password','billing_db_password','sunat_db_password','mailer_db_password','received_db_password','jwt_private_key','jwt_public_key','internal_service_token','initial_admin_password','app_master_key','reception_settings_key'];
const refs={
  postgres:['postgres_admin_password'],redis:['redis_password'],
  'identity-service':['identity_db_password','redis_password','jwt_private_key','jwt_public_key','internal_service_token','initial_admin_password'],
  'billing-service':['billing_db_password','redis_password','jwt_public_key','internal_service_token'],
  'sunat-service':['sunat_db_password','redis_password','jwt_public_key','internal_service_token','app_master_key'],
  'mailer-worker':['mailer_db_password','redis_password','jwt_public_key','internal_service_token','app_master_key'],
  'received-documents-service':['received_db_password','redis_password','reception_settings_key'],
  'received-sync-worker':['received_db_password','redis_password','reception_settings_key'],
  'realtime-service':['redis_password','jwt_public_key'],
};
const ports={'web-pwa':3000,'identity-service':3001,'billing-service':3002,'sunat-service':3003,'mailer-worker':3004,'received-documents-service':3006,'realtime-service':3006};
const services=Object.fromEntries(inventory.map(([name,mib,cpus,profile,source])=>{
  const imageVar='B2B_'+name.toUpperCase().replaceAll('-','_')+'_IMAGE';
  const s={
    image:'${'+imageVar+':?TI must supply immutable repository@sha256 digest}',
    platform:'linux/amd64',pull_policy:'never',restart:'unless-stopped',
    mem_limit:mib*1048576,memswap_limit:mib*1048576,cpus,pids_limit:160,
    logging:{driver:'json-file',options:{'max-size':'10m','max-file':'3'}},
    networks:['factuez-vps'],security_opt:['no-new-privileges:true'],
    entrypoint:['/bin/sh','/review/review-blocked.sh'],command:[],
    healthcheck:{disable:true},
    volumes:[bind(root+'/config/review-blocked.sh','/review/review-blocked.sh',true)],
    environment:{NODE_ENV:'production',TZ:'America/Lima',B2B_REVIEW_ONLY:'true',
      B2B_TI_REVIEW_REFERENCE:'${B2B_TI_REVIEW_REFERENCE:?BLOCKED pending TI review}'},
    'x-runtime':{status:'BLOCKED',source,executableVerified:false,proposedCommand:null,
      reason:'Review artifact: entrypoint always refuses startup; configuration is not production composition'},
  };
  if(profile)s.profiles=[profile];
  if(refs[name])s.secrets=refs[name];
  if(ports[name])s.environment.PORT=String(ports[name]);
  if(name==='postgres'){
    Object.assign(s.environment,{POSTGRES_DB:'postgres',POSTGRES_USER:'${B2B_PG_ADMIN_USER:?TI must choose dedicated administrator}',POSTGRES_PASSWORD_FILE:'/run/secrets/postgres_admin_password'});
    s.volumes.push(bind(root+'/data/postgres','/var/lib/postgresql/data'));
    s['x-runtime'].reason+='; select PostgreSQL 17 amd64 digest and review PGDATA contract; no automatic init SQL';
  }
  if(name==='redis')s.volumes.push(bind(root+'/data/redis','/data'));
  if(name==='kong'){
    s.ports=[{target:8000,published:'9000',host_ip:'127.0.0.1',protocol:'tcp'}];
    Object.assign(s.environment,{KONG_DATABASE:'off',KONG_ADMIN_LISTEN:'off',KONG_STATUS_LISTEN:'off',KONG_PROXY_LISTEN:'0.0.0.0:8000',KONG_DECLARATIVE_CONFIG:'/kong/review/kong.review.json',KONG_NGINX_WORKER_PROCESSES:'1',KONG_PROXY_ACCESS_LOG:'/dev/stdout',KONG_PROXY_ERROR_LOG:'/dev/stderr'});
    s.volumes.push(bind(root+'/config/kong.review.json','/kong/review/kong.review.json',true));
  }
  const owner=name==='received-sync-worker'?'received':name==='received-documents-service'?'received':name==='mailer-worker'?'mailer':name.replace('-service','');
  if(['identity','billing','sunat','mailer','received'].includes(owner)){
    Object.assign(s.environment,{DB_HOST:'postgres',DB_PORT:'5432',DB_NAME:'${B2B_'+owner.toUpperCase()+'_DB_NAME:?TI dedicated owner database}',DB_USER:'${B2B_'+owner.toUpperCase()+'_DB_USER:?TI dedicated least-privilege owner role}',DB_PASSWORD_FILE:'/run/secrets/'+owner+'_db_password',REDIS_HOST:'redis',REDIS_PORT:'6379',REDIS_PASSWORD_FILE:'/run/secrets/redis_password'});
    s.depends_on={postgres:{condition:'service_started'},redis:{condition:'service_started'}};
  }
  if(name==='billing-service')s.volumes.push(bind(root+'/data/print-branding','/data/print-branding'));
  if(name==='sunat-service'){
    s.volumes.push(bind(root+'/data/artifacts','/data/artifacts'),bind(root+'/data/private','/data/private'));
    Object.assign(s.environment,{ARTIFACTS_ROOT:'/data/artifacts',PRIVATE_STORAGE_ROOT:'/data/private',APP_MASTER_KEY_FILE:'/run/secrets/app_master_key',INTERNAL_SERVICE_TOKEN_FILE:'/run/secrets/internal_service_token'});
  }
  if(name==='mailer-worker')Object.assign(s.environment,{APP_MASTER_KEY_FILE:'/run/secrets/app_master_key',INTERNAL_SERVICE_TOKEN_FILE:'/run/secrets/internal_service_token'});
  if(name.startsWith('received-'))Object.assign(s.environment,{RECEIVED_LOCAL_FIXTURE_ENABLED:'false',RECEIVED_QA_USE_APP_KEY:'false',RECEIVED_LIVE_READ_ALLOWED:'false',RECEIVED_SETTINGS_KEY_FILE:'/run/secrets/reception_settings_key'});
  if(name==='realtime-service')s.environment.WS_ALLOWED_ORIGINS='${B2B_HTTPS_ORIGIN:?TI approved HTTPS subdomain}';
  if(name==='b2b-api-service')s.environment.B2B_API_ENABLED='false';
  if(name==='operations')s.volumes.push(bind(root+'/config/b2b-operations.json','/review/b2b-operations.json',true));
  if(name==='backup-tools')s.volumes.push(bind(root+'/backups','/review/backups'));
  return [name,s];
}));
const model={name:'factuez-b2b-vps-review',
  'x-review':{status:'BLOCKED',activationAllowed:false,host:'Ubuntu 24.04 amd64; shared 10 CPU / 31 GB',memoryBudgetBytes:8000000000,reportingService:'ABSENT; no image, route, dependency or migration invented',migrations:'NOT_EXECUTED; candidate SQL is not a deployment migration',runtime:'INCOMPLETE_OWNER_COMPOSITION'},
  services,networks:{'factuez-vps':{driver:'bridge'}},
  secrets:Object.fromEntries(secretNames.map(n=>[n,{file:root+'/secrets/'+n}]))};
const save=(name,obj)=>writeFileSync(new URL(name,import.meta.url),JSON.stringify(obj,null,2)+'\n');
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  save('docker-compose.yml',model);
  save('postgres-loopback.override.yml',{services:{postgres:{ports:[{target:5432,published:'9001',host_ip:'127.0.0.1',protocol:'tcp'}]}}});
  save('runtime-inventory.review.json',{
    status:'BLOCKED',activationAllowed:false,
    coordinatorSource:'packages/service-access/src/b2b-deployment-maintenance.ts',
    nodeSource:'packages/service-access/src/b2b-maintenance-node.ts',
    facadeSource:'services/b2b-api-service/src/runtime-assembly.ts',
    facadeBootstrapSource:'services/b2b-api-service/src/main.ts',
    phases:['ADMISSION','PRODUCERS','WORKERS','STORAGE'],
    managedServices:{KONG:'kong',WEB_PWA:'web-pwa',B2B_API:'b2b-api-service',INTEGRATION_API:'integration-service',RECEIVED_SYNC:'received-sync-worker',WEBHOOKS:'webhook-service',SUNAT:'sunat-service',MAILER:'mailer-worker',BILLING:'billing-service',IDENTITY:'identity-service',RECEIVED:'received-documents-service',HISTORY:'history-service',REALTIME:'realtime-service',EXPORTS:'integration-export-service'},
    infrastructureOnly:['postgres','redis'],metadataOnly:['operations','backup-tools'],
    facadeOwners:['identity','billing','fiscal','webhooks','received','history','exports','mailer'],
    operatorIngress:'SEPARATE_HTTPS_MTLS_DISABLED_NO_KONG_ROUTE_NO_HOST_PORT',
    pending:['owner bootstraps and real storage readiness','instanceId/bootId inventory across all services','real four-phase hooks across all services','offline writer verifier','operator PKI and peers','full backup implementation'],
  });
  const route=(name,port,paths)=>({name,url:'http://'+name+':'+port,routes:[{name:name+'-review',paths,strip_path:false,protocols:['http']}]});
  save('kong.review.json',{_format_version:'3.0',_transform:true,services:[
    route('identity-service',3001,['/api/v1/auth','/api/v1/users','/api/v1/roles']),
    route('billing-service',3002,['/api/v1/setup/company','/api/v1/emission-points','/api/v1/shifts','/api/v1/products','/api/v1/customers','/api/v1/documents','/api/v1/stations','/api/v1/daily-summaries']),
    route('sunat-service',3003,['/api/v1/setup/certificate','/api/v1/setup/sunat','/api/v1/fiscal-artifacts','/api/v1/local-xml-validation','/api/v1/fiscal-rules']),
    route('received-documents-service',3006,['/api/v1/received-documents']),
    route('realtime-service',3006,['/socket.io']),route('web-pwa',3000,['/']),
  ],plugins:[{name:'request-size-limiting',config:{allowed_payload_size:18,size_unit:'megabytes'}}]});
}
export { model };
