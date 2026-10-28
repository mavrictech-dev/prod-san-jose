'use strict';

// Runs ONLY inside the new labelled phase6 container. Every connection points
// to its random internal-network host; schemas/data below are fictional.
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');

let stage = 'explicit-synthetic-guard', checks = 0, admin, prisma;
const pools = new Set();
const connections = new Set();
let Pool, Client, PrismaClient, PrismaPg, BillingCapture, PrismaBillingCapture;
let PostgresIntegrationJournal, readIntegrationJournal, assertIntegrationJournalInstallation, PostgresChangeDeliveryStore, ExportVault;
const host = process.env.FIXTURE_DATABASE_HOST, password = process.env.FIXTURE_DATABASE_PASSWORD;
const databases = new Set(['integration_fixture', 'integration_sunat_fixture', 'integration_delivery_fixture']);
const ruc = '20555555555', otherRuc = '20666666666';
const issueDate = '2026-01-01T12:00:00.000Z';
const owners = [1, 2].map((companyId, i) => ({ companyId, ruc: i ? otherRuc : ruc,
  branch: randomUUID(), point: randomUUID(), counter: randomUUID() }));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pass = () => { checks++; };
const code = (expected, status) => error => error?.code === expected && (status === undefined || error.status === status);
const hash = value => createHash('sha256').update(value).digest('hex');

function config(database) {
  assert.ok(databases.has(database));
  return { host, port: 5432, user: 'integration_fixture', password, database,
    connectionTimeoutMillis: 2000, statement_timeout: 10000, application_name: 'phase6_synthetic_fixture' };
}
function pool(database) {
  const value = new Pool({ ...config(database), max: 8 });
  // Do not let driver diagnostics, connection details or SQL escape to stdout.
  value.on('error', () => { process.exitCode = 1; });
  pools.add(value);
  return value;
}
async function connection(database) {
  const client = new Client(config(database));
  await client.connect();
  connections.add(client);
  return client;
}
async function empty(sql, database) {
  const identity = (await sql.query('SELECT current_database() AS db,current_user AS usr')).rows[0];
  assert.equal(identity.db, database);
  assert.equal(identity.usr, 'integration_fixture');
  const objects = await sql.query(`SELECT count(*)::int AS n FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'`);
  assert.equal(objects.rows[0].n, 0);
  pass();
}
function snapshot(id, number, owner = owners[0], extra = {}) {
  return { companyId: owner.companyId, branchId: owner.branch, environment: 'BETA', documentId: id,
    documentTypeCode: '01', series: 'F001', number: String(number), fullNumber: 'F001-' + number,
    issueDate, currencyCode: 'PEN', issuer: { identityType: '6', identityNumber: owner.ruc, legalName: 'FICTITIOUS PHASE6 ISSUER' },
    customer: { identityType: '0', identityNumber: '0', legalName: 'FICTITIOUS PHASE6 CUSTOMER' },
    lines: [{ lineNumber: 1, description: 'FICTITIOUS PHASE6 ITEM', unitCode: 'NIU', quantity: '1', unitValue: '100',
      unitPriceWithTax: '118', lineExtensionAmount: '100', igvAmount: '18', igvRate: '18', taxAffectationCode: '10' }],
    totals: { taxableAmount: '100', exemptAmount: '0', unaffectedAmount: '0', igvAmount: '18', payableAmount: '118' }, ...extra };
}
async function head(sql, issuer = ruc) {
  return (await sql.query(`SELECT "epoch"::text,"head"::text,"floor"::text FROM "IntegrationChangeState"
    WHERE "issuerRuc"=$1 AND "environment"='BETA'`, [issuer])).rows[0];
}
async function events(sql, issuer = ruc) {
  return (await sql.query(`SELECT "id"::text,"sequence"::text,"ownerId"::text,"ownerKind","eventKind","artifactId"::text
    FROM "IntegrationChangeEvent" e WHERE "issuerRuc"=$1 ORDER BY e."sequence"`, [issuer])).rows;
}
function contiguous(rows, from = 1n) {
  assert.deepEqual(rows.map(row => row.sequence), rows.map((_, index) => (from + BigInt(index)).toString()));
}
async function guard(sql, text, values, expected = 'INTEGRATION_JOURNALED_OWNER_REBINDING') {
  await assert.rejects(sql.query(text, values), error => error?.message === expected);
  pass();
}
async function begin(client, readonly = false) {
  await client.query(readonly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
  return (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
}
function pending(client, text, values) {
  const query = { settled: false };
  // Attach both handlers immediately so failure/cleanup cannot leave an
  // unhandled rejection from the deliberately blocked producer.
  query.done = client.query(text, values).then(result => {
    query.settled = true; return { result };
  }, error => { query.settled = true; return { error }; });
  return query;
}
async function blocking(sql, blockedPid, blockerPid, query) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const row = (await sql.query(`SELECT pg_blocking_pids($1::int) AS blockers,"wait_event_type" AS wait
      FROM pg_stat_activity WHERE pid=$1`, [blockedPid])).rows[0];
    if (row?.wait === 'Lock' && row.blockers.includes(blockerPid)) {
      assert.equal(query.settled, false);
      pass();
      return;
    }
    assert.equal(query.settled, false);
    await pause(20);
  }
  throw new Error('Synthetic producer did not wait on state lock');
}
async function complete(query) {
  const outcome = await query.done;
  if (outcome.error) throw outcome.error;
  assert.equal(outcome.result.rowCount, 1);
}

async function disabledRecovery(sql, journal, owner, issuer, ownerId, missedUpdate, baseline, nextUpdate) {
  const relation = owner === 'BILLING' ? 'Document' : 'FiscalDocument';
  const relations = owner === 'BILLING'
    ? ['CompanySettings', 'Branch', 'EmissionPoint', 'SeriesCounter', 'Document', 'IntegrationChangeState', 'IntegrationChangeEvent', 'IntegrationChangeBinding']
    : ['IssuerProjection', 'FiscalDocument', 'FiscalBatch', 'DocumentArtifact', 'BatchArtifact', 'CdrLog', 'SunatSubmission',
      'IntegrationChangeState', 'IntegrationChangeEvent', 'IntegrationChangeBinding', 'IntegrationChangeArtifactBinding', 'IntegrationChangeProofBinding'];
  stage = owner.toLowerCase() + '-disabled-trigger-empty-head';
  const previous = await journal.read(issuer, null);
  assert.equal(previous.head, '0'); assert.equal(previous.events.length, 0);
  await sql.query(`ALTER TABLE "${relation}" DISABLE TRIGGER "IntegrationChangeDocument"`);
  await assert.rejects(journal.read(issuer, null), code('CHANGE_FEED_NOT_READY', 503));
  await assert.rejects(assertIntegrationJournalInstallation(sql, owner), code('CHANGE_FEED_NOT_READY', 503));
  await missedUpdate();
  assert.equal((await head(sql, issuer)).head, '0'); assert.equal((await events(sql, issuer)).length, 0); pass();
  // Enabling cannot reveal a historical gap when head/events are both zero.
  // Rotate EVERY epoch under exclusive locks before enabling and taking a cut.
  stage = owner.toLowerCase() + '-reenable-rotate-and-new-baseline';
  await sql.query('BEGIN');
  await sql.query('LOCK TABLE ' + relations.map(name => '"' + name + '"').join(',') + ' IN ACCESS EXCLUSIVE MODE');
  await sql.query('DELETE FROM "IntegrationChangeEvent"');
  await sql.query('UPDATE "IntegrationChangeState" SET epoch=gen_random_uuid(),head=0,floor=0');
  await sql.query(`ALTER TABLE "${relation}" ENABLE TRIGGER "IntegrationChangeDocument"`);
  await sql.query('COMMIT');
  await assert.rejects(journal.read(issuer, previous.position), code('CURSOR_EXPIRED', 410));
  const current = await journal.read(issuer, null);
  assert.notEqual(current.epoch, previous.epoch); assert.equal(current.head, '0');
  await baseline(current); pass();
  await nextUpdate();
  const replay = await journal.read(issuer, current.position);
  assert.equal(replay.events.length, 1); assert.equal(replay.events[0].ownerId, ownerId);
  assert.equal(replay.events[0].sequence, '1'); pass();
}

const billingSchema = `
-- The blueprint names Prisma's DocumentType. A fixture-only text domain keeps
-- Document/SeriesCounter as text while allowing its typed binding FK to match.
CREATE DOMAIN "DocumentType" AS text;
CREATE TABLE "CompanySettings" (id integer PRIMARY KEY,ruc char(11) NOT NULL UNIQUE,environment text NOT NULL DEFAULT 'BETA');
CREATE TABLE "Branch" (id uuid PRIMARY KEY,"companyId" integer NOT NULL REFERENCES "CompanySettings"(id),UNIQUE(id,"companyId"));
CREATE TABLE "EmissionPoint" (id uuid PRIMARY KEY,"companyId" integer NOT NULL REFERENCES "CompanySettings"(id),"branchId" uuid,
  UNIQUE(id,"companyId"),FOREIGN KEY("branchId","companyId") REFERENCES "Branch"(id,"companyId"));
-- SeriesCounter intentionally has NO nextNumber: these tests never allocate fiscal numbers.
CREATE TABLE "SeriesCounter" (id uuid PRIMARY KEY,"companyId" integer NOT NULL REFERENCES "CompanySettings"(id),
  "emissionPointId" uuid NOT NULL,"documentType" text NOT NULL,series varchar(4) NOT NULL,UNIQUE(id,"companyId"),
  FOREIGN KEY("emissionPointId","companyId") REFERENCES "EmissionPoint"(id,"companyId"));
-- Prisma enum projections are deliberately text in this minimal business fixture.
CREATE TABLE "Document" (id uuid PRIMARY KEY,"companyId" integer NOT NULL REFERENCES "CompanySettings"(id),
  "emissionPointId" uuid NOT NULL,"seriesCounterId" uuid NOT NULL,type text NOT NULL,series varchar(4) NOT NULL,number bigint NOT NULL,
  "fullNumber" varchar(32) NOT NULL,"issueDate" timestamptz NOT NULL,status text NOT NULL,"sunatStatus" text NOT NULL,
  "sunatResponseCode" varchar(20),"sunatResponseDescription" text,"originSystem" varchar(40),"originId" varchar(120),
  "payableAmount" numeric(18,2) NOT NULL,"updatedAt" timestamptz NOT NULL,"immutableSnapshot" jsonb NOT NULL,
  FOREIGN KEY("emissionPointId","companyId") REFERENCES "EmissionPoint"(id,"companyId"),
  FOREIGN KEY("seriesCounterId","companyId") REFERENCES "SeriesCounter"(id,"companyId"),
  UNIQUE("companyId",type,series,number));`;

async function billingInsert(sql, id, number, owner = owners[0], extra = {}, type = 'INVOICE', status = 'ISSUED') {
  await sql.query(`INSERT INTO "Document" (id,"companyId","emissionPointId","seriesCounterId",type,series,number,"fullNumber",
    "issueDate",status,"sunatStatus","payableAmount","updatedAt","immutableSnapshot")
    VALUES ($1,$2,$3,$4,$5,'F001',$6,$7,$8,$9,'PENDING',118,$8,$10)`,
  [id, owner.companyId, owner.point, owner.counter, type, number, 'F001-' + number, issueDate, status,
    JSON.stringify(snapshot(id, number, owner, extra))]);
}

async function billing(sql, dbPool) {
  stage = 'billing-fresh-schema-and-activation';
  await empty(sql, 'integration_fixture');
  await sql.query(billingSchema);
  for (const owner of owners) {
    await sql.query('INSERT INTO "CompanySettings" VALUES ($1,$2,\'BETA\')', [owner.companyId, owner.ruc]);
    await sql.query('INSERT INTO "Branch" VALUES ($1,$2)', [owner.branch, owner.companyId]);
    await sql.query('INSERT INTO "EmissionPoint" VALUES ($1,$2,$3)', [owner.point, owner.companyId, owner.branch]);
    await sql.query('INSERT INTO "SeriesCounter" VALUES ($1,$2,$3,\'INVOICE\',\'F001\')', [owner.counter, owner.companyId, owner.point]);
  }
  const a = randomUUID(), b = randomUUID(), created = randomUUID(), independent = randomUUID();
  await billingInsert(sql, a, 1); await billingInsert(sql, b, 2);
  await billingInsert(sql, independent, 1, owners[1]);
  await sql.query(readFileSync('/fixture/billing.sql', 'utf8'));
  const journal = new PostgresIntegrationJournal(dbPool, 'BILLING');
  const activation = await journal.read(ruc, null);
  assert.equal(activation.head, '0'); assert.equal(activation.floor, '0');
  assert.deepEqual(activation.events, []); assert.equal((await events(sql)).length, 0); pass();
  await billingInsert(sql, created, 3);
  const initial = await journal.read(ruc, { epoch: activation.epoch, sequence: '0' });
  assert.equal(initial.events.length, 1); assert.equal(initial.events[0].kind, 'DOCUMENT_CREATED');
  assert.equal(initial.events[0].ownerId, created); assert.match(initial.events[0].id, /^BILLING:[a-f0-9-]{36}$/); pass();

  stage = 'billing-counter-commit-order';
  const writerA = await connection('integration_fixture'), writerB = await connection('integration_fixture');
  const aPid = await begin(writerA), bPid = await begin(writerB);
  await writerA.query('UPDATE "Document" SET "sunatStatus"=\'SUBMITTED\' WHERE id=$1', [a]);
  assert.equal((await head(writerA)).head, '2');
  const waiting = pending(writerB, 'UPDATE "Document" SET "sunatStatus"=\'REJECTED\' WHERE id=$1', [b]);
  await blocking(sql, bPid, aPid, waiting);
  const before = await journal.read(ruc, null);
  assert.equal(before.head, '1');
  assert.deepEqual((await sql.query('SELECT "sunatStatus" FROM "Document" WHERE id=ANY($1::uuid[]) ORDER BY id', [[a, b]])).rows.map(row => row.sunatStatus), ['PENDING', 'PENDING']); pass();
  // A different issuer commits while B is actually waiting on A's state row.
  await sql.query('UPDATE "Document" SET "sunatStatus"=\'SUBMITTED\' WHERE id=$1', [independent]);
  assert.equal((await head(sql, otherRuc)).head, '1'); assert.equal((await head(sql)).head, '1');
  assert.equal(waiting.settled, false); pass();
  await writerA.query('COMMIT'); await complete(waiting);
  assert.equal((await head(sql)).head, '2'); assert.equal((await head(writerB)).head, '3'); pass();
  await writerB.query('COMMIT');
  let committed = await events(sql); contiguous(committed);
  assert.deepEqual(committed.slice(1).map(row => [row.ownerId, row.sequence]), [[a, '2'], [b, '3']]); pass();

  stage = 'billing-rollback-counter-no-gaps';
  const aRollbackPid = await begin(writerA), bAfterRollbackPid = await begin(writerB);
  await writerA.query('UPDATE "Document" SET "sunatStatus"=\'REJECTED\' WHERE id=$1', [a]);
  assert.equal((await head(writerA)).head, '4');
  const afterRollback = pending(writerB, 'UPDATE "Document" SET "sunatStatus"=\'ACCEPTED\' WHERE id=$1', [b]);
  await blocking(sql, bAfterRollbackPid, aRollbackPid, afterRollback);
  assert.equal((await journal.read(ruc, null)).head, '3');
  await writerA.query('ROLLBACK'); await complete(afterRollback);
  assert.equal((await head(writerB)).head, '4'); await writerB.query('COMMIT');
  committed = await events(sql); contiguous(committed); assert.equal(committed.length, 4);
  assert.equal(committed.at(-1).ownerId, b); assert.equal((await sql.query('SELECT "sunatStatus" FROM "Document" WHERE id=$1', [a])).rows[0].sunatStatus, 'SUBMITTED'); pass();
  await begin(writerA); await writerA.query('UPDATE "Document" SET status=\'CANCELLED\' WHERE id=$1', [a]);
  await writerA.query('ROLLBACK');
  await sql.query('UPDATE "Document" SET "sunatStatus"="sunatStatus","updatedAt"=clock_timestamp() WHERE id=$1', [a]);
  assert.equal((await head(sql)).head, '4'); assert.equal((await events(sql)).length, 4); pass();

  stage = 'billing-real-capture-mvcc-same-cut';
  const principal = { clientId: randomUUID(), revision: 1, environment: 'BETA', scopes: ['integration:documents:read'],
    grants: [{ issuerRuc: ruc, environment: 'BETA', documentTypes: ['01'], branches: { kind: 'ALL' }, points: { kind: 'ALL' }, series: { kind: 'ALL' } }] };
  const identity = { authenticate: async token => { assert.equal(token, 'fictitious-phase6-token'); return structuredClone(principal); } };
  const query = { issuerRuc: ruc, from: '2026-01-01', to: '2026-01-01', types: '01' };
  let intervened = false, readonlyChecked = false;
  const intercepted = { $transaction: (work, options) => {
    assert.equal(options.isolationLevel, 'RepeatableRead');
    return prisma.$transaction(tx => work(new Proxy(tx, { get(target, key) {
      if (key === '$executeRawUnsafe') return async (...args) => {
        const result = await target.$executeRawUnsafe(...args);
        if (args[0] === 'SET TRANSACTION READ ONLY') {
          assert.equal((await target.$queryRawUnsafe('SHOW transaction_read_only'))[0].transaction_read_only, 'on');
          assert.equal((await target.$queryRawUnsafe('SHOW transaction_isolation'))[0].transaction_isolation, 'repeatable read');
          readonlyChecked = true;
        }
        return result;
      };
      if (key === '$queryRawUnsafe') return async (...args) => {
        const rows = await target.$queryRawUnsafe(...args);
        if (!intervened && String(args[0]).includes('FROM public."IntegrationChangeState"')) {
          intervened = true;
          // Head has already been captured; this later committed update must
          // remain absent from ALL document pages of that same MVCC snapshot.
          await sql.query('UPDATE "Document" SET "sunatStatus"=\'ACCEPTED\' WHERE id=$1', [a]);
        }
        return rows;
      };
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } })), options);
  } };
  const capture = await new BillingCapture(new PrismaBillingCapture(intercepted, true), identity).capture('fictitious-phase6-token', query);
  assert.ok(intervened && readonlyChecked); assert.equal(capture.documents.length, 3);
  assert.deepEqual(capture.changeBarrier, { epoch: activation.epoch, sequence: '4' });
  assert.equal(capture.documents.find(row => row.id === a).state.transport, 'SUBMITTED'); pass();
  const later = await new BillingCapture(new PrismaBillingCapture(prisma, true), identity).capture('fictitious-phase6-token', query);
  assert.equal(later.changeBarrier.sequence, '5'); assert.equal(later.documents.find(row => row.id === a).state.transport, 'ACCEPTED');
  const overlap = await journal.read(ruc, capture.changeBarrier);
  assert.equal(overlap.events.length, 1); assert.equal(overlap.events[0].ownerId, a); assert.equal(overlap.events[0].sequence, '5'); pass();
  // Direct shared reader also participates in a real read-only transaction.
  await begin(writerA, true);
  assert.equal((await readIntegrationJournal(writerA, ruc, capture.changeBarrier, 1, 'BILLING')).position.sequence, '5');
  await writerA.query('COMMIT'); pass();

  stage = 'billing-production-qa-type-exclusions';
  const excluded = [];
  const variants = [
    [{ environment: 'PRODUCTION' }], [{ qa: true }], [{ qaScenario: 'FICTITIOUS' }], [{ qaOnly: true }],
    [{ candidateOnly: true }], [{ profile: 'fictitious-qa-fixture' }], [{ documentTypeCode: '03' }],
    [{ documentTypeCode: '09' }, 'DESPATCH_ADVICE'], [{}, 'INVOICE', 'DRAFT'],
  ];
  for (const [extra, type = 'INVOICE', status = 'ISSUED'] of variants) {
    const id = randomUUID(); excluded.push(id);
    await billingInsert(sql, id, 100 + excluded.length, owners[0], extra, type, status);
    await sql.query('UPDATE "Document" SET "sunatStatus"=\'REJECTED\' WHERE id=$1', [id]);
  }
  assert.equal((await head(sql)).head, '5'); assert.ok((await events(sql)).every(row => !excluded.includes(row.ownerId))); pass();
  // Classification uses the frozen emitted snapshot, not mutable company config.
  await sql.query('UPDATE "CompanySettings" SET environment=\'PRODUCTION\' WHERE id=1');
  await sql.query('UPDATE "Document" SET "sunatResponseCode"=\'FICTITIOUS\' WHERE id=$1', [a]);
  assert.equal((await head(sql)).head, '6');
  await sql.query('UPDATE "CompanySettings" SET environment=\'BETA\' WHERE id=1'); pass();

  stage = 'billing-retention-floor-and-durable-guards';
  const beforeTrim = await journal.read(ruc, null);
  const bindings = (await sql.query('SELECT count(*)::int AS n FROM "IntegrationChangeBinding"')).rows[0].n;
  const retainedId = (await events(sql)).at(-1).id;
  const trimmed = await journal.trim(ruc, { epoch: beforeTrim.epoch, sequence: '5' });
  assert.equal(trimmed.floor, '5'); assert.equal(trimmed.head, '6');
  await assert.rejects(journal.read(ruc, capture.changeBarrier), code('CURSOR_EXPIRED', 410));
  const retained = await journal.read(ruc, { epoch: trimmed.epoch, sequence: '5' });
  assert.equal(retained.events[0].id, 'BILLING:' + retainedId); assert.equal(retained.position.sequence, '6');
  assert.equal((await sql.query('SELECT count(*)::int AS n FROM "IntegrationChangeBinding"')).rows[0].n, bindings); pass();
  await guard(sql, 'DELETE FROM "Document" WHERE id=$1', [a], 'INTEGRATION_JOURNALED_OWNER_REMOVAL');
  await guard(sql, 'UPDATE "Document" SET number=number+1000 WHERE id=$1', [a]);
  await guard(sql, 'UPDATE "Document" SET "immutableSnapshot"=jsonb_set("immutableSnapshot",\'{environment}\',\'"PRODUCTION"\') WHERE id=$1', [a]);
  await guard(sql, 'UPDATE "Document" SET "immutableSnapshot"=jsonb_set("immutableSnapshot",\'{customer,legalName}\',\'"FICTITIOUS MUTATION"\') WHERE id=$1', [a]);
  await guard(sql, 'UPDATE "Document" SET "issueDate"="issueDate"+interval \'1 day\' WHERE id=$1', [a]);
  await guard(sql, 'UPDATE "Document" SET "payableAmount"=119 WHERE id=$1', [a]);
  await guard(sql, 'UPDATE "CompanySettings" SET ruc=$1 WHERE id=1', ['20777777777']);
  await guard(sql, 'UPDATE "EmissionPoint" SET "branchId"=$2 WHERE id=$1', [owners[0].point, owners[1].branch]);
  await guard(sql, 'UPDATE "SeriesCounter" SET series=\'F999\' WHERE id=$1', [owners[0].counter]);
  await guard(sql, 'UPDATE "Branch" SET "companyId"=2 WHERE id=$1', [owners[0].branch]);
  await guard(sql, 'TRUNCATE "Document","IntegrationChangeBinding"', [], 'INTEGRATION_JOURNALED_OWNER_REMOVAL');

  stage = 'billing-restore-epoch-expiry';
  const oldPosition = { epoch: beforeTrim.epoch, sequence: '6' };
  await sql.query('BEGIN');
  await sql.query('LOCK TABLE "CompanySettings","Branch","EmissionPoint","SeriesCounter","Document","IntegrationChangeState","IntegrationChangeEvent","IntegrationChangeBinding" IN ACCESS EXCLUSIVE MODE');
  await sql.query('DELETE FROM "IntegrationChangeEvent"');
  await sql.query('UPDATE "IntegrationChangeState" SET epoch=gen_random_uuid(),head=0,floor=0');
  await sql.query('COMMIT');
  await assert.rejects(journal.read(ruc, oldPosition), code('CURSOR_EXPIRED', 410));
  const restored = await journal.read(ruc, null);
  assert.notEqual(restored.epoch, oldPosition.epoch); assert.equal(restored.head, '0'); assert.equal(restored.floor, '0');
  assert.equal((await sql.query('SELECT count(*)::int AS n FROM "IntegrationChangeBinding"')).rows[0].n, bindings);
  await sql.query('UPDATE "Document" SET "sunatStatus"=\'REJECTED\' WHERE id=$1', [a]);
  const resumed = await journal.read(ruc, restored.position);
  assert.equal(resumed.events[0].sequence, '1'); assert.equal(resumed.events[0].ownerId, a); pass();
  await guard(sql, 'DELETE FROM "Document" WHERE id=$1', [b], 'INTEGRATION_JOURNALED_OWNER_REMOVAL');
  const independentPrincipal = structuredClone(principal);
  independentPrincipal.grants[0].issuerRuc = otherRuc;
  const independentIdentity = { authenticate: async token => {
    assert.equal(token, 'fictitious-phase6-token'); return structuredClone(independentPrincipal);
  } };
  await disabledRecovery(sql, journal, 'BILLING', otherRuc, independent,
    () => sql.query('UPDATE "Document" SET "sunatStatus"=\'ACCEPTED\' WHERE id=$1', [independent]),
    async current => {
      const fresh = await new BillingCapture(new PrismaBillingCapture(prisma, true), independentIdentity)
        .capture('fictitious-phase6-token', { ...query, issuerRuc: otherRuc });
      assert.deepEqual(fresh.changeBarrier, current.position); assert.equal(fresh.documents.length, 1);
      assert.equal(fresh.documents[0].id, independent); assert.equal(fresh.documents[0].state.transport, 'ACCEPTED');
    },
    () => sql.query('UPDATE "Document" SET "sunatStatus"=\'REJECTED\' WHERE id=$1', [independent]));
}

const sunatSchema = `
CREATE TABLE "IssuerProjection" (id integer PRIMARY KEY,ruc char(11) NOT NULL UNIQUE,environment text NOT NULL);
CREATE TABLE "FiscalDocument" ("documentId" uuid PRIMARY KEY,"issuerRuc" char(11) NOT NULL,"documentType" varchar(2) NOT NULL,
  series varchar(4) NOT NULL,number bigint NOT NULL,environment text NOT NULL,status text NOT NULL,"billingEventId" uuid NOT NULL UNIQUE,
  "immutablePayload" jsonb NOT NULL,"digestValue" varchar(128),"acceptedAt" timestamptz,"createdAt" timestamptz DEFAULT now(),"updatedAt" timestamptz DEFAULT now());
CREATE TABLE "FiscalBatch" (id uuid PRIMARY KEY,"issuerRuc" char(11) NOT NULL,"summaryId" uuid NOT NULL UNIQUE,
  identifier varchar(32) NOT NULL,environment text NOT NULL,status text NOT NULL,"billingEventId" uuid NOT NULL UNIQUE,
  "immutablePayload" jsonb NOT NULL,"createdAt" timestamptz DEFAULT now(),"updatedAt" timestamptz DEFAULT now());
CREATE TABLE "DocumentArtifact" (id uuid PRIMARY KEY,"documentId" uuid NOT NULL REFERENCES "FiscalDocument"("documentId"),
  kind text NOT NULL,"storageKey" varchar(500) NOT NULL,"mediaType" varchar(120) NOT NULL,"sizeBytes" bigint NOT NULL,"sha256" char(64) NOT NULL,
  "createdAt" timestamptz DEFAULT now(),UNIQUE("documentId",kind));
CREATE TABLE "BatchArtifact" (id uuid PRIMARY KEY,"batchId" uuid NOT NULL REFERENCES "FiscalBatch"(id),
  kind text NOT NULL,"storageKey" varchar(500) NOT NULL,"mediaType" varchar(120) NOT NULL,"sizeBytes" bigint NOT NULL,"sha256" char(64) NOT NULL,
  "createdAt" timestamptz DEFAULT now(),UNIQUE("batchId",kind));
CREATE TABLE "SunatSubmission" (id uuid PRIMARY KEY,"documentId" uuid REFERENCES "FiscalDocument"("documentId"),
  "batchId" uuid REFERENCES "FiscalBatch"(id),channel text,attempt integer,"idempotencyKey" varchar(160) UNIQUE,ticket varchar(120),result text);
CREATE TABLE "CdrLog" (id uuid PRIMARY KEY,"documentId" uuid REFERENCES "FiscalDocument"("documentId"),"batchId" uuid REFERENCES "FiscalBatch"(id),
  "submissionId" uuid NOT NULL REFERENCES "SunatSubmission"(id),"responseCode" varchar(20) NOT NULL,description text NOT NULL,
  notes text[] NOT NULL,"cdrStorageKey" varchar(500) NOT NULL,"cdrSha256" char(64) NOT NULL,"receivedAt" timestamptz DEFAULT now());`;

async function sunatInsert(sql, id, number, extra = {}, environment = 'BETA', type = '01') {
  await sql.query(`INSERT INTO "FiscalDocument" ("documentId","issuerRuc","documentType",series,number,environment,status,"billingEventId","immutablePayload")
    VALUES ($1,$2,$3,'F001',$4,$5,'QUEUED',$6,$7)`, [id, ruc, type, number, environment, randomUUID(), JSON.stringify(snapshot(id, number, owners[0], extra))]);
}
function batchPayload(member, identifier, extra = {}) {
  const sale = snapshot(member, 1, owners[0], { documentTypeCode: '03', series: 'B001', fullNumber: 'B001-1' });
  return { kind: 'RC', identifier, environment: 'BETA', issuer: sale.issuer,
    input: { kind: 'RC', entries: [{ document: { snapshot: sale }, conditionCode: '1' }] }, ...extra };
}
async function artifact(sql, kind, id, ownerId) {
  const table = kind === 'DOCUMENT' ? 'DocumentArtifact' : 'BatchArtifact';
  const ownerColumn = kind === 'DOCUMENT' ? 'documentId' : 'batchId';
  await sql.query(`INSERT INTO "${table}" (id,"${ownerColumn}",kind,"storageKey","mediaType","sizeBytes",sha256)
    VALUES ($1,$2,'CDR_XML','fictional/phase6.xml','application/xml',32,$3)`, [id, ownerId, 'a'.repeat(64)]);
}

async function sunat(sql, dbPool) {
  stage = 'sunat-fresh-schema-and-activation';
  await empty(sql, 'integration_sunat_fixture');
  stage = 'sunat-minimal-schema'; await sql.query(sunatSchema);
  stage = 'sunat-baseline-owners';
  await sql.query('INSERT INTO "IssuerProjection" VALUES (1,$1,\'BETA\')', [ruc]);
  const document = randomUUID(), newDocument = randomUUID(), batch = randomUUID(), member = randomUUID();
  const documentArtifact = randomUUID(), batchArtifact = randomUUID();
  const identifier = 'RC-20260101-1';
  await sunatInsert(sql, document, 1);
  await sql.query(`INSERT INTO "FiscalBatch" (id,"issuerRuc","summaryId",identifier,environment,status,"billingEventId","immutablePayload")
    VALUES ($1,$2,$3,$4,'BETA','QUEUED',$5,$6)`, [batch, ruc, randomUUID(), identifier, randomUUID(), JSON.stringify(batchPayload(member, identifier))]);
  stage = 'sunat-apply-blueprint'; await sql.query(readFileSync('/fixture/sunat.sql', 'utf8'));
  const journal = new PostgresIntegrationJournal(dbPool, 'SUNAT');
  stage = 'sunat-activation-reader';
  const initial = await journal.read(ruc, null);
  assert.equal(initial.head, '0'); assert.deepEqual(initial.events, []); pass();
  stage = 'sunat-new-issuer-empty-ruc-initializer';
  await sql.query('INSERT INTO "IssuerProjection" (id,ruc,environment) VALUES (2,$1,\'BETA\')', [otherRuc]);
  const emptyIssuer = await journal.read(otherRuc, null);
  assert.equal(emptyIssuer.head, '0'); assert.equal(emptyIssuer.floor, '0'); assert.deepEqual(emptyIssuer.events, []);
  assert.equal((await sql.query('SELECT count(*)::int AS n FROM "FiscalDocument" WHERE "issuerRuc"=$1', [otherRuc])).rows[0].n, 0); pass();
  stage = 'sunat-created-owner'; await sunatInsert(sql, newDocument, 2);
  assert.equal((await head(sql)).head, '1'); pass();

  stage = 'sunat-artifact-batch-atomic-rollback-and-commit';
  const writer = await connection('integration_sunat_fixture');
  async function changes() {
    await writer.query('UPDATE "FiscalDocument" SET status=\'ACCEPTED\' WHERE "documentId"=$1', [document]);
    await artifact(writer, 'DOCUMENT', documentArtifact, document);
    await writer.query('UPDATE "FiscalBatch" SET status=\'ACCEPTED\' WHERE id=$1', [batch]);
    await artifact(writer, 'BATCH', batchArtifact, batch);
  }
  await begin(writer); await changes();
  assert.equal((await head(writer)).head, '5'); assert.equal((await journal.read(ruc, null)).head, '1');
  assert.equal((await sql.query('SELECT count(*)::int AS n FROM "DocumentArtifact"')).rows[0].n, 0);
  assert.equal((await sql.query('SELECT status FROM "FiscalBatch" WHERE id=$1', [batch])).rows[0].status, 'QUEUED'); pass();
  await writer.query('ROLLBACK'); assert.equal((await head(sql)).head, '1');
  await begin(writer); await changes(); await writer.query('COMMIT');
  let page = await journal.read(ruc, { epoch: initial.epoch, sequence: '1' });
  assert.deepEqual(page.events.map(row => [row.ownerKind, row.kind, row.artifactId]), [
    ['DOCUMENT', 'DOCUMENT_STATE_CHANGED', null], ['DOCUMENT', 'ARTIFACT_ADDED', documentArtifact],
    ['BATCH', 'DOCUMENT_STATE_CHANGED', null], ['BATCH', 'ARTIFACT_ADDED', batchArtifact],
  ]);
  assert.ok(page.events.every(row => /^SUNAT:[a-f0-9-]{36}$/.test(row.id))); contiguous(await events(sql)); pass();
  await sql.query('UPDATE "DocumentArtifact" SET "storageKey"=\'fictional/reconciled.xml\',sha256=$2 WHERE id=$1', [documentArtifact, 'b'.repeat(64)]);
  await sql.query('UPDATE "BatchArtifact" SET "sizeBytes"=64 WHERE id=$1', [batchArtifact]);
  await sql.query('UPDATE "FiscalDocument" SET "digestValue"=\'FICTITIOUS_DIGEST\' WHERE "documentId"=$1', [document]);
  await sql.query('UPDATE "FiscalDocument" SET "acceptedAt"=clock_timestamp() WHERE "documentId"=$1', [document]);
  page = await journal.read(ruc, page.position);
  assert.equal(page.events.length, 4); assert.ok(page.events.every(row => row.kind === 'DOCUMENT_RECONCILED')); pass();
  const noopHead = (await head(sql)).head;
  await sql.query('UPDATE "DocumentArtifact" SET sha256=sha256 WHERE id=$1', [documentArtifact]);
  await sql.query('UPDATE "FiscalBatch" SET "updatedAt"=clock_timestamp() WHERE id=$1', [batch]);
  assert.equal((await head(sql)).head, noopHead); pass();

  stage = 'sunat-cdr-proof-and-submission-bindings';
  const submission = randomUUID(), proof = randomUUID();
  await sql.query(`INSERT INTO "SunatSubmission" (id,"documentId","batchId",channel,attempt,"idempotencyKey",result)
    VALUES ($1,$2,$3,'SOAP_SEND_SUMMARY',1,$4,'PENDING')`, [submission, document, batch, 'fictional-' + randomUUID()]);
  const proofBefore = await journal.read(ruc, null);
  await sql.query(`INSERT INTO "CdrLog" (id,"documentId","batchId","submissionId","responseCode",description,notes,"cdrStorageKey","cdrSha256")
    VALUES ($1,$2,$3,$4,'0','FICTITIOUS CDR',ARRAY[]::text[],'fictional/cdr.xml',$5)`, [proof, document, batch, submission, 'c'.repeat(64)]);
  const proofEvents = await journal.read(ruc, proofBefore.position);
  assert.equal(proofEvents.events.length, 2); assert.ok(proofEvents.events.every(row => row.kind === 'DOCUMENT_RECONCILED'));
  assert.deepEqual(new Set(proofEvents.events.map(row => row.ownerId)), new Set([document, batch])); pass();
  await sql.query('UPDATE "CdrLog" SET description=\'FICTITIOUS RECONCILED CDR\' WHERE id=$1', [proof]);
  assert.equal((await journal.read(ruc, proofEvents.position)).events.length, 2); pass();

  stage = 'sunat-production-qa-type-exclusions';
  const beforeExcluded = (await head(sql)).head;
  const excluded = [
    ['production-row', {}, 'PRODUCTION', '01'], ['production-snapshot', { environment: 'PRODUCTION' }, 'BETA', '01'],
    ['qa-only', { qaOnly: true }, 'BETA', '01'], ['qa-marker', { qa: true }, 'BETA', '01'],
    ['unsupported-type', { documentTypeCode: '09' }, 'BETA', '09'], ['type-mismatch', { documentTypeCode: '03' }, 'BETA', '01'],
  ];
  for (let index = 0; index < excluded.length; index++) {
    const [label, extra, environment, type] = excluded[index], id = randomUUID();
    stage = 'sunat-exclude-' + label + '-insert';
    await sunatInsert(sql, id, 100 + index, extra, environment, type);
    stage = 'sunat-exclude-' + label + '-eligibility';
    assert.equal((await sql.query('SELECT public.integration_change_document_ok(d) AS eligible FROM "FiscalDocument" d WHERE "documentId"=$1', [id])).rows[0].eligible, false);
    assert.equal((await head(sql)).head, beforeExcluded);
    stage = 'sunat-exclude-' + label + '-artifact';
    await artifact(sql, 'DOCUMENT', randomUUID(), id);
    assert.equal((await head(sql)).head, beforeExcluded);
    stage = 'sunat-exclude-' + label + '-update';
    await sql.query('UPDATE "FiscalDocument" SET status=\'REJECTED\' WHERE "documentId"=$1', [id]);
    assert.equal((await head(sql)).head, beforeExcluded); pass();
  }
  stage = 'sunat-exclude-qa-batch-insert';
  const qaBatch = randomUUID(), qaIdentifier = 'RC-20260101-2';
  await sql.query(`INSERT INTO "FiscalBatch" (id,"issuerRuc","summaryId",identifier,environment,status,"billingEventId","immutablePayload")
    VALUES ($1,$2,$3,$4,'BETA','QUEUED',$5,$6)`, [qaBatch, ruc, randomUUID(), qaIdentifier, randomUUID(), JSON.stringify(batchPayload(randomUUID(), qaIdentifier, { qaOnly: true }))]);
  assert.equal((await head(sql)).head, beforeExcluded);
  stage = 'sunat-exclude-qa-batch-artifact'; await artifact(sql, 'BATCH', randomUUID(), qaBatch);
  stage = 'sunat-exclusion-head-and-contiguity';
  assert.equal((await head(sql)).head, beforeExcluded); contiguous(await events(sql)); pass();

  stage = 'sunat-retention-and-removal-rebinding-guards';
  const beforeTrim = await journal.read(ruc, null);
  const bindings = (await sql.query('SELECT count(*)::int AS n FROM "IntegrationChangeBinding"')).rows[0].n;
  await journal.trim(ruc, beforeTrim.position);
  assert.equal((await events(sql)).length, 0);
  await assert.rejects(journal.read(ruc, { epoch: initial.epoch, sequence: '0' }), code('CURSOR_EXPIRED', 410));
  assert.equal((await sql.query('SELECT count(*)::int AS n FROM "IntegrationChangeBinding"')).rows[0].n, bindings); pass();
  await guard(sql, 'DELETE FROM "FiscalDocument" WHERE "documentId"=$1', [document], 'INTEGRATION_JOURNALED_OWNER_REMOVAL');
  await guard(sql, 'DELETE FROM "FiscalBatch" WHERE id=$1', [batch], 'INTEGRATION_JOURNALED_OWNER_REMOVAL');
  await guard(sql, 'UPDATE "FiscalDocument" SET environment=\'PRODUCTION\' WHERE "documentId"=$1', [document]);
  await guard(sql, 'UPDATE "FiscalDocument" SET "immutablePayload"=jsonb_set("immutablePayload",\'{customer,legalName}\',\'"FICTITIOUS MUTATION"\') WHERE "documentId"=$1', [document]);
  await guard(sql, 'UPDATE "FiscalDocument" SET "immutablePayload"=jsonb_set("immutablePayload",\'{issueDate}\',\'"2026-01-02T12:00:00.000Z"\') WHERE "documentId"=$1', [document]);
  await guard(sql, 'UPDATE "FiscalDocument" SET "immutablePayload"=jsonb_set("immutablePayload",\'{totals,payableAmount}\',\'"119"\') WHERE "documentId"=$1', [document]);
  await guard(sql, 'UPDATE "FiscalBatch" SET "immutablePayload"=jsonb_set("immutablePayload",\'{input,entries,0,document,snapshot,customer,legalName}\',\'"FICTITIOUS MUTATION"\') WHERE id=$1', [batch]);
  await guard(sql, 'UPDATE "FiscalBatch" SET "immutablePayload"=jsonb_set("immutablePayload",\'{input,entries,0,document,snapshot,documentId}\',to_jsonb($2::text)) WHERE id=$1', [batch, randomUUID()]);
  await guard(sql, 'DELETE FROM "DocumentArtifact" WHERE id=$1', [documentArtifact], 'INTEGRATION_JOURNALED_OWNER_REMOVAL');
  await guard(sql, 'DELETE FROM "BatchArtifact" WHERE id=$1', [batchArtifact], 'INTEGRATION_JOURNALED_OWNER_REMOVAL');
  await guard(sql, 'UPDATE "DocumentArtifact" SET "documentId"=$2 WHERE id=$1', [documentArtifact, newDocument]);
  await guard(sql, 'UPDATE "BatchArtifact" SET "batchId"=$2 WHERE id=$1', [batchArtifact, qaBatch]);
  await guard(sql, 'DELETE FROM "CdrLog" WHERE id=$1', [proof], 'INTEGRATION_JOURNALED_OWNER_REMOVAL');
  await guard(sql, 'UPDATE "CdrLog" SET "documentId"=$2 WHERE id=$1', [proof, newDocument]);
  await guard(sql, 'UPDATE "SunatSubmission" SET "documentId"=$2 WHERE id=$1', [submission, newDocument]);
  await guard(sql, 'DELETE FROM "SunatSubmission" WHERE id=$1', [submission], 'INTEGRATION_JOURNALED_OWNER_REMOVAL');
  await guard(sql, 'TRUNCATE "CdrLog","IntegrationChangeProofBinding"', [], 'INTEGRATION_JOURNALED_OWNER_REMOVAL');
  await sql.query('BEGIN');
  await sql.query('LOCK TABLE "IssuerProjection","FiscalDocument","FiscalBatch","DocumentArtifact","BatchArtifact","CdrLog","SunatSubmission","IntegrationChangeState","IntegrationChangeEvent","IntegrationChangeBinding","IntegrationChangeArtifactBinding","IntegrationChangeProofBinding" IN ACCESS EXCLUSIVE MODE');
  await sql.query('DELETE FROM "IntegrationChangeEvent"');
  await sql.query('UPDATE "IntegrationChangeState" SET epoch=gen_random_uuid(),head=0,floor=0');
  await sql.query('COMMIT');
  await assert.rejects(journal.read(ruc, beforeTrim.position), code('CURSOR_EXPIRED', 410));
  assert.equal((await journal.read(ruc, null)).head, '0'); pass();
  await disabledRecovery(sql, journal, 'SUNAT', ruc, document,
    () => sql.query('UPDATE "FiscalDocument" SET status=\'REJECTED\' WHERE "documentId"=$1', [document]),
    async current => {
      await begin(writer, true);
      const barrier = await readIntegrationJournal(writer, ruc, null, 1, 'SUNAT');
      assert.deepEqual(barrier.position, current.position);
      assert.equal((await writer.query('SELECT status FROM "FiscalDocument" WHERE "documentId"=$1', [document])).rows[0].status, 'REJECTED');
      assert.equal((await writer.query('SELECT status FROM "FiscalBatch" WHERE id=$1', [batch])).rows[0].status, 'ACCEPTED');
      assert.equal((await writer.query('SELECT count(*)::int AS n FROM "DocumentArtifact" WHERE "documentId"=$1', [document])).rows[0].n, 1);
      await writer.query('COMMIT');
    },
    () => sql.query('UPDATE "FiscalDocument" SET status=\'SUBMITTED\' WHERE "documentId"=$1', [document]));
}

async function delivery(sql) {
  stage = 'delivery-readonly-schema-probe';
  await empty(sql, 'integration_delivery_fixture');
  let dbPool = pool('integration_delivery_fixture');
  let store = new PostgresChangeDeliveryStore(dbPool);
  await assert.rejects(store.readySchema(), code('CONSISTENT_READ_UNAVAILABLE', 503));
  await empty(sql, 'integration_delivery_fixture'); // readySchema must not install DDL.
  await sql.query(readFileSync('/fixture/delivery.sql', 'utf8')); await store.readySchema(); pass();
  const key = randomBytes(32), vault = new ExportVault(key), clientId = randomUUID();
  const checkpointKey = hash('FICTITIOUS PHASE6 CHECKPOINT'), aad = 'phase6:' + checkpointKey;
  const plaintext = { marker: 'FICTITIOUS PHASE6 PRIVATE PAGE', checkpoint: { epoch: randomUUID(), sequence: '7' }, events: ['FICTITIOUS EVENT'] };
  const now = (await sql.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime();
  function record(extra = {}) {
    return { id: randomUUID(), clientId, contextSha256: hash('FICTITIOUS CONTEXT'), issuerRuc: ruc, checkpointKey,
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 300000).toISOString(), payload: vault.sealJson(plaintext, aad), ...extra };
  }

  stage = 'delivery-ciphertext-same-key-concurrency';
  const contenderPool = pool('integration_delivery_fixture'), contender = new PostgresChangeDeliveryStore(contenderPool);
  const first = record(), second = record(); assert.notDeepEqual(first.payload, second.payload);
  const winners = await Promise.all([store.put(first), contender.put(second)]);
  assert.equal(winners[0].id, winners[1].id); assert.deepEqual(winners[0].payload, winners[1].payload);
  assert.ok([first.id, second.id].includes(winners[0].id));
  assert.equal((await sql.query('SELECT count(*)::int AS n FROM "IntegrationChangeDelivery"')).rows[0].n, 1);
  const durable = (await sql.query('SELECT payload FROM "IntegrationChangeDelivery"')).rows[0].payload;
  assert.deepEqual(durable, winners[0].payload); assert.equal(durable.includes(Buffer.from(plaintext.marker)), false);
  assert.deepEqual(vault.openJson(durable, aad), plaintext); pass();
  await assert.rejects(store.put(record({ contextSha256: hash('DIFFERENT FICTITIOUS CONTEXT') })), code('IDEMPOTENCY_CONFLICT', 409));
  assert.equal(await store.get(randomUUID(), checkpointKey), null); pass();
  assert.throws(() => vault.openJson(durable, 'different-fictional-aad'), code('INTEGRITY_FAILED', 409));
  assert.throws(() => new ExportVault(randomBytes(32)).openJson(durable, aad), code('INTEGRITY_FAILED', 409)); pass();

  stage = 'delivery-new-pool-restart';
  await contenderPool.end(); pools.delete(contenderPool);
  await dbPool.end(); pools.delete(dbPool);
  dbPool = pool('integration_delivery_fixture'); store = new PostgresChangeDeliveryStore(dbPool);
  await store.readySchema();
  const restarted = await store.get(clientId, checkpointKey);
  assert.equal(restarted.id, winners[0].id); assert.deepEqual(restarted.payload, durable);
  assert.deepEqual(new ExportVault(key).openJson(restarted.payload, aad), plaintext); pass();

  stage = 'delivery-metadata-only-audit-and-empty-poll';
  const audit = { clientId, revision: 1, recordId: restarted.id, operation: 'CHANGES', sha256: null, byteLength: null };
  await store.audit(audit); await store.audit({ ...audit, recordId: randomUUID(), operation: 'EMPTY_POLL' });
  const audits = (await sql.query('SELECT "recordId",operation,sha256,"byteLength" FROM "IntegrationChangeDeliveryAudit" ORDER BY at')).rows;
  assert.equal(audits.length, 2); assert.ok(audits.every(row => row.sha256 === null && row.byteLength === null));
  assert.equal((await sql.query('SELECT count(*)::int AS n FROM "IntegrationChangeDelivery"')).rows[0].n, 1); pass();
  await assert.rejects(store.audit({ ...audit, byteLength: 32 }), code('INVALID_REQUEST', 400));
  await assert.rejects(store.put(record({ payload: Buffer.from('FICTITIOUS UNENCRYPTED PAGE') })), code('INVALID_REQUEST', 400));
  await assert.rejects(store.put(record({ expiresAt: new Date(now + 8 * 86400000).toISOString() })), code('INVALID_REQUEST', 400)); pass();

  stage = 'delivery-expiry-wipe-and-clock-clamp';
  const liveKey = hash('FICTITIOUS LIVE CHECKPOINT'), live = await store.put(record({ checkpointKey: liveKey }));
  await sql.query(`UPDATE "IntegrationChangeDelivery" SET "createdAt"=clock_timestamp()-interval '2 minutes',
    "expiresAt"=clock_timestamp()-interval '1 second' WHERE id=$1`, [restarted.id]);
  await assert.rejects(store.get(clientId, checkpointKey), code('CURSOR_EXPIRED', 410));
  await store.sweep('9999-01-01T00:00:00.000Z');
  const expired = (await sql.query('SELECT payload,"wipedAt" FROM "IntegrationChangeDelivery" WHERE id=$1', [restarted.id])).rows[0];
  assert.equal(expired.payload, null); assert.ok(expired.wipedAt instanceof Date);
  assert.equal((await store.get(clientId, liveKey)).id, live.id);
  await assert.rejects(store.get(clientId, checkpointKey), code('CURSOR_EXPIRED', 410));
  await assert.rejects(store.put(record()), code('CURSOR_EXPIRED', 410)); pass();
  const restartedAgain = new PostgresChangeDeliveryStore(pool('integration_delivery_fixture'));
  await assert.rejects(restartedAgain.get(clientId, checkpointKey), code('CURSOR_EXPIRED', 410)); pass();
  await sql.query(`UPDATE "IntegrationChangeDelivery" SET "createdAt"=clock_timestamp()-interval '8 days 1 minute',
    "expiresAt"=clock_timestamp()-interval '8 days',"wipedAt"=clock_timestamp()-interval '1 minute' WHERE id=$1`, [restarted.id]);
  await store.sweep(new Date().toISOString());
  assert.equal(await store.get(clientId, checkpointKey), null);
  assert.equal((await sql.query('SELECT count(*)::int AS n FROM "IntegrationChangeDeliveryAudit"')).rows[0].n, 2); pass();

  stage = 'delivery-audit-failure-closed';
  await sql.query('DROP TABLE "IntegrationChangeDeliveryAudit"');
  await assert.rejects(store.audit(audit), code('CONSISTENT_READ_UNAVAILABLE', 503));
  assert.equal((await store.get(clientId, liveKey)).id, live.id); pass();
}

(async () => {
  let failed = false;
  try {
    assert.equal(process.argv.length, 3); assert.equal(process.argv[2], '--isolated-synthetic-only');
    assert.match(process.env.FIXTURE_RUN_ID ?? '', /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.equal(host, 'factuez-i6-' + process.env.FIXTURE_RUN_ID.replaceAll('-', '').slice(0, 12) + '-db');
    assert.match(password ?? '', /^[A-Za-z0-9_-]{43}$/);
    stage = 'compiled-interface-preflight';
    const base = '/workspace/services/billing-service';
    stage = 'compiled-pg-preflight';
    ({ Pool, Client } = require(base + '/node_modules/pg'));
    stage = 'compiled-prisma-preflight';
    // Current image uses the generated Prisma client plus its pg adapter.
    // Import software directly, without PrismaService's configuration reader.
    ({ PrismaClient } = require(base + '/dist/generated/prisma/client'));
    ({ PrismaPg } = require(base + '/node_modules/@prisma/adapter-pg'));
    stage = 'compiled-billing-capture-preflight';
    ({ BillingCapture } = require(base + '/dist/integration/capture'));
    stage = 'compiled-billing-repository-preflight';
    ({ PrismaBillingCapture } = require(base + '/dist/integration/capture-repository'));
    stage = 'compiled-journal-preflight';
    ({ PostgresIntegrationJournal, readIntegrationJournal, assertIntegrationJournalInstallation } = require('/workspace/packages/service-access/dist/integration-journal'));
    stage = 'compiled-change-store-preflight';
    ({ PostgresChangeDeliveryStore } = require(base + '/dist/integration-export/change-store'));
    stage = 'compiled-vault-preflight';
    ({ ExportVault } = require(base + '/dist/integration-export/vault'));
    for (const value of [BillingCapture, PrismaBillingCapture, PostgresIntegrationJournal, readIntegrationJournal, assertIntegrationJournalInstallation, PostgresChangeDeliveryStore, ExportVault]) assert.equal(typeof value, 'function');
    for (const method of ['readySchema', 'get', 'put', 'audit', 'sweep']) assert.equal(typeof PostgresChangeDeliveryStore.prototype[method], 'function');
    stage = 'connect-new-tmpfs-postgresql';
    for (let attempt = 0; attempt < 60; attempt++) {
      const client = new Client(config('integration_fixture'));
      try { await client.connect(); admin = client; connections.add(client); break; }
      catch { await client.end().catch(() => {}); await pause(200); }
    }
    assert.ok(admin);
    await empty(admin, 'integration_fixture');
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM pg_database
      WHERE datname NOT IN ('postgres','template0','template1','integration_fixture')`)).rows[0].n, 0);
    await admin.query('CREATE DATABASE integration_sunat_fixture');
    await admin.query('CREATE DATABASE integration_delivery_fixture');
    const connectionString = `postgresql://integration_fixture:${password}@${host}:5432/integration_fixture`;
    // Only a new synthetic URL is supplied; no .env or configuration is read.
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 2000 }), log: [] });
    await prisma.$connect();
    await billing(admin, pool('integration_fixture'));
    await delivery(await connection('integration_delivery_fixture'));
    await sunat(await connection('integration_sunat_fixture'), pool('integration_sunat_fixture'));
    stage = 'phase6-isolated-postgresql';
    if (process.exitCode) throw new Error('Synthetic pool failure');
  } catch (error) {
    // A SQLSTATE and numeric source offset identify fixture incompatibility
    // without exposing a diagnostic message, statement, values or credentials.
    if (/^[0-9A-Z]{5}$/.test(error?.code ?? '')) {
      stage += '-' + error.code.toLowerCase();
      if (/^[1-9][0-9]{0,6}$/.test(error.position ?? '')) stage += '-p' + error.position;
    }
    failed = true; process.exitCode = 1;
  }
  finally {
    // Close/rollback writers before ending pools, including blocked producers.
    for (const client of connections) {
      try { await client.query('ROLLBACK'); } catch { /* No driver diagnostics. */ }
      try { await client.end(); } catch { failed = true; }
    }
    try { await prisma?.$disconnect(); } catch { failed = true; }
    for (const value of pools) { try { await value.end(); } catch { failed = true; } }
    if (failed) process.exitCode = 1;
    console.log(JSON.stringify({ result: failed ? 'FAIL' : 'PASS', stage, checks, realData: false }));
  }
})();
