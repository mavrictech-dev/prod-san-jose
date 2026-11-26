'use strict';
// Existing installation updater. No bootstrap, key generation, reset or official network use.
const {readFileSync}=require('node:fs'),{join,resolve}=require('node:path'),{createRequire}=require('node:module'),{createHash}=require('node:crypto');
const {randomUUID}=require('node:crypto');
const allowed=new Set(['identity-service','billing-service','sunat-service']);
function migrations(root,service){
 const sql=name=>readFileSync(join(root,'services',service,'prisma',name),'utf8');
 const declarationSql=name=>{const text=sql(name),start=text.indexOf('BEGIN;'),end=text.lastIndexOf('COMMIT;');if(start<0||end<=start)throw Error('REVIEWED_DECLARATION_DDL_REQUIRED');return text.slice(start+6,end);};
 if(service==='identity-service')return [{id:'20261124_native_b2b_v1',sql:sql('updates/20261124_native_b2b_v1.sql'),tables:['b2b_production_record']}];
 return service==='billing-service'?[
  {id:'20261123_catalog_tax_v1',sql:sql('updates/20261123_catalog_tax_v1.sql')},
  {id:'20261123_counter_environment_v1',sql:sql('updates/20261123_counter_environment_v1.sql')},
  {id:'20261123_native_gre_billing_v1',sql:sql('production-guides.sql'),tables:['ProductionGuidesGrant','ProductionGuidesReservation','ProductionGuidesOwnerStatus']},
  {id:'20261124_gre_hydrocarbon_v1',sql:sql('updates/20261124_gre_hydrocarbon_v1.sql')},
  {id:'20261124_native_b2b_v1',sql:sql('updates/20261124_native_b2b_v1.sql'),tables:['b2b_production_record']},
  {id:'20261125_guide_declarations_v1',sql:declarationSql('guide-operational-settings.sql')},
  {id:'20261125_guide_fuel_declarations_v1',sql:declarationSql('guide-fuel-settings.sql')}
 ]:[{id:'20261123_native_gre_sunat_v1',sql:sql('production-guides.sql'),tables:['ProductionGuidesJob','ProductionGuidesArtifact','ProductionGuidesStatusOutbox']},{id:'20261123_tax_profiles_v1',sql:sql('updates/20261123_tax_profiles_v1.sql')},{id:'20261123_gre_catalogue_v1',sql:sql('updates/20261123_gre_catalogue_v1.sql'),tables:['ProductionGuidesCatalogue']},{id:'20261126_gre_administration_v1',sql:sql('updates/20261126_gre_administration_v1.sql'),tables:['ProductionGuidesAdministrationDraft']}];
}
async function update(pool,{root,service,apply=false}){
 if(!allowed.has(service))throw Error('REVIEWED_SERVICE_REQUIRED');const db=await pool.connect();
 try{
  const pending=[];const existing=(await db.query(`SELECT to_regclass('"FactuezSchemaUpdate"') IS NOT NULL AS ready`)).rows[0].ready;
  for(const m of migrations(root,service)){
   const sha=createHash('sha256').update(m.sql).digest('hex');const prior=existing?(await db.query('SELECT "sha256" FROM "FactuezSchemaUpdate" WHERE "id"=$1',[m.id])).rows[0]:null;
   if(prior){if(prior.sha256!==sha)throw Error('APPLIED_MIGRATION_CHECKSUM_CHANGED');continue;}pending.push(m.id);if(!apply)continue;
   await db.query('BEGIN');try{
    await db.query(`SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='120s';`);
    await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('factuez:catalog-tax-gre-updates:v1',0))`);
    await db.query('CREATE TABLE IF NOT EXISTS "FactuezSchemaUpdate" ("id" text PRIMARY KEY,"sha256" char(64) NOT NULL,"appliedAt" timestamptz NOT NULL DEFAULT now())');
    const current=(await db.query('SELECT "sha256" FROM "FactuezSchemaUpdate" WHERE "id"=$1',[m.id])).rows[0];if(current){if(current.sha256!==sha)throw Error('APPLIED_MIGRATION_CHECKSUM_CHANGED');await db.query('COMMIT');continue;}
    let adopted=false;
    if(m.tables){const present=await Promise.all(m.tables.map(async name=>(await db.query('SELECT to_regclass($1) IS NOT NULL AS present',['"'+name+'"'])).rows[0].present));if(present.some(Boolean)&&!present.every(Boolean))throw Error('PARTIAL_GRE_SCHEMA_REQUIRES_REVIEW');adopted=present.every(Boolean);if(adopted)await verifyAdoptedSchema(db,m);}
    if(!adopted)await db.query(m.sql);
    await db.query('INSERT INTO "FactuezSchemaUpdate" ("id","sha256") VALUES ($1,$2)',[m.id,sha]);await db.query('COMMIT');
   }catch(e){await db.query('ROLLBACK');throw e;}
  }
  return {service,mode:apply?'APPLIED':'READ_ONLY',pending:apply?[]:pending};
 }finally{db.release();}
}
/** Verify real columns, defaults, constraints, indexes and immutable trigger bodies.
 * The reviewed DDL is instantiated only in a new transaction-local scratch schema;
 * existing owner rows are never changed by this comparison. */
async function verifyAdoptedSchema(db,m){
 const scratch='factuez_update_review_'+randomUUID().replaceAll('-','');
 const normalize=value=>typeof value==='string'?value.replaceAll('"'+scratch+'".','').replaceAll(scratch+'.','').replaceAll('public.','').replace(/\s+/g,' ').trim():value;
 async function shape(schema){
  const result=[];
  for(const table of m.tables){
   const oid=(await db.query('SELECT to_regclass($1)::oid AS oid',['"'+schema+'"."'+table+'"'])).rows[0].oid;
   const columns=(await db.query(`SELECT attname,format_type(atttypid,atttypmod) AS type,attnotnull,pg_get_expr(d.adbin,d.adrelid) AS expression FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,[oid])).rows;
   const constraints=(await db.query('SELECT conname,contype,condeferrable,condeferred,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1 ORDER BY conname',[oid])).rows;
   const indexes=(await db.query('SELECT indexrelid::regclass::text AS name,pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indrelid=$1 ORDER BY indexrelid::regclass::text',[oid])).rows;
   const triggers=(await db.query('SELECT tgname,pg_get_triggerdef(oid) AS definition,pg_get_functiondef(tgfoid) AS function FROM pg_trigger WHERE tgrelid=$1 AND NOT tgisinternal ORDER BY tgname',[oid])).rows;
   result.push({table,columns,constraints,indexes,triggers});
  }
  return JSON.stringify(result,(_k,v)=>normalize(v));
 }
 await db.query('CREATE SCHEMA "'+scratch+'"');await db.query('SET LOCAL search_path TO "'+scratch+'", public');await db.query(m.sql);
 const expected=await shape(scratch);await db.query('SET LOCAL search_path TO public');const actual=await shape('public');
 // Scratch name is generated here and was created successfully in this transaction.
 await db.query('DROP SCHEMA "'+scratch+'" CASCADE');
 if(actual!==expected)throw Error('GRE_SCHEMA_INCOMPATIBLE: existing '+m.tables.join(',')+' differs from reviewed DDL; review columns/types/defaults/constraints/indexes/immutable triggers before updating');
}
async function main(){
 const service=process.argv[2],mode=process.argv[3];if(!allowed.has(service)||!['--check','--apply'].includes(mode)||process.argv.length!==4)throw Error('Use identity-service|billing-service|sunat-service --check|--apply inside the existing service container');
 const root=resolve(__dirname,'..'),local=createRequire(join(root,'services',service,'package.json')),{Pool}=local('pg');
 // Fixed container identity. No command-line URL and no fallback to another database.
 const expected=({'identity-service':'factuez_identity','billing-service':'factuez_billing','sunat-service':'factuez_sunat'})[service];
 if(process.env.DB_NAME!==expected||process.env.DB_USER!==expected||!process.env.DB_PASSWORD_FILE)throw Error('EXISTING_OWNER_DATABASE_IDENTITY_REQUIRED');
 const pool=new Pool({host:process.env.DB_HOST??'postgres',port:Number(process.env.DB_PORT??5432),database:expected,user:expected,password:readFileSync(process.env.DB_PASSWORD_FILE,'utf8').trim(),max:1});
 try{const identity=(await pool.query('SELECT current_database() AS db,current_user AS actor')).rows[0];if(identity.db!==expected||identity.actor!==expected)throw Error('OWNER_IDENTITY_MISMATCH');const report=await update(pool,{root,service,apply:mode==='--apply'});console.log(JSON.stringify(report));if(mode==='--check'&&report.pending.length)process.exitCode=2;}finally{await pool.end();}
}
module.exports={update,migrations};if(require.main===module)main().catch(error=>{console.error(String(error?.message??'').startsWith('GRE_SCHEMA_INCOMPATIBLE')?error.message:'SCHEMA_UPDATE_BLOCKED: review owner identity, migration checksum and database logs; no keys or volumes were changed');process.exitCode=1;});
