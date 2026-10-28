'use strict';
// CANDIDATE / ISOLATED SYNTHETIC ONLY. Run after main confirms a fresh build:
// node tests/guide-dispatch-db.e2e.cjs --isolated-synthetic-only
// The UNCHANGED helper owns a NEW labelled --rm tmpfs PostgreSQL container,
// --network none, no ports, no image pull. This runner creates a separate NEW
// fixed database containing ONLY the two dispatch tables. No HTTP or env input.
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {readFileSync} = require('node:fs');
const {createRequire} = require('node:module');
const {resolve} = require('node:path');

if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--isolated-synthetic-only'])) {
  console.error(JSON.stringify({result: 'FAIL', stage: 'GUARD', code: 'ISOLATED_SYNTHETIC_ONLY_REQUIRED'}));
  process.exitCode = 1;
} else {
  let stage = 'PREFLIGHT';
  const passed = [];
  const check = async (label, work) => {stage = label; await work(); passed.push(label);};
  const {withCorrectionDatabase} = require('./helpers/correction-reservation-db.cjs');
  async function run() {
    // helper.local resolves Billing: explicitly resolve the compiled SUNAT owner.
    const local = createRequire(require.resolve('../services/sunat-service/package.json'));
    const {PostgresGuideDispatchStore} = local('./dist/application/guide-dispatch-store');
    const {GuideDispatchCoordinator} = local('./dist/application/guide-dispatch');
    const {appendGuideDispatch, rebuildGuideDispatch, GuideDispatchError} = local('@factuez/sunat-core/dist/guide-dispatch-journal');
    const {fiscalSnapshotSha256: hash} = local('@factuez/sunat-core/dist/fiscal-note');
    const {Pool} = local('pg');
    const {PrismaPg} = local('@prisma/adapter-pg');
    const {PrismaClient} = local('./dist/generated/prisma/client');
    const at = '2026-10-22T05:00:00.000Z';
    const ruc = '20000000001', otherRuc = '20000000010';
    const unavailable = 'GUIDE_DISPATCH_STORE_UNAVAILABLE';
    const identity = 'GUIDE_DISPATCH_IDENTITY_CONFLICT', revision = 'GUIDE_DISPATCH_REVISION_CONFLICT';
    const exact = code => error => error instanceof GuideDispatchError && error.code === code && error.message === code;
    // Fictitious metadata labels only. These are neither reserved nor produced numbers.
    let fixtureLabel = 1;
    const make = (patch = {}) => ({schemaVersion: 'factuez.guide-dispatch-manifest.v1', environment: 'BETA',
      key: {companyId: 1, issuerRuc: ruc, operationId: randomUUID()}, documentId: randomUUID(), guideType: '09',
      fullNumber: 'TSYN-' + fixtureLabel++, ownerRevision: 1, snapshotSha256: 'a'.repeat(64),
      xmlSha256: 'b'.repeat(64), zipSha256: 'c'.repeat(64), source: 'LOCAL_EMULATOR', ...patch});
    const first = m => appendGuideDispatch(m, [], {kind: 'REGISTER', data: {manifestSha256: hash(m)}}, at);
    const nextAttempt = (m, events) => appendGuideDispatch(m, events, {kind: 'ATTEMPT', data: {attemptId: randomUUID()}}, at);
    const rehash = event => {const {sha256, ...unsigned} = event; return {...unsigned, sha256: hash(unsigned)};};
    const concurrent = async jobs => {
      const settled = await Promise.allSettled(jobs);
      const failure = settled.find(r => r.status === 'rejected');
      if (failure) throw failure.reason;
      return settled.map(r => r.value);
    };
    const quote = name => '"' + name.replaceAll('"', '""') + '"';
    async function billingSnapshot(pool) {
      const tables = (await pool.query(`SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public' ORDER BY tablename`)).rows;
      assert.ok(tables.length > 0 && tables.length < 150, 'SYNTHETIC_BILLING_TABLE_BOUND');
      const data = {};
      for (const {tablename} of tables) data[tablename] = (await pool.query(`SELECT COALESCE(jsonb_agg(j ORDER BY j::text),'[]'::jsonb) AS data
        FROM (SELECT to_jsonb(t) AS j FROM ${quote(tablename)} t) rows`)).rows[0].data;
      const columns = (await pool.query(`SELECT table_name,column_name,data_type,is_nullable,column_default
        FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position`)).rows;
      const constraints = (await pool.query(`SELECT c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition
        FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' ORDER BY c.relname,k.conname`)).rows;
      const indexes = (await pool.query(`SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname`)).rows;
      const triggers = (await pool.query(`SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' ORDER BY c.relname,t.tgname`)).rows;
      const sequences = (await pool.query(`SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`)).rows;
      return {data, columns, constraints, indexes, triggers, sequences};
    }

    await withCorrectionDatabase(async ({pool: billingPool}) => {
      assert.equal(billingPool.options.database, 'b2b_corrections_synthetic');
      const billingBefore = await billingSnapshot(billingPool);
      await billingPool.query('CREATE DATABASE guide_dispatch_synthetic');
      // Reuse ONLY the helper's ephemeral Docker-exec stream and random password.
      const pool = new Pool({...billingPool.options, password: billingPool.options.password,
        database: 'guide_dispatch_synthetic', max: 8});
      pool.on('error', () => {});
      const client = new PrismaClient({adapter: new PrismaPg(pool)});
      const store = new PostgresGuideDispatchStore(client);
      const get = m => store.transaction(m.key, tx => tx.read());
      const register = (m, e = first(m)) => store.transaction(m.key, tx => tx.register(m, e));
      const append = (m, e, expected) => store.transaction(m.key, tx => tx.append(e, expected));
      async function direct(work) {
        const connection = await pool.connect();
        try {await connection.query('BEGIN'); const result = await work(connection); await connection.query('COMMIT'); return result;}
        catch (error) {await connection.query('ROLLBACK'); throw error;}
        finally {connection.release();}
      }
      const insertRoot = (c, m, e) => c.query(`INSERT INTO "GuideDispatchStream"
        ("operationId","companyId","issuerRuc","documentId","guideType","fullNumber","manifest","revision","headSha256")
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,1,$8)`,
      [m.key.operationId, m.key.companyId, m.key.issuerRuc, m.documentId, m.guideType, m.fullNumber, JSON.stringify(m), e.sha256]);
      const insertEvent = (c, e) => c.query(`INSERT INTO "GuideDispatchEvent" ("operationId","version","payload","hash")
        VALUES ($1,$2,$3::jsonb,$4)`, [e.operationId, e.version, JSON.stringify(e), e.sha256]);
      const updateHead = (c, e) => c.query(`UPDATE "GuideDispatchStream" SET "revision"=$2,"headSha256"=$3 WHERE "operationId"=$1`,
        [e.operationId, e.version, e.sha256]);
      const ownState = async () => ({
        roots: (await pool.query('SELECT * FROM "GuideDispatchStream" ORDER BY "operationId"')).rows,
        events: (await pool.query('SELECT * FROM "GuideDispatchEvent" ORDER BY "operationId","version"')).rows,
      });
      const unchanged = async work => {const before = await ownState(); await work(); assert.deepEqual(await ownState(), before);};
      const m = make(), e = first(m);
      try {
        await check('01_NEW_DATABASE_ONLY_TWO_TABLES', async () => {
          assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'guide_dispatch_synthetic');
          assert.deepEqual((await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows, []);
          await pool.query(readFileSync(resolve(__dirname, '../services/sunat-service/guide-dispatch-schema.candidate.sql'), 'utf8'));
          assert.deepEqual((await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r => r.tablename),
            ['GuideDispatchEvent', 'GuideDispatchStream']);
          assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM pg_constraint k JOIN pg_class c ON c.oid=k.confrelid
            WHERE c.relname='CompanySettings'`)).rows[0].n, 0);
        });
        await check('02_ATOMIC_REGISTER_REAL_REBUILD', async () => {
          await register(m, e); assert.deepEqual(await get(m), {manifest: m, events: [e]});
          const projection = rebuildGuideDispatch(m, (await get(m)).events);
          assert.equal(projection.state, 'READY'); assert.equal(projection.revision, 1);
          assert.equal((await pool.query('SELECT guide_dispatch_sha($1::jsonb) AS sha', [JSON.stringify(m)])).rows[0].sha, hash(m));
        });
        await check('03_IDEMPOTENT_REGISTER_AFTER_APPEND', async () => {
          const event = nextAttempt(m, [e]); await append(m, event, 1);
          await unchanged(() => register(m, e)); assert.equal((await get(m)).events.length, 2);
        });
        await check('04_GLOBAL_FISCAL_AND_DOCUMENT_IDENTITY', async () => {
          const fiscal = make({fullNumber: 'T001-1'}); await register(fiscal);
          const variants = [make({key: {...fiscal.key}, fullNumber: 'T001-2'}), make({documentId: fiscal.documentId}),
            make({fullNumber: fiscal.fullNumber}),
            make({key: {companyId: 2, issuerRuc: ruc, operationId: randomUUID()}, fullNumber: fiscal.fullNumber})];
          for (const candidate of variants) await unchanged(() => assert.rejects(register(candidate), exact(identity)));
          const other = make({key: {companyId: 2, issuerRuc: otherRuc, operationId: randomUUID()}, fullNumber: 'T001-1'});
          await register(other); assert.equal((await get(other)).manifest.key.issuerRuc, otherRuc);
          const left = make(), right = make({key: {companyId: 2, issuerRuc: ruc, operationId: randomUUID()}, fullNumber: left.fullNumber});
          const outcomes = await Promise.allSettled([register(left), register(right)]);
          assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
          assert.ok(exact(identity)(outcomes.find(r => r.status === 'rejected').reason));
        });
        await check('05_TRIPLE_SCOPE_NO_CROSS_TENANT_READ', async () => {
          for (const key of [{...m.key, companyId: 2}, {...m.key, issuerRuc: otherRuc}, {...m.key, operationId: randomUUID()}]) {
            assert.equal(await store.transaction(key, tx => tx.read()), null);
          }
          const wrong = {...m, key: {...m.key, companyId: 2}};
          await unchanged(() => assert.rejects(register(wrong), exact(identity)));
          await unchanged(() => assert.rejects(store.transaction(m.key, tx => tx.register(wrong, first(wrong))), exact(identity)));
        });
        await check('06_REAL_APPEND_AND_STALE_CAS', async () => {
          const f = make(), initial = first(f), attempt = nextAttempt(f, [initial]); await register(f, initial);
          await append(f, attempt, 1); assert.deepEqual((await get(f)).events, [initial, attempt]);
          await unchanged(() => assert.rejects(append(f, attempt, 1), exact(revision)));
          await unchanged(() => assert.rejects(append(make(), attempt, 1), exact(revision)));
        });
        await check('07_CONCURRENT_REGISTRATION_DEDUP', async () => {
          const f = make(), initial = first(f);
          await concurrent([register(f, initial), register(f, initial), register(f, initial)]);
          assert.deepEqual((await get(f)).events, [initial]);
        });
        await check('08_CONCURRENT_APPEND_EXACTLY_ONE_CAS_WINNER', async () => {
          const f = make(), initial = first(f); await register(f, initial);
          const results = await Promise.allSettled([append(f, nextAttempt(f, [initial]), 1), append(f, nextAttempt(f, [initial]), 1)]);
          assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
          assert.ok(exact(revision)(results.find(r => r.status === 'rejected').reason));
          assert.equal((await get(f)).events.length, 2);
        });
        await check('09_CALLBACK_FAILURE_ROLLS_BACK_REGISTER', async () => {
          const f = make(); await unchanged(() => assert.rejects(store.transaction(f.key, async tx => {
            await tx.register(f, first(f)); throw new Error('SYNTHETIC_CALLBACK_FAILURE');
          }), exact(unavailable))); assert.equal(await get(f), null);
        });
        await check('10_SWALLOWED_REAL_SQL_FAILURE_POISONS_COMMIT', async () => {
          const f = make(), initial = first(f); await register(f, initial);
          // Inject a real PostgreSQL division-by-zero on the append statement;
          // the actual head UPDATE has already succeeded in the same real tx.
          const broken = new PostgresGuideDispatchStore({$transaction: (work, options) => client.$transaction(tx => work({
            $queryRawUnsafe: (sql, ...values) => tx.$queryRawUnsafe(sql, ...values),
            $executeRawUnsafe: (sql, ...values) => /INSERT INTO "GuideDispatchEvent"/.test(sql)
              ? tx.$executeRawUnsafe('SELECT 1/0') : tx.$executeRawUnsafe(sql, ...values),
          }), options)});
          await unchanged(() => assert.rejects(broken.transaction(f.key, async tx => {
            try {await tx.append(nextAttempt(f, [initial]), 1);} catch {}
            return 'SWALLOWED_SQL_MUST_NOT_COMMIT';
          }), exact(unavailable)));
          assert.deepEqual((await get(f)).events, [initial]);
        });
        await check('11_DEFERRED_HEAD_MEMBERSHIP_AT_COMMIT', async () => {
          const f = make(); await unchanged(() => assert.rejects(direct(c => insertRoot(c, f, first(f)))));
          const current = await get(m), event = appendGuideDispatch(m, current.events,
            {kind: 'NO_RESPONSE', data: {attemptId: current.events[1].data.attemptId}}, at);
          await unchanged(() => assert.rejects(direct(c => updateHead(c, event))));
        });
        await check('12_HEAD_BEFORE_APPEND_AND_PREDECESSOR', async () => {
          const f = make(), initial = first(f), attempt = nextAttempt(f, [initial]); await register(f, initial);
          await unchanged(() => assert.rejects(direct(c => insertEvent(c, attempt))));
          const wrong = rehash({...attempt, previousSha256: 'f'.repeat(64)});
          await unchanged(() => assert.rejects(direct(async c => {await updateHead(c, wrong); await insertEvent(c, wrong);}))); 
          await unchanged(() => assert.rejects(direct(c => insertEvent(c, initial))));
        });
        await check('13_APPEND_ONLY_DELETE_TRUNCATE_BLOCKED', async () => {
          for (const sql of [
            'UPDATE "GuideDispatchEvent" SET "hash"="hash"', 'DELETE FROM "GuideDispatchEvent"',
            'DELETE FROM "GuideDispatchStream"', 'TRUNCATE "GuideDispatchEvent" CASCADE',
            'TRUNCATE "GuideDispatchStream" CASCADE', 'TRUNCATE "GuideDispatchStream","GuideDispatchEvent"',
          ]) await unchanged(() => assert.rejects(direct(c => c.query(sql))));
        });
        await check('14_ROOT_IDENTITY_IMMUTABLE_AND_REVISION_PLUS_ONE', async () => {
          for (const clause of ['"companyId"=2', '"issuerRuc"=\'' + otherRuc + '\'', '"documentId"=\'' + randomUUID() + '\'',
            '"operationId"=\'' + randomUUID() + '\'', '"guideType"=\'31\'', '"fullNumber"=\'T001-99\'',
            '"manifest"=jsonb_set("manifest",\'{ownerRevision}\',\'2\')', '"revision"="revision"', '"revision"="revision"+2']) {
            await unchanged(() => assert.rejects(direct(c => c.query('UPDATE "GuideDispatchStream" SET ' + clause + ' WHERE "operationId"=$1', [m.key.operationId]))));
          }
        });
        await check('15_EXACT_BETA_EMULATOR_MANIFEST_AND_SCOPE', async () => {
          for (const patch of [{environment: 'PRODUCTION'}, {environment: undefined}, {source: 'SUNAT'}, {credential: 'SYNTHETIC_FORBIDDEN'}]) {
            const bad = make(patch), unsigned = {kind: 'REGISTER', data: {manifestSha256: hash(bad)}, schemaVersion: 'factuez.guide-dispatch-event.v1',
              operationId: bad.key.operationId, version: 1, previousSha256: null, at};
            await unchanged(() => assert.rejects(direct(c => insertRoot(c, bad, {...unsigned, sha256: hash(unsigned)}))));
            await unchanged(() => assert.rejects(register(bad, {...unsigned, sha256: hash(unsigned)}), exact(unavailable)));
          }
          const f = make(), initial = first(f);
          await unchanged(() => assert.rejects(direct(c => c.query(`INSERT INTO "GuideDispatchStream"
            ("operationId","companyId","issuerRuc","documentId","guideType","fullNumber","manifest","revision","headSha256")
            VALUES ($1,2,$2,$3,$4,$5,$6::jsonb,1,$7)`,
          [f.key.operationId, ruc, f.documentId, f.guideType, f.fullNumber, JSON.stringify(f), initial.sha256]))));
          const carrier = make({guideType: '31', fullNumber: 'V001-1'}); await register(carrier); assert.equal((await get(carrier)).manifest.guideType, '31');
        });
        await check('16_REGISTER_AND_EVENT_EXACT_SHAPE_HASH', async () => {
          const f = make(), initial = first(f);
          for (const bad of [rehash({...initial, extra: 'SYNTHETIC_FORBIDDEN'}), {...initial, sha256: 'f'.repeat(64)},
            rehash({...initial, data: {manifestSha256: 'f'.repeat(64)}}), rehash({...initial, at: '2026-02-30T05:00:00.000Z'})]) {
            await unchanged(() => assert.rejects(direct(async c => {await insertRoot(c, f, bad); await insertEvent(c, bad);}))); 
          }
        });
        await check('17_PHYSICAL_GUARDS_AND_ROLLED_BACK_SEMANTIC_CORRUPTION', async () => {
          const f = make(), initial = first(f); await register(f, initial);
          // Never disable triggers, constraints, roles or isolation, even here.
          await unchanged(() => assert.rejects(pool.query('UPDATE "GuideDispatchStream" SET "headSha256"=$2 WHERE "operationId"=$1',
            [f.key.operationId, 'f'.repeat(64)])));
          await unchanged(() => assert.rejects(pool.query('UPDATE "GuideDispatchEvent" SET "hash"=$2 WHERE "operationId"=$1',
            [f.key.operationId, 'f'.repeat(64)])));
          // SQL enforces structure/hash/linkage. Business transition validation
          // additionally belongs to the real reducer. The deliberately invalid
          // transition exists ONLY inside this explicitly rolled-back transaction.
          const forged = rehash({...initial, kind: 'TICKET', version: 2, previousSha256: initial.sha256,
            data: {attemptId: randomUUID(), ticket: 'SYNTHETIC_INVALID_TRANSITION'}});
          const rollback = new Error('SYNTHETIC_EXPECTED_ROLLBACK');
          await unchanged(() => assert.rejects(direct(async c => {
            await updateHead(c, forged); await insertEvent(c, forged);
            const history = (await c.query('SELECT "payload" FROM "GuideDispatchEvent" WHERE "operationId"=$1 ORDER BY "version"',
              [f.key.operationId])).rows.map(r => r.payload);
            assert.throws(() => rebuildGuideDispatch(f, history), exact('GUIDE_DISPATCH_TRANSITION_FORBIDDEN'));
            throw rollback;
          }), error => error === rollback));
          assert.deepEqual((await get(f)).events, [initial]);
        });
        await check('18_BOUNDED_HISTORY_LIMIT', async () => {
          const f = make(), events = [first(f)]; await register(f, events[0]);
          const attempt = nextAttempt(f, events); events.push(attempt); await append(f, attempt, 1);
          const ticket = appendGuideDispatch(f, events, {kind: 'TICKET', data: {attemptId: attempt.data.attemptId, ticket: 'SYNTHETIC_LIMIT'}}, at);
          events.push(ticket); await append(f, ticket, 2);
          // One bounded transaction; every append re-reads/rebuilds the real history.
          await store.transaction(f.key, async tx => {
            while (events.length < 128) {const e = appendGuideDispatch(f, events, {kind: 'POLL_PENDING', data: {ticket: 'SYNTHETIC_LIMIT'}}, at);
              await tx.append(e, events.length); events.push(e);}
          });
          assert.equal((await get(f)).events.length, 128);
          const overflow = rehash({...events.at(-1), version: 129, previousSha256: events.at(-1).sha256});
          await unchanged(() => assert.rejects(append(f, overflow, 128), exact('GUIDE_DISPATCH_HISTORY_LIMIT')));
        });

        const owner = manifest => ({current: async key => hash(key) === hash(manifest.key) ? structuredClone(manifest) : null});
        const emulator = overrides => ({mode: 'ISOLATED_LOCAL_EMULATOR', submit: async () => ({ticket: 'SYNTHETIC_TICKET'}),
          findTicket: async () => null, poll: async () => ({state: 'PENDING'}), ...overrides});
        const coordinator = (manifest, emu) => new GuideDispatchCoordinator(new PostgresGuideDispatchStore(client), owner(manifest), emu, () => at);
        await check('19_COORDINATOR_COMMITTED_INTENT_AND_ONE_SUBMIT', async () => {
          const f = make(); let submits = 0, observed = null;
          const emu = emulator({submit: async () => {
            submits++;
            // Independent pool connection: uncommitted intent is not visible here.
            const rows = (await pool.query('SELECT "payload" FROM "GuideDispatchEvent" WHERE "operationId"=$1 ORDER BY "version"', [f.key.operationId])).rows;
            observed = rebuildGuideDispatch(f, rows.map(r => r.payload));
            return {ticket: 'SYNTHETIC_COMMITTED_TICKET'};
          }});
          const a = coordinator(f, emu), b = coordinator(f, emu);
          await concurrent([a.dispatch(f.key), b.dispatch(f.key), a.dispatch(f.key)]);
          assert.equal(submits, 1); assert.equal(observed.state, 'INTENT_RECORDED'); assert.equal(observed.revision, 2);
          assert.equal((await b.dispatch(f.key)).state, 'TICKET_RECEIVED'); assert.equal(submits, 1);
          assert.deepEqual((await get(f)).events.map(e => e.kind), ['REGISTER', 'ATTEMPT', 'TICKET']);
        });
        await check('20_COORDINATOR_LOST_REPLY_RESTART_RECONCILE_NO_RESUBMIT', async () => {
          const f = make(); let submits = 0, finds = 0;
          const emu = emulator({submit: async () => {submits++; throw new Error('SYNTHETIC_LOST_REPLY');},
            findTicket: async () => {finds++; return {ticket: 'SYNTHETIC_RECOVERED_TICKET'};}});
          assert.equal((await coordinator(f, emu).dispatch(f.key)).state, 'UNCERTAIN');
          const restarted = coordinator(f, emu);
          assert.equal((await restarted.dispatch(f.key)).state, 'UNCERTAIN'); assert.equal(submits, 1);
          assert.equal((await restarted.reconcile(f.key)).state, 'TICKET_RECEIVED');
          assert.equal((await restarted.dispatch(f.key)).state, 'TICKET_RECEIVED');
          assert.equal(submits, 1); assert.equal(finds, 1);
          assert.deepEqual((await get(f)).events.map(e => e.kind), ['REGISTER', 'ATTEMPT', 'NO_RESPONSE', 'TICKET']);
        });
        await check('21_COORDINATOR_RESULT_IS_PENDING_VERIFICATION_FLAGS_FALSE', async () => {
          const f = make(); let polls = 0;
          const emu = emulator({poll: async () => {polls++; return {state: 'RESULT', receiptSha256: 'd'.repeat(64)};}});
          const c = coordinator(f, emu); await c.dispatch(f.key); const result = await c.poll(f.key);
          assert.equal(result.state, 'RESULT_PENDING_VERIFICATION'); assert.equal(result.candidateOnly, true);
          for (const flag of ['transmissionAuthorized', 'authorizedForTransfer', 'officialCdrVerified']) assert.equal(result[flag], false);
          assert.deepEqual(await coordinator(f, emu).poll(f.key), result); assert.equal(polls, 1);
          assert.equal(rebuildGuideDispatch(f, (await get(f)).events).state, 'RESULT_PENDING_VERIFICATION');
        });
        await check('22_BILLING_TABLES_SCHEMA_SEQUENCES_UNCHANGED', async () => {
          assert.deepEqual(await billingSnapshot(billingPool), billingBefore);
          assert.deepEqual((await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r => r.tablename),
            ['GuideDispatchEvent', 'GuideDispatchStream']);
        });
      } finally {
        await client.$disconnect(); if (!pool.ended) await pool.end();
      }
    });
  }
  run().then(() => console.log(JSON.stringify({result: 'PASS', candidateOnly: true, groups: passed.length, passed})))
    .catch(error => {
      // No raw driver diagnostics, SQL, connection details or callback messages.
      const code = typeof error?.code === 'string' && /^(GUIDE_DISPATCH_[A-Z_]+|ERR_ASSERTION|[0-9A-Z]{5})$/.test(error.code)
        ? error.code : 'ISOLATED_GUIDE_DISPATCH_FAILURE';
      console.error(JSON.stringify({result: 'FAIL', stage, code, passed})); process.exitCode = 1;
    });
}
