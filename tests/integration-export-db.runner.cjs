'use strict';
const assert=require('node:assert/strict');
const {randomUUID,randomBytes,createHash}=require('node:crypto');
const {readFileSync}=require('node:fs');
const host=process.env.FIXTURE_DATABASE_HOST,password=process.env.FIXTURE_DATABASE_PASSWORD;
assert.match(host??'',/^factuez-i5-[a-f0-9]{8}-db$/);assert.match(password??'',/^[A-Za-z0-9_-]{43}$/);
const base='/workspace/services/billing-service',moduleBase=base+'/dist/integration-export';
const {Pool,Client}=require(base+'/node_modules/pg');
const {PrismaService}=require(base+'/dist/infrastructure/prisma.service');
const {PostgresExportStore}=require(moduleBase+'/postgres-store');
const {ExportVault}=require(moduleBase+'/vault');
const {IntegrationExports,binding}=require(moduleBase+'/core');
const {BillingCapture}=require(base+'/dist/integration/capture');
const {PrismaBillingCapture}=require(base+'/dist/integration/capture-repository');
const {snapshotHash}=require('/workspace/packages/service-access/dist/integration');
const connectionString=`postgresql://integration_fixture:${password}@${host}:5432/integration_fixture`;
process.env.DATABASE_URL=connectionString;
let sql,pool,db,checks=0,stage='connect-new-database';const pass=()=>{checks++;};
async function connect(){for(let i=0;i<40;i++){const c=new Client({connectionString});try{await c.connect();return c;}catch{await c.end().catch(()=>{});await new Promise(r=>setTimeout(r,250));}}throw new Error('New fixture unavailable');}
const ruc='20555555555',clientId=randomUUID(),branch=randomUUID(),point=randomUUID(),counter=randomUUID();
const principal={clientId,revision:1,environment:'BETA',scopes:['integration:documents:read','integration:exports:create','integration:exports:read'],
 grants:[{issuerRuc:ruc,environment:'BETA',documentTypes:['01'],branches:{kind:'ALL'},points:{kind:'ALL'},series:{kind:'ALL'}}]};
const identity={authenticate:async(token)=>{assert.equal(token,'fictitious-integration-token');return structuredClone(principal);}};
const date='2026-01-01T12:00:00.000Z';
function snapshot(id,number){return {companyId:1,branchId:branch,environment:'BETA',documentId:id,documentTypeCode:'01',series:'F001',number:String(number),
 fullNumber:'F001-'+number,issueDate:date,currencyCode:'PEN',issuer:{identityType:'6',identityNumber:ruc,legalName:'FICTITIOUS DB OWNER'},
 customer:{identityType:'0',identityNumber:'0',legalName:'FICTITIOUS DB CLIENT'},lines:[{lineNumber:1,description:'FICTITIOUS',unitCode:'NIU',quantity:'1',
 unitValue:'100',unitPriceWithTax:'118',lineExtensionAmount:'100',igvAmount:'18',igvRate:'18',taxAffectationCode:'10'}],totals:{taxableAmount:'100',igvAmount:'18',payableAmount:'118'}};}
function record(kind='EXPORT',keyHash=createHash('sha256').update(randomBytes(8)).digest('hex')){return {id:randomUUID(),kind,clientId,contextSha256:snapshotHash(principal),issuerRuc:ruc,
 keyHash:kind==='CUT'?null:keyHash,requestSha256:kind==='CUT'?null:'b'.repeat(64),createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+300000).toISOString(),state:'CAPTURING',
 payload:null,content:null,contentSha256:null,manifestSha256:null,failureCode:null,lease:null};}
async function run(){
 await sql.query(readFileSync('/fixture/export.sql','utf8'));await sql.query(`CREATE TABLE "CompanySettings" (id integer PRIMARY KEY,ruc char(11));
 CREATE TABLE "Branch" (id uuid PRIMARY KEY,"companyId" integer);
 CREATE TABLE "EmissionPoint" (id uuid PRIMARY KEY,"companyId" integer,"branchId" uuid);
 CREATE TABLE "SeriesCounter" (id uuid PRIMARY KEY,"companyId" integer,"emissionPointId" uuid,"documentType" text,series text);
 CREATE TABLE "Document" (id uuid PRIMARY KEY,"companyId" integer,"emissionPointId" uuid,"seriesCounterId" uuid,type text,series text,number bigint,
 "fullNumber" text,"issueDate" timestamptz,status text,"sunatStatus" text,"sunatResponseCode" text,"originSystem" text,"originId" text,
 "payableAmount" numeric(16,2),"updatedAt" timestamptz,"immutableSnapshot" jsonb);`);
 await sql.query('INSERT INTO "CompanySettings" VALUES (1,$1)',[ruc]);await sql.query('INSERT INTO "Branch" VALUES ($1,1)',[branch]);
 await sql.query('INSERT INTO "EmissionPoint" VALUES ($1,1,$2)',[point,branch]);await sql.query('INSERT INTO "SeriesCounter" VALUES ($1,1,$2,$3,$4)',[counter,point,'INVOICE','F001']);
 const records=Array.from({length:1201},(_,i)=>{const id=randomUUID();return {id,number:i+1,snapshot:snapshot(id,i+1)};});
 await sql.query(`INSERT INTO "Document" SELECT id::uuid,1,$2::uuid,$3::uuid,'INVOICE','F001',number,'F001-'||number,$4::timestamptz,
 'ISSUED','ACCEPTED','0',NULL,NULL,118,$4::timestamptz,snapshot FROM jsonb_to_recordset($1::jsonb) AS r(id text,number bigint,snapshot jsonb)`,
 [JSON.stringify(records),point,counter,date]);
 const capture=new BillingCapture(new PrismaBillingCapture(db),identity);
 const query={issuerRuc:ruc,from:'2026-01-01',to:'2026-01-01',types:'01'};
 let result=await capture.capture('fictitious-integration-token',query);assert.equal(result.documents.length,1201);pass();
 assert.ok(result.coverage.complete);assert.equal(result.documents[0].detail.items[0].description,'FICTITIOUS');pass();
 assert.ok(result.documents.every(d=>d.state.fiscal==='NOT_CHECKED'));pass();
 assert.equal((await capture.reauthorize('fictitious-integration-token',{issuerRuc:ruc,bindings:result.documents.map(binding)})).valid,true);pass();
 assert.equal((await capture.capture('fictitious-integration-token',{...query,from:'2026-01-02',to:'2026-01-02'})).documents.length,0);pass();
 principal.grants[0].points={kind:'IDS',ids:[]};await assert.rejects(capture.capture('fictitious-integration-token',query),e=>e.code==='RESOURCE_NOT_FOUND');pass();principal.grants[0].points={kind:'ALL'};
 // Update between keyset pages. RepeatableRead must keep all captured state at the original transaction snapshot.
 let changed=false;const intercepted={$transaction:(work,options)=>db.$transaction(tx=>work(new Proxy(tx,{get(target,key){if(key==='$queryRawUnsafe')return async(...args)=>{
   const rows=await target.$queryRawUnsafe(...args);if(!changed&&String(args[0]).startsWith('SELECT d.')){changed=true;await sql.query('UPDATE "Document" SET "sunatStatus"=$1',[ 'REJECTED' ]);}
   return rows;};const value=target[key];return typeof value==='function'?value.bind(target):value;}})),options)};
 const consistent=await new BillingCapture(new PrismaBillingCapture(intercepted),identity).capture('fictitious-integration-token',query);
 assert.ok(changed);assert.ok(consistent.documents.every(d=>d.state.transport==='ACCEPTED'));pass();
 const later=await capture.capture('fictitious-integration-token',query);assert.ok(later.documents.every(d=>d.state.transport==='REJECTED'));pass();
 // The uncompressed JSON budget rejects the row before any snapshot projection/mapper can read it.
 await sql.query(`UPDATE "Document" SET "immutableSnapshot"=jsonb_set("immutableSnapshot",'{lines,0,description}',to_jsonb(repeat('X',16777217))) WHERE id=$1`,[records[0].id]);
 await assert.rejects(capture.capture('fictitious-integration-token',query),e=>e.code==='EXPORT_TOO_LARGE');pass();
 await sql.query('UPDATE "Document" SET "immutableSnapshot"=$2 WHERE id=$1',[records[0].id,JSON.stringify(records[0].snapshot)]);
 const store=new PostgresExportStore(pool);await store.readySchema();pass();
 const candidate=record(),dupe=await Promise.all([store.reserve(candidate),store.reserve({...candidate,id:randomUUID()})]);
 assert.equal(dupe.filter(r=>r.created).length,1);assert.equal(dupe[0].record.id,dupe[1].record.id);pass();
 const vault=new ExportVault(randomBytes(32)),encrypted=vault.seal(Buffer.from('FICTITIOUS CONFIDENTIAL'),'fixture');
 await store.captured(candidate.id,encrypted,'QUEUED');assert.equal((await store.get(candidate.id,clientId)).payload.toString('hex'),encrypted.toString('hex'));pass();
 const restarted=new PostgresExportStore(pool);assert.equal((await restarted.byKey(clientId,candidate.keyHash)).id,candidate.id);pass();
 assert.equal(await restarted.get(candidate.id,randomUUID()),null);pass();
 const claims=await Promise.all([store.claim(new Date().toISOString()),restarted.claim(new Date().toISOString())]);assert.equal(claims.filter(Boolean).length,1);pass();
 const claim=claims.find(Boolean);await assert.rejects(store.ready(candidate.id,randomUUID(),encrypted,encrypted,'c'.repeat(64),'d'.repeat(64),new Date(Date.now()+86400000).toISOString()));pass();
 await store.ready(candidate.id,claim.lease,encrypted,encrypted,'c'.repeat(64),'d'.repeat(64),new Date(Date.now()+86400000).toISOString());
 assert.equal((await store.get(candidate.id,clientId)).state,'READY');pass();
 await store.audit({clientId,revision:1,recordId:candidate.id,operation:'DOWNLOAD',sha256:'c'.repeat(64),byteLength:32});
 assert.equal((await sql.query('SELECT count(*)::int AS n FROM "IntegrationExportAudit"')).rows[0].n,1);pass();
 const other=record();await store.reserve(other);await store.captured(other.id,encrypted,'QUEUED');const leased=await store.claim(new Date().toISOString());
 await sql.query('UPDATE "IntegrationExportRecord" SET "leaseExpiresAt"=clock_timestamp()-interval \'1 second\' WHERE id=$1',[other.id]);
 const recovered=await store.claim(new Date().toISOString());assert.equal(recovered.id,other.id);assert.notEqual(recovered.lease,leased.lease);pass();
 await store.fail(other.id,'INTEGRITY_FAILED',leased.lease);assert.equal((await store.get(other.id,clientId)).state,'RUNNING');pass();
 await store.fail(other.id,'INTEGRITY_FAILED',recovered.lease);assert.equal((await store.get(other.id,clientId)).payload,null);pass();
 const expired=record();await store.reserve(expired);await store.captured(expired.id,encrypted,'QUEUED');const expiringLease=await store.claim(new Date().toISOString());
 await sql.query('UPDATE "IntegrationExportRecord" SET "expiresAt"=clock_timestamp()-interval \'1 second\' WHERE id=$1',[expired.id]);
 await assert.rejects(store.ready(expired.id,expiringLease.lease,encrypted,encrypted,'c'.repeat(64),'d'.repeat(64),new Date(Date.now()+86400000).toISOString()));
 assert.equal((await store.get(expired.id,clientId)).state,'RUNNING');pass();
 await sql.query('UPDATE "IntegrationExportRecord" SET "expiresAt"=clock_timestamp()-interval \'1 second\' WHERE id=$1',[candidate.id]);
 await store.sweep(new Date().toISOString());assert.equal((await store.get(candidate.id,clientId)).content,null);assert.equal((await store.get(candidate.id,clientId)).state,'EXPIRED');pass();
 assert.equal((await sql.query('SELECT count(*)::int AS n FROM "Document"')).rows[0].n,1201);pass();
 // End-to-end cut and metadata-only asynchronous export on the new PostgreSQL store, not an in-memory queue.
 const owner={json:async(path,token,body)=>path.endsWith('/capture')?capture.capture(token,body):capture.reauthorize(token,body),bytes:async()=>{throw new Error('Forbidden fixture path');}};
 const core=new IntegrationExports(store,vault,identity,owner,owner);
 const page=await core.documents('fictitious-integration-token',{...query,limit:'500'});assert.equal(page.items.length,500);assert.ok(page.page.nextCursor);pass();
 const coreAfterRestart=new IntegrationExports(new PostgresExportStore(pool),vault,identity,owner,owner);
 const page2=await coreAfterRestart.documents('fictitious-integration-token',{...query,limit:'500',cursor:page.page.nextCursor});assert.equal(page2.items.length,500);
 assert.equal(new Set([...page.items,...page2.items].map(d=>d.id)).size,1000);pass();
 const job=await core.create('fictitious-integration-token','fictitious-pg-key-000001',{filters:{issuerRuc:ruc,from:query.from,to:query.to,types:['01']},artifactKinds:[],missingArtifacts:'FAIL',dataFormat:'JSONL'});
 assert.equal(job.state,'QUEUED');await coreAfterRestart.runOne();assert.equal((await core.status('fictitious-integration-token',job.id,ruc)).state,'READY');pass();
 const manifest=await core.manifest('fictitious-integration-token',job.id,ruc),archive=await core.content('fictitious-integration-token',job.id,ruc);
 assert.equal(manifest.documentCount,1201);assert.equal(archive.bytes.readUInt32LE(0),0x04034b50);pass();
 const saved=await store.get(job.id,clientId,true);assert.ok(!saved.payload.includes(Buffer.from('FICTITIOUS DB CLIENT'))&&!saved.content.includes(Buffer.from('FICTITIOUS DB CLIENT')));pass();
 await sql.query('DROP TABLE "IntegrationExportAudit"');await assert.rejects(core.content('fictitious-integration-token',job.id,ruc));pass();
}
(async()=>{try{sql=await connect();pool=new Pool({connectionString,max:4});db=new PrismaService();await db.$connect();stage='synthetic-schema-and-cut-export';await run();
 console.log(JSON.stringify({result:'PASS',checks,realData:false,sourceDocuments:1201,credentialsAndOutboxAbsent:true}));
 }catch(error){console.log(JSON.stringify({result:'FAIL',stage,checks,realData:false,errorClass:error?.constructor?.name??'Unknown'}));process.exitCode=1;}
 finally{await db?.$disconnect().catch(()=>{});await pool?.end().catch(()=>{});await sql?.end().catch(()=>{});}})();
