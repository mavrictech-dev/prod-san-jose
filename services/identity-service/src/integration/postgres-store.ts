import { fail, type Audit, type Client, type Store, type Transaction, type ClientView } from './model';

export interface Sql {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
}
export interface TransactionalSql extends Sql {
  $transaction<T>(work: (sql: Sql) => Promise<T>, options?: { timeout: number; maxWait: number }): Promise<T>;
}
function times<T extends { createdAt: Date | string; updatedAt: Date | string; secretRotatedAt: Date | string }>(row: T) {
  return { ...row, createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString(),
    secretRotatedAt: new Date(row.secretRotatedAt).toISOString() };
}
class PostgresTransaction implements Transaction {
  constructor(private readonly sql: Sql) {}
  rate(keyHash: string, window: number, limit: number) { return consumeRate(this.sql, keyHash, window, limit); }
  async get(id: string) {
    const rows = await this.sql.$queryRawUnsafe<Client[]>(`SELECT "id", "label", "enabled", "revision", "secretHash", "scopes", "grants",
      "createdAt", "updatedAt", "secretRotatedAt" FROM "IntegrationClient" WHERE "id" = $1::uuid AND "environment" = 'BETA' FOR UPDATE`, id);
    return rows[0] ? times(rows[0]) : null;
  }
  async create(c: Client) {
    await this.sql.$executeRawUnsafe(`INSERT INTO "IntegrationClient"
      ("id","label","enabled","revision","secretHash","scopes","grants","createdAt","updatedAt","secretRotatedAt")
      VALUES ($1::uuid,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::timestamptz,$9::timestamptz,$10::timestamptz)`,
      c.id, c.label, c.enabled, c.revision, c.secretHash, JSON.stringify(c.scopes), JSON.stringify(c.grants), c.createdAt, c.updatedAt, c.secretRotatedAt);
  }
  async save(c: Client, revision: number) {
    const count = await this.sql.$executeRawUnsafe(`UPDATE "IntegrationClient" SET "label"=$2,"enabled"=$3,"revision"=$4,
      "secretHash"=$5,"scopes"=$6::jsonb,"grants"=$7::jsonb,"updatedAt"=$8::timestamptz,"secretRotatedAt"=$9::timestamptz
      WHERE "id"=$1::uuid AND "environment"='BETA' AND "revision"=$10`,
      c.id, c.label, c.enabled, c.revision, c.secretHash, JSON.stringify(c.scopes), JSON.stringify(c.grants), c.updatedAt, c.secretRotatedAt, revision);
    if (count !== 1) return fail(409, 'REVISION_CONFLICT');
  }
  async audit(a: Audit) {
    await this.sql.$executeRawUnsafe(`INSERT INTO "IntegrationAudit"
      ("id","clientId","actorId","requestId","peerHash","action","outcome","revision","at")
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9::timestamptz)`,
      a.id, a.clientId, a.actorId, a.requestId, a.peerHash, a.action, a.outcome, a.revision, a.at);
  }
}
export class PostgresIntegrationStore implements Store {
  constructor(private readonly db: TransactionalSql) {}
  async ready() {
    // Validate table/column presence without reading any client, credential or audit row.
    await this.db.$queryRawUnsafe(`SELECT c."id",c."secretHash",c."scopes",c."grants",c."revision",c."enabled",c."environment",
      c."label",c."createdAt",c."updatedAt",c."secretRotatedAt",a."id",a."clientId",a."actorId",a."requestId",a."peerHash",
      a."action",a."outcome",a."revision",a."at",r."keyHash",r."window",r."count"
      FROM "IntegrationClient" c CROSS JOIN "IntegrationAudit" a CROSS JOIN "IntegrationRateBucket" r WHERE false`);
  }
  transaction<T>(work: (tx: Transaction) => Promise<T>) {
    return this.db.$transaction(sql => work(new PostgresTransaction(sql)), { timeout: 15000, maxWait: 3000 });
  }
  async list(): Promise<ClientView[]> {
    const rows = await this.db.$queryRawUnsafe<ClientView[]>(`SELECT "id","label","enabled","revision","scopes","grants",
      "createdAt","updatedAt","secretRotatedAt" FROM "IntegrationClient" WHERE "environment"='BETA' ORDER BY "createdAt","id" LIMIT 1001`);
    if (rows.length > 1000) return fail(503, 'CLIENT_LIST_LIMIT');
    return rows.map(times);
  }
  async rate(keyHash: string, window: number, limit: number) {
    return consumeRate(this.db, keyHash, window, limit);
  }
}
async function consumeRate(db: Sql, keyHash: string, window: number, limit: number) {
    const rows = await db.$queryRawUnsafe<Array<{ count: number }>>(`INSERT INTO "IntegrationRateBucket" ("keyHash","window","count")
      VALUES ($1,$2,1) ON CONFLICT ("keyHash") DO UPDATE SET
      "count"=CASE WHEN "IntegrationRateBucket"."window" < $2 THEN 1 ELSE "IntegrationRateBucket"."count"+1 END,"window"=$2
      WHERE "IntegrationRateBucket"."window" < $2 OR ("IntegrationRateBucket"."window"=$2 AND "IntegrationRateBucket"."count" < $3)
      RETURNING "count"`, keyHash, window, limit);
    return rows.length === 1;
}
