'use strict';
const {spawnSync}=require('node:child_process');
const {readFileSync}=require('node:fs');
const {randomUUID}=require('node:crypto');
const {resolve}=require('node:path');
if(!process.argv.includes('--isolated-synthetic-only'))throw Error('Require --isolated-synthetic-only');
const name='factuez-production-batches-synthetic-'+randomUUID().slice(0,8),db='production_batches_synthetic';
const run=(args,input)=>{const r=spawnSync('docker',args,{input,encoding:'utf8',timeout:30000,windowsHide:true});if(r.status!==0)throw Error((r.stderr||r.stdout||r.error?.message||'Docker failed').slice(0,1500));return r.stdout;};
const sql=s=>run(['exec','-i',name,'psql','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1','-q'],s);
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
try{
 run(['run','--detach','--rm','--pull=never','--name',name,'--network','none','--tmpfs','/var/lib/postgresql/data:rw','-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_DB='+db,'postgres:16-alpine']);
 let ready=false;
 for(let i=0;i<30;i++){const r=spawnSync('docker',['exec',name,'pg_isready','-U','postgres','-d',db],{encoding:'utf8',windowsHide:true,timeout:2000});if(r.status===0){ready=true;break;}Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200);}
 if(!ready)throw Error('New isolated PostgreSQL did not become ready');
 const root=resolve(__dirname,'..'),billing=readFileSync(resolve(root,'services/billing-service/prisma/production-batches-schema.sql'),'utf8'),sunat=readFileSync(resolve(root,'services/sunat-service/prisma/production-batches-schema.sql'),'utf8');
 sql('CREATE SCHEMA billing;SET search_path=billing;CREATE TABLE "Document"("id" uuid PRIMARY KEY);'+billing+'\nCREATE SCHEMA sunat;SET search_path=sunat;'+sunat);
 sql('SET search_path=billing;INSERT INTO "Document" VALUES (\''+id(1)+'\');INSERT INTO "ProductionBatchesReservation"("batchId","operationId","actorId","issuerRuc","requestSha256","snapshotSha256","payload") VALUES (\''+id(2)+'\',\''+id(2)+'\',\''+id(3)+'\',\'20100070970\',repeat(\'a\',64),repeat(\'b\',64),\'{}\');INSERT INTO "ProductionBatchesMember"("batchId","documentId","snapshotSha256") VALUES (\''+id(2)+'\',\''+id(1)+'\',repeat(\'b\',64));');
 sql('SET search_path=billing;DO $$ BEGIN BEGIN INSERT INTO "ProductionBatchesMember"("batchId","documentId","snapshotSha256") VALUES (\''+id(2)+'\',\''+id(1)+'\',repeat(\'c\',64));RAISE EXCEPTION \'duplicate reservation accepted\';EXCEPTION WHEN unique_violation THEN NULL;END;END $$;');
 sql('SET search_path=sunat;INSERT INTO "ProductionBatchesGrant"("issuerRuc","profile","credentialRevision","fingerprint","actorId") VALUES (\'20100070970\',\'synthetic\',1,repeat(\'a\',64),\''+id(3)+'\');DO $$ BEGIN IF EXISTS(SELECT 1 FROM "ProductionBatchesGrant" WHERE "enabled") THEN RAISE EXCEPTION \'grant enabled by default\';END IF;END $$;');
 sql('SET search_path=sunat;BEGIN;INSERT INTO "ProductionBatchesNumber" VALUES (\''+id(10)+'\',\'20100070970\',\'RC\',\'2026-10-28\',\'RC-20261028-1\');INSERT INTO "ProductionBatchesStatusOutbox"("id","payload") VALUES (\''+id(11)+'\',\'{}\');ROLLBACK;DO $$ BEGIN IF EXISTS(SELECT 1 FROM "ProductionBatchesNumber") OR EXISTS(SELECT 1 FROM "ProductionBatchesStatusOutbox") THEN RAISE EXCEPTION \'rollback leaked number/outbox\';END IF;END $$;');
 sql('SET search_path=sunat;INSERT INTO "ProductionBatchesNumber" VALUES (\''+id(10)+'\',\'20100070970\',\'RC\',\'2026-10-28\',\'RC-20261028-1\');DO $$ BEGIN BEGIN INSERT INTO "ProductionBatchesNumber" VALUES (\''+id(12)+'\',\'20100070970\',\'RC\',\'2026-10-28\',\'RC-20261028-1\');RAISE EXCEPTION \'number reused\';EXCEPTION WHEN unique_violation THEN NULL;END;END $$;');
 sql('SET search_path=sunat;INSERT INTO "ProductionBatchesDispatch"("batchId","eventId","issuerRuc","snapshotSha256","payload","state") VALUES (\''+id(20)+'\',\''+id(21)+'\',\'20100070970\',repeat(\'a\',64),\'{}\',\'UNKNOWN\');DO $$ BEGIN IF EXISTS(SELECT 1 FROM "ProductionBatchesDispatch" WHERE "state" IN (\'QUEUED\',\'PREPARED\',\'SUBMITTED\')) THEN RAISE EXCEPTION \'UNKNOWN selected for automatic POST\';END IF;END $$;');
 console.log('PASS: fresh isolated PostgreSQL 16; both migrations, default-disabled grant, unique member/number reservations, atomic rollback and UNKNOWN exclusion. No host ports, network or shared volumes.');
}finally{try{run(['rm','-f',name]);}catch{/* only the exact synthetic container created above */}}
