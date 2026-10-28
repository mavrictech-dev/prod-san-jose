import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { deny, IntegrationReadError, plain, ruc, uuid } from '@factuez/service-access/dist/integration';
import type { ExportPool, ExportSql } from './postgres-store';

export interface ChangeDeliveryRecord {
  id: string;
  clientId: string;
  contextSha256: string;
  issuerRuc: string;
  checkpointKey: string;
  createdAt: string;
  expiresAt: string;
  payload: Buffer;
}

export interface ChangeDeliveryAudit {
  clientId: string;
  revision: number;
  recordId: string;
  operation: string;
  sha256: null;
  byteLength: null;
}

/** Private technical cache, separate from fiscal storage. The caller encrypts pages and
 * checkpoints with the vault and awaits audit AFTER authorization, BEFORE any response.
 * Persist nonempty pages only; empty polls audit a fresh recordId without reserving a row.
 * The bounded proof source remains disabled at the consumer. RATE_LIMITED requires the
 * consumer to obtain a new cut/retry after capacity is reclaimed; empty polls cost no quota.
 * get/put return internal ciphertext only; neither operation authorizes HTTP delivery. */
export interface ChangeDeliveryStore {
  get(clientId: string, keyHash: string): Promise<ChangeDeliveryRecord | null>;
  put(record: ChangeDeliveryRecord): Promise<ChangeDeliveryRecord>;
  audit(event: ChangeDeliveryAudit): Promise<void>;
  sweep(now: string): Promise<void>;
}

export const ChangeDeliveryQuotas = Object.freeze({
  activeRecords: 256,
  payloadBytes: 4 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  sweepBatch: 100,
  tombstoneMs: 7 * 24 * 60 * 60 * 1000,
  clockSkewMs: 60 * 1000,
});

const capacityLock = 1985126506; // Different from the export queue's lock.
const columns = '"id","clientId","contextSha256","issuerRuc","checkpointKey","createdAt","expiresAt","payload"';
const recordKeys = ['id', 'clientId', 'contextSha256', 'issuerRuc', 'checkpointKey', 'createdAt', 'expiresAt', 'payload'];
const auditKeys = ['clientId', 'revision', 'recordId', 'operation', 'sha256', 'byteLength'];
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// UTC ISO timestamps, with optional milliseconds. Round-trip rejects impossible calendar dates.
function iso(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))
    return deny(400, 'INVALID_REQUEST');
  const milliseconds = Date.parse(value);
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== canonical)
    return deny(400, 'INVALID_REQUEST');
  return milliseconds;
}

function encrypted(payload: unknown): payload is Buffer {
  // ExportVault v1: version (1) + IV (12) + GCM tag (16) + ciphertext.
  // Authentication/decryption belongs to the vault; this store never receives a key.
  return Buffer.isBuffer(payload) && payload.length >= 29 && payload[0] === 1;
}

function validate(record: ChangeDeliveryRecord): void {
  if (!plain(record) || Object.keys(record).length !== recordKeys.length ||
      Object.keys(record).some(key => !recordKeys.includes(key)) || !uuid(record.id) || !uuid(record.clientId) ||
      !hash(record.contextSha256) || !ruc(record.issuerRuc) || !hash(record.checkpointKey) || !encrypted(record.payload))
    return deny(400, 'INVALID_REQUEST');
  if (record.payload.length > ChangeDeliveryQuotas.payloadBytes) return deny(422, 'EXPORT_TOO_LARGE');
  const created = iso(record.createdAt), expires = iso(record.expiresAt);
  if (expires <= created || expires - created > ChangeDeliveryQuotas.ttlMs) return deny(400, 'INVALID_REQUEST');
}

function databaseTime(value: unknown): number {
  const milliseconds = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(milliseconds)) return deny(503, 'CONSISTENT_READ_UNAVAILABLE');
  return milliseconds;
}

function mapped(row: Record<string, unknown>): ChangeDeliveryRecord {
  const now = databaseTime(row.dbNow), created = databaseTime(row.createdAt), expires = databaseTime(row.expiresAt);
  if (expires <= now || row.payload === null) return deny(410, 'CURSOR_EXPIRED');
  if (!uuid(row.id) || !uuid(row.clientId) || !hash(row.contextSha256) || !ruc(row.issuerRuc) ||
      !hash(row.checkpointKey) || !encrypted(row.payload) || row.payload.length > ChangeDeliveryQuotas.payloadBytes ||
      created > now + ChangeDeliveryQuotas.clockSkewMs || expires > now + ChangeDeliveryQuotas.ttlMs ||
      expires <= created || expires - created > ChangeDeliveryQuotas.ttlMs)
    return deny(409, 'INTEGRITY_FAILED');
  return { id: row.id, clientId: row.clientId, contextSha256: row.contextSha256, issuerRuc: row.issuerRuc,
    checkpointKey: row.checkpointKey, createdAt: new Date(created).toISOString(), expiresAt: new Date(expires).toISOString(),
    payload: Buffer.from(row.payload) };
}

function sameRequest(row: ChangeDeliveryRecord, record: ChangeDeliveryRecord): ChangeDeliveryRecord {
  if (row.clientId.toLowerCase() !== record.clientId.toLowerCase() || row.checkpointKey !== record.checkpointKey ||
      row.contextSha256 !== record.contextSha256 || row.issuerRuc !== record.issuerRuc)
    return deny(409, 'IDEMPOTENCY_CONFLICT');
  // IDs, timestamps and randomized ciphertext may differ: always return the durable first winner.
  return row;
}

/** No pg dependency, runtime import of postgres-store, fallback, automatic DDL or connection creation.
 * Supply a pool for the NEW dedicated technical test DB, never a fiscal/production pool. */
export class PostgresChangeDeliveryStore implements ChangeDeliveryStore {
  constructor(private readonly db: ExportPool) {}

  private async safe<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (error instanceof IntegrationReadError) throw error;
      return deny(503, 'CONSISTENT_READ_UNAVAILABLE'); // Never expose driver errors or SQL values.
    }
  }

  /** Read-only probe; the isolated runner alone may apply the separate SQL blueprint. */
  async readySchema(): Promise<void> {
    await this.safe(async () => {
      await this.db.query(`SELECT ${columns},"wipedAt" FROM "IntegrationChangeDelivery" WHERE false`);
      await this.db.query('SELECT "id","clientId","revision","recordId","operation","sha256","byteLength","at" FROM "IntegrationChangeDeliveryAudit" WHERE false');
      const constraints = await this.db.query(`SELECT count(*)::int AS "total" FROM pg_constraint
        WHERE conrelid=to_regclass('"IntegrationChangeDelivery"') AND contype='u'
        AND pg_get_constraintdef(oid)='UNIQUE ("clientId", "checkpointKey")'`);
      if (constraints.rows[0]?.total !== 1) return deny(503, 'CONSISTENT_READ_UNAVAILABLE');
    });
  }

  private async transaction<T>(work: (sql: ExportSql) => Promise<T>): Promise<T> {
    return this.safe(async () => {
      const db = await this.db.connect();
      try {
        await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await db.query("SET LOCAL statement_timeout='10s'");
        await db.query('SELECT pg_advisory_xact_lock($1)', [capacityLock]);
        const value = await work(db);
        await db.query('COMMIT');
        return value;
      } catch (error) {
        await db.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally { db.release(); }
    });
  }

  private async lookup(db: ExportSql, clientId: string, keyHash: string): Promise<ChangeDeliveryRecord | null> {
    const result = await db.query(`SELECT ${columns},clock_timestamp() AS "dbNow" FROM "IntegrationChangeDelivery"
      WHERE "clientId"=$1 AND "checkpointKey"=$2`, [clientId, keyHash]);
    if (!result.rows[0]) return null;
    const row = mapped(result.rows[0]);
    if (row.clientId.toLowerCase() !== clientId.toLowerCase() || row.checkpointKey !== keyHash)
      return deny(409, 'INTEGRITY_FAILED');
    return row;
  }

  async get(clientId: string, keyHash: string): Promise<ChangeDeliveryRecord | null> {
    if (!uuid(clientId) || !hash(keyHash)) return deny(400, 'INVALID_QUERY');
    return this.safe(() => this.lookup(this.db, clientId, keyHash));
  }

  async put(record: ChangeDeliveryRecord): Promise<ChangeDeliveryRecord> {
    validate(record);
    // Snapshot before awaiting: caller mutations cannot change bound bytes or context during a race.
    const candidate = { ...record, payload: Buffer.from(record.payload) };
    return this.transaction(async db => {
      const clock = await db.query('SELECT clock_timestamp() AS "now"');
      const now = databaseTime(clock.rows[0]?.now);
      if (iso(candidate.createdAt) > now + ChangeDeliveryQuotas.clockSkewMs ||
          iso(candidate.expiresAt) > now + ChangeDeliveryQuotas.ttlMs) return deny(400, 'INVALID_REQUEST');
      if (iso(candidate.expiresAt) <= now) return deny(410, 'CURSOR_EXPIRED');
      const existing = await this.lookup(db, candidate.clientId, candidate.checkpointKey);
      if (existing) return sameRequest(existing, candidate);

      // Count all retained ciphertext, including expired pages awaiting the bounded sweep.
      const counts = (await db.query(`SELECT count(*) FILTER (WHERE "expiresAt">clock_timestamp() AND "payload" IS NOT NULL)::int AS "active",
        coalesce(sum(octet_length("payload")),0)::bigint AS "bytes" FROM "IntegrationChangeDelivery"`)).rows[0];
      const active = Number(counts?.active), bytes = Number(counts?.bytes);
      if (!Number.isSafeInteger(active) || active < 0 || !Number.isSafeInteger(bytes) || bytes < 0)
        return deny(503, 'CONSISTENT_READ_UNAVAILABLE');
      if (active >= ChangeDeliveryQuotas.activeRecords || bytes + candidate.payload.length > ChangeDeliveryQuotas.totalBytes)
        return deny(429, 'RATE_LIMITED');
      const inserted = await db.query(`INSERT INTO "IntegrationChangeDelivery" (${columns})
        SELECT $1::uuid,$2::uuid,$3,$4,$5,$6::timestamptz,$7::timestamptz,$8::bytea
        WHERE $6::timestamptz<=clock_timestamp()+($9::bigint*interval '1 millisecond')
          AND $7::timestamptz>clock_timestamp()
          AND $7::timestamptz<=clock_timestamp()+($10::bigint*interval '1 millisecond')
        ON CONFLICT ("clientId","checkpointKey") DO NOTHING
        RETURNING ${columns},clock_timestamp() AS "dbNow"`,
      [candidate.id, candidate.clientId, candidate.contextSha256, candidate.issuerRuc, candidate.checkpointKey,
        candidate.createdAt, candidate.expiresAt, candidate.payload, ChangeDeliveryQuotas.clockSkewMs, ChangeDeliveryQuotas.ttlMs]);
      if (inserted.rows[0]) return sameRequest(mapped(inserted.rows[0]), candidate);
      // Also handle a winner inserted by another compatible writer using the UNIQUE constraint.
      const winner = await this.lookup(db, candidate.clientId, candidate.checkpointKey);
      if (!winner) return deny(410, 'CURSOR_EXPIRED');
      return sameRequest(winner, candidate);
    });
  }

  async audit(event: ChangeDeliveryAudit): Promise<void> {
    if (!plain(event) || Object.keys(event).length !== auditKeys.length || Object.keys(event).some(key => !auditKeys.includes(key)) ||
        !uuid(event.clientId) || !uuid(event.recordId) || !Number.isSafeInteger(event.revision) || event.revision < 1 ||
        event.revision > 2147483647 || typeof event.operation !== 'string' || !/^[A-Z][A-Z_]{0,31}$/.test(event.operation) ||
        event.sha256 !== null || event.byteLength !== null) return deny(400, 'INVALID_REQUEST');
    const values = [randomUUID(), event.clientId, event.revision, event.recordId, event.operation, null, null];
    await this.transaction(async db => {
      const result = await db.query(`INSERT INTO "IntegrationChangeDeliveryAudit"
        ("id","clientId","revision","recordId","operation","sha256","byteLength")
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING "id"`, values);
      if (result.rowCount !== 1) return deny(503, 'CONSISTENT_READ_UNAVAILABLE');
    });
  }

  async sweep(now: string): Promise<void> {
    iso(now);
    await this.transaction(async db => {
      // Clamp caller time to the DB clock: a future caller cannot expire live checkpoints.
      await db.query(`UPDATE "IntegrationChangeDelivery" SET "payload"=NULL,"wipedAt"=clock_timestamp()
        WHERE "id" IN (SELECT "id" FROM "IntegrationChangeDelivery"
          WHERE "expiresAt"<=LEAST($1::timestamptz,clock_timestamp()) AND "payload" IS NOT NULL
          ORDER BY "expiresAt","id" LIMIT $2 FOR UPDATE SKIP LOCKED)`, [now, ChangeDeliveryQuotas.sweepBatch]);
      // Retain tombstones for at least seven days after expiry; audit has no FK.
      await db.query(`DELETE FROM "IntegrationChangeDelivery" WHERE "id" IN
        (SELECT "id" FROM "IntegrationChangeDelivery" WHERE "payload" IS NULL AND "wipedAt" IS NOT NULL
          AND "expiresAt"<LEAST($1::timestamptz,clock_timestamp())-($3::bigint*interval '1 millisecond')
          ORDER BY "expiresAt","id" LIMIT $2 FOR UPDATE SKIP LOCKED)`,
      [now, ChangeDeliveryQuotas.sweepBatch, ChangeDeliveryQuotas.tombstoneMs]);
    });
  }
}
