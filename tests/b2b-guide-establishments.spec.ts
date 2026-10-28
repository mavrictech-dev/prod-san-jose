import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { B2bSecurityError } from '../packages/contracts/src/b2b-security';
import type { EstablishmentSnapshot } from '../services/billing-service/src/b2b/guide-establishments';
import { fiscalSnapshotSha256 } from '../packages/sunat-core/src/fiscal-note';
import { BillingGuidePreparation, GUIDE_PREPARATION_GATES } from '../services/billing-service/src/b2b/guide-preparation';
import { establishmentFixture, type EstablishmentState } from './helpers/b2b-guide-establishments.fixture';
import { guideFixture, guideKey, guideUuid } from './helpers/b2b-guide.fixture';

type Fixture = ReturnType<typeof establishmentFixture>;
const flags = { candidateOnly: true, officialValidation: false, fiscalExecutionEnabled: false, transmissionAuthorized: false };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const call = (f: Fixture, action: 'READ' | 'REPLACE') => action === 'READ' ? f.read() : f.replace();
const head = (f: Fixture) => f.store.state.heads.get(f.company.id)!;
function reseal(value: EstablishmentSnapshot) {
  const { sha256: _hash, ...unsigned } = value;
  value.sha256 = fiscalSnapshotSha256(unsigned);
}

describe('local establishment registry: bounds and trusted administrator', () => {
  it.each([0, -1, 1.5, NaN, Infinity, 2147483648, '1', null, undefined])('rejects company id %s before any port', async id => {
    const f = establishmentFixture();
    await expect(f.core.read(f.token, id as number, f.context)).rejects.toMatchObject({ status: 400 });
    await expect(f.core.replace(f.token, id as number, f.input(), f.context)).rejects.toMatchObject({ status: 400 });
    expect(f.store.rateCalls).toEqual([]);
    expect(f.admin.verify).not.toHaveBeenCalled();
    expect(f.store.transactions).toEqual([]);
  });

  it.each([
    null, {}, { requestId: 'bad', peer: 'fictitious' }, { requestId: guideUuid(81), peer: '' },
    { requestId: guideUuid(81), peer: 42 }, { requestId: guideUuid(81), peer: 'p'.repeat(257) },
  ])('rejects invalid request context %j', async context => {
    const f = establishmentFixture();
    for (const action of ['READ', 'REPLACE'] as const) {
      const run = action === 'READ' ? f.core.read(f.token, 1, context as any) : f.core.replace(f.token, 1, f.input(), context as any);
      await expect(run).rejects.toMatchObject({ status: 400, code: 'INVALID_ESTABLISHMENT_REQUEST' });
    }
    expect(f.store.rateCalls).toEqual([]);
    expect(f.admin.verify).not.toHaveBeenCalled();
  });

  it.each(['', 'Bearer fictitious', 'bad/token', 'x'.repeat(8193), null, 1])('rejects malformed token %#', async token => {
    const f = establishmentFixture();
    await expect(f.core.read(token as string, 1, f.context)).rejects.toMatchObject({ status: 401, code: 'INVALID_TOKEN' });
    await expect(f.core.replace(token as string, 1, f.input(), f.context)).rejects.toMatchObject({ status: 401 });
    expect(f.admin.verify).not.toHaveBeenCalled();
    expect(f.store.transactions).toEqual([]);
  });

  const invalidAdmins = [
    ['no step-up', { stepUpVerified: false }], ['claimed step-up', { stepUpVerified: 'true' }],
    ['assigned scope', { scope: 'ASSIGNED' }], ['no permissions', { permissions: [] }],
    ['setup only', { permissions: ['setup.manage'] }], ['series only', { permissions: ['series.manage'] }],
    ['requested scopes', { permissions: ['guide.write', 'setup.manage series.manage'] }],
    ['bad id', { id: 'fictitious-admin' }], ['negative auth revision', { authRevision: -1 }],
    ['fractional auth revision', { authRevision: 0.5 }], ['overflow auth revision', { authRevision: 2147483648 }],
  ] as const;
  for (const action of ['READ', 'REPLACE'] as const) {
    it.each(invalidAdmins)(`${action} requires a verified global admin: %s`, async (_label, changes) => {
      const f = establishmentFixture();
      f.admin.verify.mockResolvedValue({ ...f.actor, ...changes } as any);
      await expect(call(f, action)).rejects.toMatchObject({ status: 403, code: 'ESTABLISHMENT_ADMIN_REQUIRED' });
      expect(f.store.transactions).toEqual([]);
      expect(f.store.state.heads.size).toBe(0);
      expect(f.store.state.audits).toEqual([]);
    });

    it(`${action} cannot use a SERVICE token or JSON proof as administrator authority`, async () => {
      const f = establishmentFixture();
      await expect(action === 'READ' ? f.core.read('fictitious-service-token', 1, f.context)
        : f.core.replace('fictitious-service-token', 1, { ...f.input(), admin: f.actor }, f.context))
        .rejects.toMatchObject({ status: 401 });
      f.admin.verify.mockResolvedValue({ kind: 'SERVICE', scope: 'GLOBAL', scopes: ['setup.manage', 'series.manage'] } as any);
      await expect(call(f, action)).rejects.toMatchObject({ status: 403 });
      expect(f.store.transactions).toEqual([]);
    });

    it(`${action} fails closed on verifier outage and preserves explicit revocation`, async () => {
      const f = establishmentFixture();
      f.admin.verify.mockRejectedValueOnce(new Error('SYNTHETIC_AUTH_OUTAGE'));
      await expect(call(f, action)).rejects.toMatchObject({ status: 503, code: 'ADMIN_AUTHORITY_UNAVAILABLE' });
      f.admin.verify.mockRejectedValueOnce(new B2bSecurityError(401, 'SYNTHETIC_REVOKED'));
      await expect(call(f, action)).rejects.toMatchObject({ status: 401, code: 'SYNTHETIC_REVOKED' });
      expect(f.store.transactions).toEqual([]);
    });
  }

  it('accepts authRevision zero, maximal company id and a 256-character peer', async () => {
    const f = establishmentFixture(), id = 2147483647;
    f.actor.authRevision = 0;
    f.store.state.companies.set(id, { ...f.company, id });
    const result = await f.core.replace(f.token, id, f.input(0, []), { ...f.context, peer: 'p'.repeat(256) });
    expect(result.snapshot.authRevision).toBe(0);
    expect(result.companyId).toBe(id);
  });
});

describe('local establishment registry: request and entry limits', () => {
  const badInputs: [string, (f: Fixture) => unknown][] = [
    ['null', () => null], ['array', () => []], ['missing entries', f => ({ expectedRevision: 0, expectedIssuerRevision: f.company.configVersion })],
    ['extra proof', f => ({ ...f.input(), officialValidation: true })],
    ['negative map revision', f => ({ ...f.input(), expectedRevision: -1 })],
    ['fractional map revision', f => ({ ...f.input(), expectedRevision: 0.5 })],
    ['string map revision', f => ({ ...f.input(), expectedRevision: '0' })],
    ['exhausted map revision', f => ({ ...f.input(), expectedRevision: 2147483647 })],
    ['missing issuer revision', f => ({ ...f.input(), expectedIssuerRevision: 0 })],
    ['issuer revision overflow', f => ({ ...f.input(), expectedIssuerRevision: 2147483648 })],
    ['non-array entries', f => ({ ...f.input(), entries: {} })],
    ['201 entries', f => ({ ...f.input(), entries: Array.from({ length: 201 }, () => f.entries[0]) })],
    ['over 128 KiB', f => ({ ...f.input(), padding: Array.from({ length: 10 }, () => 'x'.repeat(14000)) })],
    ['cyclic input', f => { const v: any = f.input(); v.loop = v; return v; }],
    ['proxy input', f => new Proxy(f.input(), {})],
    ['prototype key', () => JSON.parse('{"__proto__":{},"expectedRevision":0,"expectedIssuerRevision":3,"entries":[]}')],
  ];
  it.each(badInputs)('refuses %s without a map or audit', async (_label, make) => {
    const f = establishmentFixture();
    await expect(f.replace(make(f))).rejects.toMatchObject({ status: 400, code: 'INVALID_ESTABLISHMENT_REQUEST' });
    expect(f.store.transactions).toEqual([]);
    expect(f.store.state.heads.size).toBe(0);
    expect(f.store.state.audits).toEqual([]);
  });

  it('does not execute an accessor supplied as input', async () => {
    const f = establishmentFixture(), getter = vi.fn(() => f.entries);
    const value = { expectedRevision: 0, expectedIssuerRevision: 3 };
    Object.defineProperty(value, 'entries', { enumerable: true, get: getter });
    await expect(f.replace(value)).rejects.toMatchObject({ status: 400 });
    expect(getter).not.toHaveBeenCalled();
  });

  const invalidEntries = [
    ['branch UUID', { branchId: 'bad' }], ['zero branch revision', { branchRevision: 0 }],
    ['fractional branch revision', { branchRevision: 1.5 }], ['overflow branch revision', { branchRevision: 2147483648 }],
    ['numeric code', { establishmentCode: 1 }], ['short code', { establishmentCode: '001' }],
    ['long code', { establishmentCode: '00001' }], ['non-numeric code', { establishmentCode: 'ABCD' }],
    ['short ubigeo', { ubigeo: '15010' }], ['non-numeric ubigeo', { ubigeo: 'ABCDEF' }],
    ['numeric ubigeo', { ubigeo: 150101 }], ['empty address', { address: '' }],
    ['leading space', { address: ' ORIGEN FICTICIO' }], ['trailing space', { address: 'ORIGEN FICTICIO ' }],
    ['301-character address', { address: 'A'.repeat(301) }], ['control character', { address: 'ORIGEN\nFICTICIO' }],
    ['C1 control', { address: 'ORIGEN\u0085FICTICIO' }], ['lone surrogate', { address: 'ORIGEN\ud800' }],
    ['XML noncharacter', { address: 'ORIGEN\uffff' }], ['extra entry field', { sunatVerified: true }],
  ] as const;
  it.each(invalidEntries)('rejects entry %s', async (_label, change) => {
    const f = establishmentFixture();
    await expect(f.replace({ ...f.input(), entries: [{ ...f.entries[0], ...change }, f.entries[1]] }))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_ESTABLISHMENT_REQUEST' });
    expect(f.store.state.heads.size).toBe(0);
    expect(f.store.state.audits).toEqual([]);
  });

  it.each(['branchId', 'establishmentCode'] as const)('rejects duplicate %s', async field => {
    const f = establishmentFixture(), entries = structuredClone(f.entries);
    entries[1][field] = entries[0][field];
    await expect(f.replace(f.input(0, entries))).rejects.toMatchObject({ status: 400 });
    expect(f.store.transactions).toEqual([]);
  });

  it('accepts 200 distinct entries and a 300-character address', async () => {
    const f = establishmentFixture();
    const entries = Array.from({ length: 200 }, (_, n) => ({ branchId: guideUuid(1000 + n), branchRevision: 1,
      establishmentCode: String(n).padStart(4, '0'), ubigeo: '150101', address: 'A'.repeat(300) }));
    for (const e of entries) f.store.state.branches.set(e.branchId, { id: e.branchId, companyId: 1, active: true, masterRevision: 1 });
    expect((await f.replace(f.input(0, entries))).snapshot.entries).toHaveLength(200);
  });
});

describe('local establishment registry: rates, audited reads and immutable snapshots', () => {
  it('reads an absent map at revision zero without creating a head', async () => {
    const f = establishmentFixture(), result = await f.read();
    expect(result).toEqual({ schemaVersion: 'factuez.guide-establishment-registry.v1', companyId: 1,
      issuerRuc: '20000000001', issuerRevision: 3, revision: 0, snapshot: null, stale: false, ...flags });
    expect(f.store.state.heads.size).toBe(0);
    expect(f.store.state.audits).toHaveLength(1);
    expect(f.store.state.audits[0]).toMatchObject({ requestId: f.context.requestId, peerSha256: sha(f.context.peer),
      companyId: 1, revision: 0, actorId: f.actor.id, action: 'READ', at: f.control.at });
    expect(f.store.state.audits[0]).not.toHaveProperty('peer');
    expect(f.admin.verify).toHaveBeenCalledTimes(3);
  });

  it('enforces 300 reads per minute before authentication and resets in the next minute', async () => {
    const f = establishmentFixture();
    for (let i = 0; i < 300; i++) await f.read();
    const calls = f.admin.verify.mock.calls.length, before = structuredClone(f.store.state);
    await expect(f.read()).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    expect(f.admin.verify).toHaveBeenCalledTimes(calls);
    expect(f.store.state).toEqual(before);
    expect(f.store.rateCalls[0]).toEqual({ keySha256: sha('guide-establishments:READ:' + f.context.peer),
      window: Math.floor(Date.parse(f.control.at) / 60000), limit: 300 });
    await f.replace(); // independent action bucket
    await f.core.read(f.token, 1, { ...f.context, peer: 'fictitious-other-peer' });
    f.control.at = '2026-10-22T15:01:00.000Z';
    await expect(f.read()).resolves.toMatchObject({ revision: 1 });
  });

  it('enforces 30 replacements and counts failed requests outside rollback', async () => {
    const f = establishmentFixture();
    for (let i = 0; i < 30; i++) await expect(f.replace(f.input(1))).rejects.toMatchObject({ code: 'ESTABLISHMENT_REVISION_CONFLICT' });
    await expect(f.replace()).rejects.toMatchObject({ status: 429 });
    expect(f.store.state.heads.size).toBe(0);
    expect(f.store.state.audits).toEqual([]);
    expect(f.store.rateCalls[0]).toMatchObject({ keySha256: sha('guide-establishments:REPLACE:' + f.context.peer), limit: 30 });
    await expect(f.read()).resolves.toMatchObject({ revision: 0 });
    f.control.at = '2026-10-22T15:01:00.000Z';
    await expect(f.replace()).resolves.toMatchObject({ revision: 1 });
  });

  it('canonicalizes entry order, hashes the complete snapshot, persists and detaches every boundary', async () => {
    const f = establishmentFixture(), input = f.input(0, [...f.entries].reverse());
    const result = await f.replace(input), { sha256, ...unsigned } = result.snapshot;
    expect(result).toMatchObject({ revision: 1, ...flags });
    expect(unsigned).toEqual({ schemaVersion: 'factuez.guide-establishments.v1', companyId: 1, issuerRuc: f.company.ruc,
      issuerRevision: 3, revision: 1, entries: f.entries, actorId: f.actor.id, authRevision: 4,
      at: f.control.at, source: 'ADMIN_LOCAL_CONFIGURATION' });
    expect(sha256).toBe(fiscalSnapshotSha256(unsigned));
    expect(sha256).toMatch(/^[a-f0-9]{64}$/);
    const saved = structuredClone(head(f));
    input.entries[0].address = 'INPUT FICTICIO MODIFICADO';
    result.snapshot.entries[0].address = 'RESPUESTA FICTICIA MODIFICADA';
    expect(head(f)).toEqual(saved);
    const restarted = await f.restart().read(f.token, 1, f.context);
    expect(restarted.snapshot).toEqual(saved);
    restarted.snapshot!.entries[0].address = 'LECTURA FICTICIA MODIFICADA';
    expect(head(f)).toEqual(saved);
    expect(f.store.state.audits.map(a => a.action)).toEqual(['REPLACE', 'READ']);
    expect(new Set(f.store.state.audits.map(a => a.id)).size).toBe(2);
  });

  it('produces the same hash for reordered input and a new hash for a new revision', async () => {
    const a = establishmentFixture(), b = establishmentFixture();
    expect((await a.replace()).snapshot.sha256).toBe((await b.replace(b.input(0, [...b.entries].reverse()))).snapshot.sha256);
    const first = head(a).sha256;
    expect((await a.replace(a.input(1))).snapshot.sha256).not.toBe(first);
  });
});

describe('local establishment registry: authority freshness and transactional rollback', () => {
  for (const action of ['READ', 'REPLACE'] as const) {
    it.each([2, 3])(`${action} rechecks authRevision at verification #%s`, async at => {
      const f = establishmentFixture(), before = structuredClone(f.store.state);
      let n = 0;
      f.admin.verify.mockImplementation(async () => {
        if (++n === at) f.actor.authRevision++;
        return structuredClone(f.actor);
      });
      await expect(call(f, action)).rejects.toMatchObject({ status: 409, code: 'ESTABLISHMENT_AUTHORITY_CHANGED' });
      expect(f.store.state).toEqual(before);
      expect(f.store.writeCalls).toEqual(at === 2 ? [] : action === 'READ' ? ['audit'] : ['save', 'audit']);
    });

    it.each(['actor', 'permission', 'step-up', 'revoked'] as const)(`${action} rolls back when %s changes after audit`, async mode => {
      const f = establishmentFixture(), before = structuredClone(f.store.state);
      f.store.onWrite = async action => {
        if (action !== 'audit') return;
        if (mode === 'actor') f.actor.id = guideUuid(82);
        if (mode === 'permission') f.actor.permissions.pop();
        if (mode === 'step-up') (f.actor as any).stepUpVerified = false;
        if (mode === 'revoked') f.admin.verify.mockRejectedValue(new B2bSecurityError(401, 'SYNTHETIC_REVOKED'));
      };
      await expect(call(f, action)).rejects.toMatchObject({ status: mode === 'actor' ? 409 : mode === 'revoked' ? 401 : 403 });
      expect(f.store.state).toEqual(before);
    });
  }

  it.each(['save', 'audit'] as const)('discards staged head and audit on %s failure and releases the queue', async failing => {
    const f = establishmentFixture();
    await f.replace();
    const before = structuredClone(f.store.state);
    let leaked: EstablishmentState | undefined;
    f.store.onWrite = async (action, staged) => {
      if (action === failing) { leaked = staged; throw new Error('SYNTHETIC_WRITE_FAILURE'); }
    };
    await expect(f.replace(f.input(1))).rejects.toThrow('SYNTHETIC_WRITE_FAILURE');
    expect(f.store.state).toEqual(before);
    f.store.onWrite = undefined;
    await expect(f.replace(f.input(1))).resolves.toMatchObject({ revision: 2 });
    leaked!.heads.get(1)!.entries[0].address = 'STAGED FICTICIO DESCARTADO';
    expect(head(f).entries).toEqual(f.entries);
    expect(f.store.state.audits).toHaveLength(2);
  });

  it('serializes competing replacements so only one exact expected revision wins', async () => {
    const f = establishmentFixture();
    const results = await Promise.allSettled([f.replace(), f.replace()]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(failure.reason).toMatchObject({ status: 409, code: 'ESTABLISHMENT_REVISION_CONFLICT' });
    expect(head(f).revision).toBe(1);
    expect(f.store.state.audits).toHaveLength(1);
  });
});

describe('local establishment registry: map, issuer and branch revision ownership', () => {
  it.each([0, 2])('rejects wrong expected map revision %s without changing the head', async revision => {
    const f = establishmentFixture(); await f.replace();
    const before = structuredClone(f.store.state);
    await expect(f.replace(f.input(revision))).rejects.toMatchObject({ status: 409, code: 'ESTABLISHMENT_REVISION_CONFLICT' });
    expect(f.store.state).toEqual(before);
  });

  it('requires the exact current issuer revision', async () => {
    const f = establishmentFixture(), before = structuredClone(f.store.state);
    await expect(f.replace(f.input(0, f.entries, 2))).rejects.toMatchObject({ status: 409, code: 'ESTABLISHMENT_ISSUER_REVISION_CONFLICT' });
    expect(f.store.state).toEqual(before);
  });

  it.each(['missing', 'inactive', 'production', 'wrong id', 'zero revision', 'bad ruc'] as const)('refuses %s issuer on reads and writes', async mode => {
    const f = establishmentFixture(), company = f.store.state.companies.get(1)!;
    if (mode === 'missing') f.store.state.companies.delete(1);
    if (mode === 'inactive') company.active = false;
    if (mode === 'production') (company as any).environment = 'PRODUCTION';
    if (mode === 'wrong id') company.id = 2;
    if (mode === 'zero revision') company.configVersion = 0;
    if (mode === 'bad ruc') company.ruc = '20000000000';
    const before = structuredClone(f.store.state);
    for (const action of ['READ', 'REPLACE'] as const) await expect(call(f, action)).rejects.toMatchObject({
      status: mode === 'bad ruc' ? 409 : 404,
    });
    expect(f.store.state).toEqual(before);
  });

  it.each(['missing', 'inactive', 'other company', 'stale revision', 'duplicate rows', 'extra rows'] as const)('refuses branch %s on replace', async mode => {
    const f = establishmentFixture(), branch = f.store.state.branches.get(f.entries[1].branchId)!;
    if (mode === 'missing') f.store.state.branches.delete(branch.id);
    if (mode === 'inactive') branch.active = false;
    if (mode === 'other company') branch.companyId = 2;
    if (mode === 'stale revision') branch.masterRevision++;
    if (mode === 'duplicate rows') f.store.branchesOverride = rows => [rows[0], rows[0]];
    if (mode === 'extra rows') f.store.branchesOverride = rows => [...rows, rows[0]];
    const before = structuredClone(f.store.state);
    await expect(f.replace()).rejects.toMatchObject({ status: 409, code: 'ESTABLISHMENT_BRANCH_REVISION_CONFLICT' });
    expect(f.store.state).toEqual(before);
  });

  it('cannot map a known branch belonging to a different issuer', async () => {
    const f = establishmentFixture(), entries = structuredClone(f.entries);
    entries[1].branchId = guideUuid(90); entries[1].branchRevision = 1;
    await expect(f.replace(f.input(0, entries))).rejects.toMatchObject({ code: 'ESTABLISHMENT_BRANCH_REVISION_CONFLICT' });
    expect(f.store.state.heads.size).toBe(0);
  });

  it.each(['issuer', 'branch', 'inactive branch', 'missing branch'] as const)('allows admin read of stale %s map and explicit versioned replacement', async mode => {
    const f = establishmentFixture(); await f.replace();
    const original = structuredClone(head(f)), company = f.store.state.companies.get(1)!;
    const branch = f.store.state.branches.get(f.entries[1].branchId)!;
    if (mode === 'issuer') company.configVersion++;
    if (mode === 'branch') branch.masterRevision++;
    if (mode === 'inactive branch') branch.active = false;
    if (mode === 'missing branch') f.store.state.branches.delete(branch.id);
    const read = await f.read();
    expect(read).toMatchObject({ stale: true, snapshot: original, revision: 1, ...flags });
    expect(head(f)).toEqual(original);
    await expect(f.match()).rejects.toMatchObject({ status: 409 });
    if (mode === 'issuer' || mode === 'branch') {
      const entries = structuredClone(f.entries);
      entries[1].branchRevision = branch.masterRevision;
      const replacement = await f.replace(f.input(1, entries, company.configVersion));
      expect(replacement.revision).toBe(2);
      await expect(f.read()).resolves.toMatchObject({ stale: false });
      await expect(f.match()).resolves.toHaveProperty('fresh');
    }
  });
});

describe('local establishment registry: tampered or corrupt persisted heads', () => {
  const tampering: [string, (p: EstablishmentSnapshot) => void, boolean?][] = [
    ['hash', p => { p.sha256 = '0'.repeat(64); }],
    ['address without rehash', p => { p.entries[0].address = 'DIRECCION FICTICIA ALTERADA'; }],
    ['actor without rehash', p => { p.actorId = guideUuid(82); }],
    ['wrong company', p => { p.companyId = 2; }, true],
    ['unknown schema', p => { (p as any).schemaVersion = 'unknown'; }, true],
    ['untrusted source', p => { (p as any).source = 'SERVICE'; }, true],
    ['zero revision', p => { p.revision = 0; }, true],
    ['invalid actor', p => { p.actorId = 'bad'; }, true],
    ['negative auth revision', p => { p.authRevision = -1; }, true],
    ['noncanonical timestamp', p => { p.at = '2026-10-22T15:00:00Z'; }, true],
    ['invalid issuer ruc', p => { p.issuerRuc = '20000000000'; }, true],
    ['noncanonical order', p => { p.entries.reverse(); }, true],
    ['duplicate branch', p => { p.entries[1].branchId = p.entries[0].branchId; }, true],
    ['duplicate code', p => { p.entries[1].establishmentCode = p.entries[0].establishmentCode; }, true],
    ['extra snapshot proof', p => { (p as any).officialValidation = true; }, true],
  ];
  it.each(tampering)('rejects %s on read, match AND overwrite without repairing it', async (_label, mutate, rehash) => {
    const f = establishmentFixture(); await f.replace();
    mutate(head(f)); if (rehash) reseal(head(f));
    const before = structuredClone(f.store.state);
    await expect(f.read()).rejects.toMatchObject({ status: 409, code: 'ESTABLISHMENT_REGISTRY_INCONSISTENT' });
    await expect(f.match()).rejects.toMatchObject({ status: 409, code: 'ESTABLISHMENT_REGISTRY_INCONSISTENT' });
    await expect(f.replace(f.input(1))).rejects.toMatchObject({ status: 409, code: 'ESTABLISHMENT_REGISTRY_INCONSISTENT' });
    expect(f.store.state).toEqual(before);
  });
});

describe('local establishment guard: exact local match, freshness and withdrawal', () => {
  it('accepts same fictional RUC, anchor origin and a distinct destination branch without side effects', async () => {
    const f = establishmentFixture(); await f.replace();
    expect(f.body.sender.ruc).toBe('20000000001'); expect(f.body.recipient.ruc).toBe(f.body.sender.ruc);
    const before = structuredClone(f.store.state), rates = f.store.rateCalls.length;
    const guard = await f.match();
    expect(Object.keys(guard)).toEqual(['fresh']);
    await expect(guard.fresh()).resolves.toBeUndefined();
    await expect(guard.fresh()).resolves.toBeUndefined();
    expect(f.store.state).toEqual(before);
    expect(f.store.rateCalls).toHaveLength(rates);
  });

  it('requires an existing registry', async () => {
    const f = establishmentFixture();
    await expect(f.match()).rejects.toMatchObject({ status: 409, code: 'ESTABLISHMENT_REGISTRY_REQUIRED' });
    expect(f.store.state.heads.size).toBe(0);
  });

  it.each(['origin', 'destination'] as const)('compares every %s field exactly', async endpoint => {
    for (const field of ['address', 'ubigeo', 'establishmentCode'] as const) {
      const f = establishmentFixture(); await f.replace();
      f.body[endpoint][field] = field === 'address' ? f.body[endpoint][field].toLowerCase() : field === 'ubigeo' ? '150103' : '0003';
      await expect(f.match()).rejects.toMatchObject({ status: 409, code: 'ESTABLISHMENT_MAPPING_MISMATCH' });
    }
  });

  it.each(['wrong anchor', 'same branch', 'swapped endpoints', 'different issuer ruc', 'different issuer id'] as const)('refuses %s', async mode => {
    const f = establishmentFixture(); await f.replace();
    if (mode === 'wrong anchor') f.binding.anchor.branchId = f.entries[1].branchId;
    if (mode === 'same branch') f.body.destination = structuredClone(f.body.origin);
    if (mode === 'swapped endpoints') [f.body.origin, f.body.destination] = [f.body.destination, f.body.origin];
    if (mode === 'different issuer ruc') f.binding.anchor.issuerRuc = '20000000010';
    if (mode === 'different issuer id') f.binding.anchor.issuerId = 2;
    await expect(f.match()).rejects.toMatchObject({ status: mode.startsWith('different issuer') ? 404 : 409 });
  });

  it.each(['sender', 'recipient'] as const)('refuses a %s RUC outside the locally mapped issuer', async party => {
    const f = establishmentFixture(); await f.replace();
    f.body[party].ruc = '20000000010';
    await expect(f.match()).rejects.toMatchObject({ status: 409 });
  });

  it('rejects invalid bindings, GT profile and absent endpoints before storage', async () => {
    const f = establishmentFixture();
    for (const binding of [{}, { ...f.binding, guideType: '31' }])
      await expect(f.core.assertLocalMapping(binding as any, f.body)).rejects.toMatchObject({ status: 400 });
    await expect(f.core.assertLocalMapping(f.binding, { ...f.body, destination: null } as any)).rejects.toMatchObject({ status: 400 });
    expect(f.store.transactions).toEqual([]);
  });

  it.each(['issuer', 'branch', 'removed branch', 'map changed', 'same entries new version', 'withdrawal'] as const)('fresh rejects after %s', async mode => {
    const f = establishmentFixture(); await f.replace();
    const guard = await f.match();
    if (mode === 'issuer') f.store.state.companies.get(1)!.configVersion++;
    if (mode === 'branch') f.store.state.branches.get(f.entries[1].branchId)!.masterRevision++;
    if (mode === 'removed branch') f.store.state.branches.delete(f.entries[1].branchId);
    if (mode === 'map changed') {
      const entries = structuredClone(f.entries); entries[1].address = 'DESTINO FICTICIO NUEVO';
      await f.replace(f.input(1, entries));
    }
    if (mode === 'same entries new version') await f.replace(f.input(1));
    if (mode === 'withdrawal') await f.replace(f.input(1, []));
    const before = structuredClone(f.store.state);
    await expect(guard.fresh()).rejects.toMatchObject({ status: 409 });
    expect(f.store.state).toEqual(before);
  });

  it('fresh detects a new version even when the matching locations remain identical', async () => {
    const f = establishmentFixture(); await f.replace(); const guard = await f.match();
    await f.replace(f.input(1));
    await expect(guard.fresh()).rejects.toMatchObject({ code: 'ESTABLISHMENT_MAPPING_CHANGED' });
    await expect((await f.match()).fresh()).resolves.toBeUndefined();
  });

  it('captures detached binding and body rather than mutable caller references', async () => {
    const f = establishmentFixture(); await f.replace(); const guard = await f.match();
    f.body.destination.address = 'CAMBIO DEL CALLER FICTICIO'; f.binding.anchor.branchId = guideUuid(999);
    await expect(guard.fresh()).resolves.toBeUndefined();
  });

  it('withdraws with an empty versioned map, rejects stale withdrawal and can explicitly restore', async () => {
    const f = establishmentFixture(); await f.replace();
    await expect(f.replace(f.input(0, []))).rejects.toMatchObject({ code: 'ESTABLISHMENT_REVISION_CONFLICT' });
    const withdrawn = await f.replace(f.input(1, []));
    expect(withdrawn).toMatchObject({ revision: 2, snapshot: { entries: [], revision: 2 }, ...flags });
    await expect(f.read()).resolves.toMatchObject({ revision: 2, stale: false, snapshot: { entries: [] } });
    await expect(f.match()).rejects.toMatchObject({ code: 'ESTABLISHMENT_MAPPING_MISMATCH' });
    expect(f.store.state.heads.size).toBe(1);
    await f.replace(f.input(2));
    await expect((await f.match()).fresh()).resolves.toBeUndefined();
    expect(f.store.state.audits.filter(a => a.action === 'REPLACE').map(a => a.revision)).toEqual([1, 2, 3]);
  });

  it('allows an initial empty map and versioned withdrawal of a stale issuer map', async () => {
    const f = establishmentFixture(); await f.replace(f.input(0, []));
    f.store.state.companies.get(1)!.configVersion++;
    await expect(f.read()).resolves.toMatchObject({ stale: true, revision: 1 });
    await f.replace(f.input(1, [], 4));
    await expect(f.read()).resolves.toMatchObject({ stale: false, revision: 2, snapshot: { issuerRevision: 4, entries: [] } });
  });

  it('a local match leaves real guide preparation gates and all fiscal execution flags closed', async () => {
    const f = establishmentFixture(), g = guideFixture();
    const made = await g.command('CREATE', null, guideKey, undefined, f.body), id = made.response.id;
    await g.command('READY', id, guideKey + '_ready', '"v1"', {});
    const issuer = { current: vi.fn(async () => ({ ...f.body.sender, metadataSha256: 'b'.repeat(64) })) };
    const preparation = new BillingGuidePreparation(g.core, issuer);
    const before = await preparation.prepare(g.token, g.kind, g.binding, id, '"v2"');
    const guideState = structuredClone(g.store.state), companyState = structuredClone(f.store.state.companies), branches = structuredClone(f.store.state.branches);
    await f.replace(); await (await f.match()).fresh();
    const after = await preparation.prepare(g.token, g.kind, g.binding, id, '"v2"');
    expect(after).toEqual(before);
    expect(after).toMatchObject({ candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false, authorizedForTransfer: false });
    expect(after.gates).toEqual(GUIDE_PREPARATION_GATES);
    expect(after.gates).toContain('ESTABLISHMENT_MAPPING');
    expect(after.plan).toMatchObject({ numberReserved: false, signatureVerified: false, officialRulesValidated: false });
    for (const field of ['xml', 'cdr', 'number', 'outbox', 'certificate']) expect(after).not.toHaveProperty(field);
    expect(g.store.state).toEqual(guideState);
    expect(f.store.state.companies).toEqual(companyState);
    expect(f.store.state.branches).toEqual(branches);
  });
});
