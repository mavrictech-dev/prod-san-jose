import { createRequire } from 'node:module';
import { describe,it,expect } from 'vitest';
import { B2bReports,BillingOwnerReportSources,PostgresBillingReportSources,PostgresReportsStore,reportsFilters } from '../services/billing-service/src/b2b/phase8-reports';
import { reportsSourcesFixture,reportsGuideSourcesFixture } from './b2b-phase8-reports-sources.fixture';
const {withPhase8ReportsDatabase}=createRequire(import.meta.url)('./b2b-phase8-reports-db-helper.cjs');
// Read-side query fixture only, in a NEW network-none/tmpfs database. These are
// the exact column names used by the existing owner tables, not a migration.
const ddl=`
CREATE TABLE "CompanySettings" ("id" integer PRIMARY KEY,"ruc" text,"environment" text);
CREATE TABLE "Branch" ("id" uuid PRIMARY KEY,"companyId" integer);
CREATE TABLE "EmissionPoint" ("id" uuid PRIMARY KEY,"companyId" integer,"branchId" uuid);
CREATE TABLE "SeriesCounter" ("id" uuid PRIMARY KEY,"companyId" integer,"emissionPointId" uuid,"documentType" text,"series" text);
CREATE TABLE "Document" ("id" uuid PRIMARY KEY,"companyId" integer,"emissionPointId" uuid,"seriesCounterId" uuid,"type" text,"series" text,"number" bigint,
 "fullNumber" text,"issueDate" timestamptz,"updatedAt" timestamptz,"status" text,"sunatStatus" text,"sunatResponseCode" text,
 "payableAmount" numeric(38,12),"immutableSnapshot" jsonb,"originSystem" text,"originId" text);
CREATE TABLE "B2bCommercialResource" ("id" uuid PRIMARY KEY,"kind" text,"environment" text,"clientId" uuid,"actorKey" text,"binding" jsonb,
 "body" jsonb,"state" text,"revision" integer,"commercialNumber" text,"completedSha256" text,"convertedDocumentId" uuid);
CREATE TABLE "B2bGuideIssueDocument" ("id" uuid PRIMARY KEY,"operationId" uuid,"draftId" uuid,"companyId" integer,"issuerRuc" text,"draftSeriesId" uuid,
 "fiscalSeriesId" uuid,"binding" jsonb,"series" text,"number" bigint,"snapshot" jsonb,"snapshotSha256" text);
CREATE TABLE "B2bGuideIssueReceipt" ("documentId" uuid PRIMARY KEY,"clientId" uuid,"actorKey" text,"payload" jsonb);
CREATE TABLE "B2bGuideIssueItem" ("documentId" uuid,"position" integer,"payload" jsonb);
CREATE TABLE "B2bGuideIssueLocalOutbox" ("documentId" uuid,"operationId" uuid,"eventType" text,"payload" jsonb);
CREATE TABLE "CarrierGuideDocument" ("documentId" uuid PRIMARY KEY,"operationId" uuid,"draftId" uuid,"companyId" integer,"issuerRuc" text,"draftSeriesId" uuid,
 "fiscalSeriesId" uuid,"binding" jsonb,"series" text,"number" bigint,"snapshot" jsonb,"snapshotSha256" text);
CREATE TABLE "CarrierGuideReceipt" ("documentId" uuid PRIMARY KEY,"clientId" uuid,"actorKey" text,"payload" jsonb);
CREATE TABLE "CarrierGuideItem" ("documentId" uuid,"position" integer,"payload" jsonb);
CREATE TABLE "CarrierGuideLocalOutbox" ("documentId" uuid,"operationId" uuid,"eventType" text,"payload" jsonb);
`;
async function seedDocument(pool:any,d:any){
  await pool.query('INSERT INTO "SeriesCounter" ("id","companyId","emissionPointId","documentType","series") VALUES ($1,1,$2,$3,$4) ON CONFLICT DO NOTHING',
    [d.seriesCounter.id,d.emissionPoint.id,d.type,d.series]);
  await pool.query(`INSERT INTO "Document" ("id","companyId","emissionPointId","seriesCounterId","type","series","number","fullNumber","issueDate","updatedAt","status",
    "sunatStatus","sunatResponseCode","payableAmount","immutableSnapshot") VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [d.id,d.emissionPoint.id,d.seriesCounter.id,d.type,d.series,String(d.number),d.fullNumber,d.issueDate,d.updatedAt,d.status,d.sunatStatus,d.sunatResponseCode,d.payableAmount,JSON.stringify(d.immutableSnapshot)]);
}
describe('B2B08 owner SQL in an exclusively NEW synthetic database',()=>{
  it('executes note/NV/09/31 queries, latest snapshots, exact scope filtering and durable replay',async()=>{
    await withPhase8ReportsDatabase(async({pool,database}:any)=>{
      expect((await pool.query('SELECT current_database() AS name')).rows[0].name).toBe(database);
      await pool.query(ddl);const f=reportsSourcesFixture(),b=f.p.bindings[0];
      await pool.query('INSERT INTO "CompanySettings" VALUES (1,$1,\'BETA\')',[b.issuerRuc]);
      await pool.query('INSERT INTO "Branch" VALUES ($1,1)',[b.branchId]);
      await pool.query('INSERT INTO "EmissionPoint" VALUES ($1,1,$2)',[b.pointId,b.branchId]);
      await seedDocument(pool,f.original);
      await seedDocument(pool,f.records[0].value.document);await seedDocument(pool,f.records[1].value.document);
      const nv=f.nv;await pool.query(`INSERT INTO "B2bCommercialResource" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [nv.id,nv.kind,nv.environment,nv.clientId,nv.actorKey,JSON.stringify(nv.binding),JSON.stringify(nv.body),nv.state,nv.revision,nv.commercialNumber,nv.completedSha256,nv.convertedDocumentId]);
      const sourceStore=new PostgresBillingReportSources(pool),jobs=new PostgresReportsStore(pool);
      const sources=new BillingOwnerReportSources(sourceStore,f.configuration());
      const core=new B2bReports(jobs,f.identity,f.port,{enabled:true,sources});
      const made=await core.execute(f.auth,'CREATE',f.input());expect(made.data.count).toBe(3);
      const dashboard=await core.execute(f.auth,'DASHBOARD',{filters:f.filters()});
      expect(dashboard.data.groups.find((g:any)=>g.type==='07').payableAmount).toBe('-118.00');
      expect(dashboard.data.netSales).toEqual([{currency:'PEN',payableAmount:'0.00'}]);
      // Actual current owner row replaces the preceding snapshot for a new capture.
      const changed=structuredClone(f.records[0].value.document.immutableSnapshot);changed.totals.payableAmount='59.00';
      await pool.query('UPDATE "Document" SET "payableAmount"=$2,"immutableSnapshot"=$3 WHERE "id"=$1',[f.records[0].value.document.id,'59.00',JSON.stringify(changed)]);
      const current=await core.execute(f.auth,'DASHBOARD',{filters:f.filters('07')});expect(current.data.groups[0].payableAmount).toBe('-59.00');
      const replay=await core.execute(f.auth,'CREATE',f.input());expect(replay.data).toEqual(made.data);expect(replay.replayed).toBe(true);
      const originalFile=await core.execute(f.auth,'CONTENT',{id:made.data.id});expect(originalFile.bytes.toString()).toContain('"-118.00"');
      const selected=reportsFilters({...f.filters('07'),seriesId:f.pairs[0].noteSeriesId},true);
      expect((await sourceStore.capture(f.p,selected,[f.records[0].access])).records).toHaveLength(1);
      // A foreign branch document never reaches projection or consumes the limit.
      await pool.query('UPDATE "EmissionPoint" SET "branchId"=$2 WHERE "id"=$1',[b.pointId,'90000000-0000-4000-8000-000000000099']);
      expect((await core.execute(f.auth,'DASHBOARD',{filters:f.filters('07')})).data.count).toBe(0);
      await pool.query('UPDATE "EmissionPoint" SET "branchId"=$2 WHERE "id"=$1',[b.pointId,b.branchId]);
      await pool.query('UPDATE "CompanySettings" SET "environment"=\'PRODUCTION\' WHERE "id"=1');
      expect((await core.execute(f.auth,'DASHBOARD',{filters:f.filters('07')})).data.count).toBe(0);
      for(const type of ['09','31'] as const){
        const g=await reportsGuideSourcesFixture(type),record=g.records[0],v=record.value,s=g.guideSnapshot,carrier=type==='31';
        const table=carrier?'CarrierGuide':'B2bGuideIssue',id=carrier?'documentId':'id';
        await pool.query(`INSERT INTO "${table}Document" ("${id}","operationId","draftId","companyId","issuerRuc","draftSeriesId","fiscalSeriesId","binding","series","number","snapshot","snapshotSha256")
          VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [s.documentId,s.operationId,s.draftId,s.issuer.ruc,s.binding.draft.guideSeriesId,s.binding.fiscalSeriesId,JSON.stringify(s.binding),s.series,s.number,JSON.stringify(s),v.header.snapshotSha256]);
        await pool.query(`INSERT INTO "${table}Receipt" VALUES ($1,$2,'SERVICE:-',$3)`,[s.documentId,g.p.clientId,JSON.stringify(v.receipt)]);
        for(const [i,item] of s.body.items.entries())await pool.query(`INSERT INTO "${table}Item" VALUES ($1,$2,$3)`,[s.documentId,i+1,JSON.stringify(item)]);
        await pool.query(`INSERT INTO "${table}LocalOutbox" VALUES ($1,$2,$3,$4)`,[s.documentId,s.operationId,v.events[0].eventType,JSON.stringify(s)]);
        const guideCore=new B2bReports(jobs,g.identity,g.port,{enabled:true,sources:new BillingOwnerReportSources(sourceStore,g.configuration())});
        const report=await guideCore.execute(g.auth,'CREATE',{...g.input,idempotencyKey:'synthetic_db_guide_report_'+type});expect(report.data.count).toBe(1);
        const data=await guideCore.execute(g.auth,'DASHBOARD',{filters:g.input.filters});
        expect(data.data.netSales).toEqual([]);expect(data.data.groups).toEqual([]);expect(data.data.transfers).toHaveLength(1);
        expect(data.data.transfers[0].grossWeight).toBe('1.25');
        const day=g.input.filters.from,later={...g.input.filters,from:day,to:day};
        // Exercise the SQL date boundary directly, before bundle projection.
        const nextDay=new Date(Date.parse(day)+86400000).toISOString().slice(0,10);
        await pool.query(`UPDATE "${table}Document" SET "snapshot"=jsonb_set("snapshot",'{body,issueDate}',to_jsonb($2::text)) WHERE "${id}"=$1`,[s.documentId,nextDay+'T04:59:59.000Z']);
        expect((await sourceStore.capture(g.p,reportsFilters(later,true),[record.access])).records).toHaveLength(1);
        await pool.query(`UPDATE "${table}Document" SET "snapshot"=jsonb_set("snapshot",'{body,issueDate}',to_jsonb($2::text)) WHERE "${id}"=$1`,[s.documentId,nextDay+'T05:00:00.000Z']);
        expect((await sourceStore.capture(g.p,reportsFilters(later,true),[record.access])).records).toHaveLength(0);
        const denied=structuredClone(g.p);denied.bindings=[];
        await expect(sourceStore.capture(denied as any,reportsFilters(later,true),[record.access])).rejects.toMatchObject({code:'INVALID_REPORT_SOURCE_CONFIGURATION'});
      }
    });
  });
});



