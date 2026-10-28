'use strict';

// RUN ONLY AFTER MAIN EXPLICITLY AUTHORIZES THE DB REHEARSAL AND CONFIRMS BUILD:
// node tests/b2b-guide-goods-db.e2e.cjs --isolated-synthetic-only
// The unchanged helper owns a NEW labelled --rm PostgreSQL, tmpfs data,
// network=none, no ports, no image pull. No runtime or existing DB is contacted.
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--isolated-synthetic-only'])) {
  console.error(JSON.stringify({ result: 'FAIL', stage: 'GUARD', code: 'ISOLATED_SYNTHETIC_ONLY_REQUIRED' }));
  process.exitCode = 1;
} else {
  const { withCorrectionDatabase } = require('./helpers/correction-reservation-db.cjs');
  let stage = 'PREFLIGHT';
  const passed = [];
  const check = async (name, work) => { stage = name; await work(); passed.push(name); };
  withCorrectionDatabase(async ({ client, pool, local }) => {
    // Use the real core and store from main's confirmed build, never rebuild here.
    const { GuideGoods, guideGoodsProductSha256 } = local('./dist/b2b/guide-goods');
    const { PostgresGuideGoodsStore } = local('./dist/b2b/guide-goods-store');
    const { fiscalSnapshotSha256 } = local('@factuez/sunat-core/dist/fiscal-note');
    const { validateGuideReferenceCatalogue } = local('@factuez/sunat-core/dist/fiscal-guide-catalogues');
    const { B2bSecurityError } = local('@factuez/contracts/b2b-security');
    const store = new PostgresGuideGoodsStore(client), at = '2026-10-22T05:00:00.000Z';
    const actorId = randomUUID(), productId = randomUUID(), unmappedId = randomUUID();
    const token = 'synthetic-goods-fake-admin', peer = 'synthetic-goods-local-peer';
    const sha = value => createHash('sha256').update(value).digest('hex');
    const context = () => ({ requestId: randomUUID(), peer });
    const proof = { id: actorId, authRevision: 1, stepUpVerified: true,
      scope: 'GLOBAL', permissions: ['setup.manage', 'series.manage'] };
    const authority = { verify: async supplied => { assert.equal(supplied, token); return structuredClone(proof); } };
    const core = new GuideGoods(store, authority, () => at);
    const exact = (code, status = 409) => error => error?.code === code && error?.status === status;
    const unavailable = exact('GUIDE_GOODS_STORE_UNAVAILABLE', 503);
    const policyTables = ['B2bGuideGoodsHead', 'B2bGuideGoodsVersion', 'B2bGuideGoodsAudit'];
    const ownTables = [...policyTables, 'B2bGuideGoodsRate'];
    const quote = name => '"' + name.replaceAll('"', '""') + '"';
    const rows = async table => (await pool.query(`SELECT COALESCE(jsonb_agg(j ORDER BY j::text),'[]'::jsonb) AS rows
      FROM (SELECT to_jsonb(t) AS j FROM ${quote(table)} t) entries`)).rows[0].rows;
    const policyState = async () => Object.fromEntries(await Promise.all(policyTables.map(async t => [t, await rows(t)])));
    async function unchanged(work) { const before = await policyState(); await work(); assert.deepEqual(await policyState(), before); }
    async function protectedState() {
      const names = (await pool.query(`SELECT tablename FROM pg_catalog.pg_tables
        WHERE schemaname='public' ORDER BY tablename`)).rows.map(r => r.tablename);
      assert.ok(names.length > 0 && names.length <= 128, 'SYNTHETIC_TABLE_BOUND');
      const excluded = [...ownTables, 'CompanySettings', 'FuelProduct'];
      return Object.fromEntries(await Promise.all(names.filter(n => !excluded.includes(n)).map(async n => [n, await rows(n)])));
    }
    async function direct(work) {
      const connection = await pool.connect();
      try { await connection.query('BEGIN'); const result = await work(connection); await connection.query('COMMIT'); return result; }
      catch (error) { await connection.query('ROLLBACK'); throw error; }
      finally { connection.release(); }
    }
    function syntheticRuc(id) {
      const base = '200000000' + String(id - 1), weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
      const digit = 11 - weights.reduce((sum, w, i) => sum + Number(base[i]) * w, 0) % 11;
      return base + (digit === 10 ? 0 : digit === 11 ? 1 : digit);
    }
    const catalogueUnsigned = { schemaVersion: 'factuez.guide-reference-catalogue.v1', version: 'synthetic-goods-v1',
      sourceUrl: 'https://www.sunat.gob.pe/synthetic-reference-only', sourceSha256: sha('synthetic-reference-bytes'),
      units: ['NIU'], weightUnits: ['KGM'], ubigeos: ['150101', '150102'], referenceStatus: 'LOCAL_REFERENCE_NOT_OFFICIAL' };
    const catalogue = validateGuideReferenceCatalogue({ ...catalogueUnsigned, sha256: fiscalSnapshotSha256(catalogueUnsigned) });
    const product = { id: productId, sku: 'SYNTHETIC-GOODS-1', description: 'BIEN FICTICIO', category: 'FICTICIO',
      unitCode: 'NIU', sunatProductCode: null, active: true, updatedAt: at };
    const entry = (classification = 'NON_REGULATED') => ({ productId, productSha256: guideGoodsProductSha256(product),
      classification, rationale: 'Declaracion local ficticia atribuible' });
    const current = companyId => store.transaction(companyId, tx => tx.head(companyId));
    const input = revision => ({ expectedRevision: revision, expectedIssuerRevision: 1, catalogue, entries: [entry()] });
    async function replace(overrides = {}, registry = core, companyId = 1) {
      const head = await current(companyId);
      return registry.replace(token, companyId, { ...input(head?.revision ?? 0), ...overrides }, context());
    }
    const audit = (revision, overrides = {}) => ({ id: randomUUID(), requestId: randomUUID(), peerSha256: sha(peer),
      companyId: 1, revision, actorId, action: 'REPLACE', at, ...overrides });
    function next(snapshot, overrides = {}) {
      const { sha256: _old, ...unsigned } = snapshot;
      const changed = { ...unsigned, revision: snapshot.revision + 1, ...overrides };
      return { ...changed, sha256: fiscalSnapshotSha256(changed) };
    }
    async function directAppend(connection, payload) {
      assert.equal((await connection.query(`UPDATE "B2bGuideGoodsHead" SET "revision"="revision"+1 WHERE "companyId"=1`)).rowCount, 1);
      const head = (await connection.query(`SELECT "revision" FROM "B2bGuideGoodsHead" WHERE "companyId"=1`)).rows[0];
      await connection.query(`INSERT INTO "B2bGuideGoodsVersion" ("companyId","revision","payload") VALUES (1,$1,$2::jsonb)`,
        [head.revision, JSON.stringify(payload)]);
    }
    const binding = { anchor: { issuerId: 1, issuerRuc: syntheticRuc(1), environment: 'BETA', branchId: randomUUID(),
      pointId: randomUUID(), seriesId: randomUUID(), documentType: '01' }, guideSeriesId: randomUUID(), guideType: '09' };
    // Internal goods guard composition only; these IDs do not create series or reserve numbers.
    const body = { reasonCode: '04', sender: { ruc: syntheticRuc(1) }, recipient: { ruc: syntheticRuc(1) },
      origin: { ubigeo: '150101' }, destination: { ubigeo: '150102' }, transport: { mode: '02' },
      weightUnit: 'KGM', regulatedGoods: false, references: [],
      items: [{ code: product.sku, description: product.description, unitCode: product.unitCode }] };
    const flags = value => {
      assert.equal(value.candidateOnly, true); assert.equal(value.officialValidation, false);
      assert.equal(value.fiscalExecutionEnabled, false); assert.equal(value.transmissionAuthorized, false);
    };
    let protectedBefore, firstSnapshot;

    await check('01_NEW_SYNTHETIC_COMPANY_PRODUCT_MASTERS_ONLY_AND_CANDIDATE_DDL', async () => {
      await pool.query(readFileSync(resolve(__dirname, '../services/billing-service/b2b-guide-goods-schema.candidate.sql'), 'utf8'));
      for (let id = 1; id <= 4; id++) await client.companySettings.create({ data: { id, ruc: syntheticRuc(id),
        legalName: 'EMPRESA FICTICIA ' + id, companyType: 'FICTICIO', economicActivities: [],
        taxAddress: 'DOMICILIO FICTICIO', ubigeo: '150101', contactEmails: [], configVersion: 1,
        active: id !== 3, environment: id === 4 ? 'PRODUCTION' : 'BETA' } });
      for (const p of [product, { ...product, id: unmappedId, sku: 'SYNTHETIC-UNMAPPED' }])
        await client.fuelProduct.create({ data: { ...p, updatedAt: new Date(p.updatedAt), taxAffectationCode: '10' } });
      for (const table of ownTables) assert.deepEqual(await rows(table), []);
      protectedBefore = await protectedState();
    });

    await check('02_CORE_EMPTY_READ_AUDIT_IS_ATOMIC_AND_ATTRIBUTABLE', async () => {
      const ctx = context(), value = await core.read(token, 1, ctx); flags(value);
      assert.equal(value.revision, 0); assert.equal(value.snapshot, null); assert.equal(value.stale, false);
      const state = await policyState(); assert.deepEqual(state.B2bGuideGoodsHead, []);
      assert.deepEqual(state.B2bGuideGoodsVersion, []); assert.equal(state.B2bGuideGoodsAudit.length, 1);
      assert.deepEqual(state.B2bGuideGoodsAudit.map(a => [a.requestId, a.peerSha256, a.actorId, a.action, a.revision]),
        [[ctx.requestId, sha(peer), actorId, 'READ', 0]]);
    });

    await check('03_CORE_POLICY_CAS_VERSION_AUDIT_AND_HASH_COMMIT_TOGETHER', async () => {
      const value = await replace(); flags(value); firstSnapshot = value.snapshot;
      assert.equal(value.revision, 1); assert.deepEqual(firstSnapshot.entries, [entry()]);
      assert.deepEqual(await current(1), firstSnapshot);
      const { sha256, ...unsigned } = firstSnapshot; assert.equal(sha256, fiscalSnapshotSha256(unsigned));
      const state = await policyState(); assert.equal(state.B2bGuideGoodsVersion.length, 1);
      assert.equal(state.B2bGuideGoodsAudit.filter(a => a.action === 'REPLACE' && a.revision === 1).length, 1);
      assert.deepEqual(await store.transaction(1, tx => tx.products([productId])), [product]);
    });

    await check('04_CORE_RECHECKS_EXACT_BETA_ACTIVE_COMPANY_AND_ISOLATES_POLICIES', async () => {
      const value = await core.read(token, 2, context()); assert.equal(value.snapshot, null); assert.equal(value.revision, 0);
      for (const id of [3, 4, 999]) await unchanged(async () => {
        await assert.rejects(core.read(token, id, context()), exact('GUIDE_GOODS_ISSUER_NOT_FOUND', 404));
        await assert.rejects(core.replace(token, id, input(0), context()), exact('GUIDE_GOODS_ISSUER_NOT_FOUND', 404));
      });
      for (const change of [{ active: false }, { environment: 'PRODUCTION' }]) {
        await client.companySettings.update({ where: { id: 1 }, data: change });
        try { await unchanged(async () => {
          await assert.rejects(core.read(token, 1, context()), exact('GUIDE_GOODS_ISSUER_NOT_FOUND', 404));
          await assert.rejects(replace(), exact('GUIDE_GOODS_ISSUER_NOT_FOUND', 404));
          await assert.rejects(core.assertLocalGoods(binding, body), exact('GUIDE_GOODS_ISSUER_NOT_FOUND', 404));
        }); } finally { await client.companySettings.update({ where: { id: 1 }, data: { active: true, environment: 'BETA' } }); }
      }
      await replace({}, core, 2); assert.equal((await current(2)).companyId, 2);
      assert.deepEqual(await current(1), firstSnapshot);
    });

    await check('05_STORE_PORTS_CANNOT_ESCAPE_LOCKED_COMPANY', async () => {
      for (const work of [tx => tx.company(2), tx => tx.head(2),
        tx => tx.save({ ...next(firstSnapshot), companyId: 2 }, 1), tx => tx.audit(audit(1, { companyId: 2 }))])
        await unchanged(() => assert.rejects(store.transaction(1, work), exact('GUIDE_GOODS_POLICY_INCONSISTENT')));
    });

    await check('06_CORE_PRESERVES_EXPLICIT_CLASSIFICATION_AND_COMPOSES_GOODS_GUARD', async () => {
      for (const classification of ['REGULATED', 'UNKNOWN']) {
        const value = await replace({ entries: [entry(classification)] });
        assert.equal(value.snapshot.entries[0].classification, classification);
        await unchanged(() => assert.rejects(core.assertLocalGoods(binding, body), exact('GUIDE_GOODS_CLASSIFICATION_NOT_ENABLED')));
      }
      await replace(); await (await core.assertLocalGoods(binding, body)).fresh();
      const other = { ...body, items: [{ ...body.items[0], code: 'SYNTHETIC-UNMAPPED' }] };
      await unchanged(() => assert.rejects(core.assertLocalGoods(binding, other), exact('GUIDE_GOODS_ITEM_MISMATCH')));
    });

    await check('07_CURRENT_PRODUCT_METADATA_AND_ACTIVE_FLAG_INVALIDATE_CLASSIFICATION', async () => {
      for (const change of [{ sku: 'SYNTHETIC-CHANGED' }, { description: 'OTRO BIEN FICTICIO' }, { category: 'OTRA' },
        { unitCode: 'LTR' }, { sunatProductCode: '99999999' }, { active: false }, { updatedAt: new Date('2026-10-22T05:00:01.000Z') }]) {
        const guard = await core.assertLocalGoods(binding, body);
        await client.fuelProduct.update({ where: { id: productId }, data: { ...change, updatedAt: change.updatedAt ?? new Date(at) } });
        try {
          assert.equal((await core.read(token, 1, context())).stale, true);
          await unchanged(async () => {
            await assert.rejects(replace(), exact('GUIDE_GOODS_PRODUCT_CHANGED'));
            await assert.rejects(guard.fresh(), exact('GUIDE_GOODS_PRODUCT_CHANGED'));
            if (change.active === false) {
              const [inactive] = await store.transaction(1, tx => tx.products([productId]));
              await assert.rejects(replace({ entries: [{ ...entry(), productSha256: guideGoodsProductSha256(inactive) }] }),
                exact('GUIDE_GOODS_PRODUCT_CHANGED'));
            }
          });
        } finally { const { id: _id, ...restore } = product;
          await client.fuelProduct.update({ where: { id: productId }, data: { ...restore, updatedAt: new Date(at) } }); }
      }
      assert.equal((await core.read(token, 1, context())).stale, false);
    });

    await check('08_ISSUER_REVISION_IS_RECHECKED_BY_CORE_AND_GUARD', async () => {
      await client.companySettings.update({ where: { id: 1 }, data: { configVersion: 2 } });
      try {
        assert.equal((await core.read(token, 1, context())).stale, true);
        await unchanged(async () => {
          await assert.rejects(replace(), exact('GUIDE_GOODS_ISSUER_REVISION_CONFLICT'));
          await assert.rejects(core.assertLocalGoods(binding, body), exact('GUIDE_GOODS_POLICY_STALE'));
        });
      } finally { await client.companySettings.update({ where: { id: 1 }, data: { configVersion: 1 } }); }
    });

    await check('09_STALE_CAS_AND_SWALLOWED_CONFLICT_ROLL_BACK_EARLIER_AUDIT', async () => {
      const head = await current(1);
      await unchanged(async () => {
        await assert.rejects(core.replace(token, 1, input(0), context()), exact('GUIDE_GOODS_REVISION_CONFLICT'));
        await assert.rejects(store.transaction(1, async tx => {
          await tx.audit(audit(head.revision, { action: 'READ' }));
          try { await tx.save(next(head), 0); } catch {} return 'swallowed';
        }), exact('GUIDE_GOODS_REVISION_CONFLICT'));
      });
    });

    await check('10_FAILED_VERSION_APPEND_AFTER_CAS_POISONS_COMMIT', async () => {
      const head = await current(1), malformed = next(head, { entries: [{ ...entry(), classification: 'AUTOMATIC' }] });
      for (const swallowed of [false, true]) await unchanged(() => assert.rejects(store.transaction(1, async tx => {
        if (!swallowed) return tx.save(malformed, head.revision);
        try { await tx.save(malformed, head.revision); } catch {} return 'swallowed';
      }), unavailable));
    });

    await check('11_FAILED_AUDIT_ROLLS_BACK_CAS_AND_VERSION_EVEN_IF_MASKED', async () => {
      const head = await current(1), value = next(head);
      for (const masked of [false, true]) await unchanged(() => assert.rejects(store.transaction(1, async tx => {
        await tx.save(value, head.revision);
        if (!masked) return tx.audit(audit(value.revision, { peerSha256: 'invalid' }));
        try { await tx.audit(audit(value.revision, { peerSha256: 'invalid' })); } catch {}
        throw new B2bSecurityError(409, 'SYNTHETIC_MASKED_FAILURE');
      }), unavailable));
    });

    await check('12_CORE_LAST_AUTHORITY_CHECK_ROLLS_BACK_POLICY_AND_AUDIT', async () => {
      let calls = 0;
      const changed = { verify: async supplied => { assert.equal(supplied, token);
        return { ...structuredClone(proof), authRevision: ++calls >= 3 ? 2 : 1 }; } };
      await unchanged(() => assert.rejects(replace({}, new GuideGoods(store, changed, () => at)), exact('GUIDE_GOODS_AUTHORITY_CHANGED')));
      assert.equal(calls, 3);
    });

    await check('13_SERIALIZATION_RETRIES_WHOLE_CORE_CALLBACK_WITH_REAUTHORIZATION', async () => {
      let retries = 0, verifications = 0;
      const database = { $transaction: (work, options) => client.$transaction(async db => {
        let appended = false;
        const tx = { $queryRawUnsafe: (sql, ...values) => db.$queryRawUnsafe(sql, ...values),
          $executeRawUnsafe: async (sql, ...values) => {
            const count = await db.$executeRawUnsafe(sql, ...values);
            if (sql.includes('INSERT INTO "B2bGuideGoodsVersion"')) appended = true;
            return count;
          } };
        const result = await work(tx);
        if (appended && retries === 0) { retries++; throw Object.assign(new Error('SYNTHETIC_SERIALIZATION'), { code: '40001' }); }
        return result;
      }, options) };
      const auth = { verify: async supplied => { verifications++; return authority.verify(supplied); } };
      const head = await current(1), versions = (await rows('B2bGuideGoodsVersion')).length;
      await replace({}, new GuideGoods(new PostgresGuideGoodsStore(database), auth, () => at));
      assert.equal(retries, 1); assert.equal(verifications, 5); assert.equal((await current(1)).revision, head.revision + 1);
      assert.equal((await rows('B2bGuideGoodsVersion')).length, versions + 1);
    });

    await check('14_CONCURRENT_SAME_REVISION_HAS_EXACTLY_ONE_ATOMIC_WINNER', async () => {
      const head = await current(1), request = input(head.revision);
      const results = await Promise.allSettled([core.replace(token, 1, request, context()), core.replace(token, 1, request, context())]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      const failure = results.find(r => r.status === 'rejected'); assert.ok(exact('GUIDE_GOODS_REVISION_CONFLICT')(failure.reason));
      assert.equal((await current(1)).revision, head.revision + 1);
      assert.equal((await rows('B2bGuideGoodsAudit')).filter(a => a.companyId === 1 && a.action === 'REPLACE' && a.revision === head.revision + 1).length, 1);
    });

    await check('15_COMPANY_AND_PRODUCT_LOCKS_BLOCK_CONCURRENT_MASTER_EDITS', async () => {
      for (const target of ['company', 'product']) await store.transaction(1, async tx => {
        if (target === 'company') await tx.company(1); else await tx.products([productId]);
        await assert.rejects(direct(async db => {
          await db.query("SET LOCAL lock_timeout='100ms'");
          if (target === 'company') await db.query(`UPDATE "CompanySettings" SET "configVersion"="configVersion" WHERE "id"=1`);
          else await db.query(`UPDATE "FuelProduct" SET "description"="description" WHERE "id"=$1`, [productId]);
        }), error => error?.code === '55P03');
      });
    });

    await check('16_DIRECT_SQL_REJECTS_MALFORMED_METADATA_AND_BOUNDED_ENTRY_SHAPES', async () => {
      const valid = next(await current(1)), bad = [null, [], {}, { ...valid, extra: true },
        { ...valid, companyId: 2 }, { ...valid, revision: '2' }, { ...valid, issuerRuc: 20000000001 },
        { ...valid, issuerRevision: 0 }, { ...valid, authRevision: -1 }, { ...valid, authRevision: 2147483648 },
        { ...valid, actorId: 'invalid' }, { ...valid, at: 'infinity' }, { ...valid, sha256: 'invalid' },
        { ...valid, source: 'AUTOMATIC' }, { ...valid, entries: null }, { ...valid, entries: Array(201).fill(entry()) },
        { ...valid, entries: [null] }, { ...valid, entries: [entry(), entry()] },
        ...[{ productId: 'invalid' }, { productSha256: null }, { classification: 'AUTOMATIC' },
          { rationale: '' }, { rationale: ' x' }, { rationale: 'x'.repeat(501) }, { rationale: 'x\ny' }, { extra: true }]
          .map(change => ({ ...valid, entries: [{ ...entry(), ...change }] })),
        { ...valid, catalogue: null }, { ...valid, catalogue: { ...catalogue, sourceSha256: 'bad' } },
        { ...valid, catalogue: { ...catalogue, units: [1] } }, { ...valid, catalogue: { ...catalogue, ubigeos: [] } }];
      for (const payload of bad) await unchanged(() => assert.rejects(direct(db => directAppend(db, payload)), error => error?.code === '23514'));
    });

    await check('17_DDL_VALIDATES_SHAPE_WITHOUT_CLAIMING_CHECKSUM_OR_MASTER_AUTHORITY', async () => {
      // Shape-valid but deliberately untrusted hashes and absent product metadata.
      // Acceptance in SQL is not acceptance in core; always roll this fixture back.
      const value = next(await current(1), { issuerRuc: '20999999999', sha256: '0'.repeat(64),
        catalogue: { ...catalogue, sha256: '0'.repeat(64) }, entries: [{ ...entry('UNKNOWN'), productId: randomUUID(), productSha256: '0'.repeat(64) }] });
      value.sha256 = '0'.repeat(64);
      const rollback = new Error('SYNTHETIC_EXPECTED_ROLLBACK');
      await unchanged(() => assert.rejects(direct(async db => { await directAppend(db, value); throw rollback; }), error => error === rollback));
      await unchanged(() => assert.rejects(replace({ catalogue: { ...catalogue, sha256: '0'.repeat(64) } }), exact('INVALID_GUIDE_REFERENCE_CATALOGUE', 400)));
    });

    await check('18_DEFERRED_MEMBERSHIP_FK_HEAD_PLUS_ONE_AND_AUDIT_CONSISTENCY', async () => {
      const head = await current(1);
      for (const sql of [
        `UPDATE "B2bGuideGoodsHead" SET "revision"="revision"+1 WHERE "companyId"=1`,
        `UPDATE "B2bGuideGoodsHead" SET "revision"="revision"+2 WHERE "companyId"=1`,
        `UPDATE "B2bGuideGoodsHead" SET "companyId"=999,"revision"="revision"+1 WHERE "companyId"=1`,
        `INSERT INTO "B2bGuideGoodsHead" ("companyId","revision") VALUES (999,1)`,
        `INSERT INTO "B2bGuideGoodsHead" ("companyId","revision") VALUES (3,2)`])
        await unchanged(() => assert.rejects(direct(db => db.query(sql))));
      await unchanged(() => assert.rejects(direct(db => db.query(
        `INSERT INTO "B2bGuideGoodsVersion" ("companyId","revision","payload") VALUES (1,$1,$2::jsonb)`,
        [head.revision + 1, JSON.stringify(next(head))]))));
      for (const badAudit of [audit(0, { action: 'READ' }), audit(head.revision, { actorId: randomUUID() }),
        audit(head.revision, { at: '2026-10-22T05:00:01.000Z' })])
        await unchanged(() => assert.rejects(store.transaction(1, tx => tx.audit(badAudit)), unavailable));
    });

    await check('19_VERSIONS_AUDITS_APPEND_ONLY_AND_HISTORY_CANNOT_BE_TRUNCATED', async () => {
      for (const table of ['B2bGuideGoodsVersion', 'B2bGuideGoodsAudit']) {
        for (const sql of [`UPDATE ${quote(table)} SET "companyId"="companyId"`, `DELETE FROM ${quote(table)}`,
          `TRUNCATE ${quote(table)} CASCADE`]) await unchanged(() => assert.rejects(pool.query(sql)));
      }
      await unchanged(() => assert.rejects(pool.query(`DELETE FROM "B2bGuideGoodsHead"`)));
      await unchanged(() => assert.rejects(pool.query(`TRUNCATE "B2bGuideGoodsHead" CASCADE`)));
    });

    await check('20_QUOTA_COUNTS_DENIALS_NEVER_REWINDS_OR_RESETS_IN_WINDOW', async () => {
      const key = sha('synthetic-monotonic-quota');
      assert.equal(await store.rate(key, 100, 2), true);
      assert.equal(await store.rate(key, 100, 2), true);
      assert.equal(await store.rate(key, 100, 2), false); assert.equal(await store.rate(key, 100, 2), false);
      const getRate = async () => (await pool.query(`SELECT "window"::text,"counter" FROM "B2bGuideGoodsRate" WHERE "keyHash"=$1`, [key])).rows;
      assert.deepEqual(await getRate(), [{ window: '100', counter: 4 }]);
      assert.equal(await store.rate(key, 99, 2), false); assert.deepEqual(await getRate(), [{ window: '100', counter: 4 }]);
      assert.equal(await store.rate(key, 101, 2), true); assert.deepEqual(await getRate(), [{ window: '101', counter: 1 }]);
      for (const sql of [
        `UPDATE "B2bGuideGoodsRate" SET "counter"=1 WHERE "keyHash"=$1`,
        `UPDATE "B2bGuideGoodsRate" SET "window"=100 WHERE "keyHash"=$1`,
        `UPDATE "B2bGuideGoodsRate" SET "window"=102,"counter"=2 WHERE "keyHash"=$1`,
        `UPDATE "B2bGuideGoodsRate" SET "keyHash"=repeat('f',64) WHERE "keyHash"=$1`,
        `DELETE FROM "B2bGuideGoodsRate" WHERE "keyHash"=$1`]) await assert.rejects(pool.query(sql, [key]));
      await assert.rejects(pool.query(`INSERT INTO "B2bGuideGoodsRate" ("keyHash","window","counter") VALUES ($1,0,2)`, [sha('synthetic-invalid-initial')]));
      const ratesBefore = await rows('B2bGuideGoodsRate');
      await assert.rejects(pool.query(`TRUNCATE "B2bGuideGoodsRate"`));
      assert.deepEqual(await rows('B2bGuideGoodsRate'), ratesBefore);
      const newlineBefore = await rows('B2bGuideGoodsRate');
      await assert.rejects(store.rate(key + '\n', 101, 2), unavailable);
      assert.deepEqual(await rows('B2bGuideGoodsRate'), newlineBefore);
    });

    await check('21_FRESH_GUARD_REJECTS_CHANGED_POLICY_WITH_UNCHANGED_PRODUCT', async () => {
      const guard = await core.assertLocalGoods(binding, body);
      await replace({ entries: [{ ...entry(), rationale: 'Otra declaracion local ficticia' }] });
      await unchanged(() => assert.rejects(guard.fresh(), exact('GUIDE_GOODS_POLICY_CHANGED')));
    });

    await check('22_ALL_HISTORY_HASHES_AUDITS_AND_UNRELATED_TABLES_PRESERVED', async () => {
      const state = await policyState(), versions = state.B2bGuideGoodsVersion;
      for (const companyId of [1, 2]) {
        const list = versions.filter(v => v.companyId === companyId).sort((a, b) => a.revision - b.revision);
        assert.deepEqual(list.map(v => v.revision), list.map((_, i) => i + 1));
        assert.equal((await current(companyId)).revision, list.length);
        for (const version of list) {
          const { sha256, ...unsigned } = version.payload;
          assert.equal(sha256, fiscalSnapshotSha256(unsigned)); validateGuideReferenceCatalogue(version.payload.catalogue);
          assert.equal(version.payload.companyId, companyId); assert.equal(version.payload.revision, version.revision);
          assert.equal(state.B2bGuideGoodsAudit.filter(a => a.companyId === companyId && a.action === 'REPLACE' && a.revision === version.revision).length, 1);
        }
      }
      assert.deepEqual(versions.find(v => v.companyId === 1 && v.revision === 1).payload, firstSnapshot);
      for (const a of state.B2bGuideGoodsAudit) {
        assert.equal(a.actorId, actorId); assert.equal(a.peerSha256, sha(peer));
        assert.equal(JSON.stringify(a).includes(token), false); assert.equal(JSON.stringify(a).includes(peer), false);
      }
      assert.deepEqual(await protectedState(), protectedBefore);
      assert.deepEqual(await store.transaction(1, tx => tx.products([productId])), [product]);
    });
  }).then(() => console.log(JSON.stringify({ result: 'PASS', groups: passed.length, passed,
    authority: 'EXPLICIT_FAKE_GLOBAL_ADMIN_REAL_GOODS_CORE_AND_STORE',
    database: 'NEW_HELPER_OWNED_LABELLED_TMPFS_NETWORK_NONE_NO_PORTS_AUTO_REMOVE',
    officialNetwork: false, realData: false, qaRuntimeChanged: false, numberReserved: false,
    fiscalExecutionEnabled: false, transmissionAuthorized: false })))
    .catch(() => { console.error(JSON.stringify({ result: 'FAIL', stage, groups: passed.length, passed,
      code: 'ISOLATED_GUIDE_GOODS_CHECK_FAILED', officialNetwork: false, realData: false, qaRuntimeChanged: false }));
    process.exitCode = 1; });
}
