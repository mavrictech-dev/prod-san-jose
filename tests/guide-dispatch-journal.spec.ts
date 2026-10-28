import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  appendGuideDispatch, GuideDispatchError, rebuildGuideDispatch,
  validateGuideDispatchKey, validateGuideDispatchManifest,
  type GuideDispatchChange, type GuideDispatchEvent, type GuideDispatchManifest,
} from '../packages/sunat-core/src/guide-dispatch-journal';
import { fiscalSnapshotSha256 } from '../packages/sunat-core/src/fiscal-note';

// Invented identities and digests only; no owner runtime, DB, certificate or transport.
const uuid = (n: number) => `abcdef00-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const at = (n = 0) => new Date(Date.UTC(2026, 9, 22, 12, 0, n)).toISOString();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const manifest = (guideType: '09' | '31' = '09'): GuideDispatchManifest => ({
  schemaVersion: 'factuez.guide-dispatch-manifest.v1', environment: 'BETA',
  key: { companyId: 1, issuerRuc: '20000000001', operationId: uuid(1) },
  documentId: uuid(2), guideType, fullNumber: guideType === '09' ? 'T001-1' : 'V001-99999999',
  ownerRevision: 1, snapshotSha256: 'a'.repeat(64), xmlSha256: 'b'.repeat(64),
  zipSha256: 'c'.repeat(64), source: 'LOCAL_EMULATOR',
});
const safety = { candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false, authorizedForTransfer: false, officialCdrVerified: false };
const attempt: GuideDispatchChange = { kind: 'ATTEMPT', data: { attemptId: uuid(3) } };
const noResponse: GuideDispatchChange = { kind: 'NO_RESPONSE', data: { attemptId: uuid(3) } };
const ticket: GuideDispatchChange = { kind: 'TICKET', data: { attemptId: uuid(3), ticket: 'FICTION_ticket-001' } };
const pending: GuideDispatchChange = { kind: 'POLL_PENDING', data: { ticket: 'FICTION_ticket-001' } };
const result: GuideDispatchChange = { kind: 'POLL_RESULT', data: { ticket: 'FICTION_ticket-001', receiptSha256: 'd'.repeat(64) } };
function changes(m = manifest()): GuideDispatchChange[] {
  return [{ kind: 'REGISTER', data: { manifestSha256: fiscalSnapshotSha256(m) } }, attempt, noResponse, ticket, pending, result];
}
function history(length = 6, m = manifest()): GuideDispatchEvent[] {
  const events: GuideDispatchEvent[] = [];
  for (const change of changes(m).slice(0, length)) events.push(appendGuideDispatch(m, events, change, at(events.length)));
  return events;
}
function error(run: () => unknown, code: string) {
  let caught: unknown;
  try { run(); } catch (failure) { caught = failure; }
  expect(caught).toBeInstanceOf(GuideDispatchError);
  expect(caught).toMatchObject({ code, message: code });
}
// Re-sign deliberately malformed records so semantic checks cannot hide behind a bad hash.
function seal(value: Record<string, unknown>): GuideDispatchEvent {
  const { sha256: ignored, ...unsigned } = value;
  return { ...unsigned, sha256: fiscalSnapshotSha256(unsigned) } as GuideDispatchEvent;
}
function forgedNext(events: GuideDispatchEvent[], change: unknown, patch: Record<string, unknown> = {}) {
  return seal({ ...(change as object), schemaVersion: 'factuez.guide-dispatch-event.v1', operationId: uuid(1),
    version: events.length + 1, previousSha256: events.at(-1)?.sha256 ?? null, at: at(events.length), ...patch });
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}

describe('guide dispatch key and manifest, pure local candidate', () => {
  it('accepts fictional checksum-valid RUC and bounded company IDs as independent copies', () => {
    const input = manifest().key, output = validateGuideDispatchKey(input);
    expect(output).toEqual(input); expect(output).not.toBe(input);
    expect(validateGuideDispatchKey({ ...input, companyId: 2147483647 }).companyId).toBe(2147483647);
  });
  it.each([0, -1, 1.5, 2147483648, '1'])('rejects companyId %s', companyId => {
    error(() => validateGuideDispatchKey({ ...manifest().key, companyId }), 'INVALID_GUIDE_DISPATCH_KEY');
  });
  it.each([uuid(1).toUpperCase(), uuid(1).replace('-4000-', '-7000-'), uuid(1).replace('-8000-', '-0000-'), `${uuid(1)}\n`])(
    'rejects noncanonical operation UUID %j', operationId => {
      error(() => validateGuideDispatchKey({ ...manifest().key, operationId }), 'INVALID_GUIDE_DISPATCH_KEY');
    });
  it('requires the exact key shape including nested manifest keys', () => {
    for (const value of [null, [], { ...manifest().key, tenant: 1 }, { companyId: 1, operationId: uuid(1) }]) {
      error(() => validateGuideDispatchKey(value), 'INVALID_GUIDE_DISPATCH');
      error(() => validateGuideDispatchManifest({ ...manifest(), key: value }), 'INVALID_GUIDE_DISPATCH');
    }
  });
  it('rejects invalid checksum, prefix, type and RUC length', () => {
    for (const issuerRuc of ['20000000002', '99000000001', '2000000000', 20000000001]) {
      error(() => validateGuideDispatchKey({ ...manifest().key, issuerRuc }), 'INVALID_GUIDE_DISPATCH_KEY');
    }
  });
  it('rejects a checksum-valid RUC followed by LF instead of normalizing it', () => {
    error(() => validateGuideDispatchKey({ ...manifest().key, issuerRuc: '20000000001\n' }), 'INVALID_GUIDE_DISPATCH_KEY');
  });
  it.each(['09', '31'] as const)('accepts %s with its T/V full number and explicit BETA/local source', guideType => {
    expect(validateGuideDispatchManifest(manifest(guideType))).toEqual(manifest(guideType));
  });
  it.each([
    ['09', 'V001-1'], ['31', 'T001-1'], ['09', 't001-1'],
    ['09', 'T001-0'], ['31', 'V001-01'], ['09', 'T001-100000000'],
  ])('rejects guide %s with incompatible/noncanonical number %s', (guideType, fullNumber) => {
    error(() => validateGuideDispatchManifest({ ...manifest(), guideType, fullNumber }), 'INVALID_GUIDE_DISPATCH_MANIFEST');
  });
  it('requires a positive bounded integer owner revision', () => {
    for (const ownerRevision of [0, -1, 0.5, '1', 2147483648]) {
      error(() => validateGuideDispatchManifest({ ...manifest(), ownerRevision }), 'INVALID_GUIDE_DISPATCH_MANIFEST');
    }
    expect(validateGuideDispatchManifest({ ...manifest(), ownerRevision: 2147483647 }).ownerRevision).toBe(2147483647);
  });
  it.each(['snapshotSha256', 'xmlSha256', 'zipSha256'] as const)('validates the entire lowercase %s digest', field => {
    for (const value of ['A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63), `${'a'.repeat(64)}\n`, 1]) {
      error(() => validateGuideDispatchManifest({ ...manifest(), [field]: value }), 'INVALID_GUIDE_DISPATCH_MANIFEST');
    }
  });
  it('requires environment BETA and source LOCAL_EMULATOR without inferring them', () => {
    for (const patch of [{ environment: 'PRODUCTION' }, { environment: 'beta' }, { source: 'SUNAT' }, { source: 'BETA' }]) {
      error(() => validateGuideDispatchManifest({ ...manifest(), ...patch }), 'INVALID_GUIDE_DISPATCH_MANIFEST');
    }
    for (const field of ['environment', 'source']) {
      const input: Record<string, unknown> = { ...manifest() }; delete input[field];
      error(() => validateGuideDispatchManifest(input), 'INVALID_GUIDE_DISPATCH');
    }
  });
  it('rejects missing/extra manifest fields, fiscal-state claims, schema and unsupported guide types', () => {
    for (const patch of [{ ownerEnvironment: 'BETA' }, { fiscalState: 'ACCEPTED' }, { accepted: true }]) {
      error(() => validateGuideDispatchManifest({ ...manifest(), ...patch }), 'INVALID_GUIDE_DISPATCH');
    }
    for (const patch of [{ schemaVersion: 'factuez.guide-dispatch-manifest.v2' }, { guideType: '01' }]) {
      error(() => validateGuideDispatchManifest({ ...manifest(), ...patch }), 'INVALID_GUIDE_DISPATCH_MANIFEST');
    }
    const { ownerRevision, ...missing } = manifest();
    error(() => validateGuideDispatchManifest(missing), 'INVALID_GUIDE_DISPATCH');
  });
  it('uses the strict UUID policy for document IDs', () => {
    for (const documentId of [uuid(2).toUpperCase(), uuid(2).replace('-4000-', '-6000-'), `${uuid(2)}\n`, 'not-a-uuid']) {
      error(() => validateGuideDispatchManifest({ ...manifest(), documentId }), 'INVALID_GUIDE_DISPATCH_MANIFEST');
    }
  });
  it.each(['fullNumber', 'source', 'environment', 'documentId'] as const)('rejects trailing LF in manifest %s', field => {
    const input = manifest();
    error(() => validateGuideDispatchManifest({ ...input, [field]: `${input[field]}\n` }), 'INVALID_GUIDE_DISPATCH_MANIFEST');
  });
  it('does not alias or mutate the manifest, including its nested key', () => {
    const input = frozen(manifest()), before = clone(input), output = validateGuideDispatchManifest(input);
    output.key.companyId = 9; output.fullNumber = 'T999-9';
    expect(input).toEqual(before); expect(output.key).not.toBe(input.key);
  });
});

describe('bounded inert JSON at the dispatch boundary', () => {
  it.each([
    ['undefined', () => ({ ...manifest(), extra: undefined })],
    ['bigint', () => ({ ...manifest(), extra: 1n })],
    ['nonfinite', () => ({ ...manifest(), ownerRevision: Number.NaN })],
    ['custom prototype', () => Object.assign(Object.create({ inherited: 1 }), manifest())],
    ['symbol key', () => ({ ...manifest(), [Symbol('hidden')]: 1 })],
    ['cycle', () => { const value: any = manifest(); value.extra = value; return value; }],
    ['sparse array', () => ({ ...manifest(), extra: new Array(1) })],
  ] as const)('rejects %s before domain validation', (_name, factory) => {
    error(() => validateGuideDispatchManifest(factory()), 'INVALID_GUIDE_DISPATCH_JSON');
  });
  it('rejects accessors, toJSON and proxies without invoking user code', () => {
    const invoked = vi.fn(() => { throw new Error('must not execute'); });
    const getter = Object.defineProperty(manifest(), 'source', { enumerable: true, get: invoked });
    const proxy = new Proxy(manifest(), { ownKeys: invoked });
    for (const value of [getter, proxy, { ...manifest(), toJSON: invoked }]) {
      error(() => validateGuideDispatchManifest(value), 'INVALID_GUIDE_DISPATCH_JSON');
    }
    expect(invoked).not.toHaveBeenCalled();
  });
  it('enforces depth, string, array and total encoded byte limits', () => {
    let deep: unknown = null;
    for (let i = 0; i < 66; i++) deep = { value: deep };
    for (const extra of [deep, 'x'.repeat(16385), new Array(1001).fill(null), new Array(20).fill('x'.repeat(14000))]) {
      error(() => validateGuideDispatchManifest({ ...manifest(), extra }), 'INVALID_GUIDE_DISPATCH_JSON');
    }
  });
});

describe('one-attempt local dispatch state machine', () => {
  it('returns the exact empty READY projection with no fiscal authorization', () => {
    expect(rebuildGuideDispatch(manifest(), [])).toEqual({ state: 'READY', revision: 0, headSha256: null,
      lastAt: null, attemptId: null, ticket: null, receiptSha256: null, ...safety });
  });
  it('REGISTER binds the entire manifest using canonical SHA256 and a null first head', () => {
    const m = manifest(), [event] = history(1, m);
    const canonical = JSON.stringify({ at: at(), data: { manifestSha256: fiscalSnapshotSha256(m) }, kind: 'REGISTER',
      operationId: uuid(1), previousSha256: null, schemaVersion: 'factuez.guide-dispatch-event.v1', version: 1 });
    expect(event).toEqual({ kind: 'REGISTER', data: { manifestSha256: fiscalSnapshotSha256(m) },
      schemaVersion: 'factuez.guide-dispatch-event.v1', operationId: uuid(1), version: 1,
      previousSha256: null, at: at(), sha256: createHash('sha256').update(canonical).digest('hex') });
    expect(rebuildGuideDispatch(m, [event])).toEqual({ state: 'READY', revision: 1, headSha256: event.sha256,
      lastAt: at(), attemptId: null, ticket: null, receiptSha256: null, ...safety });
  });
  it('rebuilds REGISTER -> ATTEMPT -> NO_RESPONSE -> late TICKET -> pending -> unverified result', () => {
    const events = history(), states = ['READY', 'INTENT_RECORDED', 'UNCERTAIN', 'TICKET_RECEIVED', 'TICKET_RECEIVED', 'RESULT_PENDING_VERIFICATION'];
    for (let i = 1; i <= events.length; i++) {
      expect(rebuildGuideDispatch(manifest(), events.slice(0, i))).toEqual({ state: states[i - 1], revision: i,
        headSha256: events[i - 1].sha256, lastAt: at(i - 1), attemptId: i >= 2 ? uuid(3) : null,
        ticket: i >= 4 ? ticket.data.ticket : null, receiptSha256: i === 6 ? result.data.receiptSha256 : null, ...safety });
      expect(events[i - 1].previousSha256).toBe(i === 1 ? null : events[i - 2].sha256);
    }
  });
  it('accepts TICKET directly after INTENT_RECORDED without requiring NO_RESPONSE', () => {
    const events = history(2), next = appendGuideDispatch(manifest(), events, ticket, at(2));
    expect(rebuildGuideDispatch(manifest(), [...events, next])).toMatchObject({ state: 'TICKET_RECEIVED', ticket: ticket.data.ticket, ...safety });
  });
  it('allows repeated pending polls and the 1/100-character ticket boundaries', () => {
    for (const value of ['X', 'A'.repeat(100)]) {
      const events = history(2);
      events.push(appendGuideDispatch(manifest(), events, { kind: 'TICKET', data: { attemptId: uuid(3), ticket: value } }, at(2)));
      for (let i = 0; i < 2; i++) events.push(appendGuideDispatch(manifest(), events, { kind: 'POLL_PENDING', data: { ticket: value } }, at(3 + i)));
      expect(rebuildGuideDispatch(manifest(), events)).toMatchObject({ state: 'TICKET_RECEIVED', revision: 5, ticket: value, ...safety });
    }
  });
  it.each([2, 3, 4, 5, 6])('forbids any second ATTEMPT after history length %i, even with another ID', length => {
    const events = history(length);
    for (const attemptId of [uuid(3), uuid(4)]) {
      const change = { kind: 'ATTEMPT', data: { attemptId } };
      error(() => appendGuideDispatch(manifest(), events, change, at(10)), 'GUIDE_DISPATCH_TRANSITION_FORBIDDEN');
      error(() => rebuildGuideDispatch(manifest(), [...events, forgedNext(events, change)]), 'GUIDE_DISPATCH_TRANSITION_FORBIDDEN');
    }
  });
  it('requires REGISTER first and forbids premature or repeated lifecycle actions', () => {
    for (const change of [attempt, noResponse, ticket, pending, result]) {
      error(() => appendGuideDispatch(manifest(), [], change, at()), 'GUIDE_DISPATCH_HISTORY_INCONSISTENT');
    }
    for (const [length, change] of [[1, noResponse], [1, ticket], [2, pending], [2, result], [3, noResponse], [4, ticket], [4, noResponse], [1, changes()[0]]] as const) {
      error(() => appendGuideDispatch(manifest(), history(length), change, at(10)), 'GUIDE_DISPATCH_TRANSITION_FORBIDDEN');
    }
  });
  it('rejects a different or malformed attempt ID in NO_RESPONSE and TICKET', () => {
    for (const original of [noResponse, ticket]) for (const attemptId of [uuid(4), uuid(3).toUpperCase(), `${uuid(3)}\n`]) {
      const change = { ...original, data: { ...original.data, attemptId } };
      error(() => appendGuideDispatch(manifest(), history(2), change, at(10)),
        attemptId === uuid(4) ? 'GUIDE_DISPATCH_TRANSITION_FORBIDDEN' : 'INVALID_GUIDE_DISPATCH');
    }
  });
  it('binds both polling actions to the exact received ticket and rejects invalid tickets', () => {
    for (const original of [pending, result]) for (const value of ['different', '', 'A'.repeat(101), 'space ticket', 'ticket\n']) {
      error(() => appendGuideDispatch(manifest(), history(4), { ...original, data: { ...original.data, ticket: value } }, at(10)),
        value === 'different' ? 'GUIDE_DISPATCH_TRANSITION_FORBIDDEN' : 'INVALID_GUIDE_DISPATCH');
    }
    for (const value of ['', 'A'.repeat(101), 'ticket\n']) {
      error(() => appendGuideDispatch(manifest(), history(2), { ...ticket, data: { ...ticket.data, ticket: value } }, at(10)), 'INVALID_GUIDE_DISPATCH');
    }
  });
  it('forbids every additional lifecycle action after a poll result', () => {
    for (const change of changes()) error(() => appendGuideDispatch(manifest(), history(), change, at(10)), 'GUIDE_DISPATCH_TRANSITION_FORBIDDEN');
  });
  it('never accepts caller fiscal-state or authorization flags in change bodies or signed events', () => {
    for (const patch of [{ candidateOnly: false }, { fiscalExecutionEnabled: true }, { transmissionAuthorized: true }, { authorizedForTransfer: true },
      { officialCdrVerified: true }, { fiscalState: 'ACCEPTED' }, { state: 'ACCEPTED' }, { accepted: true }]) {
      error(() => appendGuideDispatch(manifest(), history(5), { ...result, ...patch }, at(10)), 'INVALID_GUIDE_DISPATCH');
      error(() => appendGuideDispatch(manifest(), history(5), { ...result, data: { ...result.data, ...patch } }, at(10)), 'INVALID_GUIDE_DISPATCH');
      const events = history(5);
      error(() => rebuildGuideDispatch(manifest(), [...events, forgedNext(events, result, patch)]), 'INVALID_GUIDE_DISPATCH');
    }
  });
  it('requires exact data fields for all six event kinds, including signed history', () => {
    for (const [i, original] of changes().entries()) {
      const events = history(i);
      const missing = { ...original, data: {} }, extra = { ...original, data: { ...original.data, extra: 1 } };
      for (const change of [missing, extra]) {
        error(() => appendGuideDispatch(manifest(), events, change, at(i)), 'INVALID_GUIDE_DISPATCH');
        error(() => rebuildGuideDispatch(manifest(), [...events, forgedNext(events, change)]), 'INVALID_GUIDE_DISPATCH');
      }
    }
  });
  it('rejects unknown kinds, non-object data, non-JSON changes and malformed receipt hashes', () => {
    for (const change of [null, [], { kind: 'ACCEPTED', data: {} }, { kind: 'POLL_RESULT', data: [] },
      { ...result, data: { ...result.data, receiptSha256: `${'d'.repeat(64)}\n` } }]) {
      error(() => appendGuideDispatch(manifest(), history(5), change, at(10)), 'INVALID_GUIDE_DISPATCH');
    }
    error(() => appendGuideDispatch(manifest(), history(5), undefined, at(10)), 'INVALID_GUIDE_DISPATCH_JSON');
  });
});

describe('history integrity, timestamps and bounded append', () => {
  it('preserves hashes across JSON roundtrips and property-order changes', () => {
    const m = manifest(), events = history();
    const reordered = events.map(event => Object.fromEntries(Object.entries(event).reverse()));
    expect(rebuildGuideDispatch(clone(m), clone(reordered))).toEqual(rebuildGuideDispatch(m, events));
    expect(appendGuideDispatch(m, [], changes()[0], at())).toEqual(history(1)[0]);
  });
  it.each([
    ['version gap', { version: 9 }], ['wrong parent', { previousSha256: 'e'.repeat(64) }],
    ['another operation', { operationId: uuid(99) }], ['event schema', { schemaVersion: 'factuez.guide-dispatch-event.v2' }],
    ['uppercase digest', { sha256: 'A'.repeat(64) }], ['edited data', { data: { attemptId: uuid(4) } }],
  ])('rejects %s even on an otherwise valid chain', (_name, patch) => {
    const events = history(2), changed = { ...events[1], ...patch };
    // Rehash envelope corruptions; deliberately leave data/digest edits unsealed.
    const raw = ['version', 'previousSha256', 'operationId', 'schemaVersion'].some(key => key in patch) ? seal(changed) : changed;
    error(() => rebuildGuideDispatch(manifest(), [events[0], raw]), 'GUIDE_DISPATCH_HISTORY_INCONSISTENT');
  });
  it('rejects reordered, duplicated, missing-first and missing-interior history/head records', () => {
    const events = history();
    for (const broken of [[events[1], events[0]], [events[0], events[0]], events.slice(1),
      [events[0], ...events.slice(2)], [{ ...events[0], previousSha256: 'a'.repeat(64) }],
      [events[0], { ...events[1], previousSha256: events.at(-1)!.sha256 }]]) {
      error(() => rebuildGuideDispatch(manifest(), broken), 'GUIDE_DISPATCH_HISTORY_INCONSISTENT');
    }
  });
  it('accepts a valid prefix: completeness/expected persisted head belongs to the store', () => {
    const events = history();
    expect(rebuildGuideDispatch(manifest(), events.slice(0, -1))).toMatchObject({ revision: 5,
      headSha256: events[4].sha256, state: 'TICKET_RECEIVED', receiptSha256: null, ...safety });
    expect(rebuildGuideDispatch(manifest(), events)).toMatchObject({ revision: 6, headSha256: events[5].sha256 });
  });
  it('binds REGISTER to every manifest identity, revision and artifact digest', () => {
    const m = manifest(), events = history(1);
    for (const patch of [{ documentId: uuid(9) }, { ownerRevision: 2 }, { fullNumber: 'T002-2' },
      { guideType: '31', fullNumber: 'V001-1' }, { snapshotSha256: 'e'.repeat(64) },
      { xmlSha256: 'e'.repeat(64) }, { zipSha256: 'e'.repeat(64) }, { key: { ...m.key, companyId: 2 } }]) {
      error(() => rebuildGuideDispatch({ ...m, ...patch }, events), 'GUIDE_DISPATCH_HISTORY_INCONSISTENT');
    }
    const wrongRegister = forgedNext([], { kind: 'REGISTER', data: { manifestSha256: 'f'.repeat(64) } });
    error(() => rebuildGuideDispatch(m, [wrongRegister]), 'GUIDE_DISPATCH_HISTORY_INCONSISTENT');
  });
  it.each(['2026-10-22T12:00:00Z', '2026-10-22T07:00:00.000-05:00', '2026-02-30T12:00:00.000Z', `${at()}\n`])(
    'rejects noncanonical/invalid timestamp %j in append and re-signed history', value => {
      error(() => appendGuideDispatch(manifest(), [], changes()[0], value), 'GUIDE_DISPATCH_HISTORY_INCONSISTENT');
      error(() => rebuildGuideDispatch(manifest(), [forgedNext([], changes()[0], { at: value })]), 'GUIDE_DISPATCH_HISTORY_INCONSISTENT');
    });
  it('rejects backwards timestamps and repairs to an interior event without rehashing descendants', () => {
    const events = history(3);
    error(() => appendGuideDispatch(manifest(), events, ticket, at(1)), 'GUIDE_DISPATCH_HISTORY_INCONSISTENT');
    error(() => rebuildGuideDispatch(manifest(), [events[0], seal({ ...events[1], at: at(2) }), events[2]]), 'GUIDE_DISPATCH_HISTORY_INCONSISTENT');
  });
  it('allows equal canonical timestamps for successive events', () => {
    const events: GuideDispatchEvent[] = [];
    for (const change of changes()) events.push(appendGuideDispatch(manifest(), events, change, at()));
    expect(rebuildGuideDispatch(manifest(), events)).toMatchObject({ revision: 6, lastAt: at(), ...safety });
  });
  it('accepts frozen inputs and returns independent mutable values without clock/network calls', () => {
    const m = frozen(manifest()), events = frozen(history(5)), change = frozen(clone(result));
    const before = JSON.stringify({ m, events, change });
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('NO CLOCK'); });
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('NO NETWORK'); });
    try {
      const next = appendGuideDispatch(m, events, change, at(5)), projection = rebuildGuideDispatch(m, [...events, next]);
      expect(projection).toEqual(rebuildGuideDispatch(m, [...events, next]));
      expect(next.data).not.toBe(change.data);
      if (next.kind !== 'POLL_RESULT') throw new Error('Fixture expected POLL_RESULT');
      next.data.ticket = 'changed'; next.data.receiptSha256 = 'e'.repeat(64);
      Object.assign(projection, { ticket: 'changed', transmissionAuthorized: true, fiscalExecutionEnabled: true });
      expect(rebuildGuideDispatch(m, events)).toMatchObject({ ticket: ticket.data.ticket, revision: 5, ...safety });
      expect(clock).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
      expect(JSON.stringify({ m, events, change })).toBe(before);
    } finally { clock.mockRestore(); network.mockRestore(); }
  });
  it('rebuilds exactly 128 valid events and allows appending event 128 to 127', () => {
    const events = history(4);
    while (events.length < 127) events.push(forgedNext(events, pending));
    const next = appendGuideDispatch(manifest(), events, pending, at(127));
    expect(next).toMatchObject({ version: 128, previousSha256: events[126].sha256 });
    expect(rebuildGuideDispatch(manifest(), [...events, next])).toMatchObject({ revision: 128,
      headSha256: next.sha256, state: 'TICKET_RECEIVED', ...safety });
    expect(events).toHaveLength(127);
  });
  it('rejects non-array history and histories longer than 128', () => {
    const events = history(4);
    while (events.length < 129) events.push(forgedNext(events, pending));
    for (const value of [null, {}, '[]', events]) {
      error(() => rebuildGuideDispatch(manifest(), value), 'GUIDE_DISPATCH_HISTORY_LIMIT');
      error(() => appendGuideDispatch(manifest(), value, pending, at(130)), 'GUIDE_DISPATCH_HISTORY_LIMIT');
    }
  });
  it('forbids event 129 append without mutating a full valid history', () => {
    const events = history(4);
    while (events.length < 128) events.push(forgedNext(events, pending));
    frozen(events);
    const before = JSON.stringify(events);
    error(() => appendGuideDispatch(manifest(), events, pending, at(128)), 'GUIDE_DISPATCH_HISTORY_LIMIT');
    expect(JSON.stringify(events)).toBe(before);
    expect(rebuildGuideDispatch(manifest(), events).revision).toBe(128);
  });
});
