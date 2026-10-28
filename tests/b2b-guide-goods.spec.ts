import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { B2bSecurityError } from '../packages/contracts/src/b2b-security';
import { fiscalSnapshotSha256 } from '../packages/sunat-core/src/fiscal-note';
import { guideGoodsProductSha256 } from '../services/billing-service/src/b2b/guide-goods';
import type { GuideGoodsProduct, GuideGoodsSnapshot } from '../services/billing-service/src/b2b/guide-goods-types';
import type { GuideBody } from '../services/billing-service/src/b2b/guide-model';
import { guideGoodsFixture, type GuideGoodsState } from './helpers/b2b-guide-goods.fixture';
import { guideUuid } from './helpers/b2b-guide.fixture';

type Fixture = ReturnType<typeof guideGoodsFixture>;
const flags = { candidateOnly: true, officialValidation: false, fiscalExecutionEnabled: false, transmissionAuthorized: false };
const head = (f: Fixture) => f.store.state.heads.get(f.company.id)!;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function reseal<T extends { sha256: string }>(value: T): T {
  const { sha256: _hash, ...unsigned } = value;
  value.sha256 = fiscalSnapshotSha256(unsigned);
  return value;
}
function error(code: string, status = 409) { return { status, code }; }
const invalid = error('INVALID_GUIDE_GOODS_REQUEST', 400);
async function seeded() { const f = guideGoodsFixture(); await f.replace(); return f; }
function noCommit(f: Fixture) {
  expect(f.store.state.heads.size).toBe(0);
  expect(f.store.state.audits).toEqual([]);
}

describe('GuideGoods real core: fixture, persistence and local provenance', () => {
  it('uses the exact local catalogue bundle and the real shared-product fingerprint', () => {
    const f = guideGoodsFixture();
    expect(f.company.ruc).toBe('20000000001');
    expect(f.product).toEqual({ id: guideUuid(50), sku: 'ITEM-FICTICIO-1', description: 'BIEN FICTICIO',
      category: 'BIEN', unitCode: 'NIU', sunatProductCode: null, active: true, updatedAt: '2026-10-22T14:00:00.000Z' });
    const { sha256, ...unsigned } = f.catalogue;
    expect(unsigned).toEqual({ schemaVersion: 'factuez.guide-reference-catalogue.v1', version: 'fictional-reference-v1',
      sourceUrl: 'https://cpe.sunat.gob.pe/node/116', sourceSha256: 'a'.repeat(64), units: ['NIU'],
      weightUnits: ['KGM', 'TNE'], ubigeos: ['150101', '150102'], referenceStatus: 'LOCAL_REFERENCE_NOT_OFFICIAL' });
    expect(sha256).toBe(fiscalSnapshotSha256(unsigned));
    expect(f.entries[0].productSha256).toBe(guideGoodsProductSha256(f.product));
    expect(guideGoodsProductSha256(f.product)).toBe(fiscalSnapshotSha256(f.product));
  });

  it('reads an unconfigured issuer without inventing a policy and audits only a hashed peer', async () => {
    const f = guideGoodsFixture(), result = await f.read();
    expect(result).toEqual({ schemaVersion: 'factuez.guide-goods-registry.v1', companyId: 1,
      issuerRuc: f.company.ruc, issuerRevision: 3, revision: 0, snapshot: null, stale: false, ...flags });
    expect(f.store.state.audits).toEqual([expect.objectContaining({ companyId: 1, revision: 0,
      actorId: f.actor.id, action: 'READ', requestId: f.context.requestId, peerSha256: sha(f.context.peer), at: f.control.at })]);
    expect(f.admin.verify).toHaveBeenCalledTimes(3);
    expect(f.store.productCalls).toEqual([]);
  });

  it('commits a sealed attributable snapshot and its audit, with no credentials or official claims', async () => {
    const f = guideGoodsFixture(), result = await f.replace();
    expect(result).toMatchObject({ revision: 1, ...flags });
    expect(result.snapshot).toEqual(head(f));
    expect(head(f)).toEqual({ schemaVersion: 'factuez.guide-goods-policy.v1', companyId: 1,
      issuerRuc: f.company.ruc, issuerRevision: 3, revision: 1, catalogue: f.catalogue, entries: f.entries,
      actorId: f.actor.id, authRevision: f.actor.authRevision, at: f.control.at,
      source: 'ADMIN_LOCAL_CONFIGURATION', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(reseal(structuredClone(head(f))).sha256).toBe(head(f).sha256);
    expect(f.store.writeCalls).toEqual(['save', 'audit']);
    expect(f.store.state.audits).toEqual([expect.objectContaining({ action: 'REPLACE', companyId: 1,
      revision: 1, actorId: f.actor.id, requestId: f.context.requestId, peerSha256: sha(f.context.peer) })]);
    expect(Object.keys(f.store.state.audits[0]).sort()).toEqual(
      ['id', 'requestId', 'peerSha256', 'companyId', 'revision', 'actorId', 'action', 'at'].sort());
    expect(JSON.stringify(result.snapshot)).not.toContain(f.token);
    expect(JSON.stringify(result.snapshot)).not.toContain(f.context.peer);
    expect(f.admin.verify).toHaveBeenCalledTimes(3);
  });

  it('isolates request, response and stored nested maps and arrays', async () => {
    const f = guideGoodsFixture(), input = f.input(), result = await f.replace(input);
    input.entries[0].rationale = 'REQUEST EDIT'; input.catalogue.units.push('ZZ');
    result.snapshot.entries[0].rationale = 'RESPONSE EDIT'; result.snapshot.catalogue.ubigeos.push('999999');
    const read = await f.read();
    expect(read.snapshot?.entries).toEqual(f.entries);
    expect(read.snapshot?.catalogue).toEqual(f.catalogue);
    read.snapshot!.entries.length = 0;
    expect(head(f).entries).toEqual(f.entries);
    await f.store.transaction(1, async tx => {
      const company = await tx.company(1), products = await tx.products([f.product.id]), policy = await tx.head(1);
      company!.ruc = '20000000010'; products[0].sku = 'READ EDIT'; policy!.entries.length = 0;
      expect(await tx.company(1)).toEqual(f.company);
      expect(await tx.products([f.product.id])).toEqual([f.product]);
      expect((await tx.head(1))?.entries).toEqual(f.entries);
    });
    expect(f.store.state.companies.get(1)).toEqual(f.company);
  });

  it('clones caller input before awaiting the store', async () => {
    const f = guideGoodsFixture(), input = f.input();
    f.store.onRead = action => {
      if (action === 'company') { input.entries[0].classification = 'REGULATED'; input.catalogue.units.length = 0; }
    };
    await f.replace(input);
    expect(head(f).entries).toEqual(f.entries);
    expect(head(f).catalogue).toEqual(f.catalogue);
  });

  it('recovers policy and matching after recreating the core against the same store', async () => {
    const f = await seeded(), restart = f.restart();
    expect((await restart.read(f.token, 1, f.context)).snapshot).toEqual(head(f));
    await expect((await restart.assertLocalGoods(f.binding, f.body)).fresh()).resolves.toBeUndefined();
  });

  it('keeps policies and revisions separate for two issuers sharing the same product master', async () => {
    const f = await seeded(), one = structuredClone(head(f));
    expect((await f.core.read(f.token, 2, f.context)).snapshot).toBeNull();
    await f.core.replace(f.token, 2, f.input(), f.context);
    expect(f.store.state.heads.get(2)).toMatchObject({ companyId: 2, issuerRuc: '20000000010', revision: 1, entries: f.entries });
    expect(head(f)).toEqual(one);
    expect(f.store.state.audits.map(a => [a.companyId, a.action])).toEqual([[1, 'REPLACE'], [2, 'READ'], [2, 'REPLACE']]);
  });

  it('requires a policy for the bound issuer even when another issuer enabled that shared product', async () => {
    const f = await seeded();
    f.binding.anchor.issuerId = 2; f.binding.anchor.issuerRuc = '20000000010';
    f.body.sender.ruc = f.body.recipient.ruc = '20000000010';
    await expect(f.match()).rejects.toMatchObject(error('GUIDE_GOODS_POLICY_REQUIRED'));
  });

  it('rejects RUC mismatches in the binding, sender and recipient', async () => {
    for (const target of ['binding', 'sender', 'recipient'] as const) {
      const f = await seeded();
      if (target === 'binding') f.binding.anchor.issuerRuc = '20000000010';
      else f.body[target].ruc = '20000000010';
      await expect(f.match()).rejects.toMatchObject(error('GUIDE_GOODS_ISSUER_MISMATCH'));
    }
  });
});

describe('GuideGoods real core: revisions, atomicity and authority freshness', () => {
  it('advances exactly once per successful replacement and rejects stale issuer or policy revisions', async () => {
    const f = await seeded();
    await expect(f.replace()).rejects.toMatchObject(error('GUIDE_GOODS_REVISION_CONFLICT'));
    await expect(f.replace(f.input(1, f.entries, 2))).rejects.toMatchObject(error('GUIDE_GOODS_ISSUER_REVISION_CONFLICT'));
    await f.replace(f.input(1));
    expect(head(f).revision).toBe(2);
    expect(f.store.state.audits.map(a => a.revision)).toEqual([1, 2]);
  });

  it('serializes simultaneous writers so only one expectedRevision wins', async () => {
    const f = guideGoodsFixture();
    const outcomes = await Promise.allSettled([f.replace(), f.replace()]);
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(r => r.status === 'rejected')).toMatchObject({ reason: error('GUIDE_GOODS_REVISION_CONFLICT') });
    expect(head(f).revision).toBe(1);
    expect(f.store.state.audits).toHaveLength(1);
    expect(f.store.transactions).toEqual([1, 1]);
  });

  it('enforces store CAS without replacing a committed head or adding an audit', async () => {
    const f = await seeded(), before = structuredClone(f.store.state);
    await expect(f.store.transaction(1, tx => tx.save({ ...head(f), revision: 2 }, 0)))
      .rejects.toThrow('SYNTHETIC_GUIDE_GOODS_CAS');
    expect(f.store.state).toEqual(before);
    await expect(f.store.transaction(2, tx => tx.save(head(f), 0))).rejects.toThrow('SYNTHETIC_GUIDE_GOODS_CAS');
    expect(f.store.state).toEqual(before);
  });

  it.each(['save', 'audit'] as const)('rolls back all staged state on %s failure and releases the serial queue', async action => {
    const f = await seeded(), before = structuredClone(f.store.state);
    f.store.onWrite = name => { if (name === action) throw new Error('SYNTHETIC_WRITE_FAILURE'); };
    await expect(f.replace(f.input(1))).rejects.toThrow('SYNTHETIC_WRITE_FAILURE');
    expect(f.store.state).toEqual(before);
    expect(f.store.rateCalls).toHaveLength(2);
    f.store.onWrite = undefined;
    await f.replace(f.input(1));
    expect(head(f).revision).toBe(2);
  });

  it('revalidates authority before reading any transaction state', async () => {
    const f = guideGoodsFixture();
    f.admin.verify.mockResolvedValueOnce(structuredClone(f.actor));
    f.actor.authRevision++;
    await expect(f.replace()).rejects.toMatchObject(error('GUIDE_GOODS_AUTHORITY_CHANGED'));
    expect(f.store.productCalls).toEqual([]);
    expect(f.store.writeCalls).toEqual([]);
    noCommit(f);
  });

  it.each(['save', 'audit'] as const)('rolls back if administrator proof changes after staged %s', async action => {
    const f = guideGoodsFixture();
    f.store.onWrite = name => { if (name === action) f.actor.authRevision++; };
    await expect(f.replace()).rejects.toMatchObject(error('GUIDE_GOODS_AUTHORITY_CHANGED'));
    noCommit(f);
  });

  it.each(['READ', 'REPLACE'] as const)('%s rolls back its audit if step-up is revoked at the commit boundary', async action => {
    const f = guideGoodsFixture();
    f.store.onWrite = name => { if (name === 'audit') f.actor.stepUpVerified = false as true; };
    await expect(action === 'READ' ? f.read() : f.replace()).rejects.toMatchObject(error('GUIDE_GOODS_ADMIN_REQUIRED', 403));
    noCommit(f);
  });

  it('compares the complete administrator proof, including actor and permissions, before commit', async () => {
    for (const change of [(f: Fixture) => { f.actor.id = guideUuid(82); },
      (f: Fixture) => { f.actor.permissions.push('other.permission'); }]) {
      const f = guideGoodsFixture();
      f.store.onWrite = action => { if (action === 'audit') change(f); };
      await expect(f.replace()).rejects.toMatchObject(error('GUIDE_GOODS_AUTHORITY_CHANGED'));
      noCommit(f);
    }
  });

  it('propagates verified authority errors and maps verifier outages without a commit', async () => {
    const f = guideGoodsFixture();
    f.admin.verify.mockRejectedValueOnce(new B2bSecurityError(401, 'SYNTHETIC_REVOKED'));
    await expect(f.replace()).rejects.toMatchObject(error('SYNTHETIC_REVOKED', 401));
    f.admin.verify.mockRejectedValueOnce(new Error('SYNTHETIC_UNAVAILABLE'));
    await expect(f.read()).rejects.toMatchObject(error('ADMIN_AUTHORITY_UNAVAILABLE', 503));
    expect(f.store.transactions).toEqual([]);
    noCommit(f);
  });
});

describe('GuideGoods real core: bounded trusted inputs', () => {
  it.each([
    ['step-up', { stepUpVerified: false }], ['global scope', { scope: 'ASSIGNED' }],
    ['setup permission', { permissions: ['series.manage'] }], ['series permission', { permissions: ['setup.manage'] }],
    ['actor UUID', { id: 'fictitious' }], ['auth revision', { authRevision: -1 }],
    ['unique permissions', { permissions: ['setup.manage', 'series.manage', 'setup.manage'] }],
  ])('requires a trusted proof with %s for both reads and replacements', async (_label, patch) => {
    const f = guideGoodsFixture();
    f.admin.verify.mockImplementation(async () => structuredClone({ ...f.actor, ...patch }) as typeof f.actor);
    await expect(f.read()).rejects.toMatchObject(error('GUIDE_GOODS_ADMIN_REQUIRED', 403));
    await expect(f.replace()).rejects.toMatchObject(error('GUIDE_GOODS_ADMIN_REQUIRED', 403));
    expect(f.store.transactions).toEqual([]);
    noCommit(f);
  });

  it('rejects extra authority claims and never executes accessor claims', async () => {
    const f = guideGoodsFixture(), getter = vi.fn(() => true);
    f.admin.verify.mockResolvedValue({ ...f.actor, officialValidation: true } as typeof f.actor);
    await expect(f.replace()).rejects.toMatchObject(invalid);
    f.admin.verify.mockResolvedValue(Object.defineProperty({ ...f.actor }, 'stepUpVerified', { enumerable: true, get: getter }));
    await expect(f.read()).rejects.toBeInstanceOf(B2bSecurityError);
    expect(getter).not.toHaveBeenCalled();
    noCommit(f);
  });

  it('rejects invalid company ids before rate limiting, verification or persistence', async () => {
    const f = guideGoodsFixture();
    for (const id of [0, -1, 1.5, NaN, Infinity, 2147483648, '1', null, undefined]) {
      await expect(f.core.read(f.token, id as number, f.context)).rejects.toMatchObject(invalid);
      await expect(f.core.replace(f.token, id as number, f.input(), f.context)).rejects.toMatchObject(invalid);
    }
    expect(f.store.rateCalls).toEqual([]); expect(f.admin.verify).not.toHaveBeenCalled();
    expect(f.store.transactions).toEqual([]);
  });

  it('bounds and validates request context before touching any port', async () => {
    const f = guideGoodsFixture();
    for (const context of [null, {}, { ...f.context, requestId: 'bad' },
      ...['', ' x', 'x\n', 'p'.repeat(257)].map(peer => ({ ...f.context, peer }))]) {
      await expect(f.core.read(f.token, 1, context as typeof f.context)).rejects.toMatchObject(invalid);
      await expect(f.core.replace(f.token, 1, f.input(), context as typeof f.context)).rejects.toMatchObject(invalid);
    }
    expect(f.store.rateCalls).toEqual([]); expect(f.admin.verify).not.toHaveBeenCalled();
  });

  it('rejects malformed tokens before invoking the authority', async () => {
    const f = guideGoodsFixture();
    for (const token of ['', 'Bearer fictitious', 'bad/token', 'x'.repeat(8193), null, 1]) {
      await expect(f.core.read(token as string, 1, f.context)).rejects.toMatchObject(error('INVALID_TOKEN', 401));
      await expect(f.core.replace(token as string, 1, f.input(), f.context)).rejects.toMatchObject(error('INVALID_TOKEN', 401));
    }
    expect(f.admin.verify).not.toHaveBeenCalled(); expect(f.store.transactions).toEqual([]);
  });

  it('rejects final LF in product units, master/entry UUIDs, entry hashes and administrator tokens', async () => {
    const f = guideGoodsFixture();
    for (const patch of [{ unitCode: 'NIU\n' }, { id: `${f.product.id}\n` }]) {
      expect(() => guideGoodsProductSha256({ ...f.product, ...patch }))
        .toThrowError(expect.objectContaining(error('GUIDE_GOODS_PRODUCT_INCONSISTENT')));
    }
    for (const patch of [{ productId: `${f.product.id}\n` }, { productSha256: `${f.entries[0].productSha256}\n` }]) {
      await expect(f.replace(f.input(0, [{ ...f.entries[0], ...patch }]))).rejects.toMatchObject(invalid);
    }
    const verified = f.admin.verify.mock.calls.length;
    await expect(f.core.read(`${f.token}\n`, 1, f.context)).rejects.toMatchObject(error('INVALID_TOKEN', 401));
    await expect(f.core.replace(`${f.token}\n`, 1, f.input(), f.context)).rejects.toMatchObject(error('INVALID_TOKEN', 401));
    expect(f.admin.verify).toHaveBeenCalledTimes(verified);
    expect(f.store.transactions).toEqual([]); noCommit(f);
  });

  it.each(['READ', 'REPLACE'] as const)('enforces the %s quota at the boundary, hashing peer and action independently', async action => {
    const f = guideGoodsFixture(), limit = action === 'READ' ? 300 : 30;
    const window = Math.floor(Date.parse(f.control.at) / 60000), key = sha(`guide-goods:${action}:${f.context.peer}`);
    f.store.rates.set(`${key}:${window}`, limit - 1);
    const run = () => action === 'READ' ? f.read() : f.replace();
    await run();
    const verified = f.admin.verify.mock.calls.length;
    await expect(run()).rejects.toMatchObject(error('RATE_LIMITED', 429));
    expect(f.admin.verify).toHaveBeenCalledTimes(verified);
    expect(f.store.rateCalls).toEqual([{ keySha256: key, window, limit }, { keySha256: key, window, limit }]);
    expect(JSON.stringify(f.store.rateCalls)).not.toContain(f.context.peer);
    f.control.at = '2026-10-22T15:01:00.000Z';
    if (action === 'READ') await f.read(); else await f.replace(f.input(1));
    expect(f.store.rateCalls.at(-1)?.window).toBe(window + 1);
  });

  it('fails closed for an invalid clock before ports run', async () => {
    const f = guideGoodsFixture(); f.control.at = 'not-a-timestamp';
    await expect(f.read()).rejects.toMatchObject(error('GUIDE_GOODS_CLOCK_INVALID', 503));
    await expect(f.replace()).rejects.toMatchObject(error('GUIDE_GOODS_CLOCK_INVALID', 503));
    expect(f.store.rateCalls).toEqual([]); expect(f.admin.verify).not.toHaveBeenCalled();
  });

  it('rejects nonobject replacement inputs with security errors', async () => {
    const f = guideGoodsFixture();
    for (const value of [null, false, 42, 'local', [], undefined]) {
      await expect(f.core.replace(f.token, 1, value, f.context)).rejects.toMatchObject(invalid);
    }
    expect(f.store.transactions).toEqual([]); noCommit(f);
  });

  it.each([
    ['extra top-level claim', (v: any) => { v.officialValidation = true; }],
    ['missing top-level field', (v: any) => { delete v.expectedIssuerRevision; }],
    ['exhausted revision', (v: any) => { v.expectedRevision = 2147483647; }],
    ['negative issuer revision', (v: any) => { v.expectedIssuerRevision = -1; }],
    ['duplicate product entries', (v: any) => { v.entries.push({ ...v.entries[0] }); }],
    ['invalid fingerprint', (v: any) => { v.entries[0].productSha256 = 'A'.repeat(64); }],
    ['implicit classification', (v: any) => { v.entries[0].classification = false; }],
    ['extra entry claim', (v: any) => { v.entries[0].nonRegulated = true; }],
  ])('rejects %s without a transaction', async (_label, mutate) => {
    const f = guideGoodsFixture(), input = f.input(); mutate(input);
    await expect(f.replace(input)).rejects.toMatchObject(invalid);
    expect(f.store.transactions).toEqual([]); noCommit(f);
  });

  it('rejects unsafe JSON, excessive nesting and oversized strings without executing accessors', async () => {
    const f = guideGoodsFixture(), getter = vi.fn(() => 0), cyclic: any = {}; cyclic.self = cyclic;
    let deep: any = {}; for (let i = 0; i < 66; i++) deep = { child: deep };
    const accessor = Object.defineProperty(f.input(), 'expectedRevision', { enumerable: true, get: getter });
    const proxy = new Proxy(f.input(), { get: getter });
    const oversized = f.input(0, Array.from({ length: 200 }, (_, i) => ({ ...f.entries[0],
      productId: guideUuid(1000 + i), rationale: 'x'.repeat(500) })));
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(128 * 1024);
    for (const input of [accessor, proxy, cyclic, deep, { ...f.input(), entries: 'x'.repeat(16385) },
      { ...f.input(), entries: [null] }, { ...f.input(), entries: new Array(1) }, oversized]) {
      await expect(f.replace(input)).rejects.toMatchObject(invalid);
    }
    expect(getter).not.toHaveBeenCalled(); expect(f.store.transactions).toEqual([]); noCommit(f);
  });

  it('bounds revisions, UUIDs, rationale and entry count', async () => {
    const f = guideGoodsFixture();
    for (const expectedRevision of [-1, 1.5, '0', null, 2147483648]) {
      await expect(f.replace({ ...f.input(), expectedRevision })).rejects.toMatchObject(invalid);
    }
    for (const rationale of ['', ' local', 'local\n', 'x'.repeat(501), '\ud800']) {
      await expect(f.replace(f.input(0, [{ ...f.entries[0], rationale }]))).rejects.toMatchObject(invalid);
    }
    await expect(f.replace(f.input(0, [{ ...f.entries[0], productId: 'not-a-uuid' }]))).rejects.toMatchObject(invalid);
    await expect(f.replace(f.input(0, Array.from({ length: 201 }, (_, i) => ({ ...f.entries[0], productId: guideUuid(1000 + i) })))))
      .rejects.toMatchObject(invalid);
    noCommit(f);
  });

  it('accepts 200 real product declarations and canonicalizes entry order', async () => {
    const f = guideGoodsFixture(), entries = [];
    for (let i = 0; i < 200; i++) {
      const product = { ...f.product, id: guideUuid(1000 + i), sku: `FICTIONAL-${i}` };
      f.store.state.products.set(product.id, product);
      entries.push({ ...f.entries[0], productId: product.id, productSha256: guideGoodsProductSha256(product),
        rationale: i === 0 ? 'x'.repeat(500) : f.entries[0].rationale });
    }
    await f.replace(f.input(0, [...entries].reverse()));
    expect(head(f).entries).toEqual(entries);
    expect((await f.read()).stale).toBe(false);
    expect(f.store.productCalls[0]).toEqual(entries.map(e => e.productId));
  });
});

describe('GuideGoods real core: reference catalogue boundary', () => {
  it.each([
    ['tampered hash', (v: any) => { v.sha256 = '0'.repeat(64); }],
    ['credential URL', (v: any) => { v.sourceUrl = 'https://user:secret@cpe.sunat.gob.pe/node/116'; reseal(v); }],
    ['official status', (v: any) => { v.referenceStatus = 'OFFICIAL'; reseal(v); }],
    ['extra official flag', (v: any) => { v.officialValidation = true; reseal(v); }],
  ])('rejects a catalogue with %s before writing policy', async (_label, mutate) => {
    const f = guideGoodsFixture(), input = f.input(); mutate(input.catalogue);
    await expect(f.replace(input)).rejects.toMatchObject(error('INVALID_GUIDE_REFERENCE_CATALOGUE', 400));
    expect(f.store.transactions).toEqual([]); noCommit(f);
  });

  it('refuses to reuse a catalogue version for a different sealed bundle', async () => {
    const f = await seeded(), input = f.input(1), before = structuredClone(f.store.state);
    input.catalogue.sourceSha256 = 'b'.repeat(64); reseal(input.catalogue);
    await expect(f.replace(input)).rejects.toMatchObject(error('GUIDE_GOODS_CATALOGUE_VERSION_CONFLICT'));
    expect(f.store.state).toEqual(before);
  });

  it('accepts an explicit new reference version without elevating its local status', async () => {
    const f = await seeded(), input = f.input(1);
    input.catalogue.version = 'fictional-reference-v2'; input.catalogue.sourceSha256 = 'b'.repeat(64); reseal(input.catalogue);
    await f.replace(input);
    expect(head(f).catalogue).toEqual(input.catalogue);
    expect(head(f).source).toBe('ADMIN_LOCAL_CONFIGURATION');
    expect((await f.read()).stale).toBe(false);
  });

  it('requires each declared master unit to exist in the configured catalogue', async () => {
    const f = guideGoodsFixture(), product = { ...f.product, unitCode: 'ZZ' };
    f.store.state.products.set(product.id, product);
    await expect(f.replace(f.input(0, [{ ...f.entries[0], productSha256: guideGoodsProductSha256(product) }])))
      .rejects.toMatchObject(error('GUIDE_REFERENCE_CODE_NOT_ENABLED'));
    noCommit(f);
  });
});

describe('GuideGoods real core: current shared master and fail-closed snapshots', () => {
  const mutations: [string, Partial<GuideGoodsProduct>][] = [
    ['sku', { sku: 'ITEM-EDITADO' }], ['description', { description: 'BIEN EDITADO' }],
    ['category', { category: 'OTRA CATEGORIA' }], ['unit', { unitCode: 'ZZ' }],
    ['SUNAT code', { sunatProductCode: 'FICTICIO' }], ['deactivation', { active: false }],
    ['updatedAt', { updatedAt: '2026-10-22T14:01:00.000Z' }],
  ];
  it.each(mutations)('invalidates the declaration after a master %s change', async (_label, patch) => {
    const f = await seeded(), old = structuredClone(head(f));
    const product = { ...f.product, ...patch }; f.store.state.products.set(product.id, product);
    expect(guideGoodsProductSha256(product)).not.toBe(f.entries[0].productSha256);
    expect((await f.read()).stale).toBe(true);
    await expect(f.match()).rejects.toMatchObject(error('GUIDE_GOODS_PRODUCT_CHANGED'));
    await expect(f.replace(f.input(1))).rejects.toMatchObject(error('GUIDE_GOODS_PRODUCT_CHANGED'));
    expect(head(f)).toEqual(old);
    expect(f.store.state.audits.map(a => a.action)).toEqual(['REPLACE', 'READ']);
  });

  it('detects a deleted master row on read, match and replace', async () => {
    const f = await seeded(); f.store.state.products.delete(f.product.id);
    expect((await f.read()).stale).toBe(true);
    await expect(f.match()).rejects.toMatchObject(error('GUIDE_GOODS_PRODUCT_CHANGED'));
    await expect(f.replace(f.input(1))).rejects.toMatchObject(error('GUIDE_GOODS_PRODUCT_CHANGED'));
  });

  it('rejects duplicate, unrelated or nonobject rows returned by persistence', async () => {
    for (const transform of [(rows: GuideGoodsProduct[]) => [...rows, ...rows],
      (rows: GuideGoodsProduct[]) => [...rows, { ...rows[0], id: guideUuid(99) }],
      () => [null as unknown as GuideGoodsProduct]]) {
      const f = await seeded(); f.store.productsOverride = transform;
      await expect(f.read()).rejects.toMatchObject(error('GUIDE_GOODS_PRODUCT_INCONSISTENT'));
      await expect(f.match()).rejects.toMatchObject(error('GUIDE_GOODS_PRODUCT_INCONSISTENT'));
      await expect(f.replace(f.input(1))).rejects.toMatchObject(error('GUIDE_GOODS_PRODUCT_INCONSISTENT'));
      expect(f.store.state.audits).toHaveLength(1);
    }
  });

  it('rejects malformed master metadata rather than hashing an invented ownership or authority field', async () => {
    for (const patch of [{ companyId: 1 }, { sku: '' }, { updatedAt: '2026-10-22' }, { sunatProductCode: 42 }]) {
      const f = guideGoodsFixture(), product = { ...f.product, ...patch };
      expect(() => guideGoodsProductSha256(product)).toThrow(B2bSecurityError);
      f.store.state.products.set(f.product.id, product as GuideGoodsProduct);
      await expect(f.replace()).rejects.toMatchObject(error('GUIDE_GOODS_PRODUCT_INCONSISTENT'));
      noCommit(f);
    }
  });

  it.each(['revision', 'RUC'] as const)('marks the policy stale after an issuer %s change', async field => {
    const f = await seeded(), company = f.store.state.companies.get(1)!;
    if (field === 'revision') company.configVersion++;
    else { company.ruc = '20000000010'; f.binding.anchor.issuerRuc = company.ruc; f.body.sender.ruc = f.body.recipient.ruc = company.ruc; }
    expect((await f.read()).stale).toBe(true);
    await expect(f.match()).rejects.toMatchObject(error('GUIDE_GOODS_POLICY_STALE'));
  });

  it('refuses missing, inactive, inconsistent and non-BETA issuers', async () => {
    for (const patch of [null, { active: false }, { environment: 'PRODUCTION' }, { id: 2 }, { configVersion: 0 }, { ruc: 'invalid' }]) {
      const f = guideGoodsFixture();
      if (patch === null) f.store.state.companies.delete(1);
      else Object.assign(f.store.state.companies.get(1)!, patch);
      const expected = patch?.ruc ? error('GUIDE_GOODS_ISSUER_INCONSISTENT') : error('GUIDE_GOODS_ISSUER_NOT_FOUND', 404);
      await expect(f.read()).rejects.toMatchObject(expected);
      await expect(f.replace()).rejects.toMatchObject(expected);
      await expect(f.match()).rejects.toMatchObject(expected);
      noCommit(f);
    }
  });

  const corruptions: [string, (p: GuideGoodsSnapshot) => void][] = [
    ['hash', p => { p.sha256 = '0'.repeat(64); }],
    ['company', p => { p.companyId = 2; reseal(p); }],
    ['source', p => { (p as any).source = 'OFFICIAL'; reseal(p); }],
    ['schema', p => { (p as any).schemaVersion = 'unknown'; reseal(p); }],
    ['catalogue', p => { p.catalogue.sourceSha256 = 'b'.repeat(64); reseal(p); }],
    ['duplicate entries', p => { p.entries.push({ ...p.entries[0] }); reseal(p); }],
    ['extra credentials', p => { (p as any).token = 'fictitious-forbidden-claim'; reseal(p); }],
  ];
  it.each(corruptions)('rejects a stored snapshot with corrupt %s on read, match and replace', async (_label, corrupt) => {
    const f = await seeded(); corrupt(head(f)); const before = structuredClone(f.store.state);
    await expect(f.read()).rejects.toMatchObject(error('GUIDE_GOODS_POLICY_INCONSISTENT'));
    await expect(f.match()).rejects.toMatchObject(error('GUIDE_GOODS_POLICY_INCONSISTENT'));
    await expect(f.replace(f.input(1))).rejects.toMatchObject(error('GUIDE_GOODS_POLICY_INCONSISTENT'));
    expect(f.store.state).toEqual(before);
  });

  it('rejects a resealed but noncanonical entry order', async () => {
    const f = guideGoodsFixture(), product = { ...f.product, id: guideUuid(51), sku: 'ITEM-FICTICIO-2' };
    f.store.state.products.set(product.id, product);
    await f.replace(f.input(0, [...f.entries, { ...f.entries[0], productId: product.id, productSha256: guideGoodsProductSha256(product) }]));
    head(f).entries.reverse(); reseal(head(f));
    await expect(f.read()).rejects.toMatchObject(error('GUIDE_GOODS_POLICY_INCONSISTENT'));
  });

  it('withdraws eligibility atomically with an explicit empty replacement, including a stale product', async () => {
    const f = await seeded(); f.store.state.products.get(f.product.id)!.active = false;
    await f.replace(f.input(1, []));
    expect(head(f)).toMatchObject({ revision: 2, entries: [] });
    expect((await f.read()).stale).toBe(false);
    await expect(f.match()).rejects.toMatchObject(error('GUIDE_GOODS_ITEM_MISMATCH'));
    expect(f.store.state.audits.filter(a => a.action === 'REPLACE').map(a => a.revision)).toEqual([1, 2]);
  });
});

describe('GuideGoods real core: explicit classification, item identity and fresh closures', () => {
  it('accepts only the explicit NON_REGULATED declaration and returns an internal fresh closure', async () => {
    const f = await seeded(), proof = await f.match();
    expect(Object.keys(proof)).toEqual(['fresh']);
    expect(JSON.stringify(proof)).toBe('{}');
    await expect(proof.fresh()).resolves.toBeUndefined();
    expect(f.store.state.audits).toHaveLength(1);
    expect(f.admin.verify).toHaveBeenCalledTimes(3);
  });

  it.each(['REGULATED', 'UNKNOWN'] as const)('does not let regulatedGoods:false override policy %s', async classification => {
    const f = guideGoodsFixture();
    await f.replace(f.input(0, [{ ...f.entries[0], classification }]));
    expect(f.body.regulatedGoods).toBe(false);
    expect((await f.read()).stale).toBe(false);
    await expect(f.match()).rejects.toMatchObject(error('GUIDE_GOODS_CLASSIFICATION_NOT_ENABLED'));
  });

  it.each([
    ['free item', (b: GuideBody) => { b.items[0].code = 'ITEM-LIBRE'; }],
    ['description', (b: GuideBody) => { b.items[0].description = 'OTRO BIEN'; }],
    ['unit', (b: GuideBody) => { b.items[0].unitCode = 'ZZ'; }],
    ['duplicate SKU', (b: GuideBody) => { b.items.push({ ...b.items[0] }); }],
  ])('rejects an item with mismatched %s', async (label, mutate) => {
    const f = await seeded();
    // Enable ZZ in the reference solely to reach the master/item unit comparison.
    if (label === 'unit') { const input = f.input(1); input.catalogue.version = 'fictional-v2'; input.catalogue.units.push('ZZ'); reseal(input.catalogue); await f.replace(input); }
    mutate(f.body);
    await expect(f.match()).rejects.toMatchObject(error('GUIDE_GOODS_ITEM_MISMATCH'));
  });

  it('rejects an ambiguous shared-master SKU even when each product has a valid declaration', async () => {
    const f = guideGoodsFixture(), second = { ...f.product, id: guideUuid(51) };
    f.store.state.products.set(second.id, second);
    await f.replace(f.input(0, [...f.entries, { ...f.entries[0], productId: second.id, productSha256: guideGoodsProductSha256(second) }]));
    await expect(f.match()).rejects.toMatchObject(error('GUIDE_GOODS_ITEM_MISMATCH'));
  });

  it.each([
    ['reason', (b: GuideBody) => { b.reasonCode = '01'; }],
    ['transport', (b: GuideBody) => { (b.transport as any).mode = '01'; }],
    ['regulated flag', (b: GuideBody) => { b.regulatedGoods = true; }],
    ['references', (b: GuideBody) => { b.references = [{ type: '01', issuerRuc: b.sender.ruc, series: 'F001', number: '1' }]; }],
  ])('rejects a profile with unsupported %s', async (_label, mutate) => {
    const f = await seeded(); mutate(f.body);
    await expect(f.match()).rejects.toMatchObject(error('GUIDE_GOODS_PROFILE_NOT_ENABLED'));
  });

  it.each(['origin', 'destination', 'weight'] as const)('enforces enabled reference codes for %s', async field => {
    const f = await seeded();
    if (field === 'weight') f.body.weightUnit = 'LBR' as 'KGM'; else f.body[field].ubigeo = '999999';
    await expect(f.match()).rejects.toMatchObject(error('GUIDE_REFERENCE_CODE_NOT_ENABLED'));
  });

  it('rejects invalid or type-31 bindings before starting a matching transaction', async () => {
    const f = guideGoodsFixture();
    for (const binding of [null, false, 42, [], {}, { ...f.binding, guideType: '31' }, { ...f.binding, officialValidation: true }]) {
      await expect(f.core.assertLocalGoods(binding as typeof f.binding, f.body)).rejects.toMatchObject(invalid);
    }
    expect(f.store.transactions).toEqual([]);
  });

  it('rejects nonobject matching bodies, including null, with status 400 before a transaction', async () => {
    const f = await seeded(), before = f.store.transactions.length;
    for (const value of [null, false, 42, 'not-a-body', []]) {
      await expect(f.core.assertLocalGoods(f.binding, value as unknown as GuideBody)).rejects.toMatchObject(invalid);
    }
    expect(f.store.transactions).toHaveLength(before);
    expect(f.store.state.audits).toHaveLength(1);
  });

  it('notices a replacement even if product and effective classification stay the same', async () => {
    const f = await seeded(), proof = await f.match();
    await f.replace(f.input(1));
    await expect(proof.fresh()).rejects.toMatchObject(error('GUIDE_GOODS_POLICY_CHANGED'));
  });

  it.each([
    ['issuer revision', (s: GuideGoodsState) => { s.companies.get(1)!.configVersion++; }, 'GUIDE_GOODS_POLICY_STALE'],
    ['product edit', (s: GuideGoodsState) => { s.products.values().next().value!.description = 'BIEN EDITADO'; }, 'GUIDE_GOODS_PRODUCT_CHANGED'],
    ['withdrawn policy', (s: GuideGoodsState) => { s.heads.delete(1); }, 'GUIDE_GOODS_POLICY_REQUIRED'],
  ] as const)('fresh rechecks %s instead of caching an approval', async (_label, mutate, code) => {
    const f = await seeded(), proof = await f.match(); mutate(f.store.state);
    await expect(proof.fresh()).rejects.toMatchObject(error(code));
  });

  it('captures cloned binding and body, and still checks current policy on every fresh call', async () => {
    const f = await seeded(), proof = await f.match();
    f.binding.anchor.issuerId = 2; f.body.items[0].description = 'CALLER EDIT';
    await expect(proof.fresh()).resolves.toBeUndefined();
    await expect(proof.fresh()).resolves.toBeUndefined();
    f.store.state.products.get(f.product.id)!.active = false;
    await expect(proof.fresh()).rejects.toMatchObject(error('GUIDE_GOODS_PRODUCT_CHANGED'));
  });
});
