import { randomUUID } from 'node:crypto';
import { deny } from '@factuez/service-access/dist/integration';
import type { IntegrationErrorCode } from '@factuez/contracts/integration';
import { ExportQuotas, type ExportRecord, type ExportStore } from './model';
export interface ExportSql {query(sql:string,values?:unknown[]):Promise<{rows:any[];rowCount:number|null}>}
export interface ExportPool extends ExportSql {connect():Promise<ExportSql & {release():void}>;end():Promise<void>}
const columns='"id","kind","clientId","contextSha256","issuerRuc","keyHash","requestSha256","createdAt","expiresAt",'+
  '"state","payload","content","contentSha256","manifestSha256","failureCode","lease"';
const metadataColumns=columns.replace('"content",','NULL::bytea AS "content",');
function mapped(row:any):ExportRecord {return {...row,createdAt:new Date(row.createdAt).toISOString(),expiresAt:new Date(row.expiresAt).toISOString()};}
export class PostgresExportStore implements ExportStore {
  constructor(private readonly db:ExportPool) {}
  async readySchema() {
    await this.db.query(`SELECT ${columns},"environment","leaseExpiresAt" FROM "IntegrationExportRecord" WHERE false`);
    await this.db.query('SELECT "id","requestId","clientId","revision","recordId","operation","sha256","byteLength","at" FROM "IntegrationExportAudit" WHERE false');
  }
  private async transaction<T>(work:(sql:ExportSql)=>Promise<T>):Promise<T> {
    const db=await this.db.connect();try {await db.query('BEGIN');await db.query("SET LOCAL statement_timeout='10s'");
      await db.query('SELECT pg_advisory_xact_lock(1985126505)');const result=await work(db);await db.query('COMMIT');return result;
    }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{db.release();}
  }
  async reserve(r:ExportRecord) {
    return this.transaction(async db=>{
      if(r.keyHash) {const existing=await db.query(`SELECT ${metadataColumns} FROM "IntegrationExportRecord" WHERE "clientId"=$1 AND "keyHash"=$2`,[r.clientId,r.keyHash]);
        if(existing.rows[0]) return {record:mapped(existing.rows[0]),created:false};}
      const counts=(await db.query(`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE "clientId"=$1 AND "kind"=$2)::int AS owned,
        coalesce(sum(coalesce(octet_length("payload"),0)+coalesce(octet_length("content"),0)),0)::bigint AS bytes
        FROM "IntegrationExportRecord" WHERE "expiresAt">$3 AND "state" NOT IN ('EXPIRED','FAILED')`,[r.clientId,r.kind,r.createdAt])).rows[0];
      if(counts.total>=ExportQuotas.activeRecords || counts.owned>=(r.kind==='CUT'?ExportQuotas.activeClientCuts:ExportQuotas.activeClientExports)||
        Number(counts.bytes)>=ExportQuotas.totalBytes) return deny(429,'RATE_LIMITED');
      await db.query(`INSERT INTO "IntegrationExportRecord" (${columns}) VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,NULL,NULL,NULL,NULL,NULL)`,
        [r.id,r.kind,r.clientId,r.contextSha256,r.issuerRuc,r.keyHash,r.requestSha256,r.createdAt,r.expiresAt,r.state]);
      return {record:r,created:true};
    });
  }
  async get(id:string,clientId:string,includeContent=false) {const result=await this.db.query(`SELECT ${includeContent?columns:metadataColumns} FROM "IntegrationExportRecord" WHERE "id"=$1 AND "clientId"=$2`,[id,clientId]);return result.rows[0]?mapped(result.rows[0]):null;}
  async byKey(clientId:string,keyHash:string) {const result=await this.db.query(`SELECT ${metadataColumns} FROM "IntegrationExportRecord" WHERE "clientId"=$1 AND "keyHash"=$2`,[clientId,keyHash]);return result.rows[0]?mapped(result.rows[0]):null;}
  private async budget(db:ExportSql,id:string,bytes:number) {
    if(bytes>ExportQuotas.encryptedBytes+ExportQuotas.packageBytes+58) return deny(422,'EXPORT_TOO_LARGE');
    const value=(await db.query(`SELECT coalesce(sum(coalesce(octet_length("payload"),0)+coalesce(octet_length("content"),0)),0)::bigint AS bytes
      FROM "IntegrationExportRecord" WHERE "id"<>$1 AND "state"<>'EXPIRED'`,[id])).rows[0];
    if(Number(value.bytes)+bytes>ExportQuotas.totalBytes) return deny(429,'RATE_LIMITED');
  }
  async captured(id:string,payload:Buffer,state:'QUEUED'|'READY') {
    await this.transaction(async db=>{await this.budget(db,id,payload.length);
      const result=await db.query(`UPDATE "IntegrationExportRecord" SET "payload"=$2,"state"=$3
        WHERE "id"=$1 AND "state"='CAPTURING' AND "expiresAt">clock_timestamp()`,[id,payload,state]);
      if(result.rowCount!==1) return deny(410,'SNAPSHOT_EXPIRED');});
  }
  async claim(now:string) {
    return this.transaction(async db=>{
      const result=await db.query(`SELECT ${columns} FROM "IntegrationExportRecord"
        WHERE "kind"='EXPORT' AND "expiresAt">$1 AND ("state"='QUEUED' OR ("state"='RUNNING' AND "leaseExpiresAt"<=$1))
        ORDER BY "createdAt","id" LIMIT 1 FOR UPDATE SKIP LOCKED`,[now]);
      if(!result.rows[0]) return null;const row=mapped(result.rows[0]),lease=randomUUID();
      await db.query(`UPDATE "IntegrationExportRecord" SET "state"='RUNNING',"lease"=$2,"leaseExpiresAt"=$3 WHERE "id"=$1`,
        [row.id,lease,new Date(Date.parse(now)+ExportQuotas.leaseMs).toISOString()]);return {...row,state:'RUNNING' as const,lease};
    });
  }
  async ready(id:string,lease:string,payload:Buffer,content:Buffer,contentSha256:string,manifestSha256:string,expiresAt:string) {
    await this.transaction(async db=>{await this.budget(db,id,payload.length+content.length);
      const result=await db.query(`UPDATE "IntegrationExportRecord" SET "state"='READY',"payload"=$3,"content"=$4,"contentSha256"=$5,
        "manifestSha256"=$6,"expiresAt"=$7,"lease"=NULL,"leaseExpiresAt"=NULL
        WHERE "id"=$1 AND "state"='RUNNING' AND "lease"=$2 AND "leaseExpiresAt">clock_timestamp() AND "expiresAt">clock_timestamp()`,
        [id,lease,payload,content,contentSha256,manifestSha256,expiresAt]);
      if(result.rowCount!==1) return deny(409,'CONSISTENT_READ_UNAVAILABLE');});
  }
  async fail(id:string,code:IntegrationErrorCode,lease?:string) {
    await this.db.query(`UPDATE "IntegrationExportRecord" SET "state"='FAILED',"failureCode"=$2,"payload"=NULL,"content"=NULL,
      "lease"=NULL,"leaseExpiresAt"=NULL WHERE "id"=$1 AND "state" IN ('CAPTURING','QUEUED','RUNNING')
      AND ($3::uuid IS NULL OR "lease"=$3::uuid)`,[id,code,lease??null]);
  }
  async audit(e:Parameters<ExportStore['audit']>[0]) {
    await this.db.query(`INSERT INTO "IntegrationExportAudit" ("id","requestId","clientId","revision","recordId","operation","sha256","byteLength")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,[randomUUID(),randomUUID(),e.clientId,e.revision,e.recordId,e.operation,e.sha256,e.byteLength]);
  }
  async sweep(now:string) {
    await this.transaction(async db=>{
      await db.query(`UPDATE "IntegrationExportRecord" SET "state"='EXPIRED',"payload"=NULL,"content"=NULL,"lease"=NULL,"leaseExpiresAt"=NULL
        WHERE "id" IN (SELECT "id" FROM "IntegrationExportRecord" WHERE "expiresAt"<=$1 AND "state"<>'EXPIRED' LIMIT 100)`,[now]);
      // Only the service's OWN expired ciphertext/tombstones; never originals or emission state.
      await db.query(`DELETE FROM "IntegrationExportRecord" WHERE "id" IN
        (SELECT "id" FROM "IntegrationExportRecord" WHERE "state"='EXPIRED' AND "expiresAt"<$1::timestamptz-interval '48 hours' LIMIT 100)`,[now]);
    });
  }
}
