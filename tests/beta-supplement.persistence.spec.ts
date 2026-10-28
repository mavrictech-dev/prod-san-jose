import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FiscalDocumentSnapshot } from '../packages/contracts/src/events';
import { calculateDocumentTotals } from '../packages/sunat-core/src/tax';
import { buildFiscalNoteSnapshot, fiscalSnapshotSha256, type FiscalAcceptanceEvidence, type FiscalNoteContext } from '../packages/sunat-core/src/fiscal-note';
import { buildFiscalBatchSnapshot, type FiscalBatchSnapshot, type FiscalRcEntry } from '../packages/sunat-core/src/fiscal-batch';
import { BetaSupplementRepository, type BetaSupplementManifest, type BetaSupplementRow } from '../services/sunat-service/src/application/beta-supplement.repository';
import { BetaDispatchPipeline, type BetaDispatchPorts, type BetaPhase } from '../services/sunat-service/src/application/beta-dispatch-pipeline';
import type { BetaFiscalEnvelope } from '../services/sunat-service/src/infrastructure/crypto/beta-fiscal-package-pipeline';
import type { BetaSummaryAcceptanceMetadata } from '../services/sunat-service/src/application/beta-summary-acceptance';

vi.mock('../services/sunat-service/src/infrastructure/prisma.service', () => ({ PrismaService: class {} }));
vi.mock('../services/sunat-service/src/infrastructure/sunat/bounded-soap.adapter', () => ({ SoapSubmissionError: class extends Error {} }));

const ruc = '20100070970', otherRuc = '20131312955';
const now = new Date('2026-10-03T18:00:00.000Z'), asOf = now.toISOString();
const acceptedAt = '2026-10-02T16:10:00.000Z';
const uuid = (n: number) => `abcdefab-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type Row = Record<string, unknown>;
type Table = 'documents' | 'batches' | 'submissions' | 'documentArtifacts' | 'batchArtifacts' | 'credentials' | 'outbox';
type Args = { where?: Row; data?: Row; create?: Row; update?: Row; select?: Row; orderBy?: Row | Row[]; take?: number };

/** Transaction model with real predicate evaluation, unique constraints, serialized
 * transactions and rollback of ALL writes. This is not a PostgreSQL/Prisma or
 * cryptographic integration test. Unknown predicates fail instead of matching. */
function memory() {
  let state: Record<Table, Row[]> = { documents: [], batches: [], submissions: [], documentArtifacts: [], batchArtifacts: [], credentials: [], outbox: [] };
  let tail = Promise.resolve(), inTransaction = false, sequence = 5000;
  const operations: { table: Table; operation: string; args: Args; inTransaction: boolean }[] = [];
  function scalar(actual: unknown, expected: unknown): boolean {
    if (actual instanceof Date || expected instanceof Date) return actual instanceof Date && expected instanceof Date && actual.getTime() === expected.getTime();
    if (typeof actual === 'string' && typeof expected === 'string' && /^[a-f\d]{8}-/i.test(actual) && /^[a-f\d]{8}-/i.test(expected)) return actual.toLowerCase() === expected.toLowerCase();
    return actual === expected;
  }
  function match(row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([key, value]) => {
      if (key === 'OR') return (value as Row[]).some(w => match(row, w));
      if (key === 'AND') return (Array.isArray(value) ? value : [value]).every(w => match(row, w as Row));
      if (key === 'document' || key === 'batch') {
        const related = state[key === 'document' ? 'documents' : 'batches'].find(r => scalar(r[key === 'document' ? 'documentId' : 'id'], row[key === 'document' ? 'documentId' : 'batchId']));
        return Boolean(related && match(related, (value as { is: Row }).is));
      }
      if (key.includes('_') && !(key in row)) return match(row, value as Row);
      const actual = row[key];
      if (value === null || typeof value !== 'object' || value instanceof Date) return scalar(actual, value);
      const filter = value as Row;
      let compared = actual;
      if ('path' in filter) for (const part of filter.path as string[]) compared = (compared as Row | undefined)?.[part];
      return Object.entries(filter).every(([operator, expected]) => {
        if (operator === 'path' || operator === 'mode') return true;
        const text = (v: unknown) => filter.mode === 'insensitive' ? String(v).toLowerCase() : String(v);
        if (operator === 'equals') return filter.mode ? text(compared) === text(expected) : scalar(compared, expected);
        if (operator === 'not') return !scalar(compared, expected);
        if (operator === 'in') return (expected as unknown[]).some(v => scalar(compared, v));
        if (operator === 'startsWith') return typeof compared === 'string' && text(compared).startsWith(text(expected));
        if (['lt', 'lte', 'gt', 'gte'].includes(operator)) {
          if (compared == null) return false;
          const left = compared instanceof Date ? compared.getTime() : Number(compared), right = expected instanceof Date ? expected.getTime() : Number(expected);
          return operator === 'lt' ? left < right : operator === 'lte' ? left <= right : operator === 'gt' ? left > right : left >= right;
        }
        throw new Error(`Unsupported memory predicate ${key}.${operator}`);
      });
    });
  }
  function change(row: Row, data: Row) {
    for (const [key, value] of Object.entries(data)) row[key] = value && typeof value === 'object' && 'increment' in value
      ? Number(row[key]) + Number((value as Row).increment) : structuredClone(value);
  }
  function delegate(table: Table) {
    const record = (operation: string, args: Args) => operations.push({ table, operation, args: structuredClone(args), inTransaction });
    const find = (args: Args) => {
      let rows = state[table].filter(r => match(r, args.where));
      if (args.orderBy) rows = [...rows].sort((a, b) => {
        for (const order of Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy!]) for (const [key, direction] of Object.entries(order)) {
          const av = a[key] instanceof Date ? (a[key] as Date).getTime() : a[key], bv = b[key] instanceof Date ? (b[key] as Date).getTime() : b[key];
          if (av !== bv) return ((av as string | number) < (bv as string | number) ? -1 : 1) * (direction === 'desc' ? -1 : 1);
        }
        return 0;
      });
      return rows.slice(0, args.take ?? rows.length).map(r => structuredClone(args.select ? Object.fromEntries(Object.keys(args.select).map(k => [k, r[k]])) : r));
    };
    const create = (data: Row) => {
      // Prisma omits undefined fields; nullable foreign keys read back as null.
      data = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
      const row: Row = { id: uuid(sequence++), ...structuredClone(data) };
      if (table === 'submissions') Object.assign(row, { documentId: data.documentId ?? null, batchId: data.batchId ?? null, ticket: null,
        startedAt: new Date(), completedAt: null, result: 'PENDING', ...structuredClone(data) });
      if (table === 'documents' || table === 'batches') Object.assign(row, { status: 'QUEUED', acceptedAt: null, ...structuredClone(data) });
      const unique: string[][] = table === 'submissions' ? [['idempotencyKey']] : table === 'documents'
        ? [['documentId'], ['issuerRuc', 'environment', 'documentType', 'series', 'number'], ['billingEventId']] : table === 'batches'
          ? [['summaryId'], ['issuerRuc', 'environment', 'identifier'], ['billingEventId']] : table === 'documentArtifacts' ? [['documentId', 'kind']] : table === 'batchArtifacts' ? [['batchId', 'kind']] : [['id']];
      if (state[table].some(r => unique.some(fields => fields.every(k => scalar(r[k], row[k]))))) throw new Error('Memory unique constraint');
      state[table].push(row); return structuredClone(row);
    };
    return {
      findMany: vi.fn(async (args: Args) => { record('findMany', args); return find(args); }),
      findFirst: vi.fn(async (args: Args) => { record('findFirst', args); return find(args)[0] ?? null; }),
      findUnique: vi.fn(async (args: Args) => { record('findUnique', args); return find(args)[0] ?? null; }),
      findUniqueOrThrow: vi.fn(async (args: Args) => { record('findUniqueOrThrow', args); const found = find(args)[0]; if (!found) throw new Error('Memory row absent'); return found; }),
      create: vi.fn(async (args: Args) => { record('create', args); return create(args.data!); }),
      update: vi.fn(async (args: Args) => { record('update', args); const row = state[table].find(r => match(r, args.where)); if (!row) throw new Error('Memory row absent'); change(row, args.data!); return structuredClone(row); }),
      updateMany: vi.fn(async (args: Args) => { record('updateMany', args); const rows = state[table].filter(r => match(r, args.where)); rows.forEach(r => change(r, args.data!)); return { count: rows.length }; }),
      upsert: vi.fn(async (args: Args) => { record('upsert', args); const found = state[table].find(r => match(r, args.where)); if (!found) return create(args.create!); change(found, args.update!); return structuredClone(found); }),
    };
  }
  const prisma = { fiscalDocument: delegate('documents'), fiscalBatch: delegate('batches'), sunatSubmission: delegate('submissions'),
    documentArtifact: delegate('documentArtifacts'), batchArtifact: delegate('batchArtifacts'), sunatCredentials: delegate('credentials'), outboxEvent: delegate('outbox'),
    $executeRawUnsafe: vi.fn(async (sql: string, scope: string) => {
      expect(inTransaction).toBe(true); expect(sql).toBe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))'); expect(scope).toMatch(/^\d{11}:BETA:supplement$/); return 1;
    }),
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>, _options?: unknown) => {
      const previous = tail; let release!: () => void;
      tail = new Promise<void>(resolve => { release = resolve; }); await previous;
      const before = structuredClone(state); inTransaction = true;
      try { return await run(prisma); } catch (error) { state = before; throw error; } finally { inTransaction = false; release(); }
    }),
  };
  const repository = new BetaSupplementRepository(prisma as never);
  return { prisma, repository, operations, get state() { return state; } };
}
type Memory = ReturnType<typeof memory>;
function receipt(n = 1, type: '01' | '03' = '03'): FiscalDocumentSnapshot {
  const series = type === '01' ? 'F001' : 'B001';
  return { documentId: uuid(n), companyId: 1, branchId: uuid(999), documentTypeCode: type, environment: 'BETA', series, number: String(n), fullNumber: `${series}-${n}`,
    issueDate: '2026-10-02T16:00:00.000Z', currencyCode: 'PEN', operationTypeCode: '0101', ...(type === '01' ? { paymentTerms: { type: 'CONTADO' as const } } : {}),
    issuer: { identityType: '6', identityNumber: ruc, legalName: 'MEMORY ONLY', address: 'Av. Perú 123', ubigeo: '150101', establishmentCode: '0001' },
    customer: { identityType: '6', identityNumber: otherRuc, legalName: 'MEMORY ONLY' },
    ...calculateDocumentTotals([{ description: 'Memory fixture', unitCode: 'NIU', quantity: '2', unitPriceWithTax: '118', taxAffectationCode: '10', igvRate: '18' }]) };
}
function acceptance(snapshot: FiscalRcEntry['document']['snapshot'], source: FiscalAcceptanceEvidence['source'] = { kind: 'CDR_DOCUMENT' }): FiscalAcceptanceEvidence {
  return { environment: 'BETA', issuerRuc: ruc, documentId: snapshot.documentId, documentTypeCode: snapshot.documentTypeCode as FiscalAcceptanceEvidence['documentTypeCode'],
    fullNumber: snapshot.fullNumber, snapshotSha256: fiscalSnapshotSha256(snapshot), cdrSha256: 'c'.repeat(64), status: 'ACCEPTED', responseCode: '0', acceptedAt, source };
}
function seedDocument(f: Memory, snapshot: FiscalRcEntry['document']['snapshot'], status = 'QUEUED', timestamp: string | null = null) {
  f.state.documents.push({ documentId: snapshot.documentId, issuerRuc: snapshot.issuer.identityNumber, environment: snapshot.environment, documentType: snapshot.documentTypeCode,
    series: snapshot.series, number: BigInt(snapshot.number), billingEventId: uuid(1000 + f.state.documents.length), immutablePayload: structuredClone(snapshot), status, acceptedAt: timestamp ? new Date(timestamp) : null });
}
function noteFixture() {
  const f = memory(), original = receipt(1, '01'); seedDocument(f, original, 'ACCEPTED', acceptedAt);
  f.state.documentArtifacts.push({ documentId: original.documentId, kind: 'CDR_ZIP', sha256: 'c'.repeat(64) });
  const context: FiscalNoteContext = { original, acceptance: acceptance(original), asOf, creditHistory: { complete: true, entries: [] } };
  const envelope = (n = 10, ctx = context): BetaFiscalEnvelope => ({ kind: 'NOTE', context: ctx, note: buildFiscalNoteSnapshot(ctx,
    { documentTypeCode: '07', reasonCode: '07', reasonDescription: 'Memory fixture', lines: [{ originalLineNumber: 1, quantity: '1' }] },
    { documentId: uuid(n), series: 'FN01', number: String(n), issueDate: '2026-10-02T17:00:00.000Z' }) });
  return { ...f, get state() { return f.state; }, original, context, envelope };
}
function batch(entries: FiscalRcEntry[], n = 400): FiscalBatchSnapshot {
  return buildFiscalBatchSnapshot({ kind: 'RC', entries }, { documentId: uuid(n), identifier: `RC-20261003-${n}`, issueDate: '2026-10-03', referenceDate: '2026-10-02' }, asOf);
}
function seedAcceptedBatch(f: Memory, snapshot: FiscalBatchSnapshot, timestamp = acceptedAt) {
  const id = uuid(2000 + f.state.batches.length);
  f.state.batches.push({ id, summaryId: snapshot.documentId, identifier: snapshot.identifier, issuerRuc: ruc, environment: 'BETA', status: 'ACCEPTED', immutablePayload: structuredClone(snapshot), billingEventId: uuid(3000 + f.state.batches.length) });
  f.state.submissions.push({ id: uuid(4000 + f.state.submissions.length), batchId: id, channel: 'SOAP_SEND_SUMMARY', errorCode: 'DONE', result: 'SUCCESS', completedAt: new Date(timestamp) });
  f.state.batchArtifacts.push({ batchId: id, kind: 'CDR_ZIP', sha256: 'c'.repeat(64) }, { batchId: id, kind: 'SIGNED_XML', sha256: 'd'.repeat(64) });
  return id;
}
function summaryFixture() {
  const f = memory(), original = receipt(); seedDocument(f, original);
  const sourceBatch = buildFiscalBatchSnapshot({ kind: 'RC', entries: [{ conditionCode: '1', document: { snapshot: original } }] },
    { documentId: uuid(100), identifier: 'RC-20261002-100', issueDate: '2026-10-02', referenceDate: '2026-10-02' }, asOf);
  const batchId = seedAcceptedBatch(f, sourceBatch);
  const evidence = acceptance(original, { kind: 'CDR_SUMMARY', identifier: sourceBatch.identifier, referenceDate: '2026-10-02', lineNumber: 1, conditionCode: '1' });
  const proof: BetaSummaryAcceptanceMetadata = { environment: 'BETA', issuerRuc: ruc, batchDocumentId: sourceBatch.documentId, identifier: sourceBatch.identifier,
    batchSnapshotSha256: fiscalSnapshotSha256(sourceBatch), documentId: original.documentId, documentTypeCode: '03', fullNumber: original.fullNumber,
    snapshotSha256: fiscalSnapshotSha256(original), referenceDate: '2026-10-02', lineNumber: 1, conditionCode: '1', acceptedAt, status: 'ACCEPTED', responseCode: '0',
    cdrFileName: `R-${ruc}-${sourceBatch.identifier}.xml`, cdrZipSha256: 'c'.repeat(64), cdrXmlSha256: 'e'.repeat(64), requestXmlSha256: 'd'.repeat(64), description: 'MOCK TRUST, NOT A SIGNATURE TEST', notes: [] };
  const modified = structuredClone(original);
  Object.assign(modified, calculateDocumentTotals([{ description: 'Changed values', unitCode: 'NIU', quantity: '2', unitPriceWithTax: '59', taxAffectationCode: '10', igvRate: '18' }]));
  const entry: FiscalRcEntry = { conditionCode: '2', document: { snapshot: modified }, previous: { document: { snapshot: original }, acceptance: evidence } };
  const envelope: BetaFiscalEnvelope = { kind: 'BATCH', batch: batch([entry]), asOf };
  return { ...f, get state() { return f.state; }, original, modified, sourceBatch, batchId, evidence, proof, entry, envelope };
}
async function stage(f: Memory, envelope: BetaFiscalEnvelope, proofs: BetaSummaryAcceptanceMetadata[] = []) { return f.repository.stage(envelope, uuid(800), uuid(801), proofs); }
function packageManifest(row: BetaSupplementRow): BetaSupplementManifest {
  const reference = row.snapshot.envelope.kind === 'NOTE' ? row.snapshot.envelope.note.fullNumber : row.snapshot.envelope.batch.identifier;
  const xml = { storageKey: `${row.documentId}/request.xml`, sha256: 'a'.repeat(64), sizeBytes: 20 }, zip = { storageKey: `${row.documentId}/request.zip`, sha256: hash(Buffer.from('MOCK ZIP')), sizeBytes: 8 };
  return { reference, fileName: `${ruc}-${row.snapshot.envelope.kind === 'NOTE' ? `${row.snapshot.envelope.note.documentTypeCode}-` : ''}${reference}.zip`, revision: 1,
    fingerprint: 'f'.repeat(64), digest: 'MOCK DIGEST', xml, zip, xsdEvidence: { xmlSha256: xml.sha256 } };
}
async function prepared(f: Memory, envelope: BetaFiscalEnvelope, proofs: BetaSummaryAcceptanceMetadata[] = []) {
  const id = await stage(f, envelope, proofs), row = (await f.repository.claim((await f.repository.load(id))!, 'PREPARING'))!;
  const manifest = packageManifest(row); f.state.credentials.push({ issuerRuc: ruc, environment: 'BETA', revision: 1, certificateFingerprint: manifest.fingerprint });
  expect(await f.repository.savePrepared(row, manifest)).toBe(true); return { id, row, manifest };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('NETWORK FORBIDDEN'); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('BETA supplement staging transactions and reservations', () => {
  it('keeps the three-argument document-CDR path and idempotent replay', async () => {
    const f = noteFixture(), envelope = f.envelope(), id = await stage(f, envelope);
    expect(await stage(f, envelope)).toBe(id); expect(f.state.documents).toHaveLength(2); expect(f.state.submissions).toHaveLength(1);
    expect(f.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
    expect(f.operations.filter(o => ['findMany', 'create'].includes(o.operation)).every(o => o.inTransaction)).toBe(true);
  });
  it('only one of two parallel credits reserves the unchanged history', async () => {
    const f = noteFixture(); const results = await Promise.allSettled([stage(f, f.envelope(10)), stage(f, f.envelope(11))]);
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']); expect(f.state.documents).toHaveLength(2); expect(f.state.submissions).toHaveLength(1);
  });
  it('accepts the next credit with complete reserved history, but rejects changed states', async () => {
    const f = noteFixture(), first = f.envelope(10); await stage(f, first);
    if (first.kind !== 'NOTE') throw new Error();
    const ctx = structuredClone(f.context); ctx.creditHistory.entries = [{ state: 'RESERVED', note: first.note }];
    await f.repository.stage(f.envelope(11, ctx), uuid(802), uuid(801)); expect(f.state.documents).toHaveLength(3);
    const wrong = noteFixture(), known = wrong.envelope(10); if (known.kind !== 'NOTE') throw new Error();
    seedDocument(wrong, known.note, 'ACCEPTED', acceptedAt); const stale = structuredClone(wrong.context); stale.creditHistory.entries = [{ state: 'RESERVED', note: known.note }];
    await expect(stage(wrong, wrong.envelope(11, stale))).rejects.toThrow('Historial');
  });
  it.each(['snapshot', 'status', 'time', 'cdr'] as const)('rechecks document acceptance under the lock: %s', async violation => {
    const f = noteFixture(), envelope = f.envelope();
    if (violation === 'snapshot') (f.state.documents[0].immutablePayload as FiscalDocumentSnapshot).customer.legalName = 'Changed';
    if (violation === 'status') f.state.documents[0].status = 'REJECTED';
    if (violation === 'time') f.state.documents[0].acceptedAt = new Date(now);
    if (violation === 'cdr') f.state.documentArtifacts[0].sha256 = '0'.repeat(64);
    await expect(stage(f, envelope)).rejects.toThrow(); expect(f.state.documents).toHaveLength(1); expect(f.state.submissions).toHaveLength(0);
  });
  it('rolls back a note reservation if submission creation fails', async () => {
    const f = noteFixture(); f.prisma.sunatSubmission.create.mockRejectedValueOnce(new Error('write failed'));
    await expect(stage(f, f.envelope())).rejects.toThrow('write failed'); expect(f.state.documents).toHaveLength(1); expect(f.state.submissions).toHaveLength(0);
  });
  it('propagates a serialization failure without retrying staging internally', async () => {
    const f = noteFixture(); f.prisma.sunatSubmission.create.mockRejectedValueOnce(Object.assign(new Error('serialization'), { code: 'P2034' }));
    await expect(stage(f, f.envelope())).rejects.toMatchObject({ code: 'P2034' });
    expect(f.prisma.$transaction).toHaveBeenCalledOnce(); expect(f.state.documents).toHaveLength(1);
  });
  it('freezes the caller envelope before waiting for the transaction lock', async () => {
    const f = noteFixture(), envelope = f.envelope(); const running = stage(f, envelope);
    if (envelope.kind !== 'NOTE') throw new Error(); envelope.note.reasonDescription = 'Mutated while awaiting';
    const id = await running; const archived = await f.repository.load(id);
    expect(archived?.snapshot.envelope.kind === 'NOTE' && archived.snapshot.envelope.note.reasonDescription).toBe('Memory fixture');
  });
  it('rejects a different envelope under the same idempotency key', async () => {
    const f = noteFixture(), envelope = f.envelope(); await stage(f, envelope);
    if (envelope.kind !== 'NOTE') throw new Error(); envelope.note.reasonDescription = 'Changed'; envelope.note.adjustment.reasonDescription = 'Changed';
    await expect(stage(f, envelope)).rejects.toThrow('No se modifica'); expect(f.state.submissions).toHaveLength(1);
  });
});

describe('authoritative summary version fence inside staging', () => {
  it('accepts the authoritative singleton BetaIssuance mapping while keeping the distinct batch UUID', async () => {
    const f = summaryFixture(); f.state.batches[0].summaryId = f.original.documentId;
    await stage(f, f.envelope, [f.proof]); expect(f.proof.batchDocumentId).not.toBe(f.original.documentId);
  });
  it('does not use singleton lookup mapping for a batch with multiple members', async () => {
    const f = summaryFixture(), extra = receipt(2);
    const own = buildFiscalBatchSnapshot({ kind: 'RC', entries: [{ conditionCode: '1', document: { snapshot: f.original } }, { conditionCode: '1', document: { snapshot: extra } }] },
      { documentId: f.sourceBatch.documentId, identifier: f.sourceBatch.identifier, issueDate: '2026-10-02', referenceDate: '2026-10-02' }, asOf);
    f.state.batches[0].immutablePayload = own; f.state.batches[0].summaryId = f.original.documentId; f.proof.batchSnapshotSha256 = fiscalSnapshotSha256(own);
    await expect(stage(f, f.envelope, [f.proof])).rejects.toThrow('Versión/miembro');
  });
  it('reserves RC2 new values against the exact accepted prior version and immutable base', async () => {
    const f = summaryFixture(); expect(f.modified.totals).not.toEqual(f.original.totals);
    const id = await stage(f, f.envelope, [f.proof]); expect((await f.repository.load(id))?.phase).toBe('AWAITING_AUTHORIZATION');
    expect(f.state.batches).toHaveLength(2); expect(f.state.documents[0].acceptedAt).toBeNull();
    expect((f.state.documents[0].immutablePayload as FiscalDocumentSnapshot).totals).toEqual(f.original.totals);
    expect(f.operations.filter(o => ['batches', 'batchArtifacts', 'submissions'].includes(o.table)).every(o => o.inTransaction || o.operation === 'findUnique')).toBe(true);
  });
  it('allows a note on a later accepted RC2 version even when the base snapshot has old amounts', async () => {
    const f = summaryFixture(), rc2 = batch([f.entry], 200), laterAt = '2026-10-03T16:00:00.000Z'; seedAcceptedBatch(f, rc2, laterAt);
    const evidence = { ...acceptance(f.modified, { kind: 'CDR_SUMMARY', identifier: rc2.identifier, referenceDate: '2026-10-02', lineNumber: 1, conditionCode: '2' }), acceptedAt: laterAt };
    const context: FiscalNoteContext = { original: f.modified, acceptance: evidence, asOf, creditHistory: { complete: true, entries: [] } };
    const note = buildFiscalNoteSnapshot(context, { documentTypeCode: '07', reasonCode: '07', reasonDescription: 'After RC2', lines: [{ originalLineNumber: 1, quantity: '1' }] },
      { documentId: uuid(10), series: 'BN01', number: '10', issueDate: '2026-10-03T17:00:00.000Z' });
    seedDocument(f, note);
    const noteBatch = buildFiscalBatchSnapshot({ kind: 'RC', entries: [{ conditionCode: '1', document: { snapshot: note, noteContext: context } }] },
      { documentId: uuid(401), identifier: 'RC-20261003-401', issueDate: '2026-10-03', referenceDate: '2026-10-03' }, asOf);
    const proof = { ...f.proof, batchDocumentId: rc2.documentId, identifier: rc2.identifier, batchSnapshotSha256: fiscalSnapshotSha256(rc2), snapshotSha256: fiscalSnapshotSha256(f.modified),
      conditionCode: '2' as const, acceptedAt: laterAt, cdrFileName: `R-${ruc}-${rc2.identifier}.xml` };
    await stage(f, { kind: 'BATCH', batch: noteBatch, asOf }, [proof]); expect(f.state.batches).toHaveLength(3);
  });
  it('omitted RC proofs fail closed; unrelated proofs cannot substitute', async () => {
    const f = summaryFixture(); await expect(stage(f, f.envelope)).rejects.toThrow('Prueba RC');
    await expect(stage(f, f.envelope, [{ ...f.proof, documentId: uuid(999) }])).rejects.toThrow('Prueba RC'); expect(f.state.batches).toHaveLength(1);
  });
  it('also refuses omitted proofs on an idempotent replay of an archived summary source', async () => {
    const f = summaryFixture(); const id = await stage(f, f.envelope, [f.proof]);
    await expect(stage(f, f.envelope)).rejects.toThrow('Prueba RC'); expect(await stage(f, f.envelope, [f.proof])).toBe(id);
  });
  it('reserves RC3 using the exact prior accepted version without editing the immutable base', async () => {
    const f = summaryFixture(); const entry: FiscalRcEntry = { conditionCode: '3', document: { snapshot: f.original }, previous: { document: { snapshot: f.original }, acceptance: f.evidence },
      notDelivered: { status: 'NOT_DELIVERED', documentId: f.original.documentId, documentTypeCode: '03', fullNumber: f.original.fullNumber, issuerRuc: ruc,
        snapshotSha256: fiscalSnapshotSha256(f.original), evidenceId: uuid(900), assertedAt: '2026-10-03T16:00:00.000Z' } };
    await stage(f, { kind: 'BATCH', batch: batch([entry]), asOf }, [f.proof]); expect(f.state.batches).toHaveLength(2); expect(f.state.documents[0].status).toBe('QUEUED');
  });
  it.each(['environment', 'issuerRuc', 'documentId', 'documentTypeCode', 'fullNumber', 'snapshotSha256', 'identifier', 'referenceDate', 'lineNumber', 'conditionCode', 'acceptedAt', 'status', 'responseCode', 'cdrFileName', 'cdrZipSha256', 'batchDocumentId', 'batchSnapshotSha256', 'requestXmlSha256', 'cdrXmlSha256'] as const)('rejects proof scope/version change: %s', async field => {
    const f = summaryFixture(), proof = structuredClone(f.proof) as unknown as Row;
    proof[field] = field === 'lineNumber' ? 2 : field === 'conditionCode' ? '2' : field === 'requestXmlSha256' ? undefined : 'wrong';
    await expect(stage(f, f.envelope, [proof as unknown as BetaSummaryAcceptanceMetadata])).rejects.toThrow(); expect(f.state.batches).toHaveLength(1);
  });
  it.each(['status', 'batchSnapshot', 'batchSummaryId', 'cdrZip', 'signedXml', 'submissionResult', 'submissionPhase', 'submissionTime', 'laterDone'] as const)('rereads authoritative state rather than trusting proof: %s', async change => {
    const f = summaryFixture();
    if (change === 'status') f.state.batches[0].status = 'REJECTED';
    if (change === 'batchSnapshot') (f.state.batches[0].immutablePayload as FiscalBatchSnapshot).totals.payableAmount = '0.00';
    if (change === 'batchSummaryId') f.state.batches[0].summaryId = uuid(998);
    if (change === 'cdrZip') f.state.batchArtifacts[0].sha256 = '0'.repeat(64);
    if (change === 'signedXml') f.state.batchArtifacts[1].sha256 = '0'.repeat(64);
    if (change === 'submissionResult') f.state.submissions[0].result = 'UNKNOWN';
    if (change === 'submissionPhase') f.state.submissions[0].errorCode = 'CDR_UNVERIFIED';
    if (change === 'submissionTime') f.state.submissions[0].completedAt = new Date(now);
    if (change === 'laterDone') f.state.submissions.push({ ...f.state.submissions[0], id: uuid(4001), completedAt: new Date(now) });
    await expect(stage(f, f.envelope, [f.proof])).rejects.toThrow(); expect(f.state.batches).toHaveLength(1);
  });
  it.each(['customer', 'issuer', 'companyId', 'branchId', 'issueDate'] as const)('RC2 cannot change the frozen base header: %s', async field => {
    const f = summaryFixture(); const base = f.state.documents[0].immutablePayload as unknown as Row;
    base[field] = field === 'customer' || field === 'issuer' ? { ...(base[field] as Row), legalName: 'Changed base' } : field === 'companyId' ? 2 : field === 'branchId' ? uuid(998) : '2026-10-02T15:00:00.000Z';
    await expect(stage(f, f.envelope, [f.proof])).rejects.toThrow('Snapshot propio');
  });
  it.each(['PROCESSING', 'PERMANENT_ERROR', 'RETRYABLE_ERROR', 'SUBMITTED'] as const)('pending/ambiguous original batches block a reservation: %s', async status => {
    const f = summaryFixture(); f.state.batches.push({ ...f.state.batches[0], id: uuid(2001), identifier: 'RC-20261003-200', status });
    await expect(stage(f, f.envelope, [f.proof])).rejects.toThrow('Original tiene lote reservado');
  });
  it.each(['1', '2', '3'] as const)('a later accepted RC condition %s invalidates old evidence', async conditionCode => {
    const f = summaryFixture(); let entry: FiscalRcEntry;
    if (conditionCode === '1') entry = { conditionCode, document: { snapshot: f.original } };
    else if (conditionCode === '2') entry = f.entry;
    else entry = { conditionCode, document: { snapshot: f.original }, previous: { document: { snapshot: f.original }, acceptance: f.evidence },
      notDelivered: { status: 'NOT_DELIVERED', documentId: f.original.documentId, documentTypeCode: '03', fullNumber: f.original.fullNumber, issuerRuc: ruc,
        snapshotSha256: fiscalSnapshotSha256(f.original), evidenceId: uuid(900), assertedAt: '2026-10-03T16:00:00.000Z' } };
    seedAcceptedBatch(f, batch([entry], 200), '2026-10-03T17:00:00.000Z');
    await expect(stage(f, f.envelope, [f.proof])).rejects.toThrow('versión RC/baja posterior');
  });
  it('ignores later accepted batches belonging to another RUC or production', async () => {
    const f = summaryFixture(); f.state.batches.push({ ...f.state.batches[0], id: uuid(2001), environment: 'PRODUCTION' }, { ...f.state.batches[0], id: uuid(2002), issuerRuc: otherRuc });
    await stage(f, f.envelope, [f.proof]); expect(f.state.batches).toHaveLength(4);
  });
  it('rejects unrelated and conflicting duplicate proofs; allows repeated identical verifier metadata', async () => {
    const f = summaryFixture(); await expect(stage(f, f.envelope, [f.proof, { ...f.proof, documentId: uuid(999) }])).rejects.toThrow('ajena');
    await expect(stage(f, f.envelope, [f.proof, { ...f.proof, cdrXmlSha256: '0'.repeat(64) }])).rejects.toThrow('Prueba RC');
    await stage(f, f.envelope, [f.proof, structuredClone(f.proof)]);
  });
  it('freezes verifier metadata before any awaited read', async () => {
    const f = summaryFixture(), pending = stage(f, f.envelope, [f.proof]); f.proof.requestXmlSha256 = '0'.repeat(64); await pending;
    expect(f.state.batches).toHaveLength(2);
  });
});

describe('batch member aliases and idempotency', () => {
  it('blocks RC1 already accepted in a global batch without a member acceptedAt projection', async () => {
    const f = summaryFixture(), high: BetaFiscalEnvelope = { kind: 'BATCH', batch: batch([{ conditionCode: '1', document: { snapshot: f.original } }]), asOf };
    await expect(stage(f, high)).rejects.toThrow('reservado/aceptado'); expect(f.state.documents[0].acceptedAt).toBeNull();
  });
  it.each(['uuid-case', 'fiscal-number', 'legacy-shape'] as const)('does not bypass another batch reservation through %s', async kind => {
    const f = memory(), snapshot = receipt(); seedDocument(f, snapshot);
    const known = structuredClone(snapshot); if (kind === 'uuid-case') known.documentId = known.documentId.toUpperCase(); if (kind === 'fiscal-number') known.documentId = uuid(2);
    f.state.batches.push({ id: uuid(2000), summaryId: uuid(100), issuerRuc: ruc, environment: 'BETA', status: 'PROCESSING',
      immutablePayload: kind === 'legacy-shape' ? known : batch([{ conditionCode: '1', document: { snapshot: known } }], 100) });
    await expect(stage(f, { kind: 'BATCH', batch: batch([{ conditionCode: '1', document: { snapshot } }]), asOf })).rejects.toThrow('reservado');
  });
  it('rejects duplicate UUID case aliases within a new batch even with different numbers', async () => {
    const f = memory(), one = receipt(1), two = receipt(2); two.documentId = one.documentId.toUpperCase(); seedDocument(f, one); seedDocument(f, two);
    await expect(stage(f, { kind: 'BATCH', batch: batch([{ conditionCode: '1', document: { snapshot: one } }, { conditionCode: '1', document: { snapshot: two } }]), asOf })).rejects.toThrow('Alias');
  });
  it('serializes overlapping parallel batches and rolls back a failed batch submission', async () => {
    const f = memory(), snapshot = receipt(); seedDocument(f, snapshot);
    const make = (n: number): BetaFiscalEnvelope => ({ kind: 'BATCH', batch: batch([{ conditionCode: '1', document: { snapshot } }], n), asOf });
    const results = await Promise.allSettled([stage(f, make(400)), f.repository.stage(make(401), uuid(802), uuid(801))]);
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']); expect(f.state.batches).toHaveLength(1);
    const rollback = memory(); seedDocument(rollback, snapshot); rollback.prisma.sunatSubmission.create.mockRejectedValueOnce(new Error('batch failure'));
    await expect(stage(rollback, make(400))).rejects.toThrow('batch failure'); expect(rollback.state.batches).toHaveLength(0);
  });
});

describe('claims, lease fencing, immutable packages and rollback', () => {
  it('allows exactly one concurrent claim with a strictly newer millisecond owner', async () => {
    const f = noteFixture(), id = await stage(f, f.envelope()), input = (await f.repository.load(id))!;
    const results = await Promise.all([f.repository.claim(input, 'PREPARING'), f.repository.claim(input, 'PREPARING')]);
    expect(results.filter(Boolean)).toHaveLength(1); expect(results[0]!.owner.getTime()).toBeGreaterThan(input.owner.getTime());
  });
  it.each(['SENDING', 'POLLING', 'DONE', 'UNKNOWN', 'BLOCKED', 'CDR_UNVERIFIED'] as BetaPhase[])('never claims phase %s for a new POST', async phase => {
    const f = noteFixture(), id = await stage(f, f.envelope()), row = (await f.repository.load(id))!; row.phase = phase;
    expect(await f.repository.claim(row, 'PREPARING')).toBeNull(); expect(f.prisma.sunatSubmission.updateMany).not.toHaveBeenCalled();
  });
  it('rejects stale owner/attempt, expired lease and a mutated row snapshot', async () => {
    const f = noteFixture(), p = await prepared(f, f.envelope());
    expect(await f.repository.transition({ ...p.row, owner: now }, 'PREPARED', 'SENDING')).toBe(false);
    expect(await f.repository.transition({ ...p.row, attempt: 2 }, 'PREPARED', 'SENDING')).toBe(false);
    expect(await f.repository.owns({ ...p.row, attempt: 2 }, 'PREPARED')).toBe(false);
    const mutated = structuredClone(p.row); if (mutated.snapshot.envelope.kind !== 'NOTE') throw new Error();
    mutated.snapshot.envelope.note.reasonDescription = 'Changed'; mutated.snapshot.envelope.note.adjustment.reasonDescription = 'Changed';
    expect(await f.repository.claim({ ...mutated, phase: 'PREPARED' }, 'PREPARING')).toBeNull();
    vi.setSystemTime(new Date(now.getTime() + 60001)); expect(await f.repository.transition(p.row, 'PREPARED', 'SENDING')).toBe(false);
    expect(await f.repository.savePrepared(p.row, p.manifest)).toBe(false); expect(f.state.outbox).toHaveLength(0);
  });
  it.each(['document', 'batch'] as const)('archives %s artifacts idempotently after reloading PREPARED', async kind => {
    const f = kind === 'document' ? noteFixture() : memory();
    const envelope = kind === 'document' ? (f as ReturnType<typeof noteFixture>).envelope() : { kind: 'BATCH' as const, batch: batch([{ conditionCode: '1', document: { snapshot: receipt() } }]), asOf };
    if (kind === 'batch') seedDocument(f, receipt());
    const p = await prepared(f, envelope); expect(await f.repository.savePrepared(p.row, p.manifest)).toBe(false);
    vi.setSystemTime(new Date(now.getTime() + 60002)); const reclaimed = (await f.repository.claim((await f.repository.load(p.id))!, 'PREPARING'))!;
    expect(await f.repository.savePrepared(reclaimed, p.manifest)).toBe(true);
    expect(f.state[kind === 'document' ? 'documentArtifacts' : 'batchArtifacts'].filter(a => ['SIGNED_XML', 'SUBMISSION_ZIP'].includes(String(a.kind)))).toHaveLength(2);
  });
  it.each((['document', 'batch'] as const).flatMap(kind => (['sha256', 'storageKey', 'sizeBytes', 'mediaType'] as const).map(field => [kind, field] as const)))('%s artifact conflict %s rolls back PREPARED and both artifacts', async (kind, field) => {
    const f = kind === 'document' ? noteFixture() : memory();
    const envelope = kind === 'document' ? (f as ReturnType<typeof noteFixture>).envelope() : { kind: 'BATCH' as const, batch: batch([{ conditionCode: '1', document: { snapshot: receipt() } }]), asOf };
    if (kind === 'batch') seedDocument(f, receipt());
    const id = await stage(f, envelope), row = (await f.repository.claim((await f.repository.load(id))!, 'PREPARING'))!, manifest = packageManifest(row);
    f.state.credentials.push({ issuerRuc: ruc, environment: 'BETA', revision: 1, certificateFingerprint: manifest.fingerprint });
    const artifacts = kind === 'document' ? f.state.documentArtifacts : f.state.batchArtifacts;
    const owner = kind === 'document' ? { documentId: row.documentId } : { batchId: f.state.batches[0].id };
    artifacts.push({ ...owner, kind: 'SUBMISSION_ZIP', ...manifest.zip, mediaType: 'application/zip', [field]: field === 'sizeBytes' ? 9 : 'changed' });
    await expect(f.repository.savePrepared(row, manifest)).rejects.toThrow('artefacto');
    expect((await f.repository.load(id))?.phase).toBe('PREPARING');
    expect(f.state[kind === 'document' ? 'documentArtifacts' : 'batchArtifacts'].filter(a => Object.entries(owner).every(([k, v]) => a[k] === v))).toHaveLength(1);
    if (kind === 'document') expect(f.state.documents[1].digestValue).toBeUndefined();
  });
  it('rejects a changed manifest or credential revision without replacing the package', async () => {
    const f = noteFixture(), p = await prepared(f, f.envelope());
    await expect(f.repository.savePrepared(p.row, { ...p.manifest, digest: 'changed' })).rejects.toThrow('paquete');
    const other = noteFixture(), id = await stage(other, other.envelope()), row = (await other.repository.claim((await other.repository.load(id))!, 'PREPARING'))!;
    other.state.credentials.push({ issuerRuc: ruc, environment: 'BETA', revision: 2, certificateFingerprint: 'f'.repeat(64) });
    await expect(other.repository.savePrepared(row, packageManifest(row))).rejects.toThrow('Certificado'); expect(other.state.documentArtifacts).toHaveLength(1);
  });
  it('outbox failure rolls back submission and fiscal status; terminal retry creates one event', async () => {
    const f = noteFixture(), p = await prepared(f, f.envelope()); expect(await f.repository.transition(p.row, 'PREPARED', 'SENDING')).toBe(true);
    const details = { cdr: { trusted: true, status: 'ACCEPTED' as const, code: '0', description: 'MOCK', notes: [] } };
    f.prisma.outboxEvent.create.mockRejectedValueOnce(new Error('outbox failure'));
    await expect(f.repository.transition(p.row, 'SENDING', 'DONE', details)).rejects.toThrow('outbox failure');
    expect((await f.repository.load(p.id))?.phase).toBe('SENDING'); expect(f.state.documents[1].status).toBe('SUBMITTED');
    expect(await f.repository.transition(p.row, 'SENDING', 'DONE', details)).toBe(true); expect(await f.repository.transition(p.row, 'SENDING', 'DONE', details)).toBe(false);
    expect(f.state.documents[1].acceptedAt).toEqual(f.state.submissions[0].completedAt); expect(f.state.outbox).toHaveLength(2);
  });
  it.each([false, undefined])('DONE requires trusted CDR (%s)', async trusted => {
    const f = noteFixture(), p = await prepared(f, f.envelope()); await f.repository.transition(p.row, 'PREPARED', 'SENDING');
    await expect(f.repository.transition(p.row, 'SENDING', 'DONE', { cdr: { trusted, status: 'ACCEPTED', code: '0', description: 'MOCK', notes: [] } as never })).rejects.toThrow('CDR confiable');
    expect(f.state.documents[1].status).toBe('SUBMITTED');
  });
});

describe('bounded recovery, ticket ownership and no POST retry', () => {
  it('recovers expired SENDING only to UNKNOWN, and the real pipeline never posts twice', async () => {
    const f = noteFixture(), id = await stage(f, f.envelope()), initial = (await f.repository.load(id))!;
    const manifest = packageManifest(initial); f.state.credentials.push({ issuerRuc: ruc, environment: 'BETA', revision: 1, certificateFingerprint: manifest.fingerprint });
    const preparedPackage = { fileName: manifest.fileName, reference: manifest.reference, revision: 1, sha256: manifest.zip.sha256, zip: Buffer.from('MOCK ZIP') };
    const submit = vi.fn(async () => { throw new Error('lost response after POST'); });
    const ports: BetaDispatchPorts<typeof initial.snapshot> = { authorize: async () => {}, claim: (r, p) => f.repository.claim(r, p),
      prepare: async () => preparedPackage, archived: async () => preparedPackage, savePrepared: r => f.repository.savePrepared(r, manifest),
      owns: (r, p) => f.repository.owns(r, p), transition: (r, a, b, d) => f.repository.transition(r, a, b, d), submit,
      getStatus: async () => { throw new Error('no ticket'); }, cdr: async () => { throw new Error('no CDR'); } };
    const pipeline = new BetaDispatchPipeline(ports); await pipeline.run(initial); expect((await f.repository.load(id))?.phase).toBe('UNKNOWN');
    await pipeline.run((await f.repository.load(id))!); await f.repository.recoverInterrupted(); await pipeline.run((await f.repository.load(id))!);
    expect(submit).toHaveBeenCalledOnce(); expect(await f.repository.due()).toEqual([]);
    expect(await f.repository.transition(initial, 'UNKNOWN', 'PREPARED')).toBe(false);
    const interrupted = noteFixture(), p = await prepared(interrupted, interrupted.envelope()); await interrupted.repository.transition(p.row, 'PREPARED', 'SENDING');
    vi.setSystemTime(new Date(now.getTime() + 60002)); await interrupted.repository.recoverInterrupted(); expect((await interrupted.repository.load(p.id))?.phase).toBe('UNKNOWN');
  });
  it('expires preparation leases with backoff, fences the old owner and stops at three attempts', async () => {
    const f = noteFixture(), id = await stage(f, f.envelope()); let row = (await f.repository.claim((await f.repository.load(id))!, 'PREPARING'))!;
    const first = row;
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(row.attempt).toBe(attempt); vi.setSystemTime(new Date(row.owner.getTime() + 60000)); await f.repository.recoverInterrupted();
      if (attempt < 3) {
        expect(await f.repository.due()).toEqual([]); vi.setSystemTime(new Date(Date.now() + 2000));
        row = (await f.repository.claim((await f.repository.load(id))!, 'PREPARING'))!;
      }
    }
    expect((await f.repository.load(id))?.phase).toBe('BLOCKED'); expect(await f.repository.claim((await f.repository.load(id))!, 'PREPARING')).toBeNull();
    expect(await f.repository.transition(first, 'PREPARING', 'BLOCKED')).toBe(false); expect(await f.repository.due()).toEqual([]);
  });
  it('keeps the archived ticket, bounds polling and never returns it to preparation', async () => {
    const f = memory(), doc = receipt(); seedDocument(f, doc); const p = await prepared(f, { kind: 'BATCH', batch: batch([{ conditionCode: '1', document: { snapshot: doc } }]), asOf });
    await f.repository.transition(p.row, 'PREPARED', 'SENDING'); await f.repository.transition(p.row, 'SENDING', 'WAITING_TICKET', { ticket: 'TICKET_1', delayMs: 2000 });
    vi.setSystemTime(new Date(now.getTime() + 2000)); const input = (await f.repository.load(p.id))!;
    expect(await f.repository.claim(input, 'PREPARING')).toBeNull(); const polling = (await f.repository.claim(input, 'POLLING'))!;
    expect(polling.attempt).toBe(2); expect(polling.ticket).toBe('TICKET_1');
    await expect(f.repository.transition(polling, 'POLLING', 'WAITING_TICKET', { ticket: 'TICKET_2' })).rejects.toThrow('Ticket');
    f.state.submissions[0].attempt = 20; f.state.submissions[0].nextRetryAt = new Date(Date.now()); await f.repository.recoverInterrupted();
    expect((await f.repository.load(p.id))?.phase).toBe('UNKNOWN'); expect(await f.repository.due()).toEqual([]);
  });
  it('recovery predicates protect a lease renewed after candidate selection', async () => {
    const f = noteFixture(), id = await stage(f, f.envelope()), row = (await f.repository.claim((await f.repository.load(id))!, 'PREPARING'))!;
    vi.setSystemTime(new Date(row.owner.getTime() + 60000)); const update = f.prisma.sunatSubmission.updateMany.getMockImplementation()!;
    f.prisma.sunatSubmission.updateMany.mockImplementationOnce(async args => { f.state.submissions[0].nextRetryAt = new Date(Date.now() + 60000); return update(args); });
    await f.repository.recoverInterrupted(); expect((await f.repository.load(id))?.phase).toBe('PREPARING');
  });
});
