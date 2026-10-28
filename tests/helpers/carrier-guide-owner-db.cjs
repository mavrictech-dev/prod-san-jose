'use strict';
// Only this helper's newly-created labelled network-none/tmpfs PostgreSQL.
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { withCorrectionDatabase } = require('./correction-reservation-db.cjs');

async function withCarrierGuideOwnerFixture(work) {
  return withCorrectionDatabase(async ({ client, pool, local }) => {
    const root = resolve(__dirname, '../..');
    for (const file of ['b2b-guide-drafts-schema.candidate.sql', 'carrier-guide-schema.candidate.sql'])
      await pool.query(readFileSync(resolve(root, 'services/billing-service', file), 'utf8'));
    const { createCarrierGuideOwner } = local('./dist/b2b/carrier-guide-assembly');
    const { createCarrierReference09Ingestion } = local('./dist/b2b/carrier-guide-reference');
    const { fiscalSnapshotSha256: hash } = local('@factuez/sunat-core/dist/fiscal-note');
    const { projectPublicGuide09OwnerSnapshot } = local('@factuez/sunat-core/dist/public-guide-profile');
    const { B2bSecurityError } = local('@factuez/contracts/b2b-security');
    const ids = Object.fromEntries(['branch', 'point', 'anchor', 'guide', 'counter', 'client', 'subject', 'reference', 'ownerBranch', 'ownerOperation'].map(k => [k, randomUUID()]));
    const carrier = { ruc: '20000000028', legalName: 'TRANSPORTISTA FICTICIO LOCAL' };
    const sender = { ruc: '20000000001', legalName: 'REMITENTE FICTICIO LOCAL' };
    const now = '2026-10-23T16:00:00.000Z';
    const binding = { draft: { anchor: { issuerId: 1, issuerRuc: carrier.ruc, environment: 'BETA', branchId: ids.branch,
      pointId: ids.point, seriesId: ids.anchor, documentType: '01' }, guideSeriesId: ids.guide, guideType: '31' }, fiscalSeriesId: ids.counter };
    const ownerSnapshot = { schemaVersion: 'factuez.public-guide09-issued-owner.v1', companyId: 9, branchId: ids.ownerBranch,
      documentId: ids.reference, operationId: ids.ownerOperation, issuer: sender, series: 'TQ31', number: '9', body: {
        issueDate: '2026-10-23T12:00:00.000Z', transferDate: '2026-10-24', sender, recipient: { ruc: '20000000036', legalName: 'DESTINATARIO FICTICIO' },
        origin: { ubigeo: '150101', address: 'ORIGEN FICTICIO & <UNO>' }, destination: { ubigeo: '150102', address: 'DESTINO FICTICIO' },
        carrier, grossWeight: '1.250', weightUnit: 'KGM', transportMode: '01', regulatedGoods: false,
        reasonCode: '01', mtcRegistration: 'MTC00031', items: [
          { code: 'LOCAL-1', description: 'BIEN FICTICIO & <UNO>', quantity: '2.0000000001', unitCode: 'NIU' },
          { code: 'LOCAL-2', description: 'SEGUNDO BIEN FICTICIO', quantity: '3', unitCode: 'NIU' } ] } };
    const reference = projectPublicGuide09OwnerSnapshot(ownerSnapshot);
    const body = { issueDate: '2026-10-23T15:00:00.000Z', transferDate: reference.transferDate, sender: reference.sender,
      recipient: reference.recipient, origin: reference.origin, destination: reference.destination, grossWeight: reference.grossWeight,
      weightUnit: reference.weightUnit, transport: { mode: '01', carrier: { ...carrier, mtcRegistration: 'MTC00031' },
        vehicle: { plate: 'ABC931', tuc: 'TUC00031' }, driver: { identityType: '1', identityNumber: '00000001',
          firstName: 'CONDUCTOR FICTICIO', lastName: 'LOCAL', license: 'A000000031' } },
      reference09: { documentId: ids.reference, issuerRuc: sender.ruc, series: reference.series, number: reference.number, snapshotSha256: hash(reference) },
      items: reference.items, totalTransfer: true, freightPayer: 'SENDER', subcontracted: false, regulatedGoods: false };
    const catalogueUnsigned = { schemaVersion: 'factuez.guide-reference-catalogue.v1', version: 'SYNTHETIC-LOCAL31-v1',
      sourceUrl: 'https://www.sunat.gob.pe/local-reference', sourceSha256: 'c'.repeat(64), units: ['NIU'], weightUnits: ['KGM'],
      ubigeos: ['150101', '150102'], referenceStatus: 'LOCAL_REFERENCE_NOT_OFFICIAL' };
    const registryUnsigned = { schemaVersion: 'factuez.carrier-guide-registry.v1', companyId: 1, issuerRuc: carrier.ruc,
      issuerRevision: 1, revision: 1, catalogue: { ...catalogueUnsigned, sha256: hash(catalogueUnsigned) },
      mtcRegistration: 'MTC00031', routes: [{ origin: body.origin, destination: body.destination }],
      goods: body.items.map(({ code, description, unitCode }) => ({ code, description, unitCode, classification: 'NON_REGULATED' })),
      vehicles: [body.transport.vehicle], drivers: [body.transport.driver] };
    const registry = { ...registryUnsigned, sha256: hash(registryUnsigned) };
    await pool.query(`INSERT INTO "CompanySettings" ("id","ruc","legalName","companyType","economicActivities","taxAddress","ubigeo","contactEmails","updatedAt")
      VALUES (1,$1,$2,'SYNTHETIC',ARRAY[]::text[],'DIRECCION FICTICIA','150101',ARRAY[]::text[],now())`, [carrier.ruc, carrier.legalName]);
    await pool.query(`INSERT INTO "Branch" ("id","companyId","code","name") VALUES ($1,1,'SYNTHETIC31','SUCURSAL FICTICIA')`, [ids.branch]);
    await pool.query(`INSERT INTO "EmissionPoint" ("id","companyId","branchId","code","name","updatedAt") VALUES ($1,1,$2,'SYNTHETIC31','PUNTO FICTICIO',now())`, [ids.point, ids.branch]);
    await pool.query(`INSERT INTO "SeriesCounter" ("id","companyId","emissionPointId","documentType","series","updatedAt") VALUES
      ($1,1,$3,'INVOICE','FQ31',now()),($2,1,$3,'DESPATCH_ADVICE','VQ31',now())`, [ids.anchor, ids.counter, ids.point]);
    await pool.query(`INSERT INTO "B2bGuideDraftSeries" ("id","companyId","pointId","guideType","label") VALUES ($1,1,$2,'31','VQ31')`, [ids.guide, ids.point]);
    await pool.query(`INSERT INTO "CarrierGuideSeries" ("draftSeriesId","fiscalSeriesId","companyId") VALUES ($1,$2,1)`, [ids.guide, ids.counter]);
    await pool.query(`INSERT INTO "CarrierGuideRegistryVersion" ("companyId","revision","payload") VALUES (1,1,$1)`, [registry]);
    await pool.query(`INSERT INTO "CarrierGuideRegistryHead" ("companyId","revision","active") VALUES (1,1,true)`);
    const control = { revoked: false, issueAllowed: true, readAllowed: true, clientRevision: 1, grantRevision: 1, userAuthRevision: 2,
      cryptoRevoked: false, cryptoCalls: 0, authorityCalls: 0, authorityHook: null, cryptoHook: null };
    const token = 'synthetic-carrier-owner-token';
    const authority = { current: async (t, kind, b, action) => {
      assert.equal(t, token); control.authorityCalls++; await control.authorityHook?.(action);
      if (control.revoked || !control[action === 'ISSUE' ? 'issueAllowed' : 'readAllowed']) throw new B2bSecurityError(403, 'SYNTHETIC_AUTHORITY_DENIED');
      const subjectId = kind === 'USER' ? ids.subject : null;
      return { capability: 'BETA_CARRIER_GUIDE_ISSUE_LOCAL', action, binding: structuredClone(b), clientRevision: control.clientRevision, grantRevision: control.grantRevision,
        actor: { userId: subjectId, scope: { kind: 'ASSIGNED', branchIds: [b.draft.anchor.branchId], emissionPointIds: [b.draft.anchor.pointId],
          series: [b.draft.anchor.seriesId, b.draft.guideSeriesId, b.fiscalSeriesId] },
        b2b: { kind, clientId: ids.client, revision: control.clientRevision, subjectId, userAuthRevision: kind === 'USER' ? control.userAuthRevision : null } } };
    } };
    const artifacts = { signedXml: Buffer.from('SYNTHETIC-REFERENCE-XML-NOT-A-REAL-SIGNATURE'), cdrXml: Buffer.from('SYNTHETIC-REFERENCE-CDR-NOT-A-REAL-SIGNATURE') };
    const digest = b => createHash('sha256').update(b).digest('hex');
    // Explicit test double only. The separate Main-owned crypto integration must
    // replace this with real ephemeral signatures and its concrete SUNAT adapter.
    const validator = { verify: async v => {
      control.cryptoCalls++; await control.cryptoHook?.();
      if (control.cryptoRevoked) throw new Error('SYNTHETIC_CRYPTO_REVOKED');
      assert.deepEqual(v.ownerSnapshot, ownerSnapshot); assert.deepEqual(v.projection, reference);
      assert.equal(v.ownerSnapshotSha256, hash(ownerSnapshot)); assert.equal(v.projectionSha256, hash(reference));
      assert.ok(Buffer.from(v.signedXml).equals(artifacts.signedXml)); assert.ok(Buffer.from(v.cdrXml).equals(artifacts.cdrXml));
      assert.equal(v.signedXmlSha256, digest(artifacts.signedXml)); assert.equal(v.cdrSha256, digest(artifacts.cdrXml));
      return { environment: 'BETA', documentId: reference.documentId, issuerRuc: sender.ruc, fullNumber: 'TQ31-9',
        snapshotSha256: hash(reference), cdrSha256: digest(artifacts.cdrXml), responseCode: '0', status: 'ACCEPTED', acceptedAt: '2026-10-23T13:00:00.000Z' };
    } };
    const makeOwner = (referenceValidator = validator, database = client) => createCarrierGuideOwner({ database, authority, referenceValidator, allowedRucs: [carrier.ruc], now: () => now });
    const ingest = (referenceValidator = validator) => createCarrierReference09Ingestion(client, referenceValidator, () => now).ingest(ownerSnapshot, artifacts,
      { companyId: 1, branchId: ids.branch, issuerRuc: carrier.ruc });
    const owner = makeOwner();
    let serial = 0;
    async function ready(kind = 'SERVICE', ownerInstance = owner, bodyInput = body) {
      const draftId = randomUUID();
      await ownerInstance.persistReadyDraft(token, kind, { binding, draftId, body: structuredClone(bodyInput) });
      return { schemaVersion: 'factuez.b2b.carrier-guide-issue.v1', binding: structuredClone(binding), draftId,
        expectedRevision: '"v1"', idempotencyKey: 'synthetic_carrier_key_' + String(++serial).padStart(8, '0') };
    }
    const state = async () => (await pool.query(`SELECT
      (SELECT "nextNumber"::text FROM "SeriesCounter" WHERE "id"=$1) AS counter,
      (SELECT count(*)::int FROM "CarrierGuideDocument") AS documents,
      (SELECT count(*)::int FROM "CarrierGuideItem") AS items,
      (SELECT count(*)::int FROM "CarrierGuideReceipt") AS receipts,
      (SELECT count(*)::int FROM "CarrierGuideLocalOutbox") AS events,
      (SELECT count(*)::int FROM "Document") AS legacy_documents,
      (SELECT count(*)::int FROM "OutboxEvent") AS legacy_events`, [ids.counter])).rows[0];
    const scope = r => ({ binding: r.binding, draftId: r.draftId, operationId: r.operationId });
    const faultDatabase = hook => ({ $transaction: (callback, options) => client.$transaction(sql => callback({
      $queryRawUnsafe: (text, ...values) => sql.$queryRawUnsafe(text, ...values),
      $executeRawUnsafe: async (text, ...values) => { const n = await sql.$executeRawUnsafe(text, ...values); await hook(text); return n; },
    }), options) });
    return work({ client, pool, local, root, ids, carrier, sender, now, binding, body, reference, ownerSnapshot, artifacts, registry,
      control, token, authority, validator, hash, makeOwner, ingest, owner, ready, state, scope, faultDatabase });
  });
}
module.exports = { withCarrierGuideOwnerFixture };
