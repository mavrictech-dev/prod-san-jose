import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {B2bReportRetention,FixedReportRetentionPolicy} from '../services/billing-service/src/b2b/phase8-reports/retention';
import {B2bReports,PostgresReportsStore} from '../services/billing-service/src/b2b/phase8-reports';
import {reportsFixture,createInput} from './b2b-phase8-reports.fixture';
const {withPhase8ReportsDatabase}=createRequire(import.meta.url)('./b2b-phase8-reports-db-helper.cjs');
const config=()=>({policyId:randomUUID(),revision:1,environment:'BETA' as const,owner:'BILLING' as const,profile:'REPORT_RENDERED_CONTENT_ONLY' as const,
 issuerIds:[1],minAgeHours:24,batchSize:10,maxBytes:25165824,readerContract:'REPORT_410_V1' as const,mode:'EXECUTE' as const});
const install=(pool:any)=>pool.query(readFileSync(new URL('../services/billing-service/b2b-report-retention.candidate.sql',import.meta.url),'utf8'));
async function report(pool:any,key:string,ageHours=48){
 const store=new PostgresReportsStore(pool),f=reportsFixture({store});
 const reports=new B2bReports(store,f.identity,f.port,{enabled:true,now:()=>Date.now()-ageHours*3600000});
 const input={...createInput,idempotencyKey:key},made=await reports.execute(f.auth,'CREATE',input);return {...f,reports,input,id:made.data.id};
}
describe('report retention in NEW isolated PostgreSQL only',()=>{
 it('plans without mutation, atomically removes only eligible bytes, preserves capture/key and replays after restart',async()=>{
  await withPhase8ReportsDatabase(async({pool,secondPool}:any)=>{
   await install(pool);const old=await report(pool,'retention_old_report_01'),fresh=await report(pool,'retention_fresh_report_01',0);
   const before=(await pool.query('SELECT payload,content_bytes FROM "B2bP8ReportJob" WHERE id=$1',[old.id])).rows[0];
   const p=new FixedReportRetentionPolicy(config()),w=new B2bReportRetention(pool,p,{enabled:true}),plan=await w.plan();expect(plan.rows).toBe(1);
   expect((await pool.query('SELECT content_bytes FROM "B2bP8ReportJob" WHERE id=$1',[old.id])).rows[0].content_bytes).toEqual(before.content_bytes);
   const receipt=await w.apply(plan.planId);expect(receipt).toMatchObject({rows:1,bytes:before.content_bytes.length,replayed:false});
   const after=(await pool.query('SELECT payload,content_bytes,content_purged_at FROM "B2bP8ReportJob" WHERE id=$1',[old.id])).rows[0];
   const {contentPurgedAt,...saved}=after.payload;expect(saved).toEqual(before.payload);expect(after.content_bytes).toBeNull();expect(contentPurgedAt).toBe(receipt.completedAt);
   expect((await pool.query('SELECT count(*)::int AS n FROM "B2bReportContentPurgeAudit"')).rows[0].n).toBe(1);
   expect((await fresh.reports.execute(fresh.auth,'CONTENT',{id:fresh.id})).bytes.length).toBeGreaterThan(0);
   for(const action of ['READ','CONTENT','CREATE'] as const)await expect(old.reports.execute(old.auth,action,action==='CREATE'?old.input:{id:old.id})).rejects.toMatchObject({status:410});
   expect(old.port.execute).toHaveBeenCalledOnce();old.p.bindings[0].branchId=randomUUID();await expect(old.reports.execute(old.auth,'READ',{id:old.id})).rejects.toMatchObject({status:404});
   const restarted=new B2bReportRetention(secondPool,p,{enabled:true});expect(await restarted.apply(plan.planId)).toEqual({...receipt,replayed:true});
   expect((await restarted.plan()).rows).toBe(0);
   for(const sql of ['DELETE FROM "B2bP8ReportJob"','TRUNCATE "B2bP8ReportJob" CASCADE','DELETE FROM "B2bReportContentPurgeAudit"','UPDATE "B2bReportRetentionRun" SET purged_rows=0'])await expect(pool.query(sql)).rejects.toMatchObject({code:'23514'});
   await expect(pool.query(`INSERT INTO "B2bReportContentPurgeAudit" (job_id,plan_id,purged_at,job_revision,job_created_at,byte_length,content_sha256,capture_sha256)
    SELECT $1::uuid,plan_id,purged_at,job_revision,job_created_at,byte_length,content_sha256,capture_sha256 FROM "B2bReportContentPurgeAudit" WHERE job_id=$2::uuid`,[fresh.id,old.id])).rejects.toMatchObject({code:'23514',message:'REPORT_RETENTION_RUN_SEALED'});
   await w.close();await restarted.close();
  });
 });
 it('keeps execution off in preview mode and rejects changed policy or concurrent stale plans',async()=>{
  await withPhase8ReportsDatabase(async({pool,secondPool}:any)=>{
   await install(pool);const old=await report(pool,'retention_concurrent_01'),c=config();
   const preview=new B2bReportRetention(pool,new FixedReportRetentionPolicy({...c,mode:'PLAN_ONLY'}),{enabled:true}),plan=await preview.plan();
   await expect(preview.apply(plan.planId)).rejects.toMatchObject({status:403});
   const p=new FixedReportRetentionPolicy(c),a=new B2bReportRetention(pool,p,{enabled:true}),b=new B2bReportRetention(secondPool,p,{enabled:true});
   const pa=await a.plan(),pb=await b.plan();await a.apply(pa.planId);await expect(b.apply(pb.planId)).rejects.toMatchObject({code:'RETENTION_PLAN_STALE'});
   expect((await pool.query('SELECT count(*)::int AS n FROM "B2bReportRetentionRun"')).rows[0].n).toBe(1);
   await expect(old.reports.execute(old.auth,'CONTENT',{id:old.id})).rejects.toMatchObject({status:410});
  });
 });
 it('rolls back every byte/audit/run when policy is revoked immediately before commit',async()=>{
  await withPhase8ReportsDatabase(async({pool}:any)=>{
   await install(pool);const old=await report(pool,'retention_revoke_report_01'),c=config(),base=new FixedReportRetentionPolicy(c);
   let revoked=false;const p={current:vi.fn(async()=>({...await base.current(),mode:revoked?'PLAN_ONLY' as const:'EXECUTE' as const}))};
   const wrapped={connect:async()=>{const db=await pool.connect();return {release:()=>db.release(),query:async(sql:string,v?:unknown[])=>{
    const result=await db.query(sql,v);if(sql.startsWith('UPDATE "B2bP8ReportJob" SET content_bytes=NULL'))revoked=true;return result;
   }};}};
   const w=new B2bReportRetention(wrapped,p,{enabled:true}),plan=await w.plan();await expect(w.apply(plan.planId)).rejects.toMatchObject({status:403});
   expect((await old.reports.execute(old.auth,'CONTENT',{id:old.id})).bytes.length).toBeGreaterThan(0);
   for(const table of ['B2bReportRetentionRun','B2bReportContentPurgeAudit'])expect((await pool.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n).toBe(0);
  });
 });
 it('rejects unaudited SQL purge and ready fact mutation; no filesystem or fiscal tables are involved',async()=>{
  await withPhase8ReportsDatabase(async({pool}:any)=>{
   await install(pool);const old=await report(pool,'retention_integrity_report_01');
   await expect(pool.query(`UPDATE "B2bP8ReportJob" SET content_bytes=NULL,content_purged_at=now(),payload=jsonb_set(payload,'{contentPurgedAt}','"2026-01-01T00:00:00.000Z"') WHERE id=$1`,[old.id])).rejects.toMatchObject({code:'23514'});
   await expect(pool.query(`UPDATE "B2bP8ReportJob" SET payload=jsonb_set(payload,'{createdAt}','"2025-01-01T00:00:00.000Z"') WHERE id=$1`,[old.id])).rejects.toMatchObject({code:'23514'});
   expect((await old.reports.execute(old.auth,'CONTENT',{id:old.id})).bytes.length).toBeGreaterThan(0);
  });
 });
 it('excludes QUEUED, recent and other-issuer reports and respects exact batch scope',async()=>{
  await withPhase8ReportsDatabase(async({pool}:any)=>{
   await install(pool);await report(pool,'retention_scope_first_01');await report(pool,'retention_scope_second_01');await report(pool,'retention_scope_recent_01',0);
   const store=new PostgresReportsStore(pool),other=reportsFixture({store});other.rows.length=0;other.p.bindings[0].issuerId=2;
   const otherEngine=new B2bReports(store,other.identity,other.port,{enabled:true,now:()=>Date.now()-48*3600000});
   await otherEngine.execute(other.auth,'CREATE',{...createInput,idempotencyKey:'retention_scope_other_01',filters:{...createInput.filters,issuerId:'2'}});
   const q=reportsFixture({store}),queued=new B2bReports(store,q.identity,q.port,{enabled:true,now:()=>Date.now()-48*3600000,renderers:{CSV:async()=>{throw Error('SYNTHETIC_RENDER_FAILURE');}}});
   await expect(queued.execute(q.auth,'CREATE',{...createInput,idempotencyKey:'retention_scope_queued_01'})).rejects.toMatchObject({code:'REPORT_RENDER_FAILED'});
   const c=config(),w=new B2bReportRetention(pool,new FixedReportRetentionPolicy({...c,batchSize:1}),{enabled:true});
   const first=await w.plan();expect(first.rows).toBe(1);first.rows=99;first.bytes=0;expect((await w.apply(first.planId)).rows).toBe(1);
   const second=await w.plan();expect(second.rows).toBe(1);await w.apply(second.planId);const empty=await w.plan();expect(empty.rows).toBe(0);
   expect(await w.apply(empty.planId)).toMatchObject({rows:0,bytes:0,replayed:false});expect(await w.apply(empty.planId)).toMatchObject({rows:0,bytes:0,replayed:true});
   const state=(await pool.query(`SELECT state,count(*)::int AS n FROM "B2bP8ReportJob" WHERE content_purged_at IS NULL GROUP BY state ORDER BY state`)).rows;
   expect(state).toEqual([{state:'QUEUED',n:1},{state:'READY',n:2}]);
  });
 });
 it('checks actual content SHA before cleanup and preserves corrupted evidence for review',async()=>{
  await withPhase8ReportsDatabase(async({pool}:any)=>{
   const old=await report(pool,'retention_corrupt_report_01');await pool.query('UPDATE "B2bP8ReportJob" SET content_bytes=$2 WHERE id=$1',[old.id,Buffer.from('synthetic corruption')]);await install(pool);
   const w=new B2bReportRetention(pool,new FixedReportRetentionPolicy(config()),{enabled:true});await expect(w.plan()).rejects.toMatchObject({status:409,code:'REPORT_CONTENT_INTEGRITY'});
   expect((await pool.query('SELECT content_bytes,content_purged_at FROM "B2bP8ReportJob" WHERE id=$1',[old.id])).rows[0]).toEqual({content_bytes:Buffer.from('synthetic corruption'),content_purged_at:null});
  });
 });
 it('requires fresh matching policy and an actual internal plan, never accepts forged IDs',async()=>{
  await withPhase8ReportsDatabase(async({pool}:any)=>{
   await install(pool);await report(pool,'retention_policy_report_01');const c=config();let revision=1;
   const p={current:async()=>({...await new FixedReportRetentionPolicy(c).current(),revision})},w=new B2bReportRetention(pool,p,{enabled:true}),plan=await w.plan();
   revision=2;await expect(w.apply(plan.planId)).rejects.toMatchObject({code:'RETENTION_POLICY_CHANGED'});
   await expect(w.apply(randomUUID())).rejects.toMatchObject({status:404});await expect(w.apply('../../all')).rejects.toMatchObject({status:400});
   expect((await pool.query('SELECT count(*)::int AS n FROM "B2bReportContentPurgeAudit"')).rows[0].n).toBe(0);
  });
 });
 it('waits for a locked download transaction, then purges without partially changing that download',async()=>{
  await withPhase8ReportsDatabase(async({pool,secondPool}:any)=>{
   await install(pool);const old=await report(pool,'retention_download_report_01'),w=new B2bReportRetention(secondPool,new FixedReportRetentionPolicy(config()),{enabled:true}),plan=await w.plan();
   const db=await pool.connect();let running:Promise<any>|undefined;
   try{
    await db.query('BEGIN');const file=(await db.query('SELECT content_bytes FROM "B2bP8ReportJob" WHERE id=$1 FOR UPDATE',[old.id])).rows[0].content_bytes;
    let done=false;running=w.apply(plan.planId);void running.then(()=>{done=true;},()=>{done=true;});await new Promise(r=>setTimeout(r,100));expect(done).toBe(false);
    await db.query('COMMIT');expect((await running).rows).toBe(1);expect(file.toString()).toContain('118.00');
    await expect(old.reports.execute(old.auth,'CONTENT',{id:old.id})).rejects.toMatchObject({status:410});
   }finally{await db.query('ROLLBACK');db.release();await running?.catch(()=>{});}
  });
 });
 it('bounds cleanup by actual file bytes as well as row count',async()=>{
  await withPhase8ReportsDatabase(async({pool}:any)=>{
   await install(pool);const f=reportsFixture({store:new PostgresReportsStore(pool)}),size=13*1024*1024;
   const reports=new B2bReports(new PostgresReportsStore(pool),f.identity,f.port,{enabled:true,now:()=>Date.now()-48*3600000,
    renderers:{CSV:async()=>({bytes:Buffer.alloc(size,65),mediaType:'text/csv; charset=utf-8'})}});
   for(const suffix of ['a','b'])await reports.execute(f.auth,'CREATE',{...createInput,idempotencyKey:'retention_budget_report_'+suffix});
   const w=new B2bReportRetention(pool,new FixedReportRetentionPolicy(config()),{enabled:true}),plan=await w.plan();expect(plan).toMatchObject({rows:1,bytes:size});
   expect(await w.apply(plan.planId)).toMatchObject({rows:1,bytes:size});expect(await w.plan()).toMatchObject({rows:1,bytes:size});
  });
 });
});
