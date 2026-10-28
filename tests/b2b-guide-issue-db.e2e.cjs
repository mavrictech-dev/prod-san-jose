'use strict';
// Fixed synthetic runner: no caller paths, RUCs, database URLs or certificates.
// The unchanged helper owns a new labelled tmpfs, --rm, network-none PostgreSQL.
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--isolated-synthetic-only'])) {
  console.error(JSON.stringify({ result: 'FAIL', stage: 'GUARD', code: 'ISOLATED_SYNTHETIC_ONLY_REQUIRED' }));
  process.exitCode = 1;
} else {
  const { withCorrectionDatabase } = require('./helpers/correction-reservation-db.cjs');
  const passed = []; let stage = 'PREFLIGHT';
  const check = async (name, work) => { stage = name; await work(); passed.push(name); };
  withCorrectionDatabase(async ({ client, pool, local }) => {
    const { B2bGuides } = local('./dist/b2b/guide-drafts');
    const { PostgresB2bGuideStore } = local('./dist/b2b/guide-store');
    const { PrismaGuideDraftCatalogue } = local('./dist/b2b/guide-catalogue');
    const { GuideEstablishments } = local('./dist/b2b/guide-establishments');
    const { PostgresGuideEstablishmentStore } = local('./dist/b2b/guide-establishment-store');
    const { GuideGoods, guideGoodsProductSha256 } = local('./dist/b2b/guide-goods');
    const { PostgresGuideGoodsStore } = local('./dist/b2b/guide-goods-store');
    const { PostgresGuideIssueStore } = local('./dist/b2b/guide-issue-store');
    const { createCandidateGuideIssueProducer } = local('./dist/b2b/guide-issue-assembly');
    const { BillingGuideIssueCatalogue } = local('./dist/b2b/guide-issue-catalogue');
    const { fiscalSnapshotSha256: hash } = local('@factuez/sunat-core/dist/fiscal-note');
    const { validateGuideReferenceCatalogue } = local('@factuez/sunat-core/dist/fiscal-guide-catalogues');
    const { B2bSecurityError } = local('@factuez/contracts/b2b-security');
    const ruc = '20000000001', legalName = 'EMPRESA FICTICIA DE PREPARACION';
    const at = '2026-10-23T14:00:00.000Z', now = () => at;
    const ids = Object.fromEntries(['branch', 'destination', 'point', 'anchor', 'draftSeries', 'counter',
      'boundaryDraftSeries', 'boundaryCounter', 'client', 'subject', 'admin', 'product'].map(k => [k, randomUUID()]));
    const binding = { draft: { anchor: { issuerId: 1, issuerRuc: ruc, environment: 'BETA', branchId: ids.branch,
      pointId: ids.point, seriesId: ids.anchor, documentType: '01' }, guideSeriesId: ids.draftSeries, guideType: '09' }, fiscalSeriesId: ids.counter };
    const lastBinding = { draft: { ...structuredClone(binding.draft), guideSeriesId: ids.boundaryDraftSeries }, fiscalSeriesId: ids.boundaryCounter };
    const control = { revoked: false, grantRevision: 1 }, token = 'synthetic-guide-issue-only';
    const authority = { current: async (supplied, kind, b) => {
      assert.equal(supplied, token); if (control.revoked) throw new B2bSecurityError(401, 'SYNTHETIC_REVOKED');
      const subjectId = kind === 'USER' ? ids.subject : null;
      return { capability: 'BETA_GUIDE_ISSUE_LOCAL', binding: structuredClone(b), clientRevision: 1, grantRevision: control.grantRevision,
        actor: { userId: subjectId, scope: { kind: 'ASSIGNED', branchIds: [b.draft.anchor.branchId],
          emissionPointIds: [b.draft.anchor.pointId], series: [b.draft.anchor.seriesId, b.draft.guideSeriesId, b.fiscalSeriesId] },
        b2b: { kind, clientId: ids.client, revision: 1, subjectId, userAuthRevision: kind === 'USER' ? 1 : null } } };
    } };
    const draftAuthority = { current: async (_token, kind, b) => {
      const proof = await authority.current(token, kind, { draft: b, fiscalSeriesId: ids.counter });
      proof.actor.scope.series = [b.anchor.seriesId, b.guideSeriesId];
      return { actor: proof.actor, clientRevision: 1, grantRevision: control.grantRevision };
    } };
    const admin = { verify: async () => ({ id: ids.admin, authRevision: 1, stepUpVerified: true,
      scope: 'GLOBAL', permissions: ['setup.manage', 'series.manage'] }) };
    const draftCore = new B2bGuides(new PostgresB2bGuideStore(client), draftAuthority, new PrismaGuideDraftCatalogue(client), now);
    const make = (database = client) => createCandidateGuideIssueProducer({ database, authority, allowedRucs: [ruc], now });
    const core = make(); let serial = 0;
    const key = () => 'synthetic_issue_db_' + String(++serial).padStart(8, '0');
    const exact = code => error => error?.code === code;
    const body = () => ({ issueDate: '2026-10-23T13:00:00.000Z', transferDate: '2026-10-23', reasonCode: '04',
      origin: { ubigeo: '150101', address: 'ORIGEN FICTICIO', establishmentCode: '0001' },
      destination: { ubigeo: '150102', address: 'DESTINO FICTICIO', establishmentCode: '0002' },
      sender: { ruc, legalName }, recipient: { ruc, legalName }, grossWeight: '1.250', weightUnit: 'KGM',
      transport: { mode: '02', vehicle: { plate: 'ABC123', registration: 'REG00001' },
        driver: { identityType: '1', identityNumber: '00000001', firstName: 'CONDUCTOR', lastName: 'FICTICIO', license: 'A000000001' } },
      items: [{ code: 'ITEM-FICTICIO-1', description: 'BIEN FICTICIO', quantity: '2.000001', unitCode: 'NIU' }], references: [], regulatedGoods: false });
    async function ready(kind = 'SERVICE', b = binding) {
      const a = await draftCore.command(token, kind, b.draft, 'CREATE', null, key(), undefined, body());
      const d = a.response;
      const result = await draftCore.command(token, kind, b.draft, 'READY', d.id, key(), d.revision, {});
      return { schemaVersion: 'factuez.b2b.guide-issue.v1', binding: structuredClone(b), draftId: d.id,
        expectedRevision: result.response.revision, idempotencyKey: key() };
    }
    const issue = (request, owner = core, kind = 'SERVICE') => owner.issue(token, kind, request);
    const state = async () => (await pool.query(`SELECT
      (SELECT jsonb_agg(jsonb_build_array("id","nextNumber") ORDER BY "id") FROM "SeriesCounter") AS counters,
      (SELECT count(*)::int FROM "B2bGuideIssueDocument") AS documents,
      (SELECT count(*)::int FROM "B2bGuideIssueItem") AS items,
      (SELECT count(*)::int FROM "B2bGuideIssueReceipt") AS receipts,
      (SELECT count(*)::int FROM "B2bGuideIssueLocalOutbox") AS events`)).rows[0];
    async function unchanged(work) { const before = await state(); await work(); assert.deepEqual(await state(), before); }
    const rejected = (work, code) => unchanged(() => assert.rejects(work, exact(code)));
    const quote = name => '"' + name.replaceAll('"', '""') + '"';
    async function protectedState() {
      const excluded = new Set(['B2bGuideDraft', 'B2bGuideDraftOperation', 'B2bGuideIssueSeries', 'B2bGuideIssueDocument',
        'B2bGuideIssueItem', 'B2bGuideIssueReceipt', 'B2bGuideIssueLocalOutbox']);
      const tables = (await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)).rows;
      assert.ok(tables.length > 0 && tables.length <= 128); const result = {};
      for (const { tablename: name } of tables) if (!excluded.has(name)) {
        const where = name === 'SeriesCounter' ? ` WHERE t."id"<>ALL($1::uuid[])` : '';
        result[name] = (await pool.query(`SELECT COALESCE(jsonb_agg(j ORDER BY j::text),'[]'::jsonb) AS rows
          FROM (SELECT to_jsonb(t) AS j FROM ${quote(name)} t${where}) x`, where ? [[ids.counter, ids.boundaryCounter]] : [])).rows[0].rows;
      }
      return result;
    }
    async function rollback(work) {
      const c = await pool.connect(); try { await c.query('BEGIN'); await work(c); } finally { await c.query('ROLLBACK'); c.release(); }
    }
    // Fault injection remains in JS, never by disabling a DB safeguard.
    const faultDatabase = hook => ({ $transaction: (work, opts) => client.$transaction(async sql => work({
      $queryRawUnsafe: (text, ...values) => sql.$queryRawUnsafe(text, ...values),
      $executeRawUnsafe: async (text, ...values) => { const result = await sql.$executeRawUnsafe(text, ...values); await hook(text); return result; },
    }), opts) });
    let protectedBefore, first, firstRequest;
    await check('01_NEW_EMPTY_DATABASE_FIXED_CANDIDATE_DDL', async () => {
      assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'b2b_corrections_synthetic');
      assert.equal(await client.companySettings.count(), 0);
      for (const file of ['b2b-guide-drafts-schema.candidate.sql', 'b2b-guide-establishments-schema.candidate.sql',
        'b2b-guide-goods-schema.candidate.sql', 'b2b-guide-issue-schema.candidate.sql'])
        await pool.query(readFileSync(resolve(__dirname, '../services/billing-service', file), 'utf8'));
    });
    await check('02_SYNTHETIC_MASTERS_GENUINE_REGISTRIES_AND_EXPLICIT_SERIES_LINKS', async () => {
      await client.companySettings.create({ data: { id: 1, ruc, legalName, companyType: 'FICTICIO', economicActivities: [],
        taxAddress: 'DOMICILIO FICTICIO', ubigeo: '150101', contactEmails: [], environment: 'BETA', configVersion: 1 } });
      for (const [id, code] of [[ids.branch, 'ORIGEN'], [ids.destination, 'DESTINO']])
        await client.branch.create({ data: { id, companyId: 1, code, name: code } });
      await client.emissionPoint.create({ data: { id: ids.point, companyId: 1, branchId: ids.branch, code: 'CAJA-FICTICIA', name: 'FICTICIO' } });
      for (const [id, documentType, series, nextNumber] of [[ids.anchor, 'INVOICE', 'F001', 1n],
        [ids.counter, 'DESPATCH_ADVICE', 'T001', 1n], [ids.boundaryCounter, 'DESPATCH_ADVICE', 'T999', 99999999n]])
        await client.seriesCounter.create({ data: { id, companyId: 1, emissionPointId: ids.point, documentType, series, nextNumber } });
      for (const [draftSeries, counter, label] of [[ids.draftSeries, ids.counter, 'T001'], [ids.boundaryDraftSeries, ids.boundaryCounter, 'T999']]) {
        await pool.query(`INSERT INTO "B2bGuideDraftSeries" ("id","companyId","pointId","guideType","label","purpose") VALUES ($1,1,$2,'09',$3,'DRAFT_ONLY')`, [draftSeries, ids.point, label]);
        await pool.query(`INSERT INTO "B2bGuideIssueSeries" ("draftSeriesId","fiscalSeriesId","companyId") VALUES ($1,$2,1)`, [draftSeries, counter]);
      }
      await new GuideEstablishments(new PostgresGuideEstablishmentStore(client), admin, now).replace('synthetic-admin', 1,
        { expectedRevision: 0, expectedIssuerRevision: 1, entries: [
          { branchId: ids.branch, branchRevision: 1, ...body().origin }, { branchId: ids.destination, branchRevision: 1, ...body().destination }] },
        { requestId: randomUUID(), peer: 'synthetic-local-only' });
      const product = { id: ids.product, sku: 'ITEM-FICTICIO-1', description: 'BIEN FICTICIO', category: 'BIEN',
        unitCode: 'NIU', sunatProductCode: null, active: true, updatedAt: at };
      await client.fuelProduct.create({ data: { ...product, updatedAt: new Date(at), taxAffectationCode: '10' } });
      const unsigned = { schemaVersion: 'factuez.guide-reference-catalogue.v1', version: 'synthetic-issue-v1',
        sourceUrl: 'https://www.sunat.gob.pe/synthetic-reference-only', sourceSha256: createHash('sha256').update('FICTIONAL').digest('hex'),
        units: ['NIU'], weightUnits: ['KGM'], ubigeos: ['150101', '150102'], referenceStatus: 'LOCAL_REFERENCE_NOT_OFFICIAL' };
      const catalogue = validateGuideReferenceCatalogue({ ...unsigned, sha256: hash(unsigned) });
      await new GuideGoods(new PostgresGuideGoodsStore(client), admin, now).replace('synthetic-admin', 1,
        { expectedRevision: 0, expectedIssuerRevision: 1, catalogue, entries: [{ productId: ids.product,
          productSha256: guideGoodsProductSha256(product), classification: 'NON_REGULATED', rationale: 'DECLARACION FICTICIA LOCAL' }] },
        { requestId: randomUUID(), peer: 'synthetic-local-only' });
      protectedBefore = await protectedState();
    });
    await check('03_REAL_PRODUCER_COMMITS_NUMBER_HEADER_ITEMS_RECEIPT_LOCAL_EVENT_TOGETHER', async () => {
      firstRequest = await ready(); first = await issue(firstRequest); assert.equal(first.replayed, false);
      assert.equal(first.receipt.snapshot.fullNumber, 'T001-1'); assert.equal(first.receipt.actor.subjectId, null);
      const s = await state(); assert.equal(s.documents, 1); assert.equal(s.items, 1); assert.equal(s.receipts, 1); assert.equal(s.events, 1);
      assert.equal((await client.seriesCounter.findUnique({ where: { id: ids.counter } })).nextNumber, 2n);
      assert.equal(first.receipt.snapshot.officialCdrVerified, false); assert.equal(first.receipt.snapshot.transmissionAuthorized, false);
      assert.deepEqual(first.receipt.snapshot.body, body());
    });
    await check('04_RESTART_AND_RETRY_RETURN_SAME_IMMUTABLE_RECEIPT', () => unchanged(async () => {
      const r = await issue(firstRequest, make()); assert.equal(r.replayed, true); assert.deepEqual(r.receipt, first.receipt);
    }));
    await check('05_KEY_REUSE_WITH_DIFFERENT_DRAFT_IS_TYPED_CONFLICT_WITHOUT_DISCLOSURE', async () => {
      const r = await ready(); r.idempotencyKey = firstRequest.idempotencyKey;
      await rejected(() => issue(r), 'IDEMPOTENCY_CONFLICT');
    });
    await check('06_DIFFERENT_KEY_CANNOT_NUMBER_THE_SAME_DRAFT_AGAIN', () =>
      rejected(() => issue({ ...firstRequest, idempotencyKey: key() }), 'GUIDE_ALREADY_PREPARED'));
    await check('07_CONCURRENT_SAME_KEY_ONE_NUMBER_ONE_RECEIPT', async () => {
      const r = await ready(), before = await state(); const results = await Promise.all([issue(r), issue(r), issue(r)]);
      assert.equal(results.filter(x => !x.replayed).length, 1); assert.equal(new Set(results.map(x => x.receipt.id)).size, 1);
      assert.equal((await state()).documents, before.documents + 1);
    });
    await check('08_CONCURRENT_DIFFERENT_DRAFTS_GET_DISTINCT_ADJACENT_NUMBERS', async () => {
      const a = await ready(), b = await ready(), results = await Promise.all([issue(a), issue(b)]);
      const numbers = results.map(r => Number(r.receipt.snapshot.number)).sort((x, y) => x - y);
      assert.equal(numbers[1], numbers[0] + 1);
    });
    await check('09_GENUINE_USER_PROVENANCE_NOT_FABRICATED_SERVICE_ADMIN', async () => {
      const r = await issue(await ready('USER'), core, 'USER'); assert.equal(r.receipt.actor.subjectId, ids.subject);
      assert.equal(r.receipt.actor.kind, 'USER'); assert.equal(r.receipt.actor.userAuthRevision, 1);
    });
    await check('10_FAULT_AFTER_COUNTER_CAS_ROLLS_BACK_ALL_WRITES', async () => {
      const r = await ready(), broken = make(faultDatabase(async text => { if (text.includes('UPDATE "SeriesCounter"')) throw new Error('SYNTHETIC_FAILURE'); }));
      await rejected(() => issue(r, broken), 'GUIDE_ISSUE_STORE_UNAVAILABLE');
    });
    await check('11_FAULT_AFTER_LOCAL_EVENT_ROLLS_BACK_COMPLETE_AGGREGATE', async () => {
      const r = await ready(), broken = make(faultDatabase(async text => { if (text.includes('INSERT INTO "B2bGuideIssueLocalOutbox"')) throw new Error('SYNTHETIC_FAILURE'); }));
      await rejected(() => issue(r, broken), 'GUIDE_ISSUE_STORE_UNAVAILABLE');
    });
    await check('12_REVOCATION_AFTER_WRITES_PREVENTS_COMMIT', async () => {
      const r = await ready(), revoked = make(faultDatabase(async text => { if (text.includes('INSERT INTO "B2bGuideIssueLocalOutbox"')) control.revoked = true; }));
      try { await rejected(() => issue(r, revoked), 'SYNTHETIC_REVOKED'); } finally { control.revoked = false; }
    });
    await check('13_REVOCATION_AFTER_COMMIT_RETURNS_NO_DATA_BUT_RETRY_RECOVERS', async () => {
      const r = await ready(), before = await state(), db = { $transaction: async (work, opts) => {
        const value = await client.$transaction(work, opts); control.revoked = true; return value;
      } };
      try { await assert.rejects(issue(r, make(db)), exact('SYNTHETIC_REVOKED')); } finally { control.revoked = false; }
      assert.equal((await state()).documents, before.documents + 1);
      await unchanged(async () => { assert.equal((await issue(r)).replayed, true); });
    });
    await check('14_INACTIVE_EXPLICIT_MAPPING_BLOCKS_NEW_NUMBER_NOT_HISTORY', async () => {
      const r = await ready(); await pool.query(`UPDATE "B2bGuideIssueSeries" SET "active"=false,"revision"="revision"+1 WHERE "draftSeriesId"=$1`, [ids.draftSeries]);
      try { await rejected(() => issue(r), 'GUIDE_ISSUE_SERIES_MAPPING_INVALID'); await unchanged(async () => assert.equal((await issue(firstRequest)).replayed, true)); }
      finally { await pool.query(`UPDATE "B2bGuideIssueSeries" SET "active"=true,"revision"="revision"+1 WHERE "draftSeriesId"=$1`, [ids.draftSeries]); }
    });
    await check('15_EDITED_PRODUCT_FAILS_LOCAL_POLICY_WITHOUT_SILENT_RECLASSIFICATION', async () => {
      const r = await ready(); await pool.query(`UPDATE "FuelProduct" SET "description"='BIEN CAMBIADO' WHERE "id"=$1`, [ids.product]);
      try { await unchanged(() => assert.rejects(issue(r), e => e?.status === 409)); }
      finally { await pool.query(`UPDATE "FuelProduct" SET "description"='BIEN FICTICIO' WHERE "id"=$1`, [ids.product]); }
    });
    await check('16_LAST_NUMBER_ALLOCATED_ONCE_EXHAUSTION_NEVER_RESETS', async () => {
      // Genuine metadata authorization remains valid after this transaction
      // consumes the last number; business availability is checked INSIDE it.
      const catalogue = new BillingGuideIssueCatalogue(client);
      const paired = createCandidateGuideIssueProducer({ database: client, allowedRucs: [ruc], now,
        authority: { current: async (token, kind, b, action) => {
          await catalogue.validate([b], action); return authority.current(token, kind, b);
        } } });
      const command = await ready('SERVICE', lastBinding);
      const r = await issue(command, paired); assert.equal(r.receipt.snapshot.number, '99999999');
      assert.equal((await client.seriesCounter.findUnique({ where: { id: ids.boundaryCounter } })).nextNumber, 100000000n);
      await unchanged(async () => { const replay = await issue(command, paired); assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, r.receipt); });
      const exhausted = await ready('SERVICE', lastBinding);
      await rejected(() => issue(exhausted, paired), 'GUIDE_ISSUE_COUNTER_INVALID');
    });
    await check('17_PHYSICAL_HEADER_ITEM_RECEIPT_EVENT_IMMUTABILITY_AND_DRAFT_FREEZE', async () => {
      for (const [table, column] of [['B2bGuideIssueDocument', 'id'], ['B2bGuideIssueItem', 'position'],
        ['B2bGuideIssueReceipt', 'id'], ['B2bGuideIssueLocalOutbox', 'documentId']]) {
        await assert.rejects(pool.query(`UPDATE ${quote(table)} SET ${quote(column)}=${quote(column)}`));
        await assert.rejects(pool.query(`DELETE FROM ${quote(table)}`));
        await assert.rejects(pool.query(`TRUNCATE ${quote(table)} CASCADE`));
      }
      await assert.rejects(pool.query(`UPDATE "B2bGuideDraft" SET "state"='CANCELLED',"revision"="revision"+1 WHERE "id"=$1`, [firstRequest.draftId]));
    });
    await check('18_INCOMPLETE_HEADER_CANNOT_COMMIT_WITHOUT_ITEMS_RECEIPT_AND_EVENT', async () => {
      const r = await ready(), h = structuredClone(first.receipt.snapshot);
      h.documentId = randomUUID(); h.operationId = randomUUID(); h.draftId = r.draftId;
      h.number = String((await client.seriesCounter.findUnique({ where: { id: ids.counter } })).nextNumber); h.fullNumber = 'T001-' + h.number;
      await unchanged(async () => {
        const c = await pool.connect(); try {
          await c.query('BEGIN'); await c.query(`INSERT INTO "B2bGuideIssueDocument"
            ("id","operationId","companyId","issuerRuc","type","draftSeriesId","fiscalSeriesId","draftId","draftRevision","clientId","actorKey","binding","series","number","fullNumber","itemCount","snapshot","snapshotSha256")
            VALUES ($1,$2,1,$3,'09',$4,$5,$6,2,$7,'SERVICE:-',$8::jsonb,'T001',$9,$10,1,$11::jsonb,$12)`,
          [h.documentId, h.operationId, ruc, ids.draftSeries, ids.counter, r.draftId, ids.client, JSON.stringify(binding), h.number, h.fullNumber, JSON.stringify(h), hash(h)]);
          await assert.rejects(c.query('COMMIT'));
        } finally { await c.query('ROLLBACK'); c.release(); }
      });
    });
    await check('19_FOREIGN_RUC_CONTEXT_CANNOT_READ_OR_NUMBER_OWNED_DRAFT', async () => {
      const r = { ...firstRequest, binding: structuredClone(binding), idempotencyKey: key() };
      r.binding.draft.anchor.issuerRuc = '20000000010';
      // The producer's explicit allowlist blocks before any draft lookup.
      await rejected(() => issue(r), 'GUIDE_ISSUE_ISSUER_NOT_ENABLED');
    });
    await check('20_SWALLOWED_SQL_FAILURE_POISONS_TRANSACTION_AND_ROLLS_BACK', async () => {
      const r = await ready(), db = { $transaction: (work, opts) => client.$transaction(async sql => {
        // Use the actual transaction object and store poison boundary; no trigger/role changes.
        return work(sql);
      }, opts) };
      const realStore = new PostgresGuideIssueStore(db), scope = { binding, draftId: r.draftId, clientId: ids.client, actorKey: 'SERVICE:-', keySha256: 'a'.repeat(64) };
      await rejected(() => realStore.transaction(scope, async tx => { try { await tx.sql.$queryRawUnsafe('SELECT 1/0'); } catch {} return 'MASKED'; }), 'GUIDE_ISSUE_STORE_UNAVAILABLE');
    });
    await check('21_FULL_CANDIDATE_RECEIPT_READ_VALIDATES_PHYSICAL_ITEMS_AND_EVENT', async () => {
      const r = await issue(firstRequest); assert.deepEqual(r.receipt, first.receipt);
      await rollback(async c => {
        await c.query(`INSERT INTO "B2bGuideIssueItem" ("documentId","position","payload") VALUES ($1,2,$2::jsonb)`,
          [first.receipt.snapshot.documentId, JSON.stringify(body().items[0])]);
        await assert.rejects(c.query('SET CONSTRAINTS ALL IMMEDIATE'));
      });
    });
    await check('22_ALL_UNRELATED_TABLES_AND_ANCHOR_COUNTER_UNCHANGED_NO_OFFICIAL_OUTBOX', async () => {
      assert.deepEqual(await protectedState(), protectedBefore);
      const s = await state(); assert.equal(s.documents, s.receipts); assert.equal(s.documents, s.events); assert.equal(s.documents, s.items);
      const local = (await pool.query('SELECT "snapshot" FROM "B2bGuideIssueDocument"')).rows;
      for (const { snapshot: p } of local) { assert.equal(p.numberReserved, true); assert.equal(p.candidateOnly, true);
        for (const f of ['fiscalExecutionEnabled', 'transmissionAuthorized', 'authorizedForTransfer', 'officialRulesValidated', 'officialCdrVerified']) assert.equal(p[f], false); }
      assert.equal(await client.outboxEvent.count(), 0); assert.equal(await client.document.count(), 0);
    });
    await check('23_OPERATION_LOOKUP_CHECKS_COMPLETE_AGGREGATE_WITHOUT_RESERVATION', () => unchanged(async () => {
      const found = await core.read(token, 'SERVICE', binding, firstRequest.draftId, first.receipt.id);
      assert.deepEqual(found, first.receipt);
      await assert.rejects(core.read(token, 'SERVICE', binding, firstRequest.draftId, randomUUID()), exact('GUIDE_ISSUANCE_NOT_FOUND'));
      await assert.rejects(core.read(token, 'SERVICE', binding, randomUUID(), first.receipt.id), exact('GUIDE_ISSUANCE_NOT_FOUND'));
    }));
    await check('24_REAL_OWNER_CATALOGUE_DISTINGUISHES_ACTIVE_ISSUE_FROM_HISTORICAL_READ', async () => {
      const catalogue = new BillingGuideIssueCatalogue(client);
      await catalogue.validate([binding], 'ISSUE'); await catalogue.validate([binding], 'READ');
      await catalogue.validate([lastBinding], 'ISSUE'); // exhaustion is not a grant revocation
      await catalogue.validate([lastBinding], 'READ');
      await pool.query(`UPDATE "B2bGuideIssueSeries" SET "active"=false,"revision"="revision"+1 WHERE "draftSeriesId"=$1`, [ids.draftSeries]);
      try { await catalogue.validate([binding], 'READ');
        await assert.rejects(catalogue.validate([binding], 'ISSUE'), exact('GUIDE_ISSUE_CONTEXT_NOT_FOUND'));
        await unchanged(async () => assert.deepEqual(await core.read(token, 'SERVICE', binding, firstRequest.draftId, first.receipt.id), first.receipt));
      } finally { await pool.query(`UPDATE "B2bGuideIssueSeries" SET "active"=true,"revision"="revision"+1 WHERE "draftSeriesId"=$1`, [ids.draftSeries]); }
    });
    await check('25_FOREIGN_CLIENT_CANNOT_READ_OPERATION_EVEN_WITH_SAME_BINDING', async () => {
      const ownerId = ids.client; ids.client = randomUUID();
      try { await unchanged(() => assert.rejects(core.read(token, 'SERVICE', binding, firstRequest.draftId, first.receipt.id), exact('GUIDE_ISSUANCE_NOT_FOUND'))); }
      finally { ids.client = ownerId; }
      assert.deepEqual(await protectedState(), protectedBefore);
    });
  }).then(() => console.log(JSON.stringify({ result: 'PASS', groups: passed.length, checks: passed,
    target: 'NEW_LABELLED_TMPFS_NETWORK_NONE_DATABASE_ONLY', officialTransmission: false, deployed: false })))
    .catch(error => { console.error(JSON.stringify({ result: 'FAIL', stage,
      code: typeof error?.code === 'string' ? error.code : 'ISOLATED_GUIDE_ISSUE_REHEARSAL_FAILED' })); process.exitCode = 1; });
}
