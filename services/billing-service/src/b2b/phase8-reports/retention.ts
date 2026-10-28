import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {types} from 'node:util';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {snapshotHash} from '@factuez/service-access/dist/integration';
import type {ReportsPgConnection,ReportsPgPool} from './types';
import {fail} from './validation';

export interface ReportRetentionPolicy {
 policyId:string;revision:number;environment:'BETA';owner:'BILLING';profile:'REPORT_RENDERED_CONTENT_ONLY';
 issuerIds:number[];minAgeHours:number;batchSize:number;maxBytes:number;readerContract:'REPORT_410_V1';
 mode:'PLAN_ONLY'|'EXECUTE';expiresAt:string;
}
export interface ReportRetentionPolicyPort {current():Promise<ReportRetentionPolicy>}
const fields=['policyId','revision','environment','owner','profile','issuerIds','minAgeHours','batchSize','maxBytes','readerContract','mode','expiresAt'];
const uuid=(s:unknown):s is string=>typeof s==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(s);
const hex=(s:unknown):s is string=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const integer=(v:unknown,min:number,max:number)=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=max;
const plain=(v:any)=>v&&typeof v==='object'&&!types.isProxy(v)&&Object.getPrototypeOf(v)===Object.prototype&&Object.values(Object.getOwnPropertyDescriptors(v)).every(d=>'value'in d);
function validate(value:unknown,now:number):ReportRetentionPolicy {
 if(!plain(value))fail(503,'RETENTION_POLICY_REQUIRED');const p=value as ReportRetentionPolicy;
 if(Reflect.ownKeys(p).length!==fields.length||Reflect.ownKeys(p).some(k=>typeof k!=='string'||!fields.includes(k))||!uuid(p.policyId)||!integer(p.revision,1,2147483647)||
  p.environment!=='BETA'||p.owner!=='BILLING'||p.profile!=='REPORT_RENDERED_CONTENT_ONLY'||p.readerContract!=='REPORT_410_V1'||!['PLAN_ONLY','EXECUTE'].includes(p.mode)||
  !Array.isArray(p.issuerIds)||types.isProxy(p.issuerIds)||Object.getPrototypeOf(p.issuerIds)!==Array.prototype||p.issuerIds.length<1||p.issuerIds.length>100||
  Reflect.ownKeys(p.issuerIds).length!==p.issuerIds.length+1||Object.values(Object.getOwnPropertyDescriptors(p.issuerIds)).some(d=>!('value'in d))||
  p.issuerIds.some(id=>!integer(id,1,2147483647))||new Set(p.issuerIds).size!==p.issuerIds.length||
  !integer(p.minAgeHours,24,87600)||!integer(p.batchSize,1,100)||!integer(p.maxBytes,25165824,268435456)||
  typeof p.expiresAt!=='string'||!Number.isFinite(Date.parse(p.expiresAt))||Date.parse(p.expiresAt)<=now||Date.parse(p.expiresAt)>now+300000)fail(503,'RETENTION_POLICY_INVALID');
 return {...structuredClone(p),issuerIds:[...p.issuerIds].sort((a,b)=>a-b)};
}
const policyHash=(p:ReportRetentionPolicy)=>{const {expiresAt,mode,...stable}=p;return snapshotHash(stable);};
/** Private, immutable operator composition. No inferred issuers, env, API grants or default age. */
export class FixedReportRetentionPolicy implements ReportRetentionPolicyPort {
 #policy:ReportRetentionPolicy;
 constructor(config:Omit<ReportRetentionPolicy,'expiresAt'|'mode'>&{mode?:ReportRetentionPolicy['mode']}){
  if(!plain(config))fail(503,'RETENTION_POLICY_INVALID');
  this.#policy=validate({...config,mode:config.mode??'PLAN_ONLY',expiresAt:new Date(Date.now()+5000).toISOString()},Date.now());
 }
 async current(){return {...structuredClone(this.#policy),expiresAt:new Date(Date.now()+5000).toISOString()};}
}
interface Candidate {id:string;revision:number;createdAt:string;issuerId:number;byteLength:number;contentSha256:string;captureSha256:string}
export interface ReportRetentionPlan {
 planId:string;policyId:string;policyRevision:number;policySha256:string;planSha256:string;
 environment:'BETA';profile:'REPORT_RENDERED_CONTENT_ONLY';cutoff:string;expiresAt:string;rows:number;bytes:number;
}
export interface ReportRetentionReceipt {planId:string;policyId:string;policyRevision:number;planSha256:string;completedAt:string;rows:number;bytes:number;replayed:boolean}
type Saved={view:ReportRetentionPlan;items:Candidate[];monotonicExpiry:number};
const selection=`id,revision,payload->>'createdAt' AS created_at,(payload#>>'{capture,filters,issuerId}')::integer AS issuer_id,
 octet_length(content_bytes) AS byte_length,encode(sha256(content_bytes),'hex') AS actual_sha256,
 payload#>>'{content,sha256}' AS content_sha256,payload#>>'{capture,sha256}' AS capture_sha256`;
function candidate(r:any):Candidate {
 const date=r.created_at instanceof Date?r.created_at.toISOString():r.created_at;
 if(!uuid(r.id)||r.revision!==2||!Number.isFinite(Date.parse(date))||!integer(r.issuer_id,1,2147483647)||!integer(r.byte_length,1,25165824)||
  !hex(r.actual_sha256)||r.actual_sha256!==r.content_sha256||!hex(r.capture_sha256))fail(409,'REPORT_CONTENT_INTEGRITY');
 return {id:r.id,revision:r.revision,createdAt:new Date(date).toISOString(),issuerId:r.issuer_id,byteLength:r.byte_length,contentSha256:r.content_sha256,captureSha256:r.capture_sha256};
}
/** Operator-only Billing adapter. Explicit pool, disabled by default; no startup, timers,
 * routes, files, DDL or ownership of the pool. Every apply is bounded and transactional. */
export class B2bReportRetention {
 #closed=false;#active=new Set<Promise<unknown>>();#plans=new Map<string,Saved>();
 constructor(private readonly pool:ReportsPgPool,private readonly policies:ReportRetentionPolicyPort,private readonly options:{enabled?:boolean}={}){}
 private work<T>(fn:()=>Promise<T>):Promise<T>{
  if(this.options.enabled!==true)return Promise.reject(new B2bSecurityError(503,'REPORT_RETENTION_DISABLED'));
  if(this.#closed)return Promise.reject(new B2bSecurityError(503,'REPORT_RETENTION_CLOSED'));
  const p=Promise.resolve().then(fn);this.#active.add(p);void p.then(()=>this.#active.delete(p),()=>this.#active.delete(p));return p;
 }
 async close(){this.#closed=true;await Promise.allSettled([...this.#active]);this.#plans.clear();}
 private async policy(db:ReportsPgConnection,execute=false){
  const p=await this.policies.current();
  const row=(await db.query<{now:string}>(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`)).rows[0];
  const now=Date.parse(row?.now);if(!Number.isFinite(now))fail(503,'RETENTION_CLOCK_UNAVAILABLE');
  const valid=validate(p,now);if(execute&&valid.mode!=='EXECUTE')fail(403,'RETENTION_EXECUTION_NOT_AUTHORIZED');return {p:valid,now};
 }
 private async tx<T>(work:(db:ReportsPgConnection)=>Promise<T>){
  let db:ReportsPgConnection|undefined,releaseError:Error|undefined;
  try{
   db=await this.pool.connect();await db.query('BEGIN');await db.query("SET LOCAL statement_timeout='10s'");await db.query("SET LOCAL lock_timeout='3s'");
   await db.query("SET LOCAL idle_in_transaction_session_timeout='20s'");const v=await work(db);await db.query('COMMIT');return v;
  }catch(e){
   if(db)try{await db.query('ROLLBACK');}catch{releaseError=new Error('RETENTION_ROLLBACK_FAILED');}
   if(e instanceof B2bSecurityError)throw e;
   if(['40001','40P01','55P03','23505'].includes((e as any)?.code))fail(409,'RETENTION_TRANSACTION_RETRY');
   fail(503,'RETENTION_STORAGE_UNAVAILABLE');
  }finally{db?.release(releaseError);}
 }
 plan():Promise<ReportRetentionPlan>{return this.work(()=>this.tx(async db=>{
  const {p,now}=await this.policy(db);for(const [key,v] of this.#plans)if(performance.now()>v.monotonicExpiry)this.#plans.delete(key);
  if(this.#plans.size>=16)fail(429,'RETENTION_PLAN_LIMIT');
  const cutoff=new Date(now-p.minAgeHours*3600000).toISOString();
  const rows=(await db.query(`SELECT ${selection} FROM "B2bP8ReportJob" WHERE state='READY' AND revision=2 AND content_purged_at IS NULL AND content_bytes IS NOT NULL
   AND payload#>>'{capture,filters,environment}'='BETA' AND (payload#>>'{capture,filters,issuerId}')::integer=ANY($1::integer[])
   AND (payload->>'createdAt')::timestamptz<=$2::timestamptz ORDER BY (payload->>'createdAt')::timestamptz,id LIMIT $3`,[p.issuerIds,cutoff,p.batchSize])).rows;
  const items:Candidate[]=[];let bytes=0;for(const row of rows){const item=candidate(row);if(bytes+item.byteLength>p.maxBytes)break;items.push(item);bytes+=item.byteLength;}
  const view:ReportRetentionPlan={planId:randomUUID(),policyId:p.policyId,policyRevision:p.revision,policySha256:policyHash(p),planSha256:snapshotHash(items),
   environment:'BETA',profile:'REPORT_RENDERED_CONTENT_ONLY',cutoff,expiresAt:new Date(now+60000).toISOString(),rows:items.length,bytes};
  // Revalidate an authorization that could change during the metadata scan.
  const fresh=await this.policy(db);if(policyHash(fresh.p)!==view.policySha256||fresh.p.mode!==p.mode)fail(409,'RETENTION_POLICY_CHANGED');
  this.#plans.set(view.planId,{view:structuredClone(view),items,monotonicExpiry:performance.now()+60000});return structuredClone(view);
 }));}
 apply(planId:string):Promise<ReportRetentionReceipt>{return this.work(()=>this.tx(async db=>{
  if(!uuid(planId))fail(400,'INVALID_RETENTION_PLAN');
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['b2b-report-retention']);
  const {p,now}=await this.policy(db,true),sha=policyHash(p);
  const previous=(await db.query<any>(`SELECT policy_id,policy_revision,policy_sha256,plan_sha256,completed_at,purged_rows,purged_bytes FROM "B2bReportRetentionRun" WHERE plan_id=$1::uuid`,[planId])).rows[0];
  const checkPolicy=async()=>{const fresh=await this.policy(db,true);if(policyHash(fresh.p)!==sha)fail(409,'RETENTION_POLICY_CHANGED');};
  if(previous){
   if(previous.policy_id!==p.policyId||previous.policy_revision!==p.revision||previous.policy_sha256!==sha)fail(404,'RETENTION_PLAN_NOT_FOUND');
   await checkPolicy();return {planId,policyId:p.policyId,policyRevision:p.revision,planSha256:previous.plan_sha256,
    completedAt:new Date(previous.completed_at).toISOString(),rows:previous.purged_rows,bytes:Number(previous.purged_bytes),replayed:true};
  }
  const saved=this.#plans.get(planId);if(!saved)fail(404,'RETENTION_PLAN_NOT_FOUND');const v=saved.view;
  if(v.policySha256!==sha)fail(409,'RETENTION_POLICY_CHANGED');
  if(now>=Date.parse(v.expiresAt)||performance.now()>=saved.monotonicExpiry)fail(409,'RETENTION_PLAN_EXPIRED');
  const actual=(await db.query(`SELECT ${selection} FROM "B2bP8ReportJob" WHERE id=ANY($1::uuid[]) AND state='READY' AND revision=2 AND content_bytes IS NOT NULL
   AND content_purged_at IS NULL AND payload#>>'{capture,filters,environment}'='BETA' ORDER BY id FOR UPDATE`,[saved.items.map(i=>i.id)])).rows.map(candidate);
  const expected=[...saved.items].sort((a,b)=>a.id.localeCompare(b.id));
  if(snapshotHash(actual)!==snapshotHash(expected)||actual.some(i=>!p.issuerIds.includes(i.issuerId)||Date.parse(i.createdAt)>Date.parse(v.cutoff)))fail(409,'RETENTION_PLAN_STALE');
  await checkPolicy();
  // Clock comes from the DB. Milliseconds are shared by the audit, tombstone and run.
  const completed=(await this.policy(db,true));if(policyHash(completed.p)!==sha)fail(409,'RETENTION_POLICY_CHANGED');
  if(completed.now>=Date.parse(v.expiresAt)||performance.now()>=saved.monotonicExpiry)fail(409,'RETENTION_PLAN_EXPIRED');
  const completedAt=new Date(completed.now).toISOString();
  await db.query(`INSERT INTO "B2bReportRetentionRun" (plan_id,policy_id,policy_revision,policy_sha256,plan_sha256,issuer_ids,environment,profile,cutoff,completed_at,min_age_hours,purged_rows,purged_bytes)
   VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::integer[],'BETA','REPORT_RENDERED_CONTENT_ONLY',$7::timestamptz,$8::timestamptz,$9,$10,$11)`,
   [planId,p.policyId,p.revision,sha,v.planSha256,p.issuerIds,v.cutoff,completedAt,p.minAgeHours,v.rows,v.bytes]);
  for(const item of actual){
   await db.query(`INSERT INTO "B2bReportContentPurgeAudit" (job_id,plan_id,purged_at,job_revision,job_created_at,byte_length,content_sha256,capture_sha256)
    VALUES ($1::uuid,$2::uuid,$3::timestamptz,$4,$5::timestamptz,$6,$7,$8)`,[item.id,planId,completedAt,item.revision,item.createdAt,item.byteLength,item.contentSha256,item.captureSha256]);
   const r=await db.query(`UPDATE "B2bP8ReportJob" SET content_bytes=NULL,content_purged_at=$2::timestamptz,payload=jsonb_set(payload,'{contentPurgedAt}',to_jsonb($3::text)) WHERE id=$1::uuid AND content_purged_at IS NULL RETURNING id`,[item.id,completedAt,completedAt]);
   if(r.rowCount!==1)fail(409,'RETENTION_PLAN_STALE');
  }
  await checkPolicy();return {planId,policyId:p.policyId,policyRevision:p.revision,planSha256:v.planSha256,completedAt,rows:v.rows,bytes:v.bytes,replayed:false};
 }));}
}
