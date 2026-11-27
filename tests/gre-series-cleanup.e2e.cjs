'use strict';
// Exact operator SQL against the current exported Windows schema and real triggers.
// Only newly created databases in an owned network-none fixture are contacted.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process'),{randomUUID}=require('node:crypto');
const {withCorrectionDatabase}=require('./helpers/correction-reservation-db.cjs');
assert.equal(process.argv[2],'--isolated-synthetic-only');
const root=path.resolve(__dirname,'..'),out=path.join(root,'output/gre-series-cleanup-v2-20261127');fs.mkdirSync(out,{recursive:true});
const dir=fs.mkdtempSync(path.join(out,'.fixture-')),checks=[],failures=[],id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');let stage='export',lastSqlState,lastGuard,lastErrorToken,lastPosition;
const previewSql=fs.readFileSync(path.join(root,'scripts/gre-series-cleanup-preflight.sql'),'utf8'),coreSql=fs.readFileSync(path.join(root,'scripts/gre-series-cleanup-reviewed.sql'),'utf8');
function apply(snapshot,backupSha256='a'.repeat(64)){const input=Buffer.from(JSON.stringify({snapshot,backupSha256}),'utf8').toString('base64');return coreSql.replace('-- REVIEWED_INPUT_REQUIRED',"DO $input$ BEGIN PERFORM set_config('factuez.gre.cleanup.reviewed',convert_from(decode('"+input+"','base64'),'UTF8'),true); END $input$;");}
async function main(){try{
 const exportRun=spawnSync(process.execPath,[path.join(root,'tests/helpers/gre-series-export397.cjs'),path.join(dir,'schema')],{cwd:root,encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:4*1024*1024});assert.equal(exportRun.status,0,'CLEANUP_EXPORTED_SCHEMA_FAILED');
 const schema=fs.readFileSync(path.join(dir,'schema/billing-service.sql'),'utf8');
 await withCorrectionDatabase(async({pool,local})=>{
  const {Pool}=local('pg');let sequence=0;
  async function scenario(name,mutate,success=false,setup){
   stage=name+'-schema';
   lastSqlState=undefined;lastGuard=undefined;lastErrorToken=undefined;lastPosition=undefined;
   const db='gre_cleanup_'+randomUUID().replaceAll('-','');await pool.query('CREATE DATABASE '+db);
   const client=new Pool({...pool.options,database:db});client.on('error',()=>{});
   try{
    await client.query("SELECT set_config('factuez.schema_target',$1,false)",[db]);await client.query(schema);
    await client.query(fs.readFileSync(path.join(root,'services/billing-service/prisma/integration-changes.sql'),'utf8'));
    await client.query(`INSERT INTO "CompanySettings" (id,ruc,"legalName","companyType","economicActivities","taxAddress",ubigeo,"contactEmails",environment,"updatedAt") VALUES (1,'20600979630','SYNTHETIC ONLY','SYNTHETIC',ARRAY[]::text[],'SYNTHETIC','150101',ARRAY[]::text[],'BETA',now()),(2,'20000000028','SECOND SYNTHETIC','SYNTHETIC',ARRAY[]::text[],'SYNTHETIC','150101',ARRAY[]::text[],'BETA',now());`);
    await client.query(`INSERT INTO "Branch" (id,"companyId",code,name,"establishmentCode") VALUES ($1,1,'SYNTHETIC','SYNTHETIC','0001'),($2,2,'SECOND','SECOND','0002')`,[id(2),id(22)]);
    await client.query(`INSERT INTO "EmissionPoint" (id,"companyId","branchId",code,name,"updatedAt") VALUES ($1,1,$2,'SYNTHETIC','SYNTHETIC',now()),($3,2,$4,'SECOND','SECOND',now())`,[id(3),id(2),id(23),id(22)]);
    await client.query(`INSERT INTO "SeriesCounter" (id,"companyId","emissionPointId","documentType",series,environment,"nextNumber","updatedAt") VALUES ($1,1,$2,'DESPATCH_ADVICE','T099','BETA',1,now()),($3,1,$2,'DESPATCH_ADVICE','T100','PRODUCTION',1,now()),($4,2,$5,'DESPATCH_ADVICE','T099','BETA',7,now())`,[id(99),id(3),id(100),id(299),id(23)]);
    await setup?.(client);
    stage=name+'-preview';const previewResults=await client.query(previewSql),snapshot=previewResults.flatMap(r=>r.rows??[]).find(r=>r.preview).preview;
    assert.equal(snapshot.preflightOnly,true);assert.equal(snapshot.rows.length,2);assert.equal(snapshot.rows[0].nextNumber,'1');assert.equal(snapshot.rows[0].environment,'BETA');assert.equal(snapshot.rows[1].environment,'PRODUCTION');
    assert.equal(snapshot.version,'factuez.gre-series-cleanup-preview.v2');assert.ok(!JSON.stringify(snapshot).includes('SYNTHETIC_DO_NOT_EMIT'));
    if(name==='both-empty')fs.writeFileSync(path.join(out,'preflight-example.json'),JSON.stringify(snapshot,null,2)+'\n');
    await mutate?.(client,snapshot);
    const before=(await client.query('SELECT row_to_json(s) AS value FROM "SeriesCounter" s ORDER BY id')).rows,auditBefore=(await client.query('SELECT row_to_json(a) AS value FROM "ConfigurationAudit" a ORDER BY id')).rows;
    let rejected=false,code,receipt;
    stage=name+'-delete';try{const result=await client.query(apply(snapshot));receipt=result.flatMap(r=>r.rows??[]).find(r=>r.deleted)?.deleted;}catch(e){rejected=true;code=e.code;lastSqlState=e.code;lastGuard=/^GRE_CLEANUP_[A-Z_]+$/.test(e.message??'')?e.message:'UNCLASSIFIED_GUARD';const token=String(e.message).match(/near "([A-Za-z_]{1,20})"/);lastErrorToken=token?.[1];lastPosition=/^\d+$/.test(e.position??'')?Number(e.position):undefined;await client.query('ROLLBACK');}
    assert.equal(rejected,!success,'CLEANUP_OUTCOME_'+name);
    const after=(await client.query('SELECT row_to_json(s) AS value FROM "SeriesCounter" s ORDER BY id')).rows;
    if(success){assert.equal(after.length,1);assert.deepEqual(after[0],before.find(r=>r.value.id===id(299)));}else assert.deepEqual(after,before,'CLEANUP_PARTIAL_WRITE_'+name);
    assert.deepEqual((await client.query('SELECT row_to_json(a) AS value FROM "ConfigurationAudit" a ORDER BY id')).rows,auditBefore,'AUDIT_MUST_REMAIN_IDENTICAL_'+name);
    if(success&&auditBefore.length){assert.equal(receipt.preservedCreationAudit.id,auditBefore[0].value.id);assert.match(receipt.preservedCreationAudit.sha256,/^[a-f0-9]{64}$/);}
    checks.push({name,outcome:success?'two-deleted-other-RUC-unchanged':'blocked-all-rows-preserved',...(code?{sqlState:code}:{})});sequence++;
   }finally{await client.testReleaseLock?.();await client.end();assert.match(db,/^gre_cleanup_[a-f0-9]{32}$/);await pool.query('DROP DATABASE "'+db+'"');}
  }
  await scenario('both-empty',undefined,true);
  await scenario('one-counter-used',db=>db.query('UPDATE "SeriesCounter" SET "nextNumber"=2 WHERE id=$1',[id(99)]));
  await scenario('environment-changed',db=>db.query('UPDATE "SeriesCounter" SET environment=\'PRODUCTION\' WHERE id=$1',[id(99)]));
  await scenario('target-missing',db=>db.query('DELETE FROM "SeriesCounter" WHERE id=$1',[id(100)]));
  await scenario('revision-changed',db=>db.query('UPDATE "SeriesCounter" SET "masterRevision"=2 WHERE id=$1',[id(100)]));
  await scenario('grant-even-disabled',db=>db.query('INSERT INTO "ProductionGuidesGrant" ("seriesCounterId","actorId",version,payload,"configuredBy") VALUES ($1,$2,1,\'{"enabled":false,"synthetic":true}\'::jsonb,$2)',[id(99),id(1)]));
  const document=async db=>db.query(`INSERT INTO "Document" (id,"companyId","seriesCounterId",type,status,series,number,"fullNumber","issueDate","emissionPointId","customerIdentityType","customerIdentityNumber","customerLegalName","taxableAmount","igvAmount","payableAmount","immutableSnapshot","updatedAt") VALUES ($1,1,$2,'DESPATCH_ADVICE','DRAFT','T099',1,'T099-1',now(),$3,'6','20000000028','SYNTHETIC',0,0,0,'{"environment":"BETA","synthetic":true}',now())`,[id(700),id(99),id(3)]);
  await scenario('document-even-draft',document);
  await scenario('integration-binding',async db=>{await document(db);await db.query('INSERT INTO "IntegrationChangeBinding" ("ownerId","companyId","issuerRuc","pointId","branchId","counterId",type,series) VALUES ($1,1,\'20600979630\',$2,$3,$4,\'DESPATCH_ADVICE\',\'T099\')',[id(700),id(3),id(2),id(99)]);});
  await scenario('reservation-with-document',async db=>{await document(db);await db.query('INSERT INTO "OutboxEvent" (id,"eventType","aggregateId",payload) VALUES ($1,\'SYNTHETIC\',\'SYNTHETIC\',\'{}\'::jsonb)',[id(701)]);await db.query('INSERT INTO "ProductionGuidesReservation" ("documentId","operationId","actorId","requestSha256","snapshotSha256","eventId",event) VALUES ($1,$2,$3,$4,$4,$5,\'{}\'::jsonb)',[id(700),id(702),id(1),'a'.repeat(64),id(701)]);});
  await scenario('outbox-counter-reference',db=>db.query('INSERT INTO "OutboxEvent" (id,"eventType","aggregateId",payload) VALUES ($1,\'SYNTHETIC\',\'SYNTHETIC\',$2::jsonb)',[id(900),JSON.stringify({seriesCounterId:id(100)})]));
  await scenario('future-cascade-FK',async db=>{await db.query('CREATE TABLE "SyntheticFutureReference" (id uuid PRIMARY KEY, counter uuid REFERENCES "SeriesCounter"(id) ON DELETE CASCADE)');await db.query('INSERT INTO "SyntheticFutureReference" VALUES ($1,$2)',[id(901),id(100)]);});
  await scenario('scoped-history-without-FK',db=>db.query('INSERT INTO "OutboxEvent" (id,"eventType","aggregateId",payload) VALUES ($1,\'SYNTHETIC\',\'SYNTHETIC\',$2::jsonb)',[id(902),JSON.stringify({snapshot:{companyId:1,series:'T099'}})]));
  await scenario('cross-RUC-snapshot',(_db,snapshot)=>{snapshot.rows[0].companyId=2;});
  const creationMetadata={companyId:1,issuerRuc:'20600979630',environment:'BETA',changedFields:['documentType','series'],softDelete:false};
  const creation=(metadata=creationMetadata,action='series.created',counter=id(99),auditId=id(930))=>async db=>{await db.query('INSERT INTO "ConfigurationAudit" (id,"actorId",action,"entityId",metadata) VALUES ($1,$2,$3,$4,$5::jsonb)',[auditId,id(1),action,counter,JSON.stringify(metadata)]);};
  await scenario('valid-creation-preserved-byte-for-byte',undefined,true,creation());
  for(const [name,metadata,action]of [
   ['audit-action-updated',creationMetadata,'series.updated'],
   ['audit-scope-company',{...creationMetadata,companyId:2}],['audit-scope-ruc',{...creationMetadata,issuerRuc:'20000000028'}],
   ['audit-environment',{...creationMetadata,environment:'PRODUCTION'}],['audit-soft-delete',{...creationMetadata,softDelete:true}],
   ['audit-unknown-extra',{...creationMetadata,secret:'SYNTHETIC_DO_NOT_EMIT'}],['audit-field-extra',{...creationMetadata,changedFields:['documentType','series','active']}],
   ['audit-field-duplicate',{...creationMetadata,changedFields:['series','series']}],['audit-field-type',{...creationMetadata,changedFields:'series'}],
  ])await scenario(name,undefined,false,creation(metadata,action));
  await scenario('audit-actor-changed-after-preview',db=>db.query('UPDATE "ConfigurationAudit" SET "actorId"=$1 WHERE id=$2',[id(5),id(930)]),false,creation());
  await scenario('audit-preview-tampered',(_db,snapshot)=>{snapshot.creationAudit[0].metadata.softDelete=true;},false,creation());
  await scenario('snapshot-v1-rejected',(_db,snapshot)=>{snapshot.version='factuez.gre-series-cleanup-preview.v1';},false,creation());
  await scenario('second-audit-after-preview',creation(creationMetadata,'series.created',id(99),id(931)),false,creation());
  await scenario('T100-creation-not-exempt',undefined,false,creation({...creationMetadata,environment:'PRODUCTION'},'series.created',id(100)));
  await scenario('valid-creation-plus-outbox',db=>db.query('INSERT INTO "OutboxEvent" (id,"eventType","aggregateId",payload) VALUES ($1,\'SYNTHETIC\',\'SYNTHETIC\',$2::jsonb)',[id(932),JSON.stringify({counterId:id(100)})]),false,creation());
  await scenario('other-session-lock-timeout',async db=>{const lock=await db.connect();await lock.query('BEGIN');await lock.query('SELECT id FROM "SeriesCounter" WHERE id=$1 FOR UPDATE',[id(99)]);db.testReleaseLock=async()=>{await lock.query('ROLLBACK');lock.release();};});
 });
 }catch(e){failures.push({stage,code:/^[A-Z_]+$/.test(String(e.message).split('\n')[0])?String(e.message).split('\n')[0]:'SYNTHETIC_CLEANUP_TEST_FAILED',sqlState:/^[A-Z0-9]{5}$/.test(e.code??'')?e.code:lastSqlState,guard:lastGuard,errorToken:lastErrorToken,position:lastPosition});process.exitCode=1;}
 finally{assert.ok(path.resolve(dir).startsWith(path.resolve(out)+path.sep));fs.rmSync(dir,{recursive:true,force:true});const result={synthetic:true,installationCommandsExecuted:0,checks,failures};fs.writeFileSync(path.join(out,'db-results.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));}
}
main();
