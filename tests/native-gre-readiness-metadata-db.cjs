'use strict';
// Execute the shipping diagnostic SQL against a disposable owner database.
// Only connection plumbing is redirected from Docker DNS to the helper stream.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module'),{randomBytes}=require('node:crypto');
const root=path.resolve(__dirname,'..'),local=createRequire(path.join(root,'services/sunat-service/package.json')),{withCorrectionDatabase}=require('./helpers/correction-reservation-db.cjs');
assert.deepEqual(process.argv.slice(2),['--isolated-synthetic-only']);
async function main(){await withCorrectionDatabase(async({pool})=>{
 const pg=local('pg'),ActualPool=pg.Pool,password=randomBytes(24).toString('hex'),queries=[],checks=[];const check=(v,name)=>{assert.ok(v,name);checks.push(name);};
 await pool.query("CREATE ROLE factuez_sunat LOGIN PASSWORD '"+password+"'");await pool.query('CREATE DATABASE factuez_sunat OWNER factuez_sunat');
 const owner=new ActualPool({...pool.options,database:'factuez_sunat',user:'factuez_sunat',password});owner.on('error',()=>{});
 await owner.query('CREATE TABLE "SunatCredentials" ("issuerRuc" char(11),environment text,revision integer,"cipherDoNotRead" text)');await owner.query(fs.readFileSync(path.join(root,'services/sunat-service/prisma/production-guides.sql'),'utf8'));await owner.query(fs.readFileSync(path.join(root,'services/sunat-service/prisma/updates/20261123_gre_catalogue_v1.sql'),'utf8'));
 const {metadata}=require('../scripts/diagnose-native-gre-readiness.cjs'),read=fs.readFileSync,previous={};for(const k of ['DB_NAME','DB_USER','DB_HOST','DB_PORT','DB_PASSWORD_FILE'])previous[k]=process.env[k];Object.assign(process.env,{DB_NAME:'factuez_sunat',DB_USER:'factuez_sunat',DB_HOST:'postgres',DB_PORT:'5432',DB_PASSWORD_FILE:'/run/secrets/synthetic_db_password'});
 const descriptor=Object.getOwnPropertyDescriptor(pg,'Pool');Object.defineProperty(pg,'Pool',{configurable:true,value:class extends ActualPool{
  constructor(options){assert.equal(options.host,'postgres');assert.equal(options.database,'factuez_sunat');assert.equal(options.user,'factuez_sunat');assert.equal(options.password,password);super({...options,...pool.options,database:options.database,user:options.user,password:options.password});}
  async connect(){const db=await super.connect(),original=db.query;db.query=function(...args){queries.push(args[0]);return original.apply(this,args);};return db;}
 }});fs.readFileSync=function(file,...args){return file==='/run/secrets/synthetic_db_password'?password:read.call(this,file,...args);};
 try{
  const ready=await metadata();check(ready.code==='SUNAT_SCHEMA_METADATA'&&ready.ownerMatches===true&&ready.publicSchema===true,'fixed-owner-identity-and-public-schema');check(ready.tables.length===3&&ready.tables.every(t=>t.present&&t.selectable&&t.missingColumns.length===0),'three-real-ddl-tables-and-columns-present');
  await owner.query('ALTER TABLE "SunatCredentials" RENAME COLUMN revision TO "syntheticHiddenRevision"');const missing=await metadata();check(missing.tables.find(t=>t.table==='SunatCredentials').missingColumns.join(',')==='revision','missing-readiness-revision-column-detected');await owner.query('ALTER TABLE "SunatCredentials" RENAME COLUMN "syntheticHiddenRevision" TO revision');
  await owner.query('REVOKE SELECT ON "ProductionGuidesCatalogue" FROM factuez_sunat');const denied=await metadata();check(denied.tables.find(t=>t.table==='ProductionGuidesCatalogue').selectable===false,'missing-catalogue-select-privilege-detected');await owner.query('GRANT SELECT ON "ProductionGuidesCatalogue" TO factuez_sunat');
  await owner.query('ALTER TABLE "ProductionGuidesCatalogue" RENAME TO "SyntheticHiddenCatalogue"');const absent=await metadata();check(absent.tables.find(t=>t.table==='ProductionGuidesCatalogue').present===false,'missing-catalogue-table-detected');
  check(queries.filter(q=>q==='BEGIN READ ONLY').length===4&&queries.filter(q=>q==='ROLLBACK').length===4,'every-diagnostic-transaction-readonly-and-rolled-back');check(queries.every(q=>q==='BEGIN READ ONLY'||q==='ROLLBACK'||q.startsWith('SELECT current_database()')||q.startsWith('SELECT to_regclass(')||q.startsWith('SELECT column_name FROM information_schema.columns')),'no-credential-row-or-unapproved-query');check(!JSON.stringify([ready,missing,denied,absent]).includes(password),'output-does-not-include-connection-secret');
  const result={synthetic:true,checks,failures:[]};fs.writeFileSync(path.join(root,'output/gre-runtime-repair-20261126/metadata-db-results.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 }finally{Object.defineProperty(pg,'Pool',descriptor);fs.readFileSync=read;for(const[k,v]of Object.entries(previous))v===undefined?delete process.env[k]:process.env[k]=v;await owner.end();}
 });}
main().catch(e=>{console.error(JSON.stringify({code:e.code==='ERR_ASSERTION'&&/^[a-z0-9-]+$/.test(e.message)?e.message:'SYNTHETIC_METADATA_DB_FAILED'}));process.exitCode=1;});
