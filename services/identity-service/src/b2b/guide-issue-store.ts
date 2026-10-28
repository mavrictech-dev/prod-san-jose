import { PgTransaction, PostgresB2bStore } from './postgres-store';
import { B2bIdentityError, fail, uuid, type Audit, type Client } from './model';
import { b2bBindingsContain, validB2bPrincipal } from '@factuez/contracts/b2b-security';
import type { Sql, TransactionalSql } from '../integration/postgres-store';
import { guideIssueEnrollmentAllowed, guideIssueGrantSet, guideIssueJson,
  type GuideIssueGrantSet, type GuideIssueTransaction, type GuideIssueStore } from './guide-issue-authority';

const unavailable = (): never => fail(503, 'GUIDE_ISSUE_AUTHORITY_UNAVAILABLE');
const integer = (value: unknown, min = 1) => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= 2147483647;
/** All operations poison the transaction on failure, including failures caught by callers. */
class PgGuideIssueTransaction extends PgTransaction implements GuideIssueTransaction {
  private poisoned = false;
  private closed = false;
  private pending = 0;
  private readonly clients = new Map<string, Client>();
  private readonly grants = new Map<string, GuideIssueGrantSet | null>();
  private readonly auditsRequired = new Map<string, { revision: number; actorId: string }>();
  constructor(private readonly sql: Sql) { super(sql); }
  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed || this.poisoned) return unavailable();
    this.pending++;
    try { return await work(); }
    catch (error) { this.poisoned = true; throw error; }
    finally { this.pending--; }
  }
  finish() {
    this.closed = true;
    if (this.poisoned || this.pending || this.auditsRequired.size) return unavailable();
  }
  abort() { this.closed = true; this.poisoned = true; }
  override get(id: string): ReturnType<PgTransaction['get']> {
    return this.guarded(async () => {
      if (!uuid(id)) return unavailable();
      const row = guideIssueJson(await super.get(id), 503, 'GUIDE_ISSUE_AUTHORITY_UNAVAILABLE');
      if (row === null) return null;
      if (row.id !== id || typeof row.enabled !== 'boolean' || !integer(row.revision) ||
        !validB2bPrincipal({ kind: row.kind, clientId: row.id, revision: row.revision, subjectId: row.kind === 'SERVICE' ? null : id,
          userAuthRevision: row.kind === 'SERVICE' ? null : 0, scopes: row.scopes, bindings: row.bindings, environment: 'BETA' })) return unavailable();
      this.clients.set(id, row);
      return structuredClone(row) as Client;
    });
  }
  // This port can only modify its own independent grants and append audits.
  override create(_row: Client): Promise<void> { return this.guarded(async () => unavailable()); }
  override save(_row: Client, _expected: number): ReturnType<PgTransaction['save']> { return this.guarded(async () => unavailable()); }
  guideIssueGrants(id: string): Promise<GuideIssueGrantSet | null> {
    return this.guarded(async () => {
      if (!uuid(id) || !this.clients.has(id)) return unavailable();
      // LEFT joins detect broken heads instead of mistaking corrupt physical state for no grant.
      const rows = guideIssueJson(await this.sql.$queryRawUnsafe<any[]>(`SELECT c."id" AS "clientId",h."revision" AS "headRevision",
        r."clientRevision",r."revision",r."bindings",r."environment",
        (SELECT count(*)::int FROM "B2bGuideIssueGrantRevision" x WHERE x."clientId"=c."id") AS "total",
        (SELECT max(x."revision") FROM "B2bGuideIssueGrantRevision" x WHERE x."clientId"=c."id") AS "last"
        FROM "B2bClient" c LEFT JOIN "B2bGuideIssueGrantHead" h ON h."clientId"=c."id"
        LEFT JOIN "B2bGuideIssueGrantRevision" r ON r."clientId"=h."clientId" AND r."revision"=h."revision"
        WHERE c."id"=$1::uuid AND c."environment"='BETA'`, id), 503, 'GUIDE_ISSUE_AUTHORITY_UNAVAILABLE');
      if (!Array.isArray(rows) || rows.length !== 1) return unavailable();
      const row = rows[0];
      if (row.clientId !== id) return unavailable();
      if (row.headRevision === null && row.total === 0 && row.last === null && row.revision === null && row.clientRevision === null && row.bindings === null && row.environment === null) {
        this.grants.set(id, null); return null;
      }
      if (!integer(row.headRevision) || row.headRevision !== row.revision || row.total !== row.revision || row.last !== row.revision || row.environment !== 'BETA') return unavailable();
      const grant = guideIssueGrantSet({ clientId: row.clientId, clientRevision: row.clientRevision, revision: row.revision, bindings: row.bindings }, id)!;
      // Historical revisions may legitimately have old scopes/anchors; only current grants must fit.
      const client = this.clients.get(id)!;
      if (grant.clientRevision > client.revision || grant.clientRevision === client.revision && grant.bindings.length &&
        (!guideIssueEnrollmentAllowed(client.scopes) ||
          grant.bindings.some(pair => pair.draft.guideType !== '09' || !b2bBindingsContain(client.bindings, pair.draft.anchor)))) return unavailable();
      this.grants.set(id, grant); return structuredClone(grant);
    });
  }
  saveGuideIssueGrants(value: GuideIssueGrantSet, expected: number, actorId: string, at: string): Promise<void> {
    return this.guarded(async () => {
      const detached = guideIssueJson(value, 503, 'GUIDE_ISSUE_AUTHORITY_UNAVAILABLE');
      const row = guideIssueGrantSet(detached, detached?.clientId);
      if (!row || !uuid(row.clientId) || !uuid(actorId) || typeof at !== 'string' || !Number.isFinite(Date.parse(at)) ||
        !integer(expected, 0) || expected >= 2147483647 || !this.grants.has(row.clientId) || this.auditsRequired.has(row.clientId)) return unavailable();
      if (row.revision !== expected + 1 || (this.grants.get(row.clientId)?.revision ?? 0) !== expected) return fail(409, 'REVISION_CONFLICT');
      const client = this.clients.get(row.clientId);
      if (!client?.enabled || client.revision !== row.clientRevision || row.bindings.length &&
        (!guideIssueEnrollmentAllowed(client.scopes) || row.bindings.some(pair => pair.draft.guideType !== '09' ||
          !b2bBindingsContain(client.bindings, pair.draft.anchor)))) return unavailable();
      const inserted = await this.sql.$executeRawUnsafe(`INSERT INTO "B2bGuideIssueGrantRevision" ("clientId","revision","clientRevision","bindings","actorId","at")
        VALUES ($1::uuid,$2,$3,$4::jsonb,$5::uuid,$6::timestamptz)`, row.clientId, row.revision, row.clientRevision, JSON.stringify(row.bindings), actorId, at);
      if (inserted !== 1) return unavailable();
      const count = expected === 0
        ? await this.sql.$executeRawUnsafe(`INSERT INTO "B2bGuideIssueGrantHead" ("clientId","revision") VALUES ($1::uuid,$2) ON CONFLICT DO NOTHING`, row.clientId, row.revision)
        : await this.sql.$executeRawUnsafe(`UPDATE "B2bGuideIssueGrantHead" SET "revision"=$2 WHERE "clientId"=$1::uuid AND "revision"=$3`, row.clientId, row.revision, expected);
      if (count !== 1) return fail(409, 'REVISION_CONFLICT');
      this.grants.set(row.clientId, row);
      this.auditsRequired.set(row.clientId, { revision: row.clientRevision, actorId });
    });
  }
  override audit(event: Audit): Promise<void> {
    return this.guarded(async () => {
      const row = guideIssueJson(event, 503, 'GUIDE_ISSUE_AUTHORITY_UNAVAILABLE') as Audit;
      if (!uuid(row.id) || !uuid(row.requestId) || !uuid(row.clientId) || row.actorId !== null && !uuid(row.actorId) ||
        !integer(row.revision) || !/^[a-f0-9]{64}$/.test(row.peerHash) || typeof row.action !== 'string' ||
        !['REPLACE_GUIDE_ISSUE_GRANTS', 'READ_GUIDE_ISSUE_GRANTS', 'AUTHORIZE_GUIDE_ISSUE_ISSUE', 'AUTHORIZE_GUIDE_ISSUE_READ'].includes(row.action) ||
        !['OK', 'DENIED', 'UNAVAILABLE'].includes(row.outcome) || !Number.isFinite(Date.parse(row.at))) return unavailable();
      const required = this.auditsRequired.get(row.clientId);
      if (row.action === 'REPLACE_GUIDE_ISSUE_GRANTS' && (!required || row.outcome !== 'OK' || required.actorId !== row.actorId || required.revision !== row.revision)) return unavailable();
      await super.audit(row);
      if (row.action === 'REPLACE_GUIDE_ISSUE_GRANTS') this.auditsRequired.delete(row.clientId);
    });
  }
}
/** Explicit candidate composition only. Serializable is set as the first statement because
 * the shared TransactionalSql port intentionally does not expose isolation options. */
export class PostgresB2bGuideIssueStore implements GuideIssueStore {
  private readonly base: PostgresB2bStore;
  constructor(private readonly db: TransactionalSql) { this.base = new PostgresB2bStore(db); }
  rate(hash: string, window: number, limit: number) { return this.base.rate(hash, window, limit); }
  async transaction<T>(work: (tx: GuideIssueTransaction) => Promise<T>): Promise<T> {
    try {
      return await this.db.$transaction(async sql => {
        await sql.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
        const tx = new PgGuideIssueTransaction(sql);
        try { const result = await work(tx); tx.finish(); return result; }
        catch (error) { tx.abort(); throw error; }
      }, { timeout: 15000, maxWait: 3000 });
    } catch (error) {
      if (error instanceof B2bIdentityError) throw error;
      // Prisma wraps PostgreSQL serialization conflicts differently for raw queries.
      const e = error as { code?: string; meta?: { code?: string } };
      if (e?.code === 'P2034' || e?.code === '40001' || e?.meta?.code === '40001') return fail(409, 'REVISION_CONFLICT');
      return unavailable();
    }
  }
}
