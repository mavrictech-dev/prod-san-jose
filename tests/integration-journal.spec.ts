import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readIntegrationJournal, parseIntegrationJournalHead, PostgresIntegrationJournal,
  type JournalSql, type JournalPool, type JournalPosition } from '../packages/service-access/src/integration-journal';

const issuerRuc = '20555555555', otherRuc = '20444444444', epoch = '10000000-0000-4000-8000-000000000001';
const documentId = '20000000-0000-4000-8000-000000000001', branchId = '30000000-0000-4000-8000-000000000001';
const pointId = '40000000-0000-4000-8000-000000000001', counterId = '50000000-0000-4000-8000-000000000001';
const state = (head = '0', floor = '0') => ({ issuerRuc, environment: 'BETA', epoch, head, floor });
const after = (sequence = '0'): JournalPosition => ({ epoch, sequence });
const event = (sequence = '1', extra: Record<string, unknown> = {}) => ({ id: randomUUID(), sequence, ownerKind: 'DOCUMENT',
  ownerId: documentId, eventKind: 'DOCUMENT_CREATED', occurredAt: new Date('2026-01-01T00:00:00Z'), artifactId: null, ...extra });
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const billingSQL = source('services/billing-service/prisma/integration-changes.sql');
const sunatSQL = source('services/sunat-service/prisma/integration-changes.sql');
function fake(head = state(), events: unknown[] = []) {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => ({ rows:
    sql.includes('pg_catalog.pg_trigger') ? [{ ready: true }] : sql.includes('FROM public."IntegrationChangeState"') ? [head] : sql.includes('FROM public."IntegrationChangeEvent"') ? events : [] }));
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  return { query, release, connect, repo: new PostgresIntegrationJournal({ connect }) };
}

describe('Owner technical journal interface', () => {
  it('barrier is only a validated head; helper never manages the caller transaction', async () => {
    const f = fake(state('9007199254740993'));
    const page = await readIntegrationJournal(f, issuerRuc, null);
    expect(page).toEqual({ epoch, head: '9007199254740993', floor: '0',
      position: after('9007199254740993'), events: [] });
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(f.query.mock.calls[1][1]).toEqual([issuerRuc]);
    expect(f.query.mock.calls[1][0]).not.toMatch(/BEGIN|COMMIT|FOR UPDATE|SELECT \*/);
  });
  it('pool owns one RepeatableRead read-only snapshot and releases it', async () => {
    const f = fake(state('1'), [event()]);
    expect((await f.repo.read(issuerRuc, after())).position).toEqual(after('1'));
    expect(f.query.mock.calls.map(c => c[0])[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(f.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(f.connect).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(1);
  });
  it('binds RUC, epoch, exact decimal checkpoints, snapshot head and capped limit', async () => {
    const base = 9007199254740993n, f = fake(state((base + 1n).toString()), [event((base + 1n).toString())]);
    const page = await readIntegrationJournal(f, issuerRuc, after(base.toString()), 99999, 'SUNAT');
    expect(f.query.mock.calls[2][1]).toEqual([issuerRuc, epoch, base.toString(), (base + 1n).toString(), 500]);
    expect(f.query.mock.calls[2][0]).toMatch(/"sequence">\$3::bigint[\s\S]*"sequence"<=\$4::bigint[\s\S]*ORDER BY "sequence" ASC LIMIT \$5/);
    expect(f.query.mock.calls[2][0]).not.toContain(issuerRuc);
    expect(page.events[0].id).toMatch(/^SUNAT:[0-9a-f-]{36}$/);
    expect(page.position.sequence).toBe((base + 1n).toString());
    expect(JSON.stringify(page)).toContain((base + 1n).toString());
  });
  it('enforces page count and position instead of skipping to a newer head', async () => {
    const f = fake(state('501'), Array.from({ length: 500 }, (_, i) => event(String(i + 1))));
    const page = await f.repo.read(issuerRuc, after());
    expect(page.events).toHaveLength(500); expect(page.head).toBe('501'); expect(page.position.sequence).toBe('500');
  });
  it.each(['01', '-1', '+1', ' 1', '1 ', '1.0', '1e2', '', '1;DROP TABLE x', '9223372036854775808',
    '9'.repeat(1000), 1, 1n, null, {}])('rejects malformed checkpoint %# before any query', async value => {
    const f = fake();
    await expect(f.repo.read(issuerRuc, { epoch, sequence: value } as any)).rejects.toMatchObject({ status: 400, code: 'INVALID_QUERY' });
    expect(f.connect).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, Infinity, NaN, '2', null])('rejects invalid limit %j before connecting', async limit => {
    const f = fake(); await expect(f.repo.read(issuerRuc, null, limit as any)).rejects.toMatchObject({ status: 400 });
    expect(f.connect).not.toHaveBeenCalled();
  });
  it.each(['00044232378', '*', `${issuerRuc}' OR true--`])('rejects synthetic/foreign input RUC %s', async ruc => {
    const f = fake(); await expect(f.repo.read(ruc, null)).rejects.toMatchObject({ status: 400 }); expect(f.connect).not.toHaveBeenCalled();
  });
  it.each([{ epoch: randomUUID(), sequence: '1' }, after('4'), after('0')])('explicitly expires wrong epoch/future/trimmed position %j', async position => {
    const f = fake(state('3', '1'));
    await expect(f.repo.read(issuerRuc, position)).rejects.toMatchObject({ status: 410, code: 'CURSOR_EXPIRED' });
    expect(f.query.mock.calls.some(c => c[0].includes('ORDER BY "sequence" ASC LIMIT'))).toBe(false);
    expect(f.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK'); expect(f.release).toHaveBeenCalledTimes(1);
  });
  it('accepts the inclusive floor and an exact head with no further events', async () => {
    const f = fake(state('1', '1'));
    expect((await f.repo.read(issuerRuc, after('1'))).position).toEqual(after('1'));
  });
  it.each([{ ...state(), environment: 'PRODUCTION' }, { ...state(), issuerRuc: otherRuc },
    { ...state(), epoch: 'bad' }, { ...state(), head: 9007199254740992 }, state('0', '1'), state('1e3')])(
    'fails closed for corrupt/foreign state %j', async row => {
      expect(() => parseIntegrationJournalHead(row, issuerRuc)).toThrow('CHANGE_FEED_NOT_READY');
    });
  it('does not manufacture readiness on absent state, missing schema or connection failure', async () => {
    const missing = { query: vi.fn(async () => ({ rows: [] })) };
    await expect(readIntegrationJournal(missing, issuerRuc, null)).rejects.toMatchObject({ status: 503, code: 'CHANGE_FEED_NOT_READY' });
    for (const query of [async () => { throw new Error('private SQL / secret path'); }]) {
      await expect(readIntegrationJournal({ query }, issuerRuc, null)).rejects.toThrow('CHANGE_FEED_NOT_READY');
    }
    const pool: JournalPool = { connect: async () => { throw new Error('secret connection'); } };
    await expect(new PostgresIntegrationJournal(pool).read(issuerRuc, null)).rejects.toMatchObject({ status: 503 });
    expect(missing.query).toHaveBeenCalledTimes(1);
  });
  it.each([false, 'true', null, undefined])('rejects incomplete/disabled/wrong catalog readiness %# before head reads', async ready => {
    const query = vi.fn(async () => ({ rows: [{ ready }] }));
    await expect(readIntegrationJournal({ query }, issuerRuc, null)).rejects.toMatchObject({ status: 503, code: 'CHANGE_FEED_NOT_READY' });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it.each([
    [], [event('2')], [event('0')], [event('1'), event('2')], [event('1', { ownerId: 'hidden plaintext' })],
    [event('1', { artifactId: 'secret' })], [event('1', { eventKind: 'OTHER' })],
    [event('1', { eventKind: 'ARTIFACT_ADDED', artifactId: null })], [event('1', { occurredAt: 'secret path' })],
    [event('1', { ownerKind: 'BATCH' })],
  ])('fails closed for gaps/excess/malformed rows %#', async rows => {
    const f = fake(state('1'), rows); await expect(f.repo.read(issuerRuc, after(), 1)).rejects.toMatchObject({ status: 503 });
  });
  it('whitelists only metadata and does not log/relay extra rows or database diagnostics', async () => {
    const f = fake(state('1'), [event('1', { payload: { secret: 'MUST_NOT_ESCAPE' }, storageKey: 'MUST_NOT_ESCAPE' })]);
    const page = await f.repo.read(issuerRuc, after());
    expect(Object.keys(page.events[0]).sort()).toEqual(['id', 'sequence', 'ownerKind', 'ownerId', 'kind', 'occurredAt', 'artifactId'].sort());
    expect(JSON.stringify(page)).not.toContain('MUST_NOT_ESCAPE');
    const code = source('packages/service-access/src/integration-journal.ts');
    expect(code).not.toMatch(/console\.|process\.(stdout|stderr)|logger\.|SELECT \*/);
  });
  it('trim locks state, proves contiguous prefix, then atomically deletes and advances floor', async () => {
    const calls: { sql: string; values?: unknown[] }[] = [];
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      return { rows: sql.includes('FOR UPDATE') ? [state('4', '1')] : sql.includes('count(*)') ? [{ count: '2', first: '2', last: '3' }] :
        sql.startsWith('UPDATE') ? [state('4', '3')] : [] };
    });
    const release = vi.fn(), repo = new PostgresIntegrationJournal({ connect: async () => ({ query, release }) });
    expect(await repo.trim(issuerRuc, after('3'))).toEqual({ epoch, head: '4', floor: '3' });
    expect(calls.map(c => c.sql).findIndex(s => s.includes('FOR UPDATE'))).toBeLessThan(calls.map(c => c.sql).findIndex(s => s.startsWith('DELETE')));
    expect(calls.find(c => c.sql.startsWith('DELETE'))?.values).toEqual([issuerRuc, epoch, '3']);
    expect(calls.find(c => c.sql.startsWith('UPDATE'))?.values).toEqual([issuerRuc, epoch, '3']);
    expect(calls.at(-1)?.sql).toBe('COMMIT'); expect(release).toHaveBeenCalledTimes(1);
  });
  it('trim refuses a gap or expired floor and rolls back without deleting', async () => {
    for (const first of ['2', '3']) {
      const query = vi.fn(async (sql: string) => ({ rows: sql.includes('FOR UPDATE') ? [state('4', '1')] :
        sql.includes('count(*)') ? [{ count: '1', first, last: '3' }] : [] }));
      const repo = new PostgresIntegrationJournal({ connect: async () => ({ query, release() {} }) });
      await expect(repo.trim(issuerRuc, after('3'))).rejects.toMatchObject({ status: 503 });
      expect(query.mock.calls.some(c => c[0].startsWith('DELETE'))).toBe(false); expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    }
    const f = fake(state('4', '2')); await expect(f.repo.trim(issuerRuc, after('1'))).rejects.toMatchObject({ status: 410 });
  });
});

describe('Installation SQL contracts', () => {
  it.each([['BILLING', billingSQL], ['SUNAT', sunatSQL]])('%s allocates per RUC using transaction row UPDATE RETURNING', (_owner, sql) => {
    expect(sql).not.toMatch(/nextval|bigserial|CREATE SEQUENCE|MAX\s*\(\s*"?(occurredAt|updatedAt|createdAt)|emitterOutbox/i);
    expect(sql).toMatch(/UPDATE public\."IntegrationChangeState" SET "head"="head"\+1[\s\S]*?WHERE "issuerRuc"=issuer AND "environment"='BETA'[\s\S]*?RETURNING "head", "epoch" INTO/);
    const allocation = sql.indexOf('UPDATE public."IntegrationChangeState"');
    expect(sql.indexOf('INSERT INTO public."IntegrationChangeEvent"', allocation)).toBeGreaterThan(allocation);
    expect(sql).toMatch(/AFTER INSERT OR UPDATE ON public\."(Document|FiscalDocument)"/);
    expect(sql).toMatch(/IN ACCESS EXCLUSIVE MODE/);
    expect(sql).toMatch(/EMPTY|start EMPTY/); expect(sql).toMatch(/RESTORE\/CLONE/);
    expect(sql).toMatch(/regenerate|epoch=gen_random_uuid/);
    const eventTable = sql.split('CREATE TABLE public."IntegrationChangeEvent"')[1].split(');')[0];
    expect(eventTable).not.toMatch(/payload|snapshot|customer|storageKey|password|secret|xml/i);
    expect(sql).not.toMatch(/ON public\."(FiscalCircuitQa|FiscalBatchQa|NotesQa|GreQaGuide)"/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION/);
    expect(sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n')).not.toMatch(/CREATE ROLE|GRANT .* TO /);
  });
});

// Synthetic in-memory PostgreSQL only. No network, Docker, credentials, server
// runtime, persistent data directory or installed migrations. PGlite is already
// bundled transitively; locate that local package without changing dependencies.
interface MemorySql extends JournalSql { exec(sql: string): Promise<unknown>; close(): Promise<void> }
const require = createRequire(import.meta.url);
function memoryDatabase(): MemorySql {
  const store = new URL('../node_modules/.pnpm/', import.meta.url);
  const local = readdirSync(store).find(name => /^@electric-sql\+pglite@/.test(name));
  if (!local) throw new Error('Bundled in-memory PostgreSQL package is required for journal SQL tests');
  const { PGlite } = require(join(store.pathname.replace(/^\/(?=[A-Za-z]:)/, ''), local, 'node_modules', '@electric-sql', 'pglite'));
  return new PGlite(); // no path: strictly ephemeral in-memory
}
/** All actual scalar columns/enums from the owner schemas. Relax fixture
 * defaults only; relations are not synthesized. Blueprint FKs remain enforced.
 */
function fixtureSchema(schema: string, models: string[]) {
  const enums = [...schema.matchAll(/enum (\w+)\s*\{([^}]+)\}/g)];
  const enumNames = new Set(enums.map(m => m[1]));
  const ddl = enums.map(m => `CREATE TYPE "${m[1]}" AS ENUM (${m[2].trim().split(/\s+/).map(v => `'${v}'`).join(',')});`);
  for (const name of models) {
    const model = new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema)?.[1];
    if (!model) throw new Error('Missing actual fixture model ' + name);
    const columns: string[] = [];
    for (const line of model.split('\n')) {
      const match = /^\s*(\w+)\s+(\w+)(\?|\[\])?(.*)/.exec(line);
      if (!match) continue;
      const [, field, type, suffix, attributes] = match;
      if (!['String', 'Int', 'BigInt', 'Boolean', 'Decimal', 'Json', 'DateTime'].includes(type) && !enumNames.has(type)) continue;
      const sqlType = enumNames.has(type) ? `"${type}"` : type === 'String' ? (attributes.includes('@db.Uuid') ? 'uuid' : 'text') :
        ({ Int: 'integer', BigInt: 'bigint', Boolean: 'boolean', Decimal: 'numeric', Json: 'jsonb', DateTime: 'timestamptz' } as any)[type];
      const fallback = enumNames.has(type) ? `'${enums.find(m => m[1] === type)![2].trim().split(/\s+/)[0]}'` :
        sqlType === 'uuid' ? 'gen_random_uuid()' : sqlType === 'text' ? "''" : type === 'DateTime' ? 'now()' : type === 'Json' ? "'{}'::jsonb" :
          type === 'Boolean' ? 'false' : '0';
      columns.push(`"${field}" ${sqlType}${suffix === '[]' ? '[]' : ''}${suffix === '?' ? '' : ' NOT NULL'} DEFAULT ${suffix === '?' ? 'NULL' : suffix === '[]' ? "'{}'" : fallback}${attributes.includes('@id') ? ' PRIMARY KEY' : ''}`);
    }
    ddl.push(`CREATE TABLE public."${name}" (${columns.join(',')});`);
  }
  return ddl.join('\n');
}
function snapshot(id = documentId, code = '01', ruc = issuerRuc, environment = 'BETA') {
  return { documentId: id, companyId: 1, branchId, documentTypeCode: code, environment, issuer: { identityNumber: ruc },
    series: code === '03' ? 'B001' : 'F001', number: '1', fullNumber: `${code === '03' ? 'B001' : 'F001'}-1`,
    customer: { legalName: 'PRIVATE_CUSTOMER_MUST_NOT_ESCAPE' }, issueDate: '2026-01-01T00:00:00Z', totals: { payableAmount: '118' } };
}
async function insertBilling(db: MemorySql, id = documentId, code = '01', ruc = issuerRuc, environment = 'BETA', status = 'ISSUED') {
  const type = ({ '01': 'INVOICE', '03': 'SALES_RECEIPT', '07': 'CREDIT_NOTE', '08': 'DEBIT_NOTE', '09': 'DESPATCH_ADVICE' } as any)[code];
  await db.query(`INSERT INTO "Document" ("id","companyId","emissionPointId","seriesCounterId","type","status","series","number", "fullNumber","immutableSnapshot","issueDate","payableAmount")
    VALUES ($1,1,$2,$3,$4,$5,$6,1,$7,$8,'2026-01-01',118)`,
  [id, pointId, counterId, type, status, code === '03' ? 'B001' : 'F001', `${code === '03' ? 'B001' : 'F001'}-1`, JSON.stringify(snapshot(id, code, ruc, environment))]);
}
async function insertFiscal(db: MemorySql, id = documentId, code = '01', ruc = issuerRuc, environment = 'BETA', extra = {}) {
  await db.query(`INSERT INTO "FiscalDocument" ("documentId","issuerRuc","environment","documentType","series","number","billingEventId","immutablePayload")
    VALUES ($1,$2,$3,$4,$5,1,$6,$7)`, [id, ruc, environment, code, code === '03' ? 'B001' : 'F001', randomUUID(), JSON.stringify({ ...snapshot(id, code, ruc, environment), ...extra })]);
}
async function storedHead(db: MemorySql, ruc = issuerRuc) {
  return (await db.query('SELECT "head"::text,"floor"::text,"epoch"::text FROM "IntegrationChangeState" WHERE "issuerRuc"=$1', [ruc])).rows[0] as any;
}
async function rejectStatement(db: MemorySql, sql: string, values?: unknown[]) {
  await db.exec('SAVEPOINT rejected_write');
  await expect(db.query(sql, values)).rejects.toThrow(/INTEGRATION_JOURNALED|foreign key/);
  await db.exec('ROLLBACK TO SAVEPOINT rejected_write');
}

describe('Billing blueprint executed on synthetic in-memory PostgreSQL', () => {
  let db: MemorySql;
  const historicalId = randomUUID();
  beforeAll(async () => {
    db = memoryDatabase();
    await db.exec(fixtureSchema(source('services/billing-service/prisma/schema.prisma'), ['CompanySettings', 'Branch', 'EmissionPoint', 'SeriesCounter', 'Document']));
    await db.query('INSERT INTO "CompanySettings" ("id","ruc","environment") VALUES (1,$1,\'BETA\')', [issuerRuc]);
    await db.query('INSERT INTO "Branch" ("id","companyId") VALUES ($1,1)', [branchId]);
    await db.query('INSERT INTO "EmissionPoint" ("id","companyId","branchId") VALUES ($1,1,$2)', [pointId, branchId]);
    await db.query('INSERT INTO "SeriesCounter" ("id","companyId","emissionPointId","documentType","series") VALUES ($1,1,$2,\'INVOICE\',\'F001\')', [counterId, pointId]);
    await insertBilling(db, historicalId);
    await db.exec(billingSQL);
  }, 30000);
  beforeEach(async () => { await db.exec('BEGIN'); });
  afterEach(async () => { await db.exec('ROLLBACK'); });
  afterAll(async () => { await db?.close(); });
  it('seeds an empty journal, without inventing history, and protects historical bindings', async () => {
    expect((await storedHead(db)).head).toBe('0');
    expect((await db.query('SELECT * FROM "IntegrationChangeEvent"')).rows).toEqual([]);
    await rejectStatement(db, 'DELETE FROM "Document" WHERE "id"=$1', [historicalId]);
  });
  it('owner insert/update, state, event UUID and rollback share one transaction', async () => {
    await db.exec('SAVEPOINT owner_write'); await insertBilling(db);
    expect((await storedHead(db)).head).toBe('1');
    await db.exec('ROLLBACK TO SAVEPOINT owner_write'); expect((await storedHead(db)).head).toBe('0');
    expect((await db.query('SELECT "id" FROM "Document" WHERE "id"=$1', [documentId])).rows).toEqual([]);
    await insertBilling(db);
    const baseline = await readIntegrationJournal(db, issuerRuc, null);
    await db.query('UPDATE "Document" SET "sunatStatus"=\'ACCEPTED\' WHERE "id"=$1', [documentId]);
    await db.query('UPDATE "Document" SET "originId"=\'PRIVATE_ORIGIN\' WHERE "id"=$1', [documentId]);
    const page = await readIntegrationJournal(db, issuerRuc, baseline.position);
    expect(page.events.map(e => e.kind)).toEqual(['DOCUMENT_STATE_CHANGED', 'DOCUMENT_RECONCILED']);
    expect(page.events.map(e => e.sequence)).toEqual(['2', '3']);
    expect(page.events.every(e => /^BILLING:[0-9a-f-]{36}$/.test(e.id))).toBe(true);
    expect(JSON.stringify(page)).not.toMatch(/PRIVATE_|customer|snapshot/);
  });
  it('captures only emitted BETA snapshots, independent of current company environment', async () => {
    await insertBilling(db, randomUUID(), '01', issuerRuc, 'PRODUCTION');
    await insertBilling(db, randomUUID(), '01', issuerRuc, 'BETA', 'DRAFT');
    await insertBilling(db, randomUUID(), '09');
    await insertBilling(db, randomUUID(), '01', '00044232378');
    expect((await storedHead(db)).head).toBe('0');
    await db.query('UPDATE "CompanySettings" SET "environment"=\'PRODUCTION\' WHERE "id"=1');
    await insertBilling(db); expect((await storedHead(db)).head).toBe('1');
  });
  it('maps all actual sales enums and preserves per-RUC independent state', async () => {
    for (const [code, type] of Object.entries({ '01': 'INVOICE', '03': 'SALES_RECEIPT', '07': 'CREDIT_NOTE', '08': 'DEBIT_NOTE' })) {
      // Frozen historical counter cannot be repurposed; allocate a separate fixture counter.
      const id = randomUUID(), counter = randomUUID();
      await db.query('INSERT INTO "SeriesCounter" ("id","companyId","emissionPointId","documentType","series") VALUES ($1,1,$2,$3,$4)', [counter, pointId, type, code === '03' ? 'B001' : 'F001']);
      await db.query(`INSERT INTO "Document" ("id","companyId","emissionPointId","seriesCounterId","type","status","series","number","fullNumber","immutableSnapshot")
        VALUES ($1,1,$2,$3,$4,'ISSUED',$5,1,$6,$7)`, [id, pointId, counter, type, code === '03' ? 'B001' : 'F001', snapshot(id, code).fullNumber, JSON.stringify(snapshot(id, code))]);
    }
    expect((await storedHead(db)).head).toBe('4');
    await db.query('INSERT INTO "CompanySettings" ("id","ruc","environment") VALUES (2,$1,\'BETA\')', [otherRuc]);
    expect((await storedHead(db, otherRuc)).head).toBe('0');
  });
  it('rejects frozen content/filter edits, deletes and direct/indirect rebinding even after trim', async () => {
    await insertBilling(db);
    await db.query('DELETE FROM "IntegrationChangeEvent" WHERE "issuerRuc"=$1', [issuerRuc]);
    await db.query('UPDATE "IntegrationChangeState" SET "floor"="head" WHERE "issuerRuc"=$1', [issuerRuc]);
    for (const change of ['"companyId"=2', '"immutableSnapshot"=jsonb_set("immutableSnapshot",\'{customer,legalName}\',\'"CHANGED"\')',
      '"issueDate"=\'2027-01-01\'', '"payableAmount"=119', '"series"=\'F002\'', '"status"=\'DRAFT\''])
      await rejectStatement(db, `UPDATE "Document" SET ${change} WHERE "id"=$1`, [documentId]);
    await rejectStatement(db, 'DELETE FROM "Document" WHERE "id"=$1', [documentId]);
    await rejectStatement(db, 'UPDATE "CompanySettings" SET "ruc"=$1 WHERE "id"=1', [otherRuc]);
    await rejectStatement(db, 'UPDATE "EmissionPoint" SET "branchId"=NULL WHERE "id"=$1', [pointId]);
    await rejectStatement(db, 'UPDATE "SeriesCounter" SET "series"=\'F002\' WHERE "id"=$1', [counterId]);
    await rejectStatement(db, 'UPDATE "Branch" SET "companyId"=2 WHERE "id"=$1', [branchId]);
    await rejectStatement(db, 'TRUNCATE "Document" CASCADE');
    await rejectStatement(db, 'DELETE FROM "IntegrationChangeBinding"');
    await db.query('UPDATE "Document" SET "sunatStatus"=\'REJECTED\' WHERE "id"=$1', [documentId]);
    expect((await storedHead(db)).head).toBe('2');
  });
  it('missing schema fails closed and never returns the underlying SQL error', async () => {
    await db.exec('ALTER TABLE "IntegrationChangeState" RENAME COLUMN "head" TO "unavailable"');
    await expect(readIntegrationJournal(db, issuerRuc, null)).rejects.toMatchObject({ status: 503, code: 'CHANGE_FEED_NOT_READY' });
  });
  it('barrier-only reads require the event schema even if state and all source triggers exist', async () => {
    await db.exec('DROP TABLE "IntegrationChangeEvent"');
    await expect(readIntegrationJournal(db, issuerRuc, null)).rejects.toMatchObject({ status: 503, code: 'CHANGE_FEED_NOT_READY' });
  });
  it('every disabled Billing emitter or guard blocks a barrier; ALL mode remains active', async () => {
    const triggers = (await db.query(`SELECT t.tgname,c.relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      WHERE NOT t.tgisinternal AND t.tgname LIKE 'IntegrationChange%'`)).rows as { tgname: string; relname: string }[];
    expect(triggers).toHaveLength(13);
    for (const trigger of triggers) {
      await db.exec('SAVEPOINT disabled_trigger');
      await db.exec(`ALTER TABLE "${trigger.relname}" DISABLE TRIGGER "${trigger.tgname}"`);
      await expect(readIntegrationJournal(db, issuerRuc, null)).rejects.toMatchObject({ status: 503 });
      await db.exec('ROLLBACK TO SAVEPOINT disabled_trigger');
    }
    await db.exec('ALTER TABLE "Document" ENABLE ALWAYS TRIGGER "IntegrationChangeDocument"');
    expect((await readIntegrationJournal(db, issuerRuc, null)).head).toBe('0');
  });
  it('wrong timing/events, replica-only and missing triggers cannot pass the installation gate', async () => {
    for (const replacement of [
      'ALTER TABLE "Document" ENABLE REPLICA TRIGGER "IntegrationChangeDocument"',
      'DROP TRIGGER "IntegrationChangeDocument" ON "Document"',
      'DROP TRIGGER "IntegrationChangeDocument" ON "Document"; CREATE TRIGGER "IntegrationChangeDocument" AFTER UPDATE ON "Document" FOR EACH ROW EXECUTE FUNCTION integration_change_billing_document()',
    ]) {
      await db.exec('SAVEPOINT invalid_installation'); await db.exec(replacement);
      await expect(readIntegrationJournal(db, issuerRuc, null)).rejects.toMatchObject({ status: 503 });
      await db.exec('ROLLBACK TO SAVEPOINT invalid_installation');
    }
  });
});

describe('SUNAT blueprint executed on synthetic in-memory PostgreSQL', () => {
  let db: MemorySql;
  beforeAll(async () => {
    db = memoryDatabase();
    await db.exec(fixtureSchema(source('services/sunat-service/prisma/schema.prisma'), ['IssuerProjection', 'FiscalDocument', 'FiscalBatch', 'DocumentArtifact', 'BatchArtifact', 'SunatSubmission', 'CdrLog']));
    await db.query('INSERT INTO "IssuerProjection" ("id","ruc","environment") VALUES (1,$1,\'BETA\')', [issuerRuc]);
    await db.exec(sunatSQL);
  }, 30000);
  beforeEach(async () => { await db.exec('BEGIN'); });
  afterEach(async () => { await db.exec('ROLLBACK'); });
  afterAll(async () => { await db?.close(); });
  async function batch(id = randomUUID(), legacy = false) {
    const receipt = snapshot(randomUUID(), '03');
    const payload = legacy ? receipt : { environment: 'BETA', issuer: { identityNumber: issuerRuc }, identifier: 'RC-20260101-1',
      kind: 'RC', input: { kind: 'RC', entries: [{ conditionCode: '1', document: { snapshot: receipt } }] } };
    await db.query(`INSERT INTO "FiscalBatch" ("id","issuerRuc","environment","summaryId","identifier","billingEventId","immutablePayload")
      VALUES ($1,$2,'BETA',$3,'RC-20260101-1',$4,$5)`, [id, issuerRuc, randomUUID(), randomUUID(), JSON.stringify(payload)]);
    return id;
  }
  it('new BETA issuer projections get empty state; 00 laboratory and production never do', async () => {
    await db.query('INSERT INTO "IssuerProjection" ("id","ruc","environment") VALUES (2,$1,\'BETA\'),(3,\'00044232378\',\'BETA\'),(4,\'20333333333\',\'PRODUCTION\')', [otherRuc]);
    expect((await storedHead(db, otherRuc)).head).toBe('0');
    expect((await db.query('SELECT * FROM "IntegrationChangeEvent"')).rows).toHaveLength(0);
    expect((await db.query('SELECT "issuerRuc" FROM "IntegrationChangeState"')).rows).toHaveLength(2);
    await db.query('UPDATE "IssuerProjection" SET "environment"=\'BETA\' WHERE "id"=4');
    expect((await storedHead(db, '20333333333')).head).toBe('0');
  });
  it('every SUNAT emitter, CDR proof guard and durable-binding guard is required for a barrier', async () => {
    const triggers = (await db.query(`SELECT t.tgname,c.relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      WHERE NOT t.tgisinternal AND (t.tgname LIKE 'IntegrationChange%' OR t.tgname LIKE 'IntegrationChange%Guard')`)).rows as { tgname: string; relname: string }[];
    expect(triggers).toHaveLength(22);
    for (const trigger of triggers) {
      await db.exec('SAVEPOINT disabled_trigger');
      await db.exec(`ALTER TABLE "${trigger.relname}" DISABLE TRIGGER "${trigger.tgname}"`);
      await expect(readIntegrationJournal(db, issuerRuc, null, 500, 'SUNAT')).rejects.toMatchObject({ status: 503 });
      await db.exec('ROLLBACK TO SAVEPOINT disabled_trigger');
    }
  });
  it('only safe canonical BETA 01/03/07/08 are journaled; QA, drift, 09/31 and production excluded', async () => {
    for (const code of ['01', '03', '07', '08']) await insertFiscal(db, randomUUID(), code);
    for (const code of ['09', '31']) await insertFiscal(db, randomUUID(), code);
    await insertFiscal(db, randomUUID(), '01', issuerRuc, 'PRODUCTION');
    await insertFiscal(db, randomUUID(), '01', '00044232378');
    await insertFiscal(db, randomUUID(), '01', issuerRuc, 'BETA', { qaOnly: true });
    await insertFiscal(db, randomUUID(), '01', issuerRuc, 'BETA', { issuer: { identityNumber: otherRuc } });
    expect((await storedHead(db)).head).toBe('4');
    await insertFiscal(db, randomUUID(), '01', otherRuc);
    expect((await storedHead(db, otherRuc)).head).toBe('1');
  });
  it.each([false, true])('captures modern or legacy RC batch %j status and artifacts', async legacy => {
    const id = await batch(randomUUID(), legacy), artifactId = randomUUID();
    await db.query('UPDATE "FiscalBatch" SET "status"=\'ACCEPTED\' WHERE "id"=$1', [id]);
    await db.query(`INSERT INTO "BatchArtifact" ("id","batchId","kind","storageKey","sha256","sizeBytes") VALUES ($1,$2,'CDR_XML','PRIVATE_PATH',$3,10)`, [artifactId, id, 'a'.repeat(64)]);
    await db.query('UPDATE "BatchArtifact" SET "storageKey"=\'OTHER_PRIVATE_PATH\',"sizeBytes"=11 WHERE "id"=$1', [artifactId]);
    const head = await storedHead(db);
    const page = await readIntegrationJournal(db, issuerRuc, { epoch: head.epoch, sequence: '0' }, 500, 'SUNAT');
    expect(page.events.map(e => e.kind)).toEqual(['DOCUMENT_CREATED', 'DOCUMENT_STATE_CHANGED', 'ARTIFACT_ADDED', 'DOCUMENT_RECONCILED']);
    expect(page.events.every(e => e.ownerKind === 'BATCH' && e.ownerId === id)).toBe(true);
    expect(page.events[2].artifactId).toBe(artifactId); expect(JSON.stringify(page)).not.toContain('PRIVATE_');
    await rejectStatement(db, 'UPDATE "FiscalBatch" SET "immutablePayload"=jsonb_set("immutablePayload",\'{customer}\',\'{}\') WHERE "id"=$1', [id]);
    await rejectStatement(db, 'UPDATE "FiscalBatch" SET "summaryId"=$1 WHERE "id"=$2', [randomUUID(), id]);
    await rejectStatement(db, 'DELETE FROM "FiscalBatch" WHERE "id"=$1', [id]);
    await rejectStatement(db, 'UPDATE "BatchArtifact" SET "batchId"=$1 WHERE "id"=$2', [randomUUID(), artifactId]);
  });
  it('document digest/status/artifact edits emit while frozen payload and bindings cannot change', async () => {
    await insertFiscal(db); const artifactId = randomUUID();
    await db.query('UPDATE "FiscalDocument" SET "digestValue"=\'PRIVATE_DIGEST\' WHERE "documentId"=$1', [documentId]);
    await db.query('UPDATE "FiscalDocument" SET "status"=\'ACCEPTED\' WHERE "documentId"=$1', [documentId]);
    await db.query(`INSERT INTO "DocumentArtifact" ("id","documentId","kind","storageKey","sha256","sizeBytes") VALUES ($1,$2,'SIGNED_XML','PRIVATE_PATH',$3,10)`, [artifactId, documentId, 'a'.repeat(64)]);
    await db.query('UPDATE "DocumentArtifact" SET "sha256"=$1 WHERE "id"=$2', ['b'.repeat(64), artifactId]);
    expect((await storedHead(db)).head).toBe('5');
    await db.query('DELETE FROM "IntegrationChangeEvent"'); await db.query('UPDATE "IntegrationChangeState" SET "floor"="head"');
    for (const assignment of ['"issuerRuc"=\'20444444444\'', '"environment"=\'PRODUCTION\'',
      '"immutablePayload"=jsonb_set("immutablePayload",\'{customer,legalName}\',\'"CHANGED"\')'])
      await rejectStatement(db, `UPDATE "FiscalDocument" SET ${assignment} WHERE "documentId"=$1`, [documentId]);
    await rejectStatement(db, 'DELETE FROM "FiscalDocument" WHERE "documentId"=$1', [documentId]);
    await rejectStatement(db, 'DELETE FROM "DocumentArtifact" WHERE "id"=$1', [artifactId]);
    await rejectStatement(db, 'UPDATE "DocumentArtifact" SET "kind"=\'CDR_XML\' WHERE "id"=$1', [artifactId]);
    await rejectStatement(db, 'TRUNCATE "DocumentArtifact"');
    await rejectStatement(db, 'DELETE FROM "IntegrationChangeBinding"');
  });
  it('CDR proof arrival after existing artifacts emits reconciliations without copying bodies', async () => {
    await insertFiscal(db); const batchId = await batch(), submissionId = randomUUID(), proofId = randomUUID();
    await db.query(`INSERT INTO "DocumentArtifact" ("documentId","kind","storageKey","sha256") VALUES ($1,'CDR_XML','PRIVATE_PATH',$2)`, [documentId, 'a'.repeat(64)]);
    await db.query(`INSERT INTO "SunatSubmission" ("id","documentId","batchId","channel","idempotencyKey") VALUES ($1,$2,$3,'SOAP_GET_STATUS','PRIVATE_KEY')`, [submissionId, documentId, batchId]);
    const barrier = await storedHead(db);
    await db.query(`INSERT INTO "CdrLog" ("id","documentId","batchId","submissionId","responseCode","description","notes","cdrStorageKey","cdrSha256")
      VALUES ($1,$2,$3,$4,'0','PRIVATE_DESCRIPTION',ARRAY['PRIVATE_NOTE'],'PRIVATE_CDR_PATH',$5)`, [proofId, documentId, batchId, submissionId, 'a'.repeat(64)]);
    const page = await readIntegrationJournal(db, issuerRuc, { epoch: barrier.epoch, sequence: barrier.head }, 500, 'SUNAT');
    expect(page.events.map(e => e.ownerKind).sort()).toEqual(['BATCH', 'DOCUMENT']);
    expect(page.events.every(e => e.kind === 'DOCUMENT_RECONCILED')).toBe(true);
    expect(JSON.stringify(page)).not.toMatch(/PRIVATE_|responseCode|description|notes|cdrSha256/);
    await db.query('UPDATE "CdrLog" SET "responseCode"=\'1\' WHERE "id"=$1', [proofId]);
    expect((await storedHead(db)).head).toBe((BigInt(barrier.head) + 4n).toString());
    await rejectStatement(db, 'DELETE FROM "CdrLog" WHERE "id"=$1', [proofId]);
    await rejectStatement(db, 'UPDATE "CdrLog" SET "batchId"=NULL WHERE "id"=$1', [proofId]);
    await rejectStatement(db, 'UPDATE "SunatSubmission" SET "batchId"=NULL WHERE "id"=$1', [submissionId]);
    await rejectStatement(db, 'DELETE FROM "SunatSubmission" WHERE "id"=$1', [submissionId]);
  });
  it('rollback retracts SUNAT owner + counter + event and restore changes invalidate checkpoints', async () => {
    await db.exec('SAVEPOINT owner_write'); await insertFiscal(db);
    const first = await storedHead(db); expect(first.head).toBe('1');
    await db.exec('ROLLBACK TO SAVEPOINT owner_write'); expect((await storedHead(db)).head).toBe('0');
    await insertFiscal(db); expect((await storedHead(db)).head).toBe('1');
    await db.query('DELETE FROM "IntegrationChangeEvent"');
    await db.query('UPDATE "IntegrationChangeState" SET "epoch"=gen_random_uuid(),"head"=0,"floor"=0');
    await expect(readIntegrationJournal(db, issuerRuc, { epoch: first.epoch, sequence: '1' }, 500, 'SUNAT'))
      .rejects.toMatchObject({ status: 410, code: 'CURSOR_EXPIRED' });
    await rejectStatement(db, 'DELETE FROM "FiscalDocument" WHERE "documentId"=$1', [documentId]);
  });
  it('technical trim executes atomically on PostgreSQL, preserves bindings and fails on a missing prefix', async () => {
    const isolated = memoryDatabase();
    try {
      await isolated.exec(fixtureSchema(source('services/sunat-service/prisma/schema.prisma'), ['IssuerProjection', 'FiscalDocument', 'FiscalBatch', 'DocumentArtifact', 'BatchArtifact', 'SunatSubmission', 'CdrLog']));
      await isolated.query('INSERT INTO "IssuerProjection" ("id","ruc","environment") VALUES (1,$1,\'BETA\')', [issuerRuc]);
      await isolated.exec(sunatSQL); await insertFiscal(isolated);
      const repo = new PostgresIntegrationJournal({ connect: async () => ({ query: isolated.query.bind(isolated), release() {} }) }, 'SUNAT');
      const barrier = await repo.read(issuerRuc, null);
      const trimmed = await repo.trim(issuerRuc, barrier.position);
      expect(trimmed).toEqual({ epoch: barrier.epoch, head: '1', floor: '1' });
      await expect(repo.read(issuerRuc, { epoch: barrier.epoch, sequence: '0' })).rejects.toMatchObject({ status: 410 });
      expect((await repo.read(issuerRuc, barrier.position)).events).toEqual([]);
      await expect(isolated.query('DELETE FROM "FiscalDocument" WHERE "documentId"=$1', [documentId])).rejects.toThrow('INTEGRATION_JOURNALED_OWNER_REMOVAL');
      await isolated.query('UPDATE "FiscalDocument" SET "digestValue"=\'PRIVATE_DIGEST\' WHERE "documentId"=$1', [documentId]);
      await isolated.query('DELETE FROM "IntegrationChangeEvent" WHERE "sequence"=2');
      await expect(repo.trim(issuerRuc, { epoch: barrier.epoch, sequence: '2' })).rejects.toMatchObject({ status: 503 });
      expect((await storedHead(isolated)).floor).toBe('1');
    } finally { await isolated.close(); }
  });
});
