import {readFileSync} from 'node:fs';
import {describe, expect, it, vi} from 'vitest';
import type {GuideDispatchKey, GuideDispatchManifest} from '../packages/sunat-core/src/guide-dispatch-journal';
import {appendGuideDispatch, GuideDispatchError, rebuildGuideDispatch}
  from '../packages/sunat-core/dist/guide-dispatch-journal';
import {fiscalSnapshotSha256} from '../packages/sunat-core/src/fiscal-note';
import {PostgresGuideDispatchStore, safeGuideDispatchError, type GuideDispatchSql}
  from '../services/sunat-service/src/application/guide-dispatch-store';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const key: GuideDispatchKey = {companyId: 1, issuerRuc: '20000000001', operationId: uuid(1)};
const at = '2026-10-22T05:00:00.000Z', secret = 'synthetic-private-driver-detail';
const unavailable = 'GUIDE_DISPATCH_STORE_UNAVAILABLE', identity = 'GUIDE_DISPATCH_IDENTITY_CONFLICT';
const revision = 'GUIDE_DISPATCH_REVISION_CONFLICT';
function fixtureManifest(): GuideDispatchManifest {
  return {schemaVersion: 'factuez.guide-dispatch-manifest.v1', environment: 'BETA', key: {...key},
    documentId: uuid(2), guideType: '09', fullNumber: 'T001-1', ownerRevision: 1,
    snapshotSha256: 'a'.repeat(64), xmlSha256: 'b'.repeat(64), zipSha256: 'c'.repeat(64), source: 'LOCAL_EMULATOR'};
}
const manifest = fixtureManifest();
const registered = appendGuideDispatch(manifest, [], {kind: 'REGISTER', data: {manifestSha256: fiscalSnapshotSha256(manifest)}}, at);
const attempt = appendGuideDispatch(manifest, [registered], {kind: 'ATTEMPT', data: {attemptId: uuid(3)}}, at);
const root = (events = [registered]) => ({...key, documentId: manifest.documentId, guideType: manifest.guideType,
  fullNumber: manifest.fullNumber, manifest: structuredClone(manifest), revision: events.length, headSha256: events.at(-1)!.sha256});
const eventRows = (events = [registered]) => events.map(payload => ({operationId: key.operationId,
  version: payload.version, payload: structuredClone(payload), hash: payload.sha256}));
type Step = {sql: RegExp; result?: unknown; error?: unknown; fail?: boolean; write?: boolean};
const query = (sql: RegExp, result: unknown = []): Step => ({sql, result});
const lock = () => query(/pg_advisory_xact_lock/);
const roots = (rows: unknown = [root()]) => query(/FROM "GuideDispatchStream"/, rows);
const history = (rows: unknown = eventRows()) => query(/FROM "GuideDispatchEvent"/, rows);
const write = (sql: RegExp, result = 1): Step => ({sql, result, write: true});
const insertRoot = () => write(/INSERT INTO "GuideDispatchStream"/);
const insertEvent = () => write(/INSERT INTO "GuideDispatchEvent"/);
const update = (count = 1) => write(/UPDATE "GuideDispatchStream"/, count);

function fixture(steps: Step[] = [], commitErrors: unknown[] = []) {
  const calls: {sql: string; values: unknown[]}[] = [], committedWrites: string[] = [];
  let cursor = 0, commits = 0, rollbacks = 0, attemptNumber = 0;
  const transaction = vi.fn(async (work: (tx: GuideDispatchSql) => Promise<unknown>, _options: unknown) => {
    const writes: string[] = [], index = attemptNumber++;
    const run = async (sql: string, ...values: unknown[]) => {
      calls.push({sql, values});
      const step = steps[cursor++];
      expect(step, 'unexpected SQL').toBeDefined();
      expect(sql).toMatch(step.sql);
      if (step.fail) throw step.error;
      if (step.write) writes.push(sql);
      return structuredClone(step.result);
    };
    try {
      const result = await work({$queryRawUnsafe: run, $executeRawUnsafe: run} as GuideDispatchSql);
      if (index < commitErrors.length) throw commitErrors[index];
      commits++; committedWrites.push(...writes); return result;
    } catch (error) {rollbacks++; throw error;}
  });
  return {store: new PostgresGuideDispatchStore({$transaction: transaction} as any), transaction, calls, committedWrites,
    get commits() {return commits;}, get rollbacks() {return rollbacks;},
    done() {expect(cursor).toBe(steps.length);}};
}
async function denied(work: Promise<unknown>, code = unavailable) {
  const error = await work.then(() => {throw new Error('EXPECTED_FAILURE');}, e => e);
  expect(error).toBeInstanceOf(GuideDispatchError); expect(error.code).toBe(code);
  expect(error.message).toBe(code); expect(JSON.stringify(error)).not.toContain(secret); return error;
}
const serializations = [{code: '40001'}, {code: 'P2034'}, {code: 'P2010', meta: {code: '40001'}},
  {code: 'P2010', meta: {driverAdapterError: {cause: {originalCode: '40001'}}}},
  {code: 'P2010', meta: {driverAdapterError: {cause: {code: '40001'}}}}];

describe('candidate PostgreSQL guide dispatch SQL contracts (synthetic metadata only)', () => {
  it('01 constructs without accessing the database', () => {const f = fixture(); expect(f.transaction).not.toHaveBeenCalled(); f.done();});
  it('02 validates exact keys before database access', async () => {
    for (const input of [{...key, companyId: 0}, {...key, issuerRuc: '20000000000'}, {...key, operationId: 'bad'},
      {...key, credential: secret}, null]) {
      const f = fixture(); await denied(f.store.transaction(input as any, async () => true));
      expect(f.transaction).not.toHaveBeenCalled(); f.done();
    }
  });
  it('03 uses Serializable 15s/3s and a bound global operation lock', async () => {
    const f = fixture([lock()]); expect(await f.store.transaction(key, async () => 42)).toBe(42);
    expect(f.transaction.mock.calls[0][1]).toEqual({isolationLevel: 'Serializable', timeout: 15000, maxWait: 3000});
    expect(f.calls[0].values).toEqual(['factuez:guide-dispatch:' + key.operationId]);
    expect(f.calls[0].sql).not.toContain(key.operationId); f.done();
  });
  it('04 reads missing streams without synthesizing a registration', async () => {
    const f = fixture([lock(), roots([]), history([])]);
    expect(await f.store.transaction(key, tx => tx.read())).toBeNull(); f.done();
  });
  it('05 scopes both reads by company/RUC/operation and bounds ordered events', async () => {
    const f = fixture([lock(), roots(), history()]);
    expect(await f.store.transaction(key, tx => tx.read())).toEqual({manifest, events: [registered]});
    for (const c of f.calls.slice(1)) {
      expect(c.values).toEqual([key.companyId, key.issuerRuc, key.operationId]);
      expect(c.sql).toMatch(/"companyId"=\$1/); expect(c.sql).toMatch(/"issuerRuc"=\$2/);
      expect(c.sql).toMatch(/"operationId"=\$3::uuid/);
    }
    expect(f.calls[1].sql).toContain('FOR UPDATE'); expect(f.calls[2].sql).toContain('ORDER BY e."version" LIMIT 129'); f.done();
  });
  it('06 rejects physical identity columns inconsistent with the manifest', async () => {
    for (const field of ['operationId', 'companyId', 'issuerRuc', 'documentId', 'guideType', 'fullNumber']) {
      const f = fixture([lock(), roots([{...root(), [field]: field === 'companyId' ? 2 : 'bad'}]), history()]);
      await denied(f.store.transaction(key, tx => tx.read())); f.done();
    }
  });
  it('07 rejects incorrect root head hash or revision', async () => {
    for (const patch of [{revision: 0}, {revision: 2}, {revision: '1'}, {headSha256: 'd'.repeat(64)}]) {
      const f = fixture([lock(), roots([{...root(), ...patch}]), history()]);
      await denied(f.store.transaction(key, tx => tx.read())); f.done();
    }
  });
  it('08 rejects absent, duplicate, orphan or over-limit rows', async () => {
    for (const [r, e] of [[[root()], []], [[], eventRows()], [[root(), root()], eventRows()],
      [[root()], Array.from({length: 129}, () => eventRows()[0])]]) {
      const f = fixture([lock(), roots(r), history(e)]); await denied(f.store.transaction(key, tx => tx.read())); f.done();
    }
  });
  it('09 checks every event physical version, hash and operation', async () => {
    for (const patch of [{operationId: uuid(7)}, {version: 2}, {hash: 'd'.repeat(64)},
      {payload: {...registered, version: 2}}, {payload: {...registered, operationId: uuid(7)}}, {payload: null}]) {
      const f = fixture([lock(), roots(), history([{...eventRows()[0], ...patch}])]);
      await denied(f.store.transaction(key, tx => tx.read())); f.done();
    }
  });
  it('10 rebuilds real hashes and transitions rather than trusting matching physical heads', async () => {
    const forged = {...registered, data: {manifestSha256: 'd'.repeat(64)}};
    const {sha256: ignored, ...unsigned} = forged; forged.sha256 = fiscalSnapshotSha256(unsigned);
    const f = fixture([lock(), roots([root([forged])]), history(eventRows([forged]))]);
    await denied(f.store.transaction(key, tx => tx.read())); f.done();
  });
  it('11 rejects persisted production, extra-key and wrong-scope manifests', async () => {
    for (const patch of [{environment: 'PRODUCTION'}, {source: 'SUNAT'}, {credential: secret}, {key: {...key, companyId: 2}}]) {
      const f = fixture([lock(), roots([{...root(), manifest: {...manifest, ...patch}}]), history()]);
      await denied(f.store.transaction(key, tx => tx.read())); f.done();
    }
  });
  it('12 registers root revision 1 and its exact REGISTER event in one transaction', async () => {
    const f = fixture([lock(), roots([]), history([]), insertRoot(), insertEvent()]);
    await f.store.transaction(key, tx => tx.register(manifest, registered));
    expect(f.calls[3].values).toEqual([key.operationId, 1, key.issuerRuc, manifest.documentId,
      '09', 'T001-1', JSON.stringify(manifest), registered.sha256]);
    expect(f.calls[4].values).toEqual([key.operationId, 1, JSON.stringify(registered), registered.sha256]);
    expect(f.commits).toBe(1); expect(f.committedWrites).toHaveLength(2); f.done();
  });
  it('13 accepts 31 metadata with BETA emulator source', async () => {
    const m = {...fixtureManifest(), guideType: '31' as const, fullNumber: 'V001-1'};
    const e = appendGuideDispatch(m, [], {kind: 'REGISTER', data: {manifestSha256: fiscalSnapshotSha256(m)}}, at);
    const f = fixture([lock(), roots([]), history([]), insertRoot(), insertEvent()]);
    await f.store.transaction(key, tx => tx.register(m, e)); expect(f.calls[3].values[4]).toBe('31'); f.done();
  });
  it('14 rejects malformed or scoped-different current input before reads or writes', async () => {
    for (const patch of [{environment: 'PRODUCTION'}, {environment: undefined}, {source: 'SUNAT'},
      {token: secret}, {key: {...key, companyId: 2}}]) {
      const f = fixture([lock()]); await denied(f.store.transaction(key, tx => tx.register({...manifest, ...patch} as any, registered)),
        'key' in patch ? identity : unavailable); expect(f.calls).toHaveLength(1); f.done();
    }
  });
  it('15 validates the exact register hash and event shape before SQL', async () => {
    for (const e of [{...registered, extra: secret}, {...registered, sha256: 'f'.repeat(64)}, attempt,
      {...registered, data: {manifestSha256: 'f'.repeat(64)}}]) {
      const f = fixture([lock()]); await denied(f.store.transaction(key, tx => tx.register(manifest, e))); f.done();
    }
  });
  it('16 deduplicates an identical register even after later events', async () => {
    const f = fixture([lock(), roots([root([registered, attempt])]), history(eventRows([registered, attempt]))]);
    await f.store.transaction(key, tx => tx.register(manifest, registered)); expect(f.committedWrites).toEqual([]); f.done();
  });
  it('17 reports an identity conflict for a different manifest or initial event', async () => {
    for (const m of [{...manifest, ownerRevision: 2}, manifest]) {
      const e = appendGuideDispatch(m, [], {kind: 'REGISTER', data: {manifestSha256: fiscalSnapshotSha256(m)}},
        m === manifest ? '2026-10-22T05:00:01.000Z' : at);
      const f = fixture([lock(), roots(), history()]);
      await denied(f.store.transaction(key, tx => tx.register(m, e)), identity); f.done();
    }
  });
  it('18 verifies current history then CAS-updates the head before append', async () => {
    const f = fixture([lock(), roots(), history(), update(), insertEvent()]);
    await f.store.transaction(key, tx => tx.append(attempt, 1));
    expect(f.calls[3].values).toEqual([1, key.issuerRuc, key.operationId, 2, attempt.sha256, 1, registered.sha256]);
    expect(f.calls[3].sql).toContain('AND "revision"=$6 AND "headSha256"=$7');
    expect(f.calls[4].values[1]).toBe(2); expect(f.committedWrites).toHaveLength(2); f.done();
  });
  it('19 rejects invalid expected revision without reading', async () => {
    for (const n of [0, -1, 1.5, NaN, Infinity, 129]) {
      const f = fixture([lock()]); await denied(f.store.transaction(key, tx => tx.append(attempt, n)), revision); f.done();
    }
  });
  it('20 rejects stale revision, missing stream and a zero-row CAS', async () => {
    for (const [steps, expected] of [[ [roots(), history()], 2 ], [ [roots([]), history([])], 1 ],
      [ [roots(), history(), update(0)], 1 ]] as [Step[], number][]) {
      const f = fixture([lock(), ...steps]);
      await denied(f.store.transaction(key, tx => tx.append(attempt, expected)), revision); f.done();
    }
  });
  it('21 refuses invalid appended hashes and transitions before changing the head', async () => {
    const wrong = {...attempt, data: {attemptId: uuid(9)}};
    for (const e of [wrong, registered, {...attempt, credential: secret}]) {
      const f = fixture([lock(), roots(), history()]); await denied(f.store.transaction(key, tx => tx.append(e, 1))); f.done();
    }
  });
  it('22 rolls back head writes when event insertion fails or affects zero rows', async () => {
    for (const last of [{...insertEvent(), result: 0}, {...insertEvent(), fail: true, error: new Error(secret)}]) {
      const f = fixture([lock(), roots(), history(), update(), last]);
      await denied(f.store.transaction(key, tx => tx.append(attempt, 1)));
      expect(f.commits).toBe(0); expect(f.committedWrites).toEqual([]); f.done();
    }
  });
  it('23 poisons swallowed SQL failures and stops subsequent ports', async () => {
    const f = fixture([lock(), roots(), history(), update(), {...insertEvent(), fail: true, error: new Error(secret)}]);
    await denied(f.store.transaction(key, async tx => {
      try {await tx.append(attempt, 1);} catch {}
      await expect(tx.read()).rejects.toThrow(secret); return true;
    })); expect(f.commits).toBe(0); expect(f.committedWrites).toEqual([]); f.done();
  });
  it('24 preserves the first failure when the callback masks it with a conflict', async () => {
    const f = fixture([lock(), {...roots(), fail: true, error: undefined}]);
    await denied(f.store.transaction(key, async tx => {
      try {await tx.read();} catch {} throw new GuideDispatchError(revision);
    })); expect(f.rollbacks).toBe(1); f.done();
  });
  it('25 retries only coded serialization failures using fresh callbacks, at most three attempts', async () => {
    for (const error of serializations) {
      const f = fixture([lock(), lock(), lock()], [error, error]); const callback = vi.fn(async () => 42);
      expect(await f.store.transaction(key, callback)).toBe(42); expect(callback).toHaveBeenCalledTimes(3);
      expect(f.rollbacks).toBe(2); expect(f.commits).toBe(1); f.done();
      const exhausted = fixture([lock(), lock(), lock()], [error, error, error]);
      await denied(exhausted.store.transaction(key, async () => true));
      expect(exhausted.transaction).toHaveBeenCalledTimes(3); expect(exhausted.commits).toBe(0); exhausted.done();
    }
  });
  it('26 retries swallowed serialization failures without committing the poisoned attempt', async () => {
    const f = fixture([lock(), {...roots(), fail: true, error: {code: '40001'}}, lock(), roots([]), history([])]);
    const callback = vi.fn(async tx => {try {return await tx.read();} catch {return null;}});
    expect(await f.store.transaction(key, callback)).toBeNull(); expect(callback).toHaveBeenCalledTimes(2);
    expect(f.rollbacks).toBe(1); expect(f.commits).toBe(1); f.done();
  });
  it('27 sanitizes unique violations as identity conflicts without retry', async () => {
    for (const error of [{code: '23505'}, {code: 'P2002'}, {code: 'P2010', meta: {code: '23505'}},
      {code: 'P2010', meta: {driverAdapterError: {cause: {originalCode: '23505'}}}}]) {
      const f = fixture([lock(), roots([]), history([]), {...insertRoot(), fail: true, error: {...error, message: secret}}]);
      await denied(f.store.transaction(key, tx => tx.register(manifest, registered)), identity);
      expect(f.transaction).toHaveBeenCalledTimes(1); f.done();
    }
  });
  it('28 does not retry deadlocks, message text, lookalike codes or unknown failures', async () => {
    for (const error of [{code: '40P01'}, {code: '400010'}, new Error('40001 P2034 ' + secret),
      {code: 'P2010', meta: {message: '40001'}}, {code: 'UNKNOWN', meta: {code: '40001'}}, null, undefined]) {
      const f = fixture([lock()], [error]); await denied(f.store.transaction(key, async () => true));
      expect(f.transaction).toHaveBeenCalledTimes(1); f.done();
    }
    expect(safeGuideDispatchError({code: identity, message: secret}).code).toBe(unavailable);
  });
  it('29 rolls back register on callback failure and maps arbitrary domain errors safely', async () => {
    const f = fixture([lock(), roots([]), history([]), insertRoot(), insertEvent()]);
    await denied(f.store.transaction(key, async tx => {await tx.register(manifest, registered); throw new Error(secret);}));
    expect(f.committedWrites).toEqual([]); expect(f.rollbacks).toBe(1); f.done();
  });
  it('30 drains unawaited failed ports before commit and closes escaped transaction handles', async () => {
    const f = fixture([lock(), roots(), history(), update(), {...insertEvent(), fail: true, error: new Error(secret)}]);
    await denied(f.store.transaction(key, async tx => {void tx.append(attempt, 1); return true;}));
    expect(f.commits).toBe(0); f.done();
    const g = fixture([lock()]); let escaped: any;
    await g.store.transaction(key, async tx => {escaped = tx;});
    await denied(escaped.read()); expect(g.calls).toHaveLength(1); g.done();
  });
  it('31 declares only new SUNAT tables, fiscal uniqueness and deferred head membership', () => {
    const ddl = readFileSync(new URL('../services/sunat-service/guide-dispatch-schema.candidate.sql', import.meta.url), 'utf8');
    expect(ddl).toContain('REVIEW CANDIDATE ONLY');
    expect([...ddl.matchAll(/CREATE TABLE "([^"]+)"/g)].map(m => m[1])).toEqual(['GuideDispatchStream', 'GuideDispatchEvent']);
    expect(ddl).toContain('"documentId" uuid NOT NULL UNIQUE');
    expect(ddl).toContain('UNIQUE ("issuerRuc","guideType","fullNumber")');
    expect(ddl).not.toContain('UNIQUE ("companyId","issuerRuc","guideType","fullNumber")');
    expect(ddl).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(ddl).not.toMatch(/CompanySettings|SeriesCounter|nextval|setval|CREATE EXTENSION/i);
    for (const table of ['GuideDispatchStream', 'GuideDispatchEvent']) expect(ddl).toContain('BEFORE TRUNCATE ON "' + table + '"');
    expect(ddl).toContain('BEFORE UPDATE OR DELETE ON "GuideDispatchEvent"');
    expect(ddl).toContain('BEFORE DELETE ON "GuideDispatchStream"');
    expect(ddl).toContain('NEW."revision"<>OLD."revision"+1');
  });
  it('32 enforces explicit BETA emulator shape, canonical hashes and register/predecessor linkage', () => {
    const ddl = readFileSync(new URL('../services/sunat-service/guide-dispatch-schema.candidate.sql', import.meta.url), 'utf8');
    for (const fragment of ["p->>'environment'='BETA'", "p->>'source'='LOCAL_EMULATOR'", 'guide_dispatch_exact_keys',
      'guide_dispatch_sha(root."manifest")', "guide_dispatch_sha(p-'sha256')", 'GUIDE_DISPATCH_HEAD_BEFORE_APPEND_REQUIRED',
      'GUIDE_DISPATCH_EVENT_PREDECESSOR_REQUIRED', '"revision" BETWEEN 1 AND 128']) expect(ddl).toContain(fragment);
    expect(rebuildGuideDispatch(manifest, [registered, attempt]).officialCdrVerified).toBe(false);
  });
  it('33 preserves only finite, typed coordinator errors, with a code-only message', async () => {
    for (const code of ['GUIDE_DISPATCH_OWNER_CHANGED', 'GUIDE_DISPATCH_SOURCE_NOT_FOUND',
      'GUIDE_DISPATCH_TICKET_REQUIRED', 'GUIDE_DISPATCH_HISTORY_LIMIT', 'GUIDE_DISPATCH_RESULT_CONFLICT',
      'INVALID_GUIDE_DISPATCH_OWNER', 'GUIDE_DISPATCH_SOURCE_CHANGED', 'GUIDE_DISPATCH_NOT_FOUND', 'GUIDE_DISPATCH_OWNER_UNAVAILABLE']) {
      const f = fixture([lock()]), error = new GuideDispatchError(code); error.message = secret;
      await denied(f.store.transaction(key, async () => {throw error;}), code);
      expect(f.transaction).toHaveBeenCalledTimes(1); f.done();
    }
  });
  it('34 maps arbitrary and corrupt-history codes to unavailable, even on typed errors', async () => {
    for (const error of [new GuideDispatchError(secret), new GuideDispatchError('GUIDE_DISPATCH_HISTORY_INCONSISTENT'),
      new GuideDispatchError('GUIDE_DISPATCH_TRANSITION_FORBIDDEN'), {code: 'GUIDE_DISPATCH_OWNER_CHANGED', message: secret}]) {
      const f = fixture([lock()]); await denied(f.store.transaction(key, async () => {throw error;})); f.done();
    }
  });
});
