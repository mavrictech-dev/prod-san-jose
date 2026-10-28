import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { EventNames, QueueNames } from '@factuez/contracts';
import { redisConnection } from '@factuez/service-access';
import { validateFiscalSupplementCommand } from '@factuez/sunat-core/dist/fiscal-supplement-command';
import { fiscalSnapshotSha256 } from '@factuez/sunat-core/dist/fiscal-note';
import { PrismaService } from '../infrastructure/prisma.service';
import { BetaSupplementService } from './beta-supplement.service';
import { assertOfficialFiscalActivation } from './fiscal-readiness.service';

/** Dedicated Billing -> SUNAT channel. Never consumes invoice-v1 or QA events.
 * Both this consumer and stage() keep the official activation guard closed.
 */
@Injectable()
export class BetaSupplementCommandConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private worker?: Worker;
  private stopping = false;
  constructor(private readonly prisma: PrismaService, private readonly supplements: BetaSupplementService) {}
  onApplicationBootstrap() {
    if (this.worker || this.stopping || process.env.SUNAT_BETA_WORKFLOW_ENABLED !== 'true') return;
    try { assertOfficialFiscalActivation(); } catch { return; }
    const worker = new Worker(QueueNames.betaSupplementRequests, job => this.process(job), { connection: redisConnection(), concurrency: 1 });
    this.worker = worker; worker.on('error', () => {});
  }
  async process(job: Pick<Job, 'name' | 'id' | 'data'>): Promise<void> {
    try {
      if (this.stopping || job.name !== EventNames.betaSupplementRequested) throw new Error();
      const command = validateFiscalSupplementCommand(job.data);
      if (job.id !== command.eventId) throw new Error();
      assertOfficialFiscalActivation(); // Before DB, artifacts, certificate or stage().
      const submissionId = await this.supplements.stage(command.payload.envelope, command.eventId, command.correlationId);
      await this.prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`beta-supplement-command:${command.eventId}`},0))`;
        const own = await tx.sunatSubmission.findUnique({ where: { id: submissionId },
          select: { id: true, idempotencyKey: true, errorMessage: true, documentId: true, batchId: true } });
        if (!own || own.idempotencyKey !== `beta-supplement:${command.payload.operationId.toLowerCase()}:v1`) throw new Error();
        const meta = JSON.parse(own.errorMessage ?? 'null');
        if (!meta || meta.version !== 1 || meta.kind !== 'BETA_SUPPLEMENT' || meta.eventId !== command.eventId ||
            meta.correlationId !== command.correlationId || meta.envelopeSha256 !== command.payload.envelopeSha256 ||
            fiscalSnapshotSha256(meta.envelope) !== command.payload.envelopeSha256 ||
            (command.payload.operationKind === 'NOTE' ? own.documentId !== command.payload.operationId || own.batchId !== null : own.documentId !== null || !own.batchId)) throw new Error();
        const inbox = await tx.inboxEvent.findUnique({ where: { eventId: command.eventId }, select: { eventType: true } });
        if (inbox) { if (inbox.eventType !== command.eventName) throw new Error(); }
        else await tx.inboxEvent.create({ data: { eventId: command.eventId, eventType: command.eventName } });
      }, { isolationLevel: 'Serializable' });
    } catch { throw new Error('Comando BETA no procesado; revisar autorización y reserva'); }
  }
  async onModuleDestroy() { this.stopping = true; await this.worker?.close(); }
}
