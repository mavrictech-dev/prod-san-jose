import { isProxy } from 'node:util/types';
import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import type { FiscalLedgerEvidence } from './fiscal-financial-ledger';
import {
  assertFiscalCreditCapacity, fiscalSnapshotSha256, fiscalTimestamp,
  validateFiscalOriginal, type FiscalNoteSnapshot,
} from './fiscal-note';
import {
  boundedSupplementJson, validateFiscalSupplementCommand, type FiscalSupplementCommand,
} from './fiscal-supplement-command';
import { formatScaled, parseDecimal } from './tax';

export type CorrectionJournalEvent =
  | { kind: 'RESERVE'; command: FiscalSupplementCommand; actorSha256: string }
  | { kind: 'SETTLE'; operationId: string; evidence: FiscalLedgerEvidence };

const PROFILE = 'FACTUEZ-BETA-CORRECTION-JOURNAL-v2' as const;
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
type OperationState = 'RESERVED' | FiscalLedgerEvidence['status'];
type Operation = {
  operationId: string; commandSha256: string; actorSha256: string;
  state: OperationState; noteSha256: string;
};
type Version = { revision: number; sha256: string; previousSha256: string | null };
type Projection = {
  profile: typeof PROFILE; originalSha256: string; headSha256: string; revision: number;
  versions: readonly Readonly<Version>[]; creditHeld: string; debitHeld: string; netAmount: string;
  operations: readonly Readonly<Operation>[]; candidateOnly: true; transmissionAuthorized: false;
};
type Reservation = { operation: Operation; note: FiscalNoteSnapshot; reservedAt: number };

function check(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
function checked<T>(code: string, work: () => T): T {
  try { return work(); } catch { throw new Error(code); }
}
function exact(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key)), 'INVALID_EVENT');
}
function hash(value: unknown): string { return fiscalSnapshotSha256(value); }
function timestamp(value: string, code: string): number {
  checked(code, () => fiscalTimestamp(value, 'journalTime')); return Date.parse(value);
}

/** V1 reconstructs every historical credit in supplied array order. That is
 * inappropriate for a V2 exact-set history: independently reserved snapshots
 * must NOT be rewritten merely because a DB returns equal-date members in a
 * different order. Validate the new note/command using a detached, history-free
 * COPY; the reducer below separately verifies ALL historical snapshots against
 * their already-validated reservations, states, completeness and capacity.
 * Keep and hash the ORIGINAL command, including its envelope hash, history order
 * and corresponding creditHistoryIds. No guard or legacy validator is changed.
 */
function validatedCommand(value: FiscalSupplementCommand): FiscalSupplementCommand {
  return checked('INVALID_COMMAND', () => {
    const validation = boundedSupplementJson(value) as FiscalSupplementCommand;
    const envelope = validation.payload.envelope;
    if (envelope.kind !== 'NOTE') return validateFiscalSupplementCommand(value);
    const originalEnvelope = value.payload.envelope;
    check(originalEnvelope.kind === 'NOTE' && typeof value.payload.envelopeSha256 === 'string' &&
      SHA.test(value.payload.envelopeSha256) && value.payload.envelopeSha256 === hash(originalEnvelope), 'INVALID_COMMAND');
    const history = envelope.context.creditHistory.entries;
    const ids = envelope.note.creditHistoryIds;
    check(Array.isArray(history) && history.length <= 100 && Array.isArray(ids) && ids.length === history.length &&
      history.every((member, index) => member && typeof member === 'object' &&
        ids[index] === member.note?.documentId), 'INVALID_COMMAND');
    envelope.context.creditHistory.entries = [];
    envelope.note.creditHistoryIds = [];
    validation.payload.envelopeSha256 = hash(envelope);
    validateFiscalSupplementCommand(validation);
    return value;
  });
}

/** Inspect only descriptors after rejecting proxies. Copy each bounded event,
 * rather than applying the 512 KiB command budget to the entire history (each
 * later command necessarily carries its complete creation credit history).
 * At most 200 detached events, each <=512 KiB/50k nodes/64 levels; original has
 * the same individual bound. No getters, toJSON, iterators or caller callbacks.
 */
function eventsJson(value: unknown): CorrectionJournalEvent[] {
  check(value !== null && typeof value === 'object' && !isProxy(value) &&
    Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype, 'INVALID_JSON');
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  const length = descriptors.length.value as number;
  check(length <= 200, 'LIMIT_EXCEEDED');
  const keys = Reflect.ownKeys(value);
  check(keys.length === length + 1 && keys.every(key => key === 'length' || typeof key === 'string' &&
    /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < length), 'INVALID_JSON');
  const output: CorrectionJournalEvent[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];
    check(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'), 'INVALID_JSON');
    output.push(checked('INVALID_JSON', () => boundedSupplementJson(descriptor.value)) as CorrectionJournalEvent);
  }
  return output;
}

/**
 * Pure, server-only BETA candidate, not a PKI verifier, fiscal authority or
 * transmission gate. Evidence flags/hashes are assertions from the caller:
 * even true flags NEVER prove authenticity. The owner must verify original,
 * request/operation membership, signed XML/CDR, trust and authoritative complete
 * history, then persist this journal with authorization/CAS atomically.
 *
 * Narrow existing note/command profiles apply (individual F notes; B notes need
 * their separate RC path). No storage, clock, I/O, release, sorting or replay
 * deduplication. Rejected credits keep ALL per-line/quantity reservations. Debits
 * never increase credit capacity. Original and V1 are never changed. Every
 * event, including a rejection, advances an immutable hash-linked version;
 * revision 0 depends ONLY on the original, not on future reservations. Reserve
 * timestamps and note issue dates are monotonic; CDR acceptance timestamps are
 * checked ONLY against their own operation, not append order across operations.
 * A verified owner/asOf boundary must reject future evidence before calling.
 */
export function projectCorrectionJournal(
  original: FiscalDocumentSnapshot, events: readonly CorrectionJournalEvent[],
): Readonly<Projection> {
  const base = checked('INVALID_JSON', () => boundedSupplementJson(original)) as FiscalDocumentSnapshot;
  checked('INVALID_ORIGINAL', () => validateFiscalOriginal(base, base.issueDate));
  check(Number.isSafeInteger(base.companyId) && base.companyId! > 0 &&
    typeof base.branchId === 'string' && UUID.test(base.branchId), 'INVALID_SCOPE');
  const detached = eventsJson(events), originalSha256 = hash(base);
  const reservations = new Map<string, Reservation>();
  const eventIds = new Set<string>(), numbers = new Set<string>();
  const versions: Version[] = [];
  let acceptanceSha256: string | null = null;
  let lastReservationTime = timestamp(base.issueDate, 'INVALID_ORIGINAL'), lastNoteIssue = lastReservationTime;
  let creditHeld = 0n, debitHeld = 0n, netAmount = parseDecimal(base.totals.payableAmount, 2);
  const operations = () => [...reservations.values()].map(value => ({ ...value.operation }));
  const append = (event: CorrectionJournalEvent | null) => {
    const revision = versions.length, previousSha256 = versions.at(-1)?.sha256 ?? null;
    const sha256 = hash({ profile: PROFILE, originalSha256, revision, previousSha256,
      eventSha256: event === null ? null : hash(event), creditHeld: formatScaled(creditHeld, 2),
      debitHeld: formatScaled(debitHeld, 2), netAmount: formatScaled(netAmount, 2), operations: operations() });
    versions.push(Object.freeze({ revision, sha256, previousSha256 }));
  };
  append(null);

  for (const event of detached) {
    if (event?.kind === 'RESERVE') {
      exact(event, ['kind', 'command', 'actorSha256']);
      check(reservations.size < 100, 'LIMIT_EXCEEDED');
      check(typeof event.actorSha256 === 'string' && SHA.test(event.actorSha256), 'INVALID_ACTOR_HASH');
      const command = validatedCommand(event.command);
      const payload = command.payload, envelope = payload.envelope;
      check(payload.operationKind === 'NOTE' && envelope.kind === 'NOTE', 'UNSUPPORTED_OPERATION');
      const { note, context } = envelope;
      check(payload.environment === 'BETA' && payload.companyId === base.companyId &&
        payload.branchId === base.branchId && payload.issuerRuc === base.issuer.identityNumber &&
        hash(context.original) === originalSha256, 'ORIGINAL_MISMATCH');
      const contextAcceptance = hash(context.acceptance);
      check(acceptanceSha256 === null || acceptanceSha256 === contextAcceptance, 'ACCEPTANCE_CONFLICT');
      check(!reservations.has(payload.operationId), 'OPERATION_CONFLICT');
      check(!eventIds.has(command.eventId), 'EVENT_CONFLICT');
      const number = `${note.documentTypeCode}/${note.fullNumber}`;
      check(!numbers.has(number), 'NOTE_CONFLICT');
      const reservedAt = timestamp(command.occurredAt, 'INVALID_CHRONOLOGY');
      const noteIssue = timestamp(note.issueDate, 'INVALID_CHRONOLOGY');
      check(reservedAt >= lastReservationTime && noteIssue >= lastNoteIssue, 'INVALID_CHRONOLOGY');

      // Completeness is relative to this prefix, not a client-supplied flag.
      // A projection may lag a verified acceptance (RESERVED remains valid), but
      // cannot declare ACCEPTED before its own trusted settlement or after reject.
      const credits = [...reservations.values()].filter(value => value.note.documentTypeCode === '07');
      check(context.creditHistory.complete === true && context.creditHistory.entries.length === credits.length,
        'INCOMPLETE_CREDIT_HISTORY');
      const knownCredits = new Map(credits.map(value => [value.note.documentId, value]));
      const seenCredits = new Set<string>();
      for (const member of context.creditHistory.entries) {
        exact(member, ['state', 'note']);
        const known = knownCredits.get(member.note.documentId);
        check(known && !seenCredits.has(member.note.documentId) &&
          hash(member.note) === known.operation.noteSha256, 'CREDIT_HISTORY_CONFLICT');
        seenCredits.add(member.note.documentId);
        check(member.state === 'RESERVED' || member.state === 'ACCEPTED' &&
          ['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS'].includes(known.operation.state), 'UNSETTLED_CREDIT_HISTORY');
      }
      if (note.documentTypeCode === '07') {
        checked('CREDIT_CAPACITY_EXCEEDED', () => assertFiscalCreditCapacity(base, [...credits.map(value => value.note), note]));
        creditHeld += parseDecimal(note.totals.payableAmount, 2);
      } else debitHeld += parseDecimal(note.totals.payableAmount, 2);
      reservations.set(payload.operationId, { note, reservedAt, operation: {
        operationId: payload.operationId, commandSha256: hash(command), actorSha256: event.actorSha256,
        state: 'RESERVED', noteSha256: hash(note),
      } });
      acceptanceSha256 = contextAcceptance;
      eventIds.add(command.eventId); numbers.add(number);
      lastReservationTime = reservedAt; lastNoteIssue = noteIssue;
    } else if (event?.kind === 'SETTLE') {
      exact(event, ['kind', 'operationId', 'evidence']);
      check(typeof event.operationId === 'string' && UUID.test(event.operationId), 'INVALID_OPERATION');
      const reservation = reservations.get(event.operationId);
      check(reservation, 'UNKNOWN_OPERATION');
      check(reservation.operation.state === 'RESERVED', 'ALREADY_SETTLED');
      const evidence = event.evidence;
      exact(evidence, ['status', 'cdrSignatureVerified', 'officialCdr', 'cdrSha256', 'requestSha256', 'responseCode', 'acceptedAt']);
      check(['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS', 'REJECTED'].includes(evidence.status) &&
        evidence.cdrSignatureVerified === true && evidence.officialCdr === true &&
        typeof evidence.cdrSha256 === 'string' && SHA.test(evidence.cdrSha256) &&
        typeof evidence.requestSha256 === 'string' && SHA.test(evidence.requestSha256) &&
        typeof evidence.responseCode === 'string' && /^(?:0|[1-9]\d{0,4})$/.test(evidence.responseCode) &&
        (evidence.status === 'REJECTED' ? Number(evidence.responseCode) >= 2000 : evidence.responseCode === '0'), 'INVALID_EVIDENCE');
      const acceptedAt = timestamp(evidence.acceptedAt, 'INVALID_EVIDENCE');
      check(acceptedAt >= reservation.reservedAt &&
        acceptedAt >= Date.parse(reservation.note.issueDate), 'INVALID_CHRONOLOGY');
      reservation.operation.state = evidence.status;
      if (evidence.status !== 'REJECTED') {
        const amount = parseDecimal(reservation.note.totals.payableAmount, 2);
        netAmount += reservation.note.documentTypeCode === '07' ? -amount : amount;
      }
    } else throw new Error('INVALID_EVENT');
    append(event);
  }
  const head = versions.at(-1)!;
  return Object.freeze({ profile: PROFILE, originalSha256, headSha256: head.sha256, revision: head.revision,
    versions: Object.freeze(versions), creditHeld: formatScaled(creditHeld, 2), debitHeld: formatScaled(debitHeld, 2),
    netAmount: formatScaled(netAmount, 2), operations: Object.freeze(operations().map(value => Object.freeze(value))),
    candidateOnly: true, transmissionAuthorized: false });
}
