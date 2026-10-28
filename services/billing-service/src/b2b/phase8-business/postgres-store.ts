import { createRequire } from 'node:module';
import { fuelColumns, fuelFingerprint, fuelView, type FuelProductRow } from './fuel-product';
import { B2bSecurityError, type B2bBinding } from '@factuez/contracts/b2b-security';
import type { BoundedQuery, BusinessCustomer, BusinessMovement, BusinessOperation, BusinessProduct, BusinessScope, BusinessShift, BusinessStore, BusinessSummary, BusinessTransaction } from './types';
export interface BusinessPgResult<T> { rows: T[]; rowCount: number|null }
export interface BusinessPgConnection {
  query<T = Record<string,unknown>>(sql: string, values?: unknown[]): Promise<BusinessPgResult<T>>;
  release(error?: Error): void;
}
export interface BusinessPgPool { connect(): Promise<BusinessPgConnection>; end(): Promise<void> }
export interface BusinessPgConfig { connectionString?: string; host?: string; port?: number; user?: string; password?: string; database?: string; max?: number; connectionTimeoutMillis?: number; stream?: () => unknown }
const absent = () => new B2bSecurityError(503,'BUSINESS_STORE_UNAVAILABLE');
const conflict = () => new B2bSecurityError(412,'REVISION_CONFLICT');
const scopeValues = (s: BusinessScope): unknown[] => [s.issuerId,s.issuerRuc,s.environment];
/** SQL text and table names are fixed. Every caller value is bound separately. */
class PgBusinessTransaction implements BusinessTransaction {
  private active = true;
  constructor(private readonly db: BusinessPgConnection) {}
  finish() { this.active = false; }
  private run<T>(sql: string, values: unknown[] = []) {
    if (!this.active) throw absent();
    return this.db.query<T>(sql,values);
  }
  private async payloads<T>(sql: string, values: unknown[]): Promise<T[]> {
    return (await this.run<{payload:T}>(sql,values)).rows.map(r => r.payload);
  }
  async prior(actorKey: string, keyHash: string) {
    return (await this.payloads<BusinessOperation>('SELECT payload FROM "B2bP8Operation" WHERE actor_key=$1 AND key_hash=$2 AND environment=\'BETA\'',[actorKey,keyHash]))[0] ?? null;
  }
  async append(op: BusinessOperation) {
    await this.run('INSERT INTO "B2bP8Operation" (id,actor_key,key_hash,request_hash,payload) VALUES ($1::uuid,$2,$3,$4,$5::jsonb)',[op.id,op.actorKey,op.keyHash,op.requestHash,JSON.stringify(op)]);
  }
  customers(s: BusinessScope, q: BoundedQuery) {
    return this.payloads<BusinessCustomer>(`SELECT payload FROM "B2bP8Customer" WHERE issuer_id=$1 AND issuer_ruc=$2 AND environment=$3
      AND ($4::uuid IS NULL OR id>$4::uuid) AND ($5='' OR strpos(lower(search_text),lower($5))>0) ORDER BY id LIMIT $6`,[...scopeValues(s),q.after,q.q,q.limit]);
  }
  async customer(s: BusinessScope, id: string) {
    return (await this.payloads<BusinessCustomer>('SELECT payload FROM "B2bP8Customer" WHERE issuer_id=$1 AND issuer_ruc=$2 AND environment=$3 AND id=$4::uuid FOR UPDATE',[...scopeValues(s),id]))[0] ?? null;
  }
  async createCustomer(r: BusinessCustomer) {
    await this.run(`INSERT INTO "B2bP8Customer" (id,issuer_id,issuer_ruc,environment,identity_type,identity_number,revision,search_text,payload)
      VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,[r.id,...scopeValues(r),r.identityType,r.identityNumber,r.revision,r.legalName+' '+r.identityNumber,JSON.stringify(r)]);
  }
  async saveCustomer(r: BusinessCustomer, expected: number) {
    const result = await this.run(`UPDATE "B2bP8Customer" SET identity_type=$5,identity_number=$6,revision=$7,search_text=$8,payload=$9::jsonb
      WHERE id=$1::uuid AND issuer_id=$2 AND issuer_ruc=$3 AND environment=$4 AND revision=$10`,[r.id,...scopeValues(r),r.identityType,r.identityNumber,r.revision,r.legalName+' '+r.identityNumber,JSON.stringify(r),expected]);
    if (result.rowCount !== 1) throw conflict();
  }
  /** Sidecar holds only CAS metadata. The catalogue source and write target are FuelProduct. */
  private async productRevision(row: FuelProductRow): Promise<number> {
    const sha = fuelFingerprint(row);
    const result = await this.run<{revision:number}>(`INSERT INTO "B2bP8ProductRevision" (product_id,revision,source_sha256)
      VALUES ($1::uuid,1,$2) ON CONFLICT (product_id) DO UPDATE SET
      revision=CASE WHEN "B2bP8ProductRevision".source_sha256=EXCLUDED.source_sha256 THEN "B2bP8ProductRevision".revision ELSE "B2bP8ProductRevision".revision+1 END,
      source_sha256=EXCLUDED.source_sha256 RETURNING revision`,[row.id,sha]);
    return result.rows[0].revision;
  }
  async products(q: BoundedQuery) {
    const rows = await this.run<FuelProductRow>(`SELECT ${fuelColumns} FROM "FuelProduct"
      WHERE ($1::uuid IS NULL OR id>$1::uuid) AND ($2='' OR strpos(lower(sku||' '||description||' '||category),lower($2))>0)
      ORDER BY id LIMIT $3 FOR UPDATE`,[q.after,q.q,q.limit]);
    const products: BusinessProduct[] = [];
    for (const row of rows.rows) products.push(fuelView(row,await this.productRevision(row)));
    return products;
  }
  async product(id: string) {
    const result = await this.run<FuelProductRow>(`SELECT ${fuelColumns} FROM "FuelProduct" WHERE id=$1::uuid FOR UPDATE`,[id]);
    const row = result.rows[0];
    return row ? fuelView(row,await this.productRevision(row)) : null;
  }
  async createProduct(r: BusinessProduct) {
    const result = await this.run<FuelProductRow>(`INSERT INTO "FuelProduct"
      (id,sku,description,category,"unitCode","taxAffectationCode","defaultUnitPrice",active,"createdAt","updatedAt")
      VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::numeric,$8,$9::timestamp,$10::timestamp) RETURNING ${fuelColumns}`,
      [r.id,r.sku,r.description,r.category,r.unitCode,r.taxAffectationCode,r.defaultUnitPrice,r.active,r.createdAt,r.updatedAt]);
    await this.run('INSERT INTO "B2bP8ProductRevision" (product_id,revision,source_sha256) VALUES ($1::uuid,$2,$3)',
      [r.id,r.revision,fuelFingerprint(result.rows[0])]);
  }
  async saveProduct(r: BusinessProduct, expected: number) {
    // The engine obtained this row through product(), which locked FuelProduct and
    // observed any out-of-band POS/admin update before accepting expectedRevision.
    const head = await this.run<{revision:number;source_sha256:string}>('SELECT revision,source_sha256 FROM "B2bP8ProductRevision" WHERE product_id=$1::uuid FOR UPDATE',[r.id]);
    if (head.rows[0]?.revision !== expected) throw conflict();
    const current = await this.run<FuelProductRow>(`SELECT ${fuelColumns} FROM "FuelProduct" WHERE id=$1::uuid FOR UPDATE`,[r.id]);
    if (!current.rows[0] || fuelFingerprint(current.rows[0]) !== head.rows[0].source_sha256) throw conflict();
    const result = await this.run<FuelProductRow>(`UPDATE "FuelProduct" SET sku=$2,description=$3,category=$4,"unitCode"=$5,
      "taxAffectationCode"=$6,"defaultUnitPrice"=$7::numeric,active=$8,"updatedAt"=$9::timestamp WHERE id=$1::uuid RETURNING ${fuelColumns}`,
      [r.id,r.sku,r.description,r.category,r.unitCode,r.taxAffectationCode,r.defaultUnitPrice,r.active,r.updatedAt]);
    const saved = await this.run('UPDATE "B2bP8ProductRevision" SET revision=$2,source_sha256=$3 WHERE product_id=$1::uuid AND revision=$4',
      [r.id,r.revision,fuelFingerprint(result.rows[0]),expected]);
    if (saved.rowCount !== 1) throw conflict();
  }
  shifts(binding: B2bBinding, actorKey: string, q: BoundedQuery) {
    return this.payloads<BusinessShift>(`SELECT payload FROM "B2bP8Shift" WHERE environment='BETA' AND binding=$1::jsonb AND actor_key=$2
      AND ($3::uuid IS NULL OR id>$3::uuid) AND ($4='' OR strpos(lower(id::text||' '||state),lower($4))>0) ORDER BY id LIMIT $5`,[JSON.stringify(binding),actorKey,q.after,q.q,q.limit]);
  }
  async shift(binding: B2bBinding, actorKey: string, id: string) {
    return (await this.payloads<BusinessShift>(`SELECT payload FROM "B2bP8Shift" WHERE id=$1::uuid AND binding=$2::jsonb
      AND actor_key=$3 AND environment='BETA' FOR UPDATE`,[id,JSON.stringify(binding),actorKey]))[0] ?? null;
  }
  async createShift(r: BusinessShift) {
    await this.run(`INSERT INTO "B2bP8Shift" (id,issuer_id,issuer_ruc,branch_id,point_id,binding,actor_key,state,revision,currency,balance,payload)
      VALUES ($1::uuid,$2,$3,$4::uuid,$5::uuid,$6::jsonb,$7,$8,$9,$10,$11::numeric,$12::jsonb)`,
      [r.id,r.binding.issuerId,r.binding.issuerRuc,r.binding.branchId,r.binding.pointId,JSON.stringify(r.binding),r.actorKey,r.state,r.revision,r.currency,r.balance,JSON.stringify(r)]);
  }
  async saveShift(r: BusinessShift, expected: number) {
    const result = await this.run(`UPDATE "B2bP8Shift" SET state=$2,revision=$3,balance=$4::numeric,payload=$5::jsonb
      WHERE id=$1::uuid AND revision=$6 AND state='OPEN' AND actor_key=$7 AND binding=$8::jsonb AND environment='BETA'`,
      [r.id,r.state,r.revision,r.balance,JSON.stringify(r),expected,r.actorKey,JSON.stringify(r.binding)]);
    if (result.rowCount !== 1) throw conflict();
  }
  async movement(r: BusinessMovement) {
    await this.run(`INSERT INTO "B2bP8Movement" (id,shift_id,revision,kind,amount,balance_after,payload)
      VALUES ($1::uuid,$2::uuid,$3,$4,$5::numeric,$6::numeric,$7::jsonb)`,[r.id,r.shiftId,r.revision,r.kind,r.amount,r.balanceAfter,JSON.stringify(r)]);
  }
  async movementBalance(id: string) {
    const result = await this.run<{balance:string}>(`SELECT COALESCE(SUM(CASE WHEN kind IN ('OPEN','IN') THEN amount WHEN kind='OUT' THEN -amount ELSE 0 END),0)::text AS balance FROM "B2bP8Movement" WHERE shift_id=$1::uuid`,[id]);
    return result.rows[0].balance;
  }
  async summary(scope: BusinessScope, binding: B2bBinding, actorKey: string): Promise<BusinessSummary> {
    const counts = await this.run<Omit<BusinessSummary,'cash'>>(`SELECT
      (SELECT count(*)::text FROM "B2bP8Customer" WHERE issuer_id=$1 AND issuer_ruc=$2 AND environment=$3) AS customers,
      (SELECT count(*)::text FROM "B2bP8Customer" WHERE issuer_id=$1 AND issuer_ruc=$2 AND environment=$3 AND payload->>'active'='true') AS "activeCustomers",
      (SELECT count(*)::text FROM "FuelProduct") AS "sharedProducts",
      (SELECT count(*)::text FROM "B2bP8Shift" WHERE binding=$4::jsonb AND actor_key=$5 AND environment=$3) AS "actorPointShifts",
      (SELECT count(*)::text FROM "B2bP8Shift" WHERE binding=$4::jsonb AND actor_key=$5 AND state='OPEN' AND environment=$3) AS "actorPointOpenShifts"`,[...scopeValues(scope),JSON.stringify(binding),actorKey]);
    const cash = await this.run<BusinessSummary['cash'][number]>(`SELECT s.currency,
      COALESCE(SUM(m.amount) FILTER (WHERE m.kind='IN'),0)::numeric(30,2)::text AS incoming,
      COALESCE(SUM(m.amount) FILTER (WHERE m.kind='OUT'),0)::numeric(30,2)::text AS outgoing
      FROM "B2bP8Shift" s JOIN "B2bP8Movement" m ON m.shift_id=s.id
      WHERE s.binding=$1::jsonb AND s.actor_key=$2 AND s.environment='BETA' GROUP BY s.currency ORDER BY s.currency`,[JSON.stringify(binding),actorKey]);
    return {...counts.rows[0],cash:cash.rows};
  }
}
function mapped(error: unknown): Error {
  if (error instanceof B2bSecurityError) return error;
  const e = error as {code?:string;constraint?:string};
  if (e?.code === '23505') {
    const code = e.constraint === 'B2bP8Shift_one_open_point' ? 'SHIFT_ALREADY_OPEN' :
      e.constraint?.startsWith('B2bP8Customer_') ? 'CUSTOMER_IDENTITY_CONFLICT' :
      e.constraint === 'FuelProduct_sku_key' ? 'PRODUCT_SKU_CONFLICT' : 'BUSINESS_UNIQUE_CONFLICT';
    return new B2bSecurityError(409,code);
  }
  if (['40001','40P01','55P03'].includes(e?.code ?? '')) return new B2bSecurityError(409,'BUSINESS_TRANSACTION_RETRY');
  return absent();
}
export class PostgresBusinessStore implements BusinessStore {
  private closed = false;
  constructor(private readonly pool: BusinessPgPool, private readonly ownsPool = false) {}
  async transaction<T>(lockKeys: readonly string[], work: (tx: BusinessTransaction) => Promise<T>): Promise<T> {
    if (this.closed) throw absent();
    let connection: BusinessPgConnection|undefined, tx: PgBusinessTransaction|undefined, releaseError: Error|undefined;
    try {
      connection = await this.pool.connect();
      if (this.closed) throw absent();
      await connection.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await connection.query("SET LOCAL statement_timeout = '10s'");
      await connection.query("SET LOCAL lock_timeout = '3s'");
      await connection.query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
      for (const key of [...new Set(lockKeys)].sort()) {
        await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
      }
      tx = new PgBusinessTransaction(connection);
      const result = await work(tx);
      tx.finish();
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      if (connection) try { await connection.query('ROLLBACK'); } catch { releaseError = absent(); }
      throw mapped(error);
    } finally { tx?.finish(); connection?.release(releaseError); }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsPool) await this.pool.end();
  }
}
/** Explicit configuration; never loads .env, installs DDL or opens an implicit application DB. */
export function createPostgresBusinessStore(config: BusinessPgConfig): PostgresBusinessStore {
  if (!config || !(config.connectionString || config.host && config.database && config.user)) throw new Error('EXPLICIT_BUSINESS_DATABASE_REQUIRED');
  const {Pool} = createRequire(__filename)('pg') as {Pool:new (config:BusinessPgConfig) => BusinessPgPool};
  return new PostgresBusinessStore(new Pool({...config,max:config.max ?? 4,connectionTimeoutMillis:config.connectionTimeoutMillis ?? 3000}),true);
}

