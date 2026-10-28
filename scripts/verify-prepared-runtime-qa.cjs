// Local deployment verification; no credentials, document contents or outbound sends.
'use strict';
const {spawnSync}=require('node:child_process');
const crypto=require('node:crypto');
const services=['identity-service','billing-service','sunat-service','mailer-worker','web-pwa'];
function docker(args){const r=spawnSync('docker',['--context','desktop-linux',...args],{encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:2*1024*1024});if(r.error||r.status!==0)throw Error('QA_METADATA_CHECK_FAILED');return r.stdout.trim();}
async function main(){
 const endpoint=docker(['context','inspect','desktop-linux','--format','{{.Endpoints.docker.Host}}']);if(!endpoint.startsWith('npipe:')||!endpoint.toLowerCase().includes('dockerdesktoplinuxengine'))throw Error('LOCAL_QA_ONLY');
 const containers=[];
 const flags=['FACTUEZ_DEMO_SEED','BILLING_PRODUCTION_ISSUANCE_ENABLED','SUNAT_PRODUCTION_WORKFLOW_ENABLED','SUNAT_BETA_TRANSMISSION_ENABLED','SUNAT_BETA_WORKFLOW_ENABLED','SERVER_SMTP_ENABLED','SMTP_CONNECTION_DIAGNOSTICS_ENABLED','B2B_ONPREM_ADMIN_ENABLED','MAILER_DATABASE_NAME','BILLING_PRODUCTION_NOTES_ENABLED','SUNAT_PRODUCTION_NOTES_ENABLED','SERVER_SMTP_DOCUMENTS_ENABLED'];
 for(const service of services){
  const c=JSON.parse(docker(['inspect','factuez-stage2-qa-'+service+'-1','--format','{{json .}}']));
  if(c.Config.Labels['com.docker.compose.project']!=='factuez-stage2-qa'||c.Config.Labels['com.docker.compose.service']!==service)throw Error('QA_OWNER_MISMATCH');
  const environment=Object.fromEntries(c.Config.Env.map(v=>{const i=v.indexOf('=');return[v.slice(0,i),v.slice(i+1)];}).filter(([k])=>flags.includes(k)));
  if(Object.entries(environment).some(([k,v])=>k!=='MAILER_DATABASE_NAME'&&v!=='false'))throw Error('QA_FLAG_CHANGED');
  if(c.State.Status!=='running'||(c.State.Health&&c.State.Health.Status!=='healthy'))throw Error('SERVICE_NOT_HEALTHY');
  containers.push({service,image:c.Config.Image,imageId:c.Image,status:c.State.Status,health:c.State.Health?.Status??'not-configured',flags:environment});
 }
 const uuid=crypto.randomUUID(),checks=[
 ['GET','/login',200],['GET','/integrations',200],['GET','/api-reference',200],['GET','/api-docs',200],['GET','/api-docs/swagger',200],['GET','/api-docs/openapi.json',200],['GET','/sunat-health',200],
 ['GET','/api/v1/documents',401],['GET','/api/v1/stations/admin/catalog',401],['GET','/api/v1/setup/sunat/reference',401],
 ['GET','/api/v1/setup/sunat/1/PRODUCTION/dispatch',401],['GET','/api/v1/fiscal-artifacts/'+uuid+'/original/xml',401],
 ['POST','/api/v1/b2b-admin/status',401],['GET','/api/v1/mail-settings/1/corporate',401],['POST','/api/v1/mail-settings/1/send-test',401],
 ['GET','/api/v1/setup/sunat/1/PRODUCTION/notes/authorization',401],['GET','/api/v1/documents/'+uuid+'/production-notes/ready',401],['GET','/api/v1/mail-settings/1/documents/'+uuid,401]
 ];const http=[];
 for(const [method,path,status]of checks){const r=await fetch('http://127.0.0.1:8091'+path,{method,redirect:'manual',headers:{'Content-Type':'application/json','Idempotency-Key':uuid},...(method==='POST'?{body:path.endsWith('/send-test')?JSON.stringify({expectedRevision:1,expectedActivationRevision:1,recipient:'qa@pruebas.invalid',confirmed:true}):'{}'}:{}),signal:AbortSignal.timeout(15000)});await r.body?.cancel();http.push({method,path,status:r.status});if(r.status!==status)throw Error('QA_HTTP_STATUS_MISMATCH '+method+' '+path+' '+r.status);}
 const contract=JSON.parse(docker(['exec','factuez-stage2-qa-sunat-service-1','node','-e',"const s=require('./services/sunat-service/dist/runtime-openapi.controller').fiscalRuntimeOpenApi(); console.log(JSON.stringify({paths:Object.keys(s.paths).length,operations:Object.values(s.paths).reduce((n,p)=>n+Object.keys(p).filter(k=>['get','post','patch','put','delete'].includes(k)).length,0),internalAdmissionPublished:Object.keys(s.paths).some(p=>p.includes('/admission'))}));"]));
 if(contract.paths!==69||contract.operations!==83||contract.internalAdmissionPublished!==false)throw Error('INSTALLED_NATIVE_SWAGGER_MISMATCH');
 const mailer=JSON.parse(docker(['exec','factuez-stage2-qa-mailer-worker-1','node','-e',"const s=require('./services/mailer-worker/dist/health').mailerHealth();const p=require('./services/mailer-worker/dist/corporate-document-policy').DOCUMENT_AUTHORIZATION_PROFILE;console.log(JSON.stringify({status:s.status,transport:s.transport,readiness:s.readiness,profile:p,externalSmtp:s.transports.corporateSmtp,externalDocuments:s.transports.corporateDocuments}));"]));
 if(mailer.status!=='ok'||mailer.readiness!=='NOT_PROBED'||mailer.profile!=='factuez.mail.document.01-03-07-08.v2'||mailer.externalSmtp!==false||mailer.externalDocuments!==false)throw Error('INSTALLED_MAILER_PROFILE_MISMATCH');
 console.log(JSON.stringify({result:'PASS',scope:'existing local QA',containers,http,contract,mailer,officialTransmission:false,realMailSent:false},null,2));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
