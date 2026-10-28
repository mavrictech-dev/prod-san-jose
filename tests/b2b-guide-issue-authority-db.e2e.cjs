'use strict';
// Candidate rehearsal only. Main owns builds and invocation; never discovers a DB URL.
const assert = require('node:assert/strict');
const { generateKeyPairSync, randomBytes, randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--isolated-synthetic-only'])) throw new Error('ISOLATED_SYNTHETIC_ONLY_REQUIRED');
const { withCorrectionAuthorityDatabases } = require('./helpers/correction-authority-db.cjs');
let stage = 'PREFLIGHT'; const passed = [];
withCorrectionAuthorityDatabases(async ({ identityClient, identityPool, billingClient, i }) => {
  // The shared helper creates NEW disposable databases in a labelled, networkless tmpfs container.
  await identityPool.query(readFileSync(resolve(__dirname, '../services/identity-service/b2b-guide-issue-grants-schema.candidate.sql'), 'utf8'));
  const { B2bIdentity } = i('./dist/b2b/service');
  const { B2bTokenCodec } = i('./dist/b2b/token');
  const { PostgresB2bStore } = i('./dist/b2b/postgres-store');
  const { PostgresB2bGuideIssueStore } = i('./dist/b2b/guide-issue-store');
  const { B2bGuideIssueAuthority } = i('./dist/b2b/guide-issue-authority');
  const { PostgresLinkedUsers } = i('./dist/b2b/users');
  const { PostgresQueuedUsers } = i('./dist/b2b/webhook-authority');
  const { B2bEnabledIdentityScopes } = i('@factuez/contracts/b2b-security');
  const { B2bIdentityError } = i('./dist/b2b/model');
  const { b2bGuideIssueScopes, b2bGuideIssueReadScopes } = i('@factuez/contracts/b2b-guide-security');
  const scopes = [...new Set([...b2bGuideIssueScopes, ...b2bGuideIssueReadScopes])];
  const branch = randomUUID(), point = randomUUID(), original = randomUUID(), draft = randomUUID(), fiscal = randomUUID(), userId = randomUUID(), adminId = randomUUID();
  const binding = { draft: { anchor: { issuerId: 1, issuerRuc: '00000000001', environment: 'BETA', branchId: branch,
    pointId: point, seriesId: original, documentType: '01' }, guideSeriesId: draft, guideType: '09' }, fiscalSeriesId: fiscal };
  const ctx = () => ({ requestId: randomUUID(), peer: 'SYNTHETIC-GUIDE-ISSUE-AUTHORITY-DB' });
  const check = async (name, work) => { stage = name; await work(); passed.push(name); };
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = Buffer.from(generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }));
  const codec = new B2bTokenCodec(Buffer.from(key.privateKey.export({ type: 'pkcs8', format: 'pem' })),
    'https://synthetic-identity.invalid', () => 1800000000, { human: other, integration: other, tls: other });
  let verifyCount = 0, revokeAt = Infinity;
  const admin = { verify: async token => {
    assert.equal(token, 'synthetic-step-up');
    if (++verifyCount === revokeAt) throw new B2bIdentityError(403, 'STEP_UP_REQUIRED');
    return { id: adminId, stepUpVerified: true };
  } };
  let delegated = null, ownerActive = true, catalogueHook = null;
  // The real Billing RPC/metadata chain is covered by main; this bounded owner port models
  // refusal and history semantics without accessing a second owner's data from Identity SQL.
  const catalogue = { validate: async (bindings, action) => {
    assert.deepEqual(bindings, [binding]); assert.ok(['ISSUE', 'READ'].includes(action));
    if (action === 'ISSUE' && !ownerActive) throw new B2bIdentityError(404, 'RESOURCE_NOT_FOUND');
    if (catalogueHook) await catalogueHook();
  } };
  const identity = new B2bIdentity(new PostgresB2bStore(identityClient), codec, randomBytes(32), admin,
    { validate: async values => assert.deepEqual(values, [binding.draft.anchor]) },
    { verify: async () => structuredClone(delegated) }, () => 1800000000000, B2bEnabledIdentityScopes);
  const users = new PostgresQueuedUsers(identityClient, new PostgresLinkedUsers(identityClient, { effective: async () => [] }));
  const store = new PostgresB2bGuideIssueStore(identityClient);
  const authority = new B2bGuideIssueAuthority(store, identity, catalogue, admin, users);
  const made = await identity.create('synthetic-step-up', { label: 'SYNTHETIC GUIDE ISSUE', kind: 'SERVICE', scopes, bindings: [binding.draft.anchor] }, ctx());
  const access = async secret => (await identity.token('Basic ' + Buffer.from(made.client.id + ':' + secret).toString('base64'),
    { grant_type: 'client_credentials', scope: scopes.join(' ') }, ctx())).access_token;
  let token = await access(made.clientSecret);
  const authorize = (action = 'ISSUE', pair = binding) => authority.authorize(token, { action, binding: pair, kind: 'SERVICE' }, ctx());
  const replace = (bindings = [binding], expectedGrantRevision = 0, expectedClientRevision = 1) =>
    authority.replace('synthetic-step-up', made.client.id, { bindings, expectedGrantRevision, expectedClientRevision }, ctx());
  const head = async () => (await identityPool.query('SELECT "revision" FROM "B2bGuideIssueGrantHead" WHERE "clientId"=$1', [made.client.id])).rows[0]?.revision;
  const revisions = async () => (await identityPool.query('SELECT count(*)::int n FROM "B2bGuideIssueGrantRevision" WHERE "clientId"=$1', [made.client.id])).rows[0].n;
  await check('INDEPENDENT_GRANT_REAL_IDENTITY_JWT_RESTART_AND_DENIAL_AUDIT', async () => {
    await assert.rejects(authorize(), error => error.status === 404);
    assert.equal((await identityPool.query('SELECT count(*)::int n FROM "B2bAudit" WHERE "action"=$1 AND "outcome"=$2', ['AUTHORIZE_GUIDE_ISSUE_ISSUE', 'DENIED'])).rows[0].n, 1);
    await replace();
    const restarted = new B2bGuideIssueAuthority(new PostgresB2bGuideIssueStore(identityClient), identity, catalogue, admin, users);
    const answer = await restarted.authorize(token, { kind: 'SERVICE', binding, action: 'ISSUE' }, ctx());
    assert.equal(Object.keys(answer).length, 10); assert.equal(answer.actor.userId, null);
    assert.deepEqual(answer.actor.scope.series, [original, draft, fiscal]);
    assert.equal(answer.capability, 'BETA_GUIDE_ISSUE_LOCAL'); assert.equal(answer.transmissionAuthorized, false);
    assert.equal(answer.grantRevision, 1); assert.equal(await revisions(), 1);
  });
  await check('EXACT_WHOLE_PAIR_AND_HISTORY_READ_ACTION', async () => {
    await assert.rejects(authorize('ISSUE', { ...binding, fiscalSeriesId: randomUUID() }), error => error.status === 404);
    ownerActive = false; await assert.rejects(authorize(), error => error.status === 404);
    assert.equal((await authorize('READ')).action, 'READ'); ownerActive = true;
  });
  await check('SERIALIZABLE_CAS_SINGLE_WINNER_AND_APPEND_ONLY_HISTORY', async () => {
    const results = await Promise.allSettled([replace([binding], 1), replace([], 1)]);
    assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(results.filter(row => row.status === 'rejected' && row.reason.status === 409).length, 1);
    assert.equal(await head(), 2); assert.equal(await revisions(), 2); await replace([binding], 2);
  });
  await check('LATE_STEPUP_REVOCATION_ROLLS_BACK_GRANT_AND_AUDIT', async () => {
    const before = (await identityPool.query('SELECT count(*)::int n FROM "B2bAudit"')).rows[0].n;
    verifyCount = 0; revokeAt = 3;
    await assert.rejects(replace([], 3), error => error.status === 403); revokeAt = Infinity;
    assert.equal(await head(), 3); assert.equal(await revisions(), 3);
    assert.equal((await identityPool.query('SELECT count(*)::int n FROM "B2bAudit"')).rows[0].n, before);
  });
  await check('SWALLOWED_AUDIT_FAILURE_POISONS_AND_ROLLS_BACK', async () => {
    await identityPool.query(`CREATE FUNCTION synthetic_guide_issue_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW."action"='REPLACE_GUIDE_ISSUE_GRANTS' THEN RAISE EXCEPTION 'SYNTHETIC_AUDIT_FAILURE'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER synthetic_guide_issue_audit BEFORE INSERT ON "B2bAudit" FOR EACH ROW EXECUTE FUNCTION synthetic_guide_issue_reject_audit();`);
    await assert.rejects(replace([], 3), error => error.status === 503);
    await assert.rejects(store.transaction(async tx => {
      await tx.get(made.client.id); await tx.guideIssueGrants(made.client.id);
      await tx.saveGuideIssueGrants({ clientId: made.client.id, clientRevision: 1, revision: 4, bindings: [] }, 3, adminId, new Date().toISOString());
      try { await tx.audit({ id: randomUUID(), requestId: randomUUID(), peerHash: 'a'.repeat(64), clientId: made.client.id,
        revision: 1, actorId: adminId, action: 'REPLACE_GUIDE_ISSUE_GRANTS', outcome: 'OK', at: new Date().toISOString() }); } catch {}
    }), error => error.status === 503);
    assert.equal(await head(), 3); assert.equal(await revisions(), 3);
    await identityPool.query('DROP TRIGGER synthetic_guide_issue_audit ON "B2bAudit"; DROP FUNCTION synthetic_guide_issue_reject_audit();');
  });
  await check('IMMUTABLE_REVISION_HEAD_AND_AUDIT_DELETE_TRUNCATE_GUARDS', async () => {
    for (const sql of [
      'UPDATE "B2bGuideIssueGrantRevision" SET "bindings"=\'[]\'::jsonb', 'DELETE FROM "B2bGuideIssueGrantRevision"',
      'UPDATE "B2bGuideIssueGrantHead" SET "revision"=1', 'DELETE FROM "B2bGuideIssueGrantHead"',
      'TRUNCATE "B2bGuideIssueGrantRevision" CASCADE', 'TRUNCATE "B2bGuideIssueGrantHead"',
      'UPDATE "B2bAudit" SET "outcome"=\'DENIED\' WHERE "action"=\'REPLACE_GUIDE_ISSUE_GRANTS\'',
      'DELETE FROM "B2bAudit" WHERE "action"=\'REPLACE_GUIDE_ISSUE_GRANTS\'', 'TRUNCATE "B2bAudit"',
    ]) await assert.rejects(identityPool.query(sql));
    const malformed = [{ ...binding, fiscalSeriesId: original }];
    assert.equal((await identityPool.query('SELECT "b2b_guide_issue_bindings_valid"($1::jsonb) ok', [JSON.stringify(malformed)])).rows[0].ok, false);
    assert.equal((await identityPool.query('SELECT "b2b_guide_issue_bindings_valid"($1::jsonb) ok', [JSON.stringify([binding])])).rows[0].ok, true);
    await assert.rejects(identityPool.query(`INSERT INTO "B2bGuideIssueGrantRevision" ("clientId","revision","clientRevision","bindings","actorId","at")
      VALUES ($1,4,1,$2::jsonb,$3,now())`, [made.client.id, JSON.stringify(malformed), adminId]));
    // A structurally valid orphan revision must also fail the deferred head integrity guard.
    await assert.rejects(identityPool.query(`INSERT INTO "B2bGuideIssueGrantRevision" ("clientId","revision","clientRevision","bindings","actorId","at")
      VALUES ($1,4,1,'[]'::jsonb,$2,now())`, [made.client.id, adminId]));
    assert.equal(await revisions(), 3);
  });
  await check('CLIENT_ROTATION_REQUIRES_EXPLICIT_REGRANT', async () => {
    const changed = await identity.change('synthetic-step-up', made.client.id, { expectedRevision: 1 }, ctx(), true);
    await assert.rejects(authorize(), error => error.status === 401); token = await access(changed.clientSecret);
    await assert.rejects(authorize(), error => error.status === 404); await replace([binding], 3, 2);
    assert.equal((await authorize()).grantRevision, 4);
  });
  await check('REAL_USER_LINK_PERMISSIONS_ALL_THREE_ASSIGNMENTS_AND_MID_RPC_REVOCATION', async () => {
    await identityClient.user.create({ data: { id: userId, username: 'synthetic_guide_issue', fullName: 'SYNTHETIC ONLY', passwordHash: 'SYNTHETIC-NOT-A-LOGIN', authVersion: 3 } });
    const role = await identityClient.role.create({ data: { code: 'CASHIER', name: 'SYNTHETIC ONLY' } });
    for (const code of ['DOCUMENT_VIEW', 'DOCUMENT_ISSUE']) {
      const permission = await identityClient.permission.create({ data: { code, name: 'SYNTHETIC ONLY' } });
      await identityClient.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    }
    await identityClient.userRoleAssignment.create({ data: { userId, roleId: role.id, assignedByUserId: userId } });
    await identityClient.userBranch.create({ data: { userId, branchId: branch } });
    await identityClient.userEmissionPoint.create({ data: { userId, emissionPointId: point, assignedByUserId: userId } });
    await identityClient.userSeries.createMany({ data: [original, draft, fiscal].map(series => ({ userId, series })) });
    const app = await identity.create('synthetic-step-up', { label: 'SYNTHETIC USER', kind: 'USER', oidcClientId: 'synthetic_guide_oidc', scopes, bindings: [binding.draft.anchor] }, ctx());
    await identityPool.query(`INSERT INTO "B2bUserLink" ("issuer","subject","oidcClientId","clientId","clientRevision","userId","userAuthRevision","enabled")
      VALUES ('https://synthetic.invalid','synthetic-guide-user','synthetic_guide_oidc',$1,1,$2,3,true)`, [app.client.id, userId]);
    delegated = { clientId: app.client.id, clientRevision: 1, oidcClientId: 'synthetic_guide_oidc', userId, authRevision: 3, tokenScopes: scopes,
      permissions: ['document.view', 'document.issue'], scope: { kind: 'ASSIGNED', branchIds: [branch], emissionPointIds: [point], series: [original, draft, fiscal] } };
    await authority.replace('synthetic-step-up', app.client.id, { expectedClientRevision: 1, expectedGrantRevision: 0, bindings: [binding] }, ctx());
    const auth = (action = 'ISSUE') => authority.authorize('synthetic-delegated-token', { kind: 'USER', action, binding }, ctx());
    assert.equal((await auth()).actor.userId, userId);
    await identityClient.userSeries.deleteMany({ where: { userId, series: fiscal } });
    await assert.rejects(auth(), error => error.status === 404); await identityClient.userSeries.create({ data: { userId, series: fiscal } });
    catalogueHook = async () => { await identityClient.userSeries.deleteMany({ where: { userId, series: fiscal } }); };
    await assert.rejects(auth(), error => error.status === 404); catalogueHook = null;
    await identityClient.userSeries.create({ data: { userId, series: fiscal } });
    await identityClient.user.update({ where: { id: userId }, data: { authVersion: 4 } });
    await assert.rejects(auth('READ'), error => error.status === 404);
  });
  await check('REVOCATION_AND_ZERO_BILLING_SIDE_EFFECTS', async () => {
    await replace([], 4, 2); await assert.rejects(authorize('READ'), error => error.status === 404);
    assert.equal(await billingClient.document.count(), 0); assert.equal(await billingClient.outboxEvent.count(), 0);
    assert.equal(await billingClient.seriesCounter.count(), 0);
    const denials = (await identityPool.query('SELECT "actorId" FROM "B2bAudit" WHERE "action" IN ($1,$2) AND "outcome"=$3',
      ['AUTHORIZE_GUIDE_ISSUE_ISSUE', 'AUTHORIZE_GUIDE_ISSUE_READ', 'DENIED'])).rows;
    assert.ok(denials.some(row => row.actorId === userId)); assert.ok(denials.some(row => row.actorId === null));
  });
  await check('READ_ONLY_CLIENT_ENROLLS_AND_READS_WITHOUT_DORMANT_ISSUE_SCOPE', async () => {
    const readScopes = [...b2bGuideIssueReadScopes];
    const reader = await identity.create('synthetic-step-up', { label: 'SYNTHETIC READER', kind: 'SERVICE', scopes: readScopes, bindings: [binding.draft.anchor] }, ctx());
    await authority.replace('synthetic-step-up', reader.client.id, { expectedClientRevision: 1, expectedGrantRevision: 0, bindings: [binding] }, ctx());
    const readerToken = (await identity.token('Basic ' + Buffer.from(reader.client.id + ':' + reader.clientSecret).toString('base64'),
      { grant_type: 'client_credentials', scope: readScopes.join(' ') }, ctx())).access_token;
    const value = await authority.authorize(readerToken, { kind: 'SERVICE', binding, action: 'READ' }, ctx());
    assert.equal(value.action, 'READ'); assert.equal(value.actor.b2b.clientId, reader.client.id);
    assert.ok(!reader.client.scopes.includes('b2b:guides:issue'));
    await assert.rejects(authority.authorize(readerToken, { kind: 'SERVICE', binding, action: 'ISSUE' }, ctx()), error => error.status === 403);
    assert.equal(await billingClient.seriesCounter.count(), 0);
  });
}).then(() => {
  console.log(JSON.stringify({ result: 'PASS', checks: passed.length, groups: passed, syntheticOnly: true, ownerDatabases: 2, fiscalExecution: false }));
}).catch(() => {
  console.error(JSON.stringify({ result: 'FAIL', stage, passed: passed.length, syntheticOnly: true })); process.exitCode = 1;
});
