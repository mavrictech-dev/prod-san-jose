import { allowsResource, type FiscalDocumentSnapshot } from '@factuez/contracts';
import { FISCAL_FINANCIAL_LEDGER_PROFILE, projectFiscalFinancialLedger, type FiscalFinancialLedgerInput, type FiscalLedgerReadonly } from '@factuez/sunat-core/dist/fiscal-financial-ledger';
import { boundedSupplementJson, validateFiscalSupplementCommand } from '@factuez/sunat-core/dist/fiscal-supplement-command';
import { fiscalSnapshotSha256, type FiscalNoteSnapshot } from '@factuez/sunat-core/dist/fiscal-note';
import { parseDecimal } from '@factuez/sunat-core/dist/tax';
import type { Prisma, PrismaClient } from '../generated/prisma/client';
import type { BetaSupplementActor } from './beta-supplement-command.repository';
import { validateFinancialLedgerPlan, type FinancialLedgerPlanValidationResult } from './financial-ledger-plan';
import {supplementActor} from './supplement-actor';

type Tx = Prisma.TransactionClient;
type Validation = FinancialLedgerPlanValidationResult;
type Entry = FiscalFinancialLedgerInput['entries'][number];
type Snapshot = FiscalLedgerReadonly<FiscalDocumentSnapshot | FiscalNoteSnapshot>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TYPES = { '01': 'INVOICE', '03': 'SALES_RECEIPT', '07': 'CREDIT_NOTE', '08': 'DEBIT_NOTE' } as const;
const headSelect = { documentId: true, companyId: true, branchId: true, issuerRuc: true, environment: true, candidateOnly: true,
  profile: true, revision: true, sequence: true, versionSha256: true, originalSha256: true, historySha256: true, state: true,
  originalSnapshot: true, financialSnapshot: true, historyPayload: true, currentVersion: true, lastCommitId: true } satisfies Prisma.FinancialLedgerStreamSelect;
type Head = Prisma.FinancialLedgerStreamGetPayload<{ select: typeof headSelect }>;
class CandidateBlocked extends Error {
  constructor(code: string) { super(`Ledger candidato BETA: ${code}`); delete this.stack; }
}
function check(condition: unknown, code: string): asserts condition { if (!condition) throw new CandidateBlocked(code); }
function same(a: unknown, b: unknown, code = 'INTEGRITY_CONFLICT') { check(fiscalSnapshotSha256(a) === fiscalSnapshotSha256(b), code); }
function json(value: unknown): Prisma.InputJsonValue { return boundedSupplementJson(value) as Prisma.InputJsonValue; }
function uniqueEntries(input: FiscalFinancialLedgerInput, id: string): Entry[] {
  const entries = new Map<string, Entry>();
  for (const entry of input.entries) if (entry.documentId === id && !entries.has(entry.eventId)) entries.set(entry.eventId, entry);
  return [...entries.values()]; // Exact replays were already checked by the pure reducer.
}
function history(input: FiscalFinancialLedgerInput, id: string): FiscalFinancialLedgerInput {
  return { scope: input.scope, documents: input.documents.filter(d => d.documentId === id), entries: uniqueEntries(input, id),
    ...(input.reservations ? { reservations: input.reservations.filter(r => r.documentId === id) } : {}) };
}
function resultOf(v: Validation) {
  return { profile: FISCAL_FINANCIAL_LEDGER_PROFILE, candidateOnly: true as const, persistedCandidate: true as const,
    fiscalAuthority: false as const, evidenceAuthenticityVerified: false as const, transmissionAuthorized: false as const,
    planId: v.plan.planId, inputSha256: v.inputSha256, planSha256: v.planSha256,
    targets: v.projection.documents.map(d => ({ documentId: d.documentId, sequence: d.lastSequence,
      revision: d.currentVersion.revision, versionSha256: d.currentVersion.sha256, state: d.currentVersion.state })) };
}
export type FinancialLedgerCandidateCommitResult = ReturnType<typeof resultOf> & { deduplicated: boolean };

/** Internal CANDIDATE persistence only. No controller/bootstrap/worker invokes it.
 * The public composition gate remains hard-closed BEFORE DB. Evidence booleans
 * are NOT authenticated here: rows cannot become fiscal authority by storing them.
 * All writers must use the same company/RUC lock as the supplement producer.
 * Does not update Document, counters, statuses, Outbox or any other service table.
 */
export class FinancialLedgerCandidateRepository {
  constructor(private readonly prisma: Pick<PrismaClient, '$transaction'>) {}
  async commit(value: unknown, actorInput: BetaSupplementActor): Promise<FinancialLedgerCandidateCommitResult> {
    let v: Validation, actor: BetaSupplementActor;
    try {
      v = validateFinancialLedgerPlan(value); actor = supplementActor(actorInput);
      check(actor && (actor.userId===null?actor.b2b?.kind==='SERVICE':UUID.test(actor.userId)) && actor.scope && ['GLOBAL', 'ASSIGNED'].includes(actor.scope.kind), 'INVALID_ACTOR');
      if (actor.scope.kind === 'ASSIGNED') check([actor.scope.branchIds, actor.scope.emissionPointIds, actor.scope.series]
        .every(ids => Array.isArray(ids) && ids.every(id => typeof id === 'string' && UUID.test(id))), 'INVALID_ACTOR');
      check(allowsResource(actor.scope, v.plan.input.scope.branchId), 'SCOPE_DENIED');
    } catch { throw new CandidateBlocked('INVALID_PLAN_OR_ACTOR'); }
    for (let attempt = 0; ; attempt++) {
      try { return await this.prisma.$transaction(tx => this.commitTx(tx, v, actor), { isolationLevel: 'Serializable', maxWait: 2000, timeout: 10000 }); }
      catch (error) {
        if (attempt < 2 && error && typeof error === 'object' && 'code' in error && error.code === 'P2034') continue;
        throw error instanceof CandidateBlocked ? error : new CandidateBlocked('STORAGE_FAILED');
      }
    }
  }

  /** Owner-local composition; caller supplies verified evidence and owns rollback. No nested transaction. */
  async commitWithinTransaction(tx:Tx,value:unknown,actorInput:BetaSupplementActor):Promise<FinancialLedgerCandidateCommitResult>{
    const v=validateFinancialLedgerPlan(value),actor=supplementActor(actorInput);
    check(allowsResource(actor.scope,v.plan.input.scope.branchId),'SCOPE_DENIED');
    return this.commitTx(tx,v,actor);
  }

  private async commitTx(tx: Tx, v: Validation, actor: BetaSupplementActor): Promise<FinancialLedgerCandidateCommitResult> {
    const input = v.plan.input, scope = input.scope;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`factuez:beta-supplement:company:${scope.companyId}:ruc:${scope.issuerRuc}`}, 0))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`factuez:financial-candidate:plan:${v.plan.planId}`}, 0))`;
    for (const id of input.documents.map(d => d.documentId).sort())
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`factuez:financial-candidate:document:${id}`}, 0))`;
    const company = await tx.companySettings.findUnique({ where: { id: scope.companyId }, select: { id: true, ruc: true, environment: true } });
    const branch = await tx.branch.findUnique({ where: { id: scope.branchId }, select: { id: true, companyId: true, active: true } });
    check(company?.id === scope.companyId && company.ruc === scope.issuerRuc && company.environment === 'BETA' &&
      branch?.id === scope.branchId && branch.active && branch.companyId === scope.companyId, 'OWN_SCOPE_MISMATCH');
    // Reauthorization and exact own snapshots even when a stored plan is replayed.
    for (const document of input.documents) await this.ownSnapshot(tx, document, actor, scope);
    for (const entry of input.entries) await this.backingOperation(tx, input, entry, actor);
    for (const reserved of input.reservations ?? []) {
      await this.ownSnapshot(tx, reserved.note, actor, scope);
      const command = await this.command(tx, reserved.operationId, scope);
      check(command.payload.envelope.kind === 'NOTE', 'RESERVATION_COMMAND_MISMATCH');
      same(command.payload.envelope.note, reserved.note);
      this.contextBinding(command.payload.envelope.context, reserved.noteContext);
    }
    const result = resultOf(v);
    const receipt = await tx.financialLedgerCommit.findUnique({ where: { planId: v.plan.planId }, select: {
      planId: true, companyId: true, branchId: true, issuerRuc: true, environment: true, candidateOnly: true, profile: true,
      planSha256: true, inputSha256: true, resultSha256: true, planPayload: true, resultPayload: true,
    } });
    if (receipt) {
      this.candidateScope(receipt, scope);
      check(receipt.planSha256 === v.planSha256 && receipt.inputSha256 === v.inputSha256, 'PLAN_CONFLICT');
      same(boundedSupplementJson(receipt.planPayload), v.plan); same(boundedSupplementJson(receipt.resultPayload), result);
      check(receipt.resultSha256 === fiscalSnapshotSha256(result), 'RECEIPT_INTEGRITY');
      for (const target of result.targets) {
        const head = await tx.financialLedgerStream.findUnique({ where: { documentId: target.documentId }, select: headSelect });
        check(head && head.revision >= target.revision && head.sequence >= target.sequence, 'RECEIPT_HEAD_MISSING');
        this.candidateScope(head, scope);
        await this.verifyStored(tx, head, boundedSupplementJson(head.historyPayload) as FiscalFinancialLedgerInput);
        const version = await tx.financialLedgerVersion.findUnique({ where: { documentId_revision: { documentId: target.documentId, revision: target.revision } },
          select: { companyId: true, branchId: true, versionSha256: true, candidateOnly: true } });
        check(version?.candidateOnly && version.companyId === scope.companyId && version.branchId === scope.branchId && version.versionSha256 === target.versionSha256, 'RECEIPT_VERSION_MISSING');
      }
      return { ...result, deduplicated: true };
    }
    // Only NEW commits evaluate today's complete credit membership. Replaying
    // an immutable historical receipt must not fail because later notes exist;
    // the branch above reauthorizes its exact inputs and verifies the live head
    // without rewriting it or granting capacity from the historical result.
    for (const original of input.documents) {
      const credits = await tx.document.findMany({ where: { companyId: scope.companyId, type: 'CREDIT_NOTE', OR: [
        { referencesFrom: { some: { targetDocumentId: original.documentId } } },
        { immutableSnapshot: { path: ['reference', 'documentId'], equals: original.documentId } },
      ] }, select: { id: true, immutableSnapshot: true }, take: 101 });
      const declared = new Map<string, unknown>();
      for (const e of input.entries) if (e.documentId === original.documentId && e.kind === 'NOTE_CREDIT') declared.set(e.nextSnapshot.documentId, e.nextSnapshot);
      for (const r of input.reservations ?? []) if (r.documentId === original.documentId) declared.set(r.note.documentId, r.note);
      check(credits.length <= 100 && credits.length === declared.size, 'INCOMPLETE_OWN_CREDITS');
      for (const credit of credits) { check(declared.has(credit.id), 'INCOMPLETE_OWN_CREDITS'); same(credit.immutableSnapshot, declared.get(credit.id)); }
    }
    const prepared: Array<{ documentId: string; stored: Head | null; input: FiscalFinancialLedgerInput }> = [];
    for (const document of v.projection.documents) {
      const stored = await tx.financialLedgerStream.findUnique({ where: { documentId: document.documentId }, select: headSelect });
      const expected = v.plan.expectedHeads.find(h => h.documentId === document.documentId)!;
      const incoming = history(input, document.documentId);
      if (!stored) check(expected.versionSha256 === null && expected.revision === 0 && expected.sequence === 0, 'MISSING_HEAD');
      else {
        this.candidateScope(stored, scope);
        check(stored.revision === expected.revision && stored.sequence === expected.sequence && stored.versionSha256 === expected.versionSha256, 'STALE_HEAD');
        await this.verifyStored(tx, stored, incoming);
      }
      prepared.push({ documentId: document.documentId, stored, input: incoming });
    }
    await tx.financialLedgerCommit.create({ data: { planId: v.plan.planId, ...scope, candidateOnly: true,
      profile: FISCAL_FINANCIAL_LEDGER_PROFILE, planSha256: v.planSha256, inputSha256: v.inputSha256,
      resultSha256: fiscalSnapshotSha256(result), planPayload: json(v.plan), resultPayload: json(result) } });
    for (const p of prepared) {
      const d = v.projection.documents.find(doc => doc.documentId === p.documentId)!;
      const data = { ...scope, candidateOnly: true as const, profile: FISCAL_FINANCIAL_LEDGER_PROFILE,
        revision: d.currentVersion.revision, sequence: d.lastSequence, versionSha256: d.currentVersion.sha256,
        originalSha256: d.originalSha256, state: d.currentVersion.state, historySha256: fiscalSnapshotSha256(p.input),
        originalSnapshot: json(d.originalSnapshot), financialSnapshot: json(d.financialSnapshot),
        historyPayload: json(p.input), currentVersion: json(d.currentVersion), lastCommitId: v.plan.planId };
      if (!p.stored) await tx.financialLedgerStream.create({ data: { documentId: p.documentId, ...data } });
      else if (p.stored.historySha256 !== data.historySha256) {
        // Only mutable head fields; immutable originals/scope are never in UPDATE.
        const mutable = { revision: data.revision, sequence: data.sequence, versionSha256: data.versionSha256,
          state: data.state, historySha256: data.historySha256, financialSnapshot: data.financialSnapshot,
          historyPayload: data.historyPayload, currentVersion: data.currentVersion, lastCommitId: data.lastCommitId };
        const changed = await tx.financialLedgerStream.updateMany({ where: { documentId: p.documentId, companyId: scope.companyId,
          branchId: scope.branchId, candidateOnly: true, environment: 'BETA', revision: p.stored.revision,
          sequence: p.stored.sequence, versionSha256: p.stored.versionSha256, historySha256: p.stored.historySha256 }, data: mutable });
        check(changed.count === 1, 'HEAD_CAS_FAILED');
      }
      for (const version of d.versions) if (!p.stored || version.revision > p.stored.revision)
        await tx.financialLedgerVersion.create({ data: { documentId: p.documentId, companyId: scope.companyId, branchId: scope.branchId,
          revision: version.revision, versionSha256: version.sha256, previousSha256: version.previousSha256,
          versionPayload: json(version), candidateOnly: true, commitId: v.plan.planId } });
      for (const entry of uniqueEntries(input, p.documentId)) if (!p.stored || entry.sequence > p.stored.sequence) {
        const outcome = v.projection.entries.find(e => e.documentId === p.documentId && e.eventId === entry.eventId && e.outcome !== 'DUPLICATE')!;
        await tx.financialLedgerEntry.create({ data: { documentId: p.documentId, companyId: scope.companyId, branchId: scope.branchId,
          eventId: entry.eventId, operationId: entry.operationId, sequence: entry.sequence, kind: entry.kind, outcome: outcome.outcome,
          entrySha256: fiscalSnapshotSha256(entry), entryPayload: json(entry), versionSha256: outcome.versionSha256,
          revision: outcome.revision, candidateOnly: true, commitId: v.plan.planId } });
      }
    }
    return { ...result, deduplicated: false };
  }

  private candidateScope(row: { companyId: number; branchId: string; issuerRuc: string; environment: string; candidateOnly: boolean; profile: string }, scope: FiscalFinancialLedgerInput['scope']) {
    check(row.companyId === scope.companyId && row.branchId === scope.branchId && row.issuerRuc === scope.issuerRuc &&
      row.environment === 'BETA' && row.candidateOnly === true && row.profile === FISCAL_FINANCIAL_LEDGER_PROFILE, 'CANDIDATE_SCOPE_MISMATCH');
  }
  private async verifyStored(tx: Tx, head: Head, incoming: FiscalFinancialLedgerInput) {
    const saved = boundedSupplementJson(head.historyPayload) as FiscalFinancialLedgerInput;
    const projection = projectFiscalFinancialLedger(saved);
    check(projection.ok && projection.documents.length === 1 && saved.documents.length === 1 && saved.documents[0].documentId === head.documentId, 'HISTORY_INTEGRITY');
    const original = projection.documents[0];
    same(saved.scope, incoming.scope); same(saved.documents, incoming.documents); same(saved.reservations ?? [], incoming.reservations ?? [], 'RESERVATIONS_IMMUTABLE');
    check(head.historySha256 === fiscalSnapshotSha256(saved) && head.originalSha256 === original.originalSha256 &&
      head.versionSha256 === original.currentVersion.sha256 && head.revision === original.currentVersion.revision &&
      head.sequence === original.lastSequence && head.state === original.currentVersion.state, 'HISTORY_INTEGRITY');
    same(head.originalSnapshot, original.originalSnapshot); same(head.financialSnapshot, original.financialSnapshot); same(head.currentVersion, original.currentVersion);
    check(incoming.entries.length >= saved.entries.length, 'HISTORY_TRUNCATED');
    saved.entries.forEach((entry, i) => same(entry, incoming.entries[i], 'HISTORY_REWRITE'));
    const recomputed = projectFiscalFinancialLedger(incoming); check(recomputed.ok, 'HISTORY_INTEGRITY');
    // Every stored version remains immutable, including revision 0/reservations.
    const versions = await tx.financialLedgerVersion.findMany({ where: { documentId: head.documentId, companyId: head.companyId, branchId: head.branchId },
      orderBy: { revision: 'asc' }, take: 102, select: { revision: true, versionSha256: true, previousSha256: true, versionPayload: true, candidateOnly: true } });
    check(versions.length === original.versions.length && versions.length <= 101, 'VERSIONS_INTEGRITY');
    versions.forEach((row, i) => {
      const version = original.versions[i]; check(row.candidateOnly && row.revision === version.revision && row.versionSha256 === version.sha256 && row.previousSha256 === version.previousSha256, 'VERSIONS_INTEGRITY');
      same(row.versionPayload, version); same(version, recomputed.documents[0].versions[i], 'VERSION_REWRITE');
    });
    const entries = await tx.financialLedgerEntry.findMany({ where: { documentId: head.documentId, companyId: head.companyId, branchId: head.branchId },
      orderBy: { sequence: 'asc' }, take: 101, select: { eventId: true, operationId: true, sequence: true, kind: true, outcome: true,
        entrySha256: true, entryPayload: true, versionSha256: true, revision: true, candidateOnly: true } });
    check(entries.length === saved.entries.length && entries.length <= 100, 'ENTRIES_INTEGRITY');
    entries.forEach((row, i) => {
      const entry = saved.entries[i], outcome = projection.entries[i];
      check(row.candidateOnly && row.eventId === entry.eventId && row.operationId === entry.operationId && row.sequence === entry.sequence &&
        row.kind === entry.kind && row.entrySha256 === fiscalSnapshotSha256(entry) && row.outcome === outcome.outcome &&
        row.versionSha256 === outcome.versionSha256 && row.revision === outcome.revision, 'ENTRIES_INTEGRITY');
      same(row.entryPayload, entry);
    });
  }

  private async ownSnapshot(tx: Tx, snapshot: Snapshot, actor: BetaSupplementActor, scope: FiscalFinancialLedgerInput['scope']) {
    check(snapshot.companyId === scope.companyId && snapshot.branchId === scope.branchId && snapshot.environment === 'BETA' && snapshot.issuer.identityNumber === scope.issuerRuc, 'OWN_SNAPSHOT_MISMATCH');
    const document = await tx.document.findUnique({ where: { id: snapshot.documentId }, select: { id: true, companyId: true, emissionPointId: true,
      seriesCounterId: true, type: true, status: true, series: true, number: true, fullNumber: true, currencyCode: true, payableAmount: true, immutableSnapshot: true } });
    check(document?.id === snapshot.documentId && document.companyId === scope.companyId && document.status === 'ISSUED' && document.type === TYPES[snapshot.documentTypeCode as keyof typeof TYPES] &&
      document.series === snapshot.series && document.number === BigInt(snapshot.number) && document.fullNumber === snapshot.fullNumber && document.currencyCode === snapshot.currencyCode &&
      parseDecimal(String(document.payableAmount), 2) === parseDecimal(snapshot.totals.payableAmount, 2), 'OWN_SNAPSHOT_MISMATCH');
    same(boundedSupplementJson(document.immutableSnapshot), snapshot, 'OWN_SNAPSHOT_MISMATCH');
    const point = await tx.emissionPoint.findUnique({ where: { id: document.emissionPointId }, select: { id: true, companyId: true, branchId: true, code: true, active: true } });
    const series = await tx.seriesCounter.findUnique({ where: { id: document.seriesCounterId }, select: { id: true, companyId: true, emissionPointId: true, documentType: true, series: true, active: true } });
    check(point?.id === document.emissionPointId && point.active && point.companyId === scope.companyId && point.branchId === scope.branchId && point.code === snapshot.issuer.establishmentCode &&
      series?.id === document.seriesCounterId && series.active && series.companyId === scope.companyId && series.emissionPointId === point.id && series.documentType === document.type && series.series === snapshot.series &&
      allowsResource(actor.scope, scope.branchId, point.id, series.id), 'SCOPE_DENIED');
    return document;
  }
  private async command(tx: Tx, operationId: string, scope: FiscalFinancialLedgerInput['scope']) {
    const rows = await tx.outboxEvent.findMany({ where: { eventType: 'billing.beta.supplement.requested.v1', aggregateId: operationId }, select: { id: true, payload: true }, take: 2 });
    check(rows.length === 1, 'OWN_COMMAND_REQUIRED');
    const command = validateFiscalSupplementCommand(rows[0].payload);
    check(command.eventId === rows[0].id && command.payload.operationId === operationId && command.payload.companyId === scope.companyId &&
      command.payload.branchId === scope.branchId && command.payload.issuerRuc === scope.issuerRuc, 'OWN_COMMAND_MISMATCH');
    return command;
  }
  private contextBinding(a: { asOf: string }, b: { asOf: string }) {
    const { asOf: createdAt, ...created } = a, { asOf, ...now } = b;
    same(created, now, 'NOTE_CONTEXT_MISMATCH'); check(Date.parse(asOf) >= Date.parse(createdAt), 'NOTE_CONTEXT_MISMATCH');
  }
  private async backingOperation(tx: Tx, input: FiscalFinancialLedgerInput, entry: Entry, actor: BetaSupplementActor) {
    const command = await this.command(tx, entry.operationId, input.scope), envelope = command.payload.envelope;
    check(Date.parse(entry.evidence.acceptedAt) >= Date.parse(command.occurredAt), 'EVIDENCE_TIME_MISMATCH');
    if (entry.kind === 'NOTE_CREDIT' || entry.kind === 'NOTE_DEBIT') {
      await this.ownSnapshot(tx, entry.nextSnapshot, actor, input.scope);
      if (envelope.kind === 'NOTE') { same(envelope.note, entry.nextSnapshot); this.contextBinding(envelope.context, entry.noteContext); }
      else {
        check(envelope.batch.kind === 'RC', 'OWN_COMMAND_MISMATCH');
        const member = envelope.batch.input.entries.find(e => e.document.snapshot.documentId === entry.nextSnapshot.documentId);
        check(member && 'conditionCode' in member && member.conditionCode === '1' && member.document.noteContext, 'OWN_COMMAND_MISMATCH');
        same(member.document.snapshot, entry.nextSnapshot); this.contextBinding(member.document.noteContext, entry.noteContext);
      }
      return;
    }
    check(envelope.kind === 'BATCH', 'OWN_COMMAND_MISMATCH');
    const member = envelope.batch.input.entries.find(e => e.document.snapshot.documentId === entry.documentId);
    check(member, 'OWN_COMMAND_MISMATCH'); same(member.document.snapshot, entry.nextSnapshot);
    if (entry.kind === 'RC_REPLACE') check('conditionCode' in member && member.conditionCode === '2', 'OWN_COMMAND_MISMATCH');
    else if (entry.kind === 'VOID') { check('notDelivered' in member && member.notDelivered && (envelope.batch.kind === 'RA' || 'conditionCode' in member && member.conditionCode === '3'), 'OWN_COMMAND_MISMATCH'); same(member.notDelivered, entry.notDelivered); }
    else check(false, 'OWN_COMMAND_MISMATCH');
  }
}
