import 'reflect-metadata';
import { Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fiscalSnapshotSha256 } from '../packages/sunat-core/src/fiscal-note';
import { betaSigningFixture } from './helpers/beta-signing.fixture';
import { BetaSupplementEvidenceConsumer, BETA_SUPPLEMENT_EVIDENCE_EVENT as EVENT,
  BETA_SUPPLEMENT_EVIDENCE_QUEUE as QUEUE } from '../services/sunat-service/src/application/beta-supplement-evidence.consumer';

type Row = Record<string, any>;
type JobInput = { name: string; id?: string; data: unknown };
const ports = vi.hoisted(() => ({
  workers: [] as { queue: string; process: (job: JobInput) => Promise<void>; options: unknown;
    listeners: Map<string, (...args: unknown[]) => void>; close: ReturnType<typeof vi.fn> }[],
  lives: [] as { changed: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[],
  redis: vi.fn(() => ({ host: 'redis.invalid', port: 6379 })),
  queue: vi.fn(() => { throw new Error('REAL_QUEUE_FORBIDDEN'); }),
  startupFailure: false,
}));
// Resolver desde el servicio: BullMQ no es una dependencia del package raíz.
vi.mock('../services/sunat-service/node_modules/bullmq', () => ({
  Queue: ports.queue,
  Worker: class {
    private readonly item;
    constructor(queue: string, process: (job: JobInput) => Promise<void>, options: unknown) {
      if (ports.startupFailure) throw new Error('REDIS_PASSWORD_FIXTURE');
      this.item = { queue, process, options, listeners: new Map<string, (...args: unknown[]) => void>(), close: vi.fn(async () => {}) };
      ports.workers.push(this.item);
    }
    on(name: string, listener: (...args: unknown[]) => void) { this.item.listeners.set(name, listener); return this; }
    close() { return this.item.close(); }
  },
}));
vi.mock('@factuez/service-access', () => ({
  redisConnection: ports.redis,
  LivePublisher: class {
    private readonly item = { changed: vi.fn(async (_id: string) => {}), close: vi.fn(async () => {}) };
    constructor() { ports.lives.push(this.item); }
    changed(id: string) { return this.item.changed(id); }
    close() { return this.item.close(); }
  },
}));
vi.mock('../services/sunat-service/src/infrastructure/prisma.service', () => ({ PrismaService: class {} }));

const ruc = '20615878481', otherRuc = '20100070970';
const uuid = (n: number) => `abcdefab-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = new Date('2026-10-03T18:00:00.000Z');
const socketAttempt = vi.fn();
type Table = 'documents' | 'batches' | 'submissions' | 'outbox' | 'inbox';
type Args = { where: Row; select?: Row; data?: Row };

/** Sólo metadatos sintéticos. El mock evalúa IDs/selecciones, serializa las
 * transacciones y revierte el Inbox si aborta el commit. No prueba PostgreSQL,
 * Redis, confianza PKI ni SUNAT; ningún cliente de esos servicios se instancia.
 */
function mockPrisma() {
  const state: Record<Table, Row[]> = { documents: [], batches: [], submissions: [], outbox: [], inbox: [] };
  const operations: { table: Table; operation: string; inTransaction: boolean; args: Args }[] = [];
  const primary: Record<Table, string> = { documents: 'documentId', batches: 'id', submissions: 'id', outbox: 'id', inbox: 'eventId' };
  let active = false, tail = Promise.resolve(), failCommit = false;
  const forbidden = vi.fn(() => { throw new Error('FINANCIAL_OR_SECRET_OPERATION_FORBIDDEN'); });
  function delegate(table: Table) {
    return {
      findUnique: vi.fn(async (args: Args) => {
        expect(active).toBe(true);
        expect(Object.keys(args.where)).toEqual([primary[table]]);
        expect(args.select).toBeDefined();
        operations.push({ table, operation: 'read', inTransaction: active, args: structuredClone(args) });
        const row = state[table].find(value => String(value[primary[table]]).toLowerCase() === String(args.where[primary[table]]).toLowerCase());
        return row ? structuredClone(Object.fromEntries(Object.keys(args.select!).filter(key => args.select![key]).map(key => [key, row[key]]))) : null;
      }),
      create: table === 'inbox' ? vi.fn(async (args: Args) => {
        expect(active).toBe(true);
        operations.push({ table, operation: 'create', inTransaction: active, args: structuredClone(args) });
        if (state.inbox.some(row => row.eventId === args.data!.eventId)) throw new Error('P2002');
        const row = structuredClone(args.data!); state.inbox.push(row); return row;
      }) : forbidden,
      update: forbidden, updateMany: forbidden, upsert: forbidden, delete: forbidden,
    };
  }
  const prisma = {
    fiscalDocument: delegate('documents'), fiscalBatch: delegate('batches'), sunatSubmission: delegate('submissions'),
    outboxEvent: delegate('outbox'), inboxEvent: delegate('inbox'),
    sunatCredentials: { findUnique: forbidden }, documentArtifact: { findUnique: forbidden }, batchArtifact: { findUnique: forbidden },
    billing: { update: forbidden }, fiscalQaCounter: { update: forbidden },
    $executeRaw: vi.fn(async (sql: TemplateStringsArray, scope: string) => {
      expect(active).toBe(true);
      expect(sql.join('?')).toBe('SELECT pg_advisory_xact_lock(hashtextextended(?,0))');
      expect(scope).toMatch(/^beta-supplement-evidence:[a-f0-9-]{36}$/); return 1;
    }),
    $transaction: vi.fn(async <T>(callback: (tx: unknown) => Promise<T>, options: unknown) => {
      expect(options).toEqual({ isolationLevel: 'Serializable' });
      const previous = tail;
      let release!: () => void; tail = new Promise<void>(resolve => { release = resolve; });
      await previous;
      const inboxBefore = structuredClone(state.inbox); active = true;
      try {
        const result = await callback(prisma);
        if (failCommit) { failCommit = false; throw new Error('DATABASE_SECRET_FIXTURE'); }
        return result;
      } catch (error) { state.inbox = inboxBefore; throw error; }
      finally { active = false; release(); }
    }),
  };
  return { state, prisma, operations, forbidden, abortCommit: () => { failCommit = true; } };
}
function snapshot(id: string, type: string, reference?: Row): Row {
  return { documentId: id, environment: 'BETA', documentTypeCode: type,
    issuer: { identityNumber: ruc, legalName: 'EMISOR FICTICIO SIN CONFIGURACION' },
    series: type === '01' ? 'F001' : type === '03' ? 'B001' : 'FC01', number: '1',
    totals: { payableAmount: '1.18', taxAmount: '0.18' }, ...(reference ? { reference } : {}) };
}
function ownDocument(value: Row, status = 'SUBMITTED') {
  return { documentId: value.documentId.toLowerCase(), issuerRuc: ruc, environment: 'BETA',
    documentType: value.documentTypeCode, status, billingEventId: uuid(3), immutablePayload: structuredClone(value) };
}
function fixture(kind: 'NOTE' | 'RC' | 'RA' = 'NOTE', count = 2) {
  const db = mockPrisma();
  const original = snapshot(uuid(10), '01');
  const note = snapshot(uuid(11), '07', { documentId: original.documentId, documentTypeCode: '01' });
  let envelope: Row, owner: Row;
  if (kind === 'NOTE') {
    owner = ownDocument(note); db.state.documents.push(owner, ownDocument(original, 'ACCEPTED'));
    envelope = { kind: 'NOTE', note, context: { original } };
  } else {
    const members = Array.from({ length: count }, (_, n) => snapshot(uuid(n + 100), kind === 'RC' ? '03' : '01'));
    db.state.documents.push(...members.map(member => ownDocument(member, 'QUEUED')));
    const batch = { documentId: uuid(80), environment: 'BETA', issuer: { identityNumber: ruc },
      identifier: `${kind}-20261003-1`, kind, input: { kind, entries: members.map(member => ({ document: { snapshot: member } })) },
      totals: { payableAmount: '2.36' } };
    owner = { id: uuid(81), summaryId: batch.documentId, issuerRuc: ruc, environment: 'BETA',
      identifier: batch.identifier, status: 'SUBMITTED', billingEventId: uuid(3), immutablePayload: structuredClone(batch) };
    db.state.batches.push(owner); envelope = { kind: 'BATCH', batch, asOf: now.toISOString() };
  }
  const event: Row = { eventId: uuid(1), producer: 'sunat-service', environment: 'BETA', issuerRuc: ruc,
    submissionId: uuid(2), status: 'SUBMITTED', phase: 'SENDING', cdrSignatureVerified: false, responseCode: null };
  const metadata: Row = { version: 1, kind: 'BETA_SUPPLEMENT', eventId: uuid(3), correlationId: uuid(4),
    envelope, envelopeSha256: fiscalSnapshotSha256(envelope) };
  const submission: Row = { id: event.submissionId, documentId: kind === 'NOTE' ? note.documentId : null,
    batchId: kind === 'NOTE' ? null : owner.id, channel: kind === 'NOTE' ? 'SOAP_SEND_BILL' : 'SOAP_SEND_SUMMARY',
    idempotencyKey: `beta-supplement:${kind === 'NOTE' ? note.documentId : owner.summaryId}:v1`,
    errorCode: 'SENDING', errorMessage: JSON.stringify(metadata), result: 'PENDING', completedAt: null };
  db.state.submissions.push(submission);
  const outbox: Row = { id: event.eventId, eventType: EVENT,
    aggregateId: kind === 'NOTE' ? note.documentId : owner.summaryId, payload: structuredClone(event) };
  db.state.outbox.push(outbox);
  const consumer = new BetaSupplementEvidenceConsumer(db.prisma as never), live = ports.lives.at(-1)!;
  const job = (): JobInput => ({ name: EVENT, id: event.eventId, data: structuredClone(event) });
  const saveEvent = () => { outbox.payload = structuredClone(event); };
  const saveMetadata = () => { metadata.envelopeSha256 = fiscalSnapshotSha256(envelope); submission.errorMessage = JSON.stringify(metadata); };
  const saveBatch = () => { owner.immutablePayload = structuredClone(envelope.batch); saveMetadata(); };
  const financialState = () => structuredClone({ documents: db.state.documents, batches: db.state.batches, submissions: db.state.submissions, outbox: db.state.outbox });
  return { ...db, consumer, live, event, metadata, envelope, submission, owner, original, outbox, job, saveEvent, saveMetadata, saveBatch, financialState };
}
type Fixture = ReturnType<typeof fixture>;
function outcome(f: Fixture, phase: string, status: string, responseCode: string | null = null) {
  Object.assign(f.event, { phase, status, responseCode, cdrSignatureVerified: phase === 'DONE' });
  f.owner.status = status; f.submission.errorCode = phase;
  f.submission.result = phase === 'SENDING' ? 'PENDING' : phase === 'DONE' ? status === 'REJECTED' ? 'BUSINESS_ERROR' : 'SUCCESS' :
    phase === 'BLOCKED' ? 'BUSINESS_ERROR' : 'UNKNOWN';
  f.submission.completedAt = phase === 'SENDING' ? null : now;
  if (phase === 'DONE') f.metadata.cdr = { trusted: true, status, code: responseCode ?? (status === 'REJECTED' ? '2335' : '0'), description: 'CDR FICTICIO', notes: [] };
  f.saveEvent(); f.saveMetadata();
}
async function rejected(f: Fixture, job = f.job()) {
  const financialBefore = f.financialState();
  await expect(f.consumer.process(job)).rejects.toThrow('No se pudo consumir evidencia BETA');
  expect(f.state.inbox).toHaveLength(0); expect(f.live.changed).not.toHaveBeenCalled();
  expect(f.financialState()).toEqual(financialBefore); expect(f.forbidden).not.toHaveBeenCalled();
}

beforeEach(() => {
  ports.workers.length = 0; ports.lives.length = 0; ports.startupFailure = false;
  ports.redis.mockClear(); ports.queue.mockClear();
  socketAttempt.mockClear();
  vi.spyOn(Socket.prototype, 'connect').mockImplementation(() => { socketAttempt(); throw new Error('NETWORK_FORBIDDEN'); });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('NETWORK_FORBIDDEN'); }));
});
afterEach(() => { expect(ports.queue).not.toHaveBeenCalled(); expect(socketAttempt).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('contrato plano V1 y procedencia propia SUNAT', () => {
  it.each([
    ['production', { environment: 'PRODUCTION' }], ['producer ajeno', { producer: 'billing-service' }],
    ['UUID arbitrario', { eventId: 'not-an-id' }], ['UUID nulo', { eventId: '00000000-0000-0000-0000-000000000000' }],
    ['UUID sin variante', { submissionId: 'abcdefab-0000-4000-0000-000000000002' }], ['UUID con espacios', { submissionId: ` ${uuid(2)}` }],
    ['RUC corto', { issuerRuc: '2061587848' }], ['RUC con salto', { issuerRuc: `${ruc}\n` }], ['RUC numérico', { issuerRuc: Number(ruc) }],
    ['fase desconocida', { phase: 'VOIDED' }], ['fase válida no emitida', { phase: 'PREPARED' }], ['estado inválido', { status: 'VOIDED' }],
    ['claim terminal en progreso', { status: 'ACCEPTED' }], ['firma de progreso', { cdrSignatureVerified: true }],
    ['firma coercionada', { cdrSignatureVerified: 'false' }], ['código ausente', { responseCode: undefined }],
    ['código largo', { responseCode: 'A'.repeat(41) }], ['código con datos', { responseCode: 'Bearer secret' }],
    ['código objeto', { responseCode: { code: '0' } }], ['campo secreto extra', { solPassword: 'FIXTURE_ONLY' }],
    ['ID de UI arbitrario', { documentId: uuid(999) }], ['contrato anidado', { payload: { documentId: uuid(999) } }],
  ])('rechaza %s antes de consultar DB', async (_label, changes) => {
    const f = fixture(); Object.assign(f.event, changes); await rejected(f);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it.each([{ data: null }, { data: [] }, { data: 'payload' }, { data: 42 }, { data: {} }])('rechaza payload no contractual $data', async ({ data }) => {
    const f = fixture(); await rejected(f, { name: EVENT, data }); expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it('exige todos los campos y el nombre/jobId publicados por el outbox', async () => {
    const f = fixture(); await rejected(f, { ...f.job(), name: 'sunat.status.changed.v1' });
    await rejected(f, { ...f.job(), id: uuid(999) }); delete f.event.responseCode; await rejected(f);
  });
  it.each(['missing', 'type', 'aggregate', 'payload', 'submission'] as const)('rechaza outbox/submission falsificado: %s', async failure => {
    const f = fixture();
    if (failure === 'missing') f.state.outbox.length = 0;
    if (failure === 'type') f.outbox.eventType = 'billing.document.issued.v1';
    if (failure === 'aggregate') f.outbox.aggregateId = uuid(999);
    if (failure === 'payload') f.outbox.payload.issuerRuc = otherRuc;
    if (failure === 'submission') { f.event.submissionId = uuid(999); f.saveEvent(); }
    await rejected(f);
  });
  it('acepta UUID en mayúsculas y job sin ID; nunca los utiliza como IDs de UI', async () => {
    const f = fixture(); f.event.eventId = f.event.eventId.toUpperCase(); f.event.submissionId = f.event.submissionId.toUpperCase(); f.saveEvent();
    await f.consumer.process({ name: EVENT, data: f.event });
    expect(f.state.inbox[0].eventId).toBe(uuid(1));
    expect(f.live.changed.mock.calls).toEqual([[uuid(11)], [uuid(10)]]);
  });
  it.each(['NOTE', 'RC', 'RA'] as const)('evento de reserva de %s debe coincidir con billingEventId propio', async kind => {
    const f = fixture(kind); f.metadata.eventId = uuid(999); f.saveMetadata(); await rejected(f);
  });
});

describe('sólo IDs de documento/miembros y original de nota propios BETA', () => {
  it('invalida nota y original sin escribir ninguna proyección fiscal/financiera', async () => {
    const f = fixture(), before = f.financialState(); await f.consumer.process(f.job());
    expect(f.live.changed.mock.calls).toEqual([[uuid(11)], [uuid(10)]]);
    expect(f.state.inbox).toEqual([{ eventId: uuid(1), eventType: EVENT }]);
    expect(f.financialState()).toEqual(before); expect(f.forbidden).not.toHaveBeenCalled();
    expect(f.operations.filter(op => op.operation === 'create').map(op => op.table)).toEqual(['inbox']);
    expect(f.operations.every(op => op.inTransaction)).toBe(true);
  });
  it.each(['RC', 'RA'] as const)('invalida sólo miembros propios de %s, excluyendo summaryId/submission/eventId', async kind => {
    const f = fixture(kind), before = f.financialState(); await f.consumer.process(f.job());
    expect(f.live.changed.mock.calls).toEqual([[uuid(100)], [uuid(101)]]);
    expect(f.financialState()).toEqual(before); expect(f.forbidden).not.toHaveBeenCalled();
  });
  it.each(['ruc', 'environment', 'snapshotRuc', 'snapshotEnvironment', 'snapshotId', 'reference', 'originalRuc', 'originalEnvironment',
    'missingOriginal', 'context', 'idempotency', 'channel', 'doubleOwner', 'metadataKind', 'metadataHash', 'metadataEvent', 'json'] as const)
    ('rechaza pertenencia/metadata de nota inconsistente: %s', async failure => {
      const f = fixture(), saved = f.owner.immutablePayload;
      if (failure === 'ruc') f.owner.issuerRuc = otherRuc;
      if (failure === 'environment') f.owner.environment = 'PRODUCTION';
      if (failure === 'snapshotRuc') saved.issuer.identityNumber = otherRuc;
      if (failure === 'snapshotEnvironment') saved.environment = 'PRODUCTION';
      if (failure === 'snapshotId') saved.documentId = uuid(999);
      if (failure === 'reference') saved.reference.documentId = uuid(999);
      if (failure === 'originalRuc') f.state.documents[1].issuerRuc = otherRuc;
      if (failure === 'originalEnvironment') f.state.documents[1].environment = 'PRODUCTION';
      if (failure === 'missingOriginal') f.state.documents.pop();
      if (failure === 'context') { f.envelope.context.original.documentId = uuid(999); f.saveMetadata(); }
      if (failure === 'idempotency') f.submission.idempotencyKey = `beta-issue:${uuid(11)}:v1`;
      if (failure === 'channel') f.submission.channel = 'REST_GRE_SUBMIT';
      if (failure === 'doubleOwner') f.submission.batchId = uuid(81);
      if (failure === 'metadataKind') { f.metadata.kind = 'BETA_DOCUMENT'; f.saveMetadata(); }
      if (failure === 'metadataHash') f.submission.errorMessage = JSON.stringify({ ...f.metadata, envelopeSha256: 'a'.repeat(64) });
      if (failure === 'metadataEvent') { f.metadata.eventId = 'secret-not-a-uuid'; f.saveMetadata(); }
      if (failure === 'json') f.submission.errorMessage = '{PRIVATE_SNAPSHOT_FIXTURE';
      await rejected(f);
    });
  it.each(['missing', 'ruc', 'production', 'rootRuc', 'rootId', 'identifier', 'kind', 'hash', 'owner'] as const)
    ('rechaza lote ajeno/inconsistente: %s', async failure => {
      const f = fixture('RC');
      if (failure === 'missing') f.state.batches.length = 0;
      if (failure === 'ruc') f.owner.issuerRuc = otherRuc;
      if (failure === 'production') f.owner.environment = 'PRODUCTION';
      if (failure === 'rootRuc') f.owner.immutablePayload.issuer.identityNumber = otherRuc;
      if (failure === 'rootId') f.owner.immutablePayload.documentId = uuid(999);
      if (failure === 'identifier') f.owner.identifier = 'RC-20261003-999';
      if (failure === 'kind') { f.envelope.batch.input.kind = 'RA'; f.saveBatch(); }
      if (failure === 'hash') f.owner.immutablePayload.totals.payableAmount = '0.00';
      if (failure === 'owner') f.submission.documentId = uuid(11);
      await rejected(f);
    });
  it.each([0, 101])('rechaza cardinalidad %i antes de cargar miembros', async count => {
    const f = fixture('RC', count); await rejected(f); expect(f.prisma.fiscalDocument.findUnique).not.toHaveBeenCalled();
  });
  it('acepta exactamente 100 miembros sin modificar sus estados/totales', async () => {
    const f = fixture('RC', 100), before = f.financialState(); await f.consumer.process(f.job());
    expect(f.live.changed).toHaveBeenCalledTimes(100); expect(f.financialState()).toEqual(before);
  });
  it.each(['duplicate', 'caseDuplicate', 'uuid', 'ruc', 'production', 'missing', 'ownRuc', 'ownProduction', 'ownSnapshot', 'type'] as const)
    ('rechaza miembro inválido: %s', async failure => {
      const f = fixture('RC'), entries = f.envelope.batch.input.entries, member = entries[1].document.snapshot;
      if (failure === 'duplicate' || failure === 'caseDuplicate') member.documentId = failure === 'duplicate' ? uuid(100) : uuid(100).toUpperCase();
      if (failure === 'uuid') member.documentId = 'not-a-uuid';
      if (failure === 'ruc') member.issuer.identityNumber = otherRuc;
      if (failure === 'production') member.environment = 'PRODUCTION';
      if (failure === 'missing') f.state.documents.pop();
      if (failure === 'ownRuc') f.state.documents[1].issuerRuc = otherRuc;
      if (failure === 'ownProduction') f.state.documents[1].environment = 'PRODUCTION';
      if (failure === 'ownSnapshot') f.state.documents[1].immutablePayload.documentId = uuid(999);
      if (failure === 'type') member.documentTypeCode = '08';
      f.saveBatch(); await rejected(f);
    });
  it('nota de lote invalida su original una sola vez y nunca IDs de previous/acceptance/historial', async () => {
    const f = fixture('RC'), original = snapshot(uuid(20), '03');
    f.state.documents.push(ownDocument(original, 'ACCEPTED'));
    f.envelope.batch.input.entries = [100, 101].map(n => {
      const note = snapshot(uuid(n), '07', { documentId: original.documentId, documentTypeCode: '03' });
      f.state.documents[n - 100] = ownDocument(note, 'QUEUED');
      return { document: { snapshot: note, noteContext: { original, creditHistory: { entries: [{ documentId: uuid(997) }] } } },
        previous: { document: { snapshot: snapshot(uuid(998), '03') } }, acceptance: { documentId: uuid(999), cdrSignatureVerified: true } };
    });
    f.saveBatch(); await f.consumer.process(f.job());
    expect(f.live.changed.mock.calls).toEqual([[uuid(100)], [uuid(20)], [uuid(101)]]);
  });
  it('rechaza original ajeno de nota en lote aun con flags de aceptación', async () => {
    const f = fixture('RC'), original = snapshot(uuid(20), '03'), note = snapshot(uuid(100), '07', { documentId: original.documentId, documentTypeCode: '03' });
    f.state.documents[0] = ownDocument(note); f.state.documents.push({ ...ownDocument(original, 'ACCEPTED'), issuerRuc: otherRuc });
    f.envelope.batch.input.entries[0].document = { snapshot: note, noteContext: { original, acceptance: { cdrSignatureVerified: true } } };
    f.saveBatch(); await rejected(f);
  });
});

describe('estado actual, evidencia sin confianza fiscal y progreso tardío', () => {
  it.each([
    ['DONE', 'ACCEPTED', '0'], ['DONE', 'ACCEPTED_WITH_OBSERVATIONS', '0'], ['DONE', 'REJECTED', '2335'],
    ['DONE', 'ACCEPTED', null], ['UNKNOWN', 'RETRYABLE_ERROR', 'RECONCILIATION_REQUIRED'],
    ['BLOCKED', 'PERMANENT_ERROR', 'LOCAL_PREFLIGHT_FAILED'], ['CDR_UNVERIFIED', 'RETRYABLE_ERROR', 'CDR_SIGNATURE_UNVERIFIED'],
  ])('consume %s/%s sin alterar la fuente fiscal', async (phase, status, code) => {
    const f = fixture(); outcome(f, phase!, status!, code); const before = f.financialState();
    await f.consumer.process(f.job()); expect(f.live.changed).toHaveBeenCalledTimes(2); expect(f.financialState()).toEqual(before);
  });
  it.each(['DONE', 'UNKNOWN', 'BLOCKED', 'CDR_UNVERIFIED', 'WAITING_TICKET', 'POLLING'])('SENDING tardío sólo invalida lectura tras %s', async current => {
    const f = fixture('RC'), archivedProgress = structuredClone(f.event);
    if (current === 'WAITING_TICKET' || current === 'POLLING') f.submission.errorCode = current;
    else outcome(f, current, current === 'DONE' ? 'ACCEPTED' : current === 'BLOCKED' ? 'PERMANENT_ERROR' : 'RETRYABLE_ERROR');
    Object.assign(f.event, archivedProgress); f.saveEvent(); const before = f.financialState();
    await f.consumer.process(f.job()); expect(f.live.changed.mock.calls).toEqual([[uuid(100)], [uuid(101)]]); expect(f.financialState()).toEqual(before);
  });
  it('permite aviso tardío tras recuperación UNKNOWN que todavía conserva SUBMITTED', async () => {
    const f = fixture(); f.submission.errorCode = 'UNKNOWN'; f.submission.result = 'UNKNOWN'; f.submission.completedAt = now;
    await f.consumer.process(f.job()); expect(f.owner.status).toBe('SUBMITTED');
  });
  it('nota sendBill no puede alegar fase de ticket/consulta', async () => {
    const f = fixture(); f.submission.errorCode = 'WAITING_TICKET'; await rejected(f);
  });
  it('CDR_UNVERIFIED no acepta metadata que alegue CDR confiable', async () => {
    const f = fixture(); outcome(f, 'CDR_UNVERIFIED', 'RETRYABLE_ERROR');
    f.metadata.cdr = { trusted: true, status: 'ACCEPTED', code: '0' }; f.saveMetadata(); await rejected(f);
  });
  it.each(['status', 'result', 'completed', 'phase', 'cdrTrust', 'cdrCode', 'eventCode', 'terminalPhase', 'terminalStatus', 'terminalFlag'] as const)
    ('rechaza claim/estado actual incoherente: %s', async failure => {
      const f = fixture(); outcome(f, 'DONE', 'ACCEPTED', '0');
      if (failure === 'status') f.owner.status = 'QUEUED';
      if (failure === 'result') f.submission.result = 'UNKNOWN';
      if (failure === 'completed') f.submission.completedAt = null;
      if (failure === 'phase') f.submission.errorCode = 'PREPARING';
      if (failure === 'cdrTrust') { f.metadata.cdr.trusted = false; f.saveMetadata(); }
      if (failure === 'cdrCode') { f.metadata.cdr.code = '2335'; f.saveMetadata(); }
      if (failure === 'eventCode') f.event.responseCode = '2335';
      if (failure === 'terminalPhase') Object.assign(f.event, { phase: 'UNKNOWN', status: 'RETRYABLE_ERROR', responseCode: null, cdrSignatureVerified: false });
      if (failure === 'terminalStatus') f.event.status = 'REJECTED';
      if (failure === 'terminalFlag') f.event.cdrSignatureVerified = false;
      f.saveEvent(); await rejected(f);
    });
  it('certificado efímero y flag true no dan aceptación a miembros ni acceso a credenciales', async () => {
    const f = fixture('RC'), synthetic = betaSigningFixture();
    expect(synthetic.certificatePem).toContain('BEGIN CERTIFICATE');
    f.metadata.prepared = { fingerprint: 'a'.repeat(64), revision: 1 }; outcome(f, 'DONE', 'ACCEPTED', '0');
    const before = f.financialState(); await f.consumer.process(f.job());
    expect(f.state.documents.map(row => row.status)).toEqual(['QUEUED', 'QUEUED']);
    expect(f.financialState()).toEqual(before); expect(f.prisma.sunatCredentials.findUnique).not.toHaveBeenCalled();
    expect(f.prisma.batchArtifact.findUnique).not.toHaveBeenCalled(); expect(f.forbidden).not.toHaveBeenCalled();
  });
});

describe('Inbox transaccional, rollback y replay de notificación', () => {
  it('replay registra una vez pero revalida y vuelve a invalidar los mismos IDs', async () => {
    const f = fixture(); await f.consumer.process(f.job()); await f.consumer.process(f.job());
    expect(f.state.inbox).toHaveLength(1); expect(f.prisma.inboxEvent.create).toHaveBeenCalledOnce();
    expect(f.prisma.sunatSubmission.findUnique).toHaveBeenCalledTimes(2);
    expect(f.live.changed.mock.calls).toEqual([[uuid(11)], [uuid(10)], [uuid(11)], [uuid(10)]]);
  });
  it('concurrente registra una vez; avisos duplicados son invalidaciones idempotentes', async () => {
    const f = fixture(); await Promise.all([f.consumer.process(f.job()), f.consumer.process(f.job())]);
    expect(f.state.inbox).toHaveLength(1); expect(f.prisma.inboxEvent.create).toHaveBeenCalledOnce(); expect(f.live.changed).toHaveBeenCalledTimes(4);
  });
  it('rollback de commit revierte Inbox y no publica nada antes de reintentar', async () => {
    const f = fixture(); f.abortCommit(); await rejected(f);
    await f.consumer.process(f.job()); expect(f.state.inbox).toHaveLength(1); expect(f.live.changed).toHaveBeenCalledTimes(2);
  });
  it('fallo de inserción no publica ni acusa recibo; retry puede registrar', async () => {
    const f = fixture(); f.prisma.inboxEvent.create.mockRejectedValueOnce(new Error('DB_PRIVATE_FIXTURE'));
    await rejected(f); await f.consumer.process(f.job()); expect(f.state.inbox).toHaveLength(1);
  });
  it('fallo live posterior al commit permite replay sin otra escritura Inbox', async () => {
    const f = fixture(), before = f.financialState();
    f.live.changed.mockImplementationOnce(async () => { expect(f.state.inbox).toHaveLength(1); throw new Error('REDIS_PRIVATE_FIXTURE'); });
    await expect(f.consumer.process(f.job())).rejects.toThrow('No se pudo consumir evidencia BETA');
    expect(f.state.inbox).toHaveLength(1); await f.consumer.process(f.job());
    expect(f.prisma.inboxEvent.create).toHaveBeenCalledOnce();
    expect(f.live.changed.mock.calls).toEqual([[uuid(11)], [uuid(11)], [uuid(10)]]); expect(f.financialState()).toEqual(before);
  });
  it('fallo live parcial vuelve a invalidar todos los IDs, incluido el ya publicado', async () => {
    const f = fixture('RC'); f.live.changed.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('LIVE_PRIVATE_FIXTURE'));
    await expect(f.consumer.process(f.job())).rejects.toThrow('No se pudo consumir evidencia BETA');
    await f.consumer.process(f.job()); expect(f.live.changed.mock.calls).toEqual([[uuid(100)], [uuid(101)], [uuid(100)], [uuid(101)]]);
    expect(f.state.inbox).toHaveLength(1);
  });
  it('dedupe no omite revalidación: cambio de scope/estado u outbox provoca rechazo', async () => {
    const f = fixture(); await f.consumer.process(f.job()); f.live.changed.mockClear(); f.owner.issuerRuc = otherRuc;
    await expect(f.consumer.process(f.job())).rejects.toThrow('No se pudo consumir evidencia BETA');
    f.owner.issuerRuc = ruc; f.owner.status = 'ACCEPTED';
    await expect(f.consumer.process(f.job())).rejects.toThrow('No se pudo consumir evidencia BETA');
    f.owner.status = 'SUBMITTED'; f.outbox.payload.submissionId = uuid(999);
    await expect(f.consumer.process(f.job())).rejects.toThrow('No se pudo consumir evidencia BETA');
    expect(f.state.inbox).toHaveLength(1); expect(f.live.changed).not.toHaveBeenCalled();
  });
  it('eventId ya registrado con otro contrato no se reutiliza', async () => {
    const f = fixture(); f.state.inbox.push({ eventId: uuid(1), eventType: 'billing.document.issued.v1' });
    await expect(f.consumer.process(f.job())).rejects.toThrow('No se pudo consumir evidencia BETA'); expect(f.live.changed).not.toHaveBeenCalled();
  });
  it('copia el claim antes de await para impedir retargeting del caller', async () => {
    const f = fixture(), job = f.job(); const processing = f.consumer.process(job);
    (job.data as Row).submissionId = uuid(999); (job.data as Row).issuerRuc = otherRuc;
    await processing; expect(f.live.changed.mock.calls).toEqual([[uuid(11)], [uuid(10)]]);
  });
});

describe('lifecycle Nest/BullMQ y errores sin snapshots/secrets', () => {
  it('worker sólo en cola existente, conexión compartida; bootstrap y shutdown idempotentes', async () => {
    const f = fixture();
    await f.consumer.onApplicationBootstrap(); await f.consumer.onApplicationBootstrap();
    expect(ports.workers).toHaveLength(1); const worker = ports.workers[0];
    expect(worker.queue).toBe(QUEUE); expect(worker.options).toEqual({ connection: { host: 'redis.invalid', port: 6379 }, concurrency: 1 });
    expect(ports.redis).toHaveBeenCalledOnce(); await worker.process(f.job());
    await f.consumer.onModuleDestroy(); await f.consumer.onModuleDestroy(); await f.consumer.onApplicationBootstrap();
    expect(worker.close).toHaveBeenCalledOnce(); expect(f.live.close).toHaveBeenCalledOnce(); expect(ports.workers).toHaveLength(1);
  });
  it('cierra live aunque cierre worker falle y sanitiza el error', async () => {
    const f = fixture(); await f.consumer.onApplicationBootstrap(); ports.workers[0].close.mockRejectedValueOnce(new Error('REDIS_PASSWORD_FIXTURE'));
    await expect(f.consumer.onModuleDestroy()).rejects.toThrow('No se pudo cerrar el consumidor de evidencia BETA');
    expect(f.live.close).toHaveBeenCalledOnce();
  });
  it('mantiene live abierto mientras worker drena jobs y luego lo cierra', async () => {
    const f = fixture(); await f.consumer.onApplicationBootstrap();
    let drain!: () => void; ports.workers[0].close.mockImplementationOnce(() => new Promise<void>(resolve => { drain = resolve; }));
    const stopping = f.consumer.onModuleDestroy(); expect(f.live.close).not.toHaveBeenCalled(); drain(); await stopping; expect(f.live.close).toHaveBeenCalledOnce();
  });
  it('sin bootstrap cierra live y rechaza jobs después de destroy', async () => {
    const f = fixture(); await f.consumer.onModuleDestroy(); await rejected(f); expect(f.live.close).toHaveBeenCalledOnce();
  });
  it('fallo de bootstrap limpia recursos y oculta datos de conexión', async () => {
    const f = fixture(); ports.startupFailure = true;
    await expect(f.consumer.onApplicationBootstrap()).rejects.toThrow('No se pudo iniciar el consumidor de evidencia BETA');
    expect(f.live.close).toHaveBeenCalledOnce(); expect(ports.workers).toHaveLength(0);
  });
  it('errores DB/JSON/Redis no llegan a logs ni failedReason/cause', async () => {
    const logs = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {})];
    const f = fixture(); await f.consumer.onApplicationBootstrap();
    expect(() => ports.workers[0].listeners.get('error')!(new Error('REDIS_PASSWORD_FIXTURE'))).not.toThrow();
    f.prisma.outboxEvent.findUnique.mockRejectedValueOnce(new Error('SOL_SECRET_SNAPSHOT_FIXTURE'));
    const error = await f.consumer.process(f.job()).catch(value => value as Error);
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).toBe('No se pudo consumir evidencia BETA');
    expect((error as Error).stack).not.toContain('SOL_SECRET_SNAPSHOT_FIXTURE'); expect((error as Error).cause).toBeUndefined();
    expect(logs.every(log => log.mock.calls.length === 0)).toBe(true); await f.consumer.onModuleDestroy();
  });
});
