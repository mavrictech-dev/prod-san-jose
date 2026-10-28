'use strict';

// Main must confirm rebuilt Billing dist before executing this integration test:
// node tests/b2b-guide-establishments-db.e2e.cjs --isolated-synthetic-only
// The unchanged helper owns a NEW labelled PostgreSQL, tmpfs, network=none,
// no published ports. No runtime, existing database, secrets, migrations or SUNAT.
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
    const { GuideEstablishments } = local('./dist/b2b/guide-establishments');
    const { PostgresGuideEstablishmentStore } = local('./dist/b2b/guide-establishment-store');
    const { B2bGuides } = local('./dist/b2b/guide-drafts');
    const { PostgresB2bGuideStore } = local('./dist/b2b/guide-store');
    const { PrismaGuideDraftCatalogue } = local('./dist/b2b/guide-catalogue');
    const { BillingGuidePreparation, PrismaGuidePreparationIssuer, GUIDE_PREPARATION_GATES } =
      local('./dist/b2b/guide-preparation');
    const { B2bSecurityError } = local('@factuez/contracts/b2b-security');
    const { fiscalSnapshotSha256 } = local('@factuez/sunat-core/dist/fiscal-note');
    const { prepareGuide09 } = local('@factuez/sunat-core/dist/fiscal-guide-preparation');

    const ruc = '20000000001', legalName = 'EMPRESA FICTICIA DE ESTABLECIMIENTOS';
    const branch = randomUUID(), destinationBranch = randomUUID(), point = randomUUID();
    const anchor = randomUUID(), guide09 = randomUUID(), actorId = randomUUID(), clientId = randomUUID();
    const adminToken = 'synthetic-establishments-fake-admin', guideToken = 'synthetic-establishments-fake-service';
    const now = () => '2026-10-21T16:00:00.000Z';
    const sha = text => createHash('sha256').update(text).digest('hex');
    const exact = (code, status = 409) => error => error?.code === code && error?.status === status;
    const registryTables = ['B2bGuideEstablishmentHead', 'B2bGuideEstablishmentVersion',
      'B2bGuideEstablishmentAudit', 'B2bGuideEstablishmentRate'];
    const localTables = [...registryTables, 'B2bGuideDraft', 'B2bGuideDraftOperation'];
    const quote = name => '"' + name.replaceAll('"', '""') + '"';

    // All public base tables: counters, fiscal children, receipts and outbox too.
    // Explicit exclusions apply only to deliberately exercised local mutations.
    async function snapshot(excluded = []) {
      const tables = (await pool.query(`SELECT tablename FROM pg_catalog.pg_tables
        WHERE schemaname='public' ORDER BY tablename`)).rows.map(row => row.tablename);
      assert.ok(tables.length > 0 && tables.length <= 128, 'ISOLATED_TABLE_COUNT');
      const result = {};
      for (const name of tables) {
        if (excluded.includes(name)) continue;
        const rows = await pool.query(`SELECT COALESCE(jsonb_agg(value ORDER BY value::text), '[]'::jsonb) AS rows
          FROM (SELECT to_jsonb(t) AS value FROM "public".${quote(name)} t) entries`);
        result[name] = rows.rows[0].rows;
      }
      return result;
    }
    async function unchanged(work, excluded = []) {
      const before = await snapshot(excluded);
      const result = await work();
      assert.deepEqual(await snapshot(excluded), before, 'UNEXPECTED_DATABASE_MUTATION');
      return result;
    }
    // Failed admin requests may intentionally consume only a durable rate entry.
    const rejected = (work, code, status = 409) => unchanged(async () => {
      await assert.rejects(work, exact(code, status));
    }, ['B2bGuideEstablishmentRate']);

    await check('NEW_EMPTY_HELPER_DATABASE_AND_NEW_CANDIDATE_DDL_ONLY', async () => {
      assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'b2b_corrections_synthetic');
      const before = await snapshot();
      assert.ok(Object.hasOwn(before, 'CompanySettings') && Object.hasOwn(before, 'Document'));
      assert.ok(Object.values(before).every(rows => rows.length === 0), 'NEW_DATABASE_MUST_BE_EMPTY');
      for (const name of [...localTables, 'B2bGuideDraftSeries']) assert.equal(Object.hasOwn(before, name), false);
      // These two fixed files are applied exclusively to the fresh helper-owned DB.
      for (const file of ['b2b-guide-drafts-schema.candidate.sql', 'b2b-guide-establishments-schema.candidate.sql']) {
        await pool.query(readFileSync(resolve(__dirname, '../services/billing-service', file), 'utf8'));
      }
      const after = await snapshot();
      for (const name of [...localTables, 'B2bGuideDraftSeries']) assert.deepEqual(after[name], []);
    });

    await client.companySettings.create({ data: { id: 1, ruc, legalName, companyType: 'FICTICIO',
      economicActivities: [], taxAddress: 'DOMICILIO FICTICIO', ubigeo: '150101', contactEmails: [],
      environment: 'BETA', active: true, configVersion: 1 } });
    for (const [id, code] of [[branch, 'ORIGEN-FICTICIO'], [destinationBranch, 'DESTINO-FICTICIO']]) {
      await client.branch.create({ data: { id, companyId: 1, code, name: code, masterRevision: 1 } });
    }
    await client.emissionPoint.create({ data: { id: point, companyId: 1, branchId: branch,
      code: '0001', name: 'PUNTO FICTICIO' } });
    await client.seriesCounter.create({ data: { id: anchor, companyId: 1, emissionPointId: point,
      documentType: 'INVOICE', series: 'F001', nextNumber: 1n } });
    await pool.query(`INSERT INTO "B2bGuideDraftSeries"
      ("id","companyId","pointId","guideType","label","purpose") VALUES ($1,1,$2,'09','T001','DRAFT_ONLY')`, [guide09, point]);

    const binding = { anchor: { issuerId: 1, issuerRuc: ruc, environment: 'BETA',
      branchId: branch, pointId: point, seriesId: anchor, documentType: '01' },
      guideSeriesId: guide09, guideType: '09' };
    const body = () => ({ issueDate: '2026-10-21T15:30:00.000Z', transferDate: '2026-10-21', reasonCode: '04',
      origin: { ubigeo: '150101', address: 'ORIGEN FICTICIO', establishmentCode: '0001' },
      destination: { ubigeo: '150102', address: 'DESTINO FICTICIO', establishmentCode: '0002' },
      sender: { ruc, legalName }, recipient: { ruc, legalName }, grossWeight: '1.250', weightUnit: 'KGM',
      transport: { mode: '02', vehicle: { plate: 'ABC123', registration: 'REG00001' },
        driver: { identityType: '1', identityNumber: '00000001', firstName: 'CONDUCTOR',
          lastName: 'FICTICIO', license: 'A000000001' } },
      items: [{ code: 'ITEM-FICTICIO-1', description: 'BIEN FICTICIO', quantity: '2.000001', unitCode: 'NIU' }],
      references: [], regulatedGoods: false });
    const entries = (originRevision = 1, destinationRevision = 1) => [
      { branchId: branch, branchRevision: originRevision, ...body().origin },
      { branchId: destinationBranch, branchRevision: destinationRevision, ...body().destination },
    ];
    const sortedEntries = list => structuredClone(list).sort((a, b) => a.branchId < b.branchId ? -1 : a.branchId > b.branchId ? 1 : 0);

    // Explicit FAKE authorities: no Identity, live session or token verification.
    const adminState = { calls: 0, alterAt: null };
    const adminProof = { id: actorId, authRevision: 1, stepUpVerified: true,
      scope: 'GLOBAL', permissions: ['setup.manage', 'series.manage'] };
    const admin = { verify: async supplied => {
      assert.equal(supplied, adminToken);
      const proof = structuredClone(adminProof);
      if (++adminState.calls === adminState.alterAt) proof.authRevision++;
      return proof;
    } };
    const guideState = { revoked: false, calls: 0 };
    const authorization = { current: async (supplied, kind, suppliedBinding) => {
      guideState.calls++;
      assert.equal(supplied, guideToken); assert.equal(kind, 'SERVICE'); assert.deepEqual(suppliedBinding, binding);
      if (guideState.revoked) throw new B2bSecurityError(401, 'SYNTHETIC_REVOKED');
      return { actor: { userId: null, scope: { kind: 'ASSIGNED', branchIds: [branch],
        emissionPointIds: [point], series: [anchor, guide09] },
        b2b: { kind, clientId, revision: 1, subjectId: null, userAuthRevision: null } },
        grantRevision: 1, clientRevision: 1 };
    } };
    const makeRegistry = (authority = admin) => new GuideEstablishments(new PostgresGuideEstablishmentStore(client), authority, now);
    const registry = makeRegistry(), store = new PostgresGuideEstablishmentStore(client);
    const make = () => {
      const guides = new B2bGuides(new PostgresB2bGuideStore(client), authorization, new PrismaGuideDraftCatalogue(client), now);
      const issuer = new PrismaGuidePreparationIssuer(client);
      return { guides, issuer, preparer: new BillingGuidePreparation(guides, issuer, makeRegistry()) };
    };
    const core = make();
    let serial = 0;
    const key = () => 'synthetic_establishment_db_' + String(++serial).padStart(8, '0');
    const context = () => ({ requestId: randomUUID(), peer: 'synthetic-local-peer-' + randomUUID() });
    const expectedAudits = [];
    const recordAudit = (ctx, action, revision) => expectedAudits.push({ requestId: ctx.requestId,
      peerSha256: sha(ctx.peer), companyId: 1, revision, actorId, action, at: now() });
    let headRevision = 0;
    async function read(reg = registry) {
      const ctx = context(), value = await reg.read(adminToken, 1, ctx);
      recordAudit(ctx, 'READ', value.revision);
      return value;
    }
    async function replace(list = entries(), expectedIssuerRevision = 1, reg = registry) {
      const ctx = context(), value = await reg.replace(adminToken, 1,
        { expectedRevision: headRevision, expectedIssuerRevision, entries: list }, ctx);
      assert.equal(value.revision, headRevision + 1);
      headRevision = value.revision; recordAudit(ctx, 'REPLACE', value.revision);
      return value;
    }
    const prepare = (draft, preparer = core.preparer) => preparer.prepare(guideToken, 'SERVICE', binding, draft.id, draft.revision);
    const create = async () => (await core.guides.command(guideToken, 'SERVICE', binding, 'CREATE', null,
      key(), undefined, body())).response;
    const flags = value => {
      assert.equal(value.candidateOnly, true); assert.equal(value.fiscalExecutionEnabled, false);
      assert.equal(value.transmissionAuthorized, false);
      for (const field of ['xml', 'cdr', 'series', 'number', 'fullNumber', 'operationId', 'signature']) {
        assert.equal(Object.hasOwn(value, field), false, field);
      }
    };
    const registryFlags = value => { flags(value); assert.equal(value.officialValidation, false); };
    const fiscalBefore = await snapshot(localTables);
    let ready, firstSnapshot;

    await check('FAKE_ADMIN_READ_EMPTY_REGISTRY_IS_TRANSACTIONALLY_AUDITED', async () => {
      const value = await read(); registryFlags(value);
      assert.equal(value.revision, 0); assert.equal(value.snapshot, null); assert.equal(value.stale, false);
      assert.equal(value.issuerRuc, ruc); assert.equal(value.issuerRevision, 1);
      const state = await snapshot();
      assert.equal(state.B2bGuideEstablishmentAudit.length, 1);
      assert.deepEqual(state.B2bGuideEstablishmentHead, []); assert.deepEqual(state.B2bGuideEstablishmentVersion, []);
    });

    await check('REAL_GUIDE_STORE_AND_CATALOGUE_NEW_PRIVATE04_READY09', async () => {
      const draft = await create(); assert.equal(draft.state, 'DRAFT');
      ready = (await core.guides.command(guideToken, 'SERVICE', binding, 'READY', draft.id,
        key(), draft.revision, {})).response;
      assert.equal(ready.state, 'READY'); assert.equal(ready.revision, '"v2"');
      assert.deepEqual(ready.body, body()); assert.equal(ready.bodySha256, fiscalSnapshotSha256(body()));
      assert.deepEqual(await snapshot(localTables), fiscalBefore);
    });

    await check('STRICT_BILLING_PREPARATION_REQUIRES_LOCAL_REGISTRY', async () => {
      await unchanged(async () => { await assert.rejects(prepare(ready), exact('ESTABLISHMENT_REGISTRY_REQUIRED')); });
    });

    await check('TRANSACTIONAL_REPLACE_CANONICAL_HASH_AND_RESTART_READ', async () => {
      const result = await replace(entries().reverse()); registryFlags(result);
      firstSnapshot = result.snapshot;
      assert.equal(result.revision, 1); assert.equal(firstSnapshot.authRevision, 1); assert.equal(firstSnapshot.actorId, actorId);
      assert.equal(firstSnapshot.source, 'ADMIN_LOCAL_CONFIGURATION');
      assert.deepEqual(firstSnapshot.entries, sortedEntries(entries()));
      const { sha256, ...unsigned } = firstSnapshot; assert.equal(sha256, fiscalSnapshotSha256(unsigned));
      const restarted = await read(makeRegistry());
      assert.deepEqual(restarted.snapshot, firstSnapshot); assert.equal(restarted.stale, false);
      await unchanged(async () => {
        await new PostgresGuideEstablishmentStore(client).transaction(1, async tx => {
          assert.deepEqual(await tx.head(1), firstSnapshot);
          assert.deepEqual(await tx.company(1), { id: 1, ruc, environment: 'BETA', configVersion: 1, active: true });
          const branches = await tx.branches(1, [branch, destinationBranch]);
          assert.equal(branches.length, 2); assert.ok(branches.every(row => row.active && row.masterRevision === 1));
        });
      });
    });

    await check('STRICT_PREPARATION_DETERMINISTIC_RESTART_READY_AND_ALL_TABLES_UNCHANGED', async () => {
      await unchanged(async () => {
        const beforeCalls = guideState.calls, result = await prepare(ready);
        assert.ok(guideState.calls > beforeCalls, 'PREPARATION_MUST_REAUTHORIZE');
        flags(result); flags(result.plan);
        assert.equal(result.authorizedForTransfer, false); assert.equal(result.plan.authorizedForTransfer, false);
        assert.equal(result.plan.numberReserved, false); assert.equal(result.plan.signatureVerified, false);
        assert.equal(result.plan.officialRulesValidated, false); assert.equal(result.plan.referenceVerification, 'NOT_VERIFIED');
        assert.deepEqual(result.gates, GUIDE_PREPARATION_GATES);
        assert.ok(result.gates.includes('ESTABLISHMENT_MAPPING'), 'LOCAL_MAP_DOES_NOT_REMOVE_OFFICIAL_GATE');
        assert.equal(Object.hasOwn(result, 'registry'), false);
        assert.deepEqual(result.plan, prepareGuide09({ schemaVersion: 'factuez.guide09-preparation-input.v1',
          draftId: ready.id, draftRevision: ready.revision, draftBodySha256: ready.bodySha256,
          issuer: { ruc, legalName }, body: ready.body }));
        assert.deepEqual(await prepare(ready), result);
        const restarted = make(); assert.deepEqual(await prepare(ready, restarted.preparer), result);
        assert.deepEqual(await restarted.guides.read(guideToken, 'SERVICE', binding, ready.id), ready);
      });
    });

    await check('EXACT_STALE_CAS_REJECTED_WITHOUT_HEAD_VERSION_OR_AUDIT_WRITE', async () => {
      await rejected(() => registry.replace(adminToken, 1,
        { expectedRevision: 0, expectedIssuerRevision: 1, entries: entries() }, context()), 'ESTABLISHMENT_REVISION_CONFLICT');
      await rejected(() => store.transaction(1, async tx => {
        const unsigned = { ...firstSnapshot, revision: 2 }; delete unsigned.sha256;
        await tx.save({ ...unsigned, sha256: fiscalSnapshotSha256(unsigned) }, 0);
      }), 'ESTABLISHMENT_REVISION_CONFLICT');
    });

    const nextSnapshot = prior => {
      const { sha256, ...unsigned } = { ...prior, revision: prior.revision + 1, at: now() };
      return { ...unsigned, sha256: fiscalSnapshotSha256(unsigned) };
    };
    const auditFor = value => ({ id: randomUUID(), requestId: randomUUID(), peerSha256: sha('synthetic-rollback-peer'),
      companyId: 1, revision: value.revision, actorId, action: 'REPLACE', at: now() });

    await check('SAVE_AND_AUDIT_ROLL_BACK_TOGETHER_WHEN_CALLBACK_FAILS', async () => {
      await unchanged(async () => {
        await assert.rejects(store.transaction(1, async tx => {
          const prior = await tx.head(1), next = nextSnapshot(prior);
          await tx.save(next, prior.revision); await tx.audit(auditFor(next));
          assert.deepEqual(await tx.head(1), next);
          throw new B2bSecurityError(409, 'SYNTHETIC_CALLBACK_ROLLBACK');
        }), exact('SYNTHETIC_CALLBACK_ROLLBACK'));
      });
    });

    await check('SWALLOWED_FAILED_CAS_POISONS_TRANSACTION_AND_ROLLS_BACK_SAVE_AUDIT', async () => {
      await unchanged(async () => {
        await assert.rejects(store.transaction(1, async tx => {
          const prior = await tx.head(1), next = nextSnapshot(prior);
          await tx.save(next, prior.revision); await tx.audit(auditFor(next));
          // Even if a callback swallows a semantic CAS error, preceding writes
          // cannot commit. This failure does not rely on PostgreSQL abort state.
          await assert.rejects(tx.save(next, prior.revision), exact('ESTABLISHMENT_REVISION_CONFLICT'));
          return 'MUST_NOT_COMMIT';
        }), exact('ESTABLISHMENT_REVISION_CONFLICT'));
      });
    });

    await check('FAILED_AUDIT_INSERT_ROLLS_BACK_NEW_HEAD_AND_VERSION', async () => {
      await unchanged(async () => {
        await assert.rejects(store.transaction(1, async tx => {
          const prior = await tx.head(1), next = nextSnapshot(prior);
          await tx.save(next, prior.revision);
          await tx.audit({ ...auditFor(next), revision: prior.revision });
        }), exact('ESTABLISHMENT_STORE_UNAVAILABLE', 503));
      });
    });

    await check('CONCURRENT_EXACT_CAS_ONE_WINNER_ONE_CONFLICT_NO_LOST_UPDATE', async () => {
      const before = await snapshot(), expectedRevision = headRevision;
      const attempts = [context(), context()];
      const results = await Promise.allSettled(attempts.map(ctx => makeRegistry().replace(adminToken, 1,
        { expectedRevision, expectedIssuerRevision: 1, entries: entries() }, ctx)));
      const wins = results.filter(result => result.status === 'fulfilled');
      const losses = results.filter(result => result.status === 'rejected');
      assert.equal(wins.length, 1); assert.equal(losses.length, 1);
      assert.ok(exact('ESTABLISHMENT_REVISION_CONFLICT')(losses[0].reason));
      headRevision = wins[0].value.revision; assert.equal(headRevision, expectedRevision + 1);
      recordAudit(attempts[results.findIndex(result => result.status === 'fulfilled')], 'REPLACE', headRevision);
      const after = await snapshot();
      assert.equal(after.B2bGuideEstablishmentVersion.length, before.B2bGuideEstablishmentVersion.length + 1);
      assert.equal(after.B2bGuideEstablishmentAudit.length, before.B2bGuideEstablishmentAudit.length + 1);
      assert.deepEqual(after.B2bGuideEstablishmentHead, [{ companyId: 1, revision: headRevision }]);
      for (const name of Object.keys(before)) if (!registryTables.includes(name)) assert.deepEqual(after[name], before[name], name);
      assert.deepEqual((await read(makeRegistry())).snapshot, wins[0].value.snapshot);
    });

    await check('FINAL_ADMIN_REVISION_CHANGE_ROLLS_BACK_READ_AND_REPLACE_AUDITS', async () => {
      for (const action of ['READ', 'REPLACE']) {
        // Boundary verify, transaction entry verify, then final verify after SQL.
        adminState.alterAt = adminState.calls + 3;
        try {
          await rejected(() => action === 'READ' ? registry.read(adminToken, 1, context())
            : registry.replace(adminToken, 1, { expectedRevision: headRevision,
              expectedIssuerRevision: 1, entries: entries() }, context()), 'ESTABLISHMENT_AUTHORITY_CHANGED');
        } finally { adminState.alterAt = null; }
      }
    });

    await check('FAKE_ADMIN_MUST_HAVE_GLOBAL_STEPUP_AND_BOTH_MANAGEMENT_PERMISSIONS', async () => {
      for (const patch of [{ stepUpVerified: false }, { scope: 'ASSIGNED' },
        { permissions: ['setup.manage'] }, { permissions: ['series.manage'] }]) {
        const denied = makeRegistry({ verify: async supplied => {
          assert.equal(supplied, adminToken); return { ...adminProof, ...patch };
        } });
        await rejected(() => denied.replace(adminToken, 1, { expectedRevision: headRevision,
          expectedIssuerRevision: 1, entries: entries() }, context()), 'ESTABLISHMENT_ADMIN_REQUIRED', 403);
      }
    });

    await check('AUDIT_AND_VERSION_UPDATE_DELETE_TRUNCATE_REJECTED_APPEND_ONLY', async () => {
      for (const table of ['B2bGuideEstablishmentAudit', 'B2bGuideEstablishmentVersion']) {
        const assignment = table.endsWith('Audit') ? '"action"="action"' : '"payload"="payload"';
        for (const sql of [`UPDATE ${quote(table)} SET ${assignment} WHERE "companyId"=1`,
          `DELETE FROM ${quote(table)} WHERE "companyId"=1`]) {
          await unchanged(async () => {
            await assert.rejects(pool.query(sql), error => error?.code === 'P0001' && /ESTABLISHMENT_APPEND_ONLY/.test(error.message));
          });
        }
      }
      await unchanged(async () => {
        await assert.rejects(pool.query('TRUNCATE "B2bGuideEstablishmentAudit"'),
          error => error?.code === 'P0001' && /ESTABLISHMENT_APPEND_ONLY/.test(error.message));
      });
    });

    await check('HEAD_TRIGGER_REJECTS_DELETE_IDENTITY_REWIND_SKIP_AND_DANGLING_VERSION', async () => {
      for (const [sql, message] of [
        ['DELETE FROM "B2bGuideEstablishmentHead" WHERE "companyId"=1', 'ESTABLISHMENT_HEAD_NO_DELETE'],
        ['UPDATE "B2bGuideEstablishmentHead" SET "companyId"=2,"revision"="revision"+1 WHERE "companyId"=1', 'ESTABLISHMENT_HEAD_IDENTITY_OR_REVISION'],
        ['UPDATE "B2bGuideEstablishmentHead" SET "revision"="revision" WHERE "companyId"=1', 'ESTABLISHMENT_HEAD_IDENTITY_OR_REVISION'],
        ['UPDATE "B2bGuideEstablishmentHead" SET "revision"="revision"-1 WHERE "companyId"=1', 'ESTABLISHMENT_HEAD_IDENTITY_OR_REVISION'],
        ['UPDATE "B2bGuideEstablishmentHead" SET "revision"="revision"+2 WHERE "companyId"=1', 'ESTABLISHMENT_HEAD_IDENTITY_OR_REVISION'],
      ]) {
        await unchanged(async () => {
          await assert.rejects(pool.query(sql), error => error?.code === 'P0001' && error.message.includes(message));
        });
      }
      await unchanged(async () => {
        await assert.rejects(pool.query('UPDATE "B2bGuideEstablishmentHead" SET "revision"="revision"+1 WHERE "companyId"=1'),
          error => error?.code === '23503' && error?.constraint === 'B2bGuideEstablishmentHead_version_fkey');
      });
    });

    await check('STALE_ISSUER_HISTORY_READABLE_REPAIR_REQUIRES_EXPLICIT_CURRENT_ISSUER', async () => {
      const prior = (await read()).snapshot;
      // Deliberate synthetic metadata changes use SQL to preserve updatedAt.
      // The original issuer row is restored before the global fiscal comparison.
      await pool.query('UPDATE "CompanySettings" SET "configVersion"=2 WHERE "id"=1');
      try {
        const stale = await read(makeRegistry());
        assert.equal(stale.stale, true); assert.equal(stale.issuerRevision, 2);
        assert.deepEqual(stale.snapshot, prior); assert.equal(stale.revision, headRevision);
        await unchanged(async () => {
          await assert.rejects(prepare(ready), exact('ESTABLISHMENT_REGISTRY_STALE'));
        });
        await rejected(() => registry.replace(adminToken, 1, { expectedRevision: headRevision,
          expectedIssuerRevision: 1, entries: entries() }, context()), 'ESTABLISHMENT_ISSUER_REVISION_CONFLICT');
        await rejected(() => registry.replace(adminToken, 1, { expectedRevision: headRevision - 1,
          expectedIssuerRevision: 2, entries: entries() }, context()), 'ESTABLISHMENT_REVISION_CONFLICT');
        const repaired = await replace(entries(), 2);
        assert.equal(repaired.snapshot.issuerRevision, 2); assert.equal((await read()).stale, false);
        await unchanged(async () => { flags(await prepare(ready)); });
      } finally {
        await pool.query('UPDATE "CompanySettings" SET "configVersion"=1 WHERE "id"=1');
      }
      await replace(entries(), 1);
      assert.equal((await read()).stale, false);
      assert.deepEqual(await snapshot(localTables), fiscalBefore);
    });

    for (const [side, branchId] of [['ORIGIN', branch], ['DESTINATION', destinationBranch]]) {
      await check('STALE_' + side + '_BRANCH_HISTORY_READABLE_AND_EXPLICIT_REPLACEMENT_REQUIRED', async () => {
        const prior = (await read()).snapshot;
        await pool.query('UPDATE "Branch" SET "masterRevision"=2 WHERE "id"=$1', [branchId]);
        try {
          const stale = await read(makeRegistry());
          assert.equal(stale.stale, true); assert.deepEqual(stale.snapshot, prior);
          await unchanged(async () => {
            await assert.rejects(prepare(ready), exact('ESTABLISHMENT_BRANCH_REVISION_CONFLICT'));
          });
          await rejected(() => registry.replace(adminToken, 1, { expectedRevision: headRevision,
            expectedIssuerRevision: 1, entries: entries() }, context()), 'ESTABLISHMENT_BRANCH_REVISION_CONFLICT');
          const currentEntries = side === 'ORIGIN' ? entries(2, 1) : entries(1, 2);
          const repaired = await replace(currentEntries);
          assert.deepEqual(repaired.snapshot.entries, sortedEntries(currentEntries));
          assert.equal((await read()).stale, false);
          await unchanged(async () => { flags(await prepare(ready)); });
        } finally {
          await pool.query('UPDATE "Branch" SET "masterRevision"=1 WHERE "id"=$1', [branchId]);
        }
        await replace(entries());
        assert.equal((await read()).stale, false);
        assert.deepEqual(await snapshot(localTables), fiscalBefore);
      });
    }

    await check('INACTIVE_DESTINATION_BRANCH_IS_STALE_AND_BLOCKS_GUARD_WITHOUT_REPAIR', async () => {
      const prior = (await read()).snapshot;
      await pool.query('UPDATE "Branch" SET "active"=false WHERE "id"=$1', [destinationBranch]);
      try {
        const stale = await read(); assert.equal(stale.stale, true); assert.deepEqual(stale.snapshot, prior);
        await unchanged(async () => {
          await assert.rejects(prepare(ready), exact('ESTABLISHMENT_BRANCH_REVISION_CONFLICT'));
        });
        await rejected(() => registry.replace(adminToken, 1, { expectedRevision: headRevision,
          expectedIssuerRevision: 1, entries: entries() }, context()), 'ESTABLISHMENT_BRANCH_REVISION_CONFLICT');
      } finally { await pool.query('UPDATE "Branch" SET "active"=true WHERE "id"=$1', [destinationBranch]); }
      assert.deepEqual((await read()).snapshot, prior); assert.equal((await read()).stale, false);
    });

    await check('EXACT_LOCAL_MAPPING_ORIGIN_ANCHOR_DISTINCT_DESTINATION_NO_WRITES', async () => {
      await unchanged(async () => {
        const proof = await makeRegistry().assertLocalMapping(binding, body());
        assert.deepEqual(Object.keys(proof), ['fresh']); assert.equal(typeof proof.fresh, 'function');
        assert.equal(await proof.fresh(), undefined);
      });
    });

    await check('DIRECT_GUARD_REJECTS_FOREIGN_SENDER_AND_RECIPIENT_RUC_WITHOUT_WRITES', async () => {
      for (const party of ['sender', 'recipient']) {
        const supplied = body(); supplied[party].ruc = '20000000010';
        await unchanged(async () => {
          await assert.rejects(registry.assertLocalMapping(binding, supplied), exact('ESTABLISHMENT_MAPPING_MISMATCH'));
        });
      }
    });

    const mismatches = [
      ['ORIGIN_CODE', (b, value) => { value.origin.establishmentCode = '0003'; }],
      ['ORIGIN_UBIGEO', (b, value) => { value.origin.ubigeo = '150103'; }],
      ['ORIGIN_ADDRESS', (b, value) => { value.origin.address += ' '; }],
      ['DESTINATION_CODE', (b, value) => { value.destination.establishmentCode = '0003'; }],
      ['DESTINATION_UBIGEO', (b, value) => { value.destination.ubigeo = '150103'; }],
      ['DESTINATION_ADDRESS', (b, value) => { value.destination.address += ' '; }],
      ['SAME_BRANCH', (b, value) => { value.destination = { ...value.origin }; }],
      ['SWAPPED_ENDPOINTS', (b, value) => { [value.origin, value.destination] = [value.destination, value.origin]; }],
      ['ORIGIN_NOT_ANCHOR_BRANCH', b => { b.anchor.branchId = destinationBranch; }],
    ];
    for (const [name, alter] of mismatches) {
      await check('EXACT_MAPPING_REJECTS_' + name + '_WITHOUT_WRITES', async () => {
        const suppliedBinding = structuredClone(binding), suppliedBody = body(); alter(suppliedBinding, suppliedBody);
        await unchanged(async () => {
          await assert.rejects(registry.assertLocalMapping(suppliedBinding, suppliedBody), exact('ESTABLISHMENT_MAPPING_MISMATCH'));
        });
      });
    }

    await check('GUARD_FRESH_REJECTS_EVEN_IDENTICAL_ENTRIES_AFTER_DURABLE_REPLACE', async () => {
      const proof = await unchanged(() => registry.assertLocalMapping(binding, body()));
      await replace(entries());
      await unchanged(async () => { await assert.rejects(proof.fresh(), exact('ESTABLISHMENT_MAPPING_CHANGED')); });
      await unchanged(async () => { await (await makeRegistry().assertLocalMapping(binding, body())).fresh(); });
    });

    await check('STRICT_BILLING_FINAL_GUARD_DETECTS_REPLACE_DURING_PREPARATION_NO_EXTRA_OPERATION', async () => {
      let issuerCalls = 0;
      const observedIssuer = { current: async b => {
        if (++issuerCalls === 2) await replace(entries());
        return core.issuer.current(b);
      } };
      const preparer = new BillingGuidePreparation(core.guides, observedIssuer, makeRegistry());
      const before = await snapshot();
      // Only the explicit administrative replacement may change registry tables.
      // Draft, receipts, numbers, outbox and every other table remain identical.
      await unchanged(async () => {
        await assert.rejects(prepare(ready, preparer), exact('ESTABLISHMENT_MAPPING_CHANGED'));
      }, registryTables);
      assert.equal(issuerCalls, 2);
      const after = await snapshot();
      assert.equal(after.B2bGuideEstablishmentVersion.length, before.B2bGuideEstablishmentVersion.length + 1);
      assert.equal(after.B2bGuideEstablishmentAudit.length, before.B2bGuideEstablishmentAudit.length + 1);
      assert.equal(after.B2bGuideDraftOperation.length, before.B2bGuideDraftOperation.length);
      await unchanged(async () => { flags(await prepare(ready, make().preparer)); });
    });

    await check('REVOKED_GUIDE_AUTHORIZATION_FAILS_BEFORE_LOCAL_REGISTRY_LOOKUP', async () => {
      let guardCalls = 0;
      const guarded = { assertLocalMapping: async (b, value) => {
        guardCalls++; return registry.assertLocalMapping(b, value);
      } };
      const preparer = new BillingGuidePreparation(core.guides, core.issuer, guarded);
      guideState.revoked = true;
      try {
        await unchanged(async () => { await assert.rejects(prepare(ready, preparer), exact('SYNTHETIC_REVOKED', 401)); });
      } finally { guideState.revoked = false; }
      assert.equal(guardCalls, 0);
    });

    await check('EMPTY_REPLACEMENT_WITHDRAWS_MAPPING_PRESERVES_HISTORY_AND_BLOCKS_READY_PREPARATION', async () => {
      const proof = await unchanged(() => registry.assertLocalMapping(binding, body()));
      const previous = headRevision, withdrawn = await replace([]);
      assert.equal(withdrawn.revision, previous + 1); assert.deepEqual(withdrawn.snapshot.entries, []);
      const current = await read(makeRegistry()); assert.equal(current.stale, false); assert.deepEqual(current.snapshot.entries, []);
      await unchanged(async () => {
        await assert.rejects(proof.fresh(), exact('ESTABLISHMENT_MAPPING_MISMATCH'));
        await assert.rejects(prepare(ready), exact('ESTABLISHMENT_MAPPING_MISMATCH'));
      });
      const versions = (await snapshot()).B2bGuideEstablishmentVersion;
      assert.deepEqual(versions.find(row => row.revision === 1).payload, firstSnapshot);
      await replace(entries());
      await unchanged(async () => { flags(await prepare(ready)); });
    });

    await check('DURABLE_RATE_LIMIT_EXACT_BOUNDARY_RESTART_NEW_WINDOW_AND_CLOCK_REWIND', async () => {
      await unchanged(async () => {
        const keyHash = sha('synthetic-establishment-rate-sequential'), window = 1000;
        assert.equal(await store.rate(keyHash, window, 2), true);
        assert.equal(await new PostgresGuideEstablishmentStore(client).rate(keyHash, window, 2), true);
        assert.equal(await store.rate(keyHash, window, 2), false);
        let row = (await snapshot()).B2bGuideEstablishmentRate.find(value => value.keyHash === keyHash);
        assert.equal(row.counter, 3); assert.equal(row.window, window);
        assert.equal(await store.rate(keyHash, window - 1, 2), false);
        assert.deepEqual((await snapshot()).B2bGuideEstablishmentRate.find(value => value.keyHash === keyHash), row);
        assert.equal(await store.rate(keyHash, window + 1, 2), true);
        row = (await snapshot()).B2bGuideEstablishmentRate.find(value => value.keyHash === keyHash);
        assert.equal(row.counter, 1); assert.equal(row.window, window + 1);
      }, ['B2bGuideEstablishmentRate']);
    });

    await check('DURABLE_RATE_CONCURRENT_EXACT_LIMIT_HAS_ONE_WINNER', async () => {
      await unchanged(async () => {
        const keyHash = sha('synthetic-establishment-rate-concurrent');
        const results = await Promise.all([store.rate(keyHash, 1000, 1),
          new PostgresGuideEstablishmentStore(client).rate(keyHash, 1000, 1)]);
        assert.deepEqual(results.sort(), [false, true]);
        const row = (await snapshot()).B2bGuideEstablishmentRate.find(value => value.keyHash === keyHash);
        assert.equal(row.counter, 2); assert.equal(row.window, 1000);
        assert.equal(await store.rate(keyHash, 1000, 1), false);
      }, ['B2bGuideEstablishmentRate']);
    });

    await check('AUDIT_EXACT_COMMITTED_ACTIONS_HASHED_PEERS_NO_TOKENS_AND_CONTIGUOUS_HISTORY', async () => {
      const state = await snapshot(), rows = state.B2bGuideEstablishmentAudit;
      assert.equal(rows.length, expectedAudits.length);
      const expected = new Map(expectedAudits.map(row => [row.requestId, row]));
      assert.equal(expected.size, expectedAudits.length);
      for (const { id, ...row } of rows) {
        assert.match(id, /^[a-f0-9-]{36}$/); assert.ok(expected.has(row.requestId));
        // JSONB rendering of timestamptz uses an offset; compare the same instant.
        assert.deepEqual({ ...row, at: new Date(row.at).toISOString() }, expected.get(row.requestId));
        assert.equal(JSON.stringify(row).includes('synthetic-local-peer-'), false);
        assert.equal(JSON.stringify(row).includes(adminToken), false);
        assert.equal(JSON.stringify(row).includes(guideToken), false);
      }
      const versions = state.B2bGuideEstablishmentVersion.sort((a, b) => a.revision - b.revision);
      assert.equal(versions.length, headRevision);
      for (const [index, row] of versions.entries()) {
        assert.equal(row.companyId, 1); assert.equal(row.revision, index + 1);
        const { sha256, ...unsigned } = row.payload;
        assert.equal(row.payload.revision, row.revision); assert.equal(sha256, fiscalSnapshotSha256(unsigned));
        assert.equal(row.payload.actorId, actorId); assert.equal(row.payload.authRevision, 1);
        assert.equal(row.payload.source, 'ADMIN_LOCAL_CONFIGURATION');
        assert.equal(rows.filter(audit => audit.action === 'REPLACE' && audit.revision === row.revision).length, 1);
      }
      assert.deepEqual(versions[0].payload, firstSnapshot);
      assert.deepEqual(state.B2bGuideEstablishmentHead, [{ companyId: 1, revision: headRevision }]);
    });

    await check('ALL_FISCAL_TABLES_STABLE_READY_UNCHANGED_EXACTLY_CREATE_READY_OPERATIONS_ONLY', async () => {
      assert.deepEqual(await snapshot(localTables), fiscalBefore);
      const state = await snapshot();
      assert.equal(state.B2bGuideDraft.length, 1); assert.equal(state.B2bGuideDraftOperation.length, 2);
      assert.deepEqual(state.B2bGuideDraftOperation.map(row => row.payload.action).sort(), ['CREATE', 'READY']);
      for (const row of state.B2bGuideDraftOperation) {
        assert.deepEqual(row.payload.actor, { kind: 'SERVICE', clientId, revision: 1, subjectId: null, userAuthRevision: null });
        assert.equal(JSON.stringify(row).includes(guideToken), false);
      }
      const draft = state.B2bGuideDraft[0];
      assert.equal(draft.id, ready.id); assert.equal(draft.state, 'READY'); assert.equal(draft.revision, 2);
      assert.deepEqual(draft.body, ready.body); assert.deepEqual(draft.binding, binding);
      assert.equal(draft.bodySha256, ready.bodySha256);
      assert.equal(state.SeriesCounter.length, 1); assert.equal(state.SeriesCounter[0].nextNumber, 1);
      assert.equal(state.B2bGuideDraftSeries.length, 1); assert.equal(state.B2bGuideDraftSeries[0].purpose, 'DRAFT_ONLY');
      assert.equal(state.B2bGuideDraftSeries[0].guideType, '09');
      assert.deepEqual(state.Document, []); assert.deepEqual(state.OutboxEvent, []); assert.deepEqual(state.DailySummary, []);
      await unchanged(async () => { assert.deepEqual(await make().guides.read(guideToken, 'SERVICE', binding, ready.id), ready); });
    });
  }).then(() => console.log(JSON.stringify({ result: 'PASS', groups: passed.length, passed,
    authority: 'EXPLICIT_FAKE_GLOBAL_ADMIN_AND_SERVICE_NOT_IDENTITY',
    database: 'NEW_HELPER_OWNED_LABELLED_TMPFS_NETWORK_NONE_NO_PORTS',
    officialNetwork: false, realData: false, qaRuntimeChanged: false, numberReserved: false,
    fiscalExecutionEnabled: false, transmissionAuthorized: false })))
    .catch(error => { console.error(JSON.stringify({ result: 'FAIL', stage,
      code: error?.code ?? 'ISOLATED_GUIDE_ESTABLISHMENTS_CHECK_FAILED', groups: passed.length, passed,
      officialNetwork: false, realData: false, qaRuntimeChanged: false })); process.exitCode = 1; });
}
