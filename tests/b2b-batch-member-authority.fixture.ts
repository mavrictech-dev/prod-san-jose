import { vi } from 'vitest';
import { buildFiscalNoteSnapshot, fiscalSnapshotSha256, type FiscalAcceptanceEvidence, type FiscalNoteContext } from '../packages/sunat-core/src/fiscal-note';
import { calculateDocumentTotals } from '../packages/sunat-core/src/tax';
import {
  B2bBatchMemberAuthority, type BatchMemberBinding, type BatchMemberGrant, type BatchMemberPlan,
  type BatchMemberRequest, type BatchMemberTransaction, type BatchMemberVersion, type BatchOwnerMember,
  type BatchJournal, type BatchMemberOwnerPort, type BatchSubject,
} from '../services/billing-service/src/b2b/batch-member-authority';
import { supplementCommandFixture, supplementUuid as uuid } from './helpers/fiscal-supplement.fixture';

const clone = <T>(v: T): T => structuredClone(v);
export { uuid };
export const asOf = '2026-10-03T18:00:00Z';
export const actor: BatchSubject = { kind: 'SERVICE', clientId: uuid(2000), subjectId: null };
const key = (r: BatchMemberVersion) => `${r.documentId}/${r.version}`;
export function acceptance(snapshot: BatchOwnerMember['snapshot']): FiscalAcceptanceEvidence {
  return { environment: 'BETA', documentId: snapshot.documentId, documentTypeCode: snapshot.documentTypeCode as '01' | '03' | '07' | '08',
    issuerRuc: snapshot.issuer.identityNumber, fullNumber: snapshot.fullNumber, snapshotSha256: fiscalSnapshotSha256(snapshot),
    cdrSha256: 'a'.repeat(64), status: 'ACCEPTED', responseCode: '0', acceptedAt: '2026-10-02T17:10:00Z',
    source: snapshot.series.startsWith('B') ? { kind: 'CDR_SUMMARY', identifier: 'RC-20261002-1', referenceDate: '2026-10-02', conditionCode: '1', lineNumber: 1 } : { kind: 'CDR_DOCUMENT' } };
}
export function fixture(kind: 'RC' | 'RA' = 'RC', count = 2) {
  const base = supplementCommandFixture(kind), rows = new Map<string, BatchOwnerMember>();
  const s = { environment: 'BETA' as const, issuerRuc: base.doc.issuer.identityNumber, companyId: base.doc.companyId!, branchId: base.doc.branchId! };
  let time = asOf, revision = 1, clientRevision = 1, denied = '', writable = true;
  let beforeMember: (() => void | Promise<void>) | undefined;
  let beforeAuthorize: (() => void | Promise<void>) | undefined;
  let beforeFence: (() => void | Promise<void>) | undefined;
  let beforeJournal: (() => void | Promise<void>) | undefined;
  let loseReply = false, doubleCallback = false;
  const journals = new Map<string, BatchJournal>();
  const state = { writes: [] as string[], numbers: 0, commits: 0 };
  const add = (snapshot: BatchOwnerMember['snapshot'], version = 1, options: Partial<BatchOwnerMember> = {}) => {
    const member = { documentId: snapshot.documentId, version, snapshotSha256: fiscalSnapshotSha256(snapshot) };
    const binding: BatchMemberBinding = { ...s, pointId: uuid(2100), seriesId: uuid(snapshot.documentTypeCode === '07' ? 2102 : snapshot.documentTypeCode === '08' ? 2103 : 2101),
      series: snapshot.series, documentType: snapshot.documentTypeCode as BatchMemberBinding['documentType'] };
    const row: BatchOwnerMember = { member, binding, revision: 1, lifecycle: 'CURRENT', reporting: kind === 'RC' ? 'UNREPORTED' : 'REPORTED',
      snapshot: clone(snapshot), acceptance: kind === 'RA' ? acceptance(snapshot) : null,
      notDelivered: { status: 'NOT_DELIVERED', documentId: snapshot.documentId, documentTypeCode: binding.documentType, fullNumber: snapshot.fullNumber,
        issuerRuc: s.issuerRuc, snapshotSha256: member.snapshotSha256, evidenceId: uuid(2200 + version), assertedAt: '2026-10-03T16:00:00Z' }, note: null, ...options };
    rows.set(key(member), row); return row;
  };
  const roots = Array.from({ length: count }, (_, i) => {
    const snapshot = clone(base.doc); snapshot.documentId = uuid(10 + i); snapshot.number = String(10 + i); snapshot.fullNumber = `${snapshot.series}-${10 + i}`;
    return add(snapshot);
  });
  const request: BatchMemberRequest = { schemaVersion: 'factuez.b2b.batch-members.v1', scope: s, idempotencyKey: 'synthetic-batch-key-0001', asOf,
    issueDate: '2026-10-03', referenceDate: '2026-10-02', ...(kind === 'RC' ? { kind, entries: roots.map(r => ({ member: r.member, conditionCode: '1' as const })) }
      : { kind, entries: roots.map(r => ({ member: r.member, reasonDescription: 'SUSTENTO SINTETICO' })) }) };
  const member = vi.fn(async (r: BatchMemberVersion) => { await beforeMember?.(); return rows.has(key(r)) ? clone(rows.get(key(r))!) : null; });
  const authorize = vi.fn(async (subject: BatchSubject, row: BatchOwnerMember, permission: 'READ' | 'WRITE'): Promise<BatchMemberGrant> => {
    await beforeAuthorize?.();
    if (denied === key(row.member)) throw new Error('PRIVATE OWNER DETAIL MUST NOT ESCAPE');
    return { subject: clone(subject), binding: clone(row.binding), permission: permission === 'WRITE' && !writable ? 'READ' : permission,
      clientRevision, grantRevision: revision, userAuthRevision: subject.kind === 'USER' ? 1 : null, checkedAt: time };
  });
  const fence = vi.fn(async (plan: BatchMemberPlan) => {
    await beforeFence?.();
    for (const m of plan.members) {
      if (fiscalSnapshotSha256(rows.get(key(m.record.member))) !== fiscalSnapshotSha256(m.record) || m.grant.grantRevision !== revision ||
        m.grant.clientRevision !== clientRevision || denied === key(m.record.member) || !writable) throw new Error('OWNER FENCE LOST');
    }
  });
  let queue = Promise.resolve();
  const transaction = vi.fn(async <T>(plan: BatchMemberPlan, work: (tx: BatchMemberTransaction<{ write(label: string): void }>) => Promise<T>): Promise<T> => {
    const previous = queue; let release!: () => void; queue = new Promise<void>(resolve => { release = resolve; }); await previous;
    let open = true;
    const writes: string[] = [], staged = new Map(journals); let numbers = state.numbers;
    const tx: BatchMemberTransaction<{ write(label: string): void }> = {
      owner: { write(label) { if (!open) throw new Error('TX CLOSED'); writes.push(label); } }, member, authorize, fence,
      journal: async () => { await beforeJournal?.(); return clone(staged.get(plan.request.idempotencyKey) ?? null); },
      reserveIdentity: vi.fn(async () => ({ identity: { documentId: uuid(3000 + ++numbers), identifier: `${plan.request.kind}-20261003-${numbers}`,
        issueDate: plan.request.issueDate, referenceDate: plan.request.referenceDate }, eventId: uuid(4000 + numbers), correlationId: uuid(5000 + numbers) })),
      appendJournal: async row => { if (staged.has(row.idempotencyKey)) throw new Error('UNIQUE BATCH'); staged.set(row.idempotencyKey, clone(row)); },
    };
    try {
      const result = await work(tx); if (doubleCallback) await work(tx);
      state.writes.push(...writes); state.numbers = numbers; state.commits++; journals.clear(); for (const [k, v] of staged) journals.set(k, v);
      if (loseReply) { loseReply = false; throw new Error('SYNTHETIC LOST COMMIT REPLY'); }
      return result;
    } finally { open = false; release(); }
  });
  const owner: BatchMemberOwnerPort<{ write(label: string): void }> = { member, authorize, transaction };
  const adapter = new B2bBatchMemberAuthority(owner, () => time);
  const note = (n = 100, history: BatchOwnerMember[] = []) => {
    const originalSnapshot = clone(base.doc); originalSnapshot.documentId = uuid(90); originalSnapshot.number = '90'; originalSnapshot.fullNumber = `${originalSnapshot.series}-90`;
    const original = rows.get(`${uuid(90)}/1`) ?? add(originalSnapshot, 1, { reporting: 'REPORTED', acceptance: acceptance(originalSnapshot) });
    const context: FiscalNoteContext = { original: original.snapshot as typeof base.doc, acceptance: original.acceptance!, asOf,
      creditHistory: { complete: true, entries: history.map(h => ({ state: 'RESERVED', note: h.snapshot as ReturnType<typeof buildFiscalNoteSnapshot> })) } };
    const snapshot = buildFiscalNoteSnapshot(context, { documentTypeCode: '07', reasonCode: '07', reasonDescription: 'DEVOLUCION SINTETICA', lines: [{ originalLineNumber: 1, quantity: '0.5' }] },
      { documentId: uuid(n), series: kind === 'RC' ? 'BC01' : 'FC01', number: String(n), issueDate: '2026-10-02T17:00:00Z' });
    return add(snapshot, 1, { note: { original: original.member, historyRevision: 1, creditHistory: history.map(h => ({ member: h.member, state: 'RESERVED' })) } });
  };
  const previous = (index: number, condition: '2' | '3') => {
    if (request.kind !== 'RC') throw new Error('RC only');
    const old = roots[index]; old.reporting = 'REPORTED'; old.acceptance = acceptance(old.snapshot); old.lifecycle = 'HISTORICAL';
    const snapshot = clone(old.snapshot);
    if (condition === '2') Object.assign(snapshot, calculateDocumentTotals([{ description: 'BIEN FICTICIO CORREGIDO', unitCode: 'NIU', quantity: '2', unitPriceWithTax: '59', taxAffectationCode: '10', igvRate: '18' }]));
    const current = add(snapshot, 2, { reporting: 'REPORTED' }); roots[index] = current;
    request.entries[index] = { conditionCode: condition, member: current.member, previous: old.member };
    return { old, current };
  };
  return { adapter, owner, request, roots, rows, journals, state, member, authorize, fence, transaction, add, note, previous,
    setTime: (v: string) => { time = v; }, deny: (r: BatchMemberVersion) => { denied = key(r); },
    revoke: () => { revision++; }, changeClient: () => { clientRevision++; }, readOnly: () => { writable = false; },
    onMember: (fn?: typeof beforeMember) => { beforeMember = fn; }, onAuthorize: (fn?: typeof beforeAuthorize) => { beforeAuthorize = fn; },
    onFence: (fn?: typeof beforeFence) => { beforeFence = fn; }, onJournal: (fn?: typeof beforeJournal) => { beforeJournal = fn; },
    loseReply: () => { loseReply = true; }, doubleCallback: () => { doubleCallback = true; } };
}
