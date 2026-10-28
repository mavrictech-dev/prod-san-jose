/* Offline schema packaging only. No DB connection, startup, credential read or migration. */
'use strict';
const {spawnSync}=require('node:child_process'),{readFileSync,mkdirSync,existsSync,writeFileSync,realpathSync}=require('node:fs'),{resolve,join,dirname,isAbsolute,relative}=require('node:path'),{createHash}=require('node:crypto');
const root=resolve(__dirname,'..');
function load(path){return readFileSync(join(root,path),'utf8');}
function body(text){const start=text.indexOf('BEGIN;'),end=text.lastIndexOf('COMMIT;');if(start<0||end<=start)throw Error('REVIEWED_DDL_REQUIRED');return text.slice(start+6,end);}
const target=process.argv[2];
if(process.argv.length!==3||!target||!isAbsolute(target))throw Error('Use one absolute NEW output directory; no database argument is accepted');
const output=resolve(target),parent=realpathSync(dirname(output));if(existsSync(output)||relative(parent,output).includes('..')||parent!==dirname(output))throw Error('NEW_CANONICAL_OUTPUT_REQUIRED');
const extras={
 'identity-service':body(load('services/identity-service/src/b2b/onprem-admin.minimal.sql')),
 'billing-service':body(load('services/billing-service/prisma/production-notes-schema.sql')),
 'sunat-service':`ALTER TABLE "FiscalDispatchAuthorization" ADD CONSTRAINT "FiscalDispatchAuthorization_profile_check" CHECK ("profile" IN ('01-PEN-0101-IGV18-v1','01-03-PEN-0101-IGV18-v2'));
 ALTER TABLE "FiscalDispatchAuthorization" ADD CONSTRAINT "FiscalDispatchAuthorization_environment_check" CHECK ("environment"='PRODUCTION');
 ALTER TABLE "FiscalDispatchAuthorization" ADD CONSTRAINT "FiscalDispatchAuthorization_enabled_registration_check" CHECK (NOT "enabled" OR "registrationAttestedAt" IS NOT NULL);
 ALTER TABLE "FiscalDispatchAuthorization" ADD CONSTRAINT "FiscalDispatchAuthorization_version_positive" CHECK ("version">0 AND "credentialRevision">=0);
 `+body(load('services/sunat-service/prisma/production-notes-schema.sql')),
 'mailer-worker':body(load('services/mailer-worker/prisma/smtp-configuration.qa.sql'))+body(load('services/mailer-worker/prisma/corporate-mail-runtime.candidate.sql'))+body(load('services/mailer-worker/prisma/corporate-document-runtime.deploy.sql')),
 'received-documents-service':'',
};
const entries=[];
for(const [service,extra]of Object.entries(extras)){
 const cwd=join(root,'services',service),cli=join(cwd,'node_modules','prisma','build','index.js');
 const result=spawnSync(process.execPath,[cli,'migrate','diff','--from-empty','--to-schema','prisma/schema.prisma','--script'],{cwd,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:8*1024*1024,
 env:{NODE_PATH:join(cwd,'node_modules'),PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,DATABASE_URL:'postgresql://offline:offline@127.0.0.1:1/not_connected',PRISMA_HIDE_UPDATE_MESSAGE:'true'}});
 if(result.error||result.status!==0||!result.stdout.includes('CREATE TABLE')||/^\s*(?:DROP TABLE|TRUNCATE|INSERT INTO|DELETE FROM|UPDATE\s+")/im.test(result.stdout))throw Error('OFFLINE_PRISMA_SCHEMA_FAILED '+service);
 const schema=result.stdout.replace(/^CREATE SCHEMA IF NOT EXISTS "public";\s*/m,'');
 const guard=`-- NEW EMPTY DATABASE ONLY. Never run on an existing client/QA database.
 BEGIN;
 SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s';
 DO $target$ BEGIN
 IF current_setting('factuez.schema_target',true) IS DISTINCT FROM current_database() THEN RAISE EXCEPTION 'Explicit reviewed database identity required'; END IF;
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) THEN RAISE EXCEPTION 'Connect as the reviewed service database owner'; END IF;
 IF EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema='public') OR EXISTS(SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype='e') THEN RAISE EXCEPTION 'Target is not empty'; END IF;
 END $target$;
 `;
 const text=guard+schema+'\n'+extra+'\nCOMMIT;\n',name=service+'.sql';
 entries.push({service,name,bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex'),text});
}
mkdirSync(output,{mode:0o700});
for(const e of entries)writeFileSync(join(output,e.name),e.text,{flag:'wx',mode:0o600});
const manifest={schemaVersion:'factuez.new-core-schema.v1',scope:'NEW_EMPTY_DATABASE_ONLY',generatedAt:new Date().toISOString(),runtimeDdl:false,dataRows:0,seeds:false,files:entries.map(({text,...metadata})=>metadata)};
writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({result:'GENERATED_OFFLINE',output,files:entries.length,dataRows:0,databaseContacted:false}));
