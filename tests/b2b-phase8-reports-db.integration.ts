import { createRequire } from 'node:module';
import { describe,it,expect } from 'vitest';
import { B2bReports,PostgresReportsStore } from '../services/billing-service/src/b2b/phase8-reports';
import { reportsFixture,createInput } from './b2b-phase8-reports.fixture';
const {withPhase8ReportsDatabase}=createRequire(import.meta.url)('./b2b-phase8-reports-db-helper.cjs');
describe('B2B08 reports in NEW isolated PostgreSQL',()=>{
  it('persists restart/replay, original captured rows, private bytes, concurrency and revision CAS',async()=>{
    await withPhase8ReportsDatabase(async({pool,secondPool,database}:any)=>{
      expect((await pool.query('SELECT current_database() AS name')).rows[0].name).toBe(database);
      const store=new PostgresReportsStore(pool),f=reportsFixture({store}),stableSource=structuredClone(f.rows[0]);
      const made=await f.reports.execute(f.auth,'CREATE',createInput),id=made.data.id;
      expect(made.data).toMatchObject({state:'READY',revision:2,count:1});
      const restarted=new B2bReports(new PostgresReportsStore(secondPool),f.identity,f.port,{enabled:true});f.rows.length=0;
      const replay=await restarted.execute(f.auth,'CREATE',createInput);expect(replay.data).toEqual(made.data);expect(replay.replayed).toBe(true);expect(f.port.execute).toHaveBeenCalledTimes(1);
      const file=await restarted.execute(f.auth,'CONTENT',{id});expect(file.bytes.toString()).toContain('118.00');
      f.p.revision++;await expect(restarted.execute(f.auth,'READ',{id})).rejects.toMatchObject({code:'RESOURCE_NOT_FOUND'});f.p.revision--;
      await expect(restarted.execute(f.auth,'CREATE',{...createInput,filters:{...createInput.filters,to:'2026-01-03'}})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
      const concurrent={...createInput,idempotencyKey:'synthetic_reports_concurrent'};
      const [a,b]=await Promise.all([f.reports.execute(f.auth,'CREATE',concurrent),restarted.execute(f.auth,'CREATE',concurrent)]);expect(a.data).toEqual(b.data);
      expect((await pool.query('SELECT count(*)::text AS n FROM "B2bP8ReportJob"')).rows[0].n).toBe('2');
      const saved=(await pool.query('SELECT payload FROM "B2bP8ReportJob" WHERE id=$1',[id])).rows[0].payload;
      expect(await store.transaction('cas-test',tx=>tx.complete(saved.ownerKey,id,1,file))).toBe(false);
      expect(await store.transaction('foreign-test',tx=>tx.get('f'.repeat(64),id))).toBeNull();
      f.rows.push(stableSource);let fail=true;const render=async()=>{if(fail)throw new Error('private-render-error');return {bytes:Buffer.from('stable captured restart'),mediaType:'text/csv; charset=utf-8'};};
      const interrupted=new B2bReports(store,f.identity,f.port,{enabled:true,renderers:{CSV:render}}),input={...createInput,idempotencyKey:'synthetic_reports_interrupted'};
      await expect(interrupted.execute(f.auth,'CREATE',input)).rejects.toMatchObject({code:'REPORT_RENDER_FAILED'});
      const queued=(await pool.query('SELECT payload FROM "B2bP8ReportJob" WHERE state=\'QUEUED\'')).rows[0].payload;
      expect(queued.capture.rows).toHaveLength(1);f.rows.length=0;fail=false;
      const resumed=new B2bReports(new PostgresReportsStore(secondPool),f.identity,f.port,{enabled:true,renderers:{CSV:render}});
      const done=await resumed.execute(f.auth,'CREATE',input);expect(done.data.id).toBe(queued.id);expect(done.data.state).toBe('READY');expect(done.data.count).toBe(1);
      expect((await pool.query('SELECT revision FROM "B2bP8ReportJob" WHERE id=$1',[queued.id])).rows[0].revision).toBe(2);
      const leased:any[]=[];
      await store.transaction('lease-test',async tx=>{leased.push(tx);});await expect(leased[0].get(saved.ownerKey,id)).rejects.toMatchObject({code:'REPORT_TRANSACTION_CLOSED'});
      const before=(await pool.query('SELECT count(*)::text AS n FROM "B2bP8ReportJob"')).rows[0].n;
      await expect(store.transaction('rollback-test',async tx=>{const row=structuredClone(saved);row.id='90000000-0000-4000-8000-000000000099';row.keyHash='e'.repeat(64);row.state='QUEUED';row.revision=1;row.content=null;await tx.insert(row);throw new Error('rollback');})).rejects.toMatchObject({code:'REPORT_STORAGE_UNAVAILABLE'});
      expect((await pool.query('SELECT count(*)::text AS n FROM "B2bP8ReportJob"')).rows[0].n).toBe(before);
    });
  });
});