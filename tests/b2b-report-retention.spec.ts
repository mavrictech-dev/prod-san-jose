import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {B2bReportRetention,FixedReportRetentionPolicy} from '../services/billing-service/src/b2b/phase8-reports/retention';
import {reportsFixture,createInput} from './b2b-phase8-reports.fixture';
import {B2bWorkerMaintenance} from '../packages/service-access/src/b2b-worker-maintenance';
export const retentionConfig=()=>({policyId:randomUUID(),revision:1,environment:'BETA' as const,owner:'BILLING' as const,
 profile:'REPORT_RENDERED_CONTENT_ONLY' as const,issuerIds:[1],minAgeHours:24,batchSize:10,maxBytes:25165824,readerContract:'REPORT_410_V1' as const});
describe('private report retention',()=>{
 it('is off by default and close is terminal without opening a connection',async()=>{
  const pool={connect:vi.fn()},p=new FixedReportRetentionPolicy(retentionConfig()),w=new B2bReportRetention(pool,p);
  await expect(w.plan()).rejects.toMatchObject({status:503,code:'REPORT_RETENTION_DISABLED'});
  const active=new B2bReportRetention(pool,p,{enabled:true});await active.close();await expect(active.plan()).rejects.toMatchObject({code:'REPORT_RETENTION_CLOSED'});expect(pool.connect).not.toHaveBeenCalled();
 });
 it('requires bounded explicit private BETA policy, no inferred issuer or execution',async()=>{
  const config=retentionConfig(),p=new FixedReportRetentionPolicy(config);config.issuerIds.push(2);
  const current=await p.current();expect(current.mode).toBe('PLAN_ONLY');expect(current.issuerIds).toEqual([1]);current.issuerIds.push(3);expect((await p.current()).issuerIds).toEqual([1]);
  for(const bad of [{environment:'PRODUCTION'},{issuerIds:[]},{issuerIds:[1,1]},{issuerIds:Array(2)},{minAgeHours:0},{batchSize:101},{maxBytes:0},{readerContract:'OLD'},{extra:true}])
   expect(()=>new FixedReportRetentionPolicy({...retentionConfig(),...bad} as any)).toThrow();
 });
 it('protects expired jobs with fresh authorization and never recaptures on replay',async()=>{
  const f=reportsFixture(),made=await f.reports.execute(f.auth,'CREATE',createInput),id=made.data.id;
  f.store.jobs.get(id)!.contentPurgedAt=new Date().toISOString();f.store.files.delete(id);
  for(const action of ['READ','CONTENT','CREATE'] as const)await expect(f.reports.execute(f.auth,action,action==='CREATE'?createInput:{id})).rejects.toMatchObject({status:410,code:'ARTIFACT_NOT_AVAILABLE'});
  expect(f.port.execute).toHaveBeenCalledOnce();f.p.bindings[0].branchId=randomUUID();await expect(f.reports.execute(f.auth,'READ',{id})).rejects.toMatchObject({status:404});
 });
 it('joins the exact Billing maintenance set and waits for in-flight metadata scans',async()=>{
  let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{started=r;});
  const pool={connect:async()=>{started();await gate;throw Error('PRIVATE_DB_FAILURE');}},w=new B2bReportRetention(pool,new FixedReportRetentionPolicy(retentionConfig()),{enabled:true});
  const running=w.plan();const rejected=expect(running).rejects.toMatchObject({code:'RETENTION_STORAGE_UNAVAILABLE'});await entered;
  const g=new B2bWorkerMaintenance({enabled:true,owner:'BILLING',expected:['BILLING_WEBHOOK_PUBLISHER','BILLING_REPORT_RETENTION'],components:[{id:'BILLING_WEBHOOK_PUBLISHER',worker:{close:async()=>{}}},{id:'BILLING_REPORT_RETENTION',worker:w}]});
  g.stop();expect((await g.wait(1)).state).toBe('STOPPING');await expect(w.plan()).rejects.toMatchObject({code:'REPORT_RETENTION_CLOSED'});
  release();await rejected;expect((await g.wait(1000)).state).toBe('QUIESCED_LOCAL');
 });
 it('expires the internal plan using the database clock, with no apply or new capture',async()=>{
  let time=Date.now();const query=vi.fn(async(sql:string)=>({rows:sql.startsWith('SELECT to_char')?[{now:new Date(time).toISOString()}]:[],rowCount:0}));
  const pool={connect:async()=>({query,release:()=>{}})},c=retentionConfig(),policy={current:async()=>({...c,mode:'EXECUTE' as const,expiresAt:new Date(time+5000).toISOString()})};
  const w=new B2bReportRetention(pool,policy,{enabled:true}),plan=await w.plan();time+=61000;
  await expect(w.apply(plan.planId)).rejects.toMatchObject({code:'RETENTION_PLAN_EXPIRED'});expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE')||sql.startsWith('INSERT'))).toBe(false);
 });
});
