import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import type { ReportFile, ReportJob, ReportsPgConnection, ReportsPgPool, ReportsStore, ReportsTransaction } from './types';
import { fail, hashBytes, limits, verifyCapture } from './validation';
function job(row:any):ReportJob|null {
  if(!row) return null;
  const p=row.payload as ReportJob;
  if(!p||p.id!==row.id||p.ownerKey!==row.owner_key||p.keyHash!==row.key_hash||p.requestHash!==row.request_hash||p.state!==row.state||p.revision!==row.revision||
    !['QUEUED','READY'].includes(p.state)||!['CSV','XLSX','PDF'].includes(p.format)||
    (p.state==='READY'?!p.content:p.content!==null)||
    (p.contentPurgedAt!==undefined&&(p.state!=='READY'||typeof p.contentPurgedAt!=='string'||!Number.isFinite(Date.parse(p.contentPurgedAt))||new Date(p.contentPurgedAt).toISOString()!==p.contentPurgedAt))) fail(409,'REPORT_JOB_INTEGRITY');
  verifyCapture(p.capture);return structuredClone(p);
}
class PgReportsTransaction implements ReportsTransaction {
  private active=true;
  constructor(private readonly db:ReportsPgConnection){}
  finish(){this.active=false;}
  private query(sql:string,values:unknown[]) {if(!this.active) fail(503,'REPORT_TRANSACTION_CLOSED');return this.db.query(sql,values);}
  async prior(ownerKey:string,keyHash:string) {
    return job((await this.query('SELECT id,owner_key,key_hash,request_hash,state,revision,payload FROM "B2bP8ReportJob" WHERE owner_key=$1 AND key_hash=$2 FOR UPDATE',[ownerKey,keyHash])).rows[0]);
  }
  async get(ownerKey:string,id:string) {
    return job((await this.query('SELECT id,owner_key,key_hash,request_hash,state,revision,payload FROM "B2bP8ReportJob" WHERE owner_key=$1 AND id=$2::uuid FOR UPDATE',[ownerKey,id])).rows[0]);
  }
  async insert(p:ReportJob) {
    if(p.state!=='QUEUED'||p.revision!==1||p.content!==null) fail(409,'REPORT_JOB_INTEGRITY');verifyCapture(p.capture);
    await this.query('INSERT INTO "B2bP8ReportJob" (id,owner_key,key_hash,request_hash,state,revision,payload) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::jsonb)',
      [p.id,p.ownerKey,p.keyHash,p.requestHash,p.state,p.revision,JSON.stringify(p)]);
  }
  async complete(ownerKey:string,id:string,expectedRevision:number,file:ReportFile) {
    const p=await this.get(ownerKey,id);
    if(!p||p.state!=='QUEUED'||p.revision!==expectedRevision) return false;
    if(!Buffer.isBuffer(file.bytes)||!file.bytes.length||file.bytes.length>limits.contentBytes||hashBytes(file.bytes)!==file.sha256||file.sizeBytes!==file.bytes.length) fail(409,'REPORT_CONTENT_INTEGRITY');
    const {bytes,...metadata}=file;const ready:ReportJob={...p,state:'READY',revision:p.revision+1,content:metadata};
    const result=await this.query('UPDATE "B2bP8ReportJob" SET state=\'READY\',revision=revision+1,payload=$4::jsonb,content_bytes=$5 WHERE owner_key=$1 AND id=$2::uuid AND revision=$3 AND state=\'QUEUED\' RETURNING id',
      [ownerKey,id,expectedRevision,JSON.stringify(ready),bytes]);
    return result.rowCount===1;
  }
  async content(ownerKey:string,id:string):Promise<ReportFile|null> {
    const p=await this.get(ownerKey,id);if(!p||p.state!=='READY'||!p.content) return null;
    const result=await this.query('SELECT content_bytes FROM "B2bP8ReportJob" WHERE owner_key=$1 AND id=$2::uuid AND state=\'READY\' AND revision=$3',[ownerKey,id,p.revision]);
    const bytes=result.rows[0]?.content_bytes;
    if(!Buffer.isBuffer(bytes)) fail(409,'REPORT_CONTENT_INTEGRITY');
    return {...p.content,bytes:Buffer.from(bytes)};
  }
}
/** Uses only the explicitly injected pool and this candidate table. Owns no connection configuration or DDL. */
export class PostgresReportsStore implements ReportsStore {
  constructor(private readonly pool:ReportsPgPool){}
  async transaction<T>(lockKey:string,work:(tx:ReportsTransaction)=>Promise<T>):Promise<T> {
    let db:ReportsPgConnection|undefined,tx:PgReportsTransaction|undefined,releaseError:Error|undefined;
    try {
      db=await this.pool.connect();await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await db.query("SET LOCAL statement_timeout = '10s'");await db.query("SET LOCAL lock_timeout = '3s'");
      await db.query("SET LOCAL idle_in_transaction_session_timeout = '20s'");
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['b2b-p8-reports:'+lockKey]);
      tx=new PgReportsTransaction(db);const value=await work(tx);tx.finish();await db.query('COMMIT');return value;
    }catch(error){
      if(db) try{await db.query('ROLLBACK');}catch{releaseError=new Error('REPORT_ROLLBACK_FAILED');}
      if(error instanceof B2bSecurityError) throw error;
      const code=(error as {code?:string})?.code;
      if(code&&['40001','40P01','55P03','23505'].includes(code)) throw new B2bSecurityError(409,'REPORT_TRANSACTION_RETRY');
      throw new B2bSecurityError(503,'REPORT_STORAGE_UNAVAILABLE');
    }finally{tx?.finish();db?.release(releaseError);}
  }
}
