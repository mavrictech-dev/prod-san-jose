/* Strictly scoped local QA additive upgrade. No network SUNAT, seeds or db push. */
'use strict';
const {spawnSync}=require('node:child_process');
const {readFileSync}=require('node:fs');
const {resolve}=require('node:path');
const {randomUUID}=require('node:crypto');
const context='desktop-linux',project='factuez-stage2-qa',pg='factuez-stage2-qa-postgres-1';
const root=resolve(__dirname,'..');
function command(args,input,allowFailure=false){
 const r=spawnSync('docker',['--context',context,...args],{input,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:4*1024*1024});
 if(r.error||(!allowFailure&&r.status!==0))throw Error('QA upgrade Docker operation failed');
 return r;
}
function local(){const e=command(['context','inspect',context,'--format','{{.Endpoints.docker.Host}}']).stdout.trim();
 if(!e.startsWith('npipe:')||!e.toLowerCase().includes('dockerdesktoplinuxengine'))throw Error('Only local Docker Desktop QA allowed');}
function owned(name,service){const m=JSON.parse(command(['inspect',name,'--format','{{json .Config.Labels}}']).stdout);
 if(m['com.docker.compose.project']!==project||m['com.docker.compose.service']!==service)throw Error('QA container ownership mismatch');}
function sql(container,db,text,user='factuez_demo_admin',allowFailure=false){return command(['exec','-i',container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',user,'-d',db],text,allowFailure).stdout.trim();}
function file(name){return readFileSync(resolve(root,name),'utf8');}
const billingSql=()=>file('services/billing-service/prisma/production-compat-expand.sql');
const branchSql=()=>file('services/billing-service/prisma/branch-establishment-expand.sql');
const fiscalSql=()=>file('services/sunat-service/prisma/production-dispatch.sql');
const receiptSql=()=>file('services/sunat-service/prisma/production-receipt-profile-expand.sql');
function fingerprint(container,db,user){return sql(container,db,`SELECT encode(sha256(convert_to(COALESCE(string_agg(row_text,'' ORDER BY row_text),''),'UTF8')),'hex') FROM (
 SELECT ('document:'||(to_jsonb(d)||jsonb_build_object('createdByActor',to_jsonb(d)->'createdByActor'))::text) AS row_text FROM "Document" d
 UNION ALL SELECT 'series:'||to_jsonb(s)::text FROM "SeriesCounter" s
 UNION ALL SELECT 'branch:'||(to_jsonb(b)||jsonb_build_object('establishmentCode',to_jsonb(b)->'establishmentCode'))::text FROM "Branch" b) entries;`,user);}
async function rehearsal(){
 local();const run=randomUUID(),name='factuez-compat-rehearsal-'+run,label='factuez.compat.rehearsal';let created=false;
 try{
  const image=command(['image','inspect','postgres:17-alpine','--format','{{.Id}}']).stdout.trim();if(!/^sha256:[a-f0-9]{64}$/.test(image))throw Error('Local PostgreSQL image required');
  command(['run','--pull','never','-d','--name',name,'--label',label+'='+run,'--network','none','--memory','256m','--cpus','1','--tmpfs','/var/lib/postgresql/data:rw,nosuid,nodev,size=192m','-e','POSTGRES_HOST_AUTH_METHOD=trust',image,'postgres','-c','listen_addresses=']);created=true;
  let ready=false;for(let i=0;i<80;i++){if(command(['exec',name,'pg_isready','-U','postgres'],undefined,true).status===0){ready=true;break;}await new Promise(r=>setTimeout(r,200));}if(!ready)throw Error('Ephemeral database not ready');
  sql(name,'postgres',`CREATE TYPE "SunatEnvironment" AS ENUM ('BETA','PRODUCTION');
 CREATE TABLE "Document" (id uuid PRIMARY KEY, "createdByUserId" uuid NOT NULL, number bigint NOT NULL, "immutableSnapshot" jsonb NOT NULL);
 CREATE TABLE "SeriesCounter" (id uuid PRIMARY KEY, "nextNumber" bigint NOT NULL);
 CREATE TABLE "Branch" (id uuid PRIMARY KEY, "companyId" integer NOT NULL, name text NOT NULL);
 INSERT INTO "Document" VALUES ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',42,'{"synthetic":true}');
 INSERT INTO "SeriesCounter" VALUES ('33333333-3333-4333-8333-333333333333',43);
 INSERT INTO "Branch" VALUES ('44444444-4444-4444-8444-444444444444',1,'SYNTHETIC');`,'postgres');
  const before=fingerprint(name,'postgres','postgres');
  sql(name,'postgres',billingSql(),'postgres');sql(name,'postgres',billingSql(),'postgres');
  sql(name,'postgres',branchSql(),'postgres');sql(name,'postgres',branchSql(),'postgres');
  sql(name,'postgres',fiscalSql(),'postgres');
  sql(name,'postgres',receiptSql(),'postgres');sql(name,'postgres',receiptSql(),'postgres');
  if(before!==fingerprint(name,'postgres','postgres'))throw Error('Synthetic records or counters changed');
  if(sql(name,'postgres',`SELECT "createdByActor" IS NULL FROM "Document";`,'postgres')!=='t')throw Error('Actor provenance fabricated');
  if(sql(name,'postgres',`SELECT "establishmentCode" IS NULL FROM "Branch";`,'postgres')!=='t')throw Error('Establishment fabricated');
  if(sql(name,'postgres',`SELECT count(*) FROM "FiscalDispatchAuthorization";`,'postgres')!=='0')throw Error('Authority fabricated');
  console.log(JSON.stringify({result:'PASS',scope:'isolated synthetic SQL rehearsal',preservedDocuments:true,preservedCounters:true,idempotentBilling:true,idempotentBranch:true,officialAuthorityCreated:false,publishedPorts:0}));
 }finally{if(created){const id=command(['inspect',name,'--format','{{index .Config.Labels "'+label+'"}}']).stdout.trim();if(id!==run)throw Error('Rehearsal cleanup ownership mismatch');command(['rm','-f',name]);}}
}
async function apply(){
 local();owned(pg,'postgres');owned(project+'-billing-service-1','billing-service');owned(project+'-sunat-service-1','sunat-service');
 // Read and check all reviewed scripts BEFORE pausing anything.
 const billing=billingSql(),branch=branchSql(),fiscal=fiscalSql(),receipt=receiptSql();
 const grantTables=Number(sql(pg,'factuez_sunat',`SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('FiscalDispatchAuthorization','FiscalDispatchAudit');`));
 if(![0,2].includes(grantTables))throw Error('Partial fiscal authorization schema requires repair');
 const names=[project+'-billing-service-1',project+'-sunat-service-1'];
 const backup='/var/lib/postgresql/data/factuez-upgrade-backups/'+randomUUID();let stopped=false;
 try{
  command(['stop','--time','30',...names]);stopped=true;
  command(['exec','-u','postgres',pg,'sh','-ec',`umask 077; mkdir -p '${backup}'; pg_dump -U factuez_demo_admin -d factuez_billing -Fc -f '${backup}/billing.dump'; pg_dump -U factuez_demo_admin -d factuez_sunat -Fc -f '${backup}/sunat.dump'; pg_restore --list '${backup}/billing.dump' >/dev/null; pg_restore --list '${backup}/sunat.dump' >/dev/null; chmod 600 '${backup}/billing.dump' '${backup}/sunat.dump'`]);
  const before=fingerprint(pg,'factuez_billing');
  sql(pg,'factuez_billing','SET ROLE factuez_demo_app;\n'+billing);sql(pg,'factuez_billing','SET ROLE factuez_demo_app;\n'+branch);
  if(grantTables===0)sql(pg,'factuez_sunat','SET ROLE factuez_demo_app;\n'+fiscal);
  sql(pg,'factuez_sunat','SET ROLE factuez_demo_app;\n'+receipt);
  if(before!==fingerprint(pg,'factuez_billing'))throw Error('Unexpected data change; manual restore review required');
  console.log(JSON.stringify({result:'APPLIED',project,backupInsidePostgresVolume:backup,preservedDocuments:true,preservedCounters:true,officialTransmissionActivated:false}));
 }finally{if(stopped)command(['start',...names]);}
}
const mode=process.argv.slice(2).join(' ');
if(mode==='--rehearse-synthetic')rehearsal().catch(()=>{console.error('QA compatibility rehearsal failed; no existing database was changed');process.exitCode=1;});
else if(mode==='--apply-reviewed-expansion --project=factuez-stage2-qa --ack-preserve-data')apply().catch(()=>{console.error('QA compatibility upgrade failed; inspect schema and protected backup before retrying');process.exitCode=1;});
else {console.error('Explicit synthetic rehearsal or scoped reviewed QA upgrade arguments required');process.exitCode=2;}
