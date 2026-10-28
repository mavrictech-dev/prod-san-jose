import { Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FiscalDocumentSnapshot } from '../packages/contracts/src/events';
import { calculateDocumentTotals } from '../packages/sunat-core/src/tax';
import {
  buildFiscalNoteSnapshot, fiscalSnapshotSha256, type FiscalAcceptanceEvidence, type FiscalNoteContext,
  type FiscalNoteInput, type FiscalNoteSnapshot,
} from '../packages/sunat-core/src/fiscal-note';
import { buildFiscalBatchSnapshot, type FiscalBatchInput, type FiscalNotDeliveredEvidence } from '../packages/sunat-core/src/fiscal-batch';
import { buildFiscalSupplementCommand, type FiscalSupplementCommand } from '../packages/sunat-core/src/fiscal-supplement-command';
import { BetaSupplementCommandRepository, type BetaSupplementActor } from '../services/billing-service/src/application/beta-supplement-command.repository';
import { supplementCommandFixture, supplementUuid } from './helpers/fiscal-supplement.fixture';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const asOf = '2026-10-04T18:00:00Z';
const branchId = uuid(2), pointId = uuid(3), ruc = '20100070970';
const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const types = { '01': 'INVOICE', '03': 'SALES_RECEIPT', '07': 'CREDIT_NOTE', '08': 'DEBIT_NOTE' } as const;
const counterId = (doc: FiscalDocumentSnapshot) => uuid(doc.documentTypeCode === '01' ? 10 : doc.documentTypeCode === '03' ? 11 : doc.documentTypeCode === '07' ? (doc.series[0] === 'B' ? 22 : 20) : (doc.series[0] === 'B' ? 23 : 21));
const actor: BetaSupplementActor = { userId: uuid(4), scope: { kind: 'ASSIGNED', branchIds: [branchId], emissionPointIds: [pointId], series: [10, 11, 20, 21, 22, 23].map(uuid) } };
// Same known fiscal-note/fiscal-batch fixture values, all fabricated in memory.
// Structural RUC strings are not real operations, CDRs, certificates or DB data.
function original(type: '01' | '03' = '01', id = 1): FiscalDocumentSnapshot {
  const series = type === '01' ? 'F001' : 'B001';
  return { documentId: uuid(id), companyId: 1, branchId, environment: 'BETA', documentTypeCode: type,
    series, number: String(id), fullNumber: `${series}-${id}`, issueDate: '2026-10-02T16:00:00Z', currencyCode: 'PEN', operationTypeCode: '0101',
    ...(type === '01' ? { paymentTerms: { type: 'CONTADO' as const } } : {}),
    issuer: { identityType: '6', identityNumber: ruc, legalName: 'Emisor simulado', address: 'Dirección simulada', ubigeo: '150101', establishmentCode: '0000' },
    customer: { identityType: '6', identityNumber: '20131312955', legalName: 'Cliente simulado' },
    ...calculateDocumentTotals([
      { description: 'Producto uno', unitCode: 'NIU', quantity: '2', unitPriceWithTax: '118', taxAffectationCode: '10', igvRate: '18' },
      { description: 'Producto dos', unitCode: 'KGM', quantity: '1', unitPriceWithTax: '59', taxAffectationCode: '10', igvRate: '18' },
    ]) };
}
function acceptance(doc: FiscalDocumentSnapshot): FiscalAcceptanceEvidence {
  return { environment: 'BETA', issuerRuc: ruc, documentId: doc.documentId,
    documentTypeCode: doc.documentTypeCode as FiscalAcceptanceEvidence['documentTypeCode'], fullNumber: doc.fullNumber,
    snapshotSha256: fiscalSnapshotSha256(doc), cdrSha256: 'a'.repeat(64), responseCode: '0', status: 'ACCEPTED', acceptedAt: '2026-10-02T16:10:00Z',
    source: doc.series[0] === 'B' ? { kind: 'CDR_SUMMARY', identifier: 'RC-20261002-1', referenceDate: '2026-10-02', lineNumber: 1, conditionCode: '1' } : { kind: 'CDR_DOCUMENT' } };
}
function context(doc = original()): FiscalNoteContext {
  return { original: doc, acceptance: acceptance(doc), asOf, creditHistory: { complete: true, entries: [] } };
}
const partial: FiscalNoteInput = { documentTypeCode: '07', reasonCode: '07', reasonDescription: 'Devolución parcial', lines: [{ originalLineNumber: 1, quantity: '1' }] };
const increase: FiscalNoteInput = { documentTypeCode: '08', reasonCode: '02', reasonDescription: 'Aumento pactado', lines: [{ originalLineNumber: 1, unitPriceAdjustmentWithTax: '11.8' }] };
const interest: FiscalNoteInput = { documentTypeCode: '08', reasonCode: '01', reasonDescription: 'Interés moratorio', interestNature: 'MORATORIO', interestBasis: 'Sustento simulado', lines: [{ originalLineNumber: 1, interestAmount: '12.34' }] };
function note(ctx = context(), id = 100, number = id, input = partial): FiscalNoteSnapshot {
  return clean(buildFiscalNoteSnapshot(ctx, input, { documentId: uuid(id), series: ctx.original.series[0] === 'B' ? 'BN01' : 'FN01', number: String(number), issueDate: '2026-10-02T17:00:00Z' }));
}
function noteCommand(ctx = context(), id = 100, number = id, input = partial, event = 1000): FiscalSupplementCommand {
  return buildFiscalSupplementCommand(clean({ kind: 'NOTE', note: note(ctx, id, number, input), context: ctx }),
    { eventId: uuid(event), correlationId: uuid(2000), occurredAt: asOf });
}
function notDelivered(doc: FiscalDocumentSnapshot): FiscalNotDeliveredEvidence {
  return { status: 'NOT_DELIVERED', documentId: doc.documentId, documentTypeCode: doc.documentTypeCode as FiscalNotDeliveredEvidence['documentTypeCode'], fullNumber: doc.fullNumber,
    issuerRuc: ruc, snapshotSha256: fiscalSnapshotSha256(doc), evidenceId: uuid(800), assertedAt: '2026-10-03T16:00:00Z' };
}
function batchCommand(input: FiscalBatchInput, id = 900, sequence = 123, event = 1000): FiscalSupplementCommand {
  const batch = buildFiscalBatchSnapshot(clean(input), { documentId: uuid(id), identifier: `${input.kind}-20261003-${sequence}`, issueDate: '2026-10-03', referenceDate: '2026-10-02' }, asOf);
  return buildFiscalSupplementCommand({ kind: 'BATCH', batch, asOf }, { eventId: uuid(event), correlationId: uuid(2000), occurredAt: asOf });
}

type Row = Record<string, any>;
type Table = 'companies' | 'branches' | 'points' | 'counters' | 'documents' | 'summaries' | 'summaryItems' | 'outbox';
type Call = { table: Table | 'lock'; method: string; args: Row };
function documentRow(snapshot: FiscalDocumentSnapshot, sunatStatus = 'ACCEPTED'): Row {
  return { id: snapshot.documentId, companyId: snapshot.companyId, seriesCounterId: counterId(snapshot), emissionPointId: pointId,
    type: types[snapshot.documentTypeCode as keyof typeof types], status: 'ISSUED', sunatStatus,
    series: snapshot.series, number: BigInt(snapshot.number), fullNumber: snapshot.fullNumber, issueDate: new Date(snapshot.issueDate),
    currencyCode: snapshot.currencyCode, operationTypeCode: snapshot.operationTypeCode,
    customerIdentityType: snapshot.customer.identityType, customerIdentityNumber: snapshot.customer.identityNumber, customerLegalName: snapshot.customer.legalName,
    taxableAmount: snapshot.totals.taxableAmount, igvAmount: snapshot.totals.igvAmount, payableAmount: snapshot.totals.payableAmount,
    unaffectedAmount: 'unaffectedAmount' in snapshot.totals ? snapshot.totals.unaffectedAmount : '0.00', immutableSnapshot: clean(snapshot) };
}

/** Local Prisma port only: selects, JSON/reference predicates, unique aliases,
 * serial transaction queue and rollback (including post-write commit failures).
 * Advisory SQL is inspected, not executed. This does not prove PostgreSQL locking.
 * No PrismaService/client, bootstrap, socket, filesystem credentials or DB exists.
 */
function mockPrisma(doc = original(), sunatStatus = 'ACCEPTED') {
  const state: Record<Table, Row[]> = {
    companies: [{ id: 1, ruc, environment: 'BETA' }], branches: [{ id: branchId, companyId: 1, active: true }],
    points: [{ id: pointId, companyId: 1, branchId, code: '0000', active: true }],
    counters: [
      { id: uuid(10), documentType: 'INVOICE', series: 'F001' }, { id: uuid(11), documentType: 'SALES_RECEIPT', series: 'B001' },
      { id: uuid(20), documentType: 'CREDIT_NOTE', series: 'FN01' }, { id: uuid(21), documentType: 'DEBIT_NOTE', series: 'FN01' },
      { id: uuid(22), documentType: 'CREDIT_NOTE', series: 'BN01' }, { id: uuid(23), documentType: 'DEBIT_NOTE', series: 'BN01' },
    ].map(row => ({ ...row, companyId: 1, emissionPointId: pointId, active: true, nextNumber: 100n })),
    documents: [documentRow(doc, sunatStatus)], summaries: [], summaryItems: [], outbox: [],
  };
  const calls: Call[] = [], options: Row[] = [];
  let active = false, tail = Promise.resolve();
  const faults = { cas: false, document: false, outbox: false, commit: false, serializations: 0 };
  const forbidden = vi.fn(() => { throw new Error('READONLY_OR_UNSUPPORTED_WRITE'); });
  function view(table: Table, row: Row): Row {
    if (table === 'documents') return { ...row, referencesFrom: row.referencesFrom?.create ? [row.referencesFrom.create] : row.referencesFrom ?? [] };
    if (table === 'summaries') return { ...row, items: state.summaryItems.filter(item => item.dailySummaryId === row.id) };
    if (table === 'summaryItems') return { ...row, summary: state.summaries.find(summary => summary.id === row.dailySummaryId) };
    return row;
  }
  function eq(a: any, b: any): boolean { return a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b; }
  function matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, expected]) => {
      if (key === 'OR') return expected.some((part: Row) => matches(row, part));
      if (key === 'AND') return (Array.isArray(expected) ? expected : [expected]).every((part: Row) => matches(row, part));
      if (key === 'NOT') return !matches(row, expected);
      if (key.includes('_') && !(key in row)) return matches(row, expected);
      const actual = row[key];
      if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
        if ('path' in expected) return eq(expected.path.reduce((v: any, part: string) => v?.[part], actual), expected.equals);
        if ('in' in expected) return expected.in.some((v: any) => eq(actual, v));
        if ('not' in expected) return !eq(actual, expected.not);
        if ('some' in expected) return actual?.some((v: Row) => matches(v, expected.some)) ?? false;
        return !!actual && matches(actual, expected);
      }
      return eq(actual, expected);
    });
  }
  function select(row: Row, selection: Row): Row {
    return Object.fromEntries(Object.entries(selection).map(([key, enabled]) => [key, enabled === true ? row[key] :
      Array.isArray(row[key]) ? row[key].map((v: Row) => select(v, enabled.select)) : select(row[key], enabled.select)]));
  }
  function delegate(table: Table) {
    const read = async (method: string, args: Row) => {
      expect(active).toBe(true); expect(args.select).toBeDefined();
      calls.push({ table, method, args: structuredClone(args) });
      const found = state[table].map(row => view(table, row)).filter(row => matches(row, args.where));
      const rows = args.take ? found.slice(0, args.take) : found;
      return method === 'findMany' ? rows.map(row => structuredClone(select(row, args.select))) : rows[0] ? structuredClone(select(rows[0], args.select)) : null;
    };
    return { findUnique: vi.fn((args: Row) => read('findUnique', args)), findMany: vi.fn((args: Row) => read('findMany', args)),
      update: forbidden, delete: forbidden, deleteMany: forbidden, upsert: forbidden,
      updateMany: vi.fn(async (args: Row) => {
        expect(active).toBe(true); calls.push({ table, method: 'updateMany', args: structuredClone(args) });
        if (table !== 'counters') return forbidden();
        expect(args.data).toEqual({ nextNumber: { increment: 1n } }); expect(typeof args.where.nextNumber).toBe('bigint');
        if (faults.cas) return { count: 0 };
        const rows = state.counters.filter(row => matches(row, args.where)); rows.forEach(row => row.nextNumber += 1n); return { count: rows.length };
      }),
      create: vi.fn(async (args: Row) => {
        expect(active).toBe(true); calls.push({ table, method: 'create', args: structuredClone(args) });
        if (!['documents', 'summaries', 'outbox'].includes(table)) return forbidden();
        if (faults.document && table === 'documents' || faults.outbox && table === 'outbox') throw new Error(`${table} failed`);
        const data = structuredClone(args.data);
        if (state[table].some(row => row.id === data.id)) throw new Error('unique id');
        if (table === 'documents' && state.documents.some(row => row.companyId === data.companyId && row.type === data.type && row.series === data.series && row.number === data.number)) throw new Error('unique number');
        if (table === 'summaries') {
          if (state.summaries.some(row => row.companyId === data.companyId && (row.identifier === data.identifier || row.sequence === data.sequence && eq(row.referenceDate, data.referenceDate)))) throw new Error('unique summary');
          data.items.create.forEach((item: Row, index: number) => state.summaryItems.push({ ...item, id: uuid(5000 + state.summaryItems.length + index), dailySummaryId: data.id }));
          delete data.items;
        }
        state[table].push(data); return structuredClone(data);
      }),
    };
  }
  const tx = { companySettings: delegate('companies'), branch: delegate('branches'), emissionPoint: delegate('points'),
    seriesCounter: delegate('counters'), document: delegate('documents'), dailySummary: delegate('summaries'), dailySummaryItem: delegate('summaryItems'), outboxEvent: delegate('outbox'),
    $executeRaw: vi.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
      expect(active).toBe(true); expect(sql.join('?')).toBe('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))');
      expect(values).toHaveLength(1); calls.push({ table: 'lock', method: 'lock', args: { key: values[0] } }); return 1;
    }),
  };
  const prisma = { $transaction: vi.fn(async (run: (transaction: typeof tx) => Promise<unknown>, opts: Row) => {
    const previous = tail; let release!: () => void; tail = new Promise<void>(resolve => { release = resolve; }); await previous;
    const before = structuredClone(state); active = true; options.push(opts);
    try {
      const result = await run(tx);
      if (faults.serializations > 0) { faults.serializations--; throw Object.assign(new Error('simulated serialization'), { code: 'P2034' }); }
      if (faults.commit) throw new Error('commit failed');
      return result;
    } catch (error) { for (const table of Object.keys(state) as Table[]) state[table] = before[table]; throw error; }
    finally { active = false; release(); }
  }) };
  return { state, calls, tx, options, faults, forbidden, prisma, repo: new BetaSupplementCommandRepository(prisma as unknown as ConstructorParameters<typeof BetaSupplementCommandRepository>[0]) };
}
function writes(h: ReturnType<typeof mockPrisma>) { return h.calls.filter(call => ['create', 'updateMany'].includes(call.method)); }
function seedBase(h: ReturnType<typeof mockPrisma>, doc: FiscalDocumentSnapshot) {
  h.state.summaries.push({ id: uuid(700), companyId: 1, emissionPointId: pointId, identifier: 'RC-20261002-1', referenceDate: new Date('2026-10-02T00:00:00Z'), sequence: 1, status: 'ACCEPTED' });
  h.state.summaryItems.push({ id: uuid(701), dailySummaryId: uuid(700), documentId: doc.documentId, lineNumber: 1, conditionCode: '1' });
}
function sharedFixture(kind: 'NOTE' | 'RC' | 'RA') {
  const fixture = supplementCommandFixture(kind), h = mockPrisma(fixture.doc, kind === 'RC' ? 'QUEUED' : 'ACCEPTED');
  h.state.companies[0].id = fixture.doc.companyId;
  Object.assign(h.state.branches[0], { id: fixture.doc.branchId, companyId: fixture.doc.companyId });
  Object.assign(h.state.points[0], { branchId: fixture.doc.branchId, companyId: fixture.doc.companyId });
  h.state.counters.forEach(counter => { counter.companyId = fixture.doc.companyId; });
  h.state.counters.find(counter => counter.id === counterId(fixture.doc))!.series = fixture.doc.series;
  Object.assign(h.state.counters.find(counter => counter.id === counterId(fixture.note))!, { series: fixture.note.series, nextNumber: BigInt(fixture.note.number) });
  const fixtureActor: BetaSupplementActor = { userId: supplementUuid(9), scope: { kind: 'ASSIGNED',
    branchIds: [fixture.doc.branchId!], emissionPointIds: [pointId], series: h.state.counters.map(counter => counter.id) } };
  return { h, fixture, fixtureActor };
}
beforeEach(() => {
  vi.spyOn(Socket.prototype, 'connect').mockImplementation(() => { throw new Error('NETWORK_FORBIDDEN'); });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('NETWORK_FORBIDDEN'); });
});
afterEach(() => vi.restoreAllMocks());

describe('BetaSupplementCommandRepository: own Billing reservation, offline only', () => {
  it.each(['NOTE', 'RC', 'RA'] as const)('reserves shared supplementCommandFixture(%s) unchanged', async kind => {
    const { h, fixture, fixtureActor } = sharedFixture(kind), before = structuredClone(fixture);
    await expect(h.repo.reserve(fixture.command, fixtureActor)).resolves.toMatchObject({ operationId: fixture.command.payload.operationId, operationKind: kind });
    expect(h.state.outbox[0].payload).toEqual(fixture.command); expect(fixture).toEqual(before);
    if (kind === 'NOTE') expect(h.state.documents[1].items.create[0].internalCode).toBe('QA');
    else expect(h.tx.seriesCounter.updateMany).not.toHaveBeenCalled();
  });
  it('NOTE reserves exact snapshot/items/taxes/reference + unchanged command atomically, keeps original readonly', async () => {
    const h = mockPrisma(), cmd = noteCommand(), before = structuredClone(h.state.documents[0]), input = structuredClone(cmd);
    const result = await h.repo.reserve(cmd, actor);
    expect(result).toEqual({ operationId: uuid(100), eventId: uuid(1000), operationKind: 'NOTE', deduplicated: false });
    expect(h.options).toEqual([{ isolationLevel: 'Serializable' }]); expect(h.forbidden).not.toHaveBeenCalled();
    expect(h.state.documents[0]).toEqual(before); expect(cmd).toEqual(input);
    const saved = h.state.documents[1], envelope = cmd.payload.envelope;
    if (envelope.kind !== 'NOTE') throw new Error('fixture');
    expect(saved).toMatchObject({ type: 'CREDIT_NOTE', sunatStatus: 'QUEUED', number: 100n,
      taxableAmount: '100.00', unaffectedAmount: '0.00', igvAmount: '18.00', payableAmount: '118.00', immutableSnapshot: envelope.note });
    const { originalLineNumber, ...persistedLine } = envelope.note.lines[0];
    expect(saved.items.create[0]).toMatchObject(persistedLine);
    expect(saved.immutableSnapshot.lines[0].originalLineNumber).toBe(originalLineNumber);
    expect(saved.referencesFrom.create).toMatchObject({ targetDocumentId: uuid(1), targetTypeCode: '01', targetSeries: 'F001', targetNumber: 1n });
    expect(saved.taxes.create).toEqual([{ taxSchemeId: '1000', taxName: 'IGV', taxableAmount: '100.00', taxAmount: '18.00' }]);
    expect(h.state.counters.find(row => row.id === uuid(20))!.nextNumber).toBe(101n);
    expect(h.state.outbox).toHaveLength(1); expect(h.state.outbox[0].payload).toEqual(cmd);
    expect(writes(h).map(call => [call.table, call.method])).toEqual([['counters', 'updateMany'], ['documents', 'create'], ['outbox', 'create']]);
    expect(h.calls.slice(0, 2).map(call => call.args.key)).toEqual([`factuez:beta-supplement:company:1:ruc:${ruc}`, `factuez:beta-supplement:operation:${uuid(100)}`]);
  });
  it.each([increase, interest])('DEBIT_NOTE keeps exact tax/payable values, including explicit mora', async input => {
    const h = mockPrisma(), cmd = noteCommand(context(), 100, 100, input);
    await h.repo.reserve(cmd, actor); const saved = h.state.documents[1];
    expect(saved.type).toBe('DEBIT_NOTE'); expect(h.state.counters.find(row => row.id === uuid(21))!.nextNumber).toBe(101n);
    if (cmd.payload.envelope.kind !== 'NOTE') throw new Error('fixture');
    expect(saved.payableAmount).toBe(cmd.payload.envelope.note.totals.payableAmount);
    if (input.reasonCode === '01') expect(saved.taxes.create).toEqual([{ taxSchemeId: '9998', taxName: 'INA', taxableAmount: '12.34', taxAmount: '0.00' }]);
  });
  it.each(['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS'])('requires own original %s without asserting PKI', async status => {
    const ctx = context(); ctx.acceptance.status = status as FiscalAcceptanceEvidence['status'];
    const h = mockPrisma(ctx.original, status); await expect(h.repo.reserve(noteCommand(ctx), actor)).resolves.toMatchObject({ deduplicated: false });
  });
  it.each(['PENDING', 'REJECTED', 'PERMANENT_ERROR', 'VOIDED', 'UNKNOWN'])('claimed acceptance cannot replace own Billing state %s', async status => {
    const h = mockPrisma(original(), status); await expect(h.repo.reserve(noteCommand(), actor)).rejects.toThrow('aceptación previa propia'); expect(writes(h)).toEqual([]);
  });
  it.each(['issuer', 'issuer-inactive', 'production', 'branch', 'point', 'establishment', 'original-counter', 'note-counter', 'snapshot', 'number'])('rejects own %s mismatch before numeric writes', async scenario => {
    const h = mockPrisma();
    if (scenario === 'issuer') h.state.companies[0].ruc = '20131312955';
    if (scenario === 'issuer-inactive') (h.state.companies[0] as any).active = false;
    if (scenario === 'production') h.state.companies[0].environment = 'PRODUCTION';
    if (scenario === 'branch') h.state.branches[0].companyId = 2;
    if (scenario === 'point') h.state.points[0].active = false;
    if (scenario === 'establishment') h.state.points[0].code = '0001';
    if (scenario === 'original-counter') h.state.counters[0].companyId = 2;
    if (scenario === 'note-counter') h.state.counters[2].emissionPointId = uuid(99);
    if (scenario === 'snapshot') h.state.documents[0].immutableSnapshot.customer.legalName = 'Alterado';
    if (scenario === 'number') h.state.counters[2].nextNumber = 101n;
    await expect(h.repo.reserve(noteCommand(), actor)).rejects.toThrow(); expect(writes(h)).toEqual([]);
  });
  it.each(['branchIds', 'emissionPointIds', 'original-series', 'note-series'])('checks %s scope including original and both counters', async dimension => {
    const h = mockPrisma(), restricted = structuredClone(actor);
    if (restricted.scope.kind !== 'ASSIGNED') throw new Error('fixture');
    if (dimension === 'branchIds' || dimension === 'emissionPointIds') restricted.scope[dimension] = [];
    else restricted.scope.series = restricted.scope.series.filter(id => id !== uuid(dimension === 'original-series' ? 10 : 20));
    await expect(h.repo.reserve(noteCommand(), restricted)).rejects.toThrow(); expect(writes(h)).toEqual([]);
  });
  it('rejects malformed/unbounded command and actor without a transaction', async () => {
    const h = mockPrisma(), cmd: any = noteCommand(); cmd.payload.envelopeSha256 = 'b'.repeat(64);
    await expect(h.repo.reserve(cmd, actor)).rejects.toThrow();
    await expect(h.repo.reserve(noteCommand(), { ...actor, scope: { kind: 'ASSIGNED' } } as any)).rejects.toThrow();
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
  it.each(['QUEUED', 'UNKNOWN', 'PERMANENT_ERROR', 'VOIDED', 'ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS'])('complete own credit history includes %s; UNKNOWN remains reserved', async status => {
    const ctx = context(), prior = note(ctx, 99, 99, { ...partial, lines: [{ originalLineNumber: 1, quantity: '0.5' }] } as FiscalNoteInput);
    const h = mockPrisma(); h.state.documents.push(documentRow(prior, status));
    ctx.creditHistory.entries.push({ state: status.startsWith('ACCEPTED') ? 'ACCEPTED' : 'RESERVED', note: prior });
    await h.repo.reserve(noteCommand(ctx), actor);
    expect(h.state.documents[2].immutableSnapshot.creditHistoryIds).toEqual([uuid(99)]);
    const query = h.calls.find(call => call.table === 'documents' && call.method === 'findMany' && call.args.where.type === 'CREDIT_NOTE')!;
    expect(query.args.take).toBe(101); expect(query.args.where).toMatchObject({ companyId: 1, type: 'CREDIT_NOTE', sunatStatus: { not: 'REJECTED' } });
  });
  it('excludes only explicitly REJECTED notes, including relation-only credits in completeness check', async () => {
    const h = mockPrisma(); h.state.documents.push(documentRow(note(context(), 99, 99), 'REJECTED'));
    await expect(h.repo.reserve(noteCommand(), actor)).resolves.toMatchObject({ deduplicated: false });
    const other = mockPrisma(), row = documentRow(note(context(), 99, 99), 'UNKNOWN');
    delete row.immutableSnapshot.reference; row.referencesFrom = [{ targetDocumentId: uuid(1) }]; other.state.documents.push(row);
    await expect(other.repo.reserve(noteCommand(), actor)).rejects.toThrow('historial propio incompleto'); expect(writes(other)).toEqual([]);
  });
  it.each(['omitted', 'invented', 'state', 'own-hash', 'scope'])('rejects %s credit history even with input complete:true', async scenario => {
    const ctx = context(), prior = note(ctx, 99, 99, { ...partial, lines: [{ originalLineNumber: 1, quantity: '0.5' }] } as FiscalNoteInput);
    const h = mockPrisma();
    if (scenario !== 'invented') h.state.documents.push(documentRow(prior, 'QUEUED'));
    if (scenario !== 'omitted') ctx.creditHistory.entries.push({ state: scenario === 'state' ? 'ACCEPTED' : 'RESERVED', note: prior });
    if (scenario === 'own-hash') h.state.documents[1].immutableSnapshot.reasonDescription = 'Alterado';
    const restricted = structuredClone(actor);
    if (scenario === 'scope') { h.state.documents[1].seriesCounterId = uuid(30); h.state.counters.push({ ...h.state.counters[2], id: uuid(30) }); }
    await expect(h.repo.reserve(noteCommand(ctx), restricted)).rejects.toThrow(); expect(writes(h)).toEqual([]);
  });
  it('bounds own credit history to 100 with a 101-row sentinel', async () => {
    const h = mockPrisma();
    for (let i = 0; i < 101; i++) { const row = documentRow(note(context(), 99, 99), 'QUEUED'); row.id = uuid(300 + i); h.state.documents.push(row); }
    await expect(h.repo.reserve(noteCommand(), actor)).rejects.toThrow('mayor a 100'); expect(writes(h)).toEqual([]);
  });
  it('accepts exactly 100 complete own credits without dropping UNKNOWN or accepted capacity', async () => {
    const ctx = context(), h = mockPrisma(), small: FiscalNoteInput = { ...partial, lines: [{ originalLineNumber: 1, quantity: '0.001' }] };
    for (let i = 0; i < 100; i++) {
      const prior = note(context(), 300 + i, i + 1, small);
      prior.creditHistoryIds = ctx.creditHistory.entries.map(entry => entry.note.documentId);
      ctx.creditHistory.entries.push({ state: 'RESERVED', note: prior }); h.state.documents.push(documentRow(prior, 'UNKNOWN'));
    }
    h.state.counters[2].nextNumber = 101n;
    await expect(h.repo.reserve(noteCommand(ctx, 200, 101), actor)).resolves.toMatchObject({ deduplicated: false });
    expect(h.state.counters[2].nextNumber).toBe(102n); expect(h.state.documents.at(-1)!.immutableSnapshot.creditHistoryIds).toHaveLength(100);
  });
  it('retains already reserved credit capacity so a full credit cannot follow a partial credit', async () => {
    const ctx = context(), prior = note(ctx, 99, 99); ctx.creditHistory.entries.push({ state: 'RESERVED', note: prior });
    const h = mockPrisma(); h.state.documents.push(documentRow(prior, 'UNKNOWN'));
    await expect(async () => h.repo.reserve(noteCommand(ctx, 100, 100,
      { documentTypeCode: '07', reasonCode: '01', reasonDescription: 'Anulación completa' }), actor)).rejects.toThrow('Sobreacreditación');
    expect(writes(h)).toEqual([]);
  });
  it('never drops or truncates productCode that exceeds the existing DocumentItem limit', async () => {
    const ctx = context(); ctx.original.lines[0].productCode = 'P'.repeat(41); ctx.acceptance = acceptance(ctx.original);
    const h = mockPrisma(ctx.original); await expect(h.repo.reserve(noteCommand(ctx), actor)).rejects.toThrow('internalCode'); expect(writes(h)).toEqual([]);
  });
  it('deduplicates exact own Outbox forever, reauthorizes scope, and never changes event or counter', async () => {
    const h = mockPrisma(), cmd = noteCommand(); await h.repo.reserve(cmd, actor);
    const before = structuredClone(h.state), count = writes(h).length;
    await expect(h.repo.reserve(cmd, actor)).resolves.toMatchObject({ deduplicated: true });
    expect(h.state).toEqual(before); expect(writes(h)).toHaveLength(count);
    const restricted = structuredClone(actor); if (restricted.scope.kind === 'ASSIGNED') restricted.scope.series = [uuid(20)];
    await expect(h.repo.reserve(cmd, restricted)).rejects.toThrow(); expect(h.state).toEqual(before);
  });
  it.each(['eventId', 'correlationId'])('same operation with a changed %s conflicts without rewriting its event', async field => {
    const h = mockPrisma(), cmd = noteCommand(); await h.repo.reserve(cmd, actor); const before = structuredClone(h.state);
    const different = structuredClone(cmd); different[field as 'eventId' | 'correlationId'] = uuid(9000);
    await expect(h.repo.reserve(different, actor)).rejects.toThrow('otro comando'); expect(h.state).toEqual(before);
  });
  it('published Outbox metadata and unrelated events do not rewrite or break exact-command dedupe', async () => {
    const h = mockPrisma(), cmd = noteCommand(); await h.repo.reserve(cmd, actor);
    Object.assign(h.state.outbox[0], { publishedAt: new Date(asOf), attempts: 8 });
    h.state.outbox.push({ id: uuid(7000), eventType: 'unrelated.metadata.v1', aggregateId: cmd.payload.operationId, payload: {} });
    const before = structuredClone(h.state); await expect(h.repo.reserve(cmd, actor)).resolves.toMatchObject({ deduplicated: true }); expect(h.state).toEqual(before);
  });
  it('a UUID case alias uses the same stable operation lock and cannot replace the original event', async () => {
    const { h, fixture, fixtureActor } = sharedFixture('NOTE'); await h.repo.reserve(fixture.command, fixtureActor);
    const envelope = structuredClone(fixture.envelope); if (envelope.kind !== 'NOTE') throw new Error('fixture');
    envelope.note.documentId = envelope.note.documentId.toUpperCase();
    const alias = buildFiscalSupplementCommand(envelope, { eventId: fixture.command.eventId, correlationId: fixture.command.correlationId, occurredAt: fixture.command.occurredAt });
    const before = structuredClone(h.state); await expect(h.repo.reserve(alias, fixtureActor)).rejects.toThrow('otro comando'); expect(h.state).toEqual(before);
    expect(h.calls.filter(call => call.table === 'lock' && String(call.args.key).includes(':operation:')).map(call => call.args.key))
      .toEqual(Array(2).fill(`factuez:beta-supplement:operation:${fixture.command.payload.operationId.toLowerCase()}`));
  });
  it.each(['document-id', 'summary-id', 'natural-number', 'event-id', 'reserved-copy'])('enforces unique %s aliases and own copies', async scenario => {
    const h = mockPrisma(), cmd = noteCommand();
    if (scenario === 'document-id') h.state.documents.push({ ...documentRow(note()), companyId: 2 });
    if (scenario === 'natural-number') h.state.documents.push({ ...documentRow(note()), id: uuid(300) });
    if (scenario === 'summary-id') h.state.summaries.push({ id: uuid(100), items: [] });
    if (scenario === 'event-id') h.state.outbox.push({ id: uuid(1000), aggregateId: uuid(888), eventType: 'other', payload: {} });
    if (scenario === 'reserved-copy') { await h.repo.reserve(cmd, actor); h.state.documents[1].immutableSnapshot.reasonDescription = 'Alterado'; }
    const before = structuredClone(h.state), count = writes(h).length;
    await expect(h.repo.reserve(cmd, actor)).rejects.toThrow(); expect(h.state).toEqual(before); expect(writes(h)).toHaveLength(count);
  });
  it.each(['cas', 'document', 'outbox', 'commit'] as const)('rolls back %s failure including increment and all copies', async fault => {
    const h = mockPrisma(), before = structuredClone(h.state); h.faults[fault] = true;
    await expect(h.repo.reserve(noteCommand(), actor)).rejects.toThrow(); expect(h.state).toEqual(before);
    expect(h.forbidden).not.toHaveBeenCalled();
  });
  it('retries only serialization conflicts with the exact command; caps attempts at 3', async () => {
    const h = mockPrisma(); h.faults.serializations = 1; const cmd = noteCommand(); await h.repo.reserve(cmd, actor);
    expect(h.options).toHaveLength(2); expect(h.state.outbox[0].payload).toEqual(cmd); expect(h.state.counters[2].nextNumber).toBe(101n);
    const exhausted = mockPrisma(), before = structuredClone(exhausted.state); exhausted.faults.serializations = 3;
    await expect(exhausted.repo.reserve(cmd, actor)).rejects.toMatchObject({ code: 'P2034' }); expect(exhausted.options).toHaveLength(3); expect(exhausted.state).toEqual(before);
  });
  it('simulates concurrent identical operation locks: one reservation and one exact dedupe', async () => {
    const h = mockPrisma(), cmd = noteCommand();
    const results = await Promise.all([h.repo.reserve(cmd, actor), h.repo.reserve(cmd, actor)]);
    expect(results.map(result => result.deduplicated)).toEqual([false, true]); expect(h.state.outbox).toHaveLength(1);
    expect(h.calls.filter(call => call.table === 'lock').map(call => call.args.key)).toEqual([
      `factuez:beta-supplement:company:1:ruc:${ruc}`, `factuez:beta-supplement:operation:${uuid(100)}`,
      `factuez:beta-supplement:company:1:ruc:${ruc}`, `factuez:beta-supplement:operation:${uuid(100)}`,
    ]);
  });
  it('simulates concurrent credits: second caller sees complete own history and fails closed', async () => {
    const h = mockPrisma();
    const results = await Promise.allSettled([h.repo.reserve(noteCommand(), actor), h.repo.reserve(noteCommand(context(), 101, 101, partial, 1001), actor)]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']); expect(h.state.outbox).toHaveLength(1); expect(h.state.counters[2].nextNumber).toBe(101n);
  });
  it('dedupe revalidates persisted numeric identity without allocating a replacement number', async () => {
    const h = mockPrisma(), cmd = noteCommand(); await h.repo.reserve(cmd, actor); h.state.documents[1].number = 999n;
    const before = structuredClone(h.state), count = writes(h).length;
    await expect(h.repo.reserve(cmd, actor)).rejects.toThrow('documento propio'); expect(h.state).toEqual(before); expect(writes(h)).toHaveLength(count);
  });
  it.each(['series', 'counter', 'SHA'])('dedupe rejects a changed persisted NOTE %s without touching its event', async field => {
    const h = mockPrisma(), cmd = noteCommand(); await h.repo.reserve(cmd, actor);
    if (field === 'series') h.state.documents[1].series = 'FN02';
    if (field === 'counter') h.state.documents[1].seriesCounterId = uuid(10);
    if (field === 'SHA') h.state.documents[1].immutableSnapshot.reasonDescription = 'Copia distinta';
    const before = structuredClone(h.state), count = writes(h).length;
    await expect(h.repo.reserve(cmd, actor)).rejects.toThrow(); expect(h.state).toEqual(before); expect(writes(h)).toHaveLength(count);
  });
  it('dedupe keeps the original NOTE number when its active counter has subsequently advanced', async () => {
    const h = mockPrisma(), cmd = noteCommand(); await h.repo.reserve(cmd, actor); h.state.counters[2].nextNumber = 900n;
    const before = structuredClone(h.state); await expect(h.repo.reserve(cmd, actor)).resolves.toMatchObject({ deduplicated: true });
    expect(h.state).toEqual(before); expect(h.state.documents[1].number).toBe(100n);
  });

  it('RC alta projects generic DailySummary/items and exact snapshot only in Outbox, no fiscal increment or original update', async () => {
    const doc = original('03'), h = mockPrisma(doc, 'QUEUED'), before = structuredClone(h.state.documents), counters = structuredClone(h.state.counters);
    const cmd = batchCommand({ kind: 'RC', entries: [{ conditionCode: '1', document: { snapshot: doc } }] }); await h.repo.reserve(cmd, actor);
    expect(h.state.documents).toEqual(before); expect(h.state.counters).toEqual(counters); expect(h.state.outbox[0].payload).toEqual(cmd);
    expect(h.state.summaries[0]).toMatchObject({ id: uuid(900), identifier: 'RC-20261003-123', sequence: 123, status: 'QUEUED' });
    expect(h.state.summaryItems[0]).toMatchObject({ documentId: doc.documentId, lineNumber: 1, conditionCode: '1' });
    expect(writes(h).map(call => call.table)).toEqual(['summaries', 'outbox']);
    h.state.documents[0].sunatStatus = 'ACCEPTED'; const saved = structuredClone(h.state);
    await expect(h.repo.reserve(cmd, actor)).resolves.toMatchObject({ deduplicated: true }); expect(h.state).toEqual(saved);
  });
  it('RC member note requires own original/history/series and an already materialized unchanged note', async () => {
    const doc = original('03'), ctx = context(doc), n = note(ctx), h = mockPrisma(doc), before = structuredClone(h.state.documents[0]);
    h.state.documents.push(documentRow(n, 'QUEUED'));
    const cmd = batchCommand({ kind: 'RC', entries: [{ conditionCode: '1', document: { snapshot: n, noteContext: ctx } }] });
    await h.repo.reserve(cmd, actor); expect(h.state.documents[0]).toEqual(before); expect(h.state.documents).toHaveLength(2);
    const missing = mockPrisma(doc); await expect(missing.repo.reserve(cmd, actor)).rejects.toThrow('documento propio'); expect(writes(missing)).toEqual([]);
  });
  it('RC2 explicitly remains blocked even when a pure independent ledger supplies valid versions', async () => {
    const doc = original('03'), modified = structuredClone(doc);
    Object.assign(modified, calculateDocumentTotals([{ description: 'Corregido', unitCode: 'NIU', quantity: '2', unitPriceWithTax: '59', taxAffectationCode: '10', igvRate: '18' }]));
    const cmd = batchCommand({ kind: 'RC', entries: [{ conditionCode: '2', document: { snapshot: modified }, previous: { document: { snapshot: doc }, acceptance: acceptance(doc) } }] });
    const h = mockPrisma(doc), before = structuredClone(h.state);
    await expect(h.repo.reserve(cmd, actor)).rejects.toThrow('RC2 bloqueado hasta persistencia materializada'); expect(h.state).toEqual(before); expect(writes(h)).toEqual([]);
  });
  it('RC3 requires exact own accepted baseline and explicitly linked notDelivered; only that RC baseline is exempt from overlap', async () => {
    const doc = original('03'), h = mockPrisma(doc); seedBase(h, doc); const before = structuredClone(h.state.documents);
    const cmd = batchCommand({ kind: 'RC', entries: [{ conditionCode: '3', document: { snapshot: doc }, previous: { document: { snapshot: doc }, acceptance: acceptance(doc) }, notDelivered: notDelivered(doc) }] });
    await h.repo.reserve(cmd, actor); expect(h.state.documents).toEqual(before); expect(h.state.summaryItems[1].conditionCode).toBe('3');
    const again = batchCommand({ kind: 'RC', entries: [{ conditionCode: '3', document: { snapshot: doc }, previous: { document: { snapshot: doc }, acceptance: acceptance(doc) }, notDelivered: notDelivered(doc) }] }, 901, 124, 1001);
    await expect(h.repo.reserve(again, actor)).rejects.toThrow('batch pendiente/aceptado');
    const missing = mockPrisma(doc); await expect(missing.repo.reserve(cmd, actor)).rejects.toThrow('pertenencia previa propia'); expect(writes(missing)).toEqual([]);
  });
  it('RA uses generic RA label and condition 3 for exact accepted own documents, leaving all amounts and counters intact', async () => {
    const doc = original(), h = mockPrisma(doc), before = structuredClone(h.state.documents), counters = structuredClone(h.state.counters);
    const cmd = batchCommand({ kind: 'RA', entries: [{ document: { snapshot: doc }, acceptance: acceptance(doc), notDelivered: notDelivered(doc), reasonDescription: 'No entregado' }] });
    await h.repo.reserve(cmd, actor); expect(h.state.summaries[0].identifier).toBe('RA-20261003-123'); expect(h.state.summaryItems[0].conditionCode).toBe('3');
    expect(h.state.documents).toEqual(before); expect(h.state.counters).toEqual(counters); expect(h.state.outbox[0].payload).toEqual(cmd);
  });
  it('RA includes an already materialized debit note and its own accepted original without updating either', async () => {
    const ctx = context(), n = note(ctx, 100, 100, interest), h = mockPrisma(); h.state.documents.push(documentRow(n));
    const proof = acceptance(n); proof.acceptedAt = '2026-10-02T17:10:00Z';
    const before = structuredClone(h.state.documents), cmd = batchCommand({ kind: 'RA', entries: [{ document: { snapshot: n, noteContext: ctx },
      acceptance: proof, notDelivered: notDelivered(n), reasonDescription: 'No entregado' }] });
    await h.repo.reserve(cmd, actor); expect(h.state.documents).toEqual(before); expect(h.tx.seriesCounter.updateMany).not.toHaveBeenCalled();
  });
  it('batch members cannot cross points even if corrupt fixture metadata reused an establishment code', async () => {
    const first = original('03'), second = original('03', 2), h = mockPrisma(first, 'QUEUED');
    h.state.documents.push({ ...documentRow(second, 'QUEUED'), emissionPointId: uuid(50), seriesCounterId: uuid(51) });
    h.state.points.push({ ...h.state.points[0], id: uuid(50) }); h.state.counters.push({ ...h.state.counters[1], id: uuid(51), emissionPointId: uuid(50) });
    const wider = structuredClone(actor); if (wider.scope.kind === 'ASSIGNED') { wider.scope.emissionPointIds.push(uuid(50)); wider.scope.series.push(uuid(51)); }
    await expect(h.repo.reserve(batchCommand({ kind: 'RC', entries: [first, second].map(snapshot => ({ conditionCode: '1', document: { snapshot } })) }), wider)).rejects.toThrow('mismo punto');
    expect(writes(h)).toEqual([]);
  });
  it.each(['not-delivered-missing', 'not-delivered-hash', 'delivered', 'own-rejected', 'own-hash'])('RA rejects %s without writes or a server-evidence authenticity claim', async scenario => {
    const doc = original(), h = mockPrisma(doc), cmd: any = batchCommand({ kind: 'RA', entries: [{ document: { snapshot: doc }, acceptance: acceptance(doc), notDelivered: notDelivered(doc), reasonDescription: 'No entregado' }] });
    const entry = cmd.payload.envelope.batch.input.entries[0];
    if (scenario === 'not-delivered-missing') delete entry.notDelivered;
    if (scenario === 'not-delivered-hash') entry.notDelivered.snapshotSha256 = 'b'.repeat(64);
    if (scenario === 'delivered') entry.notDelivered.status = 'DELIVERED';
    if (scenario === 'own-rejected') h.state.documents[0].sunatStatus = 'REJECTED';
    if (scenario === 'own-hash') h.state.documents[0].immutableSnapshot.customer.legalName = 'Alterado';
    await expect(h.repo.reserve(cmd, actor)).rejects.toThrow(); expect(writes(h)).toEqual([]);
  });
  it.each(['QUEUED', 'PROCESSING', 'ACCEPTED', 'RETRYABLE_ERROR', 'DRAFT'])('conservatively rejects overlap with %s batches (including other company corruption)', async status => {
    const doc = original('03'), h = mockPrisma(doc, 'QUEUED'); seedBase(h, doc); h.state.summaries[0].status = status;
    const cmd = batchCommand({ kind: 'RC', entries: [{ conditionCode: '1', document: { snapshot: doc } }] });
    await expect(h.repo.reserve(cmd, actor)).rejects.toThrow('batch pendiente/aceptado'); expect(writes(h)).toEqual([]);
    expect(h.calls.find(call => call.table === 'summaryItems' && call.method === 'findMany')!.args.take).toBe(201);
  });
  it('bounds overlap to 200 with 201 sentinel; explicit rejected batch is not pending/accepted', async () => {
    const doc = original('03'), h = mockPrisma(doc, 'QUEUED'); seedBase(h, doc); h.state.summaries[0].status = 'REJECTED';
    await expect(h.repo.reserve(batchCommand({ kind: 'RC', entries: [{ conditionCode: '1', document: { snapshot: doc } }] }), actor)).resolves.toMatchObject({ deduplicated: false });
    const full = mockPrisma(doc, 'QUEUED'); seedBase(full, doc);
    for (let i = 0; i < 200; i++) full.state.summaryItems.push({ ...full.state.summaryItems[0], id: uuid(10000 + i) });
    await expect(full.repo.reserve(batchCommand({ kind: 'RC', entries: [{ conditionCode: '1', document: { snapshot: doc } }] }), actor)).rejects.toThrow('batch pendiente/aceptado'); expect(writes(full)).toEqual([]);
  });
  it.each(['company', 'point', 'series-scope', 'member-hash', 'identifier', 'shared-sequence'])('batch revalidates own %s without numeric writes', async scenario => {
    const doc = original('03'), h = mockPrisma(doc, 'QUEUED'), cmd = batchCommand({ kind: 'RC', entries: [{ conditionCode: '1', document: { snapshot: doc } }] });
    const restricted = structuredClone(actor);
    if (scenario === 'company') h.state.documents[0].companyId = 2;
    if (scenario === 'point') h.state.points[0].branchId = uuid(77);
    if (scenario === 'series-scope' && restricted.scope.kind === 'ASSIGNED') restricted.scope.series = [];
    if (scenario === 'member-hash') h.state.documents[0].immutableSnapshot.customer.legalName = 'Alterado';
    if (scenario === 'identifier' || scenario === 'shared-sequence') h.state.summaries.push({ id: uuid(800), companyId: 1, emissionPointId: pointId,
      identifier: scenario === 'identifier' ? 'RC-20261003-123' : 'RA-20261003-123', sequence: 123, referenceDate: new Date('2026-10-02T00:00:00Z'), status: 'REJECTED' });
    await expect(h.repo.reserve(cmd, restricted)).rejects.toThrow(); expect(writes(h)).toEqual([]);
  });
  it('batch Outbox failure rolls back summary and every copied member', async () => {
    const doc = original('03'), h = mockPrisma(doc, 'QUEUED'), before = structuredClone(h.state); h.faults.outbox = true;
    await expect(h.repo.reserve(batchCommand({ kind: 'RC', entries: [{ conditionCode: '1', document: { snapshot: doc } }] }), actor)).rejects.toThrow('outbox failed');
    expect(h.state).toEqual(before);
  });
});
