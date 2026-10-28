import type {EmailDeliveryPgPool} from './email-deliveries.store';
export const b2bMailerRuntimeSchemaChecks=Object.freeze([
 'SELECT id,actor_key,key_hash,revision,state,payload FROM "B2bEmailDeliveryJob" WHERE false',
 'SELECT id,job_id,revision,event_type,attempt_id,payload FROM "B2bEmailDeliveryEvent" WHERE false',
]);
/** Readiness only, on the existing NONE/LOCAL_CAPTURE candidate. Never installs DDL. */
export async function checkB2bMailerRuntimeSchema(pool:EmailDeliveryPgPool,expected:{name:string;user:string}){
 let db:Awaited<ReturnType<EmailDeliveryPgPool['connect']>>|undefined,broken:Error|undefined;
 try{
  db=await pool.connect();await db.query('BEGIN READ ONLY');
  await db.query("SET LOCAL statement_timeout = '10s'");
  const current=await db.query<{database:string;role:string}>('SELECT current_database() AS database, current_user AS role');
  if(current.rows.length!==1||current.rows[0].database!==expected.name||current.rows[0].role!==expected.user)throw Error();
  const marker=await db.query<{version:string}>('SELECT version FROM "B2bEmailDeliverySandbox" WHERE singleton=true');
  if(marker.rows.length!==1||marker.rows[0].version!=='factuez.b2b.email-deliveries.v1')throw Error();
  for(const sql of b2bMailerRuntimeSchemaChecks)if((await db.query(sql)).rows.length)throw Error();
  const triggers=await db.query<{name:string;enabled:boolean}>(`SELECT t.tgname AS name, t.tgenabled IN ('O','A') AS enabled
   FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relname IN ('B2bEmailDeliveryJob','B2bEmailDeliveryEvent')
    AND t.tgname IN ('b2b_email_job_immutable','b2b_email_event_immutable','b2b_email_job_audit')`);
  if(triggers.rows.length!==3||triggers.rows.some(t=>!t.enabled)||new Set(triggers.rows.map(t=>t.name)).size!==3)throw Error();
  await db.query('COMMIT');
 }catch{
  if(db)try{await db.query('ROLLBACK');}catch{broken=Error('B2B_MAILER_SCHEMA_ROLLBACK_FAILED');}
  throw Error('B2B_MAILER_RUNTIME_STORAGE_NOT_READY');
 }finally{db?.release(broken);}
}
