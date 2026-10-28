import { describe, expect, it, vi } from 'vitest';
import type { FiscalDocumentSnapshot } from '../packages/contracts/src/events';
import { projectCorrectionJournal, type CorrectionJournalEvent } from '../packages/sunat-core/src/fiscal-correction-journal';
import type { FiscalLedgerEvidence } from '../packages/sunat-core/src/fiscal-financial-ledger';
import {
  buildFiscalNoteSnapshot, fiscalSnapshotSha256, type FiscalNoteContext, type FiscalNoteInput,
} from '../packages/sunat-core/src/fiscal-note';
import { buildFiscalSupplementCommand } from '../packages/sunat-core/src/fiscal-supplement-command';
import { calculateDocumentTotals } from '../packages/sunat-core/src/tax';
import { supplementCommandFixture, supplementUuid as uuid } from './helpers/fiscal-supplement.fixture';

// Entirely invented snapshots and asserted evidence; NO CDR bytes, certificate,
// PKI, database, network, SUNAT, transport or production authorization.
type Reserve = Extract<CorrectionJournalEvent, { kind: 'RESERVE' }>;
type Settle = Extract<CorrectionJournalEvent, { kind: 'SETTLE' }>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 3, 18, 0, seconds)).toISOString();
function original(quantity = '4', price = '118'): FiscalDocumentSnapshot {
  const value = supplementCommandFixture().doc;
  return { ...value, ...calculateDocumentTotals([{ productCode: 'FICTION', description: 'BIEN INVENTADO', unitCode: 'NIU',
    quantity, unitPriceWithTax: price, taxAffectationCode: '10', igvRate: '18' }]) };
}
const credit = (quantity = '1', line = 1): FiscalNoteInput => ({ documentTypeCode: '07', reasonCode: '07',
  reasonDescription: 'DEVOLUCION FICTICIA', lines: [{ originalLineNumber: line, quantity }] });
const debit: FiscalNoteInput = { documentTypeCode: '08', reasonCode: '02', reasonDescription: 'DELTA FICTICIO',
  lines: [{ originalLineNumber: 1, unitPriceAdjustmentWithTax: '11.8' }] };
function note(event: Reserve) {
  if (event.command.payload.envelope.kind !== 'NOTE') throw new Error('Fixture NOTE only');
  return event.command.payload.envelope.note;
}
function context(event: Reserve) {
  if (event.command.payload.envelope.kind !== 'NOTE') throw new Error('Fixture NOTE only');
  return event.command.payload.envelope.context;
}
function reserve(base: FiscalDocumentSnapshot, n = 1, history: Reserve[] = [], options: {
  input?: FiscalNoteInput; historyState?: 'RESERVED' | 'ACCEPTED'; occurredAt?: string; issueDate?: string; series?: string;
} = {}): Reserve {
  const acceptance = { ...supplementCommandFixture().acceptance, documentId: base.documentId,
    documentTypeCode: base.documentTypeCode as '01' | '03', fullNumber: base.fullNumber,
    snapshotSha256: fiscalSnapshotSha256(base) };
  const ctx: FiscalNoteContext = { original: base, acceptance, asOf: options.occurredAt ?? at(3 * n + 1),
    creditHistory: { complete: true, entries: history.filter(event => note(event).documentTypeCode === '07')
      .map(event => ({ state: options.historyState ?? 'RESERVED', note: note(event) })) } };
  const input = options.input ?? credit();
  const snapshot = buildFiscalNoteSnapshot(ctx, input, { documentId: uuid(100 + n),
    series: options.series ?? (input.documentTypeCode === '07' ? 'FC01' : 'FD01'), number: String(n),
    issueDate: options.issueDate ?? at(3 * n) });
  return { kind: 'RESERVE', actorSha256: 'd'.repeat(64), command: buildFiscalSupplementCommand({ kind: 'NOTE', note: snapshot, context: ctx },
    { eventId: uuid(1000 + n), correlationId: uuid(2000 + n), occurredAt: ctx.asOf }) };
}
function rebuild(event: Reserve): Reserve {
  const ctx = context(event), old = note(event);
  const snapshot = buildFiscalNoteSnapshot(ctx, old.adjustment,
    { documentId: old.documentId, series: old.series, number: old.number, issueDate: old.issueDate });
  event.command = buildFiscalSupplementCommand({ kind: 'NOTE', note: snapshot, context: ctx },
    { eventId: event.command.eventId, correlationId: event.command.correlationId, occurredAt: ctx.asOf });
  return event;
}
function settle(event: Reserve, n = 1, status: FiscalLedgerEvidence['status'] = 'ACCEPTED'): Settle {
  return { kind: 'SETTLE', operationId: event.command.payload.operationId, evidence: {
    status, cdrSignatureVerified: true, officialCdr: true, cdrSha256: 'b'.repeat(64), requestSha256: 'c'.repeat(64),
    responseCode: status === 'REJECTED' ? '2335' : '0', acceptedAt: at(3 * n + 2),
  } };
}
function blocked(base: unknown, events: unknown, code?: string): void {
  const run = () => projectCorrectionJournal(base as FiscalDocumentSnapshot, events as CorrectionJournalEvent[]);
  expect(run).toThrow(code === undefined ? Error : new Error(code));
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

describe('pure dynamic correction journal V2 (asserted evidence, not PKI)', () => {
  it('returns the exact interface, immutable baseline and no authorization', () => {
    const base = original(), result = projectCorrectionJournal(base, []);
    expect(Object.keys(result).sort()).toEqual(['profile', 'originalSha256', 'headSha256', 'revision', 'versions',
      'creditHeld', 'debitHeld', 'netAmount', 'operations', 'candidateOnly', 'transmissionAuthorized'].sort());
    expect(result).toMatchObject({ profile: 'FACTUEZ-BETA-CORRECTION-JOURNAL-v2', revision: 0,
      originalSha256: fiscalSnapshotSha256(base), creditHeld: '0.00', debitHeld: '0.00', netAmount: '472.00',
      operations: [], candidateOnly: true, transmissionAuthorized: false });
    expect(result.versions).toEqual([{ revision: 0, sha256: result.headSha256, previousSha256: null }]);
    expect(result.headSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.headSha256).not.toBe(result.originalSha256);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.versions)).toBe(true);
    expect(Object.isFrozen(result.versions[0])).toBe(true); expect(Object.isFrozen(result.operations)).toBe(true);
  });
  it('never calls a clock/network or mutates/aliases frozen caller objects', () => {
    const base = original(), first = reserve(base), input = freeze([first, settle(first)]);
    const before = JSON.stringify({ base, input }); freeze(base);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('NO CLOCK'); });
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('NO NETWORK'); });
    try {
      const output = projectCorrectionJournal(base, input);
      expect(projectCorrectionJournal(base, input)).toEqual(output);
      expect(Object.isFrozen(output.operations[0])).toBe(true);
      expect(clock).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); network.mockRestore(); }
    expect(JSON.stringify({ base, input })).toBe(before);
  });
  it('accepts original 03 baseline but rejects individual B notes (separate RC profile)', () => {
    const base = supplementCommandFixture('RC').doc;
    expect(projectCorrectionJournal(base, []).revision).toBe(0);
    const event = reserve(original());
    const env = event.command.payload.envelope;
    if (env.kind !== 'NOTE') throw new Error('Fixture');
    env.note.series = 'BC01'; env.note.fullNumber = `BC01-${env.note.number}`;
    blocked(base, [event], 'INVALID_COMMAND');
  });
  it('reserves without financial effect and binds command, actor and note hashes', () => {
    const base = original(), first = reserve(base), result = projectCorrectionJournal(base, [first]);
    expect(result).toMatchObject({ revision: 1, creditHeld: '118.00', debitHeld: '0.00', netAmount: '472.00', operations: [{
      operationId: first.command.payload.operationId, commandSha256: fiscalSnapshotSha256(first.command),
      actorSha256: first.actorSha256, state: 'RESERVED', noteSha256: fiscalSnapshotSha256(note(first)),
    }] });
    expect(result.versions[1].previousSha256).toBe(result.versions[0].sha256);
  });
  it.each(['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS'] as const)('applies %s exactly once while preserving the hold', status => {
    const base = original(), first = reserve(base), result = projectCorrectionJournal(base, [first, settle(first, 1, status)]);
    expect(result).toMatchObject({ revision: 2, creditHeld: '118.00', netAmount: '354.00', operations: [{ state: status }] });
    expect(result.versions[2].previousSha256).toBe(result.versions[1].sha256);
  });
  it('appends a new reservation AFTER settlement without rewriting ANY prior version', () => {
    const base = original(), first = reserve(base), second = reserve(base, 2, [first], { historyState: 'ACCEPTED' });
    const events: CorrectionJournalEvent[] = [first, settle(first), second, settle(second, 2)];
    const full = projectCorrectionJournal(base, events);
    for (let length = 0; length <= events.length; length++) {
      const prefix = projectCorrectionJournal(base, events.slice(0, length));
      expect(prefix.versions).toEqual(full.versions.slice(0, length + 1));
      expect(prefix.revision).toBe(length); expect(prefix.headSha256).toBe(full.versions[length].sha256);
    }
    expect(full).toMatchObject({ revision: 4, creditHeld: '236.00', netAmount: '236.00' });
  });
  it('allows RESERVED context projection to lag trusted acceptance', () => {
    const base = original(), first = reserve(base), second = reserve(base, 2, [first]);
    const result = projectCorrectionJournal(base, [first, settle(first), second]);
    expect(result.operations.map(value => value.state)).toEqual(['ACCEPTED', 'RESERVED']);
  });
  it('requires known credits even for a debit reservation', () => {
    const base = original(), first = reserve(base), missing = reserve(base, 2, [], { input: debit });
    blocked(base, [first, missing], 'INCOMPLETE_CREDIT_HISTORY');
  });
  it('rejects a prematurely ACCEPTED history claim despite valid note mathematics', () => {
    const base = original(), first = reserve(base), next = reserve(base, 2, [first], { historyState: 'ACCEPTED' });
    blocked(base, [first, next], 'UNSETTLED_CREDIT_HISTORY');
  });
  it('allows observed acceptance in the accepted creation history', () => {
    const base = original(), first = reserve(base), next = reserve(base, 2, [first], { historyState: 'ACCEPTED' });
    expect(projectCorrectionJournal(base, [first, settle(first, 1, 'ACCEPTED_WITH_OBSERVATIONS'), next]).revision).toBe(3);
  });
  it('rejects unknown credit history members, even with otherwise valid snapshots', () => {
    const base = original(), first = reserve(base), stranger = reserve(base, 3), next = reserve(base, 4, [stranger]);
    blocked(base, [first, next], 'CREDIT_HISTORY_CONFLICT');
  });
  it('rejects omission of an older credit when newer credits are present', () => {
    const base = original('8'), first = reserve(base), second = reserve(base, 2, [first]), third = reserve(base, 3, [first, second]);
    context(third).creditHistory.entries.shift();
    third.command.payload.envelopeSha256 = fiscalSnapshotSha256(third.command.payload.envelope);
    // Historical snapshots carry the omitted first id: domain validation may
    // reject before the journal's completeness check. Both fail closed.
    blocked(base, [first, second, third]);
  });
  it('keeps rejected credit holds, requires their future membership, and never nets rejection', () => {
    const base = original(), first = reserve(base), rejected = settle(first, 1, 'REJECTED');
    const second = reserve(base, 2, [first]);
    const result = projectCorrectionJournal(base, [first, rejected, second, settle(second, 2)]);
    expect(result).toMatchObject({ revision: 4, creditHeld: '236.00', netAmount: '354.00' });
    expect(result.operations.map(value => value.state)).toEqual(['REJECTED', 'ACCEPTED']);
    blocked(base, [first, rejected, reserve(base, 2)], 'INCOMPLETE_CREDIT_HISTORY');
    blocked(base, [first, rejected, reserve(base, 2, [first], { historyState: 'ACCEPTED' })], 'UNSETTLED_CREDIT_HISTORY');
  });
  it('also retains rejected debit holds without a financial effect', () => {
    const base = original(), first = reserve(base, 1, [], { input: debit });
    expect(projectCorrectionJournal(base, [first, settle(first, 1, 'REJECTED')])).toMatchObject({
      creditHeld: '0.00', debitHeld: '47.20', netAmount: '472.00', operations: [{ state: 'REJECTED' }],
    });
  });
  it.each(['NC_THEN_ND', 'ND_THEN_NC'] as const)('supports %s with exact amounts and complete credit history', order => {
    const base = original(), one = reserve(base, 1, [], { input: order === 'NC_THEN_ND' ? credit() : debit });
    const two = reserve(base, 2, [one], { input: order === 'NC_THEN_ND' ? debit : credit(), historyState: 'ACCEPTED' });
    expect(projectCorrectionJournal(base, [one, settle(one), two, settle(two, 2)])).toMatchObject({
      creditHeld: '118.00', debitHeld: '47.20', netAmount: '401.20', revision: 4,
    });
  });
  it('does not treat pending debits as financial effects or credits as negative balances', () => {
    const base = original(), one = reserve(base, 1, [], { input: debit }), two = reserve(base, 2, [one]);
    expect(projectCorrectionJournal(base, [one, two])).toMatchObject({ debitHeld: '47.20', creditHeld: '118.00', netAmount: '472.00' });
  });
  it('supports mora debit separately from taxable credits without floating point arithmetic', () => {
    const base = original('4', '0.118'), one = reserve(base, 1, [], { input: { documentTypeCode: '08', reasonCode: '01',
      reasonDescription: 'MORA INVENTADA', interestNature: 'MORATORIO', interestBasis: 'SUSTENTO FICTICIO',
      lines: [{ originalLineNumber: 1, interestAmount: '0.01' }] } });
    const two = reserve(base, 2, [one]);
    expect(projectCorrectionJournal(base, [one, settle(one), two, settle(two, 2)])).toMatchObject({
      debitHeld: '0.01', creditHeld: '0.12', netAmount: '0.36',
    });
  });
  it('preserves exact bigint net beyond the individual decimal ceiling', () => {
    const base = original('1', '999999999999'), one = reserve(base, 1, [], { input: {
      documentTypeCode: '08', reasonCode: '01', reasonDescription: 'MORA INVENTADA', interestNature: 'MORATORIO',
      interestBasis: 'SUSTENTO FICTICIO', lines: [{ originalLineNumber: 1, interestAmount: '999999999999.99' }],
    } });
    expect(projectCorrectionJournal(base, [one, settle(one)]).netAmount).toBe('1999999999998.99');
  });
  it('retains per-line quantity capacity after accepted debits and rejected credits', () => {
    const base = original('2');
    const one = reserve(base), two = reserve(base, 2, [one], { input: debit }), three = reserve(base, 3, [one, two]);
    const prefix: CorrectionJournalEvent[] = [one, settle(one, 1, 'REJECTED'), two, settle(two, 2), three];
    expect(projectCorrectionJournal(base, prefix)).toMatchObject({ creditHeld: '236.00', netAmount: '259.60' });
    const omittedRejected = reserve(base, 4, [], { input: credit('1.5') });
    blocked(base, [...prefix, omittedRejected], 'INCOMPLETE_CREDIT_HISTORY');
    // Capacity cannot be expanded by the debit or rejection, even in note construction.
    expect(() => reserve(base, 4, [one, three])).toThrow();
  });
  it('rejects per-line excess even if other lines leave sufficient TOTAL capacity', () => {
    const base = original('2');
    Object.assign(base, calculateDocumentTotals([
      { productCode: 'UNO', description: 'UNO FICTICIO', unitCode: 'NIU', quantity: '2', unitPriceWithTax: '118', taxAffectationCode: '10', igvRate: '18' },
      { productCode: 'DOS', description: 'DOS FICTICIO', unitCode: 'NIU', quantity: '10', unitPriceWithTax: '118', taxAffectationCode: '10', igvRate: '18' },
    ]));
    const one = reserve(base), two = reserve(base, 2, [one]);
    expect(projectCorrectionJournal(base, [one, two]).creditHeld).toBe('236.00');
    expect(() => reserve(base, 3, [one, two])).toThrow();
    const missing = reserve(base, 3);
    blocked(base, [one, two, missing], 'INCOMPLETE_CREDIT_HISTORY');
  });
  it('blocks mixed quantity-return/value-reduction semantics rather than guessing a balance', () => {
    const base = original(), one = reserve(base);
    expect(() => reserve(base, 2, [one], { input: { documentTypeCode: '07', reasonCode: '05',
      reasonDescription: 'DESCUENTO FICTICIO', lines: [{ originalLineNumber: 1, unitPriceAdjustmentWithTax: '1' }] } })).toThrow();
  });
  it.each(['RESERVE', 'ACCEPTED', 'REJECTED'] as const)('rejects an exact duplicate %s rather than appending a replay', kind => {
    const base = original(), one = reserve(base);
    if (kind === 'RESERVE') blocked(base, [one, clone(one)], 'OPERATION_CONFLICT');
    else {
      const outcome = settle(one, 1, kind);
      blocked(base, [one, outcome, clone(outcome)], 'ALREADY_SETTLED');
    }
  });
  it('rejects a changed outcome after acceptance or rejection', () => {
    const base = original(), one = reserve(base);
    blocked(base, [one, settle(one), settle(one, 1, 'REJECTED')], 'ALREADY_SETTLED');
    blocked(base, [one, settle(one, 1, 'REJECTED'), settle(one)], 'ALREADY_SETTLED');
  });
  it('rejects duplicate event ids and conflicting note numbers on distinct operations', () => {
    const base = original(), one = reserve(base), two = reserve(base, 2, [one]);
    two.command.eventId = one.command.eventId;
    blocked(base, [one, two], 'EVENT_CONFLICT');
    const firstDebit = reserve(base, 1, [], { input: debit }), other = reserve(base, 2, [], { input: debit });
    note(other).number = note(firstDebit).number;
    blocked(base, [firstDebit, rebuild(other)], 'NOTE_CONFLICT');
  });
  it('rejects a settlement for unknown/foreign operation or a settlement before reserve', () => {
    const base = original(), one = reserve(base), outcome = settle(one);
    blocked(base, [outcome], 'UNKNOWN_OPERATION');
    outcome.operationId = uuid(900); blocked(base, [one, outcome], 'UNKNOWN_OPERATION');
    outcome.operationId = 'not-an-id'; blocked(base, [one, outcome], 'INVALID_OPERATION');
  });
  it('binds actor, command metadata and CDR/request hashes without rewriting earlier versions', () => {
    const base = original(), one = reserve(base), outcome = settle(one), current = projectCorrectionJournal(base, [one, outcome]);
    for (const field of ['cdrSha256', 'requestSha256'] as const) {
      const changed = clone(outcome); changed.evidence[field] = 'e'.repeat(64);
      const result = projectCorrectionJournal(base, [one, changed]);
      expect(result.netAmount).toBe(current.netAmount);
      expect(result.versions.slice(0, 2)).toEqual(current.versions.slice(0, 2));
      expect(result.headSha256).not.toBe(current.headSha256);
    }
    const changedActor = clone(one); changedActor.actorSha256 = 'e'.repeat(64);
    expect(projectCorrectionJournal(base, [changedActor]).headSha256).not.toBe(projectCorrectionJournal(base, [one]).headSha256);
    const changedCommand = clone(one); changedCommand.command.correlationId = uuid(999);
    expect(projectCorrectionJournal(base, [changedCommand]).headSha256).not.toBe(projectCorrectionJournal(base, [one]).headSha256);
  });
  it('canonicalizes insertion order while retaining detached data and event order', () => {
    const base = original(), one = reserve(base);
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as FiscalDocumentSnapshot;
    const event = { actorSha256: one.actorSha256, command: one.command, kind: 'RESERVE' as const };
    expect(projectCorrectionJournal(reordered, [event])).toEqual(projectCorrectionJournal(base, [one]));
    const result = projectCorrectionJournal(base, [one]); one.actorSha256 = 'f'.repeat(64);
    expect(result.operations[0].actorSha256).toBe('d'.repeat(64));
  });
  it.each(['companyId', 'branchId', 'documentId', 'customer'] as const)('rejects a valid command from another original (%s)', field => {
    const base = original(), other = clone(base);
    if (field === 'companyId') other.companyId = 123;
    if (field === 'branchId') other.branchId = uuid(900);
    if (field === 'documentId') other.documentId = uuid(900);
    if (field === 'customer') other.customer.legalName = 'OTRO CLIENTE FICTICIO';
    blocked(base, [reserve(other)], 'ORIGINAL_MISMATCH');
  });
  it('pins the original acceptance across later reservations (no silent RC2/authority replacement)', () => {
    const base = original(), one = reserve(base), two = reserve(base, 2, [one]);
    context(two).acceptance.cdrSha256 = 'f'.repeat(64);
    // Rebuild with empty history, since historical snapshots pin the old acceptance.
    context(two).creditHistory.entries = []; rebuild(two);
    blocked(base, [one, two], 'ACCEPTANCE_CONFLICT');
  });
  it.each(['actorSha256', 'envelopeSha256'] as const)('rejects invalid %s', field => {
    const base = original(), one = reserve(base);
    if (field === 'actorSha256') one.actorSha256 = 'NOT-A-HASH';
    else one.command.payload.envelopeSha256 = 'e'.repeat(64);
    blocked(base, [one], field === 'actorSha256' ? 'INVALID_ACTOR_HASH' : 'INVALID_COMMAND');
  });
  it('rejects batch commands without authorizing or creating any journal entry', () => {
    const command = supplementCommandFixture('RC').command;
    blocked(original(), [{ kind: 'RESERVE', command, actorSha256: 'd'.repeat(64) }], 'UNSUPPORTED_OPERATION');
  });
  it.each([
    ['production', (value: any) => { value.environment = 'PRODUCTION'; }],
    ['currency', (value: any) => { value.currencyCode = 'USD'; }],
    ['totals', (value: any) => { value.totals.payableAmount = '0.01'; }],
    ['line amount', (value: any) => { value.lines[0].igvAmount = '0.00'; }],
    ['payment', (value: any) => { value.paymentTerms.type = 'CREDITO'; }],
    ['missing company', (value: any) => { delete value.companyId; }],
    ['missing branch', (value: any) => { delete value.branchId; }],
    ['invalid RUC', (value: any) => { value.issuer.identityNumber = '123'; }],
    ['fullNumber', (value: any) => { value.fullNumber = 'FQ01-9'; }],
    ['missing issuer', (value: any) => { delete value.issuer; }],
    ['negative line', (value: any) => { value.lines[0].quantity = '-1'; }],
    ['too many lines', (value: any) => { value.lines = Array.from({ length: 101 }, () => value.lines[0]); }],
  ] as const)('validates full own original: %s', (_label, mutate) => {
    const base = original(); mutate(base); blocked(base, []);
  });
  it.each([
    ['unsigned', { cdrSignatureVerified: false }], ['unofficial', { officialCdr: false }],
    ['string flag', { officialCdr: 'true' }], ['missing flag', { cdrSignatureVerified: undefined }],
    ['unknown status', { status: 'PENDING' }], ['wrong accepted code', { responseCode: '2000' }],
    ['too low rejection', { status: 'REJECTED', responseCode: '1999' }],
    ['processing code', { status: 'REJECTED', responseCode: '98' }],
    ['zero rejection', { status: 'REJECTED', responseCode: '0' }],
    ['leading zeros', { status: 'REJECTED', responseCode: '02000' }],
    ['oversized code', { status: 'REJECTED', responseCode: '100000' }],
    ['numeric code', { responseCode: 0 }], ['bad cdr hash', { cdrSha256: 'A'.repeat(64) }],
    ['bad request hash', { requestSha256: 'x' }], ['timezone missing', { acceptedAt: '2026-10-03T18:00:05' }],
    ['bad date', { acceptedAt: '2026-02-30T18:00:05Z' }],
  ] as const)('fails closed on evidence %s', (_label, patch) => {
    const base = original(), one = reserve(base), outcome = settle(one);
    Object.assign(outcome.evidence, patch); blocked(base, [one, outcome]);
  });
  it.each(['2000', '2335', '99999'])('accepts asserted rejection code %s without freeing capacity', code => {
    const base = original(), one = reserve(base), outcome = settle(one, 1, 'REJECTED'); outcome.evidence.responseCode = code;
    expect(projectCorrectionJournal(base, [one, outcome])).toMatchObject({ creditHeld: '118.00', netAmount: '472.00' });
  });
  it('rejects reserve/issue chronology regression, including notes issued before a prior debit', () => {
    const base = original(), one = reserve(base, 2, [], { input: debit });
    blocked(base, [one, reserve(base, 3, [], { occurredAt: at(6), issueDate: at(5) })], 'INVALID_CHRONOLOGY');
    blocked(base, [one, reserve(base, 3, [], { occurredAt: at(10), issueDate: at(5) })], 'INVALID_CHRONOLOGY');
  });
  it('rejects settlement before its OWN note issue or reservation time', () => {
    const base = original(), one = reserve(base), outcome = settle(one);
    outcome.evidence.acceptedAt = at(2); blocked(base, [one, outcome], 'INVALID_CHRONOLOGY');
    outcome.evidence.acceptedAt = at(3); blocked(base, [one, outcome], 'INVALID_CHRONOLOGY');
    const two = reserve(base, 2, [one]), other = settle(two, 2); other.evidence.acceptedAt = at(5);
    blocked(base, [one, two, other], 'INVALID_CHRONOLOGY');
  });
  it('accepts a late first CDR whose acceptance predates the latest reservation', () => {
    const base = original(), one = reserve(base), two = reserve(base, 2, [one]);
    const prefix: CorrectionJournalEvent[] = [one, two];
    const before = projectCorrectionJournal(base, prefix);
    const result = projectCorrectionJournal(base, [...prefix, settle(one)]);
    expect(result).toMatchObject({ revision: 3, creditHeld: '236.00', netAmount: '354.00' });
    expect(result.operations.map(value => value.state)).toEqual(['ACCEPTED', 'RESERVED']);
    expect(result.versions.slice(0, 3)).toEqual(before.versions);
  });
  it.each(['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS', 'REJECTED'] as const)(
    'allows out-of-order CDR arrival with an older %s acceptance timestamp', status => {
      const base = original(), one = reserve(base), two = reserve(base, 2, [one]);
      const prefix: CorrectionJournalEvent[] = [one, two, settle(two, 2)];
      const before = projectCorrectionJournal(base, prefix);
      const result = projectCorrectionJournal(base, [...prefix, settle(one, 1, status)]);
      expect(result).toMatchObject({ revision: 4, creditHeld: '236.00', netAmount: status === 'REJECTED' ? '354.00' : '236.00' });
      expect(result.operations.map(value => value.state)).toEqual([status, 'ACCEPTED']);
      expect(result.versions.slice(0, 4)).toEqual(before.versions);
    });
  it('does not advance the reservation clock when receiving a CDR with a later acceptance time', () => {
    const base = original(), one = reserve(base), outcome = settle(one); outcome.evidence.acceptedAt = at(20);
    const two = reserve(base, 2, [one]);
    expect(projectCorrectionJournal(base, [one, outcome, two])).toMatchObject({ revision: 3, creditHeld: '236.00', netAmount: '354.00' });
    const backwards = reserve(base, 3, [one, two], { occurredAt: at(6), issueDate: at(6) });
    blocked(base, [one, outcome, two, backwards], 'INVALID_CHRONOLOGY');
  });
  it('allows reordered exact-set history for equal-issued credits, preserving original snapshots and command hashes', () => {
    const base = original('8');
    // Higher lexical ID was reserved first, while issued-at values are equal.
    const first = reserve(base, 2, [], { issueDate: at(3) });
    const second = reserve(base, 1, [first], { issueDate: at(3), occurredAt: at(8) });
    const third = reserve(base, 3, [first, second]);
    const before = projectCorrectionJournal(base, [first, second]);
    const reordered = clone(third);
    context(reordered).creditHistory.entries.reverse();
    note(reordered).creditHistoryIds.reverse();
    reordered.command.payload.envelopeSha256 = fiscalSnapshotSha256(reordered.command.payload.envelope);
    const inputBefore = JSON.stringify(reordered);
    const result = projectCorrectionJournal(base, [first, second, reordered]);
    expect(result.versions.slice(0, 3)).toEqual(before.versions);
    expect(result).toMatchObject({ revision: 3, creditHeld: '354.00', netAmount: '944.00' });
    expect(result.operations[2].commandSha256).toBe(fiscalSnapshotSha256(reordered.command));
    expect(result.operations[2].noteSha256).toBe(fiscalSnapshotSha256(note(reordered)));
    expect(result.headSha256).not.toBe(projectCorrectionJournal(base, [first, second, third]).headSha256);
    expect(JSON.stringify(reordered)).toBe(inputBefore);
  });
  it('still rejects duplicated, missing or changed members in a reordered history', () => {
    const base = original('8'), first = reserve(base), second = reserve(base, 2, [first]);
    const third = reserve(base, 3, [first, second]);
    for (const scenario of ['duplicate', 'missing', 'tampered', 'wrong-state', 'extra-fields', 'ids-order'] as const) {
      const value = clone(third), history = context(value).creditHistory.entries;
      history.reverse(); note(value).creditHistoryIds.reverse();
      if (scenario === 'duplicate') { history[1] = clone(history[0]); note(value).creditHistoryIds[1] = history[0].note.documentId; }
      if (scenario === 'missing') { history.pop(); note(value).creditHistoryIds.pop(); }
      if (scenario === 'tampered') history[0].note.reasonDescription = 'SNAPSHOT MODIFICADO';
      if (scenario === 'wrong-state') history[0].state = 'ACCEPTED';
      if (scenario === 'extra-fields') Object.assign(history[0], { accepted: true });
      if (scenario === 'ids-order') note(value).creditHistoryIds.reverse();
      value.command.payload.envelopeSha256 = fiscalSnapshotSha256(value.command.payload.envelope);
      blocked(base, [first, second, value]);
    }
  });
  it('retains rejected credits and verifies accepted claims when the known history is reordered', () => {
    const base = original('8'), first = reserve(base), second = reserve(base, 2, [first]);
    const rejected = settle(first, 1, 'REJECTED'), accepted = settle(second, 2);
    const third = reserve(base, 3, [first, second]);
    const history = context(third).creditHistory.entries;
    history.reverse(); history[0].state = 'ACCEPTED'; note(third).creditHistoryIds.reverse();
    third.command.payload.envelopeSha256 = fiscalSnapshotSha256(third.command.payload.envelope);
    expect(projectCorrectionJournal(base, [first, second, accepted, rejected, third])).toMatchObject({
      revision: 5, creditHeld: '354.00', netAmount: '826.00',
    });
  });
  it('permits equal instants with explicit timezones, not date-string lexical ordering', () => {
    const base = original(), one = reserve(base), outcome = settle(one);
    outcome.evidence.acceptedAt = '2026-10-03T13:00:04-05:00';
    expect(projectCorrectionJournal(base, [one, outcome]).revision).toBe(2);
  });
  it('accepts exactly 100 notes / 200 events with bounded individual messages', () => {
    const base = original(), events: CorrectionJournalEvent[] = [];
    for (let n = 1; n <= 100; n++) { const event = reserve(base, n, [], { input: debit }); events.push(event, settle(event, n)); }
    const result = projectCorrectionJournal(base, events);
    expect(result.revision).toBe(200); expect(result.versions).toHaveLength(201); expect(result.operations).toHaveLength(100);
    expect(result).toMatchObject({ debitHeld: '4720.00', creditHeld: '0.00', netAmount: '5192.00' });
    blocked(base, [...events, settle(events[0] as Reserve)], 'LIMIT_EXCEEDED');
    const reserves = events.filter((event): event is Reserve => event.kind === 'RESERVE');
    blocked(base, [...reserves, reserve(base, 101, [], { input: debit })], 'LIMIT_EXCEEDED');
  });
  it.each([
    null, {}, 'events', new Set(), Object.assign([], { extra: true }), [undefined], [null],
    [{ kind: 'RELEASE' }], [{ kind: 'SETTLE', operationId: uuid(1) }],
    [{ kind: 'RESERVE', actorSha256: 'a'.repeat(64) }],
  ])('rejects malformed stream %# without exposing partial output', events => { blocked(original(), events); });
  it('rejects extra keys on events and evidence', () => {
    const base = original(), one = reserve(base), outcome = settle(one);
    blocked(base, [{ ...one, productionAuthorized: true }], 'INVALID_EVENT');
    blocked(base, [one, { ...outcome, evidence: { ...outcome.evidence, documentId: uuid(999) } }], 'INVALID_EVENT');
  });
  it('rejects sparse, nonenumerable-index and symbol-keyed event arrays', () => {
    const base = original(), one = reserve(base), sparse = new Array(1);
    blocked(base, sparse, 'INVALID_JSON');
    const hidden: unknown[] = []; Object.defineProperty(hidden, '0', { value: one, enumerable: false });
    blocked(base, hidden, 'INVALID_JSON');
    const symbols = [one]; Object.defineProperty(symbols, Symbol('hidden'), { value: 1 });
    blocked(base, symbols, 'INVALID_JSON');
  });
  it('rejects getters on root indices, commands and original without executing them', () => {
    const getter = vi.fn(() => { throw new Error('MUST NOT RUN'); }), base = original();
    const array: unknown[] = []; Object.defineProperty(array, '0', { get: getter, enumerable: true });
    blocked(base, array, 'INVALID_JSON');
    const event = reserve(base); Object.defineProperty(event.command, 'payload', { get: getter, enumerable: true });
    blocked(base, [event], 'INVALID_JSON');
    Object.defineProperty(base, 'issuer', { get: getter, enumerable: true }); blocked(base, [], 'INVALID_JSON');
    expect(getter).not.toHaveBeenCalled();
  });
  it('rejects proxies and revoked proxies BEFORE traps/reflection', () => {
    const trap = vi.fn(() => { throw new Error('MUST NOT RUN'); }), handler = { get: trap, ownKeys: trap, getPrototypeOf: trap };
    const base = original();
    blocked(base, new Proxy([], handler), 'INVALID_JSON');
    blocked(new Proxy(base, handler), [], 'INVALID_JSON');
    blocked(base, [new Proxy(reserve(base), handler)], 'INVALID_JSON');
    const revoked = Proxy.revocable([], handler); revoked.revoke(); blocked(base, revoked.proxy, 'INVALID_JSON');
    expect(trap).not.toHaveBeenCalled();
  });
  it('does not execute user iterators or toJSON methods', () => {
    const fn = vi.fn(() => { throw new Error('MUST NOT RUN'); }), base = original();
    const array = [reserve(base)]; Object.defineProperty(array, Symbol.iterator, { value: fn });
    blocked(base, array, 'INVALID_JSON');
    blocked(base, [{ ...reserve(base), toJSON: fn }], 'INVALID_JSON');
    expect(fn).not.toHaveBeenCalled();
  });
  it.each([
    ['cycle', (event: any) => { event.loop = event; }],
    ['bigint', (event: any) => { event.extra = 1n; }],
    ['nonfinite', (event: any) => { event.extra = Infinity; }],
    ['date', (event: any) => { event.extra = new Date(0); }],
    ['map', (event: any) => { event.extra = new Map(); }],
    ['buffer', (event: any) => { event.extra = Buffer.from('x'); }],
    ['oversized string', (event: any) => { event.extra = 'x'.repeat(16385); }],
    ['oversized nested array', (event: any) => { event.extra = new Array(1001).fill(null); }],
    ['deep nesting', (event: any) => { let node = event; for (let n = 0; n < 70; n++) node = node.extra = {}; }],
    ['prototype key', (event: any) => { Object.defineProperty(event, '__proto__', { value: {}, enumerable: true }); }],
    ['symbol key', (event: any) => { event[Symbol('x')] = 1; }],
    ['undefined', (event: any) => { event.extra = undefined; }],
  ] as const)('uses bounded detached JSON against %s', (_label, mutate) => {
    const base = original(), event = reserve(base); mutate(event); blocked(base, [event], 'INVALID_JSON');
  });
});
