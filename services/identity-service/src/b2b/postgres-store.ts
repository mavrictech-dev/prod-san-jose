import type { Sql, TransactionalSql } from '../integration/postgres-store';
import { fail, type Store, type Transaction, type Client, type ClientMetadata, type ClientPageQuery, clientPageQuery, type Audit } from './model';
export class PgTransaction implements Transaction {
  constructor(private readonly db: Sql) {}
  async list(query: ClientPageQuery): Promise<ClientMetadata[]> {
    const page = clientPageQuery(query);
    return this.db.$queryRawUnsafe<ClientMetadata[]>(`SELECT "id","label","kind","enabled","revision","oidcClientId","scopes","bindings" FROM "B2bClient" WHERE "environment"='BETA' AND ($1::uuid IS NULL OR "id">$1::uuid) ORDER BY "id" ASC LIMIT $2`, page.after ?? null, page.limit + 1);
  }
  async get(id: string): Promise<Client | null> {
    const rows = await this.db.$queryRawUnsafe<Client[]>(`SELECT "id","label","kind","enabled","revision","secretHash","oidcClientId","scopes","bindings" FROM "B2bClient" WHERE "id"=$1::uuid AND "environment"='BETA' FOR UPDATE`, id);
    return rows[0] ?? null;
  }
  async create(row: Client) {
    await this.db.$executeRawUnsafe(`INSERT INTO "B2bClient" ("id","label","kind","enabled","revision","secretHash","oidcClientId","scopes","bindings") VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`, row.id,row.label,row.kind,row.enabled,row.revision,row.secretHash,row.oidcClientId,JSON.stringify(row.scopes),JSON.stringify(row.bindings));
  }
  async save(row: Client, revision: number) {
    const count = await this.db.$executeRawUnsafe(`UPDATE "B2bClient" SET "enabled"=$2,"revision"=$3,"secretHash"=$4,"scopes"=$5::jsonb,"bindings"=$6::jsonb,"label"=$8 WHERE "id"=$1::uuid AND "revision"=$7 AND "environment"='BETA'`, row.id,row.enabled,row.revision,row.secretHash,JSON.stringify(row.scopes),JSON.stringify(row.bindings),revision,row.label);
    if (count !== 1) return fail(409,'REVISION_CONFLICT');
  }
  async audit(row: Audit) {
    await this.db.$executeRawUnsafe(`INSERT INTO "B2bAudit" ("id","requestId","clientId","actorId","action","outcome","revision","peerHash","at") VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9::timestamptz)`,row.id,row.requestId,row.clientId,row.actorId,row.action,row.outcome,row.revision,row.peerHash,row.at);
  }
}
export class PostgresB2bStore implements Store {
  constructor(private readonly db: TransactionalSql) {}
  transaction<T>(work: (tx: Transaction) => Promise<T>) { return this.db.$transaction(db => work(new PgTransaction(db)), { timeout: 15000, maxWait: 3000 }); }
  async rate(keyHash: string, window: number, limit: number) {
    const rows = await this.db.$queryRawUnsafe<unknown[]>(`INSERT INTO "B2bRateBucket" ("keyHash","window","count") VALUES ($1,$2,1) ON CONFLICT ("keyHash") DO UPDATE SET "count"=CASE WHEN "B2bRateBucket"."window"<$2 THEN 1 ELSE "B2bRateBucket"."count"+1 END,"window"=$2 WHERE "B2bRateBucket"."window"<$2 OR ("B2bRateBucket"."window"=$2 AND "B2bRateBucket"."count"<$3) RETURNING "count"`,keyHash,window,limit);
    return rows.length === 1;
  }
}
