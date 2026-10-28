import { Buffer } from 'node:buffer';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { IntegrationReadError } from '@factuez/service-access/dist/integration';
import { ChangeDeliveryQuotas as quotas, PostgresChangeDeliveryStore,
  type ChangeDeliveryRecord, type ChangeDeliveryStore } from '../services/integration-export-service/src/change-store';
import type { ExportPool, ExportSql } from '../services/integration-export-service/src/postgres-store';

type Result = Awaited<ReturnType<ExportSql['query']>>;
type Call = { sql: string; values: unknown[]; scope: 'pool' | 'client' };
type Step = { sql: string | RegExp; scope?: Call['scope']; result?: Result; error?: Error;
  inspect?: (call: Call) => void; run?: () => Promise<Result> };
const result = (rows: unknown[] = [], rowCount: number | null = rows.length): Result => ({ rows, rowCount });
const compact = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const now = '2026-10-09T12:00:00.000Z';
const clientId = '10000000-0000-4000-8000-000000000001';
const otherClient = '10000000-0000-4000-8000-000000000002';
const lookup = /^SELECT .* FROM "IntegrationChangeDelivery" WHERE "clientId"=\$1 AND "checkpointKey"=\$2$/;
const counts = /^SELECT count\(\*\) FILTER/;
const insert = /^INSERT INTO "IntegrationChangeDelivery" /;
const auditInsert = /^INSERT INTO "IntegrationChangeDeliveryAudit" /;

// Synthetic ephemeral keys only: no secrets, sockets, pg dependency or database runner.
function ciphertext(bytes = Buffer.from('synthetic nonempty page and checkpoint')): Buffer {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', randomBytes(32), iv);
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]);
}
const at = (delta: number) => new Date(Date.parse(now) + delta).toISOString();
function record(overrides: Partial<ChangeDeliveryRecord> = {}): ChangeDeliveryRecord {
  return { id: randomUUID(), clientId, contextSha256: 'a'.repeat(64), issuerRuc: '10000000001',
    checkpointKey: 'b'.repeat(64), createdAt: now, expiresAt: at(3600000), payload: ciphertext(), ...overrides };
}
const row = (r: ChangeDeliveryRecord, dbNow = now) => ({ ...r, createdAt: new Date(r.createdAt), expiresAt: new Date(r.expiresAt), dbNow });
function boundary(call: Call): void {
  expect(call.sql).not.toMatch(/\bSELECT\s+\*/i);
  const slots = [...new Set([...call.sql.matchAll(/\$(\d+)\b/g)].map(match => Number(match[1])))].sort((a, b) => a - b);
  expect(slots).toEqual(call.values.map((_, index) => index + 1));
  for (const value of call.values) if (typeof value === 'string') expect(call.sql).not.toContain(value);
  const tables = [...call.sql.matchAll(/\b(?:FROM|UPDATE|INTO|JOIN)\s+"([^"]+)"/gi)].map(match => match[1]);
  expect(tables.every(table => ['IntegrationChangeDelivery', 'IntegrationChangeDeliveryAudit'].includes(table))).toBe(true);
}

class ScriptedPool implements ExportPool {
  readonly calls: Call[] = [];
  readonly release = vi.fn();
  readonly end = vi.fn(async () => undefined);
  connectError?: Error;
  readonly connect = vi.fn(async () => {
    if (this.connectError) throw this.connectError;
    return { query: (sql: string, values?: unknown[]) => this.execute('client', sql, values), release: this.release };
  });
  readonly query = vi.fn((sql: string, values?: unknown[]) => this.execute('pool', sql, values));
  constructor(private readonly steps: Step[]) {}
  private async execute(scope: Call['scope'], sql: string, values: unknown[] = []): Promise<Result> {
    const call = { scope, sql: compact(sql), values };
    this.calls.push(call);
    boundary(call);
    const step = this.steps.shift();
    expect(step, `Unexpected SQL: ${call.sql}`).toBeDefined();
    if (!step) throw new Error('Unscripted query');
    expect(scope).toBe(step.scope ?? 'client');
    if (typeof step.sql === 'string') expect(call.sql).toBe(step.sql);
    else expect(call.sql).toMatch(step.sql);
    step.inspect?.(call);
    if (step.error) throw step.error;
    return step.run ? step.run() : step.result ?? result([], 1);
  }
  done(connections = 1): void {
    expect(this.steps).toHaveLength(0);
    expect(this.connect).toHaveBeenCalledTimes(connections);
    expect(this.release).toHaveBeenCalledTimes(connections);
    expect(this.end).not.toHaveBeenCalled();
  }
}
const begin = (): Step[] => [
  { sql: 'BEGIN ISOLATION LEVEL READ COMMITTED' },
  { sql: "SET LOCAL statement_timeout='10s'" },
  { sql: 'SELECT pg_advisory_xact_lock($1)', inspect: call => expect(call.values).toEqual([1985126506]) },
];
const clock = (): Step => ({ sql: 'SELECT clock_timestamp() AS "now"', result: result([{ now: new Date(now) }]) });
const miss = (): Step => ({ sql: lookup, result: result() });
const budget = (active = 0, bytes = 0): Step => ({ sql: counts, result: result([{ active, bytes: String(bytes) }]),
  inspect: call => { expect(call.sql).toContain('"expiresAt">clock_timestamp()');
    expect(call.sql).toContain('sum(octet_length("payload"))'); expect(call.values).toEqual([]); } });
const tx = (body: Step[], end = 'COMMIT'): Step[] => [...begin(), ...body, { sql: end }];
async function denied(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  const error = await promise.then(() => null, reason => reason);
  expect(error).toBeInstanceOf(IntegrationReadError);
  expect(error).toMatchObject({ status, code, message: code });
  expect(String(error)).not.toContain('sensitive driver detail');
  expect(error.cause).toBeUndefined();
}
const auditEvent = (recordId = randomUUID()) => ({ clientId, revision: 2, recordId, operation: 'CHANGES', sha256: null, byteLength: null } as const);

describe('standalone private PostgreSQL change delivery', () => {
  it('accepts the exported ExportPool and implements the agreed ChangeDeliveryStore interface', () => {
    const pool: ExportPool = new ScriptedPool([]);
    const store: ChangeDeliveryStore = new PostgresChangeDeliveryStore(pool);
    expect(['get', 'put', 'audit', 'sweep'].every(name => typeof store[name as keyof ChangeDeliveryStore] === 'function')).toBe(true);
  });

  it('checks columns and durable uniqueness without applying DDL', async () => {
    const pool = new ScriptedPool([
      { scope: 'pool', sql: /^SELECT "id","clientId","contextSha256","issuerRuc","checkpointKey","createdAt","expiresAt","payload","wipedAt" FROM "IntegrationChangeDelivery" WHERE false$/ },
      { scope: 'pool', sql: /^SELECT .* FROM "IntegrationChangeDeliveryAudit" WHERE false$/ },
      { scope: 'pool', sql: /^SELECT count\(\*\)::int AS "total" FROM pg_constraint/, result: result([{ total: 1 }]) },
    ]);
    await new PostgresChangeDeliveryStore(pool).readySchema();
    pool.done(0);
  });

  it('fails schema readiness when the UNIQUE constraint is missing', async () => {
    const pool = new ScriptedPool([{ scope: 'pool', sql: /^SELECT/ }, { scope: 'pool', sql: /^SELECT/ },
      { scope: 'pool', sql: /^SELECT/, result: result([{ total: 0 }]) }]);
    await denied(new PostgresChangeDeliveryStore(pool).readySchema(), 503, 'CONSISTENT_READ_UNAVAILABLE');
    pool.done(0);
  });

  it('reads tenant-bound hashed keys, normalizes dates and copies only explicit record fields', async () => {
    const r = record(), pool = new ScriptedPool([{ scope: 'pool', sql: lookup,
      result: result([{ ...row(r), unwanted: 'not returned' }]), inspect: call => expect(call.values).toEqual([clientId, r.checkpointKey]) }]);
    const got = await new PostgresChangeDeliveryStore(pool).get(clientId.toUpperCase(), r.checkpointKey);
    expect(got).toEqual(r); expect(got?.payload).not.toBe(r.payload);
    pool.done(0);
  });

  it('returns null for a missing key', async () => {
    const pool = new ScriptedPool([{ scope: 'pool', ...miss() }]);
    expect(await new PostgresChangeDeliveryStore(pool).get(clientId, 'b'.repeat(64))).toBeNull(); pool.done(0);
  });

  it.each(['expired', 'tombstone', 'corrupt', 'wrong client', 'wrong key'] as const)('rejects a %s stored row', async kind => {
    const r = record(), stored: Record<string, unknown> = row(r);
    if (kind === 'expired') stored.expiresAt = now;
    if (kind === 'tombstone') stored.payload = null;
    if (kind === 'corrupt') stored.payload = Buffer.from('unencrypted data');
    if (kind === 'wrong client') stored.clientId = otherClient;
    if (kind === 'wrong key') stored.checkpointKey = 'c'.repeat(64);
    const pool = new ScriptedPool([{ scope: 'pool', sql: lookup, result: result([stored]) }]);
    await denied(new PostgresChangeDeliveryStore(pool).get(clientId, r.checkpointKey),
      ['expired', 'tombstone'].includes(kind) ? 410 : 409, ['expired', 'tombstone'].includes(kind) ? 'CURSOR_EXPIRED' : 'INTEGRITY_FAILED');
    pool.done(0);
  });

  it('inserts ciphertext with all values bound, DB clock gates and ON CONFLICT', async () => {
    const r = record(), pool = new ScriptedPool(tx([clock(), miss(), budget(), { sql: insert, result: result([row(r)]),
      inspect: call => {
        expect(call.sql).toContain('ON CONFLICT ("clientId","checkpointKey") DO NOTHING');
        expect(call.sql).toContain('$7::timestamptz>clock_timestamp()');
        expect(call.sql).toContain('$7::timestamptz<=clock_timestamp()+($10::bigint');
        expect(call.values).toEqual([r.id, r.clientId, r.contextSha256, r.issuerRuc, r.checkpointKey,
          r.createdAt, r.expiresAt, r.payload, quotas.clockSkewMs, quotas.ttlMs]);
        expect(call.values[7]).not.toBe(r.payload);
      } } ]));
    expect(await new PostgresChangeDeliveryStore(pool).put(r)).toEqual(r); pool.done();
  });

  it('returns an existing winner before quota checks even with different ID/ciphertext', async () => {
    const winner = record(), retry = record(), pool = new ScriptedPool(tx([clock(), { sql: lookup, result: result([row(winner)]) }]));
    expect(await new PostgresChangeDeliveryStore(pool).put(retry)).toEqual(winner); pool.done();
  });

  it.each(['contextSha256', 'issuerRuc'] as const)('rolls back a conflicting %s', async field => {
    const r = record(), winner = record({ [field]: field === 'issuerRuc' ? '10000000002' : 'c'.repeat(64) });
    const pool = new ScriptedPool(tx([clock(), { sql: lookup, result: result([row(winner)]) }], 'ROLLBACK'));
    await denied(new PostgresChangeDeliveryStore(pool).put(r), 409, 'IDEMPOTENCY_CONFLICT'); pool.done();
  });

  it.each([false, true])('handles a UNIQUE race with conflict=%s', async conflict => {
    const r = record(), winner = record(conflict ? { issuerRuc: '10000000002' } : {});
    const pool = new ScriptedPool(tx([clock(), miss(), budget(), { sql: insert, result: result() },
      { sql: lookup, result: result([row(winner)]) }], conflict ? 'ROLLBACK' : 'COMMIT'));
    const work = new PostgresChangeDeliveryStore(pool).put(r);
    if (conflict) await denied(work, 409, 'IDEMPOTENCY_CONFLICT'); else expect(await work).toEqual(winner);
    pool.done();
  });

  it.each([
    { id: 'not-uuid' }, { checkpointKey: "x';DROP TABLE fiscal;--" }, { contextSha256: 'A'.repeat(64) },
    { issuerRuc: '00000000001' }, { createdAt: '2026-02-30T12:00:00.000Z' }, { expiresAt: now },
    { expiresAt: at(quotas.ttlMs + 1) }, { payload: Buffer.alloc(28, 1) }, { payload: Buffer.alloc(29) },
    { bearer: 'synthetic forbidden field' }, { filters: {} },
  ])('rejects malformed input before connecting (%j)', async invalid => {
    const pool = new ScriptedPool([]);
    await denied(new PostgresChangeDeliveryStore(pool).put({ ...record(), ...invalid } as ChangeDeliveryRecord), 400, 'INVALID_REQUEST'); pool.done(0);
  });

  it('rejects payloads above 4 MiB before connecting', async () => {
    const pool = new ScriptedPool([]);
    await denied(new PostgresChangeDeliveryStore(pool).put(record({ payload: ciphertext(Buffer.alloc(quotas.payloadBytes - 28)) })), 422, 'EXPORT_TOO_LARGE'); pool.done(0);
  });

  it.each(['stale', 'future creation', 'future expiry'] as const)('uses DB time to reject %s', async kind => {
    const r = record(kind === 'stale' ? { createdAt: at(-3600000), expiresAt: now }
      : kind === 'future creation' ? { createdAt: at(quotas.clockSkewMs + 1) }
        : { createdAt: at(30000), expiresAt: at(quotas.ttlMs + 1) });
    const pool = new ScriptedPool(tx([clock()], 'ROLLBACK'));
    await denied(new PostgresChangeDeliveryStore(pool).put(r), kind === 'stale' ? 410 : 400,
      kind === 'stale' ? 'CURSOR_EXPIRED' : 'INVALID_REQUEST'); pool.done();
  });

  it('allows reasonable future test-clock creation while expiry stays within DB + 7 days', async () => {
    const r = record({ createdAt: at(quotas.clockSkewMs), expiresAt: at(quotas.ttlMs) });
    const pool = new ScriptedPool(tx([clock(), miss(), budget(), { sql: insert, result: result([row(r)]) }]));
    expect(await new PostgresChangeDeliveryStore(pool).put(r)).toEqual(r); pool.done();
  });

  it.each(['active', 'bytes', 'bad counts'] as const)('rolls back %s capacity rejection', async kind => {
    const r = record(), pool = new ScriptedPool(tx([clock(), miss(),
      kind === 'bad counts' ? { sql: counts, result: result([{ active: -1, bytes: 'NaN' }]) }
        : budget(kind === 'active' ? 256 : 0, kind === 'bytes' ? quotas.totalBytes - r.payload.length + 1 : 0)], 'ROLLBACK'));
    await denied(new PostgresChangeDeliveryStore(pool).put(r), kind === 'bad counts' ? 503 : 429,
      kind === 'bad counts' ? 'CONSISTENT_READ_UNAVAILABLE' : 'RATE_LIMITED'); pool.done();
  });

  it('allows exactly 4 MiB, 256th active row and exactly 32 MiB retained total', async () => {
    const r = record({ payload: ciphertext(Buffer.alloc(quotas.payloadBytes - 29)) });
    const pool = new ScriptedPool(tx([clock(), miss(), budget(255, quotas.totalBytes - r.payload.length),
      { sql: insert, result: result([row(r)]) }]));
    expect((await new PostgresChangeDeliveryStore(pool).put(r)).payload.length).toBe(quotas.payloadBytes); pool.done();
  });

  it.each(['BEGIN ISOLATION LEVEL READ COMMITTED', "SET LOCAL statement_timeout='10s'", 'SELECT pg_advisory_xact_lock($1)',
    'SELECT clock_timestamp() AS "now"', 'lookup', 'counts', 'insert', 'COMMIT'])('sanitizes failure at %s and always rolls back/releases', async failing => {
    const r = record(), body = [...begin(), clock(), miss(), budget(), { sql: insert, result: result([row(r)]) }, { sql: 'COMMIT' }];
    const aliases: Record<string, number> = { lookup: 4, counts: 5, insert: 6 };
    const index = aliases[failing] ?? body.findIndex(step => step.sql === failing);
    const steps = body.slice(0, index + 1); steps[index] = { ...steps[index], error: new Error('sensitive driver detail') };
    const pool = new ScriptedPool([...steps, { sql: 'ROLLBACK', error: new Error('sensitive driver detail during rollback') }]);
    await denied(new PostgresChangeDeliveryStore(pool).put(r), 503, 'CONSISTENT_READ_UNAVAILABLE'); pool.done();
  });

  it('sanitizes connection/read/schema failures with no fallback', async () => {
    const connection = new ScriptedPool([]); connection.connectError = new Error('sensitive driver detail');
    await denied(new PostgresChangeDeliveryStore(connection).put(record()), 503, 'CONSISTENT_READ_UNAVAILABLE');
    expect(connection.release).not.toHaveBeenCalled();
    for (const method of ['get', 'readySchema'] as const) {
      const pool = new ScriptedPool([{ scope: 'pool', sql: /^SELECT/, error: new Error('sensitive driver detail') }]);
      const store = new PostgresChangeDeliveryStore(pool);
      await denied(method === 'get' ? store.get(clientId, 'b'.repeat(64)) : store.readySchema(), 503, 'CONSISTENT_READ_UNAVAILABLE'); pool.done(0);
    }
  });

  it('audits an empty poll without any delivery lookup, reservation or FK dependency', async () => {
    const event = auditEvent(), pool = new ScriptedPool(tx([{ sql: auditInsert, result: result([{ id: randomUUID() }]), inspect: call => {
      expect(call.values).toEqual([expect.any(String), clientId, 2, event.recordId, 'CHANGES', null, null]);
      expect(call.sql).not.toContain('FROM');
    } }]));
    await new PostgresChangeDeliveryStore(pool).audit(event); pool.done();
    expect(pool.calls.some(call => insert.test(call.sql) || lookup.test(call.sql) || counts.test(call.sql))).toBe(false);
  });

  it('requires audit commit before the consumer response and fails closed on audit error', async () => {
    for (const fail of [false, true]) {
      let entered!: () => void, complete!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { complete = resolve; });
      const pool = new ScriptedPool(tx([{ sql: auditInsert, run: async () => {
        entered(); await gate; if (fail) throw new Error('sensitive driver detail'); return result([{ id: randomUUID() }]);
      } }], fail ? 'ROLLBACK' : 'COMMIT'));
      const response = vi.fn();
      const consume = async () => { await new PostgresChangeDeliveryStore(pool).audit(auditEvent()); response(); return []; };
      const work = consume(); await started; expect(response).not.toHaveBeenCalled(); complete();
      if (fail) { await denied(work, 503, 'CONSISTENT_READ_UNAVAILABLE'); expect(response).not.toHaveBeenCalled(); }
      else { expect(await work).toEqual([]); expect(response).toHaveBeenCalledOnce(); }
      pool.done();
    }
  });

  it.each([{ revision: 0 }, { revision: 2147483648 }, { sha256: 'c'.repeat(64) }, { byteLength: 1 },
    { operation: 'Bearer synthetic' }, { token: 'synthetic' }])('rejects invalid/secret-bearing audit metadata (%j)', async invalid => {
    const pool = new ScriptedPool([]);
    await denied(new PostgresChangeDeliveryStore(pool).audit({ ...auditEvent(), ...invalid } as never), 400, 'INVALID_REQUEST'); pool.done(0);
  });

  it('bounds expiry wiping/deletion, clamps future caller time and retains seven-day tombstones', async () => {
    const future = at(100 * quotas.ttlMs), pool = new ScriptedPool(tx([
      { sql: /^UPDATE "IntegrationChangeDelivery" SET "payload"=NULL,"wipedAt"=clock_timestamp\(\)/, inspect: call => {
        expect(call.values).toEqual([future, 100]); expect(call.sql).toContain('"expiresAt"<=LEAST($1::timestamptz,clock_timestamp())');
        expect(call.sql).toContain('LIMIT $2 FOR UPDATE SKIP LOCKED');
      } },
      { sql: /^DELETE FROM "IntegrationChangeDelivery"/, inspect: call => {
        expect(call.values).toEqual([future, 100, quotas.ttlMs]); expect(call.sql).toContain('"payload" IS NULL AND "wipedAt" IS NOT NULL');
        expect(call.sql).toContain('LIMIT $2 FOR UPDATE SKIP LOCKED');
      } },
    ]));
    await new PostgresChangeDeliveryStore(pool).sweep(future); pool.done();
  });

  it('rolls back a successful wipe when tombstone deletion fails', async () => {
    const pool = new ScriptedPool(tx([{ sql: /^UPDATE "IntegrationChangeDelivery"/ },
      { sql: /^DELETE FROM "IntegrationChangeDelivery"/, error: new Error('sensitive driver detail') }], 'ROLLBACK'));
    await denied(new PostgresChangeDeliveryStore(pool).sweep(now), 503, 'CONSISTENT_READ_UNAVAILABLE'); pool.done();
  });

  it('keeps the blueprint standalone, encrypted, bounded and audit without a foreign key', () => {
    const sql = readFileSync(new URL('../services/integration-export-service/sql/integration-changes.sql', import.meta.url), 'utf8');
    expect([...sql.matchAll(/CREATE TABLE "([^"]+)"/g)].map(match => match[1])).toEqual(['IntegrationChangeDelivery', 'IntegrationChangeDeliveryAudit']);
    expect(sql).toContain('UNIQUE ("clientId","checkpointKey")'); expect(sql).toContain("interval '168 hours'");
    expect(sql).toContain('BETWEEN 29 AND 4194304'); expect(sql).toContain('get_byte("payload",0)=1');
    expect(sql).toContain('CHECK ("sha256" IS NULL)'); expect(sql).toContain('CHECK ("byteLength" IS NULL)');
    expect(sql.replace(/--[^\r\n]*/g, '')).not.toMatch(/\b(?:REFERENCES|FOREIGN KEY|ALTER TABLE|CREATE EXTENSION)\b/i);
    const source = readFileSync(new URL('../services/integration-export-service/src/change-store.ts', import.meta.url), 'utf8');
    expect(source).toContain("import type { ExportPool, ExportSql } from './postgres-store'");
    expect(source).not.toMatch(/Date\.now\(|new Pool\(|process\.env|MemoryStore/);
  });
});

/** A transactional SQL boundary simulator: lock waiters observe committed state.
 * It does not connect to, interpret or apply SQL to PostgreSQL. */
class RacingPool implements ExportPool {
  records = new Map<string, ChangeDeliveryRecord>();
  audits = 0;
  readonly calls: Call[] = [];
  private tail: Promise<void> = Promise.resolve();
  private key(r: ChangeDeliveryRecord) { return `${r.clientId}:${r.checkpointKey}`; }
  seed(r: ChangeDeliveryRecord) { this.records.set(this.key(r), r); }
  async end() { throw new Error('Pool ownership belongs to caller'); }
  async query(sql: string, values: unknown[] = []): Promise<Result> {
    const call: Call = { scope: 'pool', sql: compact(sql), values }; boundary(call); this.calls.push(call);
    if (lookup.test(call.sql)) { const r = this.records.get(`${values[0]}:${values[1]}`); return result(r ? [row(r)] : []); }
    throw new Error('Unexpected pooled query');
  }
  async connect() {
    let unlock: (() => void) | undefined, staged: Map<string, ChangeDeliveryRecord> | undefined, auditCount = 0;
    return { release: () => { expect(unlock).toBeUndefined(); }, query: async (sql: string, values: unknown[] = []): Promise<Result> => {
      const call: Call = { scope: 'client', sql: compact(sql), values }; boundary(call); this.calls.push(call);
      if (call.sql.startsWith('BEGIN') || call.sql.startsWith('SET LOCAL')) return result();
      if (call.sql.startsWith('SELECT pg_advisory_xact_lock')) {
        expect(values).toEqual([1985126506]); const previous = this.tail;
        this.tail = new Promise<void>(resolve => { unlock = resolve; }); await previous; staged = new Map(this.records); return result();
      }
      if (call.sql === 'COMMIT' || call.sql === 'ROLLBACK') {
        if (call.sql === 'COMMIT') { this.records = staged!; this.audits += auditCount; }
        const releaseLock = unlock; unlock = undefined; releaseLock?.(); return result();
      }
      if (call.sql === 'SELECT clock_timestamp() AS "now"') return result([{ now }]);
      if (lookup.test(call.sql)) { const r = staged!.get(`${values[0]}:${values[1]}`); return result(r ? [row(r)] : []); }
      if (counts.test(call.sql)) return result([{ active: [...staged!.values()].filter(r => r.expiresAt > now).length,
        bytes: String([...staged!.values()].reduce((total, r) => total + r.payload.length, 0)) }]);
      if (insert.test(call.sql)) {
        const r: ChangeDeliveryRecord = { id: values[0] as string, clientId: values[1] as string, contextSha256: values[2] as string,
          issuerRuc: values[3] as string, checkpointKey: values[4] as string, createdAt: values[5] as string, expiresAt: values[6] as string, payload: values[7] as Buffer };
        if (staged!.has(this.key(r))) return result(); staged!.set(this.key(r), r); return result([row(r)]);
      }
      if (auditInsert.test(call.sql)) { auditCount++; return result([{ id: values[0] }]); }
      throw new Error('Unexpected transactional query');
    } };
  }
}

describe('simulated transaction races and restart durability', () => {
  it('returns one durable winner across parallel stores and restarts without extra reservations', async () => {
    const pool = new RacingPool(), store = new PostgresChangeDeliveryStore(pool);
    const candidates = Array.from({ length: 12 }, () => record());
    const winners = await Promise.all(candidates.map(r => new PostgresChangeDeliveryStore(pool).put(r)));
    expect(pool.records.size).toBe(1); expect(winners.every(r => r.id === winners[0].id && r.payload.equals(winners[0].payload))).toBe(true);
    expect(pool.calls.filter(call => insert.test(call.sql))).toHaveLength(1);
    expect(await new PostgresChangeDeliveryStore(pool).get(clientId, candidates[0].checkpointKey)).toEqual(winners[0]);
    expect(await store.put(record())).toEqual(winners[0]);
  });

  it('serializes the 256-record bound across competing writers and rolls the loser back', async () => {
    const pool = new RacingPool();
    for (let index = 0; index < 255; index++) pool.seed(record({ checkpointKey: index.toString(16).padStart(64, '0') }));
    const outcome = await Promise.allSettled(['d', 'e'].map(key => new PostgresChangeDeliveryStore(pool).put(record({ checkpointKey: key.repeat(64) }))));
    expect(outcome.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(pool.records.size).toBe(256);
    const failure = outcome.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(failure.reason).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    expect(pool.calls.filter(call => call.sql === 'ROLLBACK')).toHaveLength(1);
  });

  it('serializes the 32 MiB bound including unswept expired ciphertext', async () => {
    const pool = new RacingPool(), payload = ciphertext(Buffer.alloc(quotas.payloadBytes - 29));
    for (let index = 0; index < 7; index++) pool.seed(record({ checkpointKey: index.toString(16).padStart(64, '0'), payload,
      createdAt: at(-3600000), expiresAt: at(-1) }));
    const outcome = await Promise.allSettled(['d', 'e'].map(key => new PostgresChangeDeliveryStore(pool).put(record({ checkpointKey: key.repeat(64), payload }))));
    expect(outcome.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(pool.records.size).toBe(8);
    expect((outcome.find(r => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('many empty polls audit durably with zero delivery rows and zero capacity checks', async () => {
    const pool = new RacingPool(), store = new PostgresChangeDeliveryStore(pool);
    await Promise.all(Array.from({ length: 300 }, () => store.audit(auditEvent())));
    expect(pool.audits).toBe(300); expect(pool.records.size).toBe(0);
    expect(pool.calls.some(call => insert.test(call.sql) || lookup.test(call.sql) || counts.test(call.sql))).toBe(false);
  });
});
