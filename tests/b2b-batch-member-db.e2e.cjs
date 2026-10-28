'use strict';
// Storage/serialization integration, synthetic verifier and Identity/step-up ports only.
// Does not test PKI, certify official acceptance, activate routes or contact fiscal networks.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { randomUUID } = require('node:crypto');
const { withCorrectionDatabase } = require('./helpers/correction-reservation-db.cjs');
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--isolated-synthetic-only'])) throw new Error('ISOLATED_SYNTHETIC_ONLY_REQUIRED');
const AS_OF = '2026-10-03T18:00:00Z', clone = value => structuredClone(value), passed = [];
let stage = 'START';
const check = async (name, work) => { stage = name; await work(); passed.push(name); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

withCorrectionDatabase(async ({ pool, local, client }) => {
  await pool.query(readFileSync(resolve(__dirname, '../services/billing-service/b2b-batch-member-schema.candidate.sql'), 'utf8'));
  const { PostgresBatchMemberOwner } = local('./dist/b2b/batch-member-postgres');
  const { createDurableBatchMemberProducer } = local('./dist/b2b/batch-member-durable-producer');
  const { B2bBatchMemberAuthority } = local('./dist/b2b/batch-member-authority');
  const { fiscalSnapshotSha256: hash, buildFiscalNoteSnapshot } = local('@factuez/sunat-core/dist/fiscal-note');
  const { calculateDocumentTotals } = local('@factuez/sunat-core');
  const { buildFiscalBatchSnapshot, buildFiscalBatchUbl } = local('@factuez/sunat-core/dist/fiscal-batch');
  const now = () => AS_OF, subject = { kind: 'SERVICE', clientId: randomUUID(), subjectId: null };
  const branchId = randomUUID(), pointId = randomUUID(), series03 = randomUUID(), series01 = randomUUID(), series07 = randomUUID();
  const scope = { environment: 'BETA', issuerRuc: '20100070970', companyId: 99, branchId };
  const material = new Map(), revisions = new Map(), adminId = randomUUID();
  let sequence = 0, identityRevision = 1, identityAllowed = true, adminAllowed = true, adminCalls = 0, failAdminAt = 0;
  const evidence = { verifySignedVersion: async handle => {
    if (!material.has(handle)) throw new Error('PRIVATE_ARTIFACT_PATH_MUST_NOT_ESCAPE');
    return clone(material.get(handle));
  } };
  const identity = { current: async who => {
    if (!identityAllowed) throw new Error('PRIVATE_IDENTITY_DETAIL');
    return { subject: clone(who), clientRevision: identityRevision, userAuthRevision: who.kind === 'USER' ? 2 : null, checkedAt: AS_OF };
  } };
  const admin = { authorizeStepUp: async (handle, policySha256) => {
    adminCalls++;
    if (!adminAllowed || handle !== 'synthetic-owner-step-up' || adminCalls === failAdminAt) throw new Error('PRIVATE_ADMIN_DETAIL');
    return { adminId, authRevision: 1, policySha256, checkedAt: AS_OF };
  } };
  const makeOwner = (database = pool) => new PostgresBatchMemberOwner(database, evidence, identity, admin, now);
  const owner = makeOwner(), producer = createDurableBatchMemberProducer(owner, now);
  const totals = price => calculateDocumentTotals([{ productCode: 'SYNTHETIC', description: 'BIEN SINTETICO', unitCode: 'NIU', quantity: '2', unitPriceWithTax: price,
    taxAffectationCode: '10', igvRate: '18' }]);
  function snapshot(type = '03') {
    const number = String(++sequence), series = type === '03' ? 'BQ01' : 'FQ01';
    return { environment: 'BETA', companyId: scope.companyId, branchId, documentId: randomUUID(), documentTypeCode: type, series, number, fullNumber: `${series}-${number}`,
      issueDate: '2026-10-02T16:00:00Z', currencyCode: 'PEN', operationTypeCode: '0101',
      ...(type === '01' ? { paymentTerms: { type: 'CONTADO' } } : {}),
      issuer: { identityType: '6', identityNumber: scope.issuerRuc, legalName: 'EMISOR SINTETICO', address: 'DIRECCION INVENTADA',
        ubigeo: '150101', establishmentCode: '0000' }, customer: { identityType: '6', identityNumber: '20131312955', legalName: 'CLIENTE SINTETICO' },
      ...totals('118') };
  }
  function tuple(s) { return { ...scope, pointId, seriesId: s.documentTypeCode === '07' ? series07 : s.documentTypeCode === '01' ? series01 : series03,
    series: s.series, documentType: s.documentTypeCode }; }
  function accepted(s) {
    return { environment: 'BETA', issuerRuc: scope.issuerRuc, documentId: s.documentId, documentTypeCode: s.documentTypeCode,
      fullNumber: s.fullNumber, snapshotSha256: hash(s), cdrSha256: 'a'.repeat(64), status: 'ACCEPTED', responseCode: '0',
      acceptedAt: '2026-10-02T16:10:00Z', source: s.series.startsWith('B') ? { kind: 'CDR_SUMMARY', identifier: 'RC-20261002-91',
        referenceDate: '2026-10-02', conditionCode: '1', lineNumber: 2 } : { kind: 'CDR_DOCUMENT' } };
  }
  function put(s, acceptance = null, original = null, history = []) {
    const handle = `synthetic-version:${randomUUID()}`;
    material.set(handle, { snapshot: clone(s), binding: tuple(s), acceptance, original,
      notDelivered: { status: 'NOT_DELIVERED', documentId: s.documentId, documentTypeCode: s.documentTypeCode, fullNumber: s.fullNumber,
        issuerRuc: scope.issuerRuc, snapshotSha256: hash(s), evidenceId: randomUUID(), assertedAt: '2026-10-03T16:00:00Z' },
      provenance: { verifierId: 'SYNTHETIC-PRIVATE-VERIFIER-NOT-PKI', artifactId: handle, verifiedAt: AS_OF,
        signedXmlSha256: 'b'.repeat(64), cdrSha256: acceptance?.cdrSha256 ?? null, catalogueSha256: hash(history) } });
    return handle;
  }
  const policy = (s, who = subject, active = true, expectedRevision = 0, kind = s.series.startsWith('B') ? 'RC' : 'RA') => ({
    subject: who, binding: tuple(s), kind, permission: 'WRITE', clientRevision: identityRevision,
    userAuthRevision: who.kind === 'USER' ? 2 : null, active, expectedRevision,
  });
  async function grant(s, who = subject, active = true) {
    const k = hash({ subject: who, binding: tuple(s), kind: s.series.startsWith('B') ? 'RC' : 'RA', permission: 'WRITE' });
    const rev = await owner.setLocalGrant('synthetic-owner-step-up', policy(s, who, active, revisions.get(k) ?? 0));
    revisions.set(k, rev); return rev;
  }
  function request(member, condition = '1', previous, kind = 'RC') {
    return { schemaVersion: 'factuez.b2b.batch-members.v1', scope, idempotencyKey: `synthetic-batch:${randomUUID()}`, asOf: AS_OF,
      issueDate: '2026-10-03', referenceDate: '2026-10-02', kind, entries: kind === 'RC' ? [{ member, conditionCode: condition,
        ...(condition !== '1' ? { previous } : {}) }] : [{ member, reasonDescription: 'BAJA SINTETICA NO ENTREGADA' }] };
  }
  const counts = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM b2b_batch_member_reservation) reservations,
    (SELECT count(*)::int FROM b2b_batch_member_command) commands,
    (SELECT count(*)::int FROM b2b_batch_member_local_outbox) outbox,
    (SELECT count(*)::int FROM b2b_batch_member_journal) journals,
    (SELECT coalesce(sum(last_number),0)::int FROM b2b_batch_member_counter) numbers`)).rows[0];
  async function rejectedWithoutWrites(work) { const before = await counts(); await assert.rejects(work); assert.deepEqual(await counts(), before); }
  async function admitted(type = '03', report = false) {
    const s = snapshot(type); local('@factuez/sunat-core/dist/fiscal-note').validateFiscalOriginal(s, AS_OF);
    const previousStage = stage; stage += ':ADMISSION';
    const handle = put(s, report ? accepted(s) : null), member = await owner.importVerifiedVersion(handle); stage = previousStage;
    return { s, handle, member };
  }

  await check('PRIVATE_IMPORT_AND_STEP_UP_REQUIRED_NO_DEFAULT_POLICY', async () => {
    const f = await admitted();
    await rejectedWithoutWrites(() => producer.plan(request(f.member), subject));
    adminAllowed = false;
    await assert.rejects(owner.setLocalGrant('synthetic-owner-step-up', policy(f.s)), e => e.code === 'BATCH_OWNER_UNAVAILABLE');
    adminAllowed = true;
    assert.equal((await pool.query('SELECT count(*)::int n FROM b2b_batch_member_grant')).rows[0].n, 0);
    await assert.rejects(owner.importVerifiedVersion({ accepted: true }), e => e.code === 'INVALID_BATCH_OWNER');
    await assert.rejects(owner.importVerifiedVersion('unowned:artifact'), e => e.code === 'BATCH_OWNER_UNAVAILABLE' && !String(e).includes('PRIVATE_'));
    const broken = put(snapshot()); material.get(broken).provenance = null;
    await assert.rejects(owner.importVerifiedVersion(broken), e => e.code === 'INVALID_BATCH_OWNER');
  });
  await check('ADMIN_RECHECK_FAILURE_ROLLS_BACK_POLICY', async () => {
    const s = snapshot(), before = (await pool.query('SELECT count(*)::int n FROM b2b_batch_member_grant')).rows[0].n;
    failAdminAt = adminCalls + 3;
    await assert.rejects(owner.setLocalGrant('synthetic-owner-step-up', policy(s)));
    failAdminAt = 0;
    assert.equal((await pool.query('SELECT count(*)::int n FROM b2b_batch_member_grant')).rows[0].n, before);
  });
  await check('SIGNED_XML_BEFORE_AND_AFTER_CDR_HAS_TWO_IMMUTABLE_OWNER_VERSIONS', async () => {
    const f = await admitted();
    const v = material.get(f.handle); v.acceptance = accepted(f.s); v.provenance.cdrSha256 = v.acceptance.cdrSha256;
    const acceptedVersion = await owner.importVerifiedVersion(f.handle);
    assert.equal(acceptedVersion.version, 2); assert.equal(acceptedVersion.snapshotSha256, f.member.snapshotSha256);
    assert.equal((await owner.member(f.member)).acceptance, null);
    assert.deepEqual((await owner.member(acceptedVersion)).acceptance, accepted(f.s));
    assert.deepEqual(await owner.importVerifiedVersion(f.handle), acceptedVersion);
  });
  let rc2;
  await check('SERVICE_RC2_OWNER_VERSIONS_EXACT_PREVIOUS_AND_JSON_RESULT', async () => {
    const f = await admitted('03', true), corrected = { ...clone(f.s), ...totals('59') };
    const current = await owner.importVerifiedVersion(put(corrected));
    assert.equal(current.version, 2); assert.equal((await owner.member(f.member)).lifecycle, 'HISTORICAL');
    await grant(corrected);
    const req = request(current, '2', f.member), result = await producer.coordinate(await producer.plan(req, subject), 'CREATE');
    const row = (await pool.query('SELECT subject,command,ubl FROM b2b_batch_member_command WHERE batch_id=$1', [result.journal.result.batchId])).rows[0];
    assert.deepEqual(row.subject, subject); assert.equal(row.subject.subjectId, null);
    const batch = row.command.payload.envelope.batch;
    assert.equal(batch.identifier, 'RC-20261003-1'); // Accepted source RC-...-91 never seeds the owner counter.
    assert.deepEqual(batch.input.entries[0].document.snapshot, corrected);
    assert.deepEqual(batch.input.entries[0].previous.document.snapshot, f.s);
    assert.deepEqual(batch.input.entries[0].previous.acceptance, accepted(f.s));
    const { documentId, identifier, issueDate, referenceDate } = batch;
    assert.deepEqual(buildFiscalBatchSnapshot(batch.input, { documentId, identifier, issueDate, referenceDate }, AS_OF), batch);
    assert.equal(row.ubl, buildFiscalBatchUbl(batch, AS_OF));
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    assert.equal(result.officialAcceptance, false); assert.equal(result.journal.result.state, 'PREPARED');
    const reused = await producer.coordinate(await producer.plan(req, subject), 'REUSE_JOURNAL');
    assert.deepEqual(reused.journal, result.journal); rc2 = { req, f, current };
  });
  await check('VERSION_HASH_MEMBERSHIP_AND_IMMUTABLE_IDENTITY_REJECTED', async () => {
    const req = clone(rc2.req); req.entries[0].previous.snapshotSha256 = rc2.current.snapshotSha256;
    await rejectedWithoutWrites(() => producer.plan(req, subject));
    const altered = clone(rc2.f.s); altered.customer.legalName = 'CAMBIO IDENTIDAD';
    await assert.rejects(owner.importVerifiedVersion(put(altered)), e => e.code === 'BATCH_MEMBER_CHANGED');
    assert.equal((await owner.member(rc2.current)).member.version, 2);
    assert.deepEqual(await owner.importVerifiedVersion(rc2.f.handle), rc2.f.member);
  });
  await check('SERVICE_RC1_RC3_RA_AND_GENUINE_USER', async () => {
    for (const [kind, condition, who] of [['RC', '1', subject], ['RC', '3', subject], ['RA', '1', subject],
      ['RC', '1', { kind: 'USER', clientId: randomUUID(), subjectId: randomUUID() }]]) {
      const f = await admitted(kind === 'RA' ? '01' : '03', condition === '3' || kind === 'RA');
      await grant(f.s, who);
      const result = await producer.coordinate(await producer.plan(request(f.member, condition, f.member, kind), who), 'CREATE');
      assert.equal(result.journal.subject.kind, who.kind); assert.equal(result.journal.subject.subjectId, who.subjectId);
      assert.equal(result.journal.command.payload.envelope.batch.input.kind, kind);
    }
  });
  await check('CONCURRENT_CREATES_ONE_CALLBACK_AND_OWNER_COUNTER', async () => {
    const f = await admitted(); await grant(f.s);
    const req = request(f.member), a = new B2bBatchMemberAuthority(owner, now), b = new B2bBatchMemberAuthority(makeOwner(), now);
    const plans = await Promise.all([a.plan(req, subject), b.plan(req, subject)]);
    let callbacks = 0;
    const work = async (tx, prepared) => { callbacks++; return tx.persist(prepared); };
    const before = await counts();
    const results = await Promise.allSettled([a.coordinate(plans[0], 'CREATE', work), b.coordinate(plans[1], 'CREATE', work)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'BATCH_REUSE_REQUIRED');
    assert.equal(callbacks, 1); assert.equal((await counts()).numbers, before.numbers + 1);
    const altered = clone(req); altered.idempotencyKey += ':other';
    await rejectedWithoutWrites(async () => producer.coordinate(await producer.plan(altered, subject), 'CREATE'));
  });
  await check('LOST_COMMIT_REPLY_REUSES_JOURNAL_WITHOUT_SECOND_CALLBACK', async () => {
    const f = await admitted(); await grant(f.s);
    let loseReply = false, callbacks = 0;
    const lossy = { connect: async () => { const db = await pool.connect(); return {
      query: async (sql, values) => { const result = await db.query(sql, values);
        if (sql === 'COMMIT' && loseReply) { loseReply = false; throw new Error('PRIVATE_LOST_REPLY_DRIVER_DATA'); } return result; },
      release: () => db.release(),
    }; } };
    const a = new B2bBatchMemberAuthority(makeOwner(lossy), now), req = request(f.member), plan = await a.plan(req, subject), before = await counts();
    loseReply = true;
    await assert.rejects(a.coordinate(plan, 'CREATE', async (tx, prepared) => { callbacks++; return tx.persist(prepared); }),
      e => e.code === 'BATCH_OWNER_UNAVAILABLE' && !String(e).includes('PRIVATE_'));
    assert.equal((await counts()).journals, before.journals + 1);
    const reused = await producer.coordinate(await producer.plan(req, subject), 'REUSE_JOURNAL');
    assert.equal(reused.reused, true); assert.equal(callbacks, 1); assert.equal((await counts()).numbers, before.numbers + 1);
  });
  await check('LIVE_LOCAL_GRANT_REVOKED_BEFORE_TX_NO_RESERVATION', async () => {
    const f = await admitted(); await grant(f.s);
    const plan = await producer.plan(request(f.member), subject);
    await grant(f.s, subject, false);
    await rejectedWithoutWrites(() => producer.coordinate(plan, 'CREATE'));
    await grant(f.s);
  });
  await check('LIVE_LOCAL_REVOKE_BLOCKS_ON_OWNER_TRANSACTION_AND_DENIES_REPLAY', async () => {
    const f = await admitted(); await grant(f.s);
    const a = new B2bBatchMemberAuthority(owner, now), req = request(f.member), plan = await a.plan(req, subject);
    const entered = deferred(), release = deferred(); let revoked = false;
    const running = a.coordinate(plan, 'CREATE', async (tx, prepared) => {
      const result = await tx.persist(prepared); entered.resolve(); await release.promise; return result;
    });
    await entered.promise;
    const revoke = grant(f.s, subject, false).then(() => { revoked = true; });
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      const row = (await pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE wait_event='advisory' AND query='SELECT pg_advisory_lock(2070707)'")).rows[0];
      if (row.n > 0) { waiting = true; break; } await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(waiting, true); assert.equal(revoked, false);
    release.resolve(); await running; await revoke; assert.equal(revoked, true);
    await rejectedWithoutWrites(() => producer.plan(req, subject));
    await grant(f.s);
  });
  await check('REMOTE_IDENTITY_REVISION_CHANGE_AFTER_OUTPUT_ROLLS_BACK_ALL', async () => {
    const f = await admitted(); await grant(f.s);
    const a = new B2bBatchMemberAuthority(owner, now), plan = await a.plan(request(f.member), subject);
    await rejectedWithoutWrites(() => a.coordinate(plan, 'CREATE', async (tx, prepared, checkpoint) => {
      const result = await tx.persist(prepared); identityRevision++; await checkpoint(); return result;
    }));
    identityRevision--; identityAllowed = false;
    await rejectedWithoutWrites(() => producer.plan(request(f.member), subject)); identityAllowed = true;
  });
  await check('PARALLEL_CAUGHT_PRODUCER_ERROR_POISONS_TRANSACTION', async () => {
    const f = await admitted(); await grant(f.s);
    const a = new B2bBatchMemberAuthority(owner, now), plan = await a.plan(request(f.member), subject);
    await rejectedWithoutWrites(() => a.coordinate(plan, 'CREATE', async (tx, prepared) => {
      const first = tx.persist(prepared); await assert.rejects(tx.persist(prepared), e => e.code === 'BATCH_CALLBACK_REENTRY'); return first;
    }));
  });
  await check('CREDIT_CATALOGUE_IS_COMPLETE_OWNER_HISTORY_AND_FENCED', async () => {
    const f = await admitted('03', true); await grant(f.s);
    const context = { original: f.s, acceptance: accepted(f.s), asOf: AS_OF, creditHistory: { complete: true, entries: [] } };
    const n1 = buildFiscalNoteSnapshot(context, { documentTypeCode: '07', reasonCode: '07', reasonDescription: 'DEVOLUCION SINTETICA',
      lines: [{ originalLineNumber: 1, quantity: '0.5' }] }, { documentId: randomUUID(), series: 'BC01', number: String(++sequence), issueDate: '2026-10-02T17:00:00Z' });
    const first = await owner.importVerifiedVersion(put(n1, null, f.member)); await grant(n1);
    const plan = await producer.plan(request(first), subject);
    const historyRevision = (await owner.member(first)).note.historyRevision;
    const n2 = buildFiscalNoteSnapshot({ ...context, creditHistory: { complete: true, entries: [{ state: 'RESERVED', note: n1 }] } },
      { documentTypeCode: '07', reasonCode: '07', reasonDescription: 'DEVOLUCION SINTETICA', lines: [{ originalLineNumber: 1, quantity: '0.5' }] },
      { documentId: randomUUID(), series: 'BC01', number: String(++sequence), issueDate: '2026-10-02T17:00:00Z' });
    // Private verifier omits the existing credit: no version may be materialized.
    await assert.rejects(owner.importVerifiedVersion(put(n2, null, f.member)), e => e.code === 'BATCH_MEMBER_CHANGED');
    const second = await owner.importVerifiedVersion(put(n2, null, f.member, [{ member: first, state: 'RESERVED' }]));
    assert.equal((await owner.member(first)).note.historyRevision, historyRevision + 1);
    await rejectedWithoutWrites(() => producer.coordinate(plan, 'CREATE'));
    const freshPlan = await producer.plan(request(second), subject);
    assert.equal(freshPlan.members.length, 3);
    assert.deepEqual(freshPlan.members.find(m => m.record.member.documentId === second.documentId).record.note.creditHistory,
      [{ member: first, state: 'RESERVED' }]);
    await producer.coordinate(freshPlan, 'CREATE');
    await rejectedWithoutWrites(async () => producer.coordinate(await producer.plan(request(f.member, '3', f.member), subject), 'CREATE'));
  });
  await check('APPEND_ONLY_ROWS_EXPLICIT_REVISIONS_NO_LEGACY_FISCAL_OUTBOX', async () => {
    for (const table of ['b2b_batch_member_version', 'b2b_batch_member_reservation', 'b2b_batch_member_command',
      'b2b_batch_member_local_outbox', 'b2b_batch_member_journal']) {
      await assert.rejects(pool.query(`DELETE FROM ${table}`), /BATCH_APPEND_ONLY/);
    }
    await assert.rejects(pool.query('UPDATE b2b_batch_member_grant SET revision=revision'), /BATCH_REVISION_REQUIRED/);
    await assert.rejects(pool.query("UPDATE b2b_batch_member_document SET binding=jsonb_set(binding,'{issuerRuc}','\"00000000000\"'),revision=revision+1,current_version=current_version+1"), /BATCH_IDENTITY_IMMUTABLE/);
    assert.equal(await client.outboxEvent.count(), 0); assert.equal(await client.dailySummary.count(), 0); assert.equal(await client.document.count(), 0);
    const final = await counts(); assert.equal(final.commands, final.outbox); assert.equal(final.commands, final.journals);
    assert.equal((await pool.query("SELECT count(*)::int n FROM b2b_batch_member_local_outbox WHERE payload->>'fiscalExecutionEnabled' <> 'false'")).rows[0].n, 0);
  });
  console.log(JSON.stringify({ status: 'PASS', localOnly: true, syntheticVerifierOnly: true, checks: passed, totals: await counts() }));
}).catch(error => { console.error(JSON.stringify({ status: 'FAIL', stage, code: error.code ?? 'ASSERTION_OR_FIXTURE_FAILURE', message: error.message })); process.exitCode = 1; });
