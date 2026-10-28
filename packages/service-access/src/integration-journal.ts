/** Technical owner journal only; never expose these owner/artifact IDs publicly
 * before resolving and authorizing the complete resource (all batch members).
 * Each database has its own journal. A vector of owner barriers is not a
 * distributed atomic cut. Billing capture may call readIntegrationJournal in
 * its SAME RepeatableRead, read-only Prisma transaction; read SUNAT's barrier
 * before capture and replay the conservative overlap.
 */
import { deny, IntegrationReadError, plain, ruc, uuid } from './integration';

export type JournalOwner = 'BILLING' | 'SUNAT';
export interface JournalSql {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}
export interface JournalClient extends JournalSql { release(): void | Promise<void> }
export interface JournalPool { connect(): Promise<JournalClient> }
export interface JournalPosition { epoch: string; sequence: string }
export interface JournalHead { epoch: string; head: string; floor: string }
export interface JournalEvent {
  /** Fixed database source prefix plus the stored source event UUID. */
  id: string;
  sequence: string;
  ownerKind: 'DOCUMENT' | 'BATCH';
  ownerId: string;
  kind: 'DOCUMENT_CREATED' | 'DOCUMENT_STATE_CHANGED' | 'ARTIFACT_ADDED' | 'DOCUMENT_RECONCILED';
  occurredAt: string;
  artifactId: string | null;
}
export interface JournalPage extends JournalHead { position: JournalPosition; events: JournalEvent[] }
export interface IntegrationJournal {
  read(issuerRuc: string, after: JournalPosition | null, limit?: number): Promise<JournalPage>;
}

const maximum = 9223372036854775807n;
const kinds = ['DOCUMENT_CREATED', 'DOCUMENT_STATE_CHANGED', 'ARTIFACT_ADDED', 'DOCUMENT_RECONCILED'];
type Trigger = { name: string; relation: string; type: number; routine: string };
function requiredTriggers(owner: JournalOwner): Trigger[] {
  const result: Trigger[] = [];
  const add = (name: string, relation: string, type: number, routine: string) => result.push({ name, relation, type, routine });
  // PostgreSQL tgtype bits: ROW=1, BEFORE=2, INSERT=4, DELETE=8,
  // UPDATE=16, TRUNCATE=32. Require exact events/timing and public routine.
  if (owner === 'BILLING') {
    for (const [name, table, routine] of [['Document', 'Document', 'document'], ['Company', 'CompanySettings', 'company']]) {
      add(`IntegrationChange${name}`, table, 21, `integration_change_billing_${routine}`);
      add(`IntegrationChange${name}Guard`, table, 27, `integration_change_billing_${routine}_guard`);
    }
    for (const [name, table] of [['Point', 'EmissionPoint'], ['Counter', 'SeriesCounter'], ['Branch', 'Branch']])
      add(`IntegrationChange${name}Guard`, table, 27, 'integration_change_billing_master_guard');
    for (const [name, table] of [['Document', 'Document'], ['Company', 'CompanySettings'], ['Point', 'EmissionPoint'], ['Counter', 'SeriesCounter'], ['Branch', 'Branch']])
      add(`IntegrationChange${name}Truncate`, table, 34, 'integration_change_billing_no_removal');
    add('IntegrationChangeBindingGuard', 'IntegrationChangeBinding', 58, 'integration_change_billing_no_removal');
  } else {
    add('IntegrationChangeIssuer', 'IssuerProjection', 21, 'integration_change_sunat_issuer');
    for (const [name, table, routine] of [['Document', 'FiscalDocument', 'owner'], ['Batch', 'FiscalBatch', 'owner'],
      ['DocumentArtifact', 'DocumentArtifact', 'artifact'], ['BatchArtifact', 'BatchArtifact', 'artifact'], ['Cdr', 'CdrLog', 'cdr']]) {
      add(`IntegrationChange${name}`, table, 21, `integration_change_sunat_${routine}`);
      add(`IntegrationChange${name}Guard`, table, 27, `integration_change_sunat_${routine}_guard`);
    }
    add('IntegrationChangeSubmission', 'SunatSubmission', 17, 'integration_change_sunat_submission');
    add('IntegrationChangeSubmissionGuard', 'SunatSubmission', 27, 'integration_change_sunat_submission_guard');
    for (const table of ['FiscalDocument', 'FiscalBatch', 'DocumentArtifact', 'BatchArtifact', 'CdrLog', 'SunatSubmission'])
      add(`IntegrationChangeTruncate${table}`, table, 34, 'integration_change_sunat_no_removal');
    for (const table of ['IntegrationChangeBinding', 'IntegrationChangeArtifactBinding', 'IntegrationChangeProofBinding'])
      add(`${table}Guard`, table, 58, 'integration_change_sunat_no_removal');
  }
  return result;
}
function sequence(value: unknown): string | null {
  // No Number conversion, leading zeros, exponents, signs, whitespace or SQL.
  const text = typeof value === 'bigint' ? value.toString() : value;
  return typeof text === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(text) && BigInt(text) <= maximum ? text : null;
}
function inputs(issuerRuc: string, after: JournalPosition | null, limit: number, owner: JournalOwner) {
  if (!ruc(issuerRuc) || !['BILLING', 'SUNAT'].includes(owner) || !Number.isSafeInteger(limit) || limit < 1)
    return deny(400, 'INVALID_QUERY');
  if (after !== null && (!plain(after) || Object.keys(after).length !== 2 || !uuid(after.epoch) ||
      typeof after.sequence !== 'string' || sequence(after.sequence) === null)) return deny(400, 'INVALID_QUERY');
  return Math.min(limit, 500);
}

/** Whitelist and validate the state row, including exact bigint string values. */
export function parseIntegrationJournalHead(row: unknown, issuerRuc: string): JournalHead {
  if (!plain(row) || !ruc(issuerRuc) || row.issuerRuc !== issuerRuc || row.environment !== 'BETA' || !uuid(row.epoch))
    return deny(503, 'CHANGE_FEED_NOT_READY');
  const head = sequence(row.head), floor = sequence(row.floor);
  if (head === null || floor === null || BigInt(floor) > BigInt(head)) return deny(503, 'CHANGE_FEED_NOT_READY');
  return { epoch: row.epoch.toLowerCase(), head, floor };
}
function checkpoint(head: JournalHead, after: JournalPosition) {
  if (head.epoch !== after.epoch.toLowerCase() || BigInt(after.sequence) > BigInt(head.head) ||
      BigInt(after.sequence) < BigInt(head.floor)) return deny(410, 'CURSOR_EXPIRED');
}
function safeError(error: unknown): never {
  if (error instanceof IntegrationReadError &&
      ((error.status === 400 && error.code === 'INVALID_QUERY') ||
       (error.status === 410 && error.code === 'CURSOR_EXPIRED') ||
       (error.status === 503 && error.code === 'CHANGE_FEED_NOT_READY'))) throw error;
  // Neither database diagnostics nor payloads/paths/SQL are logged or relayed.
  return deny(503, 'CHANGE_FEED_NOT_READY');
}
async function state(sql: JournalSql, issuerRuc: string, locked = false): Promise<JournalHead> {
  const result = await sql.query(`SELECT s."issuerRuc", s."environment", s."epoch"::text,
    s."head"::text, s."floor"::text FROM public."IntegrationChangeState" s
    LEFT JOIN LATERAL (SELECT "id", "sequence", "ownerKind", "ownerId", "eventKind", "occurredAt", "artifactId", "epoch"
      FROM public."IntegrationChangeEvent" WHERE "issuerRuc"=$1 AND "environment"='BETA' AND false) event_schema ON false
    WHERE s."issuerRuc"=$1 AND s."environment"='BETA'${locked ? ' FOR UPDATE OF s' : ''}`, [issuerRuc]);
  if (!Array.isArray(result.rows) || result.rows.length !== 1) return deny(503, 'CHANGE_FEED_NOT_READY');
  return parseIntegrationJournalHead(result.rows[0], issuerRuc);
}

/** Readiness requires all owner emitters AND loss-prevention guards, not just
 * state tables. Run inside the same snapshot as the read. No DDL/body exposure.
 * If triggers were ever disabled/bypassed, operators MUST rotate epochs and
 * recapture baselines before reactivation; enabling them cannot repair history.
 */
export async function assertIntegrationJournalInstallation(sql: JournalSql, owner: JournalOwner = 'BILLING'): Promise<void> {
  if (!['BILLING', 'SUNAT'].includes(owner)) return deny(400, 'INVALID_QUERY');
  try {
    const expected = JSON.stringify(requiredTriggers(owner));
    const result = await sql.query(`SELECT count(*)=jsonb_array_length($1::jsonb) AS "ready"
      FROM jsonb_to_recordset($1::jsonb) AS required(name text, relation text, type integer, routine text)
      JOIN pg_catalog.pg_trigger t ON t.tgname=required.name AND t.tgtype=required.type
      JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid AND c.relname=required.relation
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
      JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid AND p.proname=required.routine
      JOIN pg_catalog.pg_namespace f ON f.oid=p.pronamespace AND f.nspname='public'
      WHERE NOT t.tgisinternal AND t.tgenabled IN ('O','A') AND p.prosecdef AND c.relkind='r'`, [expected]);
    if (!Array.isArray(result.rows) || result.rows.length !== 1 || !plain(result.rows[0]) || result.rows[0].ready !== true)
      return deny(503, 'CHANGE_FEED_NOT_READY');
  } catch (error) { return safeError(error); }
}

/** NO BEGIN/COMMIT here. Caller MUST hold one RepeatableRead, read-only
 * transaction for this entire call (including state and events). A Prisma
 * adapter implements query(text, values) as {rows: await tx.$queryRawUnsafe(
 * text, ...values)}; values are always bound parameters. No schema fallback.
 * null requests a barrier only: position.sequence=head; it reads no events.
 */
export async function readIntegrationJournal(sql: JournalSql, issuerRuc: string,
  after: JournalPosition | null, limit = 500, owner: JournalOwner = 'BILLING'): Promise<JournalPage> {
  const capped = inputs(issuerRuc, after, limit, owner);
  try {
    await assertIntegrationJournalInstallation(sql, owner);
    const head = await state(sql, issuerRuc);
    if (after === null) return { ...head, position: { epoch: head.epoch, sequence: head.head }, events: [] };
    checkpoint(head, after);
    const result = await sql.query(`SELECT "id"::text, "sequence"::text, "ownerKind", "ownerId"::text,
      "eventKind", "occurredAt", "artifactId"::text FROM public."IntegrationChangeEvent"
      WHERE "issuerRuc"=$1 AND "environment"='BETA' AND "epoch"=$2::uuid
        AND "sequence">$3::bigint AND "sequence"<=$4::bigint
      ORDER BY "sequence" ASC LIMIT $5`, [issuerRuc, head.epoch, after.sequence, head.head, capped]);
    if (!Array.isArray(result.rows) || result.rows.length > capped) return deny(503, 'CHANGE_FEED_NOT_READY');
    // A committed journal is contiguous above floor, including after a trim.
    const expectedCount = BigInt(head.head) - BigInt(after.sequence);
    if (BigInt(result.rows.length) !== (expectedCount < BigInt(capped) ? expectedCount : BigInt(capped)))
      return deny(503, 'CHANGE_FEED_NOT_READY');
    const seen = new Set<string>();
    const events = result.rows.map((row, index): JournalEvent => {
      if (!plain(row) || !uuid(row.id) || seen.has(row.id.toLowerCase()) || !uuid(row.ownerId) ||
          !['DOCUMENT', 'BATCH'].includes(row.ownerKind) || !kinds.includes(row.eventKind) ||
          (row.artifactId !== null && !uuid(row.artifactId)) ||
          (row.eventKind === 'ARTIFACT_ADDED' && row.artifactId === null) ||
          (owner === 'BILLING' && (row.ownerKind !== 'DOCUMENT' || row.artifactId !== null || row.eventKind === 'ARTIFACT_ADDED')))
        return deny(503, 'CHANGE_FEED_NOT_READY');
      const seq = sequence(row.sequence);
      if (seq === null || BigInt(seq) !== BigInt(after.sequence) + BigInt(index) + 1n) return deny(503, 'CHANGE_FEED_NOT_READY');
      if (!(row.occurredAt instanceof Date) && (typeof row.occurredAt !== 'string' || row.occurredAt.length > 40 ||
          !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(row.occurredAt))) return deny(503, 'CHANGE_FEED_NOT_READY');
      const at = new Date(row.occurredAt);
      if (!Number.isFinite(at.getTime())) return deny(503, 'CHANGE_FEED_NOT_READY');
      seen.add(row.id.toLowerCase());
      return { id: `${owner}:${row.id.toLowerCase()}`, sequence: seq, ownerKind: row.ownerKind,
        ownerId: row.ownerId.toLowerCase(), kind: row.eventKind, occurredAt: at.toISOString(),
        artifactId: row.artifactId === null ? null : row.artifactId.toLowerCase() };
    });
    return { ...head, position: { epoch: head.epoch, sequence: events.at(-1)?.sequence ?? after.sequence }, events };
  } catch (error) { return safeError(error); }
}

export class PostgresIntegrationJournal implements IntegrationJournal {
  constructor(private readonly pool: JournalPool, private readonly owner: JournalOwner = 'BILLING') {}
  private async transaction<T>(begin: string, work: (sql: JournalSql) => Promise<T>): Promise<T> {
    let client: JournalClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query(begin);
      await client.query("SET LOCAL statement_timeout='10s'");
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return safeError(error);
    } finally {
      if (client) { try { await client.release(); } catch { /* No diagnostic logging. */ } }
    }
  }
  async read(issuerRuc: string, after: JournalPosition | null, limit = 500): Promise<JournalPage> {
    inputs(issuerRuc, after, limit, this.owner);
    return this.transaction('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      sql => readIntegrationJournal(sql, issuerRuc, after, limit, this.owner));
  }
  /** Explicit technical retention operation; never an HTTP/public capability.
   * through.sequence is the new inclusive floor, not a timestamp. Uses a
   * separately privileged pool. State lock serializes with every producer and
   * other trim; count and endpoints prove an unbroken prefix before deletion.
   * Old checkpoints below this floor fail 410. Bindings MUST survive trimming.
   */
  async trim(issuerRuc: string, through: JournalPosition): Promise<JournalHead> {
    inputs(issuerRuc, through, 500, this.owner);
    return this.transaction('BEGIN ISOLATION LEVEL READ COMMITTED', async sql => {
      const head = await state(sql, issuerRuc, true);
      checkpoint(head, through);
      const rows = (await sql.query(`SELECT count(*)::text AS "count", min("sequence")::text AS "first",
        max("sequence")::text AS "last" FROM public."IntegrationChangeEvent"
        WHERE "issuerRuc"=$1 AND "environment"='BETA' AND "epoch"=$2::uuid
          AND "sequence">$3::bigint AND "sequence"<=$4::bigint`,
        [issuerRuc, head.epoch, head.floor, through.sequence])).rows;
      const count = BigInt(through.sequence) - BigInt(head.floor), row = rows[0];
      if (rows.length !== 1 || !plain(row) || sequence(row.count) !== count.toString() ||
          (count === 0n ? row.first !== null || row.last !== null :
            sequence(row.first) !== (BigInt(head.floor) + 1n).toString() || sequence(row.last) !== through.sequence))
        return deny(503, 'CHANGE_FEED_NOT_READY');
      await sql.query(`DELETE FROM public."IntegrationChangeEvent" WHERE "issuerRuc"=$1 AND "environment"='BETA'
        AND "epoch"=$2::uuid AND "sequence"<=$3::bigint`, [issuerRuc, head.epoch, through.sequence]);
      const updated = (await sql.query(`UPDATE public."IntegrationChangeState" SET "floor"=$3::bigint
        WHERE "issuerRuc"=$1 AND "environment"='BETA' AND "epoch"=$2::uuid
        RETURNING "issuerRuc", "environment", "epoch"::text, "head"::text, "floor"::text`,
        [issuerRuc, head.epoch, through.sequence])).rows;
      if (updated.length !== 1) return deny(503, 'CHANGE_FEED_NOT_READY');
      const next = parseIntegrationJournalHead(updated[0], issuerRuc);
      if (next.head !== head.head || next.epoch !== head.epoch || next.floor !== through.sequence)
        return deny(503, 'CHANGE_FEED_NOT_READY');
      return next;
    });
  }
}
