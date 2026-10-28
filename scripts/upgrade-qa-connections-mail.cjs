/* Explicit local QA installation. New tables only; never activates clients or SMTP. */
'use strict';
const {spawnSync}=require('node:child_process'),{readFileSync}=require('node:fs'),{resolve}=require('node:path'),{randomUUID}=require('node:crypto');
const root=resolve(__dirname,'..'),project='factuez-stage2-qa',pg=project+'-postgres-1',context='desktop-linux';
function docker(args,input,allow=false){const r=spawnSync('docker',['--context',context,...args],{input,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:4*1024*1024});if(r.error||(!allow&&r.status!==0))throw Error('QA_CONNECTIONS_MAIL_OPERATION_FAILED');return r;}
function sql(container,db,body,user='factuez_demo_admin'){return docker(['exec','-i',container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',user,'-d',db],body).stdout.trim();}
function file(path){return readFileSync(resolve(root,path),'utf8');}
const identity=()=>file('services/identity-service/src/b2b/onprem-admin.minimal.sql');
const smtp=()=>file('services/mailer-worker/prisma/smtp-configuration.qa.sql');
const mail=()=>file('services/mailer-worker/prisma/corporate-mail-runtime.candidate.sql');
function local(){const h=docker(['context','inspect',context,'--format','{{.Endpoints.docker.Host}}']).stdout.trim();if(!h.startsWith('npipe:')||!h.toLowerCase().includes('dockerdesktoplinuxengine'))throw Error('LOCAL_QA_ONLY');}
function owned(name,service){const l=JSON.parse(docker(['inspect',name,'--format','{{json .Config.Labels}}']).stdout);if(l['com.docker.compose.project']!==project||l['com.docker.compose.service']!==service)throw Error('QA_OWNER_MISMATCH');}
const fingerprint=(container,db,tables,user='factuez_demo_admin')=>sql(container,db,`SELECT encode(sha256(convert_to(COALESCE(string_agg(t,'' ORDER BY t),''),'UTF8')),'hex') FROM (${tables.map(t=>`SELECT '${t}:'||to_jsonb(r)::text AS t FROM "${t}" r`).join(' UNION ALL ')}) rows;`,user);
function count(container,db,names,user='factuez_demo_admin'){return Number(sql(container,db,`SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN (${names.map(n=>"'"+n+"'").join(',')});`,user));}
async function rehearsal(){local();const run=randomUUID(),name='factuez-connections-mail-'+run;let created=false;try{
 const image=docker(['image','inspect','postgres:17-alpine','--format','{{.Id}}']).stdout.trim();if(!/^sha256:[a-f0-9]{64}$/.test(image))throw Error();
 docker(['run','--pull','never','-d','--name',name,'--label','factuez.connections-mail.rehearsal='+run,'--network','none','--memory','256m','--cpus','1','--tmpfs','/var/lib/postgresql/data:rw,nosuid,nodev,size=192m','-e','POSTGRES_HOST_AUTH_METHOD=trust',image,'postgres','-c','listen_addresses=']);created=true;
 let ready=false;for(let i=0;i<80;i++){if(docker(['exec',name,'pg_isready','-U','postgres'],undefined,true).status===0){ready=true;break;}await new Promise(r=>setTimeout(r,150));}if(!ready)throw Error();
 sql(name,'postgres','CREATE DATABASE factuez_mailer_qa;','postgres');sql(name,'postgres',identity(),'postgres');sql(name,'factuez_mailer_qa',smtp(),'postgres');
 const before=fingerprint(name,'factuez_mailer_qa',['CorporateSmtpConfiguration','CorporateSmtpConfigurationAudit'],'postgres');
 sql(name,'factuez_mailer_qa',mail(),'postgres');sql(name,'factuez_mailer_qa',mail(),'postgres');
 if(before!==fingerprint(name,'factuez_mailer_qa',['CorporateSmtpConfiguration','CorporateSmtpConfigurationAudit'],'postgres'))throw Error();
 if(sql(name,'postgres','SELECT count(*) FROM "B2bClient";','postgres')!=='0'||sql(name,'factuez_mailer_qa','SELECT count(*) FROM "CorporateSmtpActivation";','postgres')!=='0')throw Error();
 sql(name,'postgres','CREATE DATABASE factuez_mailer_install_test;','postgres');
 const productionDdl=file('services/mailer-worker/prisma/smtp-corporate-install.review.sql');
 let refused=false;try{sql(name,'factuez_mailer_install_test',productionDdl,'postgres');}catch{refused=true;}if(!refused)throw Error('TARGET_GUARD_MISSING');
 sql(name,'factuez_mailer_install_test',"SET factuez.smtp_install_database='factuez_mailer_install_test';\n"+productionDdl,'postgres');
 if(count(name,'factuez_mailer_install_test',['CorporateSmtpConfiguration','CorporateSmtpConfigurationAudit','CorporateSmtpActivation','CorporateMailTestJob','CorporateMailAudit'],'postgres')!==5)throw Error();
 console.log(JSON.stringify({result:'PASS',scope:'isolated synthetic',newClients:0,smtpAuthorizations:0,preservedConfiguration:true,explicitNewDatabaseInstall:true,unconfirmedDatabaseRefused:true,publishedPorts:0}));
 }finally{if(created){if(docker(['inspect',name,'--format','{{index .Config.Labels "factuez.connections-mail.rehearsal"}}']).stdout.trim()!==run)throw Error();docker(['rm','-f',name]);}}}
async function apply(){local();owned(pg,'postgres');const names=['identity-service','mailer-worker'].map(s=>{const n=project+'-'+s+'-1';owned(n,s);return n;});
 const i=identity(),m=mail(),ic=count(pg,'factuez_identity',['B2bClient','B2bAudit','B2bRateBucket']),mc=count(pg,'factuez_mailer_qa',['CorporateSmtpActivation','CorporateMailTestJob','CorporateMailAudit']);
 if(![0,3].includes(ic)||![0,3].includes(mc)||count(pg,'factuez_mailer_qa',['CorporateSmtpConfiguration','CorporateSmtpConfigurationAudit'])!==2)throw Error('PARTIAL_SCHEMA_REQUIRES_REVIEW');
 if(ic===3&&mc===3){console.log(JSON.stringify({result:'ALREADY_INSTALLED',activated:false}));return;}
 const backup='/var/lib/postgresql/data/factuez-upgrade-backups/'+randomUUID();let stopped=false;
 try{docker(['stop','--time','30',...names]);stopped=true;
 docker(['exec','-u','postgres',pg,'sh','-ec',`umask 077; mkdir -p '${backup}'; pg_dump -U factuez_demo_admin -d factuez_identity -Fc -f '${backup}/identity.dump'; pg_dump -U factuez_demo_admin -d factuez_mailer_qa -Fc -f '${backup}/mailer.dump'; pg_restore --list '${backup}/identity.dump' >/dev/null; pg_restore --list '${backup}/mailer.dump' >/dev/null; chmod 600 '${backup}/identity.dump' '${backup}/mailer.dump'`]);
 const users=fingerprint(pg,'factuez_identity',['User','Role','Permission','UserRoleAssignment','RolePermission']),settings=fingerprint(pg,'factuez_mailer_qa',['CorporateSmtpConfiguration','CorporateSmtpConfigurationAudit']);
 if(ic===0)sql(pg,'factuez_identity','SET ROLE factuez_demo_app;\n'+i);
 if(mc===0)sql(pg,'factuez_mailer_qa','SET ROLE factuez_demo_app;\n'+m);
 if(users!==fingerprint(pg,'factuez_identity',['User','Role','Permission','UserRoleAssignment','RolePermission'])||settings!==fingerprint(pg,'factuez_mailer_qa',['CorporateSmtpConfiguration','CorporateSmtpConfigurationAudit']))throw Error('DATA_CHANGE_REQUIRES_BACKUP_REVIEW');
 console.log(JSON.stringify({result:'APPLIED',backupInsidePostgresVolume:backup,preservedUsers:true,preservedSmtpConfiguration:true,createdClients:0,activatedSmtp:false}));
 }finally{if(stopped)docker(['start',...names]);}}
const mode=process.argv.slice(2).join(' ');
if(mode==='--rehearse-synthetic')rehearsal().catch(()=>{console.error('Connections/mail synthetic rehearsal failed');process.exitCode=1;});
else if(mode==='--apply-reviewed-expansion --project=factuez-stage2-qa --ack-preserve-data')apply().catch(()=>{console.error('Connections/mail QA upgrade failed; review protected backup/schema before retry');process.exitCode=1;});
else{console.error('Explicit scoped arguments required');process.exitCode=2;}
