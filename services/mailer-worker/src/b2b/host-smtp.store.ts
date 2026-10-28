import {AccessError} from '@factuez/service-access';
import {inspect} from 'node:util';
import type {EmailDeliveryPgPool,EmailDeliveryPgConnection} from './email-deliveries.store';
import type {SmtpIssuer,StoredSmtpConfiguration} from '../smtp-configuration.store';
export const mailerHostSmtpSchemaVersion='factuez.b2b.host-smtp.prepared.v1';
const unavailable=()=>new AccessError(503,'B2B_MAILER_SMTP_STORAGE_NOT_READY');
const conflict=()=>new AccessError(409,'B2B_MAILER_SMTP_REVISION_CONFLICT');
const columns='"companyId", "issuerRuc" AS ruc, "configurationCipher", "keyVersion", revision, "updatedAt"';
/** Separate prepared-only BETA storage. The caller owns the shared TLS PG pool. */
export class MailerHostSmtpStore {
 #pool:EmailDeliveryPgPool; #database:{name:string;user:string};
 constructor(pool:EmailDeliveryPgPool,database:{name:string;user:string}){
  if(!pool||typeof pool.connect!=='function'||database?.name!=='factuez_mailer_beta'||!/^[a-z][a-z0-9_]{0,62}$/.test(database.user))throw unavailable();
  this.#pool=pool;this.#database={...database};
 }
 async #check(db:EmailDeliveryPgConnection){
  const current=await db.query<{database:string;role:string;ssl:boolean;version:string}>(`SELECT current_database() AS database,current_user AS role,s.ssl,s.version FROM pg_stat_ssl s WHERE s.pid=pg_backend_pid()`);
  const row=current.rows[0];
  if(current.rows.length!==1||row.database!==this.#database.name||row.role!==this.#database.user||row.ssl!==true||!['TLSv1.2','TLSv1.3'].includes(row.version))throw unavailable();
  const marker=await db.query<{version:string}>('SELECT version FROM public."B2bHostSmtpPreparedSchema" WHERE singleton=true');
  if(marker.rows.length!==1||marker.rows[0].version!==mailerHostSmtpSchemaVersion)throw unavailable();
  for(const sql of [`SELECT ${columns},"updatedBy" FROM public."B2bHostSmtpConfiguration" WHERE false`,
   'SELECT id,"issuerRuc","companyId","actorId",revision,"credentialsReplaced",action,"createdAt" FROM public."B2bHostSmtpConfigurationAudit" WHERE false']){
   if((await db.query(sql)).rows.length)throw unavailable();
  }
  const triggers=await db.query<{name:string;enabled:boolean}>(`SELECT t.tgname AS name,t.tgenabled IN ('O','A') AS enabled
   FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND ((c.relname='B2bHostSmtpConfiguration' AND t.tgname IN ('b2b_host_smtp_immutable','b2b_host_smtp_audit_required'))
    OR (c.relname='B2bHostSmtpConfigurationAudit' AND t.tgname='b2b_host_smtp_audit_immutable'))`);
  if(triggers.rows.length!==3||triggers.rows.some(t=>!t.enabled)||new Set(triggers.rows.map(t=>t.name)).size!==3)throw unavailable();
 }
 async #connection<T>(work:(db:EmailDeliveryPgConnection,discard:(error:Error)=>void)=>Promise<T>):Promise<T>{
  let db:EmailDeliveryPgConnection|undefined,broken:Error|undefined;
  try{db=await this.#pool.connect();return await work(db,error=>{broken=error;});}catch(e){if(e instanceof AccessError&&e.status===409)throw conflict();throw unavailable();}finally{db?.release(broken);}
 }
 /** Every readiness statement is SELECT. No DDL, startup INSERT, secret read or RPC. */
 checkStorage(){return this.#connection(db=>this.#check(db));}
 read(issuer:SmtpIssuer){return this.#connection(async db=>{await this.#check(db);
  const result=await db.query<StoredSmtpConfiguration>(`SELECT ${columns} FROM public."B2bHostSmtpConfiguration" WHERE "issuerRuc"=$1 AND "companyId"=$2`,[issuer.ruc,issuer.companyId]);
  if(result.rows.length>1)throw unavailable();return result.rows[0]??null;
 });}
 save(issuer:SmtpIssuer,sealed:{cipher:string;keyVersion:number},expectedRevision:number,actorId:string,credentialsReplaced:boolean,revalidate:()=>Promise<void>){
  return this.#connection(async (db,discard)=>{
   let begun=false;
   try{
    await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');begun=true;
    await db.query("SET LOCAL statement_timeout = '10s'");await db.query("SET LOCAL lock_timeout = '3s'");
    await db.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
    await this.#check(db);
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`b2b-host-smtp:${issuer.ruc}`]);
    const before=await db.query<{companyId:number;revision:number}>('SELECT "companyId",revision FROM public."B2bHostSmtpConfiguration" WHERE "issuerRuc"=$1 FOR UPDATE',[issuer.ruc]);
    if(before.rows.length>1||(before.rows[0]?.revision??0)!==expectedRevision||before.rows[0]&&before.rows[0].companyId!==issuer.companyId)throw conflict();
    // Recheck the real capability and current Billing hierarchy after acquiring the lock.
    await revalidate();
    const result=await db.query<StoredSmtpConfiguration>(`INSERT INTO public."B2bHostSmtpConfiguration" ("issuerRuc","companyId","configurationCipher","keyVersion",revision,"updatedBy")
     VALUES ($1,$2,$3,$4,$5,$6::uuid) ON CONFLICT ("issuerRuc") DO UPDATE SET "configurationCipher"=EXCLUDED."configurationCipher",
     "keyVersion"=EXCLUDED."keyVersion",revision=EXCLUDED.revision,"updatedBy"=EXCLUDED."updatedBy","updatedAt"=CURRENT_TIMESTAMP
     WHERE "B2bHostSmtpConfiguration"."companyId"=$2 AND "B2bHostSmtpConfiguration".revision=$7 RETURNING ${columns}`,
     [issuer.ruc,issuer.companyId,sealed.cipher,sealed.keyVersion,expectedRevision+1,actorId,expectedRevision]);
    if(result.rowCount!==1)throw conflict();
    await db.query(`INSERT INTO public."B2bHostSmtpConfigurationAudit" ("issuerRuc","companyId","actorId",revision,"credentialsReplaced") VALUES ($1,$2,$3::uuid,$4,$5)`,
     [issuer.ruc,issuer.companyId,actorId,expectedRevision+1,credentialsReplaced]);
    await revalidate();await db.query('COMMIT');begun=false;return result.rows[0];
   }catch(e){if(begun)try{await db.query('ROLLBACK');}catch{discard(unavailable());}throw e;}
  });
 }
 toJSON(){return {service:'MailerHostSmtpStore',environment:'BETA',profile:'PREPARED_ONLY'};}
 [inspect.custom](){return this.toJSON();}
}
