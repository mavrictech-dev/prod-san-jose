import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { IntegrationReadError } from '@factuez/service-access/dist/integration';
import { ExportQuotas, type ExportRecord, type ExportStore } from '../services/integration-export-service/src/model';
import { PostgresExportStore, type ExportPool, type ExportSql } from '../services/integration-export-service/src/postgres-store';

type QueryResult = Awaited<ReturnType<ExportSql['query']>>;
type QueryCall = { scope: 'pool' | 'client'; sql: string; values: unknown[] };
type SqlStep = {
  sql: string | RegExp;
  scope?: QueryCall['scope'];
  values?: unknown[];
  result?: QueryResult;
  error?: Error;
  inspect?: (call: QueryCall) => void;
};
const result = (rows: unknown[] = [], rowCount: number | null = rows.length): QueryResult => ({ rows, rowCount });
const compact = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const recordId = '10000000-0000-4000-8000-000000000001';
const clientId = '20000000-0000-4000-8000-000000000001';
const oldLease = '30000000-0000-4000-8000-000000000001';
const now = '2026-01-01T00:00:00.789Z';
const expiresAt = '2026-01-01T00:05:00.789Z';
const digest = 'a'.repeat(64);
const countsSql = /^SELECT count\(\*\)::int AS total,/;
const budgetSql = /^SELECT coalesce\(sum\(coalesce\(octet_length\("payload"\)/;
const lookupSql = /^SELECT .* FROM "IntegrationExportRecord" WHERE "clientId"=\$1 AND "keyHash"=\$2$/;

/** Scripted SQL boundary only: no PostgreSQL interpreter, sockets, timers or real data. */
class FakeSqlPool implements ExportPool {
  readonly calls: QueryCall[] = [];
  readonly events: string[] = [];
  readonly release = vi.fn(() => { this.events.push('release'); });
  readonly end = vi.fn(async () => { this.events.push('end'); });
  connectError?: Error;
  constructor(private readonly steps: SqlStep[]) {}

  readonly query = vi.fn(async (sql: string, values?: unknown[]) => this.execute('pool', sql, values));
  readonly clientQuery = vi.fn(async (sql: string, values?: unknown[]) => this.execute('client', sql, values));
  readonly connect = vi.fn(async () => {
    this.events.push('connect');
    if (this.connectError) throw this.connectError;
    return { query: this.clientQuery, release: this.release };
  });

  private async execute(scope: QueryCall['scope'], sql: string, values: unknown[] = []): Promise<QueryResult> {
    const call = { scope, sql: compact(sql), values };
    this.calls.push(call);
    this.events.push(`${scope}:${call.sql}`);
    const step = this.steps.shift();
    expect(step, `Unexpected ${scope} query: ${call.sql}`).toBeDefined();
    if (!step) throw new Error('Unscripted SQL');
    expect(scope).toBe(step.scope ?? 'client');
    if (typeof step.sql === 'string') expect(call.sql).toBe(step.sql);
    else expect(call.sql).toMatch(step.sql);
    if (step.values !== undefined) {
      expect(values).toHaveLength(step.values.length);
      for (let index = 0; index < values.length; index++) {
        // Ciphertext must be bound unchanged; avoid expanding MiB-sized buffers in deep equality.
        if (Buffer.isBuffer(step.values[index])) expect(values[index]).toBe(step.values[index]);
        else expect(values[index]).toEqual(step.values[index]);
      }
    }

    // Every argument must have a positional placeholder; injection strings must remain parameters.
    const slots = [...new Set([...sql.matchAll(/\$(\d+)\b/g)].map(match => Number(match[1])))].sort((a, b) => a - b);
    expect(slots).toEqual(Array.from({ length: values.length }, (_, index) => index + 1));
    for (const value of values) if (typeof value === 'string' && value.includes("'")) expect(sql).not.toContain(value);
    const tables = [...sql.matchAll(/\b(?:FROM|UPDATE|INTO|JOIN)\s+"([^"]+)"/gi)].map(match => match[1]);
    expect(tables.every(table => ['IntegrationExportRecord', 'IntegrationExportAudit'].includes(table))).toBe(true);
    step.inspect?.(call);
    if (step.error) throw step.error;
    return step.result ?? result([], 1);
  }

  done(transactionCount = 1) {
    expect(this.steps).toHaveLength(0);
    expect(this.connect).toHaveBeenCalledTimes(transactionCount);
    expect(this.release).toHaveBeenCalledTimes(transactionCount);
    expect(this.end).not.toHaveBeenCalled();
    if (transactionCount) {
      expect(this.query).not.toHaveBeenCalled();
      expect(this.events.at(-1)).toBe('release');
    } else expect(this.clientQuery).not.toHaveBeenCalled();
  }
}

const beginSteps = (): SqlStep[] => [
  { sql: 'BEGIN', values: [] },
  { sql: "SET LOCAL statement_timeout='10s'", values: [] },
  { sql: 'SELECT pg_advisory_xact_lock(1985126505)', values: [] },
];
const transaction = (body: SqlStep[], ending: 'COMMIT' | 'ROLLBACK' = 'COMMIT'): SqlStep[] =>
  [...beginSteps(), ...body, { sql: ending, values: [] }];
function record(overrides: Partial<ExportRecord> = {}): ExportRecord {
  return { id: recordId, kind: 'EXPORT', clientId, contextSha256: digest, issuerRuc: '10000000001',
    keyHash: 'b'.repeat(64), requestSha256: 'c'.repeat(64), createdAt: now, expiresAt, state: 'CAPTURING',
    payload: null, content: null, contentSha256: null, manifestSha256: null, failureCode: null, lease: null, ...overrides };
}
function expectRecordProjection(call: QueryCall, includeContent = false) {
  const match = /^SELECT (.+) FROM "IntegrationExportRecord" WHERE /.exec(call.sql);
  expect(match).not.toBeNull();
  const projection = match![1];
  expect(projection).not.toContain('*');
  const expected = Object.keys(record()).map(column => column === 'content' && !includeContent
    ? 'NULL::bytea AS "content"' : `"${column}"`);
  // Check individual expressions: the metadata alias still contains the word "content".
  // An allowlist also rejects a wildcard, duplicate content, or content hidden in another expression.
  expect(projection.split(',').map(expression => expression.trim()).sort()).toEqual(expected.sort());
}
const newKeyLookup = (r: ExportRecord): SqlStep[] => r.keyHash
  ? [{ sql: lookupSql, values: [r.clientId, r.keyHash], result: result(), inspect: call => expectRecordProjection(call) }] : [];
const counted = (r: ExportRecord, overrides: Record<string, unknown> = {}): SqlStep => ({
  sql: countsSql, values: [r.clientId, r.kind, r.createdAt], result: result([{ total: 0, owned: 0, bytes: '0', ...overrides }]),
  inspect: call => {
    expect(call.sql).toContain('FILTER (WHERE "clientId"=$1 AND "kind"=$2)');
    expect(call.sql).toContain('coalesce(octet_length("payload"),0)+coalesce(octet_length("content"),0)');
    expect(call.sql).toContain('WHERE "expiresAt">$3 AND "state" NOT IN (\'EXPIRED\',\'FAILED\')');
  },
});
const inserted = (r: ExportRecord): SqlStep => ({
  sql: /^INSERT INTO "IntegrationExportRecord" .* VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8,\$9,\$10,NULL,NULL,NULL,NULL,NULL,NULL\)$/,
  values: [r.id, r.kind, r.clientId, r.contextSha256, r.issuerRuc, r.keyHash, r.requestSha256, r.createdAt, r.expiresAt, r.state],
});
const budgeted = (bytes: string | number = '0'): SqlStep => ({
  sql: budgetSql, values: [recordId], result: result([{ bytes }]),
  inspect: call => {
    expect(call.sql).toContain('coalesce(octet_length("payload"),0)+coalesce(octet_length("content"),0)');
    expect(call.sql).toContain('WHERE "id"<>$1 AND "state"<>\'EXPIRED\'');
  },
});
const capturedWrite = (payload: Buffer, state: 'QUEUED' | 'READY', rowCount: number | null = 1): SqlStep => ({
  sql: /^UPDATE "IntegrationExportRecord" SET "payload"=\$2,"state"=\$3 WHERE "id"=\$1 AND "state"='CAPTURING' AND "expiresAt">clock_timestamp\(\)$/,
  values: [recordId, payload, state], result: result([], rowCount),
});
const readyWrite = (payload: Buffer, content: Buffer, rowCount: number | null = 1): SqlStep => ({
  sql: /^UPDATE "IntegrationExportRecord" SET "state"='READY',/,
  values: [recordId, oldLease, payload, content, digest, 'd'.repeat(64), expiresAt], result: result([], rowCount),
  inspect: call => {
    expect(call.sql).toContain('"contentSha256"=$5, "manifestSha256"=$6,"expiresAt"=$7,"lease"=NULL,"leaseExpiresAt"=NULL');
    const where = call.sql.slice(call.sql.indexOf(' WHERE '));
    expect(where).toMatch(/"id"\s*=\s*\$1\b/);
    expect(where).toMatch(/"state"\s*=\s*'RUNNING'/);
    expect(where).toMatch(/"lease"\s*=\s*\$2\b/);
    expect(where).toMatch(/"leaseExpiresAt"\s*>\s*clock_timestamp\(\)/);
    expect(where).toMatch(/"expiresAt"\s*>\s*clock_timestamp\(\)/);
  },
});
const finishReady = (store: PostgresExportStore, payload: Buffer, content: Buffer) =>
  store.ready(recordId, oldLease, payload, content, digest, 'd'.repeat(64), expiresAt);
async function rejectsReadError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(() => null, reason => reason);
  expect(error).toBeInstanceOf(IntegrationReadError);
  expect(error).toMatchObject({ status, code, message: code });
}

describe('Postgres export store: parameterized reads and schema readiness', () => {
  it.each(['get', 'byKey'] as const)('%s scopes reads to the client, normalizes dates and preserves ciphertext', async method => {
    const payload = Buffer.from('synthetic ciphertext');
    const row = { ...record({ payload }), createdAt: new Date(now), expiresAt: new Date(expiresAt) };
    const pool = new FakeSqlPool([{ scope: 'pool', sql: method === 'get'
      ? /^SELECT .* WHERE "id"=\$1 AND "clientId"=\$2$/ : lookupSql,
      values: method === 'get' ? [recordId, clientId] : [clientId, row.keyHash], result: result([row]),
      inspect: call => expectRecordProjection(call) }]);
    const store = new PostgresExportStore(pool);
    const read = method === 'get' ? await store.get(recordId, clientId) : await store.byKey(clientId, row.keyHash!);
    expect(read).toEqual(record({ payload }));
    expect(read?.payload).toBe(payload);
    expect(read).not.toBe(row);
    expect(row.createdAt).toBeInstanceOf(Date);
    pool.done(0);
  });

  it.each(['get default', 'get false', 'byKey'] as const)('%s omits encrypted archive content while preserving payload and hashes', async method => {
    const payload = Buffer.from('synthetic encrypted snapshot');
    const expected = record({ state: 'READY', payload, content: null, contentSha256: digest, manifestSha256: 'd'.repeat(64) });
    const row = { ...expected, createdAt: new Date(now), expiresAt: new Date(expiresAt) };
    const pool = new FakeSqlPool([{ scope: 'pool', sql: method === 'byKey' ? lookupSql
      : /^SELECT .* FROM "IntegrationExportRecord" WHERE "id"=\$1 AND "clientId"=\$2$/,
      values: method === 'byKey' ? [clientId, expected.keyHash] : [recordId, clientId],
      result: result([row]), inspect: call => expectRecordProjection(call) }]);
    const store = new PostgresExportStore(pool);
    const read = method === 'byKey' ? await store.byKey(clientId, expected.keyHash!)
      : method === 'get false' ? await store.get(recordId, clientId, false) : await store.get(recordId, clientId);
    expect(read).toEqual(expected);
    expect(read?.content).toBeNull();
    expect(read?.payload).toBe(payload);
    expect(read?.contentSha256).toBe(digest);
    expect(read?.manifestSha256).toBe('d'.repeat(64));
    pool.done(0);
  });

  it('get with explicit includeContent=true selects the encrypted archive for download and keeps client binding', async () => {
    const payload = Buffer.from('synthetic encrypted snapshot'), content = Buffer.from('synthetic encrypted archive');
    const expected = record({ state: 'READY', payload, content, contentSha256: digest, manifestSha256: 'd'.repeat(64) });
    const row = { ...expected, createdAt: new Date(now), expiresAt: new Date(expiresAt) };
    const pool = new FakeSqlPool([{ scope: 'pool', sql: /^SELECT .* FROM "IntegrationExportRecord" WHERE "id"=\$1 AND "clientId"=\$2$/,
      values: [recordId, clientId], result: result([row]), inspect: call => expectRecordProjection(call, true) }]);
    const read = await new PostgresExportStore(pool).get(recordId, clientId, true);
    expect(read).toEqual(expected);
    expect(read?.content).toBe(content);
    expect(read?.payload).toBe(payload);
    expect(row.createdAt).toBeInstanceOf(Date);
    pool.done(0);
  });

  it.each(['get', 'byKey'] as const)('%s returns null for a missing record without a broader fallback', async method => {
    const pool = new FakeSqlPool([{ scope: 'pool', sql: /^SELECT .* FROM "IntegrationExportRecord" WHERE/,
      values: method === 'get' ? [recordId, clientId] : [clientId, digest], result: result(),
      inspect: call => expectRecordProjection(call) }]);
    const store = new PostgresExportStore(pool);
    expect(method === 'get' ? await store.get(recordId, clientId) : await store.byKey(clientId, digest)).toBeNull();
    pool.done(0);
  });

  it.each(['get', 'byKey'] as const)('%s keeps SQL metacharacters in bound values', async method => {
    const injected = "' OR true; DELETE FROM synthetic_table; --";
    const pool = new FakeSqlPool([{ scope: 'pool', sql: /^SELECT .* FROM "IntegrationExportRecord" WHERE/,
      values: [injected, injected], result: result(), inspect: call => expectRecordProjection(call) }]);
    const store = new PostgresExportStore(pool);
    if (method === 'get') await store.get(injected, injected);
    else await store.byKey(injected, injected);
    expect(pool.calls[0].sql).not.toContain('synthetic_table');
    pool.done(0);
  });

  it('probes all record and audit columns with WHERE false and never provisions a schema', async () => {
    const pool = new FakeSqlPool([
      { scope: 'pool', sql: /^SELECT .* FROM "IntegrationExportRecord" WHERE false$/, values: [], result: result() },
      { scope: 'pool', sql: /^SELECT .* FROM "IntegrationExportAudit" WHERE false$/, values: [], result: result() },
    ]);
    await new PostgresExportStore(pool).readySchema();
    for (const column of [...Object.keys(record()), 'environment', 'leaseExpiresAt']) expect(pool.calls[0].sql).toContain(`"${column}"`);
    for (const column of ['id', 'requestId', 'clientId', 'revision', 'recordId', 'operation', 'sha256', 'byteLength', 'at'])
      expect(pool.calls[1].sql).toContain(`"${column}"`);
    expect(pool.calls.some(call => /\b(?:CREATE|ALTER|INSERT|DELETE|UPDATE)\b/.test(call.sql))).toBe(false);
    pool.done(0);
  });

  it.each([0, 1])('propagates schema-probe failure at query %i without continuing', async failureIndex => {
    const error = new Error('synthetic missing column');
    const steps: SqlStep[] = [
      { scope: 'pool' as const, sql: /^SELECT .* FROM "IntegrationExportRecord" WHERE false$/, result: result() },
      { scope: 'pool' as const, sql: /^SELECT .* FROM "IntegrationExportAudit" WHERE false$/, result: result() },
    ].slice(0, failureIndex + 1);
    steps[failureIndex].error = error;
    const pool = new FakeSqlPool(steps);
    await expect(new PostgresExportStore(pool).readySchema()).rejects.toBe(error);
    pool.done(0);
  });

  it('keeps the reviewed SQL blueprint dedicated to BETA with durable keys and ciphertext size constraints', () => {
    const sql = readFileSync(new URL('../services/integration-export-service/sql/integration-export.sql', import.meta.url), 'utf8');
    expect([...sql.matchAll(/CREATE TABLE "([^"]+)"/g)].map(match => match[1]))
      .toEqual(['IntegrationExportRecord', 'IntegrationExportAudit']);
    expect(sql).toContain('"environment" text NOT NULL DEFAULT \'BETA\' CHECK ("environment"=\'BETA\')');
    expect(sql).toContain('UNIQUE ("clientId","keyHash")');
    expect(sql).toContain('"kind"=\'EXPORT\' AND "keyHash" IS NOT NULL AND "requestSha256" IS NOT NULL');
    expect(sql).toContain('"kind"=\'CUT\' AND "keyHash" IS NULL AND "requestSha256" IS NULL');
    expect(sql).toContain(`CHECK (octet_length("payload") <= ${ExportQuotas.encryptedBytes + 29})`);
    expect(sql).toContain(`CHECK (octet_length("content") <= ${ExportQuotas.packageBytes + 29})`);
    expect(sql).toContain('"lease" uuid, "leaseExpiresAt" timestamptz');
    expect(sql).toContain('"revision" integer NOT NULL CHECK ("revision">0)');
    expect(sql).toContain('"at" timestamptz NOT NULL DEFAULT clock_timestamp()');
    expect(sql).toContain("'LIST','DETAIL','CREATE','STATUS','MANIFEST','DOWNLOAD'");
  });
});

describe('Postgres export store: reservations, quotas and durable idempotency', () => {
  it.each(['CUT', 'EXPORT'] as const)('reserves %s only after locking and checking global, client/kind and byte quotas', async kind => {
    const r = record(kind === 'CUT' ? { kind, keyHash: null, requestSha256: null } : { kind });
    const body = newKeyLookup(r);
    body.push(counted(r), inserted(r));
    const pool = new FakeSqlPool(transaction(body));
    expect(await new PostgresExportStore(pool).reserve(r)).toEqual({ record: r, created: true });
    expect(pool.events.slice(0, 4)).toEqual(['connect', 'client:BEGIN', "client:SET LOCAL statement_timeout='10s'",
      'client:SELECT pg_advisory_xact_lock(1985126505)']);
    expect(pool.events.slice(-2)).toEqual(['client:COMMIT', 'release']);
    pool.done();
  });

  it.each(['CAPTURING', 'READY', 'FAILED', 'EXPIRED'] as const)('reuses a persisted %s key before quotas or inserts; conflicts/expiry belong to core', async state => {
    const r = record();
    const previous = { ...record({ id: '10000000-0000-4000-8000-000000000002', state, requestSha256: 'e'.repeat(64) }),
      createdAt: new Date(now), expiresAt: new Date(expiresAt) };
    const pool = new FakeSqlPool(transaction([{ sql: lookupSql, values: [clientId, r.keyHash], result: result([previous]),
      inspect: call => expectRecordProjection(call) }]));
    const reserved = await new PostgresExportStore(pool).reserve(r);
    expect(reserved.created).toBe(false);
    expect(reserved.record).toEqual({ ...previous, createdAt: now, expiresAt });
    expect(reserved.record.id).not.toBe(r.id);
    expect(pool.calls.some(call => countsSql.test(call.sql) || call.sql.startsWith('INSERT'))).toBe(false);
    pool.done();
  });

  it('returns only metadata for an existing READY idempotent reservation without fetching the encrypted archive', async () => {
    const payload = Buffer.from('synthetic persisted encrypted snapshot');
    const previous = record({ id: '10000000-0000-4000-8000-000000000002', state: 'READY', payload, content: null,
      contentSha256: digest, manifestSha256: 'd'.repeat(64) });
    const pool = new FakeSqlPool(transaction([{ sql: lookupSql, values: [clientId, previous.keyHash],
      result: result([previous]), inspect: call => expectRecordProjection(call) }]));
    const reserved = await new PostgresExportStore(pool).reserve(record());
    expect(reserved).toEqual({ created: false, record: previous });
    expect(reserved.record.content).toBeNull();
    expect(reserved.record.payload).toBe(payload);
    expect(pool.calls.filter(call => call.sql.startsWith('SELECT') && call.sql.includes('FROM "IntegrationExportRecord"'))).toHaveLength(1);
    pool.done();
  });

  it.each((['CUT', 'EXPORT'] as const).flatMap(kind => (['total', 'owned', 'bytes'] as const).flatMap(quota =>
    [0, 1].map(extra => ({ kind, quota, extra })))))('rejects $kind at $quota quota plus $extra without inserting', async ({ kind, quota, extra }) => {
    const r = record(kind === 'CUT' ? { kind, keyHash: null, requestSha256: null } : { kind });
    const limit = quota === 'total' ? ExportQuotas.activeRecords : quota === 'bytes' ? ExportQuotas.totalBytes :
      kind === 'CUT' ? ExportQuotas.activeClientCuts : ExportQuotas.activeClientExports;
    const pool = new FakeSqlPool(transaction([...newKeyLookup(r),
      counted(r, { [quota]: quota === 'bytes' ? String(limit + extra) : limit + extra })], 'ROLLBACK'));
    await rejectsReadError(new PostgresExportStore(pool).reserve(r), 429, 'RATE_LIMITED');
    expect(pool.events.slice(-2)).toEqual(['client:ROLLBACK', 'release']);
    pool.done();
  });

  it.each(['CUT', 'EXPORT'] as const)('allows %s just below every quota', async kind => {
    const r = record(kind === 'CUT' ? { kind, keyHash: null, requestSha256: null } : { kind });
    const pool = new FakeSqlPool(transaction([...newKeyLookup(r), counted(r, { total: ExportQuotas.activeRecords - 1,
      owned: (kind === 'CUT' ? ExportQuotas.activeClientCuts : ExportQuotas.activeClientExports) - 1,
      bytes: String(ExportQuotas.totalBytes - 1) }), inserted(r)]));
    expect((await new PostgresExportStore(pool).reserve(r)).created).toBe(true);
    pool.done();
  });
});

describe('Postgres export store: transaction cleanup and failure propagation', () => {
  it('does not try to roll back or release a connection that was never acquired', async () => {
    const error = new Error('synthetic pool connection failure');
    const pool = new FakeSqlPool([]);
    pool.connectError = error;
    await expect(new PostgresExportStore(pool).reserve(record())).rejects.toBe(error);
    expect(pool.events).toEqual(['connect']);
    expect(pool.connect).toHaveBeenCalledOnce();
    expect(pool.release).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.clientQuery).not.toHaveBeenCalled();
    expect(pool.end).not.toHaveBeenCalled();
  });

  it.each(['BEGIN', 'timeout', 'lock', 'quota', 'insert', 'COMMIT'].flatMap(stage =>
    [false, true].map(rollbackFails => ({ stage, rollbackFails }))))('rolls back and releases after $stage failure, rollbackFails=$rollbackFails',
    async ({ stage, rollbackFails }) => {
      const r = record({ kind: 'CUT', keyHash: null, requestSha256: null });
      const all = transaction([counted(r), inserted(r)]);
      const index = ['BEGIN', 'timeout', 'lock', 'quota', 'insert', 'COMMIT'].indexOf(stage);
      const error = new Error(`synthetic ${stage} failure`);
      const steps = all.slice(0, index + 1);
      steps[index].error = error;
      steps.push({ sql: 'ROLLBACK', values: [], ...(rollbackFails ? { error: new Error('synthetic rollback failure') } : {}) });
      const pool = new FakeSqlPool(steps);
      await expect(new PostgresExportStore(pool).reserve(r)).rejects.toBe(error);
      expect(pool.events.slice(-2)).toEqual(['client:ROLLBACK', 'release']);
      expect(pool.calls.filter(call => call.sql === 'COMMIT')).toHaveLength(stage === 'COMMIT' ? 1 : 0);
      pool.done();
    });

  it('rolls back an idempotency lookup error instead of creating a duplicate', async () => {
    const error = new Error('synthetic key lookup failure');
    const pool = new FakeSqlPool(transaction([{ sql: lookupSql, values: [clientId, record().keyHash], error }], 'ROLLBACK'));
    await expect(new PostgresExportStore(pool).reserve(record())).rejects.toBe(error);
    expect(pool.calls.some(call => call.sql.startsWith('INSERT'))).toBe(false);
    pool.done();
  });
});

describe('Postgres export store: ciphertext budgets and compare-and-set publishing', () => {
  it.each(['QUEUED', 'READY'] as const)('captures into %s only from a live CAPTURING row', async state => {
    const payload = Buffer.from('synthetic encrypted snapshot');
    const pool = new FakeSqlPool(transaction([budgeted(), capturedWrite(payload, state)]));
    await new PostgresExportStore(pool).captured(recordId, payload, state);
    pool.done();
  });

  it.each([0, null, 2])('rolls back capture CAS failure with rowCount=%j', async rowCount => {
    const payload = Buffer.from('synthetic ciphertext');
    const pool = new FakeSqlPool(transaction([budgeted(), capturedWrite(payload, 'QUEUED', rowCount)], 'ROLLBACK'));
    await rejectsReadError(new PostgresExportStore(pool).captured(recordId, payload, 'QUEUED'), 410, 'SNAPSHOT_EXPIRED');
    pool.done();
  });

  it('publishes matching live worker leases with ciphertext, digests and expiry in the same transaction', async () => {
    const payload = Buffer.from('synthetic payload'), content = Buffer.from('synthetic content');
    const pool = new FakeSqlPool(transaction([budgeted(), readyWrite(payload, content)]));
    await finishReady(new PostgresExportStore(pool), payload, content);
    pool.done();
  });

  it.each([0, null, 2])('rolls back stale/missing/expired worker CAS with rowCount=%j', async rowCount => {
    const payload = Buffer.from('synthetic payload'), content = Buffer.from('synthetic content');
    const pool = new FakeSqlPool(transaction([budgeted(), readyWrite(payload, content, rowCount)], 'ROLLBACK'));
    await rejectsReadError(finishReady(new PostgresExportStore(pool), payload, content), 409, 'CONSISTENT_READ_UNAVAILABLE');
    pool.done();
  });

  it.each(['captured', 'ready'] as const)('%s rejects oversized combined ciphertext before a budget query or write', async method => {
    const bytes = Buffer.alloc(ExportQuotas.encryptedBytes + ExportQuotas.packageBytes + 59);
    const pool = new FakeSqlPool(transaction([], 'ROLLBACK'));
    const store = new PostgresExportStore(pool);
    await rejectsReadError(method === 'captured' ? store.captured(recordId, bytes, 'QUEUED') : finishReady(store, bytes, Buffer.alloc(0)),
      422, 'EXPORT_TOO_LARGE');
    expect(pool.calls.some(call => budgetSql.test(call.sql) || call.sql.startsWith('UPDATE'))).toBe(false);
    pool.done();
  });

  it('allows the exact combined ciphertext ceiling with both encryption overheads included', async () => {
    const payload = Buffer.alloc(ExportQuotas.encryptedBytes + 29), content = Buffer.alloc(ExportQuotas.packageBytes + 29);
    const pool = new FakeSqlPool(transaction([budgeted(), readyWrite(payload, content)]));
    await finishReady(new PostgresExportStore(pool), payload, content);
    pool.done();
  });

  it.each((['captured', 'ready'] as const).flatMap(method => [0, 1].map(extra => ({ method, extra }))))(
    '$method budgets only other rows and handles the global byte boundary plus $extra', async ({ method, extra }) => {
      const payload = Buffer.from('abc'), content = method === 'ready' ? Buffer.from('defg') : Buffer.alloc(0);
      const bytes = payload.length + content.length;
      const steps = [budgeted(String(ExportQuotas.totalBytes - bytes + extra))];
      if (!extra) steps.push(method === 'captured' ? capturedWrite(payload, 'QUEUED') : readyWrite(payload, content));
      const pool = new FakeSqlPool(transaction(steps, extra ? 'ROLLBACK' : 'COMMIT'));
      const store = new PostgresExportStore(pool);
      const completion = method === 'captured' ? store.captured(recordId, payload, 'QUEUED') : finishReady(store, payload, content);
      if (extra) await rejectsReadError(completion, 429, 'RATE_LIMITED');
      else await completion;
      pool.done();
    });

  it.each(['budget', 'write'] as const)('rolls back publishing when the %s query fails', async stage => {
    const payload = Buffer.from('synthetic payload'), content = Buffer.from('synthetic content');
    const error = new Error(`synthetic ${stage} SQL failure`);
    const steps = [budgeted(), readyWrite(payload, content)].slice(0, stage === 'budget' ? 1 : 2);
    steps[steps.length - 1].error = error;
    const pool = new FakeSqlPool(transaction(steps, 'ROLLBACK'));
    await expect(finishReady(new PostgresExportStore(pool), payload, content)).rejects.toBe(error);
    pool.done();
  });

  // A live lease can outlast capture expiry; READY must check the original expiry before extending it.
  it('security regression: READY must also compare the original record expiry to the database clock', async () => {
    const payload = Buffer.from('synthetic payload'), content = Buffer.from('synthetic content');
    const pool = new FakeSqlPool(transaction([budgeted(), readyWrite(payload, content)]));
    await finishReady(new PostgresExportStore(pool), payload, content);
    pool.done();
    const update = pool.calls.find(call => call.sql.startsWith('UPDATE'))!;
    const where = update.sql.slice(update.sql.indexOf(' WHERE '));
    expect(where).toMatch(/"expiresAt"\s*>\s*clock_timestamp\(\)/);
  });
});

describe('Postgres export store: lease claiming and safe failure transitions', () => {
  const claimStep = (row?: ExportRecord): SqlStep => ({
    sql: /^SELECT .* FROM "IntegrationExportRecord" WHERE "kind"='EXPORT'/, values: [now], result: result(row ? [row] : []),
    inspect: call => {
      expect(call.sql).toContain('"expiresAt">$1');
      expect(call.sql).toContain('(\"state\"=\'QUEUED\' OR (\"state\"=\'RUNNING\' AND \"leaseExpiresAt\"<=$1))');
      expect(call.sql).toContain('ORDER BY "createdAt","id" LIMIT 1 FOR UPDATE SKIP LOCKED');
    },
  });
  const claimWrite = (leases: string[]): SqlStep => ({
    sql: 'UPDATE "IntegrationExportRecord" SET "state"=\'RUNNING\',"lease"=$2,"leaseExpiresAt"=$3 WHERE "id"=$1',
    inspect: call => {
      expect(call.values[0]).toBe(recordId);
      expect(call.values[1]).toMatch(uuidPattern);
      expect(call.values[1]).not.toBe(oldLease);
      expect(call.values[2]).toBe(new Date(Date.parse(now) + ExportQuotas.leaseMs).toISOString());
      leases.push(call.values[1] as string);
    },
  });

  it('commits an empty queue result without a lease write and releases the client', async () => {
    const pool = new FakeSqlPool(transaction([claimStep()]));
    expect(await new PostgresExportStore(pool).claim(now)).toBeNull();
    expect(pool.calls.some(call => call.sql.startsWith('UPDATE'))).toBe(false);
    pool.done();
  });

  it.each(['QUEUED', 'RUNNING'] as const)('claims %s atomically with a fresh bounded lease and leaves the selected row untouched', async state => {
    const row = record({ state, lease: state === 'RUNNING' ? oldLease : null });
    const leases: string[] = [];
    const pool = new FakeSqlPool(transaction([claimStep(row), claimWrite(leases)]));
    const claimed = await new PostgresExportStore(pool).claim(now);
    expect(claimed).toEqual({ ...row, state: 'RUNNING', lease: leases[0] });
    expect(row.state).toBe(state);
    expect(row.lease).toBe(state === 'RUNNING' ? oldLease : null);
    pool.done();
  });

  it('uses distinct worker leases when a claim is later reclaimed', async () => {
    const leases: string[] = [];
    const queued = record({ state: 'QUEUED' });
    const running = record({ state: 'RUNNING', lease: oldLease });
    const pool = new FakeSqlPool([...transaction([claimStep(queued), claimWrite(leases)]),
      ...transaction([claimStep(running), claimWrite(leases)])]);
    const store = new PostgresExportStore(pool);
    await store.claim(now);
    await store.claim(now);
    expect(new Set(leases).size).toBe(2);
    pool.done(2);
  });

  it.each(['select', 'lease write'] as const)('rolls back claim %s failure and returns no claimed row', async stage => {
    const error = new Error('synthetic claim SQL failure');
    const steps = [claimStep(record({ state: 'QUEUED' })), claimWrite([])].slice(0, stage === 'select' ? 1 : 2);
    steps[steps.length - 1].error = error;
    const pool = new FakeSqlPool(transaction(steps, 'ROLLBACK'));
    await expect(new PostgresExportStore(pool).claim(now)).rejects.toBe(error);
    pool.done();
  });

  it.each([undefined, oldLease])('binds failure code and optional lease %j, clears ciphertext and guards mutable states', async lease => {
    const pool = new FakeSqlPool([{ scope: 'pool', sql: /^UPDATE "IntegrationExportRecord" SET "state"='FAILED',/,
      values: [recordId, 'UPSTREAM_UNAVAILABLE', lease ?? null], result: result([], 0), inspect: call => {
        expect(call.sql).toContain('"failureCode"=$2,"payload"=NULL,"content"=NULL, "lease"=NULL,"leaseExpiresAt"=NULL');
        expect(call.sql).toContain('WHERE "id"=$1 AND "state" IN (\'CAPTURING\',\'QUEUED\',\'RUNNING\')');
        expect(call.sql).toContain('AND ($3::uuid IS NULL OR "lease"=$3::uuid)');
      } }]);
    await new PostgresExportStore(pool).fail(recordId, 'UPSTREAM_UNAVAILABLE', lease);
    pool.done(0);
  });

  it('propagates a failed failure-transition write', async () => {
    const error = new Error('synthetic fail SQL failure');
    const pool = new FakeSqlPool([{ scope: 'pool', sql: /^UPDATE "IntegrationExportRecord" SET "state"='FAILED',/, error }]);
    await expect(new PostgresExportStore(pool).fail(recordId, 'INTEGRITY_FAILED', oldLease)).rejects.toBe(error);
    pool.done(0);
  });
});

describe('Postgres export store: bounded sweeps and audit failures', () => {
  const sweepUpdate: SqlStep = {
    sql: /^UPDATE "IntegrationExportRecord" SET "state"='EXPIRED',/, values: [now], result: result([], 0),
    inspect: call => {
      expect(call.sql).toContain('"payload"=NULL,"content"=NULL,"lease"=NULL,"leaseExpiresAt"=NULL');
      expect(call.sql).toContain('WHERE "expiresAt"<=$1 AND "state"<>\'EXPIRED\' LIMIT 100');
    },
  };
  const sweepDelete: SqlStep = {
    sql: /^DELETE FROM "IntegrationExportRecord" WHERE "id" IN/, values: [now], result: result([], 0),
    inspect: call => expect(call.sql).toContain('WHERE "state"=\'EXPIRED\' AND "expiresAt"<$1::timestamptz-interval \'48 hours\' LIMIT 100'),
  };

  it('expires at most 100 own records before deleting at most 100 tombstones older than 48 hours', async () => {
    const pool = new FakeSqlPool(transaction([sweepUpdate, sweepDelete]));
    await new PostgresExportStore(pool).sweep(now);
    expect(pool.calls.filter(call => /^(?:UPDATE|DELETE)/.test(call.sql)).map(call => call.sql.split(' ')[0])).toEqual(['UPDATE', 'DELETE']);
    pool.done();
  });

  it.each(['expiry', 'deletion'] as const)('rolls back the entire sweep on %s failure', async stage => {
    const error = new Error('synthetic sweep SQL failure');
    const steps = [{ ...sweepUpdate }, { ...sweepDelete }].slice(0, stage === 'expiry' ? 1 : 2);
    steps[steps.length - 1].error = error;
    const pool = new FakeSqlPool(transaction(steps, 'ROLLBACK'));
    await expect(new PostgresExportStore(pool).sweep(now)).rejects.toBe(error);
    pool.done();
  });

  it.each(['LIST', 'DETAIL', 'CREATE', 'STATUS', 'MANIFEST', 'DOWNLOAD'])('audits %s with positional values, independent UUIDs and no ciphertext', async operation => {
    const event: Parameters<ExportStore['audit']>[0] = { clientId, revision: 7, recordId, operation,
      sha256: operation === 'DOWNLOAD' ? digest : null, byteLength: operation === 'DOWNLOAD' ? 123 : null };
    const pool = new FakeSqlPool([{ scope: 'pool',
      sql: 'INSERT INTO "IntegrationExportAudit" ("id","requestId","clientId","revision","recordId","operation","sha256","byteLength") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      inspect: call => {
        expect(call.values[0]).toMatch(uuidPattern);
        expect(call.values[1]).toMatch(uuidPattern);
        expect(call.values[0]).not.toBe(call.values[1]);
        expect(call.values.slice(2)).toEqual([event.clientId, event.revision, event.recordId, event.operation, event.sha256, event.byteLength]);
        expect(call.values.some(Buffer.isBuffer)).toBe(false);
        expect(call.sql).not.toMatch(/"(?:payload|content|keyHash)"/);
      } }]);
    await new PostgresExportStore(pool).audit(event);
    pool.done(0);
  });

  it('propagates audit-write failure to the caller without retrying, reporting success or mutating records', async () => {
    const error = new Error('synthetic audit unavailable');
    const pool = new FakeSqlPool([{ scope: 'pool', sql: /^INSERT INTO "IntegrationExportAudit"/, error }]);
    await expect(new PostgresExportStore(pool).audit({ clientId, revision: 1, recordId, operation: 'DOWNLOAD',
      sha256: digest, byteLength: 5 })).rejects.toBe(error);
    expect(pool.calls).toHaveLength(1);
    pool.done(0);
  });
});
