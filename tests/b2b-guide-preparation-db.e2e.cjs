'use strict';

// Run only after main confirms the rebuilt Billing dist is ready:
// node tests/b2b-guide-preparation-db.e2e.cjs --isolated-synthetic-only
// The existing helper owns a NEW labelled, network-none, tmpfs PostgreSQL.
// No QA database, .env, real data, caller paths/URLs, credentials or downloads.
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
  const check = async (name, work) => { stage = name; await work(); passed.push(name); };

  withCorrectionDatabase(async ({ client, pool, local }) => {
    const { B2bGuides } = local('./dist/b2b/guide-drafts');
    const { PostgresB2bGuideStore } = local('./dist/b2b/guide-store');
    const { PrismaGuideDraftCatalogue } = local('./dist/b2b/guide-catalogue');
    const { BillingGuidePreparation, PrismaGuidePreparationIssuer, GUIDE_PREPARATION_GATES } =
      local('./dist/b2b/guide-preparation');
    const { B2bSecurityError } = local('@factuez/contracts/b2b-security');
    const { prepareGuide09, validateGuide09Plan } = local('@factuez/sunat-core/dist/fiscal-guide-preparation');
    const { fiscalSnapshotSha256 } = local('@factuez/sunat-core/dist/fiscal-note');

    const ruc = '20000000001', legalName = 'EMPRESA FICTICIA DE PREPARACION';
    const branch = randomUUID(), point = randomUUID(), anchor = randomUUID(), guide09 = randomUUID();
    const clientId = randomUUID(), token = 'synthetic-guide-preparation-db-token';
    const now = () => '2026-10-21T16:00:00.000Z';
    const binding = { anchor: { issuerId: 1, issuerRuc: ruc, environment: 'BETA',
      branchId: branch, pointId: point, seriesId: anchor, documentType: '01' },
      guideSeriesId: guide09, guideType: '09' };

    // All public base tables, including ledger, fiscal children, receipts, counters,
    // outbox, inbox, holds and configuration. No list of fiscal tables can go stale.
    const quote = name => '"' + name.replaceAll('"', '""') + '"';
    async function snapshot({ excludeDraftChanges = false } = {}) {
      const tables = (await pool.query(`SELECT tablename FROM pg_catalog.pg_tables
        WHERE schemaname='public' ORDER BY tablename`)).rows.map(row => row.tablename);
      assert.ok(tables.length > 0 && tables.length <= 128, 'ISOLATED_TABLE_COUNT');
      const result = {};
      for (const name of tables) {
        if (excludeDraftChanges && ['B2bGuideDraft', 'B2bGuideDraftOperation'].includes(name)) continue;
        const rows = await pool.query(`SELECT COALESCE(jsonb_agg(value ORDER BY value::text), '[]'::jsonb) AS rows
          FROM (SELECT to_jsonb(t) AS value FROM "public".${quote(name)} t) entries`);
        result[name] = rows.rows[0].rows;
      }
      return result;
    }

    await check('NEW_EMPTY_DATABASE_BEFORE_GUIDE_DDL', async () => {
      assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'b2b_corrections_synthetic');
      const empty = await snapshot();
      assert.ok(Object.hasOwn(empty, 'CompanySettings') && Object.hasOwn(empty, 'Document'));
      assert.ok(Object.values(empty).every(rows => rows.length === 0), 'NEW_DATABASE_MUST_HAVE_NO_DATA');
      assert.equal(Object.hasOwn(empty, 'B2bGuideDraft'), false, 'GUIDE_DDL_MUST_BE_NEW');
      // This fixed candidate DDL is applied only to the new DB supplied by the helper.
      await pool.query(readFileSync(resolve(__dirname,
        '../services/billing-service/b2b-guide-drafts-schema.candidate.sql'), 'utf8'));
    });

    await client.companySettings.create({ data: { id: 1, ruc, legalName,
      companyType: 'FICTICIO', economicActivities: [], taxAddress: 'DOMICILIO FICTICIO',
      ubigeo: '150101', contactEmails: [], environment: 'BETA', active: true, configVersion: 1 } });
    await client.branch.create({ data: { id: branch, companyId: 1, code: 'PREP-FICTICIO', name: legalName } });
    await client.emissionPoint.create({ data: { id: point, companyId: 1, branchId: branch,
      code: '0001', name: 'PUNTO FICTICIO' } });
    await client.seriesCounter.create({ data: { id: anchor, companyId: 1, emissionPointId: point,
      documentType: 'INVOICE', series: 'F001', nextNumber: 1n } });
    await pool.query(`INSERT INTO "B2bGuideDraftSeries"
      ("id","companyId","pointId","guideType","label","purpose") VALUES ($1,1,$2,'09','T001','DRAFT_ONLY')`, [guide09, point]);

    // Duplicate only the fictitious private04 body from guide-preparation.fixture.ts.
    // Do not import TS fixtures, an application bootstrap or an HTTP/Identity service.
    const body = () => ({ issueDate: '2026-10-21T15:30:00.000Z', transferDate: '2026-10-21', reasonCode: '04',
      origin: { ubigeo: '150101', address: 'ORIGEN FICTICIO', establishmentCode: '0001' },
      destination: { ubigeo: '150102', address: 'DESTINO FICTICIO', establishmentCode: '0002' },
      sender: { ruc, legalName }, recipient: { ruc, legalName }, grossWeight: '1.250', weightUnit: 'KGM',
      transport: { mode: '02', vehicle: { plate: 'ABC123', registration: 'REG00001' },
        driver: { identityType: '1', identityNumber: '00000001', firstName: 'CONDUCTOR',
          lastName: 'FICTICIO', license: 'A000000001' } },
      items: [{ code: 'ITEM-FICTICIO-1', description: 'BIEN FICTICIO', quantity: '2.000001', unitCode: 'NIU' }],
      references: [], regulatedGoods: false });

    // Explicit FAKE authority, not Identity, token verification or real permission.
    const control = { revoked: false, calls: 0 };
    const authority = { current: async (suppliedToken, kind, b) => {
      control.calls++;
      assert.equal(suppliedToken, token); assert.equal(kind, 'SERVICE'); assert.deepEqual(b, binding);
      if (control.revoked) throw new B2bSecurityError(401, 'SYNTHETIC_REVOKED');
      return { actor: { userId: null, scope: { kind: 'ASSIGNED', branchIds: [branch],
        emissionPointIds: [point], series: [anchor, guide09] },
        b2b: { kind, clientId, revision: 1, subjectId: null, userAuthRevision: null } },
        grantRevision: 1, clientRevision: 1 };
    } };
    const make = () => {
      const guides = new B2bGuides(new PostgresB2bGuideStore(client), authority, new PrismaGuideDraftCatalogue(client), now);
      const issuer = new PrismaGuidePreparationIssuer(client);
      return { guides, issuer, preparer: new BillingGuidePreparation(guides, issuer) };
    };
    const core = make();
    let serial = 0;
    const key = () => 'synthetic_guide_prep_db_' + String(++serial).padStart(8, '0');
    const create = async () => (await core.guides.command(token, 'SERVICE', binding, 'CREATE', null, key(), undefined, body())).response;
    const command = async (action, draft) =>
      (await core.guides.command(token, 'SERVICE', binding, action, draft.id, key(), draft.revision, {})).response;
    const prepare = (draft, preparer = core.preparer, etag = draft.revision) =>
      preparer.prepare(token, 'SERVICE', binding, draft.id, etag);
    const exact = (code, status) => error => error?.code === code && error?.status === status;
    async function unchanged(work) {
      const before = await snapshot();
      const value = await work();
      assert.deepEqual(await snapshot(), before, 'PREPARATION_MUST_NOT_CHANGE_ANY_TABLE');
      return value;
    }
    const flags = value => {
      assert.equal(value.candidateOnly, true); assert.equal(value.fiscalExecutionEnabled, false);
      assert.equal(value.transmissionAuthorized, false); assert.equal(value.authorizedForTransfer, false);
      for (const field of ['xml', 'cdr', 'series', 'number', 'fullNumber', 'operationId', 'signature']) {
        assert.equal(Object.hasOwn(value, field), false, field);
      }
    };
    const planFlags = value => {
      flags(value); assert.equal(value.numberReserved, false); assert.equal(value.signatureVerified, false);
      assert.equal(value.officialRulesValidated, false); assert.equal(value.referenceVerification, 'NOT_VERIFIED');
    };

    // Expected CREATE/READY/CANCEL writes are excluded only from the global baseline.
    // Every preparation call separately compares ALL tables, including drafts/receipts.
    const fiscalBefore = await snapshot({ excludeDraftChanges: true });
    let draft, ready, cancelled, expected;
    await check('CREATE_DRAFT_READY_AND_CANCELLED_SYNTHETIC_FIXTURES', async () => {
      draft = await create();
      const initial = await create();
      ready = await command('READY', initial);
      cancelled = await command('CANCEL', await command('READY', await create()));
      assert.equal(draft.state, 'DRAFT'); assert.equal(ready.state, 'READY'); assert.equal(cancelled.state, 'CANCELLED');
      assert.equal(ready.revision, '"v2"'); assert.equal(cancelled.revision, '"v3"');
      assert.deepEqual(ready.body, body()); assert.equal(ready.bodySha256, fiscalSnapshotSha256(body()));
      assert.deepEqual(await snapshot({ excludeDraftChanges: true }), fiscalBefore);
    });

    await check('READY_PREPARATION_DETERMINISTIC_MULTIPLE_AND_RESTART', async () => {
      await unchanged(async () => {
        const beforeCalls = control.calls;
        expected = await prepare(ready);
        assert.ok(control.calls > beforeCalls, 'PREPARATION_MUST_REAUTHORIZE');
        flags(expected); planFlags(expected.plan);
        assert.equal(expected.schemaVersion, 'factuez.b2b.guide-preparation.v1');
        assert.deepEqual(expected.binding, binding); assert.deepEqual(expected.gates, GUIDE_PREPARATION_GATES);
        assert.deepEqual(expected.plan, prepareGuide09({ schemaVersion: 'factuez.guide09-preparation-input.v1',
          draftId: ready.id, draftRevision: ready.revision, draftBodySha256: ready.bodySha256,
          issuer: { ruc, legalName }, body: ready.body }));
        assert.deepEqual(validateGuide09Plan(expected.plan), expected.plan);
        assert.deepEqual(await prepare(ready), expected);
        assert.deepEqual(await prepare(ready), expected);
        // New store/catalogue/issuer/preparer instances must use durable owner state.
        const restarted = make();
        assert.deepEqual(await restarted.guides.read(token, 'SERVICE', binding, ready.id), ready);
        assert.deepEqual(await prepare(ready, restarted.preparer), expected);
        assert.deepEqual(await core.guides.read(token, 'SERVICE', binding, ready.id), ready);
      });
    });
    await check('DRAFT_AND_CANCELLED_PREPARATION_BLOCKED_WITHOUT_OWNER_LOOKUP', async () => {
      await unchanged(async () => {
        let lookups = 0;
        const observedIssuer = { current: async b => { lookups++; return core.issuer.current(b); } };
        const preparer = new BillingGuidePreparation(core.guides, observedIssuer);
        await assert.rejects(prepare(draft, preparer), exact('READY_GUIDE_REQUIRED', 409));
        await assert.rejects(prepare(cancelled, preparer), exact('READY_GUIDE_REQUIRED', 409));
        assert.equal(lookups, 0);
      });
    });
    await check('STALE_ETAG_BLOCKED_WITHOUT_OWNER_LOOKUP', async () => {
      await unchanged(async () => {
        let lookups = 0;
        const preparer = new BillingGuidePreparation(core.guides,
          { current: async b => { lookups++; return core.issuer.current(b); } });
        await assert.rejects(prepare(ready, preparer, '"v1"'), exact('REVISION_CONFLICT', 412));
        assert.equal(lookups, 0);
      });
    });

    for (const field of ['legalName', 'configVersion']) {
      await check('OWNER_' + field.toUpperCase() + '_CHANGED_DURING_PREPARATION_REJECTED', async () => {
        await unchanged(async () => {
          const rollback = new Error('SYNTHETIC_OWNER_METADATA_ROLLBACK');
          // Real owner SQL changes, visible through the real Prisma issuer port.
          // Roll back BEFORE comparing the full baseline (including CompanySettings).
          // No fake metadata hashes and no comparison against deliberately changed config.
          await assert.rejects(client.$transaction(async tx => {
            const port = new PrismaGuidePreparationIssuer(tx);
            const original = await port.current(binding);
            assert.ok(original);
            let lookups = 0, changed;
            const observedIssuer = { current: async b => {
              if (++lookups === 2) {
                await tx.companySettings.update({ where: { id: 1 }, data: field === 'legalName'
                  ? { legalName: 'EMPRESA FICTICIA CAMBIADA' } : { configVersion: { increment: 1 } } });
                changed = await port.current(b);
                assert.ok(changed); assert.notEqual(changed.metadataSha256, original.metadataSha256);
                if (field === 'legalName') assert.equal(changed.legalName, 'EMPRESA FICTICIA CAMBIADA');
                else assert.equal(changed.legalName, legalName);
                return changed;
              }
              return port.current(b);
            } };
            const preparer = new BillingGuidePreparation(core.guides, observedIssuer);
            await assert.rejects(prepare(ready, preparer), exact('GUIDE_PREPARATION_SOURCE_CHANGED', 409));
            assert.equal(lookups, 2); assert.ok(changed);
            throw rollback;
          }, { timeout: 15000, maxWait: 3000 }), error => error === rollback);
          assert.deepEqual(await prepare(ready, make().preparer), expected);
        });
      });
    }
    await check('REVOKED_BEFORE_PREPARATION_BLOCKED_BEFORE_OWNER_LOOKUP', async () => {
      await unchanged(async () => {
        let lookups = 0;
        const preparer = new BillingGuidePreparation(core.guides,
          { current: async b => { lookups++; return core.issuer.current(b); } });
        control.revoked = true;
        try { await assert.rejects(prepare(ready, preparer), exact('SYNTHETIC_REVOKED', 401)); }
        finally { control.revoked = false; }
        assert.equal(lookups, 0);
      });
    });
    await check('REVOKED_DURING_PREPARATION_BLOCKS_FINAL_REAUTHORIZED_READ', async () => {
      await unchanged(async () => {
        let lookups = 0;
        const preparer = new BillingGuidePreparation(core.guides, { current: async b => {
          if (++lookups === 2) control.revoked = true;
          return core.issuer.current(b);
        } });
        try { await assert.rejects(prepare(ready, preparer), exact('SYNTHETIC_REVOKED', 401)); }
        finally { control.revoked = false; }
        assert.equal(lookups, 2);
        assert.deepEqual(await prepare(ready, make().preparer), expected);
      });
    });
    await check('ALL_FISCAL_ROWS_STABLE_AND_ONLY_EXPECTED_DRAFT_OPERATIONS', async () => {
      assert.deepEqual(await snapshot({ excludeDraftChanges: true }), fiscalBefore);
      const final = await snapshot();
      assert.equal(final.B2bGuideDraft.length, 3); assert.equal(final.B2bGuideDraftOperation.length, 6);
      const actions = final.B2bGuideDraftOperation.map(row => row.payload.action).sort();
      assert.deepEqual(actions, ['CANCEL', 'CREATE', 'CREATE', 'CREATE', 'READY', 'READY']);
      assert.equal(final.B2bGuideDraftSeries.length, 1); assert.equal(final.B2bGuideDraftSeries[0].purpose, 'DRAFT_ONLY');
      assert.equal(final.SeriesCounter.length, 1); assert.equal(final.SeriesCounter[0].nextNumber, 1);
      assert.equal(final.Document.length, 0); assert.equal(final.OutboxEvent.length, 0);
      assert.equal(final.DailySummary.length, 0);
      for (const row of final.B2bGuideDraftOperation) {
        const actor = row.payload.actor;
        assert.deepEqual(actor, { kind: 'SERVICE', clientId, revision: 1, subjectId: null, userAuthRevision: null });
        assert.equal(JSON.stringify(row).includes(token), false);
      }
    });
  }).then(() => console.log(JSON.stringify({ result: 'PASS', groups: passed.length, passed,
    authority: 'EXPLICIT_FAKE_NOT_IDENTITY', database: 'NEW_HELPER_OWNED_SYNTHETIC_ONLY',
    officialNetwork: false, realData: false, qaRuntimeChanged: false,
    numberReserved: false, fiscalExecutionEnabled: false, transmissionAuthorized: false })))
    .catch(error => { console.error(JSON.stringify({ result: 'FAIL', stage,
      code: error?.code ?? 'ISOLATED_GUIDE_PREPARATION_CHECK_FAILED', passed,
      officialNetwork: false, realData: false, qaRuntimeChanged: false })); process.exitCode = 1; });
}
