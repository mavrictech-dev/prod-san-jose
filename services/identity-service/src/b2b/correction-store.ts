import { PgTransaction, PostgresB2bStore } from './postgres-store';
import { fail } from './model';
import type { Sql, TransactionalSql } from '../integration/postgres-store';
import type { CorrectionGrantSet, CorrectionTransaction, CorrectionStore } from './correction-authority';
class PgCorrectionTransaction extends PgTransaction implements CorrectionTransaction {
  constructor(private readonly sql: Sql) { super(sql); }
  async correctionGrants(id: string) {
    const rows = await this.sql.$queryRawUnsafe<CorrectionGrantSet[]>(`SELECT h."clientId",r."clientRevision",r."revision",r."bindings"
      FROM "B2bCorrectionGrantHead" h JOIN "B2bCorrectionGrantRevision" r ON r."clientId"=h."clientId" AND r."revision"=h."revision"
      WHERE h."clientId"=$1::uuid FOR UPDATE OF h`, id);
    return rows[0] ?? null;
  }
  async saveCorrectionGrants(row: CorrectionGrantSet, expected: number, actorId: string, at: string) {
    await this.sql.$executeRawUnsafe(`INSERT INTO "B2bCorrectionGrantRevision" ("clientId","revision","clientRevision","bindings","actorId","at")
      VALUES ($1::uuid,$2,$3,$4::jsonb,$5::uuid,$6::timestamptz)`, row.clientId,row.revision,row.clientRevision,JSON.stringify(row.bindings),actorId,at);
    const n = expected === 0
      ? await this.sql.$executeRawUnsafe(`INSERT INTO "B2bCorrectionGrantHead" ("clientId","revision") VALUES ($1::uuid,$2) ON CONFLICT DO NOTHING`, row.clientId,row.revision)
      : await this.sql.$executeRawUnsafe(`UPDATE "B2bCorrectionGrantHead" SET "revision"=$2 WHERE "clientId"=$1::uuid AND "revision"=$3`, row.clientId,row.revision,expected);
    if (n !== 1) return fail(409, 'REVISION_CONFLICT');
  }
}
/** Explicit construction only; never applies SQL or seeds grants. */
export class PostgresB2bCorrectionStore implements CorrectionStore {
  private readonly base: PostgresB2bStore;
  constructor(private readonly db: TransactionalSql) { this.base = new PostgresB2bStore(db); }
  rate(hash: string, window: number, limit: number) { return this.base.rate(hash,window,limit); }
  transaction<T>(work: (tx: CorrectionTransaction) => Promise<T>) {
    return this.db.$transaction(sql => work(new PgCorrectionTransaction(sql)), {timeout:15000,maxWait:3000});
  }
}
