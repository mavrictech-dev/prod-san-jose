import { createRequire } from 'node:module';
import { B2bSecurityError } from './email-deliveries.security';
import type { EmailDeliveryEvent, EmailDeliveryJob, EmailDeliveryStore, EmailDeliveryTransaction } from './email-deliveries.types';
export interface EmailDeliveryPgConnection {
  query<T = Record<string,unknown>>(sql: string, values?: unknown[]): Promise<{rows:T[];rowCount:number|null}>;
  release(error?: Error): void;
}
export interface EmailDeliveryPgPool { connect(): Promise<EmailDeliveryPgConnection>; end(): Promise<void> }
export interface EmailDeliveryPgConfig {host:string;port:number;database:string;user:string;password:string;max?:number;stream?:()=>unknown}
const unavailable=()=>new B2bSecurityError(503,'EMAIL_STORE_UNAVAILABLE');
class Transaction implements EmailDeliveryTransaction {
  private active=true;
  constructor(private readonly db: EmailDeliveryPgConnection,private readonly corporate=false) {}
  finish() {this.active=false;}
  private query<T>(sql:string,values:unknown[]=[]) {
    if(!this.active)throw unavailable();
    if(this.corporate)sql=sql.replaceAll('"B2bEmailDeliveryJob"','"B2bCorporateEmailDeliveryJob"')
      .replaceAll('"B2bEmailDeliveryEvent"','"B2bCorporateEmailDeliveryEvent"');
    return this.db.query<T>(sql,values);
  }
  async job(id:string) {return (await this.query<{payload:EmailDeliveryJob}>('SELECT payload FROM "B2bEmailDeliveryJob" WHERE id=$1::uuid FOR UPDATE',[id])).rows[0]?.payload??null;}
  async prior(actorKey:string,keyHash:string) {return (await this.query<{payload:EmailDeliveryJob}>('SELECT payload FROM "B2bEmailDeliveryJob" WHERE actor_key=$1 AND key_hash=$2 FOR UPDATE',[actorKey,keyHash])).rows[0]?.payload??null;}
  async insert(j:EmailDeliveryJob) {
    await this.query('INSERT INTO "B2bEmailDeliveryJob" (id,actor_key,key_hash,revision,state,payload) VALUES ($1::uuid,$2,$3,$4,$5,$6::jsonb)',
      [j.id,j.actorKey,j.keyHash,j.revision,j.state,JSON.stringify(j)]);
  }
  async save(j:EmailDeliveryJob,expected:number) {
    const r=await this.query('UPDATE "B2bEmailDeliveryJob" SET revision=$2,state=$3,payload=$4::jsonb WHERE id=$1::uuid AND revision=$5',
      [j.id,j.revision,j.state,JSON.stringify(j),expected]);
    if(r.rowCount!==1)throw new B2bSecurityError(409,'EMAIL_REVISION_CONFLICT');
  }
  async append(e:EmailDeliveryEvent) {
    await this.query('INSERT INTO "B2bEmailDeliveryEvent" (id,job_id,revision,event_type,attempt_id,payload) VALUES ($1::uuid,$2::uuid,$3,$4,$5::uuid,$6::jsonb)',
      [e.id,e.jobId,e.revision,e.type,e.attemptId,JSON.stringify(e)]);
  }
}
/** Disabled by default, fixed bound SQL, audit in the job transaction. No schema installation or implicit DB. */
export class PostgresEmailDeliveryStore implements EmailDeliveryStore {
  private closed=false; private active=0; private drained:(()=>void)[]=[];private closing:Promise<void>|null=null;
  constructor(private readonly pool: EmailDeliveryPgPool,private readonly options:{enabled?:boolean;ownsPool?:boolean;profile?:'CORPORATE'}={}) {}
  async transaction<T>(locks:readonly string[],work:(tx:EmailDeliveryTransaction)=>Promise<T>):Promise<T> {
    if(this.closed||this.options.enabled!==true)throw unavailable();
    if(locks.length>4||locks.some(x=>typeof x!=='string'||x.length>500))throw unavailable();
    this.active++;let db:EmailDeliveryPgConnection|undefined,tx:Transaction|undefined,releaseError:Error|undefined;
    try {
      db=await this.pool.connect();
      await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await db.query("SET LOCAL statement_timeout = '10s'");
      await db.query("SET LOCAL lock_timeout = '3s'");
      await db.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
      const corporate=this.options.profile==='CORPORATE';
      const marker=await db.query<{version:string}>(corporate
        ? 'SELECT version FROM "B2bCorporateEmailDeliverySandbox" WHERE singleton=true'
        : 'SELECT version FROM "B2bEmailDeliverySandbox" WHERE singleton=true');
      if(marker.rows.length!==1||marker.rows[0].version!==(corporate?'factuez.b2b.email-deliveries.corporate.v1':'factuez.b2b.email-deliveries.v1'))throw unavailable();
      for(const lock of [...new Set(locks)].sort())await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[lock]);
      tx=new Transaction(db,corporate);const result=await work(tx);tx.finish();await db.query('COMMIT');return result;
    } catch(e) {
      if(db)try{await db.query('ROLLBACK');}catch{releaseError=unavailable();}
      if(e instanceof B2bSecurityError && ['EMAIL_STORE_UNAVAILABLE','EMAIL_REVISION_CONFLICT','RESOURCE_NOT_FOUND','IDEMPOTENCY_CONFLICT','INVALID_PRINCIPAL','ACCESS_CHANGED','EMAIL_CAPTURE_DISABLED','EMAIL_ARTIFACT_INTEGRITY','EMAIL_OWNER_UNAVAILABLE',
        'EMAIL_CORPORATE_DISABLED','EMAIL_REAL_SEND_FORBIDDEN','EMAIL_SMTP_CONFIGURATION_UNAVAILABLE','EMAIL_SMTP_CONFIGURATION_CHANGED','EMAIL_SMTP_POLICY','EMAIL_ATTEMPT_CHANGED'].includes(e.code))throw new B2bSecurityError(e.status,e.code);
      throw unavailable();
    } finally {tx?.finish();db?.release(releaseError);this.active--;if(!this.active)this.drained.splice(0).forEach(r=>r());}
  }
  close():Promise<void> {
    if(this.closing)return this.closing;this.closed=true;
    this.closing=(async()=>{if(this.active)await new Promise<void>(r=>this.drained.push(r));if(this.options.ownsPool)try{await this.pool.end();}catch{throw unavailable();}})();
    return this.closing;
  }
}
export function createPostgresEmailDeliveryStore(config:EmailDeliveryPgConfig,options:{enabled?:boolean;profile?:'CORPORATE'}={}):PostgresEmailDeliveryStore {
  if(options.enabled!==true||!config||!config.host||!config.database||!config.user||!config.password||
    !Number.isInteger(config.port)||config.port<1||config.port>65535)throw unavailable();
  const {Pool}=createRequire(__filename)('pg') as {Pool:new(c:unknown)=>EmailDeliveryPgPool};
  return new PostgresEmailDeliveryStore(new Pool({...config,max:Math.min(config.max??4,8),connectionTimeoutMillis:3000}),{enabled:true,ownsPool:true,profile:options.profile});
}

