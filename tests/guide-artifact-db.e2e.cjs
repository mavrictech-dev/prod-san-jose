'use strict';
// NEW labelled tmpfs PostgreSQL only, --network none/no ports/--rm. No .env,
// customer data, official transport, schema changes on an existing database.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { readFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { resolve } = require('node:path');
const { withCorrectionDatabase } = require('./helpers/correction-reservation-db.cjs');
const local = createRequire(require.resolve('../services/sunat-service/package.json'));
const { PostgresGuideArtifactStore } = local('./dist/application/guide-artifact-store');
const { GuideArtifactPipeline } = local('./dist/application/guide-artifact-pipeline');
const { signLocalGuideXml } = local('./dist/infrastructure/crypto/guide-artifact-crypto');
const { XmlSignerService, parseSafeInvoice, verifyLocalSignedInvoice } = local('./dist/infrastructure/crypto/xml-signer.service');
const { zipSync } = local('fflate');
const { fiscalSnapshotSha256: hash } = local('@factuez/sunat-core/dist/fiscal-note');
const forge = local('node-forge');
const ruc = '20000000001';
let stage = 'PREFLIGHT';
const uuid = () => randomUUID();
function pki(issuerRuc = ruc) {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 65537 }), cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey; cert.serialNumber = '781001';
  cert.validity.notBefore = new Date(Date.now() - 86400000); cert.validity.notAfter = new Date(Date.now() + 86400000);
  const subject = [{ name: 'commonName', value: 'EPHEMERAL SYNTHETIC GUIDE ORIGINAL TEST' }, { type: '2.5.4.97', value: 'NTRPE-' + issuerRuc }];
  cert.setSubject(subject); cert.setIssuer(subject);
  cert.setExtensions([{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const password = 'FICTITIOUS-LOCAL-TEST-ONLY';
  const p12 = Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: 'aes256' })).getBytes(), 'binary');
  return { p12, password, certificatePem: forge.pki.certificateToPem(cert) };
}
function owned(number) {
  const binding = { draft: { anchor: { issuerId: 1, issuerRuc: ruc, environment: 'BETA', branchId: uuid(), pointId: uuid(), seriesId: uuid(), documentType: '01' }, guideSeriesId: uuid(), guideType: '09' }, fiscalSeriesId: uuid() };
  const scope = { binding, draftId: uuid(), operationId: uuid() }, issuer = { ruc, legalName: 'EMISOR FICTICIO NUEVA BD' };
  const body = { issueDate: '2026-10-21T15:30:00.000Z', transferDate: '2026-10-21', reasonCode: '04',
    origin: { ubigeo: '150101', address: 'ORIGEN FICTICIO', establishmentCode: '0001' },
    destination: { ubigeo: '150102', address: 'DESTINO FICTICIO', establishmentCode: '0002' },
    sender: issuer, recipient: issuer, grossWeight: '1.250', weightUnit: 'KGM',
    transport: { mode: '02', vehicle: { plate: 'ABC123', registration: 'REG00001' }, driver: { identityType: '1', identityNumber: '00000001', firstName: 'CONDUCTOR', lastName: 'FICTICIO', license: 'A000000001' } },
    items: [{ code: 'FICTICIO', description: 'BIEN FICTICIO', quantity: '1', unitCode: 'NIU' }], references: [], regulatedGoods: false };
  const snapshot = { schemaVersion: 'factuez.guide-issued-local.v1', documentId: uuid(), operationId: scope.operationId, binding,
    draftId: scope.draftId, draftRevision: 1, issuer, series: 'TST0', number: String(number), fullNumber: `TST0-${number}`,
    body, bodySha256: hash(body), contextSha256: hash({ synthetic: true }), at: '2026-10-22T15:00:00.000Z',
    candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false, authorizedForTransfer: false,
    officialRulesValidated: false, officialCdrVerified: false, numberReserved: true };
  const issuance = { schemaVersion: 'factuez.b2b.guide-issuance.v1', operationId: scope.operationId, draftId: scope.draftId,
    binding, snapshot, snapshotSha256: hash(snapshot), replayed: null };
  return { scope, value: { issuance, authorizationSha256: 'a'.repeat(64) } };
}
async function main() {
  assert.deepEqual(process.argv.slice(2), ['--isolated-synthetic-only'], 'EXPLICIT_ISOLATION_REQUIRED');
  const checks = [], check = async (name, work) => { stage = name; await work(); checks.push(name); };
  const material = pki(), fictitiousSunat = pki('20131312955'), access = { token: 'SYNTHETIC_GUIDE_ARTIFACT', kind: 'SERVICE' };
  // Test-only pinned signature verification. This ephemeral certificate is NOT
  // official SUNAT PKI; the pipeline must preserve LOCAL_EMULATOR and closed gates.
  const verifier = { verify: async bytes => {
    try {
      const xml = bytes.toString('utf8'), p = parseSafeInvoice(xml, 'ApplicationResponse');
      const signatures = p.document.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature');
      if (signatures.length !== 1) return false; p.extension.removeChild(signatures[0]);
      verifyLocalSignedInvoice(xml, fictitiousSunat.certificatePem, p.root.toString(), 'ApplicationResponse'); return true;
    } catch { return false; }
  } };
  await withCorrectionDatabase(async ({ client, pool }) => {
    stage = 'APPLY_NEW_DB_SCHEMA';
    const ddl = readFileSync(resolve(__dirname, '../services/sunat-service/guide-artifacts-schema.candidate.sql'), 'utf8');
    // Existing helper created this DB from EMPTY; no application's active DB is used.
    await pool.query(ddl);
    let signs = 0;
    const signer = { mode: 'ISOLATED_LOCAL_SIGNER', sign: async input => { signs++; return signLocalGuideXml(input, material.p12, material.password); } };
    const make = (data, database = client) => {
      const owner = { current: async scope => { assert.equal(hash(scope), hash(data.scope)); return structuredClone(data.value); } };
      return { store: new PostgresGuideArtifactStore(database), core: new GuideArtifactPipeline(owner,
        new PostgresGuideArtifactStore(database), signer, [ruc], verifier, () => '2026-10-23T16:00:00.000Z') };
    };
    const first = owned(1), a = make(first);
    let prepared;
    await check('real-package-persisted-and-replayed-after-restart', async () => {
      prepared = await a.core.prepare(first.scope, access);
      const replay = await make(first).core.prepare(first.scope, access);
      assert.equal(prepared.replayed, false); assert.equal(replay.replayed, true); assert.equal(signs, 1);
      assert.ok(prepared.record.zip.equals(replay.record.zip)); assert.equal(prepared.record.signedXml, replay.record.signedXml);
      assert.equal((await pool.query('SELECT count(*)::int n FROM "GuideLocalArtifact"')).rows[0].n, 1);
    });
    await check('concurrent-preparation-one-original', async () => {
      const data = owned(2), b = make(data);
      const outcomes = await Promise.all([b.core.prepare(data.scope, access), b.core.prepare(data.scope, access)]);
      assert.equal(outcomes.filter(o => !o.replayed).length, 1);
      assert.ok(outcomes[0].record.zip.equals(outcomes[1].record.zip));
    });
    await check('database-blocks-update-delete-truncate', async () => {
      for (const sql of ['UPDATE "GuideLocalArtifact" SET "fullNumber"=\'TST0-999\'', 'DELETE FROM "GuideLocalArtifact"', 'TRUNCATE "GuideLocalArtifact"'])
        await assert.rejects(() => pool.query(sql));
      assert.equal((await pool.query('SELECT count(*)::int n FROM "GuideLocalArtifact"')).rows[0].n, 2);
    });
    await check('full-scope-cannot-be-swapped', async () => {
      const scope = structuredClone(first.scope); scope.binding.draft.anchor.branchId = uuid();
      await assert.rejects(() => a.store.transaction(scope, tx => tx.read()));
    });
    await check('global-fiscal-identity-unique-across-companies', async () => {
      const data = owned(1); data.scope.binding.draft.anchor.issuerId = 99;
      data.value.issuance.snapshotSha256 = hash(data.value.issuance.snapshot);
      await assert.rejects(() => make(data).core.prepare(data.scope, access), e => e.code === 'GUIDE_ARTIFACT_IDENTITY_CONFLICT');
      assert.equal((await pool.query('SELECT count(*)::int n FROM "GuideLocalArtifact"')).rows[0].n, 2);
    });
    await check('owner-revocation-after-physical-insert-rolls-back', async () => {
      const data = owned(3);
      const database = { $transaction: (work, options) => client.$transaction(tx => work({
        $queryRawUnsafe: (sql, ...values) => tx.$queryRawUnsafe(sql, ...values),
        $executeRawUnsafe: async (sql, ...values) => {
          const count = await tx.$executeRawUnsafe(sql, ...values);
          if (sql.includes('INSERT INTO "GuideLocalArtifact"')) data.value.authorizationSha256 = 'b'.repeat(64);
          return count;
        }
      }), options) };
      await assert.rejects(() => make(data, database).core.prepare(data.scope, access), e => e.code === 'GUIDE_ARTIFACT_OWNER_CHANGED');
      assert.equal((await pool.query('SELECT count(*)::int n FROM "GuideLocalArtifact" WHERE "operationId"=$1', [data.scope.operationId])).rows[0].n, 0);
    });
    await check('swallowed-write-error-poisons-owner-transaction', async () => {
      await assert.rejects(() => a.store.transaction(first.scope, async tx => {
        try { await tx.insert(prepared.record); } catch { /* callback cannot convert failed write into success */ }
        return 'incorrect-success';
      }));
      assert.equal((await pool.query('SELECT count(*)::int n FROM "GuideLocalArtifact"')).rows[0].n, 2);
    });
    await check('escaped-transaction-capability-closed', async () => {
      let retained; await a.store.transaction(first.scope, async tx => { retained = tx; await tx.read(); });
      await assert.rejects(() => retained.read()); await assert.rejects(() => retained.insert(prepared.record));
    });
    await check('cdr-fk-and-source-guards', async () => {
      await assert.rejects(() => pool.query('INSERT INTO "GuideLocalCdr" VALUES ($1,$2,$3,$4)',
        [uuid(), 'a'.repeat(64), JSON.stringify({ officialCdrVerified: true }), Buffer.alloc(30)]));
      assert.equal((await pool.query('SELECT count(*)::int n FROM "GuideLocalCdr"')).rows[0].n, 0);
    });
    await check('original-signed-cdr-persisted-revalidated-and-immutable', async () => {
      const cbc = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2', cac = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
      const unsigned = `<ApplicationResponse xmlns="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2" xmlns:cbc="${cbc}" xmlns:cac="${cac}" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"><ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions><cbc:ID>FICTITIOUS-LOCAL-CDR</cbc:ID><cbc:IssueDate>2026-10-23</cbc:IssueDate><cbc:IssueTime>10:30:00-05:00</cbc:IssueTime><cac:SenderParty><cac:PartyIdentification><cbc:ID>20131312955</cbc:ID></cac:PartyIdentification></cac:SenderParty><cac:ReceiverParty><cac:PartyIdentification><cbc:ID>${ruc}</cbc:ID></cac:PartyIdentification></cac:ReceiverParty><cac:DocumentResponse><cac:Response><cbc:ReferenceID>TST0-1</cbc:ReferenceID><cbc:ResponseCode>0</cbc:ResponseCode><cbc:Description>FICTITIOUS RESPONSE</cbc:Description></cac:Response><cac:DocumentReference><cbc:ID>TST0-1</cbc:ID><cbc:DocumentTypeCode>09</cbc:DocumentTypeCode></cac:DocumentReference></cac:DocumentResponse></ApplicationResponse>`;
      const signed = new XmlSignerService().sign(unsigned, fictitiousSunat.p12, fictitiousSunat.password, 'ApplicationResponse');
      const zip = Buffer.from(zipSync({ [`R-${ruc}-09-TST0-1.xml`]: Buffer.from(signed.xml) }, { level: 0, mtime: new Date(2000,0,1) }));
      const archived = await a.core.reviewCdr(first.scope, access, zip), read = await make(first).core.readCdr(first.scope, access);
      assert.ok(archived.zip.equals(zip)); assert.ok(read.zip.equals(zip));
      assert.equal(read.evidence.officialCdrVerified, false); assert.equal(read.evidence.source, 'LOCAL_EMULATOR');
      await a.core.reviewCdr(first.scope, access, zip);
      assert.equal((await pool.query('SELECT count(*)::int n FROM "GuideLocalCdr"')).rows[0].n, 1);
      for (const sql of ['UPDATE "GuideLocalCdr" SET "packageSha256"=repeat(\'b\',64)', 'DELETE FROM "GuideLocalCdr"', 'TRUNCATE "GuideLocalCdr"'])
        await assert.rejects(() => pool.query(sql));
      assert.ok((await a.core.readCdr(first.scope, access)).zip.equals(zip));
    });
  });
  material.p12.fill(0);
  fictitiousSunat.p12.fill(0);
  console.log(JSON.stringify({ result: 'PASS', checks }));
}
main().catch(e => { console.error(JSON.stringify({ result: 'FAIL', stage,
  code: /^[A-Z0-9_]+$/.test(e?.code ?? '') ? e.code : 'ISOLATED_GUIDE_ARTIFACT_TEST_FAILED',
  frames: String(e?.stack ?? '').split('\n').filter(s => /^\s+at /.test(s)).slice(0,3) })); process.exitCode = 1; });
