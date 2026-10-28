import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {createRequire} from 'node:module';
import {createHash, randomUUID} from 'node:crypto';
import {correctionEvidenceHash as hash} from '../packages/service-access/src/b2b-correction-evidence-wire';
import type {ReceivedScope} from '../packages/service-access/src/b2b-received-wire';
import {parseReceivedXml} from '../packages/received-core/src/index';
import {B2bReceptionDispatch, type ReceptionDispatchAuthority, type ReceptionDispatchContext} from '../services/received-documents-service/src/b2b/automation-dispatch';
import {PostgresReceptionWriteAuthority} from '../services/received-documents-service/src/b2b/write-authority';
import {emptyCounters, receptionPeriods} from '../services/received-documents-service/src/automation/policy';
import {fixtureMail} from '../services/received-documents-service/src/automation/mail-fixture';
import {fixtureSirePurchases} from '../services/received-documents-service/src/automation/sire-fixture';
import {mailAttachments} from '../services/received-documents-service/src/automation/mailbox';
import {fixture, scope, access, stepUpHandle, localSettings, liveSettings, id} from './helpers/b2b-received-automation.fixture';

const require = createRequire(import.meta.url);
const {withReceivedAutomationDatabase} = require('./helpers/b2b-received-dispatch-db.cjs');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('B2B08 dispatch disabled without any database or authority access', () => {
  it.each([undefined, {enabled: false}])('defaults to disabled (%j), even with an invalid run ID and limit', async options => {
    const touched = vi.fn(() => {throw new Error('DATABASE_OR_AUTHORITY_MUST_NOT_BE_USED');});
    const dispatcher = new B2bReceptionDispatch({$transaction: touched} as any,
      {authenticate: touched}, {authorize: touched}, {authorize: touched}, options);
    expect(await dispatcher.run('not-a-uuid')).toEqual({runId: 'not-a-uuid', status: 'DISABLED'});
    expect(await dispatcher.pending(0)).toEqual([]);
    expect(touched).not.toHaveBeenCalled();
  });
});

describe('B2B08 dispatch real SQL in NEW owned network-none tmpfs PostgreSQL', () => {
  let db: any, pool: any, f: ReturnType<typeof fixture>, writes: PostgresReceptionWriteAuthority;
  let s: ReceivedScope, other: ReceivedScope, branch: ReceivedScope;
  let release: (() => void) | undefined, completed: Promise<void> | undefined;
  let sequence = 0;
  const reportedSqlDiagnostics = new Set<string>();
  const key = () => `synthetic_dispatch_${++sequence}`;
  const connection = (target = s) => db.receptionConnection.findUnique({where: {companyId: target.companyId}});
  const stored = (runId: string) => db.receptionSyncRun.findUniqueOrThrow({where: {id: runId}});
  const attempts = async (runId: string) => (await pool.query(
    'SELECT * FROM "B2bReceivedDispatchAttempt" WHERE "runId"=$1 ORDER BY "attempt"', [runId])).rows;
  const observations = async (runId: string) => (await pool.query(
    'SELECT * FROM "B2bReceivedDispatchObservation" WHERE "runId"=$1 ORDER BY "ordinal"', [runId])).rows;
  const count = async (table: string) => Number((await pool.query(`SELECT count(*) AS n FROM "${table}"`)).rows[0].n);
  const payloadState = () => Promise.all([
    'ReceivedDocument', 'ReceivedItemRecord', 'ReceivedArtifact', 'B2bReceivedCommand', 'B2bReceivedDispatchObservation',
  ].map(count));
  const request = (action: 'CONFIG_SAVE' | 'SYNC_CREATE', payload: any, target = s, owner = f.owner) => owner.execute(
    {token: access.token, kind: f.principal.kind}, action, {scope: target, key: key(),
      payload: {...payload, ...(f.principal.kind === 'USER' ? {stepUpHandle} : {})}}) as Promise<any>;
  const settings = () => {
    const result = localSettings();
    // Production chooses three periods using the real SQL timestamp. An old
    // start keeps this fixture independent of the current month and year.
    result.sire.startPeriod = '202001';
    return result;
  };
  const stage = async (target = s, value = settings(), owner = f.owner) => request('CONFIG_SAVE', {
    expectedRevision: (await connection(target))?.revision ?? 0, settings: value,
  }, target, owner);
  const queue = async (source: 'MAIL' | 'SIRE' | 'ALL' = 'MAIL', target = s, owner = f.owner) => {
    const result = await request('SYNC_CREATE', {source, expectedRevision: (await connection(target)).revision}, target, owner);
    expect(result.items.every((item: any) => item.status === 'QUEUED' && item.dispatch === 'NOT_DISPATCHED')).toBe(true);
    return result.items as {runId: string; source: string; status: string}[];
  };
  const importGrant = (target = s, expectedRevision = 0, active = true) => writes.setGrant('synthetic-enrollment', {
    scope: target, subject: {kind: f.principal.kind, clientId: f.principal.clientId, subjectId: f.principal.subjectId},
    action: 'IMPORT', clientRevision: f.principal.revision, userAuthRevision: f.principal.userAuthRevision, active,
  }, expectedRevision);
  const ready = async (target = s) => {await f.grant('SYNC_EXECUTE', target); await importGrant(target);};
  type Proof = Awaited<ReturnType<ReceptionDispatchAuthority['authorize']>>;
  function runtime() {
    const approvals = new Map<string, {executionId: string; expiresAt: string}>();
    const contexts: ReceptionDispatchContext[] = [], tokens: string[] = [];
    const control = {mutate: null as null | ((proof: Proof, context: ReceptionDispatchContext, call: number) => Proof)};
    const port: ReceptionDispatchAuthority = {authorize: async context => {
      contexts.push(structuredClone(context));
      if (!approvals.has(context.runId)) approvals.set(context.runId, {
        executionId: randomUUID(), expiresAt: new Date(Date.now() + 240000).toISOString(),
      });
      let administrator: Proof['administrator'] = null;
      if (context.actor.kind === 'USER') {
        // Trusted local stand-in checks the current GLOBAL admin/MFA fixture;
        // no queued bearer, step-up handle or administrator proof is reused.
        const current = await f.administrator.authorize(f.principal, context.scope, 'SYNC_CREATE', stepUpHandle, hash(context));
        administrator = {adminId: current.adminId, authRevision: current.authRevision, authority: current.authority};
      }
      const token = `synthetic-fresh-dispatch-${randomUUID()}`;
      tokens.push(token);
      const proof: Proof = {access: {token, kind: context.actor.kind}, ...approvals.get(context.runId)!,
        contextSha256: hash(context), administrator};
      return control.mutate?.(proof, context, contexts.length) ?? proof;
    }};
    return {port, contexts, tokens, control};
  }
  const dispatcher = (approval = runtime(), database = db) => {
    const diagnostics: {operation: string; code: string; reason: string}[] = [];
    const observed = {$transaction: (work: any, options: any) => database.$transaction((tx: any) => {
      const invoke = (method: '$queryRawUnsafe' | '$executeRawUnsafe') => async (sql: string, ...values: any[]) => {
        try {return await tx[method](sql, ...values);}
        catch (error: any) {
          const cause = error.meta?.driverAdapterError?.cause;
          // Only operation tags, SQLSTATE and driver diagnostics from this
          // owned synthetic DB; never SQL parameters, tokens or XML bodies.
          diagnostics.push({operation: sql.startsWith('UPDATE "ReceptionSyncRun"') ? 'SYNC_RUN_UPDATE' :
            sql.startsWith('INSERT INTO "B2bReceivedDispatchAttempt"') ? 'ATTEMPT_INSERT' : 'OTHER_SQL',
            code: String(error.meta?.code ?? cause?.originalCode ?? error.code ?? 'UNKNOWN'),
            reason: String(error.meta?.message ?? cause?.originalMessage ?? 'SQL_FAILED').slice(0, 500)});
          const last = diagnostics.at(-1)!;
          const signature = JSON.stringify(last);
          if (last.operation !== 'OTHER_SQL' && !reportedSqlDiagnostics.has(signature)) {
            reportedSqlDiagnostics.add(signature);
            console.error(`B2B_RECEIVED_DISPATCH_SQL_DIAGNOSTIC ${signature}`);
          }
          throw error;
        }
      };
      return work({$queryRawUnsafe: invoke('$queryRawUnsafe'), $executeRawUnsafe: invoke('$executeRawUnsafe')});
    }, options)};
    const owner = new B2bReceptionDispatch(observed, f.identity, f.authority, writes, {enabled: true, authority: approval.port});
    const run = owner.run.bind(owner);
    owner.run = async runId => {
      diagnostics.length = 0;
      try {return await run(runId);}
      catch (error: any) {
        if (diagnostics.length) error.message += ` SQL_DIAGNOSTICS=${JSON.stringify(diagnostics)}`;
        throw error;
      }
    };
    return {approval, owner};
  };
  // Hooks run AFTER real SQL inside the dispatch transaction. Grants use the
  // independent unwrapped DB so a mid-flight revocation is durably visible.
  const wrap = (hook: (sql: string, values: any[], tx: any) => void | Promise<void>) => ({
    $transaction: (work: any, options: any) => db.$transaction((tx: any) => work({
      $queryRawUnsafe: tx.$queryRawUnsafe.bind(tx),
      $executeRawUnsafe: async (sql: string, ...values: any[]) => {
        const result = await tx.$executeRawUnsafe(sql, ...values);
        await hook(sql, values, tx);
        return result;
      },
    }), options),
  });
  const complete = async (owner: B2bReceptionDispatch, runId: string) => {
    expect(await owner.run(runId)).toEqual({runId, status: 'COMPLETED'});
    const row = await stored(runId);
    expect(row).toMatchObject({status: 'COMPLETED', activeKey: null, errorCode: null});
    expect(row.startedAt).toBeInstanceOf(Date);
    expect(row.finishedAt).toBeInstanceOf(Date);
    const receipts = await attempts(runId);
    expect(receipts.at(-1)).toMatchObject({status: 'COMPLETED', errorCode: null, counters: row.counters});
    const receipt = receipts.at(-1), authority = receipt.executionAuthority;
    expect(receipt.authoritySha256).toBe(hash(authority));
    expect(Object.keys(authority).sort()).toEqual(['administrator', 'contextSha256', 'create', 'execute', 'executionId', 'expiresAt']);
    const member = (await pool.query('SELECT * FROM "B2bReceivedAutomationRun" WHERE "runId"=$1', [runId])).rows[0];
    expect(authority.contextSha256).toBe(hash({runId, scope: member.scope, source: row.source, revision: member.revision,
      actor: {kind: member.actorKind, clientId: member.clientId, subjectId: member.subjectId,
        clientRevision: member.clientRevision, userAuthRevision: member.userAuthRevision}}));
    expect(authority.create).toEqual(member.createAuthority);
    expect(authority.execute).toEqual(await f.authority.authorize(f.principal, member.scope, 'SYNC_EXECUTE'));
    expect(authority.executionId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(Date.parse(authority.expiresAt)).toBeGreaterThan(row.finishedAt.getTime());
    expect(authority.administrator).toEqual(member.actorKind === 'SERVICE' ? null : {
      adminId: member.subjectId, authRevision: member.userAuthRevision, authority: 'GLOBAL_ADMIN',
    });
    expect(JSON.stringify(authority)).not.toContain('synthetic-fresh-dispatch-');
    return row;
  };
  const blocked = async (owner: B2bReceptionDispatch, runId: string, before: number[]) => {
    let result;
    try {result = await owner.run(runId);}
    finally {expect(await payloadState()).toEqual(before);}
    expect(result).toEqual({runId, status: 'BLOCKED'});
    expect(await stored(runId)).toMatchObject({status: 'BLOCKED', activeKey: null, counters: emptyCounters()});
    expect(await attempts(runId)).toMatchObject([{attempt: 1, status: 'BLOCKED', authoritySha256: null, executionAuthority: null, counters: emptyCounters()}]);
  };
  beforeAll(async () => {
    vi.stubGlobal('fetch', vi.fn(() => {throw new Error('OFFICIAL_NETWORK_FORBIDDEN');}));
    let resolveReady!: () => void, rejectReady!: (error: unknown) => void;
    const initialized = new Promise<void>((resolve, reject) => {resolveReady = resolve; rejectReady = reject;});
    const finished = new Promise<void>(resolve => {release = resolve;});
    completed = withReceivedAutomationDatabase(async (context: any) => {
      db = context.client; pool = context.pool; resolveReady(); await finished;
    });
    void completed!.catch(rejectReady);
    await initialized;
  }, 120000);
  afterAll(async () => {
    try {release?.(); await completed; expect(fetch).not.toHaveBeenCalled();}
    finally {vi.unstubAllGlobals();}
  }, 120000);
  beforeEach(async () => {
    const companyId = 100 + ++sequence;
    s = {...scope, companyId, recipientRuc: `00${String(companyId).padStart(9, '0')}`, branchId: randomUUID()};
    other = {...s, companyId: companyId + 10000, recipientRuc: `00${String(companyId + 10000).padStart(9, '0')}`, branchId: randomUUID()};
    branch = {...s, branchId: randomUUID()};
    f = fixture(db);
    f.principal.clientId = randomUUID(); f.principal.subjectId = randomUUID();
    f.principal.scopes.push('b2b:received:write');
    f.principal.bindings = [s, other, branch].map(target => ({issuerId: target.companyId,
      issuerRuc: target.recipientRuc, environment: target.environment, branchId: target.branchId,
      pointId: id(6), seriesId: id(7), documentType: '01'}));
    writes = new PostgresReceptionWriteAuthority(db, f.enrollment);
    for (const action of ['CONFIG_SAVE', 'SYNC_CREATE'] as const) await f.grant(action, s);
    await stage();
  });

  it('validates enabled requests and enumerates only queued runs without changing SQL state', async () => {
    const {owner} = dispatcher(), rows = await queue('ALL'), before = await payloadState();
    const expected = (await pool.query('SELECT a."runId" FROM "B2bReceivedAutomationRun" a JOIN "ReceptionSyncRun" r ON r."id"=a."runId" WHERE r."status"=\'QUEUED\' AND a."dispatchVersion"=1 ORDER BY r."createdAt",a."runId" LIMIT 100')).rows.map((row: any) => row.runId);
    expect(await owner.pending(100)).toEqual(expected);
    expect(expected).toEqual(expect.arrayContaining(rows.map(row => row.runId)));
    expect(await owner.pending(1)).toEqual(expected.slice(0, 1));
    for (const limit of [0, 101, 1.5, NaN]) await expect(owner.pending(limit)).rejects.toMatchObject({status: 400});
    await expect(owner.run('invalid')).rejects.toMatchObject({status: 400});
    expect(await owner.run(randomUUID())).toMatchObject({status: 'NOT_FOUND'});
    expect(await payloadState()).toEqual(before);
  });

  it('MAIL completes three periods with exact XML, items, original actor journal, stable counters and no replay duplicates', async () => {
    await ready();
    const [job] = await queue(), {owner, approval} = dispatcher(), before = await payloadState();
    const row = await complete(owner, job.runId), periods = receptionPeriods('202001', row.createdAt);
    expect(periods).toHaveLength(3);
    expect(row.counters).toEqual({...emptyCounters(), detected: 3, imported: 3});
    expect(await payloadState()).toEqual(before.map((n, index) => n + (index === 4 ? 0 : 3)));
    for (const period of periods) {
      const [file] = await mailAttachments(fixtureMail(s.recipientRuc, period));
      const projection = parseReceivedXml(file.bytes);
      const document = await db.receivedDocument.findFirstOrThrow({where: {companyId: s.companyId, number: period}});
      expect(document).toMatchObject({branchId: s.branchId, recipientRuc: s.recipientRuc, projection, xmlSha256: sha(file.bytes), payableAmount: '118.00'});
      const items = await db.receivedItemRecord.findMany({where: {documentId: document.id}, orderBy: {ordinal: 'asc'}});
      expect(items.map((item: any) => item.detail)).toEqual(projection.items);
      expect(items[0]).toMatchObject({quantity: '1', unitValue: '100.00', amount: '100.00'});
      const originals = await db.receivedArtifact.findMany({where: {documentId: document.id}});
      expect(originals).toHaveLength(1);
      expect(originals[0]).toMatchObject({kind: 'XML', sha256: sha(file.bytes), byteLength: file.bytes.length});
      expect(Buffer.from(originals[0].bytes)).toEqual(file.bytes);
    }
    const journal = (await pool.query('SELECT * FROM "B2bReceivedCommand" WHERE "clientId"=$1', [f.principal.clientId])).rows;
    expect(journal).toHaveLength(3);
    for (const entry of journal) expect(entry).toMatchObject({actorKind: 'USER', subjectId: f.principal.subjectId,
      clientId: f.principal.clientId, userAuthRevision: 1, scope: s, action: 'IMPORT', result: {outcome: 'IMPORTED'}});
    const membership = (await pool.query('SELECT * FROM "B2bReceivedAutomationRun" WHERE "runId"=$1', [job.runId])).rows[0];
    expect(membership).not.toHaveProperty('token'); expect(membership).not.toHaveProperty('stepUpHandle');
    expect(approval.contexts.length).toBeGreaterThan(3);
    for (const context of approval.contexts) expect(context).toEqual({runId: job.runId, scope: s, source: 'MAIL', revision: row.revision,
      actor: {kind: 'USER', clientId: f.principal.clientId, subjectId: f.principal.subjectId, clientRevision: 1, userAuthRevision: 1}});
    expect(new Set(approval.tokens).size).toBe(approval.tokens.length);
    const snapshot = await payloadState(), receipt = await attempts(job.runId), calls = approval.contexts.length;
    expect(await owner.run(job.runId)).toEqual({runId: job.runId, status: 'COMPLETED'});
    expect(await payloadState()).toEqual(snapshot); expect(await stored(job.runId)).toEqual(row);
    expect(await attempts(job.runId)).toEqual(receipt); expect(approval.contexts).toHaveLength(calls);
    expect(await owner.pending(100)).not.toContain(job.runId);
  });

  it('SIRE before MAIL records three XML-pending observations and invents no XML; later MAIL matches them', async () => {
    await ready();
    const {owner} = dispatcher(), before = await payloadState(), [sire] = await queue('SIRE');
    const row = await complete(owner, sire.runId), periods = receptionPeriods('202001', row.createdAt);
    expect(row.counters).toEqual({...emptyCounters(), detected: 3, xmlPending: 3});
    expect(await payloadState()).toEqual(before.map((n, index) => n + (index === 4 ? 3 : 0)));
    const records = await observations(sire.runId);
    expect(records.map((record: any) => record.record)).toEqual(periods.flatMap(period => fixtureSirePurchases(s.recipientRuc, period)));
    for (const record of records) expect(record).toMatchObject({scope: s, documentId: null, comparison: 'PENDING', recordSha256: hash(record.record)});
    const [mail] = await queue('MAIL');
    expect((await complete(owner, mail.runId)).counters).toEqual({...emptyCounters(), detected: 3, imported: 3, matches: 3});
    // Historical observations remain immutable; MAIL re-evaluates their records.
    expect(await observations(sire.runId)).toEqual(records);
  });

  it('MAIL does not count observations from periods outside its queued three-month window', async () => {
    await ready();
    const [oldSire] = await queue('SIRE');
    await pool.query('UPDATE "ReceptionSyncRun" SET "createdAt"=$2::timestamp WHERE "id"=$1::uuid',
      [oldSire.runId, '2024-02-15T12:00:00.000Z']);
    const owner = dispatcher().owner;
    expect((await complete(owner, oldSire.runId)).counters).toEqual({...emptyCounters(), detected: 3, xmlPending: 3});
    const originalObservations = await observations(oldSire.runId);
    expect(originalObservations).toHaveLength(3);
    const [mail] = await queue('MAIL');
    expect((await complete(owner, mail.runId)).counters).toEqual({...emptyCounters(), detected: 3, imported: 3});
    expect(await observations(oldSire.runId)).toEqual(originalObservations);
  });

  it('SIRE after MAIL matches the exact branch documents and stores no extra originals or command journals', async () => {
    await ready();
    const {owner} = dispatcher(), [mail] = await queue('MAIL');
    await complete(owner, mail.runId);
    const before = await payloadState(), [sire] = await queue('SIRE');
    expect((await complete(owner, sire.runId)).counters).toEqual({...emptyCounters(), detected: 3, matches: 3});
    expect(await payloadState()).toEqual(before.map((n, index) => n + (index === 4 ? 3 : 0)));
    const docs = await db.receivedDocument.findMany({where: {companyId: s.companyId}});
    for (const record of await observations(sire.runId)) {
      expect(record.comparison).toBe('MATCHED'); expect(docs.map((doc: any) => doc.id)).toContain(record.documentId);
    }
  });

  it.each(['EXECUTE', 'IMPORT'] as const)('MAIL requires independent %s approval beyond SYNC_CREATE', async missing => {
    if (missing !== 'EXECUTE') await f.grant('SYNC_EXECUTE', s);
    if (missing !== 'IMPORT') await importGrant();
    const [job] = await queue(), before = await payloadState();
    await blocked(dispatcher().owner, job.runId, before);
  });

  it('SIRE needs SYNC_EXECUTE but does not inherit or require an IMPORT grant or write scope', async () => {
    await f.grant('SYNC_EXECUTE', s);
    f.principal.scopes = f.principal.scopes.filter(value => value !== 'b2b:received:write');
    const [job] = await queue('SIRE'), before = await payloadState();
    expect((await complete(dispatcher().owner, job.runId)).counters.xmlPending).toBe(3);
    expect((await payloadState()).slice(0, 4)).toEqual(before.slice(0, 4));
  });

  it('MAIL still requires Identity write scope even with independently enrolled IMPORT and EXECUTE grants', async () => {
    await ready();
    const [job] = await queue(), before = await payloadState();
    f.principal.scopes = f.principal.scopes.filter(value => value !== 'b2b:received:write');
    await blocked(dispatcher().owner, job.runId, before);
  });

  it.each(['SYNC_CREATE', 'SYNC_EXECUTE', 'IMPORT'] as const)('%s revocation after the second SQL import journal rolls the entire delivery back', async action => {
    await ready();
    const [job] = await queue(), before = await payloadState();
    let journals = 0, revoked = false;
    const database = wrap(async sql => {
      if (sql.includes('INSERT INTO "B2bReceivedCommand"') && ++journals === 2) {
        if (action === 'IMPORT') await importGrant(s, 1, false);
        else await f.grant(action, s, 1, false);
        revoked = true;
      }
    });
    await blocked(dispatcher(runtime(), database).owner, job.runId, before);
    expect(revoked).toBe(true); expect(journals).toBe(2);
    expect((await stored(job.runId)).startedAt).toBeNull();
  });

  it('a command serialization conflict retries the whole transaction without consuming a durable attempt', async () => {
    await ready();
    const [job] = await queue(), before = await payloadState();
    let conflicted = false;
    const database = wrap(sql => {
      if (!conflicted && sql.startsWith('INSERT INTO "B2bReceivedCommand"')) {
        conflicted = true;
        throw Object.assign(new Error('SYNTHETIC_SERIALIZATION_CONFLICT'), {code: '40001'});
      }
    });
    await expect(dispatcher(runtime(), database).owner.run(job.runId)).rejects.toMatchObject({status: 503, code: 'RECEIVED_DISPATCH_RETRY'});
    expect(conflicted).toBe(true);
    expect(await payloadState()).toEqual(before);
    expect(await attempts(job.runId)).toEqual([]);
    expect(await stored(job.runId)).toMatchObject({status: 'QUEUED', counters: emptyCounters(), startedAt: null});
    expect((await complete(dispatcher().owner, job.runId)).counters).toEqual({...emptyCounters(), detected: 3, imported: 3});
  });

  it('a transient PostgreSQL error after partial imports rolls back, then a fresh delivery can complete', async () => {
    await ready();
    const [job] = await queue(), before = await payloadState();
    let journals = 0, injected = false;
    const database = wrap(async (sql, _values, tx) => {
      if (!injected && sql.includes('INSERT INTO "B2bReceivedCommand"') && ++journals === 2) {
        injected = true; await tx.$queryRawUnsafe('SELECT 1 / 0 AS synthetic_transient_failure');
      }
    });
    const {owner} = dispatcher(runtime(), database);
    await expect(owner.run(job.runId)).rejects.toMatchObject({status: 503, code: 'RECEIVED_DISPATCH_RETRY'});
    expect(injected).toBe(true); expect(await payloadState()).toEqual(before);
    expect(await stored(job.runId)).toMatchObject({status: 'QUEUED', startedAt: null, finishedAt: null, counters: emptyCounters()});
    expect(await attempts(job.runId)).toMatchObject([{attempt: 1, status: 'RETRY', errorCode: 'CONNECTOR_UNAVAILABLE'}]);
    expect((await complete(owner, job.runId)).counters.imported).toBe(3);
    expect((await attempts(job.runId)).map((row: any) => [row.attempt, row.status])).toEqual([[1, 'RETRY'], [2, 'COMPLETED']]);
  });

  it('persistent PostgreSQL failure consumes at most three durable attempts and never leaves partial writes', async () => {
    await ready();
    const [job] = await queue(), before = await payloadState();
    let injected = 0;
    const database = wrap(async (sql, _values, tx) => {
      if (sql.includes('INSERT INTO "B2bReceivedCommand"')) {
        injected++; await tx.$queryRawUnsafe('SELECT 1 / 0 AS synthetic_transient_failure');
      }
    });
    const {owner} = dispatcher(runtime(), database);
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt < 3) await expect(owner.run(job.runId)).rejects.toMatchObject({code: 'RECEIVED_DISPATCH_RETRY'});
      else expect(await owner.run(job.runId)).toEqual({runId: job.runId, status: 'FAILED'});
      expect(await payloadState()).toEqual(before); expect(await attempts(job.runId)).toHaveLength(attempt);
    }
    expect(injected).toBe(3);
    expect((await attempts(job.runId)).map((row: any) => row.status)).toEqual(['RETRY', 'RETRY', 'FAILED']);
    expect(await stored(job.runId)).toMatchObject({status: 'FAILED', activeKey: null, startedAt: null, counters: emptyCounters()});
    expect(await owner.run(job.runId)).toMatchObject({status: 'FAILED'});
    expect(await attempts(job.runId)).toHaveLength(3); expect(await owner.pending(100)).not.toContain(job.runId);
  });

  it('a SQL failure after the completion receipt rolls imports, counters and success receipt back together', async () => {
    await ready();
    const [job] = await queue(), before = await payloadState();
    let injected = false;
    const database = wrap(async (sql, values, tx) => {
      if (sql.includes('INSERT INTO "B2bReceivedDispatchAttempt"') && values[3] === 'COMPLETED') {
        injected = true; await tx.$queryRawUnsafe('SELECT 1 / 0 AS synthetic_receipt_failure');
      }
    });
    await expect(dispatcher(runtime(), database).owner.run(job.runId)).rejects.toMatchObject({code: 'RECEIVED_DISPATCH_RETRY'});
    expect(injected).toBe(true); expect(await payloadState()).toEqual(before);
    expect(await stored(job.runId)).toMatchObject({status: 'QUEUED', startedAt: null, finishedAt: null, counters: emptyCounters()});
    expect(await attempts(job.runId)).toMatchObject([{attempt: 1, status: 'RETRY', authoritySha256: null}]);
  });

  it.each(['expired', 'wrong-context', 'wrong-admin', 'stale-admin', 'non-global', 'no-admin', 'changed-execution'] as const)(
    'USER runtime proof %s blocks before commit', async fault => {
      await ready();
      const [job] = await queue(), before = await payloadState(), approval = runtime();
      approval.control.mutate = (proof, _context, call) => {
        if (fault === 'expired') return {...proof, expiresAt: new Date(Date.now() - 1000).toISOString()};
        if (fault === 'wrong-context') return {...proof, contextSha256: hash('another-context')};
        if (fault === 'wrong-admin') return {...proof, administrator: {...proof.administrator!, adminId: randomUUID()}};
        if (fault === 'stale-admin') return {...proof, administrator: {...proof.administrator!, authRevision: 2}};
        if (fault === 'no-admin') return {...proof, administrator: null};
        if (fault === 'changed-execution' && call > 1) return {...proof, executionId: randomUUID()};
        return proof;
      };
      if (fault === 'non-global') f.control.global = false;
      await blocked(dispatcher(approval).owner, job.runId, before);
    });

  it.each(['client', 'subject', 'client-revision', 'auth-revision'] as const)('fresh Identity %s must still match the original queued actor', async field => {
    await ready();
    const [job] = await queue(), before = await payloadState();
    if (field === 'client') f.principal.clientId = randomUUID();
    if (field === 'subject') f.principal.subjectId = randomUUID();
    if (field === 'client-revision') f.principal.revision++;
    if (field === 'auth-revision') f.principal.userAuthRevision = f.principal.userAuthRevision! + 1;
    await blocked(dispatcher().owner, job.runId, before);
  });

  it('USER proof expiry after a real SQL import journal rolls everything back', async () => {
    await ready();
    const [job] = await queue(), before = await payloadState(), approval = runtime();
    let expired = false;
    approval.control.mutate = proof => expired ? {...proof, expiresAt: new Date(Date.now() - 1).toISOString()} : proof;
    const database = wrap(sql => {if (sql.includes('INSERT INTO "B2bReceivedCommand"')) expired = true;});
    await blocked(dispatcher(approval, database).owner, job.runId, before); expect(expired).toBe(true);
  });

  it('enabled runtime without an owner approval port is blocked with no payload writes', async () => {
    await ready();
    const [job] = await queue(), before = await payloadState();
    await blocked(new B2bReceptionDispatch(db, f.identity, f.authority, writes, {enabled: true}), job.runId, before);
  });

  it('SERVICE uses explicitly enrolled CREATE, EXECUTE and IMPORT grants and keeps all human audit fields null', async () => {
    f.principal.kind = 'SERVICE'; f.principal.subjectId = null; f.principal.userAuthRevision = null;
    f.principal.clientId = randomUUID(); await f.grant('SYNC_CREATE', s); await ready();
    const [job] = await queue(), {owner, approval} = dispatcher();
    f.control.global = false;
    const adminCalls = f.control.adminCalls;
    expect((await complete(owner, job.runId)).counters.imported).toBe(3);
    expect(f.control.adminCalls).toBe(adminCalls);
    expect(approval.contexts.every(context => context.actor.kind === 'SERVICE' && context.actor.subjectId === null && context.actor.userAuthRevision === null)).toBe(true);
    const commands = (await pool.query('SELECT * FROM "B2bReceivedCommand" WHERE "clientId"=$1', [f.principal.clientId])).rows;
    expect(commands).toHaveLength(3);
    for (const row of commands) expect(row).toMatchObject({actorKind: 'SERVICE', clientId: f.principal.clientId, subjectId: null, userAuthRevision: null});
    const audit = (await pool.query('SELECT * FROM "B2bReceivedAutomationAudit" WHERE "clientId"=$1', [f.principal.clientId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({actorKind: 'SERVICE', subjectId: null, userAuthRevision: null, adminStamp: null});
    expect((await pool.query('SELECT * FROM "B2bReceivedAutomationRun" WHERE "runId"=$1', [job.runId])).rows[0]).toMatchObject({actorKind: 'SERVICE', subjectId: null, userAuthRevision: null});
  });

  it('SERVICE cannot attach a fabricated human administrator proof', async () => {
    f.principal.kind = 'SERVICE'; f.principal.subjectId = null; f.principal.userAuthRevision = null;
    f.principal.clientId = randomUUID(); await f.grant('SYNC_CREATE', s); await ready();
    const [job] = await queue(), before = await payloadState(), approval = runtime();
    approval.control.mutate = proof => ({...proof, administrator: {adminId: id(90), authRevision: 1, authority: 'GLOBAL_ADMIN'}});
    await blocked(dispatcher(approval).owner, job.runId, before);
  });

  it('simultaneous delivery is fenced by SQL and repeated/new MAIL jobs never duplicate originals or items', async () => {
    await ready();
    const [job] = await queue();
    let signal!: () => void, resume!: () => void;
    const running = new Promise<void>(resolve => {signal = resolve;});
    const resumed = new Promise<void>(resolve => {resume = resolve;});
    const database = wrap(async sql => {
      if (sql.includes('SET "status"=\'RUNNING\'')) {signal(); await resumed;}
    });
    const {owner} = dispatcher(runtime(), database);
    const first = owner.run(job.runId);
    try {
      // If the first delivery fails, reject instead of leaving the gate hanging.
      await Promise.race([running, first.then(() => {throw new Error('EXPECTED_RUNNING_GATE');})]);
      expect(await dispatcher().owner.run(job.runId)).toEqual({runId: job.runId, status: 'BUSY'});
    } finally {resume(); await first;}
    expect(await first).toMatchObject({status: 'COMPLETED'});
    expect(await attempts(job.runId)).toHaveLength(1);
    const before = await payloadState();
    expect(await owner.run(job.runId)).toMatchObject({status: 'COMPLETED'});
    expect(await payloadState()).toEqual(before);
    const [next] = await queue();
    expect((await complete(dispatcher().owner, next.runId)).counters).toEqual({...emptyCounters(), detected: 3, duplicate: 3});
    expect(await payloadState()).toEqual(before.map((n, index) => n + (index === 3 ? 3 : 0)));
  });

  it('SIRE comparison cannot match XML in a different branch or company', async () => {
    await ready();
    const {owner} = dispatcher(), [mail] = await queue(); await complete(owner, mail.runId);
    for (const target of [branch, other]) {
      for (const action of ['CONFIG_SAVE', 'SYNC_CREATE', 'SYNC_EXECUTE'] as const) await f.grant(action, target);
      if (target.companyId !== s.companyId) await stage(target);
      const [job] = await queue('SIRE', target), before = await payloadState();
      expect((await complete(owner, job.runId)).counters).toEqual({...emptyCounters(), detected: 3, xmlPending: 3});
      for (const observation of await observations(job.runId)) expect(observation).toMatchObject({scope: target, comparison: 'PENDING', documentId: null});
      expect((await payloadState()).slice(0, 4)).toEqual(before.slice(0, 4));
    }
  });

  it('an EXECUTE grant in another branch does not authorize this queued scope', async () => {
    await f.grant('SYNC_EXECUTE', branch); await importGrant();
    const [job] = await queue(), before = await payloadState(); await blocked(dispatcher().owner, job.runId, before);
  });

  it('a lost original branch binding blocks execution despite previously enrolled grants', async () => {
    await ready();
    const [job] = await queue(), before = await payloadState();
    f.principal.bindings = f.principal.bindings.filter(binding => binding.branchId !== s.branchId);
    await blocked(dispatcher().owner, job.runId, before);
  });

  it('configuration changes block queued jobs and dispatch cannot resurrect or write them', async () => {
    await ready();
    const jobs = await queue('ALL'), before = await payloadState(); await stage();
    const {owner, approval} = dispatcher();
    for (const job of jobs) {
      expect(await stored(job.runId)).toMatchObject({status: 'BLOCKED', activeKey: null, errorCode: 'CONFIGURATION_CHANGED'});
      expect(await owner.run(job.runId)).toMatchObject({status: 'BLOCKED'});
      expect(await attempts(job.runId)).toEqual([]); expect(await owner.pending(100)).not.toContain(job.runId);
    }
    expect(approval.contexts).toEqual([]); expect(await payloadState()).toEqual(before);
  });

  it('LIVE metadata is rejected before runtime approval, fetch or vault access', async () => {
    await ready(); await f.grant('LIVE_READ_ONLY', s);
    const owner = f.alternate(db, {networkProfile: 'LIVE_READ_ONLY', approvedImapHosts: ['imap.example.com']});
    const live = liveSettings(); live.sire.startPeriod = '202001';
    await request('CONFIG_SAVE', {expectedRevision: (await connection()).revision, settings: live,
      credentials: {mailPassword: 'SYNTHETIC_MAIL', sireClientSecret: 'SYNTHETIC_CLIENT', solPassword: 'SYNTHETIC_SOL'}}, s, owner);
    const jobs = await queue('ALL', s, owner), before = await payloadState(), approval = runtime();
    const vault = vi.spyOn(f.vault, 'open').mockImplementation(() => {throw new Error('VAULT_ACCESS_FORBIDDEN');});
    try {
      for (const job of jobs) {
        await blocked(dispatcher(approval).owner, job.runId, before);
        expect(await stored(job.runId)).toMatchObject({errorCode: 'CONNECTION_NOT_READY'});
      }
      expect(approval.contexts).toEqual([]); expect(vault).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    } finally {vault.mockRestore();}
  });

  it('dispatch observations and attempts are append-only in PostgreSQL', async () => {
    await f.grant('SYNC_EXECUTE', s);
    const [job] = await queue('SIRE'); await complete(dispatcher().owner, job.runId);
    for (const table of ['B2bReceivedDispatchAttempt', 'B2bReceivedDispatchObservation']) {
      for (const sql of [`DELETE FROM "${table}" WHERE "runId"=$1`, `UPDATE "${table}" SET "runId"="runId" WHERE "runId"=$1`]) {
        await expect(pool.query(sql, [job.runId])).rejects.toMatchObject({code: '23514'});
      }
      await expect(pool.query(`TRUNCATE "${table}"`)).rejects.toMatchObject({code: '23514'});
    }
    expect(await attempts(job.runId)).toHaveLength(1); expect(await observations(job.runId)).toHaveLength(3);
  });

  it('never touches emission, Outbox, series counters, legacy human audits or live connector checkpoints', async () => {
    for (const table of ['Document', 'OutboxEvent', 'SeriesCounter', 'CompanySettings', 'Branch', 'EmissionPoint',
      'ReceivedAudit', 'ReceptionMailboxCheckpoint', 'ReceptionMessageReceipt', 'ReceptionSirePurchase', 'ReceptionSireIncident']) {
      expect(await count(table)).toBe(0);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect((await pool.query('SELECT bool_and("enabled"=false) AS staged FROM "ReceptionConnection"')).rows[0].staged).toBe(true);
  });
});



