'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { withCarrierGuideOwnerFixture } = require('./helpers/carrier-guide-owner-db.cjs');
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--isolated-synthetic-only'])) {
  console.error(JSON.stringify({ result: 'FAIL', stage: 'GUARD', code: 'ISOLATED_SYNTHETIC_ONLY_REQUIRED' })); process.exitCode = 1;
} else {
  const passed = []; let stage = 'PREFLIGHT';
  const check = async (name, work) => { stage = name; await work(); passed.push(name); };
  withCarrierGuideOwnerFixture(async f => {
    const { owner, token, pool, body, binding, ids, control } = f;
    const issue = (request, instance = owner, kind = 'SERVICE') => instance.issue(token, kind, request);
    const unchanged = async work => { const before = await f.state(); await work(); assert.deepEqual(await f.state(), before); };
    const rejected = (work, code) => unchanged(() => assert.rejects(work, e => e.code === code || e.message === code));
    await check('real_public09_record_and_artifact_ingestion', async () => {
      const ingested = await f.ingest(); assert.equal(ingested.projectionSha256, f.hash(f.reference));
      const rows = (await pool.query('SELECT "ownerSnapshot","projection","signedXml","cdrXml" FROM "CarrierReference09Version"')).rows;
      assert.equal(rows.length, 1); assert.deepEqual(rows[0].ownerSnapshot, f.ownerSnapshot); assert.deepEqual(rows[0].projection, f.reference);
      assert.ok(rows[0].signedXml.equals(f.artifacts.signedXml)); assert.ok(rows[0].cdrXml.equals(f.artifacts.cdrXml));
    });
    let request, first, lastRequest, lastIssued;
    await check('full31_numbered_snapshot_receipt_bytes_and_items', async () => {
      request = await f.ready(); first = await issue(request);
      assert.deepEqual(first.snapshot.body, body); assert.equal(first.snapshot.fullNumber, 'VQ31-1');
      assert.equal(first.snapshotSha256, f.hash(first.snapshot)); assert.equal(first.snapshot.bodySha256, f.hash(body));
      assert.equal(first.snapshot.numberReserved, true); assert.equal(first.snapshot.officialCdrVerified, false);
      const row = (await pool.query('SELECT "payload","responseBytes" FROM "CarrierGuideReceipt" WHERE "documentId"=$1', [first.snapshot.documentId])).rows[0];
      assert.deepEqual(row.payload.response, first); assert.ok(row.responseBytes.equals(Buffer.from(JSON.stringify(first))));
      assert.deepEqual(await f.state(), { counter: '2', documents: 1, items: 2, receipts: 1, events: 1, legacy_documents: 0, legacy_events: 0 });
      assert.deepEqual(await owner.read(token, 'SERVICE', f.scope(first)), first);
      const xml = await owner.buildXml(token, 'SERVICE', f.scope(first)); assert.equal(xml.snapshotSha256, first.snapshotSha256);
      assert.equal(xml.documentType, '31'); assert.ok(xml.xml.includes('TUC00031')); assert.ok(xml.xml.includes('2.0000000001'));
      const artifactSource = await owner.artifactCurrent(f.scope(first), { token, kind: 'SERVICE' }, 'ISSUE');
      assert.deepEqual(artifactSource.issuance, first); assert.deepEqual(artifactSource.reference.snapshot, f.reference);
      assert.equal(artifactSource.authorizationSha256, f.hash(await f.authority.current(token, 'SERVICE', binding, 'ISSUE')));
    });
    await check('replay_is_stable_and_consumes_no_number', () => unchanged(async () => {
      const replay = await issue(request, f.makeOwner()); assert.deepEqual(replay, { ...first, replayed: true });
    }));
    await check('same_key_and_separate_keys_concurrency', async () => {
      const same = await f.ready(); const all = await Promise.all(Array.from({ length: 4 }, () => issue(same, f.makeOwner())));
      assert.equal(all.filter(r => !r.replayed).length, 1); assert.equal(new Set(all.map(r => r.operationId)).size, 1);
      const requests = await Promise.all(Array.from({ length: 3 }, () => f.ready()));
      const results = await Promise.all(requests.map(r => issue(r, f.makeOwner())));
      assert.equal(new Set(results.map(r => r.snapshot.number)).size, 3); assert.equal((await f.state()).counter, '6');
    });
    await check('idempotency_cross_draft_and_changed_revision_rejected', async () => {
      const other = await f.ready(); other.idempotencyKey = request.idempotencyKey;
      await rejected(() => issue(other), 'IDEMPOTENCY_CONFLICT');
      await rejected(() => issue({ ...request, expectedRevision: '"v2"' }), 'IDEMPOTENCY_CONFLICT');
      await rejected(() => issue({ ...request, idempotencyKey: 'synthetic_other_key_00001' }), 'CARRIER_GUIDE_ALREADY_PREPARED');
    });
    await check('service_user_provenance_and_read_is_independent', async () => {
      const r = await issue(await f.ready('USER'), owner, 'USER');
      const stored = (await pool.query('SELECT "payload" FROM "CarrierGuideReceipt" WHERE "documentId"=$1', [r.snapshot.documentId])).rows[0].payload;
      assert.deepEqual(stored.actor, { kind: 'USER', clientId: ids.client, revision: 1, subjectId: ids.subject, userAuthRevision: 2 });
      control.issueAllowed = false;
      assert.deepEqual(await owner.read(token, 'USER', f.scope(r)), r);
      await rejected(() => owner.artifactCurrent(f.scope(r), { token, kind: 'USER' }, 'ISSUE'), 'SYNTHETIC_AUTHORITY_DENIED');
      control.issueAllowed = true; control.readAllowed = false;
      await rejected(() => owner.read(token, 'USER', f.scope(r)), 'SYNTHETIC_AUTHORITY_DENIED'); control.readAllowed = true;
      await rejected(() => owner.read(token, 'SERVICE', f.scope(r)), 'CARRIER_GUIDE_OPERATION_NOT_FOUND');
    });
    await check('unknown_inputs_and_private02_relabelling_rejected', async () => {
      await assert.rejects(() => f.ingest({ verify: async () => ({ verified: true }) }));
      await rejected(() => issue({ ...request, approved: true }), 'INVALID_CARRIER_GUIDE_CONTRACT');
      await assert.rejects(() => owner.persistReadyDraft(token, 'SERVICE', { binding, draftId: randomUUID(), body: { ...body, transport: { mode: '02' } } }));
    });
    await check('revocation_after_actual_counter_and_bundle_write_rolls_back', async () => {
      const r = await f.ready();
      const bad = f.makeOwner(f.validator, f.faultDatabase(async sql => { if (sql.includes('INSERT INTO "CarrierGuideLocalOutbox"')) control.revoked = true; }));
      await rejected(() => issue(r, bad), 'SYNTHETIC_AUTHORITY_DENIED'); control.revoked = false;
      const recovered = await issue(r); assert.equal(recovered.replayed, false);
      await unchanged(async () => assert.equal((await issue(r)).operationId, recovered.operationId));
    });
    await check('client_grant_and_user_auth_fresh_fences_roll_back', async () => {
      for (const field of ['clientRevision', 'grantRevision', 'userAuthRevision']) {
        const r = await f.ready('USER'), before = control[field];
        const bad = f.makeOwner(f.validator, f.faultDatabase(async sql => { if (sql.includes('INSERT INTO "CarrierGuideLocalOutbox"')) control[field]++; }));
        await rejected(() => issue(r, bad, 'USER'), 'CARRIER_GUIDE_AUTHORITY_CHANGED'); control[field] = before;
      }
    });
    await check('crypto_revocation_rolls_back_and_blocks_replay_read_artifacts', async () => {
      const r = await f.ready();
      const bad = f.makeOwner(f.validator, f.faultDatabase(async sql => { if (sql.includes('INSERT INTO "CarrierGuideLocalOutbox"')) control.cryptoRevoked = true; }));
      try {
        await unchanged(() => assert.rejects(() => issue(r, bad)));
        await unchanged(() => assert.rejects(() => issue(request)));
        await unchanged(() => assert.rejects(() => owner.read(token, 'SERVICE', f.scope(first))));
        await unchanged(() => assert.rejects(() => owner.artifactCurrent(f.scope(first), { token, kind: 'SERVICE' }, 'ISSUE')));
      } finally { control.cryptoRevoked = false; }
    });
    await check('scoped_access_revocation_and_cross_binding_rejected', async () => {
      await pool.query('UPDATE "CarrierReference09Access" SET "active"=false,"revision"="revision"+1');
      try { await unchanged(() => assert.rejects(() => issue(request))); }
      finally { await pool.query('UPDATE "CarrierReference09Access" SET "active"=true,"revision"="revision"+1'); }
      const scope = f.scope(first); scope.binding = structuredClone(scope.binding); scope.binding.draft.anchor.branchId = randomUUID();
      await rejected(() => owner.read(token, 'SERVICE', scope), 'CARRIER_GUIDE_OPERATION_NOT_FOUND');
      const old = ids.client; ids.client = randomUUID();
      try { await rejected(() => owner.read(token, 'SERVICE', f.scope(first)), 'CARRIER_GUIDE_OPERATION_NOT_FOUND'); }
      finally { ids.client = old; }
    });
    await check('physical_immutability_and_complete_bundle_constraints', async () => {
      for (const table of ['CarrierGuideDraft', 'CarrierGuideDocument', 'CarrierGuideReferenceBinding', 'CarrierGuideItem', 'CarrierGuideReceipt', 'CarrierGuideLocalOutbox', 'CarrierReference09Version', 'CarrierGuideRegistryVersion']) {
        await assert.rejects(() => pool.query(`DELETE FROM "${table}"`), /CARRIER_GUIDE_IMMUTABLE/);
        await assert.rejects(() => pool.query(`TRUNCATE "${table}" CASCADE`), /CARRIER_GUIDE_IMMUTABLE/);
      }
      await assert.rejects(() => pool.query('UPDATE "CarrierReference09Access" SET "active"=false'), /CARRIER_GUIDE_REVISION_REQUIRED/);
      const receiptRow = (await pool.query('SELECT "clientId","actorKey","keySha256","requestSha256","payload","responseBytes" FROM "CarrierGuideReceipt" WHERE "documentId"=$1', [first.snapshot.documentId])).rows[0];
      await unchanged(() => assert.rejects(() => pool.query(`INSERT INTO "CarrierGuideReceipt" ("documentId","clientId","actorKey","keySha256","requestSha256","payload","responseBytes")
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [first.snapshot.documentId, receiptRow.clientId, receiptRow.actorKey, receiptRow.keySha256,
        receiptRow.requestSha256, receiptRow.payload, Buffer.concat([Buffer.alloc(262145, 32), receiptRow.responseBytes])]), e => e.code === '23514'));
      const draft = await f.ready(), fake = structuredClone(first.snapshot);
      fake.documentId = randomUUID(); fake.operationId = randomUUID(); fake.draftId = draft.draftId; fake.number = '999'; fake.fullNumber = 'VQ31-999';
      await unchanged(async () => {
        const sql = await pool.connect();
        try {
          await sql.query('BEGIN');
          await sql.query('UPDATE "SeriesCounter" SET "nextNumber"=1000 WHERE "id"=$1', [ids.counter]);
          await sql.query(`INSERT INTO "CarrierGuideDocument" ("documentId","operationId","draftId","companyId","issuerRuc","draftSeriesId","fiscalSeriesId","binding","series","number","snapshot","snapshotSha256")
            VALUES ($1,$2,$3,1,$4,$5,$6,$7,'VQ31',999,$8,$9)`, [fake.documentId, fake.operationId, fake.draftId, f.carrier.ruc,
            ids.guide, ids.counter, binding, fake, f.hash(fake)]);
          await assert.rejects(() => sql.query('COMMIT'));
        } finally { await sql.query('ROLLBACK'); sql.release(); }
      });
    });
    await check('counter_mapping_registry_catalogue_and_limits_fail_closed', async () => {
      const r = await f.ready();
      await pool.query('UPDATE "CarrierGuideSeries" SET "active"=false,"revision"="revision"+1');
      try { await rejected(() => issue(r), 'CARRIER_GUIDE_MASTERS_INVALID'); }
      finally { await pool.query('UPDATE "CarrierGuideSeries" SET "active"=true,"revision"="revision"+1'); }
      await pool.query('UPDATE "CompanySettings" SET "configVersion"="configVersion"+1 WHERE "id"=1');
      try { await rejected(() => issue(r), 'CARRIER_GUIDE_REGISTRY_STALE_OR_DISABLED'); }
      finally { await pool.query('UPDATE "CompanySettings" SET "configVersion"="configVersion"-1 WHERE "id"=1'); }
      const disabledRegistry = structuredClone(f.registry); disabledRegistry.revision = 2;
      disabledRegistry.catalogue.units = ['ZZ'];
      const { sha256: _oldCatalogueHash, ...catalogueUnsigned } = disabledRegistry.catalogue;
      disabledRegistry.catalogue.sha256 = f.hash(catalogueUnsigned);
      const { sha256: _oldRegistryHash, ...registryUnsigned } = disabledRegistry;
      disabledRegistry.sha256 = f.hash(registryUnsigned);
      await pool.query('INSERT INTO "CarrierGuideRegistryVersion" ("companyId","revision","payload") VALUES (1,2,$1)', [disabledRegistry]);
      await pool.query('UPDATE "CarrierGuideRegistryHead" SET "revision"=2 WHERE "companyId"=1');
      try { await rejected(() => issue(r), 'CARRIER_GUIDE_CATALOGUE_DISABLED'); }
      finally {
        const restored = structuredClone(f.registry); restored.revision = 3;
        const { sha256: _sha, ...unsigned } = restored; restored.sha256 = f.hash(unsigned);
        await pool.query('INSERT INTO "CarrierGuideRegistryVersion" ("companyId","revision","payload") VALUES (1,3,$1)', [restored]);
        await pool.query('UPDATE "CarrierGuideRegistryHead" SET "revision"=3 WHERE "companyId"=1');
      }
      await pool.query('UPDATE "SeriesCounter" SET "nextNumber"=99999999 WHERE "id"=$1', [ids.counter]);
      const last = await issue(r); assert.equal(last.snapshot.number, '99999999'); assert.equal((await f.state()).counter, '100000000');
      lastRequest = r; lastIssued = last;
      await unchanged(async () => assert.equal((await issue(r)).operationId, last.operationId));
      await assert.rejects(() => f.ready(), e => e.code === 'CARRIER_GUIDE_MASTERS_INVALID');
      assert.equal((await f.state()).legacy_documents, 0); assert.equal((await f.state()).legacy_events, 0);
    });
    await check('reference_version_is_pinned_and_replacement_blocks_prior_owner', async () => {
      const replacement = await f.ingest(); assert.equal(replacement.revision, 2);
      await unchanged(() => assert.rejects(() => issue(lastRequest)));
      await rejected(() => owner.read(token, 'SERVICE', f.scope(lastIssued)), 'CARRIER_GUIDE_REFERENCE_UNVERIFIED');
      await rejected(() => owner.artifactCurrent(f.scope(lastIssued), { token, kind: 'SERVICE' }, 'ISSUE'), 'CARRIER_GUIDE_REFERENCE_UNVERIFIED');
    });
    console.log(JSON.stringify({ result: 'PASS', checks: passed, limitation: 'PG owner/core suite uses explicit reference crypto test double; real ephemeral crypto integration is separate. No official rules/CDR/transmission.' }));
  }).catch(error => { console.error(JSON.stringify({ result: 'FAIL', stage, code: error?.code ?? error?.message ?? 'CARRIER_OWNER_DB_FAILED' })); process.exitCode = 1; });
}
