import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {ownerKey,type HookStore,type HookTx,type Subscription,type InboxEvent,type Delivery,type Attempt,type Command,type Audit} from './model';
export interface HookSql {query(sql:string,values?:unknown[]):Promise<{rows:any[];rowCount:number|null}>}
export interface HookPool extends HookSql {connect():Promise<HookSql&{release():void}>}
class PgTx implements HookTx {
  constructor(private readonly db:HookSql){}
  private async one<T>(table:string,id:string){const rows=await this.db.query(`SELECT "payload" FROM "${table}" WHERE "id"=$1::uuid`,[id]);return rows.rows[0]?.payload as T??null;}
  sub(id:string){return this.one<Subscription>('WebhookSubscription',id);}
  event(id:string){return this.one<InboxEvent>('WebhookInbox',id);}
  delivery(id:string){return this.one<Delivery>('WebhookDelivery',id);}
  async putSub(s:Subscription){await this.db.query(`INSERT INTO "WebhookSubscription" ("id","owner","revision","payload") VALUES ($1::uuid,$2,$3,$4::jsonb) ON CONFLICT ("id") DO UPDATE SET "revision"=$3,"payload"=$4::jsonb`,[s.id,ownerKey(s.actor),s.revision,JSON.stringify(s)]);}
  async subs(owner?:string,after?:string,limit=101){const r=await this.db.query(`SELECT "payload" FROM "WebhookSubscription" WHERE ($1::text IS NULL OR "owner"=$1) AND ($2::uuid IS NULL OR "id">$2::uuid) ORDER BY "id" LIMIT $3`,[owner??null,after??null,limit]);return r.rows.map(x=>x.payload as Subscription);}
  async putEvent(e:InboxEvent){await this.db.query('INSERT INTO "WebhookInbox" ("id","hash","payload") VALUES ($1::uuid,$2,$3::jsonb)',[e.id,e.hash,JSON.stringify(e)]);}
  async putDelivery(d:Delivery){await this.db.query(`INSERT INTO "WebhookDelivery" ("id","subscriptionId","eventId","state","dueAt","leaseUntil","payload") VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::jsonb) ON CONFLICT ("id") DO UPDATE SET "state"=$4,"dueAt"=$5,"leaseUntil"=$6,"payload"=$7::jsonb`,[d.id,d.subscriptionId,d.eventId,d.state,d.dueAt,d.leaseUntil,JSON.stringify(d)]);}
  async deliveries(owner:string,after?:string,limit=101){const r=await this.db.query(`SELECT d."payload" FROM "WebhookDelivery" d JOIN "WebhookSubscription" s ON s."id"=d."subscriptionId" WHERE s."owner"=$1 AND ($2::uuid IS NULL OR d."id">$2::uuid) ORDER BY d."id" LIMIT $3`,[owner,after??null,limit]);return r.rows.map(x=>x.payload as Delivery);}
  async due(now:number,limit:number){const r=await this.db.query(`SELECT "payload" FROM "WebhookDelivery" WHERE ("state" IN ('PENDING','RETRY') AND "dueAt"<=$1) OR ("state"='RUNNING' AND "leaseUntil"<=$1) ORDER BY "dueAt","id" LIMIT $2 FOR UPDATE SKIP LOCKED`,[now,limit]);return r.rows.map(x=>x.payload as Delivery);}
  async attempts(id:string){const r=await this.db.query('SELECT "payload" FROM "WebhookAttempt" WHERE "deliveryId"=$1::uuid ORDER BY ("payload"->>\'at\')::bigint,"id" LIMIT 100',[id]);return r.rows.map(x=>x.payload as Attempt);}
  async attempt(a:Attempt){await this.db.query(`INSERT INTO "WebhookAttempt" ("id","deliveryId","payload") VALUES ($1::uuid,$2::uuid,$3::jsonb) ON CONFLICT ("id") DO UPDATE SET "payload"=$3::jsonb`,[a.id,a.deliveryId,JSON.stringify(a)]);}
  async prior(owner:string,key:string){const r=await this.db.query('SELECT "payload" FROM "WebhookCommand" WHERE "owner"=$1 AND "keyHash"=$2',[owner,key]);return r.rows[0]?.payload as Command??null;}
  async command(c:Command){await this.db.query('INSERT INTO "WebhookCommand" ("owner","keyHash","payload") VALUES ($1,$2,$3::jsonb)',[c.owner,c.keyHash,JSON.stringify(c)]);}
  async audit(a:Audit){await this.db.query('INSERT INTO "WebhookAudit" ("id","payload") VALUES ($1::uuid,$2::jsonb)',[a.id,JSON.stringify(a)]);}
}
export class PostgresHookStore implements HookStore {
  private constructor(private readonly db:HookPool){}
  static async isolated(db:HookPool){const r=await db.query('SELECT current_database() AS name');if(r.rows[0]?.name!=='b2b_webhooks_beta')throw new Error('Dedicated b2b_webhooks_beta database required');
    for(const t of ['WebhookSubscription','WebhookInbox','WebhookDelivery','WebhookAttempt','WebhookCommand','WebhookAudit'])await db.query(`SELECT "payload" FROM "${t}" WHERE false`);return new PostgresHookStore(db);}
  async transaction<T>(work:(tx:HookTx)=>Promise<T>):Promise<T>{const db=await this.db.connect();try{await db.query('BEGIN');await db.query("SET LOCAL statement_timeout='10s'");await db.query('SELECT pg_advisory_xact_lock(1985126506)');const result=await work(new PgTx(db));await db.query('COMMIT');return result;
    }catch(e){await db.query('ROLLBACK').catch(()=>{});if(e instanceof B2bSecurityError)throw e;throw new B2bSecurityError(503,'WEBHOOK_STORE_UNAVAILABLE');}finally{db.release();}}
}
