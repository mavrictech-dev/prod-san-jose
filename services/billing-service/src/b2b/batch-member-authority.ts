import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import {
  buildFiscalBatchSnapshot, buildFiscalBatchUbl, type FiscalBatchDocument, type FiscalBatchIdentity,
  type FiscalBatchInput, type FiscalNotDeliveredEvidence, type FiscalRcEntry, type FiscalRaEntry,
} from '@factuez/sunat-core/dist/fiscal-batch';
import {
  fiscalSnapshotSha256, fiscalTimestamp, validateFiscalAcceptance, validateFiscalNoteSnapshot, type FiscalAcceptanceEvidence, type FiscalNoteSnapshot,
} from '@factuez/sunat-core/dist/fiscal-note';
import {
  boundedSupplementJson, buildFiscalSupplementCommand, validateFiscalSupplementCommand,
  type FiscalSupplementCommand,
} from '@factuez/sunat-core/dist/fiscal-supplement-command';

export type BatchSubject = { kind: 'SERVICE' | 'USER'; clientId: string; subjectId: string | null };
export type BatchScope = { environment: 'BETA'; issuerRuc: string; companyId: number; branchId: string };
export type BatchMemberBinding = BatchScope & {
  pointId: string; seriesId: string; series: string; documentType: '01' | '03' | '07' | '08';
};
export type BatchMemberVersion = { documentId: string; version: number; snapshotSha256: string };
type RcSelection = { member: BatchMemberVersion } & (
  { conditionCode: '1' } | { conditionCode: '2' | '3'; previous: BatchMemberVersion }
);
export type BatchMemberRequest = {
  schemaVersion: 'factuez.b2b.batch-members.v1'; scope: BatchScope; idempotencyKey: string;
  asOf: string; issueDate: string; referenceDate: string;
} & ({ kind: 'RC'; entries: RcSelection[] } | {
  kind: 'RA'; entries: { member: BatchMemberVersion; reasonDescription: string }[];
});

/** Owner records only. A public request cannot provide evidence, lifecycle or dependency completeness.
 * Version is a stable owner version, revision fences changes to its evidence/dependency catalogue.
 * Dependencies include the exact original and complete accepted/reserved credit history at this version. */
export type BatchOwnerMember = {
  member: BatchMemberVersion; binding: BatchMemberBinding; revision: number;
  lifecycle: 'CURRENT' | 'HISTORICAL'; reporting: 'UNREPORTED' | 'REPORTED' | 'VOIDED';
  snapshot: FiscalBatchDocument['snapshot']; acceptance: FiscalAcceptanceEvidence | null;
  notDelivered: FiscalNotDeliveredEvidence | null;
  note: null | { original: BatchMemberVersion; historyRevision: number;
    creditHistory: { member: BatchMemberVersion; state: 'ACCEPTED' | 'RESERVED' }[] };
};
export type BatchMemberGrant = {
  subject: BatchSubject; binding: BatchMemberBinding; permission: 'READ' | 'WRITE';
  clientRevision: number; grantRevision: number; userAuthRevision: number | null; checkedAt: string;
};
export interface BatchMemberReadPort {
  /** Must return precisely this owner version, not a caller echo or the latest replacement. */
  member(ref: BatchMemberVersion): Promise<BatchOwnerMember | null>;
  /** Reads authoritative grants for this concrete version and full tuple; throws on denial.
   * WRITE applies also to historical previous/original/history dependencies of a write plan.
   * A read-only grant can never be promoted by returning an approved/accepted flag. */
  authorize(subject: BatchSubject, member: BatchOwnerMember, permission: 'READ' | 'WRITE', kind: 'RC' | 'RA'): Promise<BatchMemberGrant>;
}
type Frozen<T> = T extends object ? { readonly [K in keyof T]: Frozen<T[K]> } : T;
type MemberMark = { record: BatchOwnerMember; grant: Omit<BatchMemberGrant, 'checkedAt'> };
export type BatchMemberPlan = Frozen<{
  request: BatchMemberRequest; subject: BatchSubject; permission: 'READ' | 'WRITE';
  requestSha256: string; membersSha256: string; members: MemberMark[]; input: FiscalBatchInput;
}>;
export type BatchPrepared = Frozen<{ command: FiscalSupplementCommand; ubl: string; plan: BatchMemberPlan }>;
export type BatchJournal = {
  subject: BatchSubject; scope: BatchScope; idempotencyKey: string; requestSha256: string; membersSha256: string;
  commandSha256: string; command: FiscalSupplementCommand; state: 'PREPARED' | 'COMPLETED' | 'UNKNOWN'; result: unknown;
};
export interface BatchMemberTransaction<Tx> extends BatchMemberReadPort {
  /** Actual owner transaction supplied only to the trusted coordinator callback. */
  readonly owner: Tx;
  journal(subject: BatchSubject, scope: BatchScope, key: string): Promise<BatchJournal | null>;
  /** First possible number allocation. Called only after every member has passed transaction-local fences. */
  reserveIdentity(plan: BatchMemberPlan): Promise<{ identity: FiscalBatchIdentity; eventId: string; correlationId: string }>;
  appendJournal(journal: BatchJournal): Promise<void>;
  /** Compare-and-fence ALL owner/member/catalogue and grant revisions. Retain locks until commit.
   * Must serialize against every writer that can change these facts, including revocation/history.
   * Remote/cached authorization receipts cannot implement this transaction-local contract. */
  fence(plan: BatchMemberPlan): Promise<void>;
}
export interface BatchMemberOwnerPort<Tx> extends BatchMemberReadPort {
  /** Exactly one callback, SERIALIZABLE owner transaction, lock batch key plus all member/grant
   * identities in deterministic order; rollback every owner write/counter/journal on rejection.
   * Enforce unique (subject, scope, idempotencyKey) AND batch operation identity/hash.
   * No callback retries: a lost reply requires explicit REUSE_JOURNAL. No transport in this port. */
  transaction<T>(plan: BatchMemberPlan, work: (tx: BatchMemberTransaction<Tx>) => Promise<T>): Promise<T>;
}
export type BatchCoordinationResult = Frozen<{
  journal: BatchJournal; reused: boolean; candidateOnly: true; localOnly: true;
  fiscalExecutionEnabled: false; transmissionAuthorized: false; officialAcceptance: false;
}>;
export type BatchMemberError = 'INVALID_BATCH_REQUEST' | 'INVALID_BATCH_OWNER' | 'INVALID_BATCH_AUTHORITY'
  | 'BATCH_MEMBER_DENIED' | 'BATCH_MEMBER_CHANGED' | 'BATCH_AUTHORITY_CHANGED' | 'BATCH_EXPIRED'
  | 'BATCH_CORE_REJECTED' | 'BATCH_PLAN_REQUIRED' | 'BATCH_CALLBACK_CLOSED' | 'BATCH_CALLBACK_REENTRY'
  | 'BATCH_REUSE_REQUIRED' | 'BATCH_JOURNAL_MISSING' | 'BATCH_JOURNAL_CONFLICT' | 'BATCH_OWNER_UNAVAILABLE'
  | 'BATCH_PRODUCER_UNSUPPORTED';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const codes: readonly BatchMemberError[] = ['INVALID_BATCH_REQUEST', 'INVALID_BATCH_OWNER', 'INVALID_BATCH_AUTHORITY',
  'BATCH_MEMBER_DENIED', 'BATCH_MEMBER_CHANGED', 'BATCH_AUTHORITY_CHANGED', 'BATCH_EXPIRED', 'BATCH_CORE_REJECTED',
  'BATCH_PLAN_REQUIRED', 'BATCH_CALLBACK_CLOSED', 'BATCH_CALLBACK_REENTRY', 'BATCH_REUSE_REQUIRED',
  'BATCH_JOURNAL_MISSING', 'BATCH_JOURNAL_CONFLICT', 'BATCH_OWNER_UNAVAILABLE', 'BATCH_PRODUCER_UNSUPPORTED'];
function fail(code: BatchMemberError, status = 409): never { throw new B2bSecurityError(status, code); }
function safeError(error: unknown): never {
  if (error instanceof B2bSecurityError && codes.includes(error.code as BatchMemberError)) throw error;
  return fail('BATCH_OWNER_UNAVAILABLE', 503);
}
function exact(v: unknown, keys: readonly string[], code: BatchMemberError): asserts v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length ||
    keys.some(k => !Object.hasOwn(v, k))) fail(code, 400);
}
function freeze<T>(v: T): Frozen<T> {
  if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); }
  return v as Frozen<T>;
}
function json<T>(v: T, code: BatchMemberError): T {
  try { return boundedSupplementJson(v) as T; } catch { return fail(code, 400); }
}
function same(a: unknown, b: unknown): boolean { return fiscalSnapshotSha256(a) === fiscalSnapshotSha256(b); }
function id(v: unknown): boolean { return typeof v === 'string' && UUID.test(v); }
function positive(v: unknown): boolean { return Number.isSafeInteger(v) && Number(v) > 0; }
function ref(v: unknown, code: BatchMemberError): asserts v is BatchMemberVersion {
  exact(v, ['documentId', 'version', 'snapshotSha256'], code);
  if (!id(v.documentId) || !positive(v.version) || typeof v.snapshotSha256 !== 'string' || !HASH.test(v.snapshotSha256)) fail(code, 400);
}
function scope(v: unknown, code: BatchMemberError, binding = false): void {
  exact(v, ['environment', 'issuerRuc', 'companyId', 'branchId', ...(binding ? ['pointId', 'seriesId', 'series', 'documentType'] : [])], code);
  if (v.environment !== 'BETA' || typeof v.issuerRuc !== 'string' || !/^\d{11}$/.test(v.issuerRuc) ||
    !positive(v.companyId) || !id(v.branchId)) fail(code, 400);
  if (binding && (!id(v.pointId) || !id(v.seriesId) || typeof v.series !== 'string' || !/^[BF][A-Z0-9]{3}$/.test(v.series) ||
    !['01', '03', '07', '08'].includes(String(v.documentType)))) fail(code, 400);
}
function subject(v: unknown): asserts v is BatchSubject {
  exact(v, ['kind', 'clientId', 'subjectId'], 'INVALID_BATCH_REQUEST');
  if (!id(v.clientId) || !(v.kind === 'SERVICE' && v.subjectId === null || v.kind === 'USER' && id(v.subjectId))) fail('INVALID_BATCH_REQUEST', 400);
}
function timestamp(v: unknown, code: BatchMemberError): number {
  try { fiscalTimestamp(v, 'batch.timestamp'); } catch { return fail(code, 400); }
  return Date.parse(v as string);
}
function fresh(asOf: string, now: string): void {
  const age = timestamp(now, 'BATCH_EXPIRED') - timestamp(asOf, 'BATCH_EXPIRED');
  if (age < 0 || age > 30000) fail('BATCH_EXPIRED');
}
function requestValue(value: unknown): BatchMemberRequest {
  const v = json(value, 'INVALID_BATCH_REQUEST');
  exact(v, ['schemaVersion', 'scope', 'idempotencyKey', 'asOf', 'issueDate', 'referenceDate', 'kind', 'entries'], 'INVALID_BATCH_REQUEST');
  scope(v.scope, 'INVALID_BATCH_REQUEST');
  if (v.schemaVersion !== 'factuez.b2b.batch-members.v1' || !['RC', 'RA'].includes(String(v.kind)) ||
    typeof v.idempotencyKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(v.idempotencyKey) ||
    !Array.isArray(v.entries) || v.entries.length < 1 || v.entries.length > 100) fail('INVALID_BATCH_REQUEST', 400);
  timestamp(v.asOf, 'INVALID_BATCH_REQUEST');
  for (const date of [v.issueDate, v.referenceDate]) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) fail('INVALID_BATCH_REQUEST', 400);
  }
  const seen = new Set<string>();
  for (const entry of v.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('INVALID_BATCH_REQUEST', 400);
    if (v.kind === 'RC') {
      if (!['1', '2', '3'].includes(entry.conditionCode)) fail('INVALID_BATCH_REQUEST', 400);
      exact(entry, ['member', 'conditionCode', ...(entry.conditionCode === '1' ? [] : ['previous'])], 'INVALID_BATCH_REQUEST');
      if (entry.conditionCode !== '1') { ref(entry.previous, 'INVALID_BATCH_REQUEST'); }
    } else {
      exact(entry, ['member', 'reasonDescription'], 'INVALID_BATCH_REQUEST');
      if (typeof entry.reasonDescription !== 'string' || !entry.reasonDescription.trim() || entry.reasonDescription.length > 100 ||
        /[\x00-\x1f\x7f]/.test(entry.reasonDescription)) fail('INVALID_BATCH_REQUEST', 400);
    }
    ref(entry.member, 'INVALID_BATCH_REQUEST');
    if (seen.has(entry.member.documentId)) fail('INVALID_BATCH_REQUEST', 400);
    seen.add(entry.member.documentId);
    if (v.kind === 'RC' && entry.conditionCode !== '1') {
      ref(entry.previous, 'INVALID_BATCH_REQUEST');
      if (entry.previous.documentId !== entry.member.documentId) fail('INVALID_BATCH_REQUEST', 400);
    }
  }
  return freeze(v) as BatchMemberRequest;
}
const memberKey = (r: BatchMemberVersion) => `${r.documentId}/${r.version}`;
function ownerValue(value: BatchOwnerMember | null, expected: BatchMemberVersion, s: BatchScope): BatchOwnerMember {
  if (value === null) fail('BATCH_MEMBER_DENIED', 404);
  const r = json(value, 'INVALID_BATCH_OWNER');
  exact(r, ['member', 'binding', 'revision', 'lifecycle', 'reporting', 'snapshot', 'acceptance', 'notDelivered', 'note'], 'INVALID_BATCH_OWNER');
  ref(r.member, 'INVALID_BATCH_OWNER'); scope(r.binding, 'INVALID_BATCH_OWNER', true);
  const b = r.binding, snapshot = r.snapshot;
  if (!same(r.member, expected) || !positive(r.revision) || !['CURRENT', 'HISTORICAL'].includes(r.lifecycle) ||
    !['UNREPORTED', 'REPORTED', 'VOIDED'].includes(r.reporting) || !snapshot ||
    s.environment !== b.environment || s.issuerRuc !== b.issuerRuc || s.companyId !== b.companyId || s.branchId !== b.branchId ||
    snapshot.documentId !== expected.documentId || fiscalSnapshotSha256(snapshot) !== expected.snapshotSha256 ||
    snapshot.environment !== b.environment || snapshot.companyId !== b.companyId || snapshot.branchId !== b.branchId ||
    snapshot.issuer?.identityNumber !== b.issuerRuc || snapshot.series !== b.series || snapshot.documentTypeCode !== b.documentType) fail('BATCH_MEMBER_DENIED', 404);
  if (['07', '08'].includes(b.documentType)) {
    exact(r.note, ['original', 'historyRevision', 'creditHistory'], 'INVALID_BATCH_OWNER');
    ref(r.note.original, 'INVALID_BATCH_OWNER');
    if (!positive(r.note.historyRevision) || !Array.isArray(r.note.creditHistory) || r.note.creditHistory.length > 100) fail('INVALID_BATCH_OWNER');
    const seen = new Set<string>();
    for (const h of r.note.creditHistory) {
      exact(h, ['member', 'state'], 'INVALID_BATCH_OWNER'); ref(h.member, 'INVALID_BATCH_OWNER');
      if (!['ACCEPTED', 'RESERVED'].includes(h.state) || seen.has(h.member.documentId)) fail('INVALID_BATCH_OWNER');
      seen.add(h.member.documentId);
    }
  } else if (r.note !== null) fail('INVALID_BATCH_OWNER');
  return freeze(r) as BatchOwnerMember;
}

/** Local synthetic candidate. No HTTP, SQL, certificates, signing, transport or official outcome.
 * The injected owner port is the security boundary; this class validates and binds its output.
 * No cached/caller acceptance flags can grant permission. Plans are private-instance capabilities. */
export class B2bBatchMemberAuthority<Tx> {
  private readonly plans = new WeakMap<object, 'READ' | 'READY' | 'RUNNING' | 'USED'>();
  constructor(private readonly owner: BatchMemberOwnerPort<Tx>, private readonly now = () => new Date().toISOString()) {}

  private async collect(request: BatchMemberRequest, actor: BatchSubject, permission: 'READ' | 'WRITE', port: BatchMemberReadPort) {
    const records = new Map<string, BatchOwnerMember>(), grants = new Map<string, MemberMark['grant']>();
    const numbers = new Map<string, string>();
    const load = async (r: BatchMemberVersion): Promise<BatchOwnerMember> => {
      fresh(request.asOf, this.now());
      const key = memberKey(r), known = records.get(key);
      if (known) { if (!same(known.member, r)) fail('BATCH_MEMBER_CHANGED'); return known; }
      // Total closure, including originals, history and previous versions, is bounded to 100.
      if (records.size >= 100) fail('INVALID_BATCH_OWNER');
      const record = ownerValue(await port.member(r), r, request.scope);
      fresh(request.asOf, this.now());
      const number = `${record.binding.documentType}/${record.snapshot.fullNumber}`, identity = numbers.get(number);
      if (identity && identity !== r.documentId) fail('BATCH_MEMBER_DENIED', 404);
      numbers.set(number, r.documentId); records.set(key, record);
      let response: BatchMemberGrant;
      try { response = json(await port.authorize(actor, record, permission, request.kind), 'INVALID_BATCH_AUTHORITY'); }
      catch (e) {
        if (e instanceof B2bSecurityError && e.code === 'INVALID_BATCH_AUTHORITY') throw e;
        return fail('BATCH_MEMBER_DENIED', 403);
      }
      fresh(request.asOf, this.now());
      exact(response, ['subject', 'binding', 'permission', 'clientRevision', 'grantRevision', 'userAuthRevision', 'checkedAt'], 'INVALID_BATCH_AUTHORITY');
      if (!same(response.subject, actor) || !same(response.binding, record.binding) || response.permission !== permission ||
        !positive(response.clientRevision) || !positive(response.grantRevision) ||
        !(actor.kind === 'SERVICE' ? response.userAuthRevision === null : Number.isSafeInteger(response.userAuthRevision) && Number(response.userAuthRevision) >= 0)) fail('BATCH_MEMBER_DENIED', 403);
      fresh(response.checkedAt, this.now());
      const { checkedAt: _checkedAt, ...stamp } = response; grants.set(key, stamp);
      if (record.note) {
        await load(record.note.original);
        for (const h of record.note.creditHistory) await load(h.member);
      }
      return record;
    };
    // Load all before constructing a batch or exposing any write capability.
    for (const e of request.entries) {
      const current = await load(e.member);
      if (permission === 'WRITE' && (current.lifecycle !== 'CURRENT' || current.reporting === 'VOIDED')) fail('BATCH_MEMBER_DENIED', 403);
      if (request.kind === 'RC') {
        const rc = e as RcSelection;
        if (rc.conditionCode === '1') {
          if (permission === 'WRITE' && current.reporting !== 'UNREPORTED') fail('BATCH_MEMBER_DENIED', 403);
        } else {
          const previous = await load(rc.previous);
          if (!same(current.binding, previous.binding) || previous.reporting !== 'REPORTED' || !previous.acceptance ||
            rc.previous.version > rc.member.version ||
            rc.conditionCode === '2' && (rc.previous.version === rc.member.version || previous.lifecycle !== 'HISTORICAL') ||
            rc.conditionCode === '3' && !same(previous.snapshot, current.snapshot)) fail('BATCH_MEMBER_DENIED', 403);
        }
      } else if (!current.acceptance || current.reporting !== 'REPORTED') fail('BATCH_MEMBER_DENIED', 403);
    }
    // Recursive notes/history may share dependencies, but cycles are forbidden.
    const active = new Set<string>(), documents = new Map<string, FiscalBatchDocument>();
    const document = (r: BatchMemberVersion): FiscalBatchDocument => {
      const key = memberKey(r), row = records.get(key)!;
      const cached = documents.get(key); if (cached) return cached;
      if (active.has(key)) fail('INVALID_BATCH_OWNER');
      if (!row.note) return { snapshot: row.snapshot };
      active.add(key);
      const original = records.get(memberKey(row.note.original))!;
      if (!['01', '03'].includes(original.binding.documentType) || !original.acceptance || original.reporting !== 'REPORTED') fail('INVALID_BATCH_OWNER');
      const history = row.note.creditHistory.map(h => {
        const prior = records.get(memberKey(h.member))!;
        if (prior.binding.documentType !== '07') fail('INVALID_BATCH_OWNER');
        // The fiscal note core checks history bytes/capacity, not acceptance of each credit.
        // An ACCEPTED label must additionally carry the exact owner's accepted-version proof.
        if (h.state === 'ACCEPTED') {
          if (!prior.acceptance || prior.reporting !== 'REPORTED') fail('INVALID_BATCH_OWNER');
          try { validateFiscalAcceptance(prior.snapshot, prior.acceptance, request.asOf); }
          catch { return fail('BATCH_CORE_REJECTED', 400); }
        }
        document(h.member); // Validate cycles and rebuild all dependency contexts as well.
        return { state: h.state, note: prior.snapshot as FiscalNoteSnapshot };
      });
      active.delete(key);
      const result: FiscalBatchDocument = { snapshot: row.snapshot, noteContext: { original: original.snapshot as FiscalDocumentSnapshot,
        acceptance: original.acceptance, asOf: request.asOf, creditHistory: { complete: true, entries: history } } };
      documents.set(key, result); return result;
    };
    let input: FiscalBatchInput;
    if (request.kind === 'RC') input = { kind: 'RC', entries: request.entries.map(e => {
      const current = records.get(memberKey(e.member))!, d = document(e.member);
      if (e.conditionCode === '1') return { conditionCode: '1', document: d };
      const old = records.get(memberKey(e.previous))!;
      return { conditionCode: e.conditionCode, document: d, previous: { document: document(e.previous), acceptance: old.acceptance! },
        ...(e.conditionCode === '3' ? { notDelivered: current.notDelivered! } : {}) } as FiscalRcEntry;
    }) };
    else input = { kind: 'RA', entries: request.entries.map(e => {
      const row = records.get(memberKey(e.member))!;
      return { document: document(e.member), acceptance: row.acceptance!, notDelivered: row.notDelivered!, reasonDescription: e.reasonDescription } as FiscalRaEntry;
    }) };
    // Validate without allocating a batch number. This identity is never persisted/exposed.
    try {
      const validationId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
      if (records.has(`${validationId}/1`) || [...records.values()].some(r => r.member.documentId === validationId)) fail('INVALID_BATCH_OWNER');
      buildFiscalBatchSnapshot(input, { documentId: validationId, identifier: `${request.kind}-${request.issueDate.replaceAll('-', '')}-1`,
        issueDate: request.issueDate, referenceDate: request.referenceDate }, request.asOf);
      // Validate dependency notes even when they are present only as credit history.
      for (const row of records.values()) if (row.note) {
        const d = document(row.member);
        validateFiscalNoteSnapshot(d.snapshot as FiscalNoteSnapshot, d.noteContext!);
      }
    } catch { return fail('BATCH_CORE_REJECTED', 400); }
    fresh(request.asOf, this.now());
    const members = [...records.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, record]) => ({ record, grant: grants.get(key)! }));
    // Same client/user authority epoch across the entire batch; grants remain per full tuple.
    if (members.some(m => m.grant.clientRevision !== members[0].grant.clientRevision || m.grant.userAuthRevision !== members[0].grant.userAuthRevision)) fail('BATCH_AUTHORITY_CHANGED');
    return { members, input };
  }

  async plan(value: unknown, identity: BatchSubject, permission: 'READ' | 'WRITE' = 'WRITE'): Promise<BatchMemberPlan> {
    try {
      const request = requestValue(value), actor = json(identity, 'INVALID_BATCH_REQUEST'); subject(actor);
      if (!['READ', 'WRITE'].includes(permission)) fail('INVALID_BATCH_REQUEST', 400);
      freeze(actor);
      const first = await this.collect(request, actor, permission, this.owner);
      const second = await this.collect(request, actor, permission, this.owner);
      if (!same(first.members.map(m => m.record), second.members.map(m => m.record))) fail('BATCH_MEMBER_CHANGED');
      if (!same(first.members, second.members)) fail('BATCH_AUTHORITY_CHANGED');
      const plan = freeze({ request, subject: actor, permission,
        // asOf is a freshness challenge, not a new batch when recovering a lost reply.
        requestSha256: fiscalSnapshotSha256({ ...request, asOf: null, subject: actor }),
        membersSha256: fiscalSnapshotSha256(second.members), ...second });
      this.plans.set(plan, permission === 'READ' ? 'READ' : 'READY');
      return plan;
    } catch (e) { return safeError(e); }
  }

  private async recheck(plan: BatchMemberPlan, tx: BatchMemberTransaction<Tx>): Promise<void> {
    const current = await this.collect(plan.request as BatchMemberRequest, plan.subject, 'WRITE', tx);
    if (!same(current.members.map(m => m.record), plan.members.map(m => m.record))) fail('BATCH_MEMBER_CHANGED');
    if (!same(current.members, plan.members)) fail('BATCH_AUTHORITY_CHANGED');
    await tx.fence(plan); fresh(plan.request.asOf, this.now());
  }

  /** Callback may perform only local owner work on tx; no external effects. It runs once, after
   * whole-batch authorization, and every staged change rolls back if the final fences fail.
   * checkpoint is scoped to this callback and rejects parallel/reentrant or escaped use. */
  async coordinate(plan: BatchMemberPlan, mode: 'CREATE' | 'REUSE_JOURNAL',
    work?: (tx: Tx, prepared: BatchPrepared, checkpoint: () => Promise<void>) => Promise<unknown>): Promise<BatchCoordinationResult> {
    if (this.plans.get(plan) !== 'READY' || !['CREATE', 'REUSE_JOURNAL'].includes(mode) ||
      mode === 'CREATE' && typeof work !== 'function' || mode === 'REUSE_JOURNAL' && work !== undefined) fail('BATCH_PLAN_REQUIRED');
    this.plans.set(plan, 'RUNNING');
    let entered = false, completed = false, transactionOpen = true;
    try {
      const result = await this.owner.transaction(plan, async tx => {
        if (!transactionOpen) fail('BATCH_CALLBACK_CLOSED');
        if (entered) fail('BATCH_CALLBACK_REENTRY'); entered = true;
        await this.recheck(plan, tx);
        const existing = await tx.journal(plan.subject, plan.request.scope, plan.request.idempotencyKey);
        await this.recheck(plan, tx);
        if (existing) {
          const journal = this.journal(existing, plan);
          if (mode !== 'REUSE_JOURNAL') fail('BATCH_REUSE_REQUIRED');
          completed = true; return this.result(journal, true);
        }
        if (mode === 'REUSE_JOURNAL') fail('BATCH_JOURNAL_MISSING');
        const reservation = json(await tx.reserveIdentity(plan), 'INVALID_BATCH_OWNER');
        exact(reservation, ['identity', 'eventId', 'correlationId'], 'INVALID_BATCH_OWNER');
        if (!reservation.identity || reservation.identity.issueDate !== plan.request.issueDate || reservation.identity.referenceDate !== plan.request.referenceDate ||
          plan.members.some(m => m.record.member.documentId === reservation.identity.documentId)) fail('INVALID_BATCH_OWNER');
        await this.recheck(plan, tx);
        const batch = buildFiscalBatchSnapshot(plan.input as FiscalBatchInput, reservation.identity, plan.request.asOf);
        const command = buildFiscalSupplementCommand({ kind: 'BATCH', batch, asOf: plan.request.asOf },
          { eventId: reservation.eventId, correlationId: reservation.correlationId, occurredAt: plan.request.asOf });
        const prepared = freeze({ command, ubl: buildFiscalBatchUbl(batch, plan.request.asOf), plan });
        let open = true, checking: Promise<void> | undefined, poisoned = false;
        const checkpoint = async () => {
          if (!open) fail('BATCH_CALLBACK_CLOSED');
          if (checking) { poisoned = true; fail('BATCH_CALLBACK_REENTRY'); }
          checking = this.recheck(plan, tx).catch(e => { poisoned = true; throw e; });
          try { await checking; } finally { checking = undefined; }
        };
        let output: unknown;
        try { output = await work!(tx.owner, prepared, checkpoint); }
        finally { open = false; if (checking) await checking; }
        if (poisoned) fail('BATCH_CALLBACK_REENTRY');
        await this.recheck(plan, tx);
        const journal: BatchJournal = { subject: plan.subject, scope: plan.request.scope, idempotencyKey: plan.request.idempotencyKey,
          requestSha256: plan.requestSha256, membersSha256: plan.membersSha256, commandSha256: fiscalSnapshotSha256(command),
          command, state: 'PREPARED', result: json(output, 'INVALID_BATCH_OWNER') };
        await tx.appendJournal(journal);
        await this.recheck(plan, tx);
        completed = true; return this.result(journal, false);
      });
      if (!completed) fail('BATCH_CALLBACK_CLOSED');
      return result;
    } catch (e) { return safeError(e); }
    finally { transactionOpen = false; this.plans.set(plan, 'USED'); }
  }

  private journal(value: BatchJournal, plan: BatchMemberPlan): BatchJournal {
    try {
      const row = json(value, 'BATCH_JOURNAL_CONFLICT');
      exact(row, ['subject', 'scope', 'idempotencyKey', 'requestSha256', 'membersSha256', 'commandSha256', 'command', 'state', 'result'], 'BATCH_JOURNAL_CONFLICT');
      const command = validateFiscalSupplementCommand(row.command), envelope = command.payload.envelope;
      if (!same(row.subject, plan.subject) || !same(row.scope, plan.request.scope) || row.idempotencyKey !== plan.request.idempotencyKey ||
        row.requestSha256 !== plan.requestSha256 || row.membersSha256 !== plan.membersSha256 || row.commandSha256 !== fiscalSnapshotSha256(command) ||
        !['PREPARED', 'COMPLETED', 'UNKNOWN'].includes(row.state) || envelope.kind !== 'BATCH' ||
        envelope.batch.kind !== plan.request.kind || envelope.batch.issueDate !== plan.request.issueDate || envelope.batch.referenceDate !== plan.request.referenceDate ||
        plan.members.some(m => m.record.member.documentId === envelope.batch.documentId) ||
        !same(this.replayInput(envelope.batch.input), this.replayInput(plan.input as FiscalBatchInput))) fail('BATCH_JOURNAL_CONFLICT');
      return row;
    } catch { return fail('BATCH_JOURNAL_CONFLICT'); }
  }
  private replayInput(input: FiscalBatchInput): FiscalBatchInput {
    // Refreshing a freshness challenge must not change the identity of a note batch.
    // Only context.asOf is ignored; all snapshots, owner proofs and ordered histories remain bound.
    const value = structuredClone(input);
    const clear = (d: FiscalBatchDocument) => { if (d.noteContext) d.noteContext.asOf = '2000-01-01T00:00:00Z'; };
    for (const e of value.entries) {
      clear(e.document);
      if ('previous' in e && e.previous) clear(e.previous.document);
    }
    return value;
  }
  private result(journal: BatchJournal, reused: boolean): BatchCoordinationResult {
    return freeze(json({ journal, reused, candidateOnly: true as const, localOnly: true as const,
      fiscalExecutionEnabled: false as const, transmissionAuthorized: false as const, officialAcceptance: false as const }, 'INVALID_BATCH_OWNER'));
  }
}
