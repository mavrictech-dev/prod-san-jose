import { describe, expect, it, vi } from 'vitest';
import type { FiscalDocumentSnapshot } from '../packages/contracts/src/events';
import { calculateDocumentTotals } from '../packages/sunat-core/src/tax';
import {
  buildFiscalNoteSnapshot, fiscalSnapshotSha256, type FiscalNoteContext,
} from '../packages/sunat-core/src/fiscal-note';
import { projectFiscalFinancialLedger, type FiscalLedgerEntry } from '../packages/sunat-core/src/fiscal-financial-ledger';
import {
  validateFinancialLedgerPlan, type FinancialLedgerPlan,
} from '../services/billing-service/src/application/financial-ledger-plan';

// Entirely fictitious in-memory identities and evidence assertions. No stored
// business data, certificates, credentials, DB, transport or wall clock.
const RUC = '20000000001';
const uuid = (n: number) => `abcdefab-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ERROR = 'Plan de persistencia financiera inválido';
const SENTINEL = 'VALOR_FICTICIO_QUE_NO_DEBE_FILTRARSE';
type Mutable<T> = T extends readonly (infer U)[] ? Mutable<U>[] : T extends object
  ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
const clone = <T>(value: T): Mutable<T> => structuredClone(value) as Mutable<T>;

function document(n = 1, type: '01' | '03' = '01'): FiscalDocumentSnapshot {
  const series = type === '01' ? 'F001' : 'B001';
  return {
    documentId: uuid(n), companyId: 1, branchId: uuid(500), environment: 'BETA', documentTypeCode: type,
    series, number: String(n), fullNumber: `${series}-${n}`, issueDate: '2026-10-02T16:00:00Z',
    currencyCode: 'PEN', operationTypeCode: '0101',
    ...(type === '01' ? { paymentTerms: { type: 'CONTADO' as const } } : {}),
    issuer: { identityType: '6', identityNumber: RUC, legalName: 'EMISOR FICTICIO',
      address: 'DIRECCION FICTICIA', ubigeo: '150101', establishmentCode: '0000' },
    customer: { identityType: '6', identityNumber: RUC, legalName: 'CLIENTE FICTICIO' },
    ...calculateDocumentTotals([{ productCode: 'FICTICIO', description: 'BIEN FICTICIO', unitCode: 'NIU',
      quantity: '3', unitPriceWithTax: '118', taxAffectationCode: '10', igvRate: '18' }]),
  };
}

function fixture(count = 1): Mutable<FinancialLedgerPlan> {
  const documents = Array.from({ length: count }, (_, i) => document(i + 1, i % 2 ? '03' : '01'));
  return {
    planId: uuid(9000),
    input: { scope: { issuerRuc: RUC, companyId: 1, branchId: uuid(500), environment: 'BETA' }, documents, entries: [] },
    expectedHeads: documents.map(doc => ({ documentId: doc.documentId, revision: 0, sequence: 0, versionSha256: null })),
  };
}

function appendCredit(plan: Mutable<FinancialLedgerPlan>, index = 0, verified = true): void {
  const original = plan.input.documents[index];
  const previous = projectFiscalFinancialLedger(plan.input);
  if (!previous.ok) throw new Error('Fixture ficticio bloqueado');
  const head = previous.documents.find(doc => doc.documentId === original.documentId)!;
  const noteContext: FiscalNoteContext = {
    original,
    acceptance: {
      environment: 'BETA', issuerRuc: RUC, documentId: original.documentId,
      documentTypeCode: original.documentTypeCode as '01' | '03', fullNumber: original.fullNumber,
      snapshotSha256: fiscalSnapshotSha256(original), cdrSha256: 'a'.repeat(64),
      status: 'ACCEPTED', responseCode: '0', acceptedAt: '2026-10-02T16:10:00Z',
      source: original.documentTypeCode === '01' ? { kind: 'CDR_DOCUMENT' } : {
        kind: 'CDR_SUMMARY', identifier: 'RC-20261002-1', referenceDate: '2026-10-02', lineNumber: 1, conditionCode: '1',
      },
    },
    asOf: '2026-10-04T18:00:00Z', creditHistory: { complete: true, entries: [] },
  };
  const entry: FiscalLedgerEntry = {
    ...plan.input.scope, eventId: uuid(1000 + index), operationId: uuid(2000 + index), documentId: original.documentId,
    sequence: head.lastSequence + 1, expectedPreviousSha256: head.currentVersion.sha256, kind: 'NOTE_CREDIT', noteContext,
    nextSnapshot: buildFiscalNoteSnapshot(noteContext, {
      documentTypeCode: '07', reasonCode: '07', reasonDescription: 'DEVOLUCION FICTICIA',
      lines: [{ originalLineNumber: 1, quantity: '1' }],
    }, { documentId: uuid(3000 + index), series: original.documentTypeCode === '01' ? 'FN01' : 'BN01',
      number: String(index + 1), issueDate: '2026-10-02T17:00:00Z' }),
    evidence: { status: 'ACCEPTED', cdrSignatureVerified: verified, officialCdr: verified,
      cdrSha256: 'b'.repeat(64), requestSha256: 'c'.repeat(64), responseCode: '0', acceptedAt: '2026-10-03T18:00:00Z' },
  };
  plan.input.entries.push(entry);
}

function rejects(value: unknown): void {
  let caught: unknown;
  try { validateFinancialLedgerPlan(value); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  const error = caught as Error;
  expect(error.message).toBe(ERROR);
  expect(error.stack).toBeUndefined();
  expect(Object.getOwnPropertyNames(error)).toEqual(['message']);
  expect(JSON.stringify(error)).toBe('{}');
  expect(String(error)).not.toContain(SENTINEL);
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

function expectDeepFrozen(value: unknown, seen = new WeakSet<object>()): void {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    expect(Object.isFrozen(value)).toBe(true);
    Object.values(value).forEach(child => expectDeepFrozen(child, seen));
  }
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)]));
  return value;
}

describe('server-only candidate financial persistence plan', () => {
  it('returns detached input, the pure successful projection and server-computed hashes', () => {
    const plan = fixture(), before = clone(plan);
    const result = validateFinancialLedgerPlan(plan);
    expect(Object.keys(result).sort()).toEqual(['inputSha256', 'plan', 'planSha256', 'projection']);
    expect(result.plan).toEqual(before);
    expect(result.plan).not.toBe(plan);
    expect(result.plan.input).not.toBe(plan.input);
    expect(result.plan.input.documents[0]).not.toBe(plan.input.documents[0]);
    expect(result.plan.expectedHeads[0]).not.toBe(plan.expectedHeads[0]);
    expect(Object.isFrozen(plan)).toBe(false);
    expect(Object.isFrozen(plan.input.documents[0])).toBe(false);
    expect(Object.isFrozen(plan.expectedHeads[0])).toBe(false);
    expect(result.projection).toEqual(projectFiscalFinancialLedger(before.input));
    expect(result.inputSha256).toBe(fiscalSnapshotSha256(before.input));
    expect(result.planSha256).toBe(fiscalSnapshotSha256(before));
    expect(result.inputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.planSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(plan).toEqual(before);
    plan.input.documents[0].issuer.legalName = 'OTRO EMISOR FICTICIO';
    plan.expectedHeads[0].revision = 10;
    expect(result.plan).toEqual(before);
  });

  it('deep-freezes the detached result and every nested plan value to preserve hashes across awaits', async () => {
    const plan = fixture(2); appendCredit(plan, 0); appendCredit(plan, 1);
    plan.input.reservations = [];
    const result = validateFinancialLedgerPlan(plan), before = clone(result);
    expectDeepFrozen(result);

    await Promise.resolve();
    plan.planId = uuid(9001);
    plan.input.documents[0].issuer.legalName = 'CAMBIO FICTICIO TRAS AWAIT';
    plan.input.entries[0].evidence.cdrSha256 = 'f'.repeat(64);
    plan.expectedHeads[0].revision = 10;
    expect(result).toEqual(before);

    expect(Reflect.set(result, 'plan', fixture())).toBe(false);
    expect(Reflect.set(result, 'projection', {})).toBe(false);
    expect(Reflect.set(result, 'inputSha256', 'f'.repeat(64))).toBe(false);
    expect(Reflect.set(result, 'planSha256', 'f'.repeat(64))).toBe(false);
    expect(Reflect.set(result.plan, 'planId', uuid(9002))).toBe(false);
    expect(Reflect.deleteProperty(result.plan, 'input')).toBe(false);
    expect(Reflect.set(result.plan.expectedHeads[0], 'revision', 10)).toBe(false);
    expect(Reflect.set(result.plan.input.scope, 'companyId', 2)).toBe(false);
    expect(Reflect.set(result.plan.input.documents[0].totals, 'payableAmount', '0.00')).toBe(false);
    expect(Reflect.set(result.plan.input.documents[0].lines[0], 'quantity', '0')).toBe(false);
    expect(Reflect.set(result.plan.input.entries[0].evidence, 'cdrSha256', 'f'.repeat(64))).toBe(false);
    expect(() => result.plan.expectedHeads.push({ documentId: uuid(999), revision: 0, sequence: 0, versionSha256: null })).toThrow(TypeError);
    expect(() => Object.defineProperty(result.plan, 'extra', { value: true })).toThrow(TypeError);
    expect(() => Object.setPrototypeOf(result.plan, {})).toThrow(TypeError);
    expect(result).toEqual(before);
    expect(fiscalSnapshotSha256(result.plan.input)).toBe(result.inputSha256);
    expect(fiscalSnapshotSha256(result.plan)).toBe(result.planSha256);
  });

  it('replays interleaved multi-document entries with independent sequences and exactly one checkpoint each', () => {
    const plan = fixture(2);
    appendCredit(plan, 1); appendCredit(plan, 0);
    plan.expectedHeads.reverse();
    const result = validateFinancialLedgerPlan(plan);
    expect(result.projection.documents.map(doc => [doc.documentId, doc.lastSequence, doc.currentVersion.revision]))
      .toEqual([[uuid(1), 1, 1], [uuid(2), 1, 1]]);
    expect(result.projection.entries.map(entry => entry.documentId)).toEqual([uuid(2), uuid(1)]);
    expect(result.plan.expectedHeads).toEqual(plan.expectedHeads);
  });

  it('projects RC members sharing parent event/operation IDs independently and deduplicates each member replay', () => {
    const plan = fixture(2);
    plan.input.documents = [document(1, '03'), document(2, '03')];
    const base = projectFiscalFinancialLedger(plan.input);
    if (!base.ok) throw new Error('Fixture ficticio bloqueado');
    plan.input.entries = plan.input.documents.map((original, index): FiscalLedgerEntry => ({
      ...plan.input.scope, eventId: uuid(1000), operationId: uuid(2000), documentId: original.documentId,
      sequence: 1, expectedPreviousSha256: base.documents[index].currentVersion.sha256, kind: 'RC_REPLACE',
      nextSnapshot: { ...original,
        ...calculateDocumentTotals(original.lines.map(line => ({ ...line, unitPriceWithTax: '59' }))) },
      evidence: { status: 'ACCEPTED', cdrSignatureVerified: true, officialCdr: true,
        cdrSha256: 'b'.repeat(64), requestSha256: 'c'.repeat(64), responseCode: '0', acceptedAt: '2026-10-03T18:00:00Z' },
    }));
    plan.input.entries.push(...clone(plan.input.entries));
    const result = validateFinancialLedgerPlan(plan);
    expect(result.projection.entries.map(entry => entry.outcome)).toEqual(['APPLIED', 'APPLIED', 'DUPLICATE', 'DUPLICATE']);
    expect(result.projection.documents.map(doc => [doc.documentId, doc.lastSequence, doc.currentVersion.revision, doc.versions.length]))
      .toEqual([[uuid(1), 1, 1, 2], [uuid(2), 1, 1, 2]]);
    expect(result.projection.documents.map(doc => doc.financialSnapshot.totals.payableAmount)).toEqual(['177.00', '177.00']);
    expect(validateFinancialLedgerPlan(plan)).toEqual(result);
    expectDeepFrozen(result);
  });

  it('is deterministic across retries and JSON key order, with frozen caller input and no clock or network calls', () => {
    const plan = fixture(2); appendCredit(plan);
    const input = freeze(plan), before = JSON.stringify(input);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error(SENTINEL); });
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error(SENTINEL); });
    try {
      const first = validateFinancialLedgerPlan(input);
      expect(validateFinancialLedgerPlan(input)).toEqual(first);
      expect(validateFinancialLedgerPlan(reverseKeys(input))).toEqual(first);
      expect(JSON.stringify(input)).toBe(before);
      expect(clock).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); network.mockRestore(); }
  });

  it('hashes plan identity, every checkpoint field and input while keeping input hash independent of checkpoints', () => {
    const plan = fixture(), first = validateFinancialLedgerPlan(plan);
    const changes: Array<(next: Mutable<FinancialLedgerPlan>) => void> = [
      next => { next.planId = uuid(9001); },
      next => { next.expectedHeads[0].versionSha256 = 'a'.repeat(64); },
      next => { Object.assign(next.expectedHeads[0], { revision: 4, sequence: 9, versionSha256: 'a'.repeat(64) }); },
    ];
    for (const change of changes) {
      const next = clone(plan); change(next);
      const result = validateFinancialLedgerPlan(next);
      expect(result.inputSha256).toBe(first.inputSha256);
      expect(result.planSha256).not.toBe(first.planSha256);
    }
    const next = clone(plan); next.input.documents[0].issuer.legalName = 'OTRO EMISOR FICTICIO';
    const result = validateFinancialLedgerPlan(next);
    expect(result.inputSha256).not.toBe(first.inputSha256);
    expect(result.planSha256).not.toBe(first.planSha256);
  });

  it.each([true, false])('evidence assertions verified=%s remain a simulation with no authenticity or transmission authority', verified => {
    const plan = fixture(); appendCredit(plan, 0, verified);
    const result = validateFinancialLedgerPlan(plan);
    expect(result.projection).toMatchObject({ ok: true, simulationOnly: true, evidenceAuthenticityVerified: false,
      persisted: false, transmissionAuthorized: false, reservationsReleased: false });
    expect(result.projection.entries[0].outcome).toBe(verified ? 'APPLIED' : 'EVIDENCE_UNVERIFIED');
  });

  it.each([
    { revision: 0, sequence: 0, versionSha256: null },
    { revision: 0, sequence: 0, versionSha256: 'a'.repeat(64) },
    { revision: 0, sequence: 5, versionSha256: 'b'.repeat(64) },
    { revision: 3, sequence: 7, versionSha256: 'c'.repeat(64) },
    { revision: Number.MAX_SAFE_INTEGER, sequence: Number.MAX_SAFE_INTEGER, versionSha256: 'd'.repeat(64) },
  ])('accepts the structural checkpoint %# without comparing it with a projected or stored head', checkpoint => {
    const plan = fixture(); Object.assign(plan.expectedHeads[0], checkpoint);
    expect(validateFinancialLedgerPlan(plan).plan.expectedHeads[0]).toEqual({ documentId: uuid(1), ...checkpoint });
  });

  it.each([
    { revision: 1, sequence: 0, versionSha256: null }, { revision: 0, sequence: 1, versionSha256: null },
    { revision: -1 }, { sequence: -1 }, { revision: 0.5 }, { sequence: 0.5 },
    { revision: '0' }, { sequence: null }, { revision: true }, { sequence: {} },
    { revision: Number.MAX_SAFE_INTEGER + 1 }, { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { versionSha256: '' }, { versionSha256: 'A'.repeat(64) }, { versionSha256: 'g'.repeat(64) },
    { versionSha256: 'a'.repeat(63) }, { versionSha256: 'a'.repeat(65) }, { versionSha256: 0 },
    { versionSha256: false }, { documentId: uuid(1).toUpperCase() }, { documentId: 'invalid' },
    { documentId: null }, { documentId: `${uuid(1)} ` },
  ])('rejects malformed checkpoint values %#', changes => {
    const plan = fixture(); Object.assign(plan.expectedHeads[0], changes); rejects(plan);
  });

  it.each(['planId', 'input', 'expectedHeads'] as const)('requires root key %s', key => {
    const plan: Record<string, unknown> = fixture(); delete plan[key]; rejects(plan);
  });

  it.each(['documentId', 'revision', 'sequence', 'versionSha256'] as const)('requires checkpoint key %s', key => {
    const plan = fixture(), head = plan.expectedHeads[0] as Record<string, unknown>; delete head[key]; rejects(plan);
  });

  it.each([null, false, 0, 'json', [], {}, undefined])('rejects non-plan roots %#', value => { rejects(value); });

  it.each([uuid(9000).toUpperCase(), 'invalid', `${uuid(9000)} `, null, 9000, {}])('requires a lowercase UUID planId %#', planId => {
    rejects({ ...fixture(), planId });
  });

  it.each(['inputSha256', 'planSha256', 'simulationOnly', 'evidenceAuthenticityVerified', 'transmissionAuthorized', 'extra'])
  ('rejects extra root key %s, including caller hashes and authorization flags', key => {
    rejects({ ...fixture(), [key]: true });
  });

  it('rejects extra head keys, malformed head containers and non-object head members', () => {
    const plan = fixture(); Object.assign(plan.expectedHeads[0], { extra: SENTINEL }); rejects(plan);
    for (const expectedHeads of [null, {}, 'heads', [null], [[]], [false], [0]]) rejects({ ...fixture(), expectedHeads });
  });

  it('rejects missing, foreign or duplicate heads and duplicate input documents', () => {
    const plan = fixture(2);
    rejects({ ...plan, expectedHeads: [] });
    rejects({ ...plan, expectedHeads: plan.expectedHeads.slice(0, 1) });
    const foreign = clone(plan); foreign.expectedHeads[1].documentId = uuid(999); rejects(foreign);
    const duplicate = clone(plan); duplicate.expectedHeads[1] = clone(duplicate.expectedHeads[0]); rejects(duplicate);
    const additional = clone(plan); additional.expectedHeads.push({ documentId: uuid(999), revision: 0, sequence: 0, versionSha256: null }); rejects(additional);
    const documents = clone(plan); documents.input.documents[1] = clone(documents.input.documents[0]); rejects(documents);
  });

  it('accepts exactly 100 documents/heads and rejects the 101st', () => {
    const plan = fixture(100), result = validateFinancialLedgerPlan(plan);
    expect(result.plan.expectedHeads).toHaveLength(100);
    expect(result.projection.documents).toHaveLength(100);
    rejects(fixture(101));
    plan.expectedHeads.push({ documentId: uuid(101), revision: 0, sequence: 0, versionSha256: null }); rejects(plan);
  });

  it('rejects invalid or blocked projections instead of returning partial state', () => {
    const plan = fixture(); appendCredit(plan);
    const stale = clone(plan); stale.input.entries[0].expectedPreviousSha256 = 'f'.repeat(64); rejects(stale);
    const gap = clone(plan); gap.input.entries[0].sequence = 2; rejects(gap);
    const badTotals = fixture(); badTotals.input.documents[0].totals.payableAmount = '1.00'; rejects(badTotals);
    const production = fixture(); Object.assign(production.input.scope, { environment: 'PRODUCTION' }); rejects(production);
    rejects(fixture(0));
    for (const input of [null, false, [], {}, { documents: [] }]) rejects({ ...fixture(), input });
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n, Symbol('ficticio'), () => SENTINEL,
    new Date('2026-10-02T16:00:00Z'), Buffer.from('FICTICIO'), new Map(), new Set(), new Array(1)])
  ('rejects non-JSON nested values %#', value => {
    const plan = fixture(); Object.assign(plan.input.documents[0].issuer, { legalName: value }); rejects(plan);
  });

  it('rejects hidden/symbol/dangerous keys, executable serialization and custom prototypes without execution', () => {
    const hidden = fixture(); Object.defineProperty(hidden, 'hidden', { value: SENTINEL }); rejects(hidden);
    const symbolic = fixture(); Object.assign(symbolic, { [Symbol('ficticio')]: SENTINEL }); rejects(symbolic);
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const plan = fixture(); Object.defineProperty(plan.input, key, { value: SENTINEL, enumerable: true }); rejects(plan);
    }
    const serializer = vi.fn(() => { throw new Error(SENTINEL); });
    rejects({ ...fixture(), toJSON: serializer }); expect(serializer).not.toHaveBeenCalled();
    const inherited = Object.assign(Object.create({ hidden: SENTINEL }), fixture()); rejects(inherited);
  });

  it('accepts null-prototype JSON objects and normalizes them into detached ordinary objects', () => {
    const plan = fixture(); Object.setPrototypeOf(plan, null); Object.setPrototypeOf(plan.input, null);
    const result = validateFinancialLedgerPlan(plan);
    expect(Object.getPrototypeOf(result.plan)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(result.plan.input)).toBe(Object.prototype);
  });

  it('rejects root and nested proxies including revoked proxies without invoking traps', () => {
    const trap = vi.fn(() => { throw new Error(SENTINEL); });
    const hostile = <T extends object>(value: T): T => new Proxy(value, {
      get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap, has: trap,
    });
    rejects(hostile(fixture()));
    const input = fixture(); input.input = hostile(input.input); rejects(input);
    const heads = fixture(); heads.expectedHeads = hostile(heads.expectedHeads); rejects(heads);
    const head = fixture(); head.expectedHeads[0] = hostile(head.expectedHeads[0]); rejects(head);
    const doc = fixture(); doc.input.documents[0].issuer = hostile(doc.input.documents[0].issuer); rejects(doc);
    const revoked = Proxy.revocable(fixture(), {}); revoked.revoke(); rejects(revoked.proxy);
    expect(trap).not.toHaveBeenCalled();
  });

  it('rejects getters at the root, input, head and array index before invoking them', () => {
    const getter = vi.fn(() => { throw new Error(SENTINEL); });
    const root = fixture(); Object.defineProperty(root, 'input', { enumerable: true, get: getter }); rejects(root);
    const input = fixture(); Object.defineProperty(input.input, 'documents', { enumerable: true, get: getter }); rejects(input);
    const head = fixture(); Object.defineProperty(head.expectedHeads[0], 'revision', { enumerable: true, get: getter }); rejects(head);
    const array = fixture(); Object.defineProperty(array.expectedHeads, '0', { enumerable: true, get: getter }); rejects(array);
    const nested = fixture(); Object.defineProperty(nested.input.documents[0].issuer, 'legalName', { enumerable: true, get: getter }); rejects(nested);
    expect(getter).not.toHaveBeenCalled();
  });

  it('bounds strings, byte size, nodes, depth, object keys and arrays before domain processing', () => {
    const overString = fixture(); overString.input.documents[0].issuer.legalName = 'x'.repeat(16385); rejects(overString);
    const overBytes = fixture(); Object.assign(overBytes.input, { padding: Array(33).fill('x'.repeat(16384)) }); rejects(overBytes);
    const overNodes = fixture(); Object.assign(overNodes.input, { padding: Array.from({ length: 51 }, () => Array(1000).fill(0)) }); rejects(overNodes);
    const overDepth = fixture(); let nested: unknown = null;
    for (let i = 0; i < 66; i++) nested = { child: nested };
    Object.assign(overDepth.input, { padding: nested }); rejects(overDepth);
    const overKeys = fixture(); Object.assign(overKeys.input, { padding: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, 0])) }); rejects(overKeys);
    const longKey = fixture(); Object.assign(longKey.input, { ['k'.repeat(121)]: 0 }); rejects(longKey);
    const overArray = fixture(); Object.assign(overArray.input, { padding: Array(1001).fill(0) }); rejects(overArray);
  });

  it('rejects cycles, sparse arrays and arrays with extra properties', () => {
    const cycle = fixture(); Object.assign(cycle.input, { cycle }); rejects(cycle);
    const sparse = fixture(); delete sparse.expectedHeads[0]; rejects(sparse);
    const array = fixture(); Object.assign(array.expectedHeads, { extra: SENTINEL }); rejects(array);
    const fractional = fixture(); fractional.input.scope.companyId = 1.5; rejects(fractional);
  });

  it('never leaks input values, projection diagnostics, foreign errors or stacks', () => {
    const plan = fixture(); plan.input.scope.issuerRuc = SENTINEL; rejects(plan);
    rejects({ ...fixture(), planId: SENTINEL });
    const head = fixture(); Object.assign(head.expectedHeads[0], { versionSha256: SENTINEL }); rejects(head);
  });
});
