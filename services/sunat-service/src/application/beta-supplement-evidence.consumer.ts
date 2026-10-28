import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { isDeepStrictEqual } from 'node:util';
import { LivePublisher, redisConnection } from '@factuez/service-access';
import { fiscalSnapshotSha256 } from '@factuez/sunat-core/dist/fiscal-note';
import { PrismaService } from '../infrastructure/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import type { BetaPhase } from './beta-dispatch-pipeline';

export const BETA_SUPPLEMENT_EVIDENCE_QUEUE = 'sunat-beta-supplement-evidence-v1';
export const BETA_SUPPLEMENT_EVIDENCE_EVENT = 'sunat.beta.supplement.evidence.v1';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const RUC = /^\d{11}$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,39}$/;
const PHASES: readonly BetaPhase[] = ['AWAITING_AUTHORIZATION', 'PREPARING', 'PREPARED', 'RETRY_PREPARATION',
  'SENDING', 'WAITING_TICKET', 'POLLING', 'DONE', 'UNKNOWN', 'BLOCKED', 'CDR_UNVERIFIED'];
const STATUSES = ['QUEUED', 'BUILDING', 'SIGNED', 'SUBMITTED', 'PROCESSING', 'ACCEPTED',
  'ACCEPTED_WITH_OBSERVATIONS', 'REJECTED', 'RETRYABLE_ERROR', 'PERMANENT_ERROR'] as const;
type Status = typeof STATUSES[number];
export type BetaSupplementEvidenceV1 = {
  eventId: string; producer: 'sunat-service'; environment: 'BETA'; issuerRuc: string;
  submissionId: string; status: Status; phase: BetaPhase; cdrSignatureVerified: boolean; responseCode: string | null;
};
const FIELDS = ['eventId', 'producer', 'environment', 'issuerRuc', 'submissionId', 'status', 'phase',
  'cdrSignatureVerified', 'responseCode'];
const documentSelect = { documentId: true, issuerRuc: true, environment: true, documentType: true,
  status: true, billingEventId: true, immutablePayload: true } as const;
const submissionSelect = { id: true, documentId: true, batchId: true, channel: true, idempotencyKey: true,
  errorCode: true, errorMessage: true, result: true, completedAt: true } as const;
type OwnDocument = Prisma.FiscalDocumentGetPayload<{ select: typeof documentSelect }>;
type Submission = Prisma.SunatSubmissionGetPayload<{ select: typeof submissionSelect }>;
type ObjectValue = Record<string, unknown>;

function assertEvidence(condition: unknown): asserts condition {
  if (!condition) throw new Error('Evidencia BETA inválida');
}
function object(value: unknown): ObjectValue {
  assertEvidence(value && typeof value === 'object' && !Array.isArray(value));
  return value as ObjectValue;
}
function uuid(value: unknown): string {
  assertEvidence(typeof value === 'string' && UUID.test(value));
  return value.toLowerCase();
}
function scopedSnapshot(value: unknown, event: BetaSupplementEvidenceV1, id: string, type?: string) {
  const snapshot = object(value);
  assertEvidence(uuid(snapshot.documentId) === uuid(id) && snapshot.environment === 'BETA' &&
    object(snapshot.issuer).identityNumber === event.issuerRuc &&
    (type === undefined || snapshot.documentTypeCode === type));
  return snapshot;
}
function eventFrom(job: Pick<Job, 'name' | 'data' | 'id'>): BetaSupplementEvidenceV1 {
  assertEvidence(job.name === BETA_SUPPLEMENT_EVIDENCE_EVENT);
  const value = object(job.data);
  assertEvidence(Object.keys(value).length === FIELDS.length && FIELDS.every(field => Object.hasOwn(value, field)));
  uuid(value.eventId); uuid(value.submissionId);
  assertEvidence(job.id === undefined || uuid(job.id) === uuid(value.eventId));
  assertEvidence(value.producer === 'sunat-service' && value.environment === 'BETA' &&
    typeof value.issuerRuc === 'string' && RUC.test(value.issuerRuc) &&
    STATUSES.includes(value.status as Status) && PHASES.includes(value.phase as BetaPhase) &&
    typeof value.cdrSignatureVerified === 'boolean' &&
    (value.responseCode === null || typeof value.responseCode === 'string' && CODE.test(value.responseCode)));
  const event = value as BetaSupplementEvidenceV1;
  // transition() sólo publica estas cinco fases; conservar el V1 plano existente.
  const coherent = event.phase === 'SENDING' ? event.status === 'SUBMITTED' :
    event.phase === 'DONE' ? ['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS', 'REJECTED'].includes(event.status) :
    event.phase === 'BLOCKED' ? event.status === 'PERMANENT_ERROR' :
    ['UNKNOWN', 'CDR_UNVERIFIED'].includes(event.phase) && event.status === 'RETRYABLE_ERROR';
  assertEvidence(coherent && event.cdrSignatureVerified === (event.phase === 'DONE'));
  if (event.phase === 'DONE' && event.responseCode !== null)
    assertEvidence(event.status === 'REJECTED' ? event.responseCode !== '0' : event.responseCode === '0');
  // Copia sólo escalares antes del primer await: el caller no puede cambiar el claim.
  return { ...event };
}

/** Proyección pura de evidencia/notificaciones, NO proyección financiera.
 * Inbox es la única escritura. Los flags del evento no verifican firmas ni
 * acreditan aceptación/baja de documentos, miembros, Billing o correlativos.
 */
@Injectable()
export class BetaSupplementEvidenceConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private worker?: Worker;
  private readonly live = new LivePublisher();
  private stopping = false;
  private shutdown?: Promise<void>;
  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap() {
    if (this.worker || this.stopping) return;
    try {
      this.worker = new Worker(BETA_SUPPLEMENT_EVIDENCE_QUEUE, job => this.process(job),
        { connection: redisConnection(), concurrency: 1 });
      this.worker.on('error', () => { /* Sin snapshots, payloads ni errores Redis en logs. */ });
    } catch {
      await this.onModuleDestroy().catch(() => {});
      throw new Error('No se pudo iniciar el consumidor de evidencia BETA');
    }
  }

  async process(job: Pick<Job, 'name' | 'data' | 'id'>): Promise<void> {
    try {
      assertEvidence(!this.stopping);
      const event = eventFrom(job);
      const ids = await this.prisma.$transaction(async tx => {
        // Dedupe propio de SUNAT; conflictos serializables se reintentan por BullMQ.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`beta-supplement-evidence:${uuid(event.eventId)}`},0))`;
        const outbox = await tx.outboxEvent.findUnique({ where: { id: uuid(event.eventId) },
          select: { id: true, eventType: true, aggregateId: true, payload: true } });
        assertEvidence(outbox && uuid(outbox.id) === uuid(event.eventId) &&
          outbox.eventType === BETA_SUPPLEMENT_EVIDENCE_EVENT && isDeepStrictEqual(outbox.payload, event));
        const submission = await tx.sunatSubmission.findUnique({ where: { id: uuid(event.submissionId) }, select: submissionSelect });
        assertEvidence(submission && uuid(submission.id) === uuid(event.submissionId));
        const metadata = object(JSON.parse(submission.errorMessage ?? 'null'));
        assertEvidence(metadata.version === 1 && metadata.kind === 'BETA_SUPPLEMENT');
        uuid(metadata.eventId); uuid(metadata.correlationId);
        const envelope = object(metadata.envelope);
        assertEvidence(typeof metadata.envelopeSha256 === 'string' && /^[a-f0-9]{64}$/.test(metadata.envelopeSha256) &&
          fiscalSnapshotSha256(envelope) === metadata.envelopeSha256);
        const own = await this.ownScope(tx, submission, envelope, event);
        assertEvidence(uuid(outbox.aggregateId) === own.aggregateId &&
          uuid(own.billingEventId) === uuid(metadata.eventId) &&
          submission.idempotencyKey.toLowerCase() === `beta-supplement:${own.aggregateId}:v1`);
        this.currentState(submission, own.status, metadata, event);
        const inbox = await tx.inboxEvent.findUnique({ where: { eventId: uuid(event.eventId) }, select: { eventType: true } });
        if (inbox) assertEvidence(inbox.eventType === BETA_SUPPLEMENT_EVIDENCE_EVENT);
        else await tx.inboxEvent.create({ data: { eventId: uuid(event.eventId), eventType: BETA_SUPPLEMENT_EVIDENCE_EVENT } });
        return own.ids;
      }, { isolationLevel: 'Serializable' });
      // Después del commit, también en replay deduplicado. changed() sólo invalida
      // lecturas de UI; su fallo no vuelve a aplicar estado ni pierde el replay.
      for (const id of ids) await this.live.changed(id);
    } catch {
      // BullMQ puede persistir failedReason/stacktrace: nunca conservar el error
      // original de DB, Redis, JSON o un claim que pudiera contener secretos.
      throw new Error('No se pudo consumir evidencia BETA');
    }
  }

  private async ownDocument(tx: Prisma.TransactionClient, id: string, event: BetaSupplementEvidenceV1) {
    const own = await tx.fiscalDocument.findUnique({ where: { documentId: uuid(id) }, select: documentSelect });
    assertEvidence(own && uuid(own.documentId) === uuid(id) && own.issuerRuc === event.issuerRuc && own.environment === 'BETA' &&
      ['01', '03', '07', '08'].includes(own.documentType) && STATUSES.includes(own.status));
    scopedSnapshot(own.immutablePayload, event, own.documentId, own.documentType);
    return own;
  }

  private async addNoteOriginal(tx: Prisma.TransactionClient, own: OwnDocument, proposed: ObjectValue,
    contextValue: unknown, event: BetaSupplementEvidenceV1, ids: Set<string>) {
    const saved = object(own.immutablePayload), reference = object(saved.reference), proposedReference = object(proposed.reference);
    const originalId = uuid(reference.documentId);
    assertEvidence(originalId !== uuid(own.documentId) && originalId === uuid(proposedReference.documentId) &&
      ['01', '03'].includes(reference.documentTypeCode as string) && reference.documentTypeCode === proposedReference.documentTypeCode);
    const original = await this.ownDocument(tx, originalId, event);
    assertEvidence(original.documentType === reference.documentTypeCode);
    scopedSnapshot(object(contextValue).original, event, original.documentId, original.documentType);
    // El ID procede de la referencia de la nota PROPIA, nunca del evento/contexto.
    ids.add(uuid(original.documentId));
  }

  private async ownScope(tx: Prisma.TransactionClient, submission: Submission, envelope: ObjectValue,
    event: BetaSupplementEvidenceV1): Promise<{ aggregateId: string; billingEventId: string; status: Status; ids: string[] }> {
    const ids = new Set<string>();
    if (envelope.kind === 'NOTE') {
      assertEvidence(submission.documentId !== null && submission.batchId === null && submission.channel === 'SOAP_SEND_BILL');
      const own = await this.ownDocument(tx, submission.documentId, event);
      assertEvidence(['07', '08'].includes(own.documentType));
      const note = scopedSnapshot(envelope.note, event, own.documentId, own.documentType);
      assertEvidence(fiscalSnapshotSha256(note) === fiscalSnapshotSha256(own.immutablePayload));
      ids.add(uuid(own.documentId));
      await this.addNoteOriginal(tx, own, note, envelope.context, event, ids);
      return { aggregateId: uuid(own.documentId), billingEventId: own.billingEventId, status: own.status, ids: [...ids] };
    }
    assertEvidence(envelope.kind === 'BATCH' && submission.documentId === null && submission.batchId !== null &&
      submission.channel === 'SOAP_SEND_SUMMARY');
    const batch = await tx.fiscalBatch.findUnique({ where: { id: uuid(submission.batchId) },
      select: { id: true, summaryId: true, issuerRuc: true, environment: true, identifier: true, status: true, billingEventId: true, immutablePayload: true } });
    assertEvidence(batch && uuid(batch.id) === uuid(submission.batchId) && batch.environment === 'BETA' &&
      batch.issuerRuc === event.issuerRuc && STATUSES.includes(batch.status));
    const snapshot = scopedSnapshot(batch.immutablePayload, event, batch.summaryId);
    const input = object(snapshot.input), entries = input.entries;
    assertEvidence(['RC', 'RA'].includes(snapshot.kind as string) && input.kind === snapshot.kind &&
      snapshot.identifier === batch.identifier && fiscalSnapshotSha256(snapshot) === fiscalSnapshotSha256(envelope.batch) &&
      Array.isArray(entries) && entries.length > 0 && entries.length <= 100);
    const memberIds = new Set<string>();
    const members = entries.map(entry => {
      const document = object(object(entry).document), member = object(document.snapshot), id = uuid(member.documentId);
      scopedSnapshot(member, event, id);
      assertEvidence(!memberIds.has(id)); memberIds.add(id);
      return { id, member, context: document.noteContext };
    });
    for (const { id, member, context } of members) {
      const own = await this.ownDocument(tx, id, event);
      assertEvidence(own.documentType === member.documentTypeCode);
      ids.add(uuid(own.documentId));
      if (own.documentType === '07' || own.documentType === '08')
        await this.addNoteOriginal(tx, own, member, context, event, ids);
    }
    // summaryId/batch.id son identidades del lote, no IDs de documentos notificables.
    return { aggregateId: uuid(batch.summaryId), billingEventId: batch.billingEventId, status: batch.status, ids: [...ids] };
  }

  private currentState(submission: Submission, status: Status, metadata: ObjectValue, event: BetaSupplementEvidenceV1) {
    const phase = submission.errorCode as BetaPhase;
    assertEvidence(PHASES.includes(phase));
    const progress = ['SENDING', 'WAITING_TICKET', 'POLLING'].includes(phase);
    if (phase === 'WAITING_TICKET' || phase === 'POLLING') assertEvidence(submission.channel === 'SOAP_SEND_SUMMARY');
    if (progress) assertEvidence(submission.result === 'PENDING' && submission.completedAt === null && status === 'SUBMITTED');
    else {
      assertEvidence(submission.completedAt instanceof Date && Number.isFinite(submission.completedAt.getTime()));
      if (phase === 'DONE') {
        const cdr = object(metadata.cdr);
        assertEvidence(cdr.trusted === true && cdr.status === status && ['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS', 'REJECTED'].includes(status) &&
          typeof cdr.code === 'string' && CODE.test(cdr.code) && (status === 'REJECTED' ? cdr.code !== '0' : cdr.code === '0') &&
          submission.result === (status === 'REJECTED' ? 'BUSINESS_ERROR' : 'SUCCESS'));
        if (event.phase === 'DONE' && event.responseCode !== null) assertEvidence(event.responseCode === cdr.code);
      } else if (phase === 'BLOCKED') assertEvidence(status === 'PERMANENT_ERROR' && submission.result === 'BUSINESS_ERROR');
      else {
        assertEvidence(['UNKNOWN', 'CDR_UNVERIFIED'].includes(phase) && submission.result === 'UNKNOWN' &&
          (status === 'RETRYABLE_ERROR' || phase === 'UNKNOWN' && status === 'SUBMITTED'));
        if (phase === 'CDR_UNVERIFIED' && metadata.cdr !== undefined) assertEvidence(object(metadata.cdr).trusted === false);
      }
    }
    // Sólo progreso SENDING archivado puede llegar tras una fase posterior. Un
    // terminal contradictorio no se convierte en estado ni en confianza fiscal.
    assertEvidence(event.phase === phase || event.phase === 'SENDING' &&
      ['WAITING_TICKET', 'POLLING', 'DONE', 'UNKNOWN', 'BLOCKED', 'CDR_UNVERIFIED'].includes(phase));
    if (event.phase !== 'SENDING') assertEvidence(event.status === status);
  }

  onModuleDestroy(): Promise<void> {
    this.stopping = true;
    return this.shutdown ??= this.closeResources();
  }
  private async closeResources() {
    let failed = false;
    try { await this.worker?.close(); } catch { failed = true; }
    try { await this.live.close(); } catch { failed = true; }
    if (failed) throw new Error('No se pudo cerrar el consumidor de evidencia BETA');
  }
}
