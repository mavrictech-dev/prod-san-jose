import { PgTransaction, PostgresB2bStore } from './postgres-store';
import { fail } from './model';
import type { Sql, TransactionalSql } from '../integration/postgres-store';
import type { GuideGrantSet, GuideTransaction, GuideStore } from './guide-authority';

class PgGuideTransaction extends PgTransaction implements GuideTransaction {
  constructor(private readonly sql: Sql) { super(sql); }
  async guideGrants(id: string) {
    const rows = await this.sql.$queryRawUnsafe<GuideGrantSet[]>(`SELECT h."clientId",r."clientRevision",r."revision",r."bindings"
      FROM "B2bGuideGrantHead" h JOIN "B2bGuideGrantRevision" r ON r."clientId"=h."clientId" AND r."revision"=h."revision"
      WHERE h."clientId"=$1::uuid AND r."environment"='BETA' FOR UPDATE OF h`, id);
    return rows[0] ?? null;
  }
  async saveGuideGrants(row: GuideGrantSet, expected: number, actorId: string, at: string) {
    if (row.revision !== expected + 1) return fail(409, 'REVISION_CONFLICT');
    await this.sql.$executeRawUnsafe(`INSERT INTO "B2bGuideGrantRevision" ("clientId","revision","clientRevision","bindings","actorId","at")
      VALUES ($1::uuid,$2,$3,$4::jsonb,$5::uuid,$6::timestamptz)`, row.clientId, row.revision, row.clientRevision, JSON.stringify(row.bindings), actorId, at);
    const count = expected === 0
      ? await this.sql.$executeRawUnsafe(`INSERT INTO "B2bGuideGrantHead" ("clientId","revision") VALUES ($1::uuid,$2) ON CONFLICT DO NOTHING`, row.clientId, row.revision)
      : await this.sql.$executeRawUnsafe(`UPDATE "B2bGuideGrantHead" SET "revision"=$2 WHERE "clientId"=$1::uuid AND "revision"=$3`, row.clientId, row.revision, expected);
    if (count !== 1) return fail(409, 'REVISION_CONFLICT');
  }
}
/** Explicit construction only. No migration, startup hook, inferred grant or cross-owner SQL. */
export class PostgresB2bGuideStore implements GuideStore {
  private readonly base: PostgresB2bStore;
  constructor(private readonly db: TransactionalSql) { this.base = new PostgresB2bStore(db); }
  rate(hash: string, window: number, limit: number) { return this.base.rate(hash, window, limit); }
  transaction<T>(work: (tx: GuideTransaction) => Promise<T>) {
    return this.db.$transaction(sql => work(new PgGuideTransaction(sql)), { timeout: 15000, maxWait: 3000 });
  }
}
