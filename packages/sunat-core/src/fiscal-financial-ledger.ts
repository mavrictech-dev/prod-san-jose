import { types } from 'node:util';
import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import {
  assertFiscalCreditCapacity, fiscalCanonical, fiscalSnapshotSha256, fiscalTimestamp,
  validateFiscalNoteSnapshot, validateFiscalOriginal,
  type FiscalNoteContext, type FiscalNoteSnapshot,
} from './fiscal-note';
import { formatScaled, parseDecimal } from './tax';

/**
 * Server-only, pure BETA simulation. No clock, environment, storage or transport.
 * Flags and hashes are caller assertions, NEVER PKI verification or proof that a
 * CDR is official. Caller must verify CDR bytes/signature, request binding, issuer,
 * document/operation membership, and completeness/concurrency of the history.
 * The existing note validator's narrow PEN/0101/IGV18/mora profile applies; this
 * reducer does not establish tax-catalog, legal, XSD, SEE or production coverage.
 *
 * Replay the whole bounded stream from immutable original snapshots (revision 0).
 * sequence starts at 1 PER ORIGINAL and advances for every unique entry, including
 * rejected/unverified entries. Financial revision/hash advances ONLY on effects.
 * expectedPreviousSha256 is the current financial VERSION hash returned here,
 * not the original or next snapshot hash. No sorting or implicit retry/release.
 * Conflicts block the entire simulation; blocked results contain no partial state.
 * RC2 is only 03, same identity/customer/payment, BEFORE notes or reservations;
 * it replaces a separate financial snapshot and never edits the frozen original.
 * VOID conserves amounts and credits/reservations, marks the active version void,
 * and prevents subsequent effects. Notes themselves cannot be replaced/voided in
 * this profile: documentId always denotes the original 01/03 being reconciled.
 */
export const FISCAL_FINANCIAL_LEDGER_PROFILE = 'FACTUEZ-BETA-FINANCIAL-LEDGER-v1' as const;
export const FISCAL_FINANCIAL_LEDGER_LIMITS = Object.freeze({
  documents: 100, entries: 100, reservations: 100, lines: 100,
  jsonNodes: 150_000, jsonCharacters: 4_000_000, jsonDepth: 24,
  // Individual input decimals, not sums: <=100 debit entries can produce a
  // 14-integer-digit aggregate, still exact bigint, never a JS money number.
  decimalIntegerDigits: 12, moneyScale: 2, quantityScale: 6,
});
export const FISCAL_FINANCIAL_LEDGER_WARNING =
  'SIMULATION ONLY: caller must verify evidence authenticity, CDR signature and official origin, request/operation/document binding, and complete history with atomic reservations. Boolean flags do not prove PKI trust or authorize transmission.';

export type FiscalLedgerReadonly<T> = T extends readonly (infer U)[]
  ? readonly FiscalLedgerReadonly<U>[] : T extends object
    ? { readonly [K in keyof T]: FiscalLedgerReadonly<T[K]> } : T;
export type FiscalLedgerScope = {
  issuerRuc: string; companyId: number; branchId: string; environment: 'BETA';
};
export type FiscalLedgerEvidence = {
  status: 'ACCEPTED' | 'ACCEPTED_WITH_OBSERVATIONS' | 'REJECTED';
  cdrSignatureVerified: boolean; officialCdr: boolean;
  cdrSha256: string; requestSha256: string; responseCode: string; acceptedAt: string;
};
export type FiscalLedgerNotDelivered = {
  status: 'NOT_DELIVERED'; documentId: string; documentTypeCode: '01' | '03';
  fullNumber: string; issuerRuc: string; snapshotSha256: string;
  evidenceId: string; assertedAt: string;
};
type FiscalLedgerEntryBase = FiscalLedgerScope & {
  eventId: string; operationId: string; documentId: string; sequence: number;
  expectedPreviousSha256: string; evidence: FiscalLedgerEvidence;
};
export type FiscalLedgerEntry = FiscalLedgerEntryBase & (
  | { kind: 'NOTE_CREDIT' | 'NOTE_DEBIT'; nextSnapshot: FiscalNoteSnapshot; noteContext: FiscalNoteContext }
  | { kind: 'RC_REPLACE'; nextSnapshot: FiscalDocumentSnapshot }
  | { kind: 'VOID'; nextSnapshot: FiscalDocumentSnapshot; notDelivered: FiscalLedgerNotDelivered }
);
/** Explicit reservations are never released by rejection, missing evidence or VOID. */
export type FiscalLedgerReservation = {
  operationId: string; documentId: string; note: FiscalNoteSnapshot; noteContext: FiscalNoteContext;
};
export type FiscalFinancialLedgerInput = FiscalLedgerReadonly<{
  scope: FiscalLedgerScope; documents: FiscalDocumentSnapshot[]; entries: FiscalLedgerEntry[];
  reservations?: FiscalLedgerReservation[];
}>;
export type FiscalLedgerAmounts = {
  taxableAmount: string; unaffectedAmount: string; igvAmount: string; payableAmount: string;
};
export type FiscalLedgerCreditCapacity = FiscalLedgerAmounts & {
  lines: { originalLineNumber: number; quantity: string; lineExtensionAmount: string; igvAmount: string; totalAmount: string }[];
};
export type FiscalLedgerVersion = {
  revision: number; sha256: string; previousSha256: string | null;
  eventId: string | null; operationId: string | null; kind: 'BASE' | FiscalLedgerEntry['kind'];
  state: 'ACTIVE' | 'VOIDED'; financialSnapshotSha256: string;
  credited: FiscalLedgerAmounts; debited: FiscalLedgerAmounts; net: FiscalLedgerAmounts;
  creditCapacity: FiscalLedgerCreditCapacity;
};
export type FiscalLedgerDocument = {
  documentId: string; originalSnapshot: FiscalDocumentSnapshot; originalSha256: string;
  financialSnapshot: FiscalDocumentSnapshot; lastSequence: number;
  currentVersion: FiscalLedgerVersion; versions: FiscalLedgerVersion[];
};
export type FiscalLedgerEntryResult = {
  eventId: string; operationId: string; documentId: string; sequence: number;
  outcome: 'APPLIED' | 'REJECTED' | 'EVIDENCE_UNVERIFIED' | 'DUPLICATE';
  versionSha256: string; revision: number;
};
export type FiscalLedgerBlockCode =
  | 'INVALID_JSON' | 'LIMIT_EXCEEDED' | 'INVALID_INPUT' | 'INVALID_SCOPE'
  | 'INVALID_SNAPSHOT' | 'INVALID_EVIDENCE' | 'INVALID_NOTE_CONTEXT'
  | 'DUPLICATE_DOCUMENT' | 'UNKNOWN_DOCUMENT' | 'EVENT_CONFLICT' | 'OPERATION_CONFLICT'
  | 'NOTE_CONFLICT' | 'SEQUENCE_MISMATCH' | 'STALE_VERSION' | 'DOCUMENT_VOIDED'
  | 'RC_REPLACE_BLOCKED' | 'IDENTITY_MISMATCH' | 'VOID_BINDING_MISMATCH'
  | 'CREDIT_CAPACITY_EXCEEDED' | 'RESERVATION_CONFLICT';
type FiscalLedgerSimulation = {
  profile: typeof FISCAL_FINANCIAL_LEDGER_PROFILE; simulationOnly: true; persisted: false;
  transmissionAuthorized: false; evidenceAuthenticityVerified: false;
  reservationsReleased: false; warning: typeof FISCAL_FINANCIAL_LEDGER_WARNING;
};
export type FiscalFinancialLedgerProjection = FiscalLedgerReadonly<FiscalLedgerSimulation & (
  | { ok: true; scope: FiscalLedgerScope; documents: FiscalLedgerDocument[]; entries: FiscalLedgerEntryResult[];
      reservations: { operationId: string; documentId: string; noteSha256: string; state: 'RESERVED' | 'CONSUMED' }[] }
  | { ok: false; error: { code: FiscalLedgerBlockCode } }
)>;

class LedgerBlocked extends Error {
  constructor(readonly code: FiscalLedgerBlockCode) { super(code); }
}
function fail(code: FiscalLedgerBlockCode): never { throw new LedgerBlocked(code); }
function check(condition: unknown, code: FiscalLedgerBlockCode): asserts condition { if (!condition) fail(code); }
function checked(code: FiscalLedgerBlockCode, action: () => void): void {
  try { action(); } catch { fail(code); }
}
const SHA = /^[a-f0-9]{64}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Reject proxies BEFORE any reflection, and accessors BEFORE any property read.
 * Copies strict JSON using descriptors, without invoking toJSON or user methods.
 * Frozen objects are valid; undefined (even optional own fields) is NOT JSON.
 */
function copyJson(input: unknown): unknown {
  let nodes = 0, characters = 0;
  const ancestors = new Set<object>();
  function copy(value: unknown, depth: number): unknown {
    check(++nodes <= FISCAL_FINANCIAL_LEDGER_LIMITS.jsonNodes && depth <= FISCAL_FINANCIAL_LEDGER_LIMITS.jsonDepth, 'LIMIT_EXCEEDED');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      characters += value.length;
      check(characters <= FISCAL_FINANCIAL_LEDGER_LIMITS.jsonCharacters, 'LIMIT_EXCEEDED');
      return value;
    }
    if (typeof value === 'number') {
      check(Number.isSafeInteger(value) && !Object.is(value, -0), 'INVALID_JSON'); return value;
    }
    check(typeof value === 'object' && value !== null, 'INVALID_JSON');
    check(!types.isProxy(value), 'INVALID_JSON');
    check(!ancestors.has(value), 'INVALID_JSON');
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    check(array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null, 'INVALID_JSON');
    const keys = Reflect.ownKeys(value);
    check(keys.length <= FISCAL_FINANCIAL_LEDGER_LIMITS.jsonNodes, 'LIMIT_EXCEEDED');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = array ? descriptors.length.value as number : 0;
    if (array) check(length <= 100 && keys.length === length + 1, 'LIMIT_EXCEEDED');
    const result: Record<string, unknown> | unknown[] = array ? [] : {};
    ancestors.add(value);
    for (const key of keys) {
      check(typeof key === 'string', 'INVALID_JSON');
      if (array && key === 'length') continue;
      const descriptor = descriptors[key];
      check(descriptor.enumerable && Object.hasOwn(descriptor, 'value'), 'INVALID_JSON');
      check(!['__proto__', 'constructor', 'prototype'].includes(key), 'INVALID_JSON');
      if (array) check(/^(?:0|[1-9]\d*)$/.test(key) && Number(key) < length, 'INVALID_JSON');
      characters += key.length;
      check(characters <= FISCAL_FINANCIAL_LEDGER_LIMITS.jsonCharacters, 'LIMIT_EXCEEDED');
      Object.defineProperty(result, key, { value: copy(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    ancestors.delete(value); return result;
  }
  return copy(input, 0);
}
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_INPUT');
  check(required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => required.includes(k) || optional.includes(k)), 'INVALID_INPUT');
}
function id(value: unknown): void { check(typeof value === 'string' && ID.test(value), 'INVALID_INPUT'); }
function sha(value: unknown): void { check(typeof value === 'string' && SHA.test(value), 'INVALID_INPUT'); }
function equal(a: unknown, b: unknown): boolean { return fiscalCanonical(a) === fiscalCanonical(b); }
function scope(value: FiscalLedgerScope): void {
  object(value, ['issuerRuc', 'companyId', 'branchId', 'environment']);
  check(value.environment === 'BETA' && /^\d{11}$/.test(value.issuerRuc) &&
    typeof value.issuerRuc === 'string' && Number.isSafeInteger(value.companyId) && value.companyId > 0 &&
    typeof value.branchId === 'string' && ID.test(value.branchId), 'INVALID_SCOPE');
}
function scoped(snapshot: FiscalDocumentSnapshot | FiscalNoteSnapshot, expected: FiscalLedgerScope): void {
  check(snapshot.environment === 'BETA' && snapshot.companyId === expected.companyId && snapshot.branchId === expected.branchId &&
    snapshot.issuer.identityNumber === expected.issuerRuc, 'INVALID_SCOPE');
}
function original(snapshot: FiscalDocumentSnapshot, expected: FiscalLedgerScope): void {
  checked('INVALID_SNAPSHOT', () => validateFiscalOriginal(snapshot, snapshot.issueDate));
  id(snapshot.documentId);
  scoped(snapshot, expected);
}
function evidence(value: FiscalLedgerEvidence, snapshot: FiscalDocumentSnapshot | FiscalNoteSnapshot): void {
  object(value, ['status', 'cdrSignatureVerified', 'officialCdr', 'cdrSha256', 'requestSha256', 'responseCode', 'acceptedAt']);
  check(['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS', 'REJECTED'].includes(value.status) &&
    typeof value.cdrSignatureVerified === 'boolean' && typeof value.officialCdr === 'boolean' &&
    typeof value.cdrSha256 === 'string' && SHA.test(value.cdrSha256) && typeof value.requestSha256 === 'string' && SHA.test(value.requestSha256) &&
    typeof value.responseCode === 'string' && /^\d{1,5}$/.test(value.responseCode) &&
    (value.status === 'REJECTED' ? value.responseCode !== '0' : value.responseCode === '0'), 'INVALID_EVIDENCE');
  checked('INVALID_EVIDENCE', () => fiscalTimestamp(value.acceptedAt, 'acceptedAt'));
  check(Date.parse(value.acceptedAt) >= Date.parse(snapshot.issueDate), 'INVALID_EVIDENCE');
}

type Reservation = FiscalLedgerReservation & { noteSha256: string; state: 'RESERVED' | 'CONSUMED' };
type State = {
  output: FiscalLedgerDocument; credits: FiscalNoteSnapshot[]; debits: FiscalNoteSnapshot[];
  reservations: Reservation[]; notDelivered: FiscalLedgerNotDelivered | null;
  financialAcceptance: FiscalLedgerEvidence | null;
};
const MONEY = ['taxableAmount', 'unaffectedAmount', 'igvAmount', 'payableAmount'] as const;
function amount(snapshot: FiscalDocumentSnapshot | FiscalNoteSnapshot, key: typeof MONEY[number]): bigint {
  return parseDecimal(key === 'unaffectedAmount' && !('unaffectedAmount' in snapshot.totals) ? '0.00' :
    (snapshot.totals as FiscalLedgerAmounts)[key], 2);
}
function sum(notes: FiscalNoteSnapshot[]): FiscalLedgerAmounts {
  return Object.fromEntries(MONEY.map(key => [key, formatScaled(notes.reduce((total, note) => total + amount(note, key), 0n), 2)])) as FiscalLedgerAmounts;
}
function capacity(state: State): FiscalLedgerCreditCapacity {
  const base = state.output.financialSnapshot;
  const notes = [...state.credits, ...state.reservations.filter(r => r.state === 'RESERVED').map(r => r.note)];
  checked('CREDIT_CAPACITY_EXCEEDED', () => assertFiscalCreditCapacity(base, notes));
  return {
    ...Object.fromEntries(MONEY.map(key => [key, formatScaled(amount(base, key) - notes.reduce((total, note) => total + amount(note, key), 0n), 2)])) as FiscalLedgerAmounts,
    lines: base.lines.map(line => {
      const items = notes.flatMap(note => note.lines.filter(l => l.originalLineNumber === line.lineNumber).map(l => ({ note, line: l })));
      const quantity = parseDecimal(line.quantity, 6) - items.filter(i => ['01', '06', '07'].includes(i.note.reasonCode))
        .reduce((total, i) => total + parseDecimal(i.line.quantity, 6), 0n);
      return { originalLineNumber: line.lineNumber, quantity: formatScaled(quantity, 6),
        ...Object.fromEntries((['lineExtensionAmount', 'igvAmount', 'totalAmount'] as const).map(key =>
          [key, formatScaled(parseDecimal(line[key], 2) - items.reduce((total, i) => total + parseDecimal(i.line[key], 2), 0n), 2)])) } as FiscalLedgerCreditCapacity['lines'][number];
    }),
  };
}
function version(state: State, entry?: FiscalLedgerEntry): FiscalLedgerVersion {
  const previous = state.output.versions.at(-1), base = state.output.financialSnapshot;
  const credited = sum(state.credits), debited = sum(state.debits);
  const net = Object.fromEntries(MONEY.map(key => [key, formatScaled(amount(base, key) - parseDecimal(credited[key], 2) + parseDecimal(debited[key], 2), 2)])) as FiscalLedgerAmounts;
  const contents = {
    revision: previous ? previous.revision + 1 : 0, previousSha256: previous?.sha256 ?? null,
    eventId: entry?.eventId ?? null, operationId: entry?.operationId ?? null, kind: entry?.kind ?? 'BASE' as const,
    state: state.notDelivered ? 'VOIDED' as const : 'ACTIVE' as const,
    financialSnapshotSha256: fiscalSnapshotSha256(base), credited, debited, net, creditCapacity: capacity(state),
  };
  // Domain separation, tenant binding and applied-event hashes prevent collisions
  // between equal totals, evidence changes, companies and independent ledgers.
  const sha256 = fiscalSnapshotSha256({ profile: FISCAL_FINANCIAL_LEDGER_PROFILE,
    documentId: base.documentId, issuerRuc: base.issuer.identityNumber, companyId: base.companyId, branchId: base.branchId, environment: base.environment,
    originalSha256: state.output.originalSha256, contents, appliedEntrySha256: entry ? fiscalSnapshotSha256(entry) : null,
    creditSha256s: state.credits.map(fiscalSnapshotSha256), debitSha256s: state.debits.map(fiscalSnapshotSha256),
    reservations: state.reservations.map(r => ({ operationId: r.operationId, noteSha256: r.noteSha256, state: r.state })), notDelivered: state.notDelivered });
  return { ...contents, sha256 };
}
function note(snapshot: FiscalNoteSnapshot, context: FiscalNoteContext, state: State, expected: FiscalLedgerScope,
  self?: Reservation, acceptedAt?: string): void {
  object(context, ['original', 'acceptance', 'asOf', 'creditHistory']);
  object(context.creditHistory, ['complete', 'entries']);
  check(equal(context.original, state.output.financialSnapshot) && context.creditHistory.complete === true &&
    Array.isArray(context.creditHistory.entries), 'INVALID_NOTE_CONTEXT');
  if (state.financialAcceptance) {
    const accepted = state.financialAcceptance;
    check(context.acceptance && context.acceptance.cdrSha256 === accepted.cdrSha256 &&
      context.acceptance.acceptedAt === accepted.acceptedAt && context.acceptance.status === accepted.status &&
      context.acceptance.responseCode === accepted.responseCode && context.acceptance.source?.kind === 'CDR_SUMMARY' &&
      context.acceptance.source.conditionCode === '2', 'INVALID_NOTE_CONTEXT');
  }
  // Context is the note's CREATION history. It can predate other reservations or
  // acceptances; every member must be known, but omitted later members are still
  // included by capacity(). complete:true is not relied on to free any capacity.
  for (const member of context.creditHistory.entries) {
    object(member, ['state', 'note']);
    const accepted = state.credits.some(n => equal(n, member.note));
    const reserved = state.reservations.some(r => r !== self && equal(r.note, member.note));
    check(member.state === 'ACCEPTED' ? accepted : member.state === 'RESERVED' && reserved, 'INVALID_NOTE_CONTEXT');
  }
  checked('INVALID_SNAPSHOT', () => validateFiscalNoteSnapshot(snapshot, context));
  id(snapshot.documentId);
  scoped(snapshot, expected);
  if (acceptedAt) check(Date.parse(acceptedAt) <= Date.parse(context.asOf), 'INVALID_EVIDENCE');
}
function sameIdentity(next: FiscalDocumentSnapshot, current: FiscalDocumentSnapshot): void {
  for (const key of ['documentId', 'documentTypeCode', 'companyId', 'branchId', 'environment', 'series', 'number', 'fullNumber',
    'issueDate', 'currencyCode', 'operationTypeCode', 'issuer', 'customer', 'paymentTerms'] as const)
    check(equal(next[key], current[key]), 'IDENTITY_MISMATCH');
}
function voidBinding(entry: Extract<FiscalLedgerEntry, { kind: 'VOID' }>, state: State): void {
  const current = state.output.financialSnapshot, proof = entry.notDelivered;
  object(proof, ['status', 'documentId', 'documentTypeCode', 'fullNumber', 'issuerRuc', 'snapshotSha256', 'evidenceId', 'assertedAt']);
  check(equal(entry.nextSnapshot, current) && proof.status === 'NOT_DELIVERED' && proof.documentId === current.documentId &&
    proof.documentTypeCode === current.documentTypeCode && proof.fullNumber === current.fullNumber &&
    proof.issuerRuc === current.issuer.identityNumber && proof.snapshotSha256 === fiscalSnapshotSha256(current) &&
    typeof proof.evidenceId === 'string' && ID.test(proof.evidenceId), 'VOID_BINDING_MISMATCH');
  checked('VOID_BINDING_MISMATCH', () => fiscalTimestamp(proof.assertedAt, 'assertedAt'));
  check(Date.parse(proof.assertedAt) >= Date.parse(current.issueDate) && Date.parse(proof.assertedAt) <= Date.parse(entry.evidence.acceptedAt), 'VOID_BINDING_MISMATCH');
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** All failures are bounded typed codes; never return input, stack or raw errors. */
export function projectFiscalFinancialLedger(input: FiscalFinancialLedgerInput): FiscalFinancialLedgerProjection {
  const simulation: FiscalLedgerSimulation = { profile: FISCAL_FINANCIAL_LEDGER_PROFILE, simulationOnly: true,
    persisted: false, transmissionAuthorized: false, evidenceAuthenticityVerified: false, reservationsReleased: false,
    warning: FISCAL_FINANCIAL_LEDGER_WARNING };
  try {
    const data = copyJson(input) as { scope: FiscalLedgerScope; documents: FiscalDocumentSnapshot[]; entries: FiscalLedgerEntry[]; reservations?: FiscalLedgerReservation[] };
    object(data, ['scope', 'documents', 'entries'], ['reservations']); scope(data.scope);
    check(Array.isArray(data.documents) && data.documents.length > 0 && Array.isArray(data.entries) &&
      (data.reservations === undefined || Array.isArray(data.reservations)), 'INVALID_INPUT');
    const states = new Map<string, State>(), numbers = new Set<string>();
    for (const snapshot of data.documents) {
      original(snapshot, data.scope);
      check(!states.has(snapshot.documentId) && !numbers.has(`${snapshot.documentTypeCode}/${snapshot.fullNumber}`), 'DUPLICATE_DOCUMENT');
      numbers.add(`${snapshot.documentTypeCode}/${snapshot.fullNumber}`);
      const output: FiscalLedgerDocument = { documentId: snapshot.documentId, originalSnapshot: snapshot,
        originalSha256: fiscalSnapshotSha256(snapshot), financialSnapshot: snapshot, lastSequence: 0,
        currentVersion: undefined as unknown as FiscalLedgerVersion, versions: [] };
      states.set(snapshot.documentId, { output, credits: [], debits: [], reservations: [], notDelivered: null, financialAcceptance: null });
    }
    const reservations: Reservation[] = [], reservationOperations = new Map<string, Reservation>();
    const noteIds = new Set(states.keys()), noteNumbers = new Set(numbers);
    for (const reserved of data.reservations ?? []) {
      object(reserved, ['operationId', 'documentId', 'note', 'noteContext']); id(reserved.operationId); id(reserved.documentId);
      const state = states.get(reserved.documentId); check(state, 'UNKNOWN_DOCUMENT');
      note(reserved.note, reserved.noteContext, state, data.scope);
      const operationKey = `${reserved.documentId}:${reserved.operationId}`;
      check(reserved.note.documentTypeCode === '07' && !reservationOperations.has(operationKey) &&
        !noteIds.has(reserved.note.documentId) && !noteNumbers.has(`07/${reserved.note.fullNumber}`), 'RESERVATION_CONFLICT');
      const reservation: Reservation = { ...reserved, noteSha256: fiscalSnapshotSha256(reserved.note), state: 'RESERVED' };
      reservations.push(reservation); state.reservations.push(reservation); reservationOperations.set(operationKey, reservation);
      noteIds.add(reserved.note.documentId); noteNumbers.add(`07/${reserved.note.fullNumber}`); capacity(state);
    }
    for (const state of states.values()) { state.output.currentVersion = version(state); state.output.versions.push(state.output.currentVersion); }
    const events = new Map<string, { entry: FiscalLedgerEntry; result: FiscalLedgerEntryResult }>(), operations = new Set<string>();
    const results: FiscalLedgerEntryResult[] = [];
    for (const entry of data.entries) {
      object(entry, ['eventId', 'operationId', 'issuerRuc', 'companyId', 'branchId', 'environment', 'documentId', 'sequence',
        'expectedPreviousSha256', 'nextSnapshot', 'evidence', 'kind'], entry.kind === 'VOID' ? ['notDelivered'] :
        ['NOTE_CREDIT', 'NOTE_DEBIT'].includes(entry.kind) ? ['noteContext'] : []);
      id(entry.eventId); id(entry.operationId); id(entry.documentId); sha(entry.expectedPreviousSha256);
      check(Number.isSafeInteger(entry.sequence) && entry.sequence > 0 && ['NOTE_CREDIT', 'NOTE_DEBIT', 'RC_REPLACE', 'VOID'].includes(entry.kind), 'INVALID_INPUT');
      check(equal({ issuerRuc: entry.issuerRuc, companyId: entry.companyId, branchId: entry.branchId, environment: entry.environment }, data.scope), 'INVALID_SCOPE');
      const state = states.get(entry.documentId); check(state, 'UNKNOWN_DOCUMENT');
      // A single RC/RA result can refer to several originals. Dedupe is per
      // original, never a global claim that suppresses the other batch members.
      const operationKey = `${entry.documentId}:${entry.operationId}`, eventKey = `${entry.documentId}:${entry.eventId}`;
      const self = reservationOperations.get(operationKey);
      const duplicate = events.get(eventKey);
      if (duplicate) {
        // Exact safe-JSON equality implies the previously validated actual shape;
        // altered replay is blocked before hashing or validating against new state.
        check(equal(duplicate.entry, entry), 'EVENT_CONFLICT');
        results.push({ ...duplicate.result, outcome: 'DUPLICATE' }); continue;
      }
      // Validate the actual snapshot BEFORE canonical event hashing, even on replay.
      if (entry.kind === 'NOTE_CREDIT' || entry.kind === 'NOTE_DEBIT') {
        note(entry.nextSnapshot, entry.noteContext, state, data.scope, self, entry.evidence.acceptedAt);
      } else original(entry.nextSnapshot, data.scope);
      evidence(entry.evidence, entry.nextSnapshot);
      check(!operations.has(operationKey), 'OPERATION_CONFLICT');
      check(entry.sequence === state.output.lastSequence + 1, 'SEQUENCE_MISMATCH');
      check(entry.expectedPreviousSha256 === state.output.currentVersion.sha256, 'STALE_VERSION');
      if (self) check(entry.kind === 'NOTE_CREDIT' && self.documentId === entry.documentId &&
        self.noteSha256 === fiscalSnapshotSha256(entry.nextSnapshot), 'RESERVATION_CONFLICT');
      if (entry.kind === 'NOTE_CREDIT' || entry.kind === 'NOTE_DEBIT') {
        check(entry.nextSnapshot.documentTypeCode === (entry.kind === 'NOTE_CREDIT' ? '07' : '08'), 'INVALID_SNAPSHOT');
        check((self && self.note.documentId === entry.nextSnapshot.documentId) || (!noteIds.has(entry.nextSnapshot.documentId) &&
          !noteNumbers.has(`${entry.nextSnapshot.documentTypeCode}/${entry.nextSnapshot.fullNumber}`)), 'NOTE_CONFLICT');
      } else {
        sameIdentity(entry.nextSnapshot, state.output.financialSnapshot);
        if (entry.kind === 'VOID') voidBinding(entry, state);
        else check(state.output.financialSnapshot.documentTypeCode === '03' && !state.credits.length && !state.debits.length && !state.reservations.length, 'RC_REPLACE_BLOCKED');
      }
      let outcome: FiscalLedgerEntryResult['outcome'];
      if (entry.evidence.status === 'REJECTED') outcome = 'REJECTED';
      else if (!entry.evidence.cdrSignatureVerified || !entry.evidence.officialCdr) outcome = 'EVIDENCE_UNVERIFIED';
      else {
        check(state.output.currentVersion.state === 'ACTIVE', 'DOCUMENT_VOIDED');
        if (state.financialAcceptance) check(Date.parse(entry.evidence.acceptedAt) >= Date.parse(state.financialAcceptance.acceptedAt), 'INVALID_EVIDENCE');
        if (entry.kind === 'NOTE_CREDIT' || entry.kind === 'NOTE_DEBIT') {
          noteIds.add(entry.nextSnapshot.documentId); noteNumbers.add(`${entry.nextSnapshot.documentTypeCode}/${entry.nextSnapshot.fullNumber}`);
          if (entry.kind === 'NOTE_CREDIT') { state.credits.push(entry.nextSnapshot); if (self) self.state = 'CONSUMED'; }
          else state.debits.push(entry.nextSnapshot);
        } else if (entry.kind === 'RC_REPLACE') { state.output.financialSnapshot = entry.nextSnapshot; state.financialAcceptance = entry.evidence; }
        else if (entry.kind === 'VOID') state.notDelivered = entry.notDelivered;
        state.output.currentVersion = version(state, entry); state.output.versions.push(state.output.currentVersion); outcome = 'APPLIED';
      }
      state.output.lastSequence = entry.sequence; operations.add(operationKey);
      const result: FiscalLedgerEntryResult = { eventId: entry.eventId, operationId: entry.operationId, documentId: entry.documentId,
        sequence: entry.sequence, outcome, versionSha256: state.output.currentVersion.sha256, revision: state.output.currentVersion.revision };
      events.set(eventKey, { entry, result }); results.push(result);
    }
    return freeze({ ...simulation, ok: true as const, scope: data.scope, documents: [...states.values()].map(s => s.output), entries: results,
      reservations: reservations.map(r => ({ operationId: r.operationId, documentId: r.documentId, noteSha256: r.noteSha256, state: r.state })) });
  } catch (error) {
    return freeze({ ...simulation, ok: false as const, error: { code: error instanceof LedgerBlocked ? error.code : 'INVALID_INPUT' as const } });
  }
}
