import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { projectFiscalFinancialLedger } from '../packages/sunat-core/src/fiscal-financial-ledger';
import { calculateDocumentTotals } from '../packages/sunat-core/src/tax';
import { buildFiscalNoteSnapshot, fiscalSnapshotSha256 } from '../packages/sunat-core/src/fiscal-note';
import { buildFiscalBatchSnapshot } from '../packages/sunat-core/src/fiscal-batch';
import { buildFiscalSupplementCommand } from '../packages/sunat-core/src/fiscal-supplement-command';
import { FinancialLedgerCandidateRepository } from '../services/billing-service/src/application/financial-ledger-candidate.repository';
import { assertFinancialLedgerCandidateActivation, FinancialLedgerCandidateService } from '../services/billing-service/src/application/financial-ledger-candidate.service';
import { supplementCommandFixture, supplementUuid as id } from './helpers/fiscal-supplement.fixture';

// In-memory transactional PORT. No Prisma client, DB, files, clock, certificates,
// credentials, sockets or Docker. Does NOT establish PostgreSQL lock semantics.
const clone = <T>(v: T): T => structuredClone(v);
type Row = Record<string, any>;
const profile = 'FACTUEZ-BETA-FINANCIAL-LEDGER-v1';
function fixture(kind: 'NOTE' | 'RC' = 'NOTE') {
  const f = supplementCommandFixture(kind), scope = { issuerRuc: f.doc.issuer.identityNumber, companyId: 99, branchId: f.doc.branchId!, environment: 'BETA' as const };
  const actor = { userId: id(90), scope: { kind: 'ASSIGNED' as const, branchIds: [scope.branchId], emissionPointIds: [id(20)], series: [id(21), id(22), id(23)] } };
  const types = { '01': 'INVOICE', '03': 'SALES_RECEIPT', '07': 'CREDIT_NOTE', '08': 'DEBIT_NOTE' } as const;
  const tables: Record<string, Row[]> = {
    companySettings: [{ id: 99, ruc: scope.issuerRuc, environment: 'BETA' }], branch: [{ id: scope.branchId, companyId: 99, active: true }],
    emissionPoint: [{ id: id(20), companyId: 99, branchId: scope.branchId, code: '0000', active: true }],
    seriesCounter: [{ id: id(21), companyId: 99, emissionPointId: id(20), documentType: types[f.doc.documentTypeCode as '01' | '03'], series: f.doc.series, active: true },
      { id: id(22), companyId: 99, emissionPointId: id(20), documentType: 'CREDIT_NOTE', series: f.note.series, active: true },
      { id: id(23), companyId: 99, emissionPointId: id(20), documentType: 'DEBIT_NOTE', series: 'FD01', active: true }],
    document: [], outboxEvent: [], financialLedgerCommit: [], financialLedgerStream: [], financialLedgerVersion: [], financialLedgerEntry: [],
  };
  function seedDoc(s: Row) { tables.document.push({ id: s.documentId, companyId: 99, emissionPointId: id(20), seriesCounterId: id(s.documentTypeCode === '07' ? 22 : s.documentTypeCode === '08' ? 23 : 21),
    type: types[s.documentTypeCode as keyof typeof types], status: 'ISSUED', series: s.series, number: BigInt(s.number), fullNumber: s.fullNumber,
    currencyCode: s.currencyCode, payableAmount: s.totals.payableAmount, immutableSnapshot: clone(s), referencesFrom: s.reference ? [{ targetDocumentId: s.reference.documentId }] : [] }); }
  seedDoc(f.doc);
  function seedCommand(command = f.command) { tables.outboxEvent.push({ id: command.eventId, aggregateId: command.payload.operationId, eventType: command.eventName, payload: clone(command) }); }
  function matches(row: Row, where: Row): boolean {
    return Object.entries(where ?? {}).every(([key, value]) => {
      if (key === 'OR') return value.some((v: Row) => matches(row, v));
      if (!(key in row) && key.includes('_')) return matches(row, value);
      const actual = row[key];
      if (value && typeof value === 'object') {
        if ('some' in value) return actual?.some((v: Row) => matches(v, value.some)) ?? false;
        if ('path' in value) return value.path.reduce((v: any, p: string) => v?.[p], actual) === value.equals;
        if ('in' in value) return value.in.includes(actual);
        return matches(actual, value);
      }
      return actual === value;
    });
  }
  function select(row: Row | undefined, fields?: Row) { if (!row) return null; return clone(fields ? Object.fromEntries(Object.keys(fields).filter(k => fields[k] === true).map(k => [k, row[k]])) : row); }
  const calls: Array<{ table: string; method: string; data: any }> = [], locks: string[] = [], options: Row[] = [];
  const faults = { cas: false, create: '', commit: false, serializations: 0 };
  const tx: Row = { $executeRaw: vi.fn(async (_strings: unknown, key: string) => { locks.push(key); return 1; }) };
  for (const table of Object.keys(tables)) {
    const append = table.startsWith('financialLedger');
    tx[table] = {
      findUnique: vi.fn(async (args: Row) => select(tables[table].find(r => matches(r, args.where)), args.select)),
      findMany: vi.fn(async (args: Row) => {
        let rows = tables[table].filter(r => matches(r, args.where));
        if (args.orderBy) { const field = Object.keys(args.orderBy)[0]; rows = [...rows].sort((a, b) => a[field] - b[field]); }
        return rows.slice(0, args.take ?? rows.length).map(r => select(r, args.select));
      }),
      create: vi.fn(async (args: Row) => {
        expect(append).toBe(true); calls.push({ table, method: 'create', data: clone(args.data) });
        if (faults.create === table) throw new Error('PRIVATE_CIPHER_DB_ERROR');
        const d = args.data;
        if (table === 'financialLedgerCommit') expect(tables[table].some(r => r.planId === d.planId)).toBe(false);
        if (table === 'financialLedgerStream') expect(tables[table].some(r => r.documentId === d.documentId)).toBe(false);
        if (table === 'financialLedgerVersion') expect(tables[table].some(r => r.documentId === d.documentId && (r.revision === d.revision || r.versionSha256 === d.versionSha256))).toBe(false);
        if (table === 'financialLedgerEntry') expect(tables[table].some(r => r.documentId === d.documentId && (r.eventId === d.eventId || r.operationId === d.operationId || r.sequence === d.sequence))).toBe(false);
        tables[table].push(clone(d)); return clone(d);
      }),
      updateMany: vi.fn(async (args: Row) => {
        expect(table).toBe('financialLedgerStream'); calls.push({ table, method: 'updateMany', data: clone(args.data) });
        if (faults.cas) return { count: 0 };
        const rows = tables[table].filter(r => matches(r, args.where)); rows.forEach(r => Object.assign(r, clone(args.data))); return { count: rows.length };
      }),
      update: vi.fn(() => { throw new Error('IMMUTABLE'); }), delete: vi.fn(() => { throw new Error('IMMUTABLE'); }), deleteMany: vi.fn(() => { throw new Error('IMMUTABLE'); }),
    };
  }
  let tail = Promise.resolve();
  const prisma = { $transaction: vi.fn((action: (tx: Row) => Promise<any>, option: Row) => {
    options.push(option);
    const work = tail.then(async () => {
      const before = clone(tables);
      try {
        if (faults.serializations-- > 0) throw Object.assign(new Error('PRIVATE-SERIALIZATION'), { code: 'P2034' });
        const result = await action(tx); if (faults.commit) throw new Error('PRIVATE-COMMIT'); return result;
      } catch (error) { for (const key of Object.keys(tables)) tables[key] = before[key]; throw error; }
    });
    tail = work.then(() => {}, () => {}); return work;
  }) };
  const repo = new FinancialLedgerCandidateRepository(prisma as never);
  const plan: any = { planId: id(91), input: { scope, documents: [clone(f.doc)], entries: [] }, expectedHeads: [{ documentId: f.doc.documentId, revision: 0, sequence: 0, versionSha256: null }] };
  function checkpoint(p = plan) { return p.input.documents.map((d: Row) => { const h = tables.financialLedgerStream.find(r => r.documentId === d.documentId);
    return { documentId: d.documentId, revision: h?.revision ?? 0, sequence: h?.sequence ?? 0, versionSha256: h?.versionSha256 ?? null }; }); }
  function credit(p = plan, mode = 'ACCEPTED') {
    const data = clone(p); data.planId = id(92); data.expectedHeads = checkpoint(data);
    if (!tables.document.some(r => r.id === f.note.documentId)) { seedDoc(f.note); seedCommand(); }
    const projection = projectFiscalFinancialLedger(data.input); if (!projection.ok) throw new Error('FIXTURE');
    data.input.entries.push({ ...scope, documentId: f.doc.documentId, eventId: id(93), operationId: f.note.documentId, sequence: 1,
      expectedPreviousSha256: projection.documents[0].currentVersion.sha256, kind: 'NOTE_CREDIT', nextSnapshot: clone(f.note),
      noteContext: { ...clone(f.context), asOf: '2026-10-04T18:00:00Z' }, evidence: { status: mode === 'REJECTED' ? 'REJECTED' : 'ACCEPTED',
        cdrSignatureVerified: mode !== 'UNVERIFIED', officialCdr: mode !== 'UNVERIFIED', responseCode: mode === 'REJECTED' ? '2335' : '0',
        cdrSha256: 'b'.repeat(64), requestSha256: 'c'.repeat(64), acceptedAt: '2026-10-03T18:10:00Z' } });
    return data;
  }
  return { f, scope, actor, tables, calls, options, faults, tx, prisma, repo, plan, checkpoint, credit, seedDoc, seedCommand, locks };
}

describe('persistencia candidata transaccional, exclusivamente puertos en memoria', () => {
  it('base BETA conserva original y escribe sólo commit/head/versión candidata', async () => {
    const h = fixture(), source = clone(h.tables.document);
    const result = await h.repo.commit(h.plan, h.actor);
    expect(result).toMatchObject({ candidateOnly: true, persistedCandidate: true, fiscalAuthority: false, transmissionAuthorized: false, evidenceAuthenticityVerified: false, deduplicated: false });
    expect(h.tables.document).toEqual(source); expect(h.calls.map(c => c.table)).toEqual(['financialLedgerCommit', 'financialLedgerStream', 'financialLedgerVersion']);
    expect(h.options).toEqual([{ isolationLevel: 'Serializable', maxWait: 2000, timeout: 10000 }]);
    expect(h.locks[0]).toBe(`factuez:beta-supplement:company:99:ruc:${h.scope.issuerRuc}`);
    expect(h.tables.financialLedgerStream[0].revision).toBe(0); expect(h.tables.financialLedgerStream[0].originalSnapshot).toEqual(h.f.doc);
  });
  it('append guarda nota en ledger separado sin cambiar ventas, series, estados o Outbox', async () => {
    const h = fixture(); await h.repo.commit(h.plan, h.actor); const plan = h.credit(), before = clone({ docs: h.tables.document, counters: h.tables.seriesCounter, outbox: h.tables.outboxEvent });
    const result = await h.repo.commit(plan, h.actor); expect(result.targets[0]).toMatchObject({ revision: 1, sequence: 1 });
    expect(h.tables.financialLedgerStream[0].currentVersion.net.payableAmount).toBe('118.00');
    expect(h.tables.financialLedgerStream[0].originalSnapshot.totals.payableAmount).toBe('236.00');
    expect({ docs: h.tables.document, counters: h.tables.seriesCounter, outbox: h.tables.outboxEvent }).toEqual(before);
    const update = h.calls.find(c => c.method === 'updateMany')!;
    for (const field of ['originalSnapshot', 'originalSha256', 'issuerRuc', 'companyId', 'branchId', 'candidateOnly', 'environment', 'profile']) expect(update.data).not.toHaveProperty(field);
    expect(h.tables.financialLedgerVersion).toHaveLength(2); expect(h.tables.financialLedgerEntry).toHaveLength(1);
  });
  it('deduplica plan exacto después del commit y reautoriza incluso en replay', async () => {
    const h = fixture(); await h.repo.commit(h.plan, h.actor); const plan = h.credit(); await h.repo.commit(plan, h.actor);
    const before = clone(h.tables), count = h.calls.length;
    await expect(h.repo.commit(plan, h.actor)).resolves.toMatchObject({ deduplicated: true }); expect(h.tables).toEqual(before); expect(h.calls).toHaveLength(count);
    await expect(h.repo.commit(plan, { ...h.actor, scope: { ...h.actor.scope, series: [] } })).rejects.toThrow('SCOPE_DENIED'); expect(h.tables).toEqual(before);
  });
  it('replay de recibo histórico no pierde idempotencia por notas posteriores ni rebobina la cabeza', async () => {
    const h = fixture(); const base = await h.repo.commit(h.plan, h.actor);
    await h.repo.commit(h.credit(), h.actor);
    const before = clone(h.tables), count = h.calls.length;
    await expect(h.repo.commit(h.plan, h.actor)).resolves.toEqual({ ...base, deduplicated: true });
    expect(h.tables).toEqual(before); expect(h.calls).toHaveLength(count);
    expect(h.tables.financialLedgerStream[0]).toMatchObject({ revision: 1, sequence: 1, currentVersion: { net: { payableAmount: '118.00' } } });
    // A new plan cannot exploit the old receipt to omit the credit history.
    const newPlan = clone(h.plan); newPlan.planId = id(99); newPlan.expectedHeads = h.checkpoint(newPlan);
    await expect(h.repo.commit(newPlan, h.actor)).rejects.toThrow('INCOMPLETE_OWN_CREDITS');
    expect(h.tables).toEqual(before);
    await expect(h.repo.commit(h.plan, { ...h.actor, scope: { ...h.actor.scope, series: [] } })).rejects.toThrow('SCOPE_DENIED');
    expect(h.tables).toEqual(before);
  });
  it.each(['REJECTED', 'UNVERIFIED'])('%s sólo avanza secuencia y no crea efecto financiero', async mode => {
    const h = fixture(); await h.repo.commit(h.plan, h.actor); const plan = h.credit(h.plan, mode); await h.repo.commit(plan, h.actor);
    expect(h.tables.financialLedgerStream[0]).toMatchObject({ sequence: 1, revision: 0 }); expect(h.tables.financialLedgerVersion).toHaveLength(1);
    expect(h.tables.financialLedgerStream[0].currentVersion.net.payableAmount).toBe('236.00');
    expect(h.tables.financialLedgerEntry[0].outcome).toBe(mode === 'REJECTED' ? 'REJECTED' : 'EVIDENCE_UNVERIFIED');
  });
  it.each(['financialLedgerCommit', 'financialLedgerStream', 'financialLedgerVersion', 'financialLedgerEntry'])('revierte todo al fallar %s', async table => {
    const h = fixture(), plan = h.credit(), before = clone(h.tables); h.faults.create = table;
    await expect(h.repo.commit(plan, h.actor)).rejects.toThrow('STORAGE_FAILED'); expect(h.tables).toEqual(before);
  });
  it.each(['cas', 'commit'])('revierte receipt, versión y evento ante fallo %s', async fault => {
    const h = fixture(); await h.repo.commit(h.plan, h.actor); const plan = h.credit(), before = clone(h.tables);
    h.faults[fault as 'cas' | 'commit'] = true; await expect(h.repo.commit(plan, h.actor)).rejects.toThrow(fault === 'cas' ? 'HEAD_CAS_FAILED' : 'STORAGE_FAILED'); expect(h.tables).toEqual(before);
  });
  it('retry P2034 conserva el mismo plan y se limita a tres intentos', async () => {
    const h = fixture(); h.faults.serializations = 2; await h.repo.commit(h.plan, h.actor); expect(h.options).toHaveLength(3); expect(h.tables.financialLedgerCommit).toHaveLength(1);
    const failed = fixture(); failed.faults.serializations = 3; const before = clone(failed.tables);
    await expect(failed.repo.commit(failed.plan, failed.actor)).rejects.toThrow('STORAGE_FAILED'); expect(failed.options).toHaveLength(3); expect(failed.tables).toEqual(before);
  });
  it.each(['company', 'branch', 'point', 'series', 'snapshot', 'amount'])('bloquea corrupción propia %s antes de escribir ledger', async kind => {
    const h = fixture();
    if (kind === 'company') h.tables.companySettings[0].environment = 'PRODUCTION';
    if (kind === 'branch') h.tables.branch[0].companyId = 100;
    if (kind === 'point') h.tables.emissionPoint[0].branchId = id(100);
    if (kind === 'series') h.tables.seriesCounter[0].companyId = 100;
    if (kind === 'snapshot') h.tables.document[0].immutableSnapshot.customer.legalName = 'CAMBIADO';
    if (kind === 'amount') h.tables.document[0].payableAmount = '0.00';
    await expect(h.repo.commit(h.plan, h.actor)).rejects.toThrow(); expect(h.calls).toHaveLength(0);
  });
  it('rechaza un checkpoint viejo, incluso si el cálculo candidato es válido', async () => {
    const h = fixture(); await h.repo.commit(h.plan, h.actor); const plan = h.credit(); plan.expectedHeads[0].versionSha256 = null;
    const before = clone(h.tables); await expect(h.repo.commit(plan, h.actor)).rejects.toThrow('STALE_HEAD'); expect(h.tables).toEqual(before);
  });
  it('mismo planId con cuerpo distinto no reemplaza la evidencia guardada', async () => {
    const h = fixture(); await h.repo.commit(h.plan, h.actor); const plan = h.credit(); plan.planId = h.plan.planId;
    const before = clone(h.tables); await expect(h.repo.commit(plan, h.actor)).rejects.toThrow('PLAN_CONFLICT'); expect(h.tables).toEqual(before);
  });
  it.each(['head', 'history', 'version', 'entry', 'receipt', 'candidate-mode'])('detecta alteración persistida %s y no la repara ni sobrescribe', async target => {
    const h = fixture(); await h.repo.commit(h.plan, h.actor); const plan = h.credit(); await h.repo.commit(plan, h.actor);
    if (target === 'head') h.tables.financialLedgerStream[0].currentVersion.net.payableAmount = '0.00';
    if (target === 'history') h.tables.financialLedgerStream[0].historyPayload.entries[0].evidence.cdrSha256 = 'd'.repeat(64);
    if (target === 'version') h.tables.financialLedgerVersion[0].versionPayload.net.payableAmount = '0.00';
    if (target === 'entry') h.tables.financialLedgerEntry[0].outcome = 'REJECTED';
    if (target === 'receipt') h.tables.financialLedgerCommit[1].resultSha256 = '0'.repeat(64);
    if (target === 'candidate-mode') h.tables.financialLedgerStream[0].candidateOnly = false;
    const before = clone(h.tables); await expect(h.repo.commit(plan, h.actor)).rejects.toThrow(); expect(h.tables).toEqual(before);
  });
  it('no permite truncar historial ni perder reservas al escribir otra cabeza', async () => {
    const h = fixture(); await h.repo.commit(h.plan, h.actor); const plan = h.credit(); await h.repo.commit(plan, h.actor);
    const shorter = clone(h.plan); shorter.planId = id(95); shorter.expectedHeads = h.checkpoint(shorter);
    // Note exists in own credit history but was silently omitted by the plan.
    const before = clone(h.tables); await expect(h.repo.commit(shorter, h.actor)).rejects.toThrow('INCOMPLETE_OWN_CREDITS'); expect(h.tables).toEqual(before);
  });
  it.each(['missing-command', 'foreign-command', 'note-copy', 'context', 'event-time'])('binding de nota rechaza %s', async target => {
    const h = fixture(), plan = h.credit();
    if (target === 'missing-command') h.tables.outboxEvent = [];
    if (target === 'foreign-command') h.tables.outboxEvent[0].aggregateId = id(100);
    if (target === 'note-copy') h.tables.document[1].immutableSnapshot.reasonDescription = 'OTRO';
    if (target === 'context') h.tables.outboxEvent[0].payload.payload.envelope.context.acceptance.cdrSha256 = 'f'.repeat(64);
    if (target === 'event-time') plan.input.entries[0].evidence.acceptedAt = '2026-10-03T17:59:00Z';
    await expect(h.repo.commit(plan, h.actor)).rejects.toThrow(); expect(h.calls).toHaveLength(0);
  });
  it('duplicados exactos no crean otra fila ni efecto', async () => {
    const h = fixture(), plan = h.credit(); plan.input.entries.push(clone(plan.input.entries[0]));
    await h.repo.commit(plan, h.actor); expect(h.tables.financialLedgerEntry).toHaveLength(1); expect(h.tables.financialLedgerStream[0].sequence).toBe(1);
    await expect(h.repo.commit(plan, h.actor)).resolves.toMatchObject({ deduplicated: true });
  });
  it.each(['REJECTED', 'UNVERIFIED'])('una reserva inicial no se libera por %s', async mode => {
    const h = fixture(); h.seedDoc(h.f.note); h.seedCommand();
    h.plan.input.reservations = [{ documentId: h.f.doc.documentId, operationId: h.f.note.documentId, note: clone(h.f.note), noteContext: clone(h.f.context) }];
    await h.repo.commit(h.plan, h.actor); const before = clone(h.tables.financialLedgerStream[0].currentVersion);
    await h.repo.commit(h.credit(h.plan, mode), h.actor);
    expect(h.tables.financialLedgerStream[0].currentVersion).toEqual(before);
    expect(h.tables.financialLedgerStream[0].historyPayload.reservations).toEqual(h.plan.input.reservations);
    expect(h.tables.financialLedgerStream[0].currentVersion.creditCapacity.payableAmount).toBe('118.00');
  });
  it('débito candidato suma al neto sin ampliar capacidad de devolución', async () => {
    const h = fixture(); await h.repo.commit(h.plan, h.actor);
    const note = buildFiscalNoteSnapshot(h.f.context, { documentTypeCode: '08', reasonCode: '02', reasonDescription: 'AJUSTE FICTICIO',
      lines: [{ originalLineNumber: 1, unitPriceAdjustmentWithTax: '11.8' }] }, { documentId: id(40), series: 'FD01', number: '1', issueDate: '2026-10-02T17:00:00Z' });
    h.seedDoc(note); h.seedCommand(buildFiscalSupplementCommand({ kind: 'NOTE', note, context: h.f.context },
      { eventId: id(41), correlationId: id(42), occurredAt: h.f.context.asOf }));
    const plan = clone(h.plan); plan.planId = id(43); plan.expectedHeads = h.checkpoint(plan);
    plan.input.entries = [{ ...h.scope, documentId: h.f.doc.documentId, eventId: id(44), operationId: note.documentId, sequence: 1,
      expectedPreviousSha256: plan.expectedHeads[0].versionSha256, kind: 'NOTE_DEBIT', nextSnapshot: note,
      noteContext: { ...clone(h.f.context), asOf: '2026-10-04T18:00:00Z' }, evidence: { status: 'ACCEPTED', cdrSignatureVerified: true, officialCdr: true,
        responseCode: '0', cdrSha256: 'b'.repeat(64), requestSha256: 'c'.repeat(64), acceptedAt: '2026-10-03T18:10:00Z' } }];
    await h.repo.commit(plan, h.actor);
    expect(h.tables.financialLedgerStream[0].currentVersion).toMatchObject({ net: { payableAmount: '259.60' }, creditCapacity: { payableAmount: '236.00' } });
  });
  it('baja candidata conserva importes sin cancelar ni reescribir el original', async () => {
    const h = fixture(); await h.repo.commit(h.plan, h.actor); const ra = supplementCommandFixture('RA'); h.seedCommand(ra.command);
    const plan = clone(h.plan); plan.planId = id(60); plan.expectedHeads = h.checkpoint(plan);
    const member: any = ra.batch!.input.entries[0];
    plan.input.entries = [{ ...h.scope, documentId: h.f.doc.documentId, eventId: id(61), operationId: ra.batch!.documentId, sequence: 1,
      expectedPreviousSha256: plan.expectedHeads[0].versionSha256, kind: 'VOID', nextSnapshot: clone(h.f.doc), notDelivered: member.notDelivered,
      evidence: { status: 'ACCEPTED', cdrSignatureVerified: true, officialCdr: true, responseCode: '0', cdrSha256: 'b'.repeat(64), requestSha256: 'c'.repeat(64), acceptedAt: '2026-10-03T18:10:00Z' } }];
    const originals = clone(h.tables.document); await h.repo.commit(plan, h.actor);
    expect(h.tables.document).toEqual(originals); expect(h.tables.financialLedgerStream[0]).toMatchObject({ state: 'VOIDED', currentVersion: { net: { payableAmount: '236.00' } } });
  });
  it('concurrencia simulada exacta produce una reserva y un replay', async () => {
    const h = fixture(), plan = h.credit(); const results = await Promise.all([h.repo.commit(plan, h.actor), h.repo.commit(plan, h.actor)]);
    expect(results.map(r => r.deduplicated)).toEqual([false, true]); expect(h.tables.financialLedgerCommit).toHaveLength(1);
  });
  it('dos planes distintos sobre el mismo checkpoint no aplican dos veces', async () => {
    const h = fixture(); await h.repo.commit(h.plan, h.actor); const first = h.credit(), second = clone(first); second.planId = id(96);
    const results = await Promise.allSettled([h.repo.commit(first, h.actor), h.repo.commit(second, h.actor)]);
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']); expect(h.tables.financialLedgerEntry).toHaveLength(1);
    expect(h.tables.financialLedgerStream[0].currentVersion.net.payableAmount).toBe('118.00');
  });
  it('añadir una reserva a la base ya congelada requiere otro protocolo, no reescribir revisión 0', async () => {
    const h = fixture(); await h.repo.commit(h.plan, h.actor); h.seedDoc(h.f.note); h.seedCommand();
    const plan = clone(h.plan); plan.planId = id(97); plan.expectedHeads = h.checkpoint(plan);
    plan.input.reservations = [{ operationId: h.f.note.documentId, documentId: h.f.doc.documentId, note: clone(h.f.note), noteContext: clone(h.f.context) }];
    const before = clone(h.tables); await expect(h.repo.commit(plan, h.actor)).rejects.toThrow('RESERVATIONS_IMMUTABLE'); expect(h.tables).toEqual(before);
  });
  it('un prefijo reescrito no se guarda aunque vuelva a calcularse como plan coherente', async () => {
    const h = fixture(); await h.repo.commit(h.plan, h.actor); const first = h.credit(); await h.repo.commit(first, h.actor);
    const rewritten = clone(first); rewritten.planId = id(98); rewritten.expectedHeads = h.checkpoint(rewritten);
    rewritten.input.entries[0].evidence.cdrSha256 = 'e'.repeat(64);
    const before = clone(h.tables); await expect(h.repo.commit(rewritten, h.actor)).rejects.toThrow('HISTORY_REWRITE'); expect(h.tables).toEqual(before);
  });
  it('simula un RC2 de varios originales con evento/operación padres compartidos y locks ordenados', async () => {
    const h = fixture('RC'), second = clone(h.f.doc); second.documentId = id(50); second.number = '2'; second.fullNumber = `${second.series}-2`; h.seedDoc(second);
    h.plan.input.documents.unshift(second); await h.repo.commit({ ...h.plan, expectedHeads: h.checkpoint(h.plan) }, h.actor);
    const next = h.plan.input.documents.map((d: Row) => ({ ...d, ...calculateDocumentTotals(d.lines.map((line: Row) => ({ ...line, unitPriceWithTax: '59' }))) }));
    const batch = buildFiscalBatchSnapshot({ kind: 'RC', entries: next.map((d: any, i: number) => ({ conditionCode: '2', document: { snapshot: d },
      previous: { document: { snapshot: h.plan.input.documents[i] }, acceptance: { ...h.f.acceptance,
        documentId: d.documentId, fullNumber: d.fullNumber, snapshotSha256: fiscalSnapshotSha256(h.plan.input.documents[i]),
        source: { kind: 'CDR_SUMMARY', identifier: 'RC-20261002-1', referenceDate: '2026-10-02', lineNumber: i + 1, conditionCode: '1' } } } })) },
      { documentId: id(70), identifier: 'RC-20261003-2', issueDate: '2026-10-03', referenceDate: '2026-10-02' }, '2026-10-03T18:00:00Z');
    const command = buildFiscalSupplementCommand({ kind: 'BATCH', batch, asOf: '2026-10-03T18:00:00Z' },
      { eventId: id(71), correlationId: id(72), occurredAt: '2026-10-03T18:00:00Z' }); h.seedCommand(command);
    const plan = clone(h.plan); plan.planId = id(73); plan.expectedHeads = h.checkpoint(plan);
    plan.input.entries = next.map((d: Row) => ({ ...h.scope, documentId: d.documentId, eventId: id(74), operationId: batch.documentId, sequence: 1,
      kind: 'RC_REPLACE', nextSnapshot: d, expectedPreviousSha256: plan.expectedHeads.find((head: Row) => head.documentId === d.documentId).versionSha256,
      evidence: { status: 'ACCEPTED', cdrSignatureVerified: true, officialCdr: true, cdrSha256: 'b'.repeat(64), requestSha256: 'c'.repeat(64), responseCode: '0', acceptedAt: '2026-10-03T18:10:00Z' } }));
    await h.repo.commit(plan, h.actor);
    expect(h.tables.financialLedgerEntry).toHaveLength(2); expect(h.tables.financialLedgerStream.map(row => row.currentVersion.net.payableAmount)).toEqual(['118.00', '118.00']);
    expect(h.locks.filter(k => k.includes(':document:')).slice(-2)).toEqual([h.f.doc.documentId, second.documentId].sort().map(doc => `factuez:financial-candidate:document:${doc}`));
    expect(h.tables.financialLedgerStream.every(row => row.originalSnapshot.totals.payableAmount === '236.00')).toBe(true);
  });
  it('gate del servicio siempre rechaza antes de DB aunque flags se activen', async () => {
    const commit = vi.fn(); const service = new FinancialLedgerCandidateService({ commit } as never);
    expect(() => assertFinancialLedgerCandidateActivation()).toThrow('Persistencia candidata BETA bloqueada');
    const getter = vi.fn(() => { throw new Error('PRIVATE'); });
    await expect(service.commit(Object.defineProperty({}, 'input', { get: getter }), {} as never)).rejects.toThrow('Persistencia candidata BETA bloqueada');
    expect(commit).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled();
  });
  it('errores no exponen datos o trazas de Prisma ni payloads privados', async () => {
    const h = fixture(); h.faults.create = 'financialLedgerCommit';
    try { await h.repo.commit(h.plan, h.actor); throw new Error('EXPECTED'); } catch (error: any) {
      expect(error.message).toBe('Ledger candidato BETA: STORAGE_FAILED'); expect(error.stack).toBeUndefined(); expect(JSON.stringify(error)).not.toContain('PRIVATE');
    }
  });
});
