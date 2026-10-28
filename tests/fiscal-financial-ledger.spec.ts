import { describe, expect, it, vi } from 'vitest';
import type { FiscalDocumentSnapshot } from '../packages/contracts/src/events';
import { calculateDocumentTotals } from '../packages/sunat-core/src/tax';
import {
  buildFiscalNoteSnapshot, fiscalSnapshotSha256,
  type FiscalAcceptanceEvidence, type FiscalNoteContext, type FiscalNoteInput,
} from '../packages/sunat-core/src/fiscal-note';
import {
  FISCAL_FINANCIAL_LEDGER_LIMITS, FISCAL_FINANCIAL_LEDGER_PROFILE,
  projectFiscalFinancialLedger, type FiscalFinancialLedgerInput, type FiscalFinancialLedgerProjection,
  type FiscalLedgerEntry, type FiscalLedgerReservation, type FiscalLedgerScope,
} from '../packages/sunat-core/src/fiscal-financial-ledger';

// Entirely synthetic, checksum-valid identities; no RUC lookup, CDR bytes,
// certificates, network, DB, Docker, randomness, credentials or wall clock.
const RUC = '20000000001';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AS_OF = '2026-10-04T18:00:00Z';
const SCOPE: FiscalLedgerScope = { issuerRuc: RUC, companyId: 1, branchId: uuid(2), environment: 'BETA' };
type Mutable<T> = T extends readonly (infer U)[] ? Mutable<U>[] : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
const json = <T>(value: T): Mutable<T> => JSON.parse(JSON.stringify(value));
type Fixture = { scope: FiscalLedgerScope; documents: FiscalDocumentSnapshot[]; entries: FiscalLedgerEntry[]; reservations?: FiscalLedgerReservation[] };
function document(type: '01' | '03' = '01', n = 1, quantity = '3', price = '118'): FiscalDocumentSnapshot {
  const series = type === '01' ? 'F001' : 'B001';
  return json({ documentId: uuid(n), companyId: 1, branchId: uuid(2), environment: 'BETA', documentTypeCode: type,
    series, number: String(n), fullNumber: `${series}-${n}`, issueDate: '2026-10-02T16:00:00Z', currencyCode: 'PEN', operationTypeCode: '0101',
    ...(type === '01' ? { paymentTerms: { type: 'CONTADO' as const } } : {}),
    issuer: { identityType: '6', identityNumber: RUC, legalName: 'EMISOR SINTETICO', address: 'Dirección ficticia', ubigeo: '150101', establishmentCode: '0000' },
    customer: type === '01' ? { identityType: '6', identityNumber: RUC, legalName: 'CLIENTE SINTETICO' } :
      { identityType: '1', identityNumber: '12345678', legalName: 'CLIENTE SINTETICO' },
    ...calculateDocumentTotals([{ description: 'Producto sintético', productCode: 'SYNTHETIC', unitCode: 'NIU', quantity,
      unitPriceWithTax: price, taxAffectationCode: '10', igvRate: '18' }]),
  });
}
function context(original: FiscalDocumentSnapshot): FiscalNoteContext {
  const acceptance: FiscalAcceptanceEvidence = { environment: 'BETA', issuerRuc: RUC, documentId: original.documentId,
    documentTypeCode: original.documentTypeCode as '01' | '03', fullNumber: original.fullNumber, snapshotSha256: fiscalSnapshotSha256(original),
    cdrSha256: 'a'.repeat(64), status: 'ACCEPTED', responseCode: '0', acceptedAt: '2026-10-02T16:10:00Z',
    source: original.documentTypeCode === '01' ? { kind: 'CDR_DOCUMENT' } :
      { kind: 'CDR_SUMMARY', identifier: 'RC-20261002-1', referenceDate: '2026-10-02', lineNumber: 1, conditionCode: '1' } };
  return { original, acceptance, asOf: AS_OF, creditHistory: { complete: true, entries: [] } };
}
const creditInput = (quantity = '1'): FiscalNoteInput => ({ documentTypeCode: '07', reasonCode: '07', reasonDescription: 'DEVOLUCION SINTETICA',
  lines: [{ originalLineNumber: 1, quantity }] });
const debitInput: FiscalNoteInput = { documentTypeCode: '08', reasonCode: '02', reasonDescription: 'DELTA SINTETICO',
  lines: [{ originalLineNumber: 1, unitPriceAdjustmentWithTax: '11.8' }] };
function fixture(type: '01' | '03' = '01'): Fixture { return { scope: { ...SCOPE }, documents: [document(type)], entries: [] }; }
function ok(data: FiscalFinancialLedgerInput): Extract<FiscalFinancialLedgerProjection, { ok: true }> {
  const result = projectFiscalFinancialLedger(data); expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Synthetic fixture blocked: ${result.error.code}`);
  return result;
}
function blocked(data: unknown, code?: string): void {
  const result = projectFiscalFinancialLedger(data as FiscalFinancialLedgerInput);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected blocked simulation');
  if (code) expect(result.error.code).toBe(code);
  expect(Object.keys(result).sort()).toEqual(['evidenceAuthenticityVerified', 'error', 'ok', 'persisted', 'profile',
    'reservationsReleased', 'simulationOnly', 'transmissionAuthorized', 'warning'].sort());
  expect(result).toMatchObject({ simulationOnly: true, persisted: false, transmissionAuthorized: false, evidenceAuthenticityVerified: false, reservationsReleased: false });
}
function baseEntry(data: Fixture, n: number, doc = data.documents[0]) {
  const current = ok(data).documents.find(d => d.documentId === doc.documentId)!;
  return { ...data.scope, eventId: uuid(1000 + n), operationId: uuid(2000 + n), documentId: doc.documentId,
    sequence: current.lastSequence + 1, expectedPreviousSha256: current.currentVersion.sha256,
    evidence: { status: 'ACCEPTED' as const, cdrSignatureVerified: true, officialCdr: true, cdrSha256: 'b'.repeat(64),
      requestSha256: 'c'.repeat(64), responseCode: '0', acceptedAt: '2026-10-03T18:00:00Z' } };
}
function noteEntry(data: Fixture, n: number, input = creditInput(), suppliedContext?: FiscalNoteContext, doc = data.documents[0]): FiscalLedgerEntry {
  const noteContext = suppliedContext ?? context(json(ok(data).documents.find(d => d.documentId === doc.documentId)!.financialSnapshot));
  let issueDate = '2026-10-02T17:00:00Z';
  const rc = data.entries.findLast(e => e.documentId === doc.documentId && e.kind === 'RC_REPLACE' &&
    e.evidence.status !== 'REJECTED' && e.evidence.cdrSignatureVerified && e.evidence.officialCdr);
  if (rc && !suppliedContext) {
    Object.assign(noteContext.acceptance, { status: rc.evidence.status, cdrSha256: rc.evidence.cdrSha256, acceptedAt: rc.evidence.acceptedAt,
      source: { kind: 'CDR_SUMMARY', identifier: 'RC-20261003-1', referenceDate: '2026-10-02', lineNumber: 1, conditionCode: '2' } });
    issueDate = '2026-10-03T18:00:00Z';
  }
  return { ...baseEntry(data, n, doc), kind: input.documentTypeCode === '07' ? 'NOTE_CREDIT' : 'NOTE_DEBIT', noteContext,
    nextSnapshot: json(buildFiscalNoteSnapshot(noteContext, input, { documentId: uuid(100 + n), series: doc.documentTypeCode === '01' ? 'FN01' : 'BN01',
      number: String(n), issueDate })) };
}
function replacement(data: Fixture, n = 1, price = '59'): FiscalLedgerEntry {
  const current = json(ok(data).documents[0].financialSnapshot);
  return { ...baseEntry(data, n), kind: 'RC_REPLACE', nextSnapshot: { ...current,
    ...calculateDocumentTotals(current.lines.map(line => ({ ...line, unitPriceWithTax: price }))) } };
}
function voidEntry(data: Fixture, n = 1): FiscalLedgerEntry {
  const nextSnapshot = json(ok(data).documents[0].financialSnapshot);
  return { ...baseEntry(data, n), kind: 'VOID', nextSnapshot, notDelivered: { status: 'NOT_DELIVERED', documentId: nextSnapshot.documentId,
    documentTypeCode: nextSnapshot.documentTypeCode as '01' | '03', fullNumber: nextSnapshot.fullNumber, issuerRuc: RUC,
    snapshotSha256: fiscalSnapshotSha256(nextSnapshot), evidenceId: uuid(900 + n), assertedAt: '2026-10-03T16:00:00Z' } };
}
function reserve(data: Fixture, n = 1, suppliedContext?: FiscalNoteContext): FiscalLedgerReservation {
  const e = noteEntry(data, n, creditInput(), suppliedContext);
  if (e.kind !== 'NOTE_CREDIT') throw new Error('Synthetic credit required');
  const r = { operationId: e.operationId, documentId: e.documentId, note: e.nextSnapshot, noteContext: e.noteContext };
  data.reservations = [...data.reservations ?? [], r]; return r;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

describe('versioned pure financial ledger BETA', () => {
  it('is deterministic, frozen, server-hashed, explicit simulation with no clock/network use', () => {
    const f = deepFreeze(fixture()), before = JSON.stringify(f);
    const now = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('CLOCK FORBIDDEN'); });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('NETWORK FORBIDDEN'); });
    let first: FiscalFinancialLedgerProjection;
    try { first = projectFiscalFinancialLedger(f); expect(projectFiscalFinancialLedger(f)).toEqual(first); expect(now).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); }
    finally { now.mockRestore(); fetch.mockRestore(); }
    const result = ok(f), d = result.documents[0];
    expect(result).toMatchObject({ profile: FISCAL_FINANCIAL_LEDGER_PROFILE, simulationOnly: true, persisted: false,
      transmissionAuthorized: false, evidenceAuthenticityVerified: false, reservationsReleased: false });
    expect(result.warning).toContain('Boolean flags do not prove PKI trust');
    expect(d.currentVersion).toMatchObject({ revision: 0, previousSha256: null, state: 'ACTIVE', net: { payableAmount: '354.00' } });
    expect(d.currentVersion.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(d.currentVersion.sha256).not.toBe(d.originalSha256);
    expect(d.originalSha256).toBe(fiscalSnapshotSha256(f.documents[0]));
    expect(d.originalSnapshot).not.toBe(f.documents[0]);
    expect(Object.isFrozen(d.originalSnapshot.lines[0])).toBe(true); expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(f)).toBe(before);
  });
  it('canonical hashes ignore key insertion order but preserve array order and tenant binding', () => {
    const f = fixture(); const reordered = { entries: f.entries, documents: f.documents, scope: { environment: 'BETA' as const,
      branchId: SCOPE.branchId, companyId: 1, issuerRuc: RUC } };
    expect(ok(reordered)).toEqual(ok(f));
    const changed = json(f); changed.scope.companyId = 2; changed.documents[0].companyId = 2;
    expect(ok(changed).documents[0].currentVersion.sha256).not.toBe(ok(f).documents[0].currentVersion.sha256);
  });
  it('credits net against original and debits add net without increasing refund capacity', () => {
    const f = fixture(), originalHash = fiscalSnapshotSha256(f.documents[0]);
    f.entries.push(noteEntry(f, 1)); const afterCredit = ok(f).documents[0];
    expect(afterCredit.currentVersion).toMatchObject({ credited: { payableAmount: '118.00' }, net: { taxableAmount: '200.00', igvAmount: '36.00', payableAmount: '236.00' },
      creditCapacity: { payableAmount: '236.00', lines: [{ quantity: '2.000000' }] } });
    f.entries.push(noteEntry(f, 2, debitInput)); const afterDebit = ok(f).documents[0];
    expect(afterDebit.currentVersion).toMatchObject({ revision: 2, debited: { payableAmount: '35.40' }, net: { payableAmount: '271.40' } });
    expect(afterDebit.currentVersion.creditCapacity).toEqual(afterCredit.currentVersion.creditCapacity);
    expect(afterDebit.versions[2].previousSha256).toBe(afterDebit.versions[1].sha256);
    expect(afterDebit.originalSha256).toBe(originalHash); expect(afterDebit.originalSnapshot).toEqual(f.documents[0]);
  });
  it('replays effects from a deeply frozen input without editing documents, entries or contexts', () => {
    const f = fixture('03'); f.entries.push(replacement(f)); f.entries.push(noteEntry(f, 2)); f.entries.push(voidEntry(f, 3));
    const before = JSON.stringify(f); deepFreeze(f); const result = ok(f);
    expect(result.documents[0].currentVersion).toMatchObject({ revision: 3, state: 'VOIDED', net: { payableAmount: '118.00' } });
    expect(JSON.stringify(f)).toBe(before);
  });
  it('supports known creation histories using existing pure note validation', () => {
    const f = fixture(), first = noteEntry(f, 1); f.entries.push(first);
    if (first.kind !== 'NOTE_CREDIT') throw new Error('Fixture');
    const ctx = context(f.documents[0]); ctx.creditHistory.entries.push({ state: 'ACCEPTED', note: first.nextSnapshot });
    f.entries.push(noteEntry(f, 2, creditInput(), ctx)); expect(ok(f).documents[0].currentVersion.net.payableAmount).toBe('118.00');
  });
  it('exact event duplicates are idempotent even after later versions; altered replay is atomic failure', () => {
    const f = fixture(), first = noteEntry(f, 1); f.entries.push(first); f.entries.push(noteEntry(f, 2, debitInput));
    const before = ok(f).documents; f.entries.push(json(first)); const result = ok(f);
    expect(result.entries.map(e => e.outcome)).toEqual(['APPLIED', 'APPLIED', 'DUPLICATE']); expect(result.documents).toEqual(before);
    f.entries[2].evidence.cdrSha256 = 'd'.repeat(64); blocked(f, 'EVENT_CONFLICT');
  });
  it.each(['REJECTED', 'unsigned', 'unofficial'] as const)('%s has no effects and does not release explicit reservations', mode => {
    const f = fixture(), reservation = reserve(f), initial = ok(f).documents[0].currentVersion;
    const e = noteEntry(f, 1); e.operationId = reservation.operationId;
    if (mode === 'REJECTED') { e.evidence.status = 'REJECTED'; e.evidence.responseCode = '2335'; }
    if (mode === 'unsigned') e.evidence.cdrSignatureVerified = false;
    if (mode === 'unofficial') e.evidence.officialCdr = false;
    f.entries.push(e, json(e)); const result = ok(f);
    expect(result.documents[0].currentVersion).toEqual(initial); expect(result.documents[0].lastSequence).toBe(1);
    expect(result.reservations[0].state).toBe('RESERVED'); expect(result.entries[1].outcome).toBe('DUPLICATE');
    expect(result.entries[0].outcome).toBe(mode === 'REJECTED' ? 'REJECTED' : 'EVIDENCE_UNVERIFIED');
  });
  it('accepted observations apply and consume the matching reservation exactly once', () => {
    const f = fixture(), reservation = reserve(f); const initial = ok(f).documents[0].currentVersion.creditCapacity;
    const e = noteEntry(f, 1); e.operationId = reservation.operationId; e.evidence.status = 'ACCEPTED_WITH_OBSERVATIONS'; f.entries.push(e, json(e));
    const result = ok(f); expect(result.reservations[0].state).toBe('CONSUMED');
    expect(result.documents[0].currentVersion.creditCapacity).toEqual(initial);
    expect(result.documents[0].currentVersion.credited.payableAmount).toBe('118.00');
  });
  it('preserves concurrent reservation capacity and accepts notes with their creation histories', () => {
    const f = fixture(), one = reserve(f, 1), ctx = context(f.documents[0]); ctx.creditHistory.entries.push({ state: 'RESERVED', note: one.note });
    const two = reserve(f, 2, ctx); const initial = ok(f).documents[0].currentVersion.creditCapacity;
    const first = noteEntry(f, 1); first.operationId = one.operationId; f.entries.push(first);
    const second = noteEntry(f, 2, creditInput(), ctx); second.operationId = two.operationId; f.entries.push(second);
    expect(ok(f).reservations.map(r => r.state)).toEqual(['CONSUMED', 'CONSUMED']);
    expect(ok(f).documents[0].currentVersion.creditCapacity).toEqual(initial);
  });
  it('rejected entries consume ordering but not financial revisions; fresh operations may follow', () => {
    const f = fixture(), e = noteEntry(f, 1); e.evidence.status = 'REJECTED'; e.evidence.responseCode = '2335'; f.entries.push(e);
    f.entries.push(noteEntry(f, 2)); const result = ok(f); expect(result.documents[0]).toMatchObject({ lastSequence: 2, currentVersion: { revision: 1 } });
  });
  it.each(['NOTE_CREDIT', 'NOTE_DEBIT', 'RC_REPLACE', 'VOID'] as const)('rejection and unverified evidence leave %s effects unapplied', kind => {
    for (const unverified of [false, true]) {
      const f = fixture('03'), initial = ok(f).documents[0];
      const e = kind === 'VOID' ? voidEntry(f) : kind === 'RC_REPLACE' ? replacement(f) : noteEntry(f, 1, kind === 'NOTE_DEBIT' ? debitInput : creditInput());
      if (unverified) e.evidence.officialCdr = false;
      else { e.evidence.status = 'REJECTED'; e.evidence.responseCode = '2335'; }
      f.entries.push(e); const result = ok(f);
      expect(result.documents[0].versions).toEqual(initial.versions);
      expect(result.documents[0].financialSnapshot).toEqual(initial.financialSnapshot);
      expect(result.entries[0].outcome).toBe(unverified ? 'EVIDENCE_UNVERIFIED' : 'REJECTED');
    }
  });
  it('reservation ownership, identity and snapshot conflicts block the whole simulation', () => {
    const f = fixture(), r = reserve(f); const e = noteEntry(f, 1);
    if (e.kind !== 'NOTE_CREDIT') throw new Error('Fixture');
    e.nextSnapshot = json(buildFiscalNoteSnapshot(e.noteContext, creditInput('2'), { documentId: uuid(101), series: 'FN01', number: '1', issueDate: '2026-10-02T17:00:00Z' }));
    f.entries.push(e); blocked(f, 'RESERVATION_CONFLICT');
    const g = fixture(); g.reservations = [r, json(r)]; blocked(g, 'RESERVATION_CONFLICT');
  });
  it.each(['credit', 'reserved', 'debit'] as const)('blocks RC2 after %s activity', mode => {
    const f = fixture('03'), rc = replacement(f); if (mode === 'reserved') reserve(f);
    else f.entries.push(noteEntry(f, 1, mode === 'debit' ? debitInput : creditInput()));
    const current = ok(f).documents[0]; rc.sequence = current.lastSequence + 1; rc.expectedPreviousSha256 = current.currentVersion.sha256;
    rc.eventId = uuid(1009); rc.operationId = uuid(2009); f.entries.push(rc); blocked(f, 'RC_REPLACE_BLOCKED');
  });
  it('RC2 changes only the separate financial version; later notes bind the accepted financial snapshot', () => {
    const f = fixture('03'), frozenOriginal = json(f.documents[0]); f.entries.push(replacement(f));
    let d = ok(f).documents[0]; expect(d.originalSnapshot).toEqual(frozenOriginal); expect(d.financialSnapshot.totals.payableAmount).toBe('177.00');
    expect(d.currentVersion.creditCapacity.payableAmount).toBe('177.00'); f.entries.push(noteEntry(f, 2));
    d = ok(f).documents[0]; expect(d.currentVersion.net.payableAmount).toBe('118.00'); expect(d.originalSnapshot).toEqual(frozenOriginal);
  });
  it.each(['cdrSha256', 'acceptedAt', 'status', 'source'] as const)('post-RC2 notes must bind version acceptance %s', field => {
    const f = fixture('03'); f.entries.push(replacement(f)); const e = noteEntry(f, 2);
    if (e.kind !== 'NOTE_CREDIT') throw new Error('Fixture');
    if (field === 'source' && e.noteContext.acceptance.source.kind === 'CDR_SUMMARY') e.noteContext.acceptance.source.conditionCode = '1';
    else if (field === 'status') e.noteContext.acceptance.status = 'ACCEPTED_WITH_OBSERVATIONS';
    else if (field === 'acceptedAt') e.noteContext.acceptance.acceptedAt = '2026-10-02T16:10:00Z';
    else e.noteContext.acceptance.cdrSha256 = 'f'.repeat(64);
    f.entries.push(e); blocked(f, 'INVALID_NOTE_CONTEXT');
  });
  it('later RC2/VOID acceptance cannot precede the financial version it references', () => {
    const f = fixture('03'); f.entries.push(replacement(f)); const e = voidEntry(f, 2);
    e.evidence.acceptedAt = '2026-10-03T17:00:00Z'; f.entries.push(e); blocked(f, 'INVALID_EVIDENCE');
  });
  it('RC2 on a factura fails closed', () => { const f = fixture(); f.entries.push(replacement(f)); blocked(f, 'RC_REPLACE_BLOCKED'); });
  it.each(['documentId', 'fullNumber', 'customer', 'issuer', 'issueDate', 'paymentTerms'] as const)('RC2 preserves identity field %s', field => {
    const f = fixture('03'), e = replacement(f) as any;
    if (field === 'customer') e.nextSnapshot.customer.legalName = 'OTRO CLIENTE';
    else if (field === 'issuer') e.nextSnapshot.issuer.legalName = 'OTRO EMISOR';
    else if (field === 'documentId') e.nextSnapshot.documentId = uuid(888);
    else if (field === 'fullNumber') { e.nextSnapshot.number = '99'; e.nextSnapshot.fullNumber = 'B001-99'; }
    else if (field === 'paymentTerms') e.nextSnapshot.paymentTerms = { type: 'CONTADO' };
    else e.nextSnapshot.issueDate = '2026-10-02T15:00:00Z';
    f.entries.push(e); blocked(f, 'IDENTITY_MISMATCH');
  });
  it.each(['01', '03'] as const)('VOID %s preserves monetary values, original, history and reservations', type => {
    const f = fixture(type), reservation = reserve(f); const initial = ok(f).documents[0]; f.entries.push(voidEntry(f, 10));
    const result = ok(f), d = result.documents[0]; expect(d.currentVersion.state).toBe('VOIDED');
    expect(d.currentVersion.net).toEqual(initial.currentVersion.net); expect(d.financialSnapshot).toEqual(initial.financialSnapshot);
    expect(d.originalSnapshot).toEqual(f.documents[0]); expect(d.currentVersion.creditCapacity).toEqual(initial.currentVersion.creditCapacity);
    expect(result.reservations[0]).toMatchObject({ operationId: reservation.operationId, state: 'RESERVED' });
    f.entries.push(noteEntry(f, 2)); blocked(f, 'DOCUMENT_VOIDED');
  });
  it('VOID of an RC2 version requires linkage to the current financial snapshot', () => {
    const f = fixture('03'), originalHash = fiscalSnapshotSha256(f.documents[0]); f.entries.push(replacement(f)); const e = voidEntry(f, 2) as any;
    e.notDelivered.snapshotSha256 = originalHash; f.entries.push(e); blocked(f, 'VOID_BINDING_MISMATCH');
  });
  it.each(['missing', 'status', 'documentId', 'documentTypeCode', 'fullNumber', 'issuerRuc', 'snapshotSha256', 'evidenceId', 'assertedAt', 'amounts'] as const)
    ('VOID blocks missing or mismatched notDelivered metadata: %s', field => {
      const f = fixture(), e = voidEntry(f) as any;
      if (field === 'missing') delete e.notDelivered;
      else if (field === 'amounts') { e.nextSnapshot = document('01', 1, '3', '59'); }
      else if (field === 'assertedAt') e.notDelivered.assertedAt = '2026-10-05T00:00:00Z';
      else e.notDelivered[field] = field === 'documentTypeCode' ? '03' : 'WRONG';
      f.entries.push(e); blocked(f);
    });
  it.each(['sequence-gap', 'sequence-repeat', 'stale', 'operation', 'prod', 'crossRuc', 'company', 'branch', 'unknown', 'order'] as const)
    ('blocks conflict or wrong scope/order: %s', violation => {
      const f = fixture(), first = noteEntry(f, 1); f.entries.push(first); const e = noteEntry(f, 2, debitInput);
      switch (violation) {
        case 'sequence-gap': e.sequence = 3; break; case 'sequence-repeat': e.sequence = 1; break;
        case 'stale': e.expectedPreviousSha256 = first.expectedPreviousSha256; break;
        case 'operation': e.operationId = first.operationId; break; case 'prod': e.environment = 'PRODUCTION' as never; break;
        case 'crossRuc': e.issuerRuc = '20000000010'; break; case 'company': e.companyId = 2; break;
        case 'branch': e.branchId = uuid(888); break; case 'unknown': e.documentId = uuid(999); break;
        case 'order': f.entries = [e, first]; blocked(f, 'SEQUENCE_MISMATCH'); return;
      }
      f.entries.push(e); blocked(f);
    });
  it('operations cannot retry with changed evidence under a new event ID', () => {
    const f = fixture(), e = noteEntry(f, 1); e.evidence.officialCdr = false; f.entries.push(e);
    const retry = json(e); retry.eventId = uuid(1999); retry.sequence = 2; retry.evidence.officialCdr = true; f.entries.push(retry); blocked(f, 'OPERATION_CONFLICT');
  });
  it('same note identity cannot produce a second effect under a new operation', () => {
    const f = fixture(), e = noteEntry(f, 1); f.entries.push(e); const another = { ...json(e), ...baseEntry(f, 2) }; f.entries.push(another); blocked(f, 'NOTE_CONFLICT');
  });
  it.each(['cdrSha256', 'requestSha256', 'responseCode', 'acceptedAt', 'status', 'cdrSignatureVerified', 'officialCdr'] as const)('rejects malformed evidence %s', field => {
    const f = fixture(), e = noteEntry(f, 1) as any; e.evidence[field] = field === 'responseCode' ? '1' : field === 'acceptedAt' ? '2026-02-30T16:00:00Z' : 'INVALID';
    f.entries.push(e); blocked(f, 'INVALID_EVIDENCE');
  });
  it('accepted evidence changes the version hash even when the monetary effect is equal', () => {
    const f = fixture(); f.entries.push(noteEntry(f, 1)); const other = json(f); other.entries[0].evidence.requestSha256 = 'f'.repeat(64);
    expect(ok(other).documents[0].currentVersion.sha256).not.toBe(ok(f).documents[0].currentVersion.sha256);
  });
  it.each(['total', 'base', 'tax', 'quantity', 'reserve'] as const)('blocks excess credits independently: %s', violation => {
    const f = fixture();
    // Existing note builder proves the single note; combined capacity is checked
    // independently from caller's historical complete:true assertion.
    if (violation === 'reserve') { reserve(f, 1); f.entries.push(noteEntry(f, 2, creditInput('2.1'))); }
    else if (violation === 'quantity' || violation === 'base' || violation === 'tax') {
      const price = violation === 'quantity' ? '0.01' : violation === 'base' ? '0.02' : '0.04';
      f.documents = [document('01', 1, '3', price)];
      for (let n = 1; n <= 3; n++) f.entries.push(noteEntry(f, n, creditInput(violation === 'quantity' ? '1.01' : '1')));
    } else {
      f.entries.push(noteEntry(f, 1, creditInput('2'))); f.entries.push(noteEntry(f, 2, creditInput('2')));
    }
    blocked(f, 'CREDIT_CAPACITY_EXCEEDED');
  });
  it('does not borrow debit value to expand credit capacity', () => {
    const f = fixture(); f.entries.push(noteEntry(f, 1, { ...debitInput, lines: [{ originalLineNumber: 1, unitPriceAdjustmentWithTax: '118' }] } as FiscalNoteInput));
    f.entries.push(noteEntry(f, 2, creditInput('2'))); f.entries.push(noteEntry(f, 3, creditInput('2'))); blocked(f, 'CREDIT_CAPACITY_EXCEEDED');
  });
  it('does not borrow unused capacity from another original line', () => {
    const f = fixture(), first = f.documents[0].lines[0];
    Object.assign(f.documents[0], json(calculateDocumentTotals([first, { ...first, description: 'Otra línea sintética', quantity: '100' }])));
    f.entries.push(noteEntry(f, 1, creditInput('2'))); f.entries.push(noteEntry(f, 2, creditInput('2')));
    blocked(f, 'CREDIT_CAPACITY_EXCEEDED');
  });
  it('price reductions reconcile value without falsely consuming returned quantity', () => {
    const f = fixture(); f.entries.push(noteEntry(f, 1, { documentTypeCode: '07', reasonCode: '09', reasonDescription: 'DELTA SINTETICO',
      lines: [{ originalLineNumber: 1, unitPriceAdjustmentWithTax: '11.8' }] }));
    expect(ok(f).documents[0].currentVersion).toMatchObject({ credited: { payableAmount: '35.40' }, creditCapacity: { payableAmount: '318.60', lines: [{ quantity: '3.000000' }] } });
    f.entries.push(noteEntry(f, 2)); blocked(f, 'CREDIT_CAPACITY_EXCEEDED');
  });
  it('full accepted credit exhausts original value and quantity', () => {
    const f = fixture(); f.entries.push(noteEntry(f, 1, { documentTypeCode: '07', reasonCode: '06', reasonDescription: 'DEVOLUCION TOTAL' }));
    expect(ok(f).documents[0].currentVersion).toMatchObject({ net: { payableAmount: '0.00' }, creditCapacity: { payableAmount: '0.00', lines: [{ quantity: '0.000000' }] } });
  });
  it('explicit mora debit keeps unaffected base separate and leaves credit capacity unchanged', () => {
    const f = fixture(), initial = ok(f).documents[0].currentVersion.creditCapacity;
    f.entries.push(noteEntry(f, 1, { documentTypeCode: '08', reasonCode: '01', reasonDescription: 'MORA SINTETICA', interestNature: 'MORATORIO',
      interestBasis: 'BASE SINTETICA DECLARADA', lines: [{ originalLineNumber: 1, interestAmount: '12.34' }] }));
    expect(ok(f).documents[0].currentVersion).toMatchObject({ net: { unaffectedAmount: '12.34', payableAmount: '366.34' }, creditCapacity: initial });
  });
  it('uses exact bigint cents and six-place quantities at rounding and large-number boundaries', () => {
    const f = fixture(); f.documents = [document('01', 1, '0.1', '11.8')];
    for (let n = 1; n <= 3; n++) f.entries.push(noteEntry(f, n, creditInput('0.033333')));
    expect(ok(f).documents[0].currentVersion).toMatchObject({ net: { payableAmount: '0.01', taxableAmount: '0.01', igvAmount: '0.00' },
      creditCapacity: { lines: [{ quantity: '0.000001' }] } });
    const large = fixture(); large.documents = [document('01', 1, '1000000', '999999')];
    large.entries.push(noteEntry(large, 1, creditInput('1.000001')));
    expect(ok(large).documents[0].currentVersion.net.payableAmount).toBe('999998000000.00');
  });
  it.each(['negative', 'exponent', 'too-many-decimals', 'too-many-digits', 'number', 'unknown-total', 'unknown-line', 'wrong-sum', 'credit', 'production'] as const)
    ('strict actual original snapshot rejects %s', violation => {
      const f = fixture(), d = f.documents[0] as any;
      switch (violation) {
        case 'negative': d.lines[0].quantity = '-1'; break; case 'exponent': d.lines[0].quantity = '1e3'; break;
        case 'too-many-decimals': d.lines[0].quantity = '1.0000001'; break; case 'too-many-digits': d.lines[0].quantity = '1000000000000'; break;
        case 'number': d.totals.payableAmount = 354; break; case 'unknown-total': d.totals.secret = 'NEVER EXPOSE'; break;
        case 'unknown-line': d.lines[0].ciphertext = 'NEVER EXPOSE'; break; case 'wrong-sum': d.totals.igvAmount = '55.00'; break;
        case 'credit': d.paymentTerms = { type: 'CREDITO', pendingAmount: '354', currencyCode: 'PEN', installments: [] }; break;
        case 'production': d.environment = 'PRODUCTION'; break;
      }
      blocked(f, 'INVALID_SNAPSHOT');
    });
  it.each(['note-total', 'reference', 'original', 'profile', 'tax', 'unknown-history', 'unknown-fields', 'missing-context'] as const)
    ('strict note snapshot/context rejects %s before applying', violation => {
      const f = fixture(), e = noteEntry(f, 1) as any;
      switch (violation) {
        case 'note-total': e.nextSnapshot.totals.payableAmount = '117.00'; break;
        case 'reference': e.nextSnapshot.reference.snapshotSha256 = 'f'.repeat(64); break;
        case 'original': e.noteContext.original = document('01', 1, '3', '59'); break;
        case 'profile': e.nextSnapshot.profile = 'LEGAL-ALL-TAXES'; break;
        case 'tax': e.nextSnapshot.lines[0].taxAffectationCode = '20'; break;
        case 'unknown-history': e.noteContext.creditHistory.entries.push({ state: 'ACCEPTED', note: e.nextSnapshot }); break;
        case 'unknown-fields': e.nextSnapshot.secretKey = 'NEVER EXPOSE'; break;
        case 'missing-context': delete e.noteContext; break;
      }
      f.entries.push(e); blocked(f);
    });
  it('scope/document duplicates and incomplete frozen scope fail closed', () => {
    const f = fixture(); f.documents.push(json(f.documents[0])); blocked(f, 'DUPLICATE_DOCUMENT');
    const g = fixture(); delete g.documents[0].companyId; blocked(g, 'INVALID_SCOPE');
    const h = fixture(); h.documents[0].branchId = uuid(333); blocked(h, 'INVALID_SCOPE');
  });
  it('rejects production scope, upper-case UUID aliases, mismatched note kinds and duplicate numbers', () => {
    const f = fixture(); f.scope.environment = 'PRODUCTION' as never; blocked(f, 'INVALID_SCOPE');
    const g = fixture(); g.documents[0].documentId = 'abcdef01-0000-4000-8000-000000000001'.toUpperCase(); blocked(g, 'INVALID_INPUT');
    const h = fixture(), e = noteEntry(h, 1); e.kind = 'NOTE_DEBIT'; h.entries.push(e); blocked(h, 'INVALID_SNAPSHOT');
    const j = fixture(), another = json(j.documents[0]); another.documentId = uuid(3); j.documents.push(another); blocked(j, 'DUPLICATE_DOCUMENT');
  });
  it('supports independent ordered streams for multiple documents under one issuer', () => {
    const f = fixture(); f.documents.push(document('01', 3)); f.entries.push(noteEntry(f, 1));
    f.entries.push(noteEntry(f, 2, creditInput(), undefined, f.documents[1]));
    expect(ok(f).documents.map(d => [d.lastSequence, d.currentVersion.net.payableAmount])).toEqual([[1, '236.00'], [1, '236.00']]);
  });
  it('batch parent event and operation IDs are deduplicated independently per original', () => {
    const f = fixture(); f.documents.push(document('01', 3));
    const first = noteEntry(f, 1); f.entries.push(first);
    const second = noteEntry(f, 2, creditInput(), undefined, f.documents[1]);
    second.eventId = first.eventId; second.operationId = first.operationId;
    f.entries.push(second, json(first), json(second));
    const result = ok(f);
    expect(result.documents.map(d => [d.lastSequence, d.currentVersion.net.payableAmount])).toEqual([[1, '236.00'], [1, '236.00']]);
    expect(result.entries.map(e => e.outcome)).toEqual(['APPLIED', 'APPLIED', 'DUPLICATE', 'DUPLICATE']);
  });
  it('a changed replay still blocks its own member without affecting other batch members', () => {
    const f = fixture(); f.documents.push(document('01', 3));
    const first = noteEntry(f, 1); f.entries.push(first);
    const second = noteEntry(f, 2, creditInput(), undefined, f.documents[1]);
    second.eventId = first.eventId; second.operationId = first.operationId; f.entries.push(second);
    const changed = json(second); changed.evidence.cdrSha256 = 'f'.repeat(64); f.entries.push(changed);
    blocked(f, 'EVENT_CONFLICT');
  });
  it.each(['proxy', 'root-proxy', 'array-proxy', 'revoked-proxy', 'getter', 'toJSON', 'cycle', 'date', 'map', 'class', 'symbol', 'hidden', 'undefined', 'bigint', 'NaN', 'fraction', 'negative-zero', 'sparse', 'array-field'] as const)
    ('rejects non-JSON %s without executing user hooks or exposing raw errors', kind => {
      const f = fixture() as any; let calls = 0;
      const trap = () => { calls++; throw new Error('SECRET_KEY_CIPHERTEXT_RAW'); };
      switch (kind) {
        case 'proxy': f.documents[0].issuer = new Proxy(f.documents[0].issuer, { get: trap, ownKeys: trap, getPrototypeOf: trap }); break;
        case 'root-proxy': {
          const root = new Proxy(f, { get: trap, ownKeys: trap, getPrototypeOf: trap }); blocked(root, 'INVALID_JSON'); expect(calls).toBe(0); return;
        }
        case 'array-proxy': f.entries = new Proxy([], { get: trap, ownKeys: trap, getPrototypeOf: trap }); break;
        case 'revoked-proxy': { const p = Proxy.revocable({}, {}); p.revoke(); f.documents[0].issuer = p.proxy; break; }
        case 'getter': Object.defineProperty(f.documents[0], 'lines', { get: trap, enumerable: true }); break;
        case 'toJSON': f.documents[0].toJSON = trap; break; case 'cycle': f.self = f; break;
        case 'date': f.documents[0].issueDate = new Date('2026-10-02T16:00:00Z'); break; case 'map': f.entries = new Map(); break;
        case 'class': f.documents[0].issuer = new (class Issuer {})(); break;
        case 'symbol': f.documents[0][Symbol('secret')] = 'SECRET'; break;
        case 'hidden': Object.defineProperty(f.documents[0], 'secret', { value: 'SECRET', enumerable: false }); break;
        case 'undefined': f.documents[0].branchId = undefined; break; case 'bigint': f.documents[0].companyId = 1n; break;
        case 'NaN': f.documents[0].companyId = NaN; break; case 'fraction': f.documents[0].companyId = 1.5; break;
        case 'negative-zero': f.documents[0].companyId = -0; break; case 'sparse': f.entries = new Array(2); break;
        case 'array-field': f.entries.secret = 'SECRET'; break;
      }
      blocked(f); expect(calls).toBe(0); expect(JSON.stringify(projectFiscalFinancialLedger(f))).not.toContain('SECRET');
    });
  it('accepts strict JSON with null object prototypes', () => {
    const f = fixture(); Object.setPrototypeOf(f.documents[0].customer, null); expect(ok(f).documents[0].currentVersion.revision).toBe(0);
  });
  it('bounds total JSON nodes before hashing and rejects prototype-pollution fields', () => {
    const f = fixture() as any;
    f.extra = Array.from({ length: 100 }, () => Array.from({ length: 100 }, () => Array(15).fill(0)));
    blocked(f, 'LIMIT_EXCEEDED');
    const g = fixture() as any; Object.defineProperty(g, '__proto__', { value: { leaked: true }, enumerable: true }); blocked(g, 'INVALID_JSON');
    expect(({} as Record<string, unknown>).leaked).toBeUndefined();
  });
  it.each(['documents', 'entries', 'reservations', 'lines', 'depth', 'characters'] as const)('bounded input blocks excess %s', kind => {
    const f = fixture() as any;
    if (kind === 'documents') f.documents = Array(101).fill(f.documents[0]);
    else if (kind === 'entries') f.entries = Array(101).fill({});
    else if (kind === 'reservations') f.reservations = Array(101).fill({});
    else if (kind === 'lines') f.documents[0].lines = Array(101).fill(f.documents[0].lines[0]);
    else if (kind === 'characters') f.extra = 'x'.repeat(FISCAL_FINANCIAL_LEDGER_LIMITS.jsonCharacters + 1);
    else { let node = f; for (let i = 0; i < 26; i++) { node.extra = {}; node = node.extra; } }
    blocked(f, 'LIMIT_EXCEEDED');
  });
  it('supports exactly 100 documents and 100 idempotent entries', () => {
    const f = fixture(); f.documents = Array.from({ length: 100 }, (_, i) => document('01', 10 + i)); expect(ok(f).documents).toHaveLength(100);
    const g = fixture(), e = noteEntry(g, 1); g.entries = Array.from({ length: 100 }, () => json(e));
    expect(ok(g).documents[0].currentVersion.revision).toBe(1); expect(ok(g).entries.filter(r => r.outcome === 'DUPLICATE')).toHaveLength(99);
  });
  it('blocked results never include partial state, payloads, secrets or exception messages', () => {
    const f = fixture(); f.entries.push(noteEntry(f, 1)); const e = noteEntry(f, 2) as any; e.secret = 'SECRET-PRIVATE-CIPHER'; f.entries.push(e);
    blocked(f, 'INVALID_INPUT'); const result = projectFiscalFinancialLedger(f);
    expect(JSON.stringify(result)).not.toMatch(/SECRET-PRIVATE|stack|documents|nextSnapshot/);
  });
});
