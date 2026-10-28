'use strict';
// EXPLICIT SYNTHETIC REHEARSAL ONLY. WeakSet seals below are test fixtures:
// NO XML/CDR validation, NO PKI trust, NO official SUNAT traffic or activation.
// The unchanged helper owns a NEW labelled tmpfs PostgreSQL, network=none,
// no published ports, fixed synthetic DB/RUC, and checks ownership on cleanup.
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--isolated-synthetic-only'])) {
  throw new Error('ISOLATED_SYNTHETIC_ONLY_REQUIRED');
}
const {withCorrectionDatabase} = require('./helpers/correction-reservation-db.cjs');
let stage = 'PREFLIGHT';
let detailStage = null;
const passed = [];
const failures = [];
async function check(label, work) {
  stage = label; detailStage = null;
  try { await work(); passed.push(label); }
  catch (error) {
    failures.push({stage: label, detailStage, code: error?.code ?? null,
      prismaMetaCode: error?.meta?.code ?? null,
      driverOriginalCode: error?.meta?.driverAdapterError?.cause?.originalCode ?? null,
      postgresCode: error?.meta?.code ?? error?.meta?.driverAdapterError?.cause?.originalCode ?? null,
      message: String(error?.meta?.message ?? error?.message ?? 'FAILURE').slice(0, 350)});
  }
}
async function concurrent(work) {
  // Await BOTH operations, even on failure, before the next group or DB cleanup.
  const settled = await Promise.allSettled(work);
  const failure = settled.find(value => value.status === 'rejected');
  if (failure) throw failure.reason;
  return settled.map(value => value.value);
}

withCorrectionDatabase(async ({client, pool, local}) => {
  const {BetaSupplementCommandRepository} = local('./dist/application/beta-supplement-command.repository');
  const {CorrectionJournalRepository} = local('./dist/application/correction-journal.repository');
  const {VerifiedCorrectionJournal} = local('./dist/application/verified-correction-journal');
  const {FinancialLedgerCandidateRepository} = local('./dist/application/financial-ledger-candidate.repository');
  const {supplementActorIdentity} = local('./dist/application/supplement-actor');
  const {PrismaCorrectionProducerDrafts} = local('./dist/b2b/correction-producer-drafts');
  const {B2bCorrectionProducer} = local('./dist/b2b/correction-producer');
  const {calculateDocumentTotals} = local('@factuez/sunat-core/dist/tax');
  const {buildFiscalNoteSnapshot, fiscalSnapshotSha256} = local('@factuez/sunat-core/dist/fiscal-note');
  const {buildFiscalSupplementCommand} = local('@factuez/sunat-core/dist/fiscal-supplement-command');
  const {projectCorrectionJournal} = local('@factuez/sunat-core/dist/fiscal-correction-journal');
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'b2b_corrections_synthetic');
  await pool.query(readFileSync(resolve(__dirname, '../services/billing-service/b2b-correction-journal-v2.candidate.sql'), 'utf8'));
  const ruc = '20000000001', branch = randomUUID(), point = randomUUID();
  const invoice = randomUUID(), creditSeries = randomUUID(), debitSeries = randomUUID();
  await client.companySettings.create({data: {id: 1, ruc, legalName: 'SYNTHETIC JOURNAL ONLY', companyType: 'SYNTHETIC',
    economicActivities: [], taxAddress: 'SYNTHETIC ADDRESS', ubigeo: '150101', contactEmails: [], environment: 'BETA'}});
  await client.branch.create({data: {id: branch, companyId: 1, code: 'SYNTHETIC', name: 'SYNTHETIC JOURNAL ONLY'}});
  await client.emissionPoint.create({data: {id: point, companyId: 1, branchId: branch, code: '0000', name: 'SYNTHETIC JOURNAL ONLY'}});
  for (const [id, documentType, series] of [[invoice, 'INVOICE', 'F001'], [creditSeries, 'CREDIT_NOTE', 'FC01'], [debitSeries, 'DEBIT_NOTE', 'FD01']]) {
    await client.seriesCounter.create({data: {id, companyId: 1, emissionPointId: point, documentType, series, nextNumber: 1n}});
  }
  const access = {kind: 'ASSIGNED', branchIds: [branch], emissionPointIds: [point], series: [invoice, creditSeries, debitSeries]};
  const actor = {userId: null, scope: access, b2b: {kind: 'SERVICE', clientId: randomUUID(), revision: 1, subjectId: null, userAuthRevision: null}};
  let clock = Date.parse('2026-10-21T10:00:00Z'), originalSequence = 0;
  const now = () => new Date(clock).toISOString();
  const tick = () => { clock += 60000; return now(); };
  const authority = {current: async () => structuredClone(actor)};
  const notes = new BetaSupplementCommandRepository(client);
  notes.reserve = () => { throw new Error('NESTED_OWNER_TRANSACTION_FORBIDDEN'); };
  const repository = new CorrectionJournalRepository(notes);
  const reservationSeals = new WeakSet(), originalSeals = new WeakSet(), outcomeSeals = new WeakSet(), prerequisiteSeals = new WeakSet();
  const evidenceByOperation = new Map();
  const reservationEvidence = {
    verify: async command => {
      const proof = {commandSha256: fiscalSnapshotSha256(command), evidenceSha256: fiscalSnapshotSha256(command.payload.envelope.context)};
      reservationSeals.add(proof); return proof;
    },
    owns: proof => !!proof && typeof proof === 'object' && reservationSeals.has(proof),
  };
  const outcomes = {
    command: async operationId => {
      const rows = await client.outboxEvent.findMany({where: {aggregateId: operationId, eventType: 'billing.beta.supplement.requested.v1'}, select: {payload: true}, take: 2});
      assert.equal(rows.length, 1, 'OWN_SYNTHETIC_COMMAND_REQUIRED'); return rows[0].payload;
    },
    prerequisites: async command => {
      const proof = {commandSha256: fiscalSnapshotSha256(command), evidenceSha256: fiscalSnapshotSha256(command.payload.envelope.context)};
      prerequisiteSeals.add(proof); return proof;
    },
    ownsPrerequisites: proof => !!proof && typeof proof === 'object' && prerequisiteSeals.has(proof),
    original: async snapshot => {
      const proof = {evidence: acceptance(snapshot), fence: {snapshotSha256: fiscalSnapshotSha256(snapshot), revision: 1, fixtureOnly: true}};
      originalSeals.add(proof); return proof;
    },
    ownsOriginal: proof => !!proof && typeof proof === 'object' && originalSeals.has(proof),
    verify: async command => {
      const evidence = evidenceByOperation.get(command.payload.operationId);
      assert.ok(evidence, 'SEALED_SYNTHETIC_OUTCOME_REQUIRED');
      const proof = {commandSha256: fiscalSnapshotSha256(command), operationId: command.payload.operationId,
        evidence: structuredClone(evidence), fence: {revision: 1, fixtureOnly: true}};
      outcomeSeals.add(proof); return proof;
    },
    owns: proof => !!proof && typeof proof === 'object' && outcomeSeals.has(proof),
  };
  function journal({repo = repository, auth = authority, reserveEvidence = reservationEvidence, resultEvidence = outcomes, allow = [ruc], db = client} = {}) {
    return new VerifiedCorrectionJournal(db, repo, auth, reserveEvidence, resultEvidence, allow, now);
  }
  function acceptance(doc) {
    return {environment: 'BETA', issuerRuc: ruc, documentId: doc.documentId, documentTypeCode: '01', fullNumber: doc.fullNumber,
      snapshotSha256: fiscalSnapshotSha256(doc), cdrSha256: 'a'.repeat(64), status: 'ACCEPTED', responseCode: '0',
      acceptedAt: '2026-10-20T10:05:00Z', source: {kind: 'CDR_DOCUMENT'}};
  }
  async function original() {
    const id = randomUUID(), number = String(++originalSequence);
    const doc = {documentId: id, companyId: 1, branchId: branch, environment: 'BETA', documentTypeCode: '01', series: 'F001', number, fullNumber: 'F001-' + number,
      issueDate: '2026-10-20T10:00:00Z', currencyCode: 'PEN', operationTypeCode: '0101', paymentTerms: {type: 'CONTADO'},
      issuer: {identityType: '6', identityNumber: ruc, legalName: 'SYNTHETIC JOURNAL ONLY', address: 'SYNTHETIC ADDRESS', ubigeo: '150101', establishmentCode: '0000'},
      customer: {identityType: '6', identityNumber: ruc, legalName: 'SYNTHETIC CUSTOMER'},
      ...calculateDocumentTotals([{description: 'SYNTHETIC ITEM', productCode: 'SYNTHETIC', unitCode: 'NIU', quantity: '2', unitPriceWithTax: '118', taxAffectationCode: '10', igvRate: '18'}])};
    await client.document.create({data: {id, companyId: 1, seriesCounterId: invoice, type: 'INVOICE', status: 'ISSUED', sunatStatus: 'ACCEPTED',
      series: doc.series, number: BigInt(number), fullNumber: doc.fullNumber, issueDate: new Date(doc.issueDate), currencyCode: 'PEN', operationTypeCode: '0101',
      emissionPointId: point, createdByUserId: null, createdByActor: actor.b2b, customerIdentityType: '6', customerIdentityNumber: ruc,
      customerLegalName: doc.customer.legalName, ...doc.totals, immutableSnapshot: doc}});
    return doc;
  }
  async function command(doc, {debit = false, history = []} = {}) {
    const asOf = tick(), context = {original: doc, acceptance: acceptance(doc), asOf,
      creditHistory: {complete: true, entries: history.map(note => ({state: 'RESERVED', note}))}};
    const counter = await client.seriesCounter.findUniqueOrThrow({where: {id: debit ? debitSeries : creditSeries}});
    const note = buildFiscalNoteSnapshot(context, debit
      ? {documentTypeCode: '08', reasonCode: '02', reasonDescription: 'SYNTHETIC DELTA', lines: [{originalLineNumber: 1, unitPriceAdjustmentWithTax: '11.8'}]}
      : {documentTypeCode: '07', reasonCode: '07', reasonDescription: 'SYNTHETIC RETURN', lines: [{originalLineNumber: 1, quantity: '1'}]},
    {documentId: randomUUID(), series: counter.series, number: String(counter.nextNumber), issueDate: asOf});
    return buildFiscalSupplementCommand({kind: 'NOTE', note, context}, {eventId: randomUUID(), correlationId: randomUUID(), occurredAt: asOf});
  }
  function publishFixture(c, status = 'ACCEPTED') {
    const evidence = {status, cdrSignatureVerified: true, officialCdr: true, responseCode: status === 'REJECTED' ? '2335' : '0',
      cdrSha256: 'b'.repeat(64), requestSha256: 'c'.repeat(64), acceptedAt: tick()};
    // Deliberate simulated assertions only; the WeakSet is NOT official trust.
    evidenceByOperation.set(c.payload.operationId, evidence); return evidence;
  }
  async function events(doc) {
    return (await pool.query('SELECT "event","versionSha256" FROM "B2bCorrectionJournalEvent" WHERE "originalDocumentId"=$1::uuid ORDER BY "revision"', [doc.documentId])).rows;
  }
  async function persistedState() {
    const tables = ['Document', 'SeriesCounter', 'OutboxEvent', 'DocumentItem', 'DocumentTax', 'DocumentReference',
      'B2bCorrectionJournalHead', 'B2bCorrectionJournalEvent', 'B2bCorrectionRequestReceipt'];
    const result = {};
    for (const table of tables) result[table] = (await pool.query('SELECT to_jsonb(t) AS row FROM "' + table + '" t ORDER BY to_jsonb(t)::text')).rows;
    return result;
  }
  const originalRow = doc => client.document.findUniqueOrThrow({where: {id: doc.documentId}});
  const noteOf = c => c.payload.envelope.note;
  async function pending() { const doc = await original(), c = await command(doc); await journal().reserve(c); publishFixture(c); return {doc, c}; }
  function wrappedRepo(method, afterWrite) {
    return {load: repository.load.bind(repository), view: repository.view.bind(repository),
      reserve: repository.reserve.bind(repository), settle: repository.settle.bind(repository),
      [method]: async (...args) => { const value = await repository[method](...args); await afterWrite(); return value; }};
  }
  function binding() { return {reference: {issuerId: 1, issuerRuc: ruc, environment: 'BETA', branchId: branch, pointId: point, seriesId: invoice, documentType: '01'}, noteSeriesId: creditSeries, noteType: '07'}; }
  const pairedActor = () => ({...structuredClone(actor), scope: {...structuredClone(access), series: [invoice, creditSeries]}});
  function facade({who = pairedActor(), overrideBinding = null} = {}) {
    const auth = {current: async () => ({actor: structuredClone(who), grantRevision: 1, clientRevision: 1})};
    const ownAuth = {current: async () => structuredClone(who)};
    const execution = journal({auth: ownAuth}), drafts = new PrismaCorrectionProducerDrafts(client, outcomes, now);
    // Do NOT spread class instances: prototype methods must preserve their receiver.
    const app = new B2bCorrectionProducer(auth, drafts, {
      reserve: c => execution.reserve(c, drafts.receiptFor(c)),
      settle: id => execution.settle(id), status: id => execution.status(id),
    });
    return {app, drafts, binding: overrideBinding || binding()};
  }
  function request(doc) { return {schemaVersion: 'factuez.b2b.correction-create.v1', binding: binding(), originalDocumentId: doc.documentId,
    idempotencyKey: 'synthetic-key-' + randomUUID(), externalReference: {namespace: 'synthetic-journal', value: randomUUID()}, issueDate: tick(),
    note: {documentTypeCode: '07', reasonCode: '07', reasonDescription: 'SYNTHETIC BUSINESS RETURN', lines: [{originalLineNumber: 1, quantity: '1'}]}}; }

  let first, originalBefore, firstRows, firstPrefix;
  await check('REAL_OWNER_RESERVATION_ATOMIC_WITH_NULL_HUMAN_SERVICE', async () => {
    const doc = await original(), c = await command(doc); originalBefore = await originalRow(doc);
    const result = await journal().reserve(c); first = {doc, c};
    assert.equal(result.state, 'RESERVED'); assert.equal(result.netAmount, '236.00'); assert.equal(result.creditHeld, '118.00');
    assert.equal(result.candidateOnly, true); assert.equal(result.fiscalExecutionEnabled, false); assert.equal(result.transmissionAuthorized, false);
    const note = await originalRow({documentId: c.payload.operationId});
    assert.equal(note.createdByUserId, null); assert.equal(note.createdByActor.kind, 'SERVICE'); assert.equal(note.createdByActor.subjectId, null);
    assert.equal(note.sunatStatus, 'QUEUED'); assert.equal(await client.documentItem.count({where: {documentId: note.id}}), 1);
    assert.equal(await client.outboxEvent.count({where: {id: c.eventId, aggregateId: note.id}}), 1);
    assert.equal(await client.documentReference.count({where: {sourceDocumentId: note.id, targetDocumentId: doc.documentId}}), 1);
    firstRows = await events(doc); firstPrefix = projectCorrectionJournal(doc, firstRows.map(r => r.event));
  });
  await check('SETTLEMENT_CHANGES_JOURNAL_NOT_ORIGINAL_OR_FISCAL_NOTE', async () => {
    publishFixture(first.c); const fiscalBefore = await persistedState();
    const result = await journal().settle(first.c.payload.operationId);
    assert.equal(result.state, 'ACCEPTED'); assert.equal(result.netAmount, '118.00'); assert.equal(result.creditHeld, '118.00');
    const fiscalAfter = await persistedState();
    for (const table of ['Document', 'SeriesCounter', 'OutboxEvent', 'DocumentItem', 'DocumentTax', 'DocumentReference']) assert.deepEqual(fiscalAfter[table], fiscalBefore[table]);
  });
  await check('NEW_CREDIT_AFTER_SETTLEMENT_WITH_RESERVED_PROJECTION_HISTORY_AND_STABLE_PREFIX', async () => {
    const c = await command(first.doc, {history: [noteOf(first.c)]}); await journal().reserve(c); publishFixture(c);
    const result = await journal().settle(c.payload.operationId);
    assert.equal(result.state, 'ACCEPTED'); assert.equal(result.netAmount, '0.00'); assert.equal(result.creditHeld, '236.00');
    const rows = await events(first.doc), projection = projectCorrectionJournal(first.doc, rows.map(r => r.event));
    assert.deepEqual(rows.slice(0, firstRows.length), firstRows);
    assert.deepEqual(projection.versions.slice(0, firstPrefix.versions.length), firstPrefix.versions);
    assert.deepEqual(await originalRow(first.doc), originalBefore);
    assert.equal((await originalRow({documentId: first.c.payload.operationId})).sunatStatus, 'QUEUED');
  });
  await check('DEBIT_SETTLEMENT_DOES_NOT_EXPAND_CREDIT_CAPACITY', async () => {
    const doc = await original(), c = await command(doc, {debit: true}); await journal().reserve(c); publishFixture(c);
    const value = await journal().settle(c.payload.operationId);
    assert.equal(value.netAmount, '259.60'); assert.equal(value.debitHeld, '23.60'); assert.equal(value.creditHeld, '0.00');
  });
  await check('REJECTED_CREDIT_RETAINS_HOLD_AFTER_FURTHER_ACCEPTED_CREDIT', async () => {
    const doc = await original(), c = await command(doc); await journal().reserve(c); publishFixture(c, 'REJECTED');
    const rejected = await journal().settle(c.payload.operationId);
    assert.equal(rejected.state, 'REJECTED'); assert.equal(rejected.netAmount, '236.00'); assert.equal(rejected.creditHeld, '118.00');
    const next = await command(doc, {history: [noteOf(c)]}); await journal().reserve(next); publishFixture(next);
    const accepted = await journal().settle(next.payload.operationId);
    assert.equal(accepted.netAmount, '118.00'); assert.equal(accepted.creditHeld, '236.00');
    const before = await persistedState();
    await assert.rejects(command(doc, {history: [noteOf(c), noteOf(next)]}));
    assert.deepEqual(await persistedState(), before);
  });
  await check('RESTART_EXACT_RESERVE_SETTLE_AND_STATUS_REPLAY_WITHOUT_WRITES', async () => {
    const before = await persistedState(), restarted = journal({repo: new CorrectionJournalRepository(notes)});
    assert.equal((await restarted.reserve(first.c)).deduplicated, true);
    assert.equal((await restarted.settle(first.c.payload.operationId)).deduplicated, true);
    assert.equal((await restarted.status(first.c.payload.operationId)).state, 'ACCEPTED');
    assert.deepEqual(await persistedState(), before);
  });
  await check('CONCURRENT_IDENTICAL_RESERVATION_HAS_ONE_COUNTER_AND_OUTBOX_EFFECT', async () => {
    const doc = await original(), c = await command(doc), counter = await client.seriesCounter.findUniqueOrThrow({where: {id: creditSeries}});
    const results = await concurrent([journal().reserve(c), journal().reserve(c)]);
    assert.equal(results.filter(r => !r.deduplicated).length, 1);
    assert.equal((await client.seriesCounter.findUniqueOrThrow({where: {id: creditSeries}})).nextNumber, counter.nextNumber + 1n);
    assert.equal((await events(doc)).length, 1); assert.equal(await client.outboxEvent.count({where: {id: c.eventId}}), 1);
  });
  await check('CONCURRENT_IDENTICAL_SETTLEMENT_HAS_ONE_FINANCIAL_EFFECT', async () => {
    detailStage = 'PENDING'; const {doc, c} = await pending();
    detailStage = 'CONCURRENT_SETTLE'; const results = await concurrent([journal().settle(c.payload.operationId), journal().settle(c.payload.operationId)]);
    assert.equal(results.filter(r => !r.deduplicated).length, 1); assert.equal((await events(doc)).length, 2);
    detailStage = 'STATUS';
    assert.equal((await journal().status(c.payload.operationId)).netAmount, '118.00');
    detailStage = null;
  });
  await check('RESERVATION_AUTHORITY_REVOKED_AFTER_WRITES_ROLLS_BACK_DOCUMENT_COUNTER_AND_JOURNAL', async () => {
    const doc = await original(), c = await command(doc), before = await persistedState(); let written = false;
    const auth = {current: async () => { if (written) throw new Error('SYNTHETIC_AUTHORITY_REVOKED'); return structuredClone(actor); }};
    await assert.rejects(journal({auth, repo: wrappedRepo('reserve', () => { written = true; })}).reserve(c), /SYNTHETIC_AUTHORITY_REVOKED/);
    assert.deepEqual(await persistedState(), before);
  });
  await check('SETTLEMENT_AUTHORITY_REVOKED_AFTER_WRITES_ROLLS_BACK_JOURNAL', async () => {
    const {c} = await pending(), before = await persistedState(); let written = false;
    const auth = {current: async () => { if (written) throw new Error('SYNTHETIC_AUTHORITY_REVOKED'); return structuredClone(actor); }};
    await assert.rejects(journal({auth, repo: wrappedRepo('settle', () => { written = true; })}).settle(c.payload.operationId), /SYNTHETIC_AUTHORITY_REVOKED/);
    assert.deepEqual(await persistedState(), before);
  });
  await check('OUTCOME_FENCE_CHANGED_AFTER_WRITES_ROLLS_BACK_JOURNAL', async () => {
    const {c} = await pending(), before = await persistedState(); let written = false;
    const changing = {...outcomes, verify: async (...args) => { const proof = await outcomes.verify(...args); if (written) proof.fence.revision++; return proof; }};
    await assert.rejects(journal({resultEvidence: changing, repo: wrappedRepo('settle', () => { written = true; })}).settle(c.payload.operationId), /FINANCIAL_EVIDENCE_CHANGED/);
    assert.deepEqual(await persistedState(), before);
  });
  await check('RESERVATION_EVIDENCE_CHANGED_AFTER_WRITES_ROLLS_BACK_ALL_ROWS', async () => {
    const doc = await original(), c = await command(doc), before = await persistedState(); let written = false;
    const changing = {...reservationEvidence, verify: async (...args) => {
      const proof = await reservationEvidence.verify(...args); if (written) proof.evidenceSha256 = '0'.repeat(64); return proof;
    }};
    await assert.rejects(journal({reserveEvidence: changing, repo: wrappedRepo('reserve', () => { written = true; })}).reserve(c), /EVIDENCE_CHANGED/);
    assert.deepEqual(await persistedState(), before);
  });
  await check('OWNER_COMMIT_FAILURE_ROLLS_BACK_NOTE_AND_JOURNAL_TOGETHER', async () => {
    const doc = await original(), c = await command(doc), before = await persistedState();
    const failingDb = {$transaction: (work, options) => client.$transaction(async tx => {
      await work(tx); throw new Error('SYNTHETIC_COMMIT_FAILURE');
    }, options)};
    await assert.rejects(journal({db: failingDb}).reserve(c), /SYNTHETIC_COMMIT_FAILURE/);
    assert.deepEqual(await persistedState(), before);
  });
  await check('COPIED_PROOF_IS_NOT_OWNER_PROVENANCE', async () => {
    const {c} = await pending(), before = await persistedState();
    const forged = {...outcomes, verify: async (...args) => structuredClone(await outcomes.verify(...args))};
    await assert.rejects(journal({resultEvidence: forged}).settle(c.payload.operationId), /VERIFIED_OWN_OUTCOME_REQUIRED/);
    assert.deepEqual(await persistedState(), before);
  });
  await check('WRONG_SCOPE_AND_UNENABLED_RUC_BLOCK_BEFORE_NUMBERING', async () => {
    const doc = await original(), c = await command(doc), before = await persistedState();
    await assert.rejects(journal({auth: {current: async () => ({...structuredClone(actor), scope: {...structuredClone(access), series: [invoice]}})}}).reserve(c), /scope/);
    await assert.rejects(journal({allow: ['20000000002']}).reserve(c), /ENTERPRISE_BETA_NOTE_PROFILE_NOT_ENABLED/);
    assert.deepEqual(await persistedState(), before);
  });
  await check('ORPHAN_LEGACY_NOTE_HISTORY_IS_NOT_SILENTLY_ADOPTED', async () => {
    const doc = await original(), c = await command(doc);
    await client.$transaction(tx => notes.reserveWithinTransaction(tx, c, actor), {isolationLevel: 'Serializable'});
    const next = await command(doc, {history: [noteOf(c)]}), before = await persistedState();
    await assert.rejects(journal().reserve(next), /UNRECONCILED_NOTE_HISTORY/);
    assert.deepEqual(await persistedState(), before);
  });
  await check('V1_LEDGER_REQUIRES_EXPLICIT_RECONCILIATION_BEFORE_V2', async () => {
    const doc = await original(), owner = new FinancialLedgerCandidateRepository(client);
    const plan = {planId: randomUUID(), input: {scope: {issuerRuc: ruc, companyId: 1, branchId: branch, environment: 'BETA'}, documents: [doc], entries: [], reservations: []},
      expectedHeads: [{documentId: doc.documentId, revision: 0, sequence: 0, versionSha256: null}]};
    await client.$transaction(tx => owner.commitWithinTransaction(tx, plan, actor), {isolationLevel: 'Serializable'});
    const c = await command(doc), before = await persistedState();
    await assert.rejects(journal().reserve(c), /V1_LEDGER_REQUIRES_RECONCILIATION/);
    assert.deepEqual(await persistedState(), before);
  });

  let business;
  await check('BUSINESS_FACADE_PREPARES_AND_RESERVES_WITH_PAIRED_GRANT_AND_ATOMIC_RECEIPT', async () => {
    const doc = await original(), req = request(doc), f = facade(), originalState = await originalRow(doc);
    const value = await f.app.create('synthetic-token', 'SERVICE', req);
    assert.equal(value.result.state, 'RESERVED'); assert.equal(value.result.creditHeld, '118.00');
    assert.equal(value.fiscalExecutionEnabled, false); assert.equal(value.transmissionAuthorized, false);
    assert.equal(Object.hasOwn(value, 'command'), false); assert.equal(Object.hasOwn(value.result, 'command'), false);
    assert.equal(Object.hasOwn(value.result, 'envelope'), false);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM "B2bCorrectionRequestReceipt" WHERE "operationId"=$1::uuid', [value.operationId])).rows[0].n, 1);
    const c = await outcomes.command(value.operationId); publishFixture(c);
    const note = c.payload.envelope.note, detail = value.result.document;
    assert.equal(value.result.originalDocumentId, doc.documentId);
    assert.equal(detail.id, value.operationId); assert.equal(detail.typeCode, '07'); assert.equal(detail.fullNumber, note.fullNumber);
    assert.equal(detail.series, note.series); assert.equal(detail.number, note.number); assert.equal(detail.issueDate, req.issueDate);
    assert.equal(detail.currency, 'PEN'); assert.deepEqual(detail.issuer, note.issuer); assert.deepEqual(detail.customer, note.customer);
    assert.deepEqual(detail.reference, note.reference); assert.deepEqual(detail.items, note.lines); assert.deepEqual(detail.totals, note.totals);
    assert.deepEqual(detail.reason, {code: req.note.reasonCode, description: req.note.reasonDescription});
    for (const forbidden of ['command', 'envelope', 'evidence', 'fence', 'acceptance', 'context']) {
      assert.equal(Object.hasOwn(detail, forbidden), false);
      assert.equal(Object.hasOwn(value.result, forbidden), false);
    }
    assert.equal((await f.app.settle('synthetic-token', 'SERVICE', req.binding, value.operationId)).result.netAmount, '118.00');
    business = {doc, req, value, originalState};
  });
  await check('BUSINESS_FACADE_SECOND_CREDIT_AFTER_ACCEPTANCE_USES_COMPLETE_RESERVED_HISTORY', async () => {
    const f = facade(), req = request(business.doc), value = await f.app.create('synthetic-token', 'SERVICE', req);
    const c = await outcomes.command(value.operationId);
    assert.equal(c.payload.envelope.context.creditHistory.entries.length, 1);
    assert.equal(c.payload.envelope.context.creditHistory.entries[0].state, 'RESERVED');
    publishFixture(c); const settled = await f.app.settle('synthetic-token', 'SERVICE', req.binding, value.operationId);
    assert.equal(settled.result.netAmount, '0.00'); assert.equal(settled.result.creditHeld, '236.00');
    assert.deepEqual(await originalRow(business.doc), business.originalState);
  });
  await check('BUSINESS_FACADE_RESTART_REPLAYS_PERSISTENT_RECEIPT_WITHOUT_NUMBERING', async () => {
    const before = await persistedState(), f = facade();
    const replay = await f.app.create('synthetic-token', 'SERVICE', business.req);
    assert.equal(replay.operationId, business.value.operationId); assert.equal(replay.result.deduplicated, true);
    assert.equal((await f.app.status('synthetic-token', 'SERVICE', business.req.binding, replay.operationId)).result.state, 'ACCEPTED');
    assert.deepEqual(await persistedState(), before);
  });
  await check('BUSINESS_KEY_REUSE_WITH_DIFFERENT_BODY_AND_EXTERNAL_REFERENCE_REUSE_FAIL', async () => {
    const before = await persistedState(), changed = structuredClone(business.req);
    changed.note.reasonDescription = 'DIFFERENT SYNTHETIC BODY';
    await assert.rejects(facade().app.create('synthetic-token', 'SERVICE', changed), /CORRECTION_REQUEST_CONFLICT/);
    const duplicateExternal = {...structuredClone(business.req), idempotencyKey: 'other-key-' + randomUUID()};
    await assert.rejects(facade().app.create('synthetic-token', 'SERVICE', duplicateExternal), /CORRECTION_REQUEST_CONFLICT/);
    assert.deepEqual(await persistedState(), before);
  });
  await check('BUSINESS_STATUS_DENIES_DIFFERENT_CLIENT_OR_SCOPE', async () => {
    const before = await persistedState(), stranger = pairedActor(); stranger.b2b.clientId = randomUUID();
    await assert.rejects(facade({who: stranger}).app.status('synthetic-token', 'SERVICE', business.req.binding, business.value.operationId), /CORRECTION_OPERATION_NOT_FOUND/);
    const denied = pairedActor(); denied.scope.series = [invoice, debitSeries];
    await assert.rejects(facade({who: denied}).app.status('synthetic-token', 'SERVICE', business.req.binding, business.value.operationId), /INVALID_CORRECTION_AUTHORITY_RESPONSE/);
    assert.deepEqual(await persistedState(), before);
  });
  await check('BUSINESS_UNSUPPORTED_BOLETA_PROFILE_BLOCKS_BEFORE_COUNTER_OR_RECEIPT', async () => {
    const doc = await original(), req = request(doc), before = await persistedState(); req.binding.reference.documentType = '03';
    await assert.rejects(facade().app.create('synthetic-token', 'SERVICE', req), /CORRECTION_PROFILE_NOT_ENABLED/);
    assert.deepEqual(await persistedState(), before);
  });
  await check('BUSINESS_CONCURRENT_EXACT_REQUESTS_HAVE_ONE_RECEIPT_AND_EFFECT', async () => {
    const doc = await original(), req = request(doc);
    const results = await concurrent([facade().app.create('synthetic-token', 'SERVICE', req), facade().app.create('synthetic-token', 'SERVICE', req)]);
    assert.equal(results[0].operationId, results[1].operationId);
    assert.equal(results.filter(r => !r.result.deduplicated).length, 1);
    assert.equal((await events(doc)).length, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM "B2bCorrectionRequestReceipt" WHERE "operationId"=$1::uuid', [results[0].operationId])).rows[0].n, 1);
  });
  await check('BUSINESS_DEBIT_FACADE_USES_OWN_PAIR_AND_SETTLES_EXACT_DELTA', async () => {
    const doc = await original(), req = request(doc), who = pairedActor();
    who.scope.series = [invoice, debitSeries];
    req.binding.noteSeriesId = debitSeries; req.binding.noteType = '08';
    req.note = {documentTypeCode: '08', reasonCode: '02', reasonDescription: 'SYNTHETIC BUSINESS DEBIT',
      lines: [{originalLineNumber: 1, unitPriceAdjustmentWithTax: '11.8'}]};
    const f = facade({who}), before = await originalRow(doc);
    const value = await f.app.create('synthetic-token', 'SERVICE', req), c = await outcomes.command(value.operationId);
    assert.equal(c.payload.envelope.note.documentTypeCode, '08'); assert.equal(c.payload.envelope.note.series, 'FD01');
    publishFixture(c);
    const result = await f.app.settle('synthetic-token', 'SERVICE', req.binding, value.operationId);
    assert.equal(result.result.netAmount, '259.60'); assert.equal(result.result.debitHeld, '23.60'); assert.equal(result.result.creditHeld, '0.00');
    assert.deepEqual(await originalRow(doc), before);
  });
  await check('PHYSICAL_NOTE_TOTAL_TAMPERING_IS_DETECTED_AND_NOT_AUTO_REPAIRED', async () => {
    const id = first.c.payload.operationId;
    const stored = await client.document.findUniqueOrThrow({where: {id}, select: {payableAmount: true}});
    const previous = stored.payableAmount.toString(), before = await persistedState();
    try {
      await client.document.update({where: {id}, data: {payableAmount: '119.00'}});
      const tampered = await persistedState();
      await assert.rejects(journal().status(id), /JOURNAL_NOTE_PHYSICAL_MISMATCH/);
      assert.deepEqual(await persistedState(), tampered);
    } finally {
      // Restore only the exact prior fixture value inside this NEW synthetic DB.
      await client.document.update({where: {id}, data: {payableAmount: previous}});
    }
    // updatedAt is legitimately changed by the fixture update, so compare all
    // other business columns and leave journal/receipt evidence byte-for-byte.
    const after = await persistedState();
    const withoutUpdatedAt = rows => rows.map(({row}) => { const copy = {...row}; delete copy.updatedAt; return copy; })
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    assert.deepEqual(withoutUpdatedAt(after.Document), withoutUpdatedAt(before.Document));
    for (const table of Object.keys(before).filter(name => name !== 'Document')) assert.deepEqual(after[table], before[table]);
  });
  // Dedicated fixtures: never mutate the originals whose exact rows were saved
  // by earlier vertical groups. Each field is tested independently and restored.
  const physicalFixture = await pending();
  const physicalMutations = [
    ['issueDate', new Date('2026-10-19T09:00:00Z')],
    ['operationTypeCode', '0200'],
    ['customerIdentityType', '1'],
    ['customerIdentityNumber', '99999999'],
    ['customerLegalName', 'TAMPERED SYNTHETIC CUSTOMER'],
    ['customerAddress', 'TAMPERED SYNTHETIC ADDRESS'],
  ];
  function sameExceptFixtureUpdatedAt(actual, expected, id) {
    const normalize = rows => rows.map(({row}) => {
      const copy = {...row}; if (copy.id === id) delete copy.updatedAt; return copy;
    }).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    assert.deepEqual(normalize(actual.Document), normalize(expected.Document));
    for (const table of Object.keys(expected).filter(name => name !== 'Document')) assert.deepEqual(actual[table], expected[table]);
  }
  async function tamperPhysical(id, field, value, expectedError) {
    const originalRecord = await client.document.findUniqueOrThrow({where: {id}}), before = await persistedState();
    try {
      await client.document.update({where: {id}, data: {[field]: value}});
      const tampered = await persistedState();
      assert.deepEqual((await client.document.findUniqueOrThrow({where: {id}})).immutableSnapshot, originalRecord.immutableSnapshot);
      await assert.rejects(journal().status(physicalFixture.c.payload.operationId), expectedError);
      // A failed verification must not repair the input or append any evidence.
      assert.deepEqual(await persistedState(), tampered);
    } finally {
      // Exact prior column value, including null/Date, in this NEW DB only.
      await client.document.update({where: {id}, data: {[field]: originalRecord[field]}});
    }
    sameExceptFixtureUpdatedAt(await persistedState(), before, id);
  }
  for (const [target, id, expectedError] of [
    ['ORIGINAL', physicalFixture.doc.documentId, /OWN_ORIGINAL_INCONSISTENT/],
    ['NOTE', physicalFixture.c.payload.operationId, /JOURNAL_NOTE_PHYSICAL_MISMATCH/],
  ]) {
    for (const [field, changed] of physicalMutations) {
      await check('PHYSICAL_' + target + '_' + field.toUpperCase() + '_TAMPER_REJECTED_WITH_IMMUTABLE_SNAPSHOT_UNCHANGED',
        () => tamperPhysical(id, field, changed, expectedError));
    }
  }
  await check('SERVICE_HUMAN_CREATOR_INJECTION_REJECTED_AND_EXACT_NULL_RESTORED', async () => {
    await tamperPhysical(physicalFixture.c.payload.operationId, 'createdByUserId', randomUUID(), /JOURNAL_ACTOR_INCONSISTENT/);
    const row = await client.document.findUniqueOrThrow({where: {id: physicalFixture.c.payload.operationId}});
    assert.equal(row.createdByUserId, null); assert.equal(row.createdByActor.kind, 'SERVICE');
  });
  await check('THREE_HALF_QUANTITY_CREDITS_SAME_ISSUE_DATE_DESCENDING_IDS_USE_DEPENDENCY_ORDER', async () => {
    const doc = await original(), before = await originalRow(doc), who = pairedActor();
    const requests = [request(doc), request(doc), request(doc)], issueDate = now();
    const deterministicUuid = hash => `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    const ordered = requests.map(req => {
      req.issueDate = issueDate; req.note.lines[0].quantity = '0.5';
      const sha = fiscalSnapshotSha256({identity: supplementActorIdentity(who), binding: req.binding, key: req.idempotencyKey});
      return {req, sha, operationId: deterministicUuid(sha)};
    }).sort((a, b) => b.sha.localeCompare(a.sha));
    assert.ok(ordered[0].operationId > ordered[1].operationId && ordered[1].operationId > ordered[2].operationId,
      'FIXTURE_OPERATION_IDS_MUST_BE_LEXICALLY_DESCENDING');
    const created = [];
    for (const [index, planned] of ordered.entries()) {
      if (index === 2) {
        const rows = await client.document.findMany({where: {id: {in: created}}, select: {id: true}, orderBy: [{issueDate: 'asc'}, {id: 'asc'}]});
        assert.deepEqual(rows.map(row => row.id), [...created].reverse(), 'DB_ID_ORDER_MUST_OPPOSE_CREATION_ORDER');
      }
      const result = await facade({who}).app.create('synthetic-token', 'SERVICE', planned.req);
      assert.equal(result.operationId, planned.operationId);
      const command = await outcomes.command(result.operationId), history = command.payload.envelope.context.creditHistory.entries;
      assert.deepEqual(history.map(entry => entry.note.documentId), created);
      assert.ok(history.every(entry => entry.state === 'RESERVED'));
      assert.equal(command.payload.envelope.note.issueDate, issueDate);
      created.push(result.operationId);
    }
    const current = await facade({who}).app.status('synthetic-token', 'SERVICE', ordered[2].req.binding, created[2]);
    assert.equal(current.result.creditHeld, '177.00'); assert.equal(current.result.netAmount, '236.00');
    assert.equal((await events(doc)).length, 3); assert.deepEqual(await originalRow(doc), before);
  });
  await check('DDL_EVENTS_AND_RECEIPTS_APPEND_ONLY_AND_HEAD_MONOTONIC', async () => {
    const before = await persistedState();
    for (const sql of [
      'UPDATE "B2bCorrectionJournalEvent" SET "versionSha256"="versionSha256"',
      'DELETE FROM "B2bCorrectionJournalEvent"',
      'UPDATE "B2bCorrectionRequestReceipt" SET "requestSha256"="requestSha256"',
      'DELETE FROM "B2bCorrectionRequestReceipt"',
    ]) await assert.rejects(pool.query(sql), /CORRECTION_JOURNAL_APPEND_ONLY/);
    await assert.rejects(pool.query('UPDATE "B2bCorrectionJournalHead" SET "revision"="revision"'), /CORRECTION_JOURNAL_HEAD_MONOTONIC/);
    await assert.rejects(pool.query('DELETE FROM "B2bCorrectionJournalHead"'), /CORRECTION_JOURNAL_HEAD_MONOTONIC/);
    assert.deepEqual(await persistedState(), before);
  });
  await check('FINAL_NO_TRANSMISSION_NO_FAKE_HUMAN_NO_SYNTHETIC_HOLD_ADOPTION', async () => {
    assert.ok((await client.outboxEvent.findMany({select: {publishedAt: true}})).every(e => e.publishedAt === null));
    assert.ok((await client.document.findMany({where: {type: {in: ['CREDIT_NOTE', 'DEBIT_NOTE']}}, select: {createdByUserId: true, createdByActor: true}}))
      .every(n => n.createdByUserId === null && n.createdByActor.kind === 'SERVICE' && n.createdByActor.subjectId === null));
    assert.equal(await client.dailySummary.count(), 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM "B2bCorrectionHold"')).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM "B2bCorrectionHoldHead"')).rows[0].n, 0);
    assert.deepEqual(await originalRow(first.doc), originalBefore);
    assert.deepEqual(await originalRow(business.doc), business.originalState);
    assert.match(fiscalSnapshotSha256(supplementActorIdentity(actor)), /^[a-f0-9]{64}$/);
  });
}).then(() => { if (failures.length) process.exitCode = 1;
  console.log(JSON.stringify({result: failures.length ? 'FAIL' : 'PASS', passed, failures, officialNetwork: false, realData: false, qaRuntimeChanged: false,
  proofSource: 'SEALED_SYNTHETIC_FIXTURE_ONLY', pkiTrustVerified: false,
  limits: ['No official dispatch or PKI validation; sealed proof fixtures only.', 'Candidate V2 journal and unregistered business facade; no QA or production activation.']})); })
  .catch(error => { console.error(JSON.stringify({result: 'FAIL', stage, detailStage, passed, code: error?.code ?? null,
    model: typeof error?.meta?.modelName === 'string' ? error.meta.modelName : null,
    prismaMetaCode: error?.meta?.code ?? null,
    driverOriginalCode: error?.meta?.driverAdapterError?.cause?.originalCode ?? null,
    postgresCode: error?.meta?.code ?? error?.meta?.driverAdapterError?.cause?.originalCode ?? null,
    postgresMessage: String(error?.meta?.message ?? error?.meta?.driverAdapterError?.cause?.originalMessage ?? '').slice(0, 350),
    frames: String(error?.stack ?? '').split('\n').filter(line => /^\s+at /.test(line)).slice(-8),
    uniqueTarget: Array.isArray(error?.meta?.target) ? error.meta.target : null,
    reason: error?.name ?? 'FAILURE', detail: error?.code ? null : String(error?.message ?? 'FAILURE').slice(0, 240), qaRuntimeChanged: false})); process.exitCode = 1; });
