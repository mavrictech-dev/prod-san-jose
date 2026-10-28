'use strict';
// Minimal synthetic schema intentionally omits credentials, Outbox and nextNumber.
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {randomUUID,createHash}=require('node:crypto');
const owner=process.env.FIXTURE_OWNER,host=process.env.FIXTURE_DATABASE_HOST,password=process.env.FIXTURE_DATABASE_PASSWORD;
assert.ok(['billing-service','sunat-service'].includes(owner));
assert.match(host??'',/^factuez-i4-[a-f0-9]{8}-(billing|sunat)$/);assert.match(password??'',/^[A-Za-z0-9_-]{43}$/);
const base='/workspace/services/'+owner;
const {Client}=require(base+'/node_modules/pg');
const {PrismaService}=require(base+'/dist/infrastructure/prisma.service');
const {snapshotHash}=require('/workspace/packages/service-access/dist/integration');
const ruc='20555555555',branch='10000000-0000-4000-8000-000000000001',point='20000000-0000-4000-8000-000000000001',
 counter='30000000-0000-4000-8000-000000000001',document='40000000-0000-4000-8000-000000000001',
 receipt='40000000-0000-4000-8000-000000000002',batch='50000000-0000-4000-8000-000000000001',
 summary='60000000-0000-4000-8000-000000000001',artifact='70000000-0000-4000-8000-000000000001';
const date='2026-01-01T12:00:00.000Z';
function snapshot(id=document,type='01') {const series=type==='03'?'B001':'F001';return {companyId:1,branchId:branch,environment:'BETA',
 documentId:id,documentTypeCode:type,series,number:'1',fullNumber:series+'-1',issueDate:date,currencyCode:'PEN',operationTypeCode:'0101',
 issuer:{identityType:'6',identityNumber:ruc,legalName:'FICTITIOUS DB OWNER'},customer:{identityType:'0',identityNumber:'0',legalName:'FICTITIOUS DB CLIENT'},
 lines:[{lineNumber:1,description:'FICTITIOUS',unitCode:'NIU',quantity:'1',unitValue:'100',unitPriceWithTax:'118',
 lineExtensionAmount:'100.00',igvAmount:'18.00',igvRate:'18',taxAffectationCode:'10'}],totals:{taxableAmount:'100.00',igvAmount:'18.00',payableAmount:'118.00'}};}
const connectionString=`postgresql://integration_fixture:${password}@${host}:5432/integration_fixture`;
process.env.DATABASE_URL=connectionString;
let sql,db,checks=0,stage='connect-new-fixture';
const pass=()=>{checks++;};
async function connect() {for(let n=0;n<40;n++) {const c=new Client({connectionString,connectionTimeoutMillis:500});try{await c.connect();return c;}catch{await c.end().catch(()=>{});await new Promise(r=>setTimeout(r,250));}}throw new Error('Fixture PostgreSQL unavailable');}
async function billing() {
 await sql.query(`CREATE TYPE "SunatEnvironment" AS ENUM ('BETA','PRODUCTION');
 CREATE TYPE "DocumentType" AS ENUM ('INVOICE','SALES_RECEIPT','CREDIT_NOTE','DEBIT_NOTE','DESPATCH_ADVICE');
 CREATE TYPE "DocumentStatus" AS ENUM ('DRAFT','ISSUED','CANCELLED');
 CREATE TYPE "SunatStatus" AS ENUM ('PENDING','QUEUED','PROCESSING','SUMMARY_PENDING','ACCEPTED','ACCEPTED_WITH_OBSERVATIONS','REJECTED','RETRYABLE_ERROR','PERMANENT_ERROR','VOID_PENDING','VOIDED');
 CREATE TABLE "CompanySettings" (id integer PRIMARY KEY,ruc char(11) UNIQUE,"legalName" text,environment "SunatEnvironment",active boolean);
 CREATE TABLE "Branch" (id uuid PRIMARY KEY,"companyId" integer,code text,name text,address text,active boolean);
 CREATE TABLE "EmissionPoint" (id uuid PRIMARY KEY,"companyId" integer,"branchId" uuid,code text,name text,active boolean);
 CREATE TABLE "SeriesCounter" (id uuid PRIMARY KEY,"companyId" integer,"emissionPointId" uuid,"documentType" "DocumentType",series text,active boolean);
 CREATE TABLE "Document" (id uuid PRIMARY KEY,"companyId" integer,"emissionPointId" uuid,"seriesCounterId" uuid,type "DocumentType",series text,number bigint,
 "fullNumber" text,"issueDate" timestamptz,status "DocumentStatus","sunatStatus" "SunatStatus","sunatResponseCode" text,"originSystem" text,"originId" text,
 "payableAmount" numeric(16,2),"updatedAt" timestamptz,"immutableSnapshot" jsonb);
 CREATE TABLE "DailySummary" (id uuid PRIMARY KEY,"companyId" integer,identifier text);
 CREATE TABLE "DailySummaryItem" (id uuid PRIMARY KEY,"dailySummaryId" uuid,"documentId" uuid,"lineNumber" integer,"conditionCode" text);`);
 await sql.query('INSERT INTO "CompanySettings" VALUES (1,$1,$2,$3,true)',[ruc,'FICTITIOUS DB OWNER','BETA']);
 await sql.query('INSERT INTO "Branch" VALUES ($1,1,$2,$3,NULL,true)',[branch,'QA','FICTITIOUS']);
 await sql.query('INSERT INTO "EmissionPoint" VALUES ($1,1,$2,$3,$4,true)',[point,branch,'QA','FICTITIOUS']);
 await sql.query('INSERT INTO "SeriesCounter" VALUES ($1,1,$2,$3,$4,true)',[counter,point,'INVOICE','F001']);
 await sql.query('INSERT INTO "Document" VALUES ($1,1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,NULL,NULL,118,$7,$11)',
 [document,point,counter,'INVOICE','F001','F001-1',date,'ISSUED','ACCEPTED','0',JSON.stringify(snapshot())]);
 await sql.query('INSERT INTO "DailySummary" VALUES ($1,1,$2)',[summary,'RC-20260101-1']);
 await sql.query('INSERT INTO "DailySummaryItem" VALUES ($1,$2,$3,1,$4)',[randomUUID(),summary,document,'1']);
 const {PrismaBillingRead}=require(base+'/dist/integration/repository'),{BillingRead}=require(base+'/dist/integration/read');
 const repository=new PrismaBillingRead(db);
 const p={clientId:randomUUID(),revision:1,environment:'BETA',scopes:['integration:documents:read','integration:catalog:read'],
 grants:[{issuerRuc:ruc,environment:'BETA',documentTypes:['01'],branches:{kind:'ALL'},points:{kind:'ALL'},series:{kind:'ALL'}}]};
 const core=new BillingRead(repository,{authenticate:async()=>p});
 const row=await repository.document(ruc,{id:document});assert.equal(row.company.ruc,ruc);assert.equal(row.number,1n);pass();
 assert.equal(row.seriesCounter.id,counter);assert.ok(!Object.hasOwn(row.seriesCounter,'nextNumber'));pass();
 const detail=(await core.document('fictitious',ruc,document)).document;assert.equal(detail.detail.items[0].description,'FICTITIOUS');pass();
 assert.equal(detail.state.fiscal,'NOT_CHECKED');assert.equal(detail.snapshotSha256,snapshotHash(snapshot()));pass();
 assert.equal((await core.lookup('fictitious',{issuerRuc:ruc,type:'01',series:'F001',number:'0001'})).document.id,document);pass();
 const c=await core.catalog('fictitious',ruc);assert.equal(c.points[0].series[0].label,'F001');assert.equal(c.branches[0].establishmentCode,null);pass();
 assert.equal(c.points.length,1);assert.equal(c.issuer.environment,'BETA');pass();
 assert.equal((await core.batch('fictitious',ruc,summary)).items[0].documentId,document);pass();
 assert.equal(await repository.document('20444444444',{id:document}),null);assert.equal(await repository.catalog('20444444444'),null);pass();
 await sql.query('UPDATE "CompanySettings" SET environment=$1 WHERE id=1',['PRODUCTION']);assert.equal(await repository.catalog(ruc),null);pass();
 // Frozen BETA identity is not reclassified from today's mutable company environment.
 assert.equal((await core.document('fictitious',ruc,document)).document.environment,'BETA');pass();
}
async function sunat() {
 await sql.query(`CREATE TYPE "SunatEnvironment" AS ENUM ('BETA','PRODUCTION');
 CREATE TYPE "ArtifactKind" AS ENUM ('UNSIGNED_XML','SIGNED_XML','SUBMISSION_ZIP','CDR_XML','CDR_ZIP','PDF_TICKET_80MM','PDF_A4','DELIVERY_ZIP');
 CREATE TABLE "FiscalDocument" ("documentId" uuid PRIMARY KEY,"issuerRuc" char(11),environment "SunatEnvironment","documentType" text,series text,number bigint,"immutablePayload" jsonb);
 CREATE TABLE "FiscalBatch" (id uuid PRIMARY KEY,"summaryId" uuid,"issuerRuc" char(11),environment "SunatEnvironment",identifier text,"immutablePayload" jsonb);
 CREATE TABLE "DocumentArtifact" (id uuid PRIMARY KEY,"documentId" uuid,kind "ArtifactKind","storageKey" text,"mediaType" text,"sizeBytes" bigint,sha256 char(64),"createdAt" timestamptz);
 CREATE TABLE "BatchArtifact" (id uuid PRIMARY KEY,"batchId" uuid,kind "ArtifactKind","storageKey" text,"mediaType" text,"sizeBytes" bigint,sha256 char(64),"createdAt" timestamptz);
 CREATE TABLE "SunatSubmission" (id uuid PRIMARY KEY,"batchId" uuid);
 CREATE TABLE "CdrLog" (id uuid PRIMARY KEY,"documentId" uuid,"batchId" uuid,"submissionId" uuid);`);
 await sql.query(readFileSync('/fixture/audit.sql','utf8'));
 const bytes=Buffer.from('<fiction/>'),sha=createHash('sha256').update(bytes).digest('hex'),storage=document+'/fiction.xml';
 await sql.query('INSERT INTO "FiscalDocument" VALUES ($1,$2,$3,$4,$5,1,$6)',[document,ruc,'BETA','01','F001',JSON.stringify(snapshot())]);
 await sql.query('INSERT INTO "FiscalBatch" VALUES ($1,$2,$3,$4,$5,$6)',[batch,summary,ruc,'BETA','RC-20260101-1',JSON.stringify(snapshot(receipt,'03'))]);
 await sql.query('INSERT INTO "DocumentArtifact" VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',[artifact,document,'CDR_XML',storage,'application/xml',bytes.length,sha,date]);
 const {PrismaSunatRead}=require(base+'/dist/integration/repository');const repository=new PrismaSunatRead(db);await repository.ready();pass();
 const d=await repository.document(ruc,document);assert.equal(d.artifacts[0].id,artifact);assert.equal(snapshotHash(d.immutablePayload),snapshotHash(snapshot()));pass();
 assert.equal((await repository.batch(ruc,batch)).summaryId,summary);pass();
 assert.equal((await repository.artifact(ruc,artifact)).owner.id,document);pass();
 assert.equal(await repository.artifact('20444444444',artifact),null);assert.equal(await repository.document('20444444444',document),null);pass();
 const copied={...d.artifacts[0]};assert.deepEqual(await repository.sharedCdr(ruc,copied,document),[]);pass();
 const submission=randomUUID();await sql.query('INSERT INTO "SunatSubmission" VALUES ($1,$2)',[submission,batch]);
 await sql.query('INSERT INTO "CdrLog" VALUES ($1,$2,$3,$4)',[randomUUID(),document,batch,submission]);
 await assert.rejects(repository.sharedCdr(ruc,copied,document),/INCOMPLETE_BINDING/);pass();
 const batchArtifact=randomUUID();await sql.query('INSERT INTO "BatchArtifact" VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
 [batchArtifact,batch,'CDR_XML',batch+'/fiction.xml','application/xml',bytes.length,sha,date]);
 assert.equal((await repository.sharedCdr(ruc,copied,document))[0].batchId,batch);pass();
 assert.equal((await repository.artifact(ruc,batchArtifact)).owner.kind,'BATCH');pass();
 await repository.audit({id:randomUUID(),clientId:randomUUID(),revision:1,issuerRuc:ruc,artifactId:artifact,sha256:sha,byteLength:bytes.length});
 assert.equal((await sql.query('SELECT count(*)::integer AS count FROM "IntegrationReadAudit"')).rows[0].count,1);pass();
 await sql.query('DROP TABLE "IntegrationReadAudit"');await assert.rejects(repository.ready());await assert.rejects(repository.audit({id:randomUUID(),clientId:randomUUID(),revision:1,issuerRuc:ruc,artifactId:artifact,sha256:sha,byteLength:bytes.length}));pass();
}
(async()=>{try{sql=await connect();stage='new-synthetic-schema';db=new PrismaService();await db.$connect();
 if(owner==='billing-service') await billing();else await sunat();console.log(JSON.stringify({result:'PASS',owner,checks,realData:false,credentialsTablesAbsent:true}));
 }catch{console.log(JSON.stringify({result:'FAIL',owner,stage,checks,realData:false}));process.exitCode=1;
 }finally{await db?.$disconnect().catch(()=>{});await sql?.end().catch(()=>{});}})();
