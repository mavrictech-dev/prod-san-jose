'use strict';

// Run only after the main integrator confirms that the candidate dist is ready.
// The unchanged helper creates a new labelled, network-none, tmpfs PostgreSQL.
// No caller-supplied database, path, RUC, credentials, official artifacts or URL.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--isolated-synthetic-only'])) {
  console.error(JSON.stringify({ result: 'FAIL', stage: 'GUARD', code: 'ISOLATED_SYNTHETIC_ONLY_REQUIRED' }));
  process.exitCode = 1;
} else {
  const { withCorrectionDatabase } = require('./helpers/correction-reservation-db.cjs');
  let stage = 'PREFLIGHT';
  const passed = [];
  const check = async (label, work) => { stage = label; await work(); passed.push(label); };

  withCorrectionDatabase(async ({ client, pool, local }) => {
    const { B2bGuides } = local('./dist/b2b/guide-drafts');
    const { PostgresB2bGuideStore } = local('./dist/b2b/guide-store');
    const { PrismaGuideDraftCatalogue } = local('./dist/b2b/guide-catalogue');
    const { B2bSecurityError } = local('@factuez/contracts/b2b-security');
    const { fiscalSnapshotSha256 } = local('@factuez/sunat-core/dist/fiscal-note');
    const ruc = '20000000001', now = () => '2026-10-21T16:00:00.000Z';
    const branch = randomUUID(), point = randomUUID(), anchor = randomUUID();
    const guide09 = randomUUID(), guide31 = randomUUID(), clientId = randomUUID();
    const otherPoint = randomUUID(), otherAnchor = randomUUID(), otherGuide = randomUUID();
    const token = 'synthetic-guide-db-token';
    await pool.query(readFileSync(resolve(__dirname, '../services/billing-service/b2b-guide-drafts-schema.candidate.sql'), 'utf8'));
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'b2b_corrections_synthetic');
    await client.companySettings.create({ data: { id: 1, ruc, legalName: 'SYNTHETIC GUIDE ONLY',
      companyType: 'SYNTHETIC', economicActivities: [], taxAddress: 'SYNTHETIC ADDRESS', ubigeo: '150101',
      contactEmails: [], environment: 'BETA' } });
    await client.branch.create({ data: { id: branch, companyId: 1, code: 'GUIDE-TEST', name: 'SYNTHETIC GUIDE ONLY' } });
    for (const [id, code] of [[point, '0001'], [otherPoint, '0002']]) {
      await client.emissionPoint.create({ data: { id, companyId: 1, branchId: branch, code, name: 'SYNTHETIC POINT' } });
    }
    for (const [id, pointId, label] of [[anchor, point, 'F001'], [otherAnchor, otherPoint, 'F002']]) {
      await client.seriesCounter.create({ data: { id, companyId: 1, emissionPointId: pointId,
        documentType: 'INVOICE', series: label, nextNumber: 1n } });
    }
    for (const [id, pointId, type, label] of [[guide09, point, '09', 'T001'], [guide31, point, '31', 'V001'],
      [otherGuide, otherPoint, '09', 'T002']]) {
      await pool.query('INSERT INTO "B2bGuideDraftSeries" ("id","companyId","pointId","guideType","label","purpose") VALUES ($1,1,$2,$3,$4,\'DRAFT_ONLY\')',
        [id, pointId, type, label]);
    }
    const binding = type => ({ anchor: { issuerId: 1, issuerRuc: ruc, environment: 'BETA', branchId: branch,
      pointId: point, seriesId: anchor, documentType: '01' }, guideSeriesId: type === '31' ? guide31 : guide09, guideType: type });
    const b09 = binding('09'), b31 = binding('31');
    const bOther = { ...structuredClone(b09), anchor: { ...b09.anchor, pointId: otherPoint, seriesId: otherAnchor }, guideSeriesId: otherGuide };
    const body = () => ({ issueDate: '2026-10-21T15:30:00.000Z', transferDate: '2026-10-21', reasonCode: '04',
      origin: { ubigeo: '150101', address: 'SYNTHETIC ORIGIN', establishmentCode: '0001' },
      destination: { ubigeo: '150102', address: 'SYNTHETIC DESTINATION', establishmentCode: '0002' },
      sender: { ruc, legalName: 'SYNTHETIC SENDER' }, recipient: { ruc, legalName: 'SYNTHETIC RECIPIENT' },
      grossWeight: '1.250', weightUnit: 'KGM',
      transport: { mode: '01', carrier: { ruc, legalName: 'SYNTHETIC CARRIER', mtcRegistration: 'SYNTHETIC-MTC' } },
      items: [{ code: 'SYNTHETIC-1', description: 'SYNTHETIC ITEM', quantity: '2.000001', unitCode: 'NIU' }],
      references: [{ type: '09', issuerRuc: ruc, series: 'T001', number: '1' }], regulatedGoods: false });

    // Explicit fake authority, NOT real Identity, token verification or official access.
    const control = { revoked: false, clientId, clientRevision: 1, grantRevision: 1, subject: randomUUID(), calls: 0 };
    const authority = { current: async (_token, kind, b) => {
      control.calls++;
      if (control.revoked) throw new B2bSecurityError(401, 'SYNTHETIC_REVOKED');
      const subjectId = kind === 'USER' ? control.subject : null;
      return { actor: { userId: subjectId, scope: { kind: 'ASSIGNED', branchIds: [b.anchor.branchId],
        emissionPointIds: [b.anchor.pointId], series: [b.anchor.seriesId, b.guideSeriesId] },
        b2b: { kind, clientId: control.clientId, revision: control.clientRevision, subjectId,
          userAuthRevision: kind === 'USER' ? 1 : null } }, grantRevision: control.grantRevision,
      clientRevision: control.clientRevision };
    } };
    const catalogue = new PrismaGuideDraftCatalogue(client);
    const make = (db = client, cat = catalogue, auth = authority) => new B2bGuides(new PostgresB2bGuideStore(db), auth, cat, now);
    const core = make();
    let serial = 0;
    const key = () => 'synthetic_guide_db_key_' + String(++serial).padStart(8, '0');
    const create = (b = b09, k = key(), c = core, kind = 'SERVICE', payload = body()) =>
      c.command(token, kind, b, 'CREATE', null, k, undefined, payload);
    const command = (action, d, payload = {}, c = core, k = key(), kind = 'SERVICE') =>
      c.command(token, kind, d.binding, action, d.id, k, d.revision, payload);
    const read = (d, c = core, kind = 'SERVICE') => c.read(token, kind, d.binding, d.id);
    const exact = code => error => error?.code === code;
    const draftCounts = async () => (await pool.query('SELECT (SELECT count(*)::int FROM "B2bGuideDraft") AS drafts, (SELECT count(*)::int FROM "B2bGuideDraftOperation") AS operations')).rows[0];
    const fixtureSnapshot = async () => (await pool.query(`SELECT
      (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t."id"),'[]'::jsonb) FROM "Document" t) AS documents,
      (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t."id"),'[]'::jsonb) FROM "SeriesCounter" t) AS counters,
      (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t."id"),'[]'::jsonb) FROM "OutboxEvent" t) AS outbox,
      (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t."id"),'[]'::jsonb) FROM "DailySummary" t) AS summaries`)).rows[0];
    const fiscalBefore = await fixtureSnapshot();
    const flags = d => {
      assert.equal(d.candidateOnly, true); assert.equal(d.fiscalExecutionEnabled, false);
      assert.equal(d.transmissionAuthorized, false);
      if (Object.hasOwn(d, 'authorizedForTransfer')) {
        assert.equal(d.authorizedForTransfer, false); assert.equal(d.referenceVerification, 'NOT_VERIFIED');
      }
      assert.equal(Object.hasOwn(d, 'xml'), false); assert.equal(Object.hasOwn(d, 'cdr'), false);
      assert.equal(Object.hasOwn(d, 'number'), false);
    };

    // Executes real SQL inside the real store transaction, never a fake store.
    // A thrown synthetic commit fault occurs before PostgreSQL COMMIT.
    function hookedDatabase({ afterWrite, beforeWork, commitFailure = false } = {}) {
      return { $transaction: (work, options) => client.$transaction(async tx => {
        if (beforeWork) await beforeWork(tx);
        const wrapped = {
          $queryRawUnsafe: (...args) => tx.$queryRawUnsafe(...args),
          $executeRawUnsafe: async (...args) => {
            const n = await tx.$executeRawUnsafe(...args);
            if (afterWrite) await afterWrite(tx, args[0]);
            return n;
          },
        };
        const result = await work(wrapped);
        if (commitFailure) throw new Error('SYNTHETIC_PRECOMMIT_FAILURE');
        return result;
      }, options) };
    }
    // Corruption is visible ONLY inside this single new-DB transaction. DDL and
    // row mutations always roll back. No repair/update of the healthy row occurs.
    async function withRolledBackCorruption(prepare, work) {
      const marker = new Error('SYNTHETIC_CORRUPTION_ROLLBACK');
      let invoked = false, completed = false;
      const db = { $transaction: (_ignored, options) => client.$transaction(async tx => {
        await prepare(tx);
        const inside = make({ $transaction: (callback) => callback(tx) }, new PrismaGuideDraftCatalogue(tx));
        invoked = true; await work(inside, tx); completed = true; throw marker;
      }, options) };
      await assert.rejects(new PostgresB2bGuideStore(db).transaction(async () => {}), exact('GUIDE_STORE_UNAVAILABLE'));
      assert.equal(invoked, true);
      // An assertion failure inside work must NEVER be mistaken for the deliberate rollback.
      assert.equal(completed, true);
    }

    let first, createKey, firstResult, carrier;
    await check('REAL_PG_09_CREATE_READ_OPERATION_SERVICE_NULL_HUMAN', async () => {
      createKey = key(); firstResult = await create(b09, createKey); first = firstResult.response;
      flags(first); flags(firstResult.operation); assert.equal(firstResult.replayed, false);
      assert.equal(first.state, 'DRAFT'); assert.equal(first.revision, '"v1"');
      assert.deepEqual(await read(first), first);
      assert.deepEqual(await core.operation(token, 'SERVICE', b09, firstResult.operation.operationId), firstResult.operation);
      const op = (await pool.query('SELECT "payload" FROM "B2bGuideDraftOperation" WHERE "id"=$1', [firstResult.operation.operationId])).rows[0].payload;
      assert.deepEqual(op.actor, { kind: 'SERVICE', clientId, revision: 1, subjectId: null, userAuthRevision: null });
      assert.equal(op.grantRevision, 1); assert.equal(JSON.stringify(op).includes(token), false);
    });
    await check('REAL_PG_31_UNVERIFIED_REFERENCE_NO_XML_OR_NUMBER', async () => {
      carrier = (await create(b31)).response; flags(carrier);
      assert.equal(carrier.body.references[0].series, 'T001'); assert.equal(carrier.body.references[0].number, '1');
      assert.deepEqual(await read(carrier), carrier);
      assert.deepEqual(await fixtureSnapshot(), fiscalBefore);
    });
    await check('EXACT_REPLAY_AND_RESTART_USE_DURABLE_RECEIPT', async () => {
      const before = await draftCounts();
      const result = await create(b09, createKey, make());
      assert.deepEqual(result, { ...firstResult, replayed: true });
      assert.deepEqual(await draftCounts(), before);
    });
    await check('SAME_KEY_DIFFERENT_BODY_OR_BINDING_CONFLICT_NO_WRITES', async () => {
      const before = await draftCounts();
      await assert.rejects(create(b09, createKey, core, 'SERVICE', { ...body(), grossWeight: '9.000' }), exact('IDEMPOTENCY_CONFLICT'));
      await assert.rejects(create(b31, createKey), exact('IDEMPOTENCY_CONFLICT'));
      assert.deepEqual(await draftCounts(), before);
    });
    await check('CONCURRENT_IDENTICAL_CREATES_BOTH_SUCCEED_ONE_REPLAY', async () => {
      const before = await draftCounts(), k = key();
      // Deliberately Promise.all: a rejected duplicate is NOT an acceptable result.
      const results = await Promise.all([create(b09, k, make()), create(b09, k, make())]);
      assert.deepEqual(results.map(r => r.replayed).sort(), [false, true]);
      assert.deepEqual(results[0].response, results[1].response);
      assert.deepEqual(results[0].operation, results[1].operation);
      const after = await draftCounts(); assert.equal(after.drafts, before.drafts + 1); assert.equal(after.operations, before.operations + 1);
    });
    await check('PATCH_READ_CAS_AND_PATCH_REPLAY_RETURN_ORIGINAL_VERSION', async () => {
      const k = key(), result = await command('PATCH', first, { grossWeight: '2.500' }, core, k);
      assert.equal(result.response.revision, '"v2"'); assert.equal(result.response.body.grossWeight, '2.500');
      assert.deepEqual(await read(result.response), result.response);
      const next = await command('PATCH', result.response, { grossWeight: '3.500' });
      assert.deepEqual(await command('PATCH', first, { grossWeight: '2.500' }, make(), k), { ...result, replayed: true });
      assert.equal((await read(first)).revision, next.response.revision);
      first = next.response;
    });
    await check('CONCURRENT_DISTINCT_PATCHES_CAS_EXACTLY_ONE_WINNER', async () => {
      const d = (await create()).response, before = await draftCounts();
      const results = await Promise.allSettled([command('PATCH', d, { grossWeight: '4.000' }, make()), command('PATCH', d, { grossWeight: '5.000' }, make())]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      const failed = results.filter(r => r.status === 'rejected'); assert.equal(failed.length, 1); assert.equal(failed[0].reason.code, 'REVISION_CONFLICT');
      assert.equal((await read(d)).revision, '"v2"');
      const after = await draftCounts(); assert.equal(after.drafts, before.drafts); assert.equal(after.operations, before.operations + 1);
    });
    await check('READY_FREEZES_PAYLOAD_AND_CANCEL_PRESERVES_IT', async () => {
      const frozen = (await command('READY', carrier)).response; flags(frozen); assert.equal(frozen.state, 'READY');
      const before = await draftCounts();
      await assert.rejects(command('PATCH', frozen, { grossWeight: '5.000' }), exact('GUIDE_DRAFT_IMMUTABLE'));
      await assert.rejects(command('READY', frozen), exact('GUIDE_DRAFT_IMMUTABLE'));
      assert.deepEqual(await draftCounts(), before);
      const cancelled = (await command('CANCEL', frozen)).response;
      assert.equal(cancelled.state, 'CANCELLED'); assert.deepEqual(cancelled.body, frozen.body); assert.equal(cancelled.bodySha256, frozen.bodySha256);
      await assert.rejects(command('PATCH', cancelled, {}), exact('GUIDE_DRAFT_IMMUTABLE'));
      await assert.rejects(command('CANCEL', cancelled), exact('GUIDE_DRAFT_IMMUTABLE'));
    });
    await check('DRAFT_CANCEL_AND_HISTORICAL_CREATE_REPLAY_NO_RESURRECTION', async () => {
      const k = key(), created = await create(b09, k);
      const cancelled = (await command('CANCEL', created.response)).response;
      const before = await draftCounts(), replay = await create(b09, k, make());
      assert.equal(replay.replayed, true); assert.deepEqual(replay.response, created.response);
      assert.equal((await read(cancelled)).state, 'CANCELLED'); assert.deepEqual(await draftCounts(), before);
    });
    await check('USER_LINKED_SUBJECT_AUDIT_AND_SERVICE_USER_ISOLATION', async () => {
      const result = await create(b09, key(), core, 'USER');
      const op = (await pool.query('SELECT "payload" FROM "B2bGuideDraftOperation" WHERE "id"=$1', [result.operation.operationId])).rows[0].payload;
      assert.equal(op.actor.kind, 'USER'); assert.equal(op.actor.subjectId, control.subject); assert.equal(op.actor.userAuthRevision, 1);
      assert.deepEqual(await read(result.response, core, 'USER'), result.response);
      await assert.rejects(read(result.response), exact('GUIDE_DRAFT_NOT_FOUND'));
      await assert.rejects(read(first, core, 'USER'), exact('GUIDE_DRAFT_NOT_FOUND'));
    });
    await check('OTHER_CLIENT_CANNOT_READ_LIST_OPERATION_OR_MODIFY', async () => {
      const before = await draftCounts(); control.clientId = randomUUID();
      try {
        await assert.rejects(read(first), exact('GUIDE_DRAFT_NOT_FOUND'));
        await assert.rejects(command('PATCH', first, { grossWeight: '9.000' }), exact('GUIDE_DRAFT_NOT_FOUND'));
        await assert.rejects(core.operation(token, 'SERVICE', b09, firstResult.operation.operationId), exact('GUIDE_OPERATION_NOT_FOUND'));
        assert.deepEqual((await core.list(token, 'SERVICE', b09)).items, []);
      } finally { control.clientId = clientId; }
      assert.deepEqual(await draftCounts(), before);
    });
    await check('OTHER_AUTHORIZED_POINT_CANNOT_READ_OR_MUTATE_THIS_DRAFT', async () => {
      const before = await draftCounts();
      await assert.rejects(core.read(token, 'SERVICE', bOther, first.id), exact('GUIDE_DRAFT_NOT_FOUND'));
      await assert.rejects(core.command(token, 'SERVICE', bOther, 'PATCH', first.id, key(), first.revision, {}), exact('GUIDE_DRAFT_NOT_FOUND'));
      await assert.rejects(core.operation(token, 'SERVICE', bOther, firstResult.operation.operationId), exact('GUIDE_DRAFT_NOT_FOUND'));
      assert.deepEqual(await draftCounts(), before);
    });
    await check('CROSS_RUC_AND_MISMATCHED_REGISTRY_PARENT_DENIED', async () => {
      const before = await draftCounts();
      for (const b of [{ ...b09, anchor: { ...b09.anchor, issuerRuc: '20000000010' } },
        { ...b09, guideSeriesId: otherGuide }, { ...b09, guideSeriesId: guide31 }]) {
        await assert.rejects(core.read(token, 'SERVICE', b, first.id), exact('GUIDE_CONTEXT_NOT_FOUND'));
      }
      assert.deepEqual(await draftCounts(), before);
    });
    await check('REVOKE_AFTER_SQL_INSERT_ROLLS_BACK_DRAFT_AND_RECEIPT', async () => {
      const before = await draftCounts(); let wrote = false;
      const broken = make(hookedDatabase({ afterWrite: async (_tx, sql) => { if (sql.startsWith('INSERT INTO "B2bGuideDraftOperation"')) { wrote = true; control.revoked = true; } } }));
      try { await assert.rejects(create(b09, key(), broken), exact('SYNTHETIC_REVOKED')); }
      finally { control.revoked = false; }
      assert.equal(wrote, true); assert.deepEqual(await draftCounts(), before);
    });
    await check('GRANT_REVISION_CHANGED_AFTER_PATCH_ROLLS_BACK_PAYLOAD', async () => {
      const d = (await create()).response, before = await draftCounts(); let wrote = false;
      const broken = make(hookedDatabase({ afterWrite: async (_tx, sql) => { if (sql.startsWith('UPDATE "B2bGuideDraft"')) { wrote = true; control.grantRevision = 2; } } }));
      try { await assert.rejects(command('PATCH', d, { grossWeight: '8.000' }, broken), exact('GUIDE_AUTHORITY_CHANGED')); }
      finally { control.grantRevision = 1; }
      assert.equal(wrote, true); assert.deepEqual(await read(d), d); assert.deepEqual(await draftCounts(), before);
    });
    await check('REGISTRY_CHANGED_AFTER_WRITES_ROLLS_BACK_ALL_OWNER_WRITES', async () => {
      const before = await draftCounts(), registryBefore = (await pool.query('SELECT * FROM "B2bGuideDraftSeries" WHERE "id"=$1', [guide09])).rows;
      // The catalogue reads the SAME tx snapshot here; fake a new metadata revision
      // only by changing actual SQL registry data in that owner transaction.
      let activeTx, wrote = false;
      const db = hookedDatabase({ beforeWork: async tx => { activeTx = tx; }, afterWrite: async (tx, sql) => {
        if (!wrote && sql.startsWith('INSERT INTO "B2bGuideDraftOperation"')) {
          wrote = true; await tx.$executeRawUnsafe('UPDATE "B2bGuideDraftSeries" SET "revision"="revision"+1 WHERE "id"=$1::uuid', guide09);
        }
      } });
      const txCatalogue = { resolve: b => new PrismaGuideDraftCatalogue(activeTx ?? client).resolve(b) };
      await assert.rejects(create(b09, key(), make(db, txCatalogue)), exact('GUIDE_AUTHORITY_CHANGED'));
      activeTx = null; assert.equal(wrote, true); assert.deepEqual(await draftCounts(), before);
      assert.deepEqual((await pool.query('SELECT * FROM "B2bGuideDraftSeries" WHERE "id"=$1', [guide09])).rows, registryBefore);
    });
    await check('PRECOMMIT_FAILURE_ROLLS_BACK_SUCCESSFUL_CALLBACK', async () => {
      const before = await draftCounts(); let writes = 0;
      await assert.rejects(create(b09, key(), make(hookedDatabase({ commitFailure: true, afterWrite: async () => { writes++; } }))), exact('GUIDE_STORE_UNAVAILABLE'));
      assert.equal(writes, 2); assert.deepEqual(await draftCounts(), before);
    });
    await check('PRECOMMIT_FAILURE_ON_PATCH_KEEPS_OLD_HASH_AND_RECEIPTS', async () => {
      const d = (await create()).response, before = await draftCounts();
      await assert.rejects(command('PATCH', d, { grossWeight: '6.500' }, make(hookedDatabase({ commitFailure: true }))), exact('GUIDE_STORE_UNAVAILABLE'));
      assert.deepEqual(await read(d), d); assert.deepEqual(await draftCounts(), before);
    });
    await check('LIST_FILTERS_OWNER_POINT_AND_TYPE_BEFORE_LIMIT_KEYSET', async () => {
      // Insert synthetic distractors with deliberately earlier UUIDs through the
      // real owner store, so a global LIMIT followed by app filtering must fail.
      const template = (await pool.query('SELECT * FROM "B2bGuideDraft" WHERE "id"=$1', [first.id])).rows[0];
      const store = new PostgresB2bGuideStore(client);
      for (const [n, foreignClient, foreignBinding] of [[1, randomUUID(), b09], [2, clientId, bOther], [3, clientId, b31]]) {
        const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
        await store.transaction(tx => tx.create({ ...template, id, clientId: foreignClient, binding: foreignBinding,
          body: body(), bodySha256: fiscalSnapshotSha256(body()), state: 'DRAFT', revision: 1, createdAt: now(), updatedAt: now() }));
      }
      const expected = (await pool.query('SELECT "id" FROM "B2bGuideDraft" WHERE "clientId"=$1 AND "actorKey"=$2 AND "binding"=$3::jsonb ORDER BY "id"',
        [clientId, 'SERVICE:-', JSON.stringify(b09)])).rows.map(r => r.id);
      assert.ok(expected.length > 2);
      let after = null; const seen = [];
      do {
        const result = await core.list(token, 'SERVICE', b09, 1, after);
        assert.equal(result.items.length, 1); flags(result.items[0]); seen.push(result.items[0].id);
        assert.equal(result.page.hasMore, seen.length < expected.length);
        after = result.page.nextAfter;
      } while (after !== null);
      assert.deepEqual(seen, expected);
    });
    await check('SQL_OPERATION_AUDIT_APPEND_ONLY_UPDATE_AND_DELETE_DENIED', async () => {
      const before = await draftCounts();
      await assert.rejects(pool.query('UPDATE "B2bGuideDraftOperation" SET "payload"="payload" || \'{"grantRevision":99}\'::jsonb WHERE "id"=$1', [firstResult.operation.operationId]));
      await assert.rejects(pool.query('DELETE FROM "B2bGuideDraftOperation" WHERE "id"=$1', [firstResult.operation.operationId]));
      assert.deepEqual(await draftCounts(), before);
    });
    await check('SQL_GUIDE_DELETE_AND_UNVERSIONED_WRITES_DENIED', async () => {
      const before = await read(first), counts = await draftCounts();
      await assert.rejects(pool.query('DELETE FROM "B2bGuideDraft" WHERE "id"=$1', [first.id]));
      await assert.rejects(pool.query('UPDATE "B2bGuideDraft" SET "state"=\'CANCELLED\' WHERE "id"=$1', [first.id]));
      assert.deepEqual(await read(first), before); assert.deepEqual(await draftCounts(), counts);
    });
    await check('SQL_GUIDE_OWNER_IDS_BINDING_AND_CREATION_METADATA_IMMUTABLE', async () => {
      const before = await read(first);
      const rewrites = [ ['"clientId"=$2::uuid', randomUUID()], ['"actorKey"=$2', 'USER:synthetic'],
        ['"guideSeriesId"=$2::uuid', guide31], ['"binding"=$2::jsonb', JSON.stringify(b31)],
        ['"createdAt"=$2::timestamptz', '2026-10-20T16:00:00.000Z'], ['"id"=$2::uuid', randomUUID()] ];
      for (const [field, value] of rewrites) await assert.rejects(pool.query('UPDATE "B2bGuideDraft" SET ' + field + ',"revision"="revision"+1 WHERE "id"=$1', [first.id, value]));
      assert.deepEqual(await read(first), before);
    });
    await check('REGISTRY_IDENTITY_TYPE_LABEL_PURPOSE_IMMUTABLE_NO_DELETE', async () => {
      for (const [field, value] of [['"id"=$2::uuid', randomUUID()], ['"pointId"=$2::uuid', otherPoint],
        ['"label"=$2', 'T099'], ['"guideType"=$2', '31'], ['"purpose"=$2', 'FISCAL']]) {
        await assert.rejects(pool.query('UPDATE "B2bGuideDraftSeries" SET ' + field + ',"revision"="revision"+1 WHERE "id"=$1', [guide09, value]));
      }
      await assert.rejects(pool.query('DELETE FROM "B2bGuideDraftSeries" WHERE "id"=$1', [guide09]));
    });
    await check('DISABLED_REGISTRY_AND_PARENTS_BLOCK_READ_WRITE_REPLAY', async () => {
      const counts = await draftCounts();
      const toggles = [
        tx => tx.$executeRawUnsafe('UPDATE "B2bGuideDraftSeries" SET "active"=false,"revision"="revision"+1 WHERE "id"=$1::uuid', guide09),
        tx => tx.$executeRawUnsafe('UPDATE "CompanySettings" SET "active"=false WHERE "id"=1'),
        tx => tx.$executeRawUnsafe('UPDATE "Branch" SET "active"=false WHERE "id"=$1::uuid', branch),
        tx => tx.$executeRawUnsafe('UPDATE "EmissionPoint" SET "active"=false WHERE "id"=$1::uuid', point),
        tx => tx.$executeRawUnsafe('UPDATE "SeriesCounter" SET "active"=false WHERE "id"=$1::uuid', anchor),
      ];
      for (const toggle of toggles) {
        await withRolledBackCorruption(toggle, async inside => {
          await assert.rejects(read(first, inside), exact('GUIDE_CONTEXT_NOT_FOUND'));
          await assert.rejects(create(b09, createKey, inside), exact('GUIDE_CONTEXT_NOT_FOUND'));
          await assert.rejects(create(b09, key(), inside), exact('GUIDE_CONTEXT_NOT_FOUND'));
        });
      }
      assert.deepEqual(await draftCounts(), counts);
    });
    await check('BODY_HASH_TAMPER_DETECTED_WITHOUT_REPAIR', async () => {
      const healthy = await read(first), counts = await draftCounts();
      await withRolledBackCorruption(async tx => {
        // Trigger permits versioned body changes; deliberately keep the OLD hash.
        await tx.$executeRawUnsafe('UPDATE "B2bGuideDraft" SET "body"=jsonb_set("body",\'{grossWeight}\',\'"9.999"\'),"revision"="revision"+1 WHERE "id"=$1::uuid', first.id);
      }, async (inside, tx) => {
        const before = await tx.$queryRawUnsafe('SELECT "body","bodySha256","revision" FROM "B2bGuideDraft" WHERE "id"=$1::uuid', first.id);
        await assert.rejects(read(first, inside), exact('GUIDE_DRAFT_INCONSISTENT'));
        assert.deepEqual(await tx.$queryRawUnsafe('SELECT "body","bodySha256","revision" FROM "B2bGuideDraft" WHERE "id"=$1::uuid', first.id), before);
      });
      assert.deepEqual(await read(first), healthy); assert.deepEqual(await draftCounts(), counts);
    });
    await check('PHYSICAL_GUIDE_SERIES_BINDING_TAMPER_DETECTED_NO_REPAIR', async () => {
      const healthy = await read(first);
      await withRolledBackCorruption(async tx => {
        await tx.$executeRawUnsafe('ALTER TABLE "B2bGuideDraft" DISABLE TRIGGER USER');
        await tx.$executeRawUnsafe('UPDATE "B2bGuideDraft" SET "guideSeriesId"=$2::uuid WHERE "id"=$1::uuid', first.id, guide31);
      }, async (inside, tx) => {
        const before = await tx.$queryRawUnsafe('SELECT "guideSeriesId","binding" FROM "B2bGuideDraft" WHERE "id"=$1::uuid', first.id);
        await assert.rejects(read(first, inside), exact('GUIDE_DRAFT_INCONSISTENT'));
        assert.deepEqual(await tx.$queryRawUnsafe('SELECT "guideSeriesId","binding" FROM "B2bGuideDraft" WHERE "id"=$1::uuid', first.id), before);
      });
      assert.deepEqual(await read(first), healthy);
    });
    await check('RECEIPT_RESPONSE_PAYLOAD_HASH_TAMPER_REPLAY_FAILS_NO_REPAIR', async () => {
      const before = await draftCounts();
      await withRolledBackCorruption(async tx => {
        await tx.$executeRawUnsafe('ALTER TABLE "B2bGuideDraftOperation" DISABLE TRIGGER USER');
        await tx.$executeRawUnsafe('UPDATE "B2bGuideDraftOperation" SET "payload"=jsonb_set("payload",\'{response,body,grossWeight}\',\'"9.999"\') WHERE "id"=$1::uuid', firstResult.operation.operationId);
      }, async (inside, tx) => {
        const receipt = await tx.$queryRawUnsafe('SELECT "payload" FROM "B2bGuideDraftOperation" WHERE "id"=$1::uuid', firstResult.operation.operationId);
        await assert.rejects(create(b09, createKey, inside), exact('GUIDE_OPERATION_INCONSISTENT'));
        assert.deepEqual(await tx.$queryRawUnsafe('SELECT "payload" FROM "B2bGuideDraftOperation" WHERE "id"=$1::uuid', firstResult.operation.operationId), receipt);
      });
      assert.deepEqual(await draftCounts(), before);
      assert.equal((await create(b09, createKey, make())).replayed, true);
    });
    await check('RECEIPT_METADATA_STATE_REVISION_ACTION_TAMPER_REPLAY_AND_READ_FAIL_NO_REPAIR', async () => {
      const counts = await draftCounts();
      const healthy = (await pool.query('SELECT "payload" FROM "B2bGuideDraftOperation" WHERE "id"=$1', [firstResult.operation.operationId])).rows;
      // Independent mutations: a malformed state must not mask a missing
      // revision/action check. All three leave the valid business-body hash intact.
      for (const [path, value] of [
        ['{response,state}', 'CANCELLED'],
        ['{response,revision}', '"v2"'],
        ['{action}', 'CANCEL'],
      ]) {
        await withRolledBackCorruption(async tx => {
          await tx.$executeRawUnsafe('ALTER TABLE "B2bGuideDraftOperation" DISABLE TRIGGER USER');
          await tx.$executeRawUnsafe('UPDATE "B2bGuideDraftOperation" SET "payload"=jsonb_set("payload",$2::text[],$3::jsonb) WHERE "id"=$1::uuid',
            firstResult.operation.operationId, path, JSON.stringify(value));
        }, async (inside, tx) => {
          const receipt = await tx.$queryRawUnsafe('SELECT "payload" FROM "B2bGuideDraftOperation" WHERE "id"=$1::uuid', firstResult.operation.operationId);
          assert.notDeepEqual(receipt, healthy);
          assert.equal(receipt[0].payload.response.bodySha256, healthy[0].payload.response.bodySha256);
          await assert.rejects(create(b09, createKey, inside), exact('GUIDE_OPERATION_INCONSISTENT'));
          assert.deepEqual(await tx.$queryRawUnsafe('SELECT "payload" FROM "B2bGuideDraftOperation" WHERE "id"=$1::uuid', firstResult.operation.operationId), receipt);
          await assert.rejects(inside.operation(token, 'SERVICE', b09, firstResult.operation.operationId), exact('GUIDE_OPERATION_INCONSISTENT'));
          assert.deepEqual(await tx.$queryRawUnsafe('SELECT "payload" FROM "B2bGuideDraftOperation" WHERE "id"=$1::uuid', firstResult.operation.operationId), receipt);
        });
        assert.deepEqual((await pool.query('SELECT "payload" FROM "B2bGuideDraftOperation" WHERE "id"=$1', [firstResult.operation.operationId])).rows, healthy);
        assert.deepEqual(await draftCounts(), counts);
      }
      assert.equal((await create(b09, createKey, make())).replayed, true);
      assert.deepEqual(await core.operation(token, 'SERVICE', b09, firstResult.operation.operationId), firstResult.operation);
      assert.deepEqual(await draftCounts(), counts);
    });
    await check('INVALID_31_REFERENCE_OR_FOREIGN_CARRIER_NO_DRAFT_NO_NUMBER', async () => {
      const before = await draftCounts();
      await assert.rejects(create(b31, key(), core, 'SERVICE', { ...body(), references: [] }), exact('INVALID_GUIDE_BODY'));
      const payload = body(); payload.transport.carrier.ruc = '20000000010';
      await assert.rejects(create(b31, key(), core, 'SERVICE', payload), exact('INVALID_GUIDE_BODY'));
      assert.deepEqual(await draftCounts(), before);
    });
    await check('ALL_FISCAL_TABLE_ROWS_COUNTS_VALUES_UNCHANGED_AND_DRAFT_ONLY', async () => {
      assert.deepEqual(await fixtureSnapshot(), fiscalBefore);
      assert.equal(await client.document.count(), 0); assert.equal(await client.outboxEvent.count(), 0);
      assert.equal(await client.dailySummary.count(), 0); assert.equal(await client.seriesCounter.count(), 2);
      const registry = (await pool.query('SELECT "id","purpose" FROM "B2bGuideDraftSeries" ORDER BY "id"')).rows;
      assert.equal(registry.length, 3); assert.ok(registry.every(r => r.purpose === 'DRAFT_ONLY'));
      const ops = (await pool.query('SELECT "payload" FROM "B2bGuideDraftOperation"')).rows;
      assert.ok(ops.length > 10);
      for (const { payload } of ops) { flags(payload.response); assert.equal(payload.grantRevision, 1); }
    });
  }).then(() => console.log(JSON.stringify({ result: 'PASS', groups: passed.length, passed,
    authority: 'EXPLICIT_FAKE_NOT_IDENTITY', referenceVerification: 'NOT_VERIFIED',
    officialNetwork: false, realData: false, qaRuntimeChanged: false,
    fiscalExecutionEnabled: false, transmissionAuthorized: false })))
    .catch(() => { console.error(JSON.stringify({ result: 'FAIL', stage,
      code: 'ISOLATED_GUIDE_DRAFT_CHECK_FAILED', officialNetwork: false, realData: false, qaRuntimeChanged: false })); process.exitCode = 1; });
}
