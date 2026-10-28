/* Explicit local QA installation. New tables only; never activates clients or SMTP. */
'use strict';
const {spawnSync}=require('node:child_process'),{readFileSync}=require('node:fs'),{resolve}=require('node:path'),{randomUUID}=require('node:crypto');
const root=resolve(__dirname,'..'),project='factuez-stage2-qa',pg=project+'-postgres-1',context='desktop-linux';
function docker(args,input,allow=false){const r=spawnSync('docker',['--context',context,...args],{input,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:4*1024*1024});if(r.error||(!allow&&r.status!==0))throw Error('QA_CONNECTIONS_MAIL_OPERATION_FAILED');return r;}
function sql(container,db,body,user='factuez_demo_admin'){return docker(['exec','-i',container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',user,'-d',db],body).stdout.trim();}
function file(path){return readFileSync(resolve(root,path),'utf8');}
function local(){const h=docker(['context','inspect',context,'--format','{{.Endpoints.docker.Host}}']).stdout.trim();if(!h.startsWith('npipe:')||!h.toLowerCase().includes('dockerdesktoplinuxengine'))throw Error('LOCAL_QA_ONLY');}
function owned(name,service){const l=JSON.parse(docker(['inspect',name,'--format','{{json .Config.Labels}}']).stdout);if(l['com.docker.compose.project']!==project||l['com.docker.compose.service']!==service)throw Error('QA_OWNER_MISMATCH');}
const fingerprint=(container,db,tables,user='factuez_demo_admin')=>sql(container,db,`SELECT encode(sha256(convert_to(COALESCE(string_agg(t,'' ORDER BY t),''),'UTF8')),'hex') FROM (${tables.map(t=>`SELECT '${t}:'||to_jsonb(r)::text AS t FROM "${t}" r`).join(' UNION ALL ')}) rows;`,user);
function count(container,db,names,user='factuez_demo_admin'){return Number(sql(container,db,`SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN (${names.map(n=>"'"+n+"'").join(',')});`,user));}

const plans=[
 {db:'factuez_billing',service:'billing-service',file:'services/billing-service/prisma/production-notes-schema.sql',tables:['ProductionNotesReservation','ProductionNotesOutbox','ProductionNotesInbox'],preserve:['Document','SeriesCounter','Branch']},
 {db:'factuez_sunat',service:'sunat-service',file:'services/sunat-service/prisma/production-notes-schema.sql',tables:['ProductionNotesGrant','ProductionNotesGrantAudit','ProductionNotesDispatch','ProductionNotesStatusOutbox'],preserve:['FiscalDocument','SunatCredentials','FiscalDispatchAuthorization']},
 {db:'factuez_mailer_qa',service:'mailer-worker',file:'services/mailer-worker/prisma/corporate-document-runtime.deploy.sql',tables:['CorporateDocumentActivation','CorporateDocumentJob','CorporateDocumentAudit'],preserve:['CorporateSmtpConfiguration','CorporateSmtpConfigurationAudit','CorporateSmtpActivation']},
];
function installationSql(p){const text=file(p.file);if(p.service!=='mailer-worker')return text;
 const marker='BEGIN;\nCREATE TABLE';const index=text.indexOf(marker);if(index<0)throw Error('REVIEWED_MAIL_DDL_REQUIRED');
 return text.slice(index); // reviewed core only; target identity is checked by this installer
}

async function rehearsal(){local();const run=randomUUID(),name='factuez-notes-mail-'+run;let created=false;try{
 const image=docker(['image','inspect','postgres:17-alpine','--format','{{.Id}}']).stdout.trim();if(!/^sha256:[a-f0-9]{64}$/.test(image))throw Error();
 docker(['run','--pull','never','-d','--name',name,'--label','factuez.notes-mail.rehearsal='+run,'--network','none','--memory','256m','--cpus','1','--tmpfs','/var/lib/postgresql/data:rw,nosuid,nodev,size=192m','-e','POSTGRES_HOST_AUTH_METHOD=trust',image,'postgres','-c','listen_addresses=']);created=true;
 let ready=false;for(let i=0;i<80;i++){if(docker(['exec',name,'pg_isready','-U','postgres'],undefined,true).status===0){ready=true;break;}await new Promise(r=>setTimeout(r,150));}if(!ready)throw Error();
 for(const p of plans)sql(name,'postgres','CREATE DATABASE '+p.db+';','postgres');
 sql(name,'factuez_billing','CREATE TABLE "Document" (id uuid PRIMARY KEY);','postgres');
 sql(name,'factuez_sunat','CREATE TABLE "FiscalDocument" ("documentId" uuid PRIMARY KEY);','postgres');
 sql(name,'factuez_mailer_qa',file('services/mailer-worker/prisma/smtp-configuration.qa.sql'),'postgres');
 for(const p of plans){sql(name,p.db,installationSql(p),'postgres');if(count(name,p.db,p.tables,'postgres')!==p.tables.length)throw Error('INCOMPLETE_SCHEMA');for(const t of p.tables)if(sql(name,p.db,'SELECT count(*) FROM "'+t+'";','postgres')!=='0')throw Error('AUTHORITY_FABRICATED');}
 console.log(JSON.stringify({result:'PASS',scope:'new isolated PostgreSQL schema rehearsal',newTables:10,publishedPorts:0,createdDocuments:0,createdGrants:0,realSends:false}));
 }finally{if(created){if(docker(['inspect',name,'--format','{{index .Config.Labels "factuez.notes-mail.rehearsal"}}']).stdout.trim()!==run)throw Error();docker(['rm','-f',name]);}}}
async function apply(){local();owned(pg,'postgres');const work=plans.map(p=>({...p,ddl:installationSql(p),beforeCount:count(pg,p.db,p.tables)}));
 for(const p of work){owned(project+'-'+p.service+'-1',p.service);if(![0,p.tables.length].includes(p.beforeCount))throw Error('PARTIAL_SCHEMA_REQUIRES_REVIEW');}
 if(work.every(p=>p.beforeCount===p.tables.length)){console.log(JSON.stringify({result:'ALREADY_INSTALLED',activated:false}));return;}
 const names=plans.map(p=>project+'-'+p.service+'-1'),backup='/var/lib/postgresql/data/factuez-upgrade-backups/'+randomUUID();let stopped=false;
 try{docker(['stop','--time','30',...names]);stopped=true;
 docker(['exec','-u','postgres',pg,'sh','-ec',`umask 077; mkdir -p '${backup}'; `+plans.map(p=>`pg_dump -U factuez_demo_admin -d ${p.db} -Fc -f '${backup}/${p.db}.dump'; pg_restore --list '${backup}/${p.db}.dump' >/dev/null; chmod 600 '${backup}/${p.db}.dump'`).join('; ')]);
 const hashes=work.map(p=>fingerprint(pg,p.db,p.preserve));
 for(const p of work)if(p.beforeCount===0)sql(pg,p.db,'SET ROLE factuez_demo_app;\n'+p.ddl);
 for(let i=0;i<work.length;i++)if(hashes[i]!==fingerprint(pg,work[i].db,work[i].preserve))throw Error('EXISTING_DATA_CHANGED_REQUIRES_BACKUP_REVIEW');
 console.log(JSON.stringify({result:'APPLIED',backupInsidePostgresVolume:backup,preservedDocuments:true,preservedCounters:true,preservedCredentials:true,createdGrants:0,productionActivated:false,realSends:false}));
 }finally{if(stopped)docker(['start',...names]);}}
const mode=process.argv.slice(2).join(' ');
if(mode==='--rehearse-synthetic')rehearsal().catch(()=>{console.error('Notes/mail synthetic schema rehearsal failed; existing data untouched');process.exitCode=1;});
else if(mode==='--apply-reviewed-expansion --project=factuez-stage2-qa --ack-preserve-data')apply().catch(()=>{console.error('Notes/mail QA expansion failed; review protected backup and schema');process.exitCode=1;});
else{console.error('Explicit scoped arguments required');process.exitCode=2;}
