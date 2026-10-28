import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { redisConnection } from '@factuez/service-access';
import { PRODUCTION_NOTES_REQUEST_QUEUE, PRODUCTION_NOTES_STATUS_QUEUE, type ProductionNotesAnyIssued as ProductionNotesIssued } from '@factuez/contracts';
import { PrismaService } from '../infrastructure/prisma.service';
import { ProductionNotesDispatchRepository } from './production-notes-dispatch.repository';
import { ProductionNotesDispatchService } from './production-notes-dispatch.service';
import { productionNotesEnabled } from './production-notes-policy.service';
@Injectable()
export class ProductionNotesSunatRuntime implements OnApplicationBootstrap, OnModuleDestroy {
    private worker?: Worker;
    private queue?: Queue;
    private timer?: NodeJS.Timeout;
    private active?: Promise<void>;
    private closing = false;
    constructor(private readonly prisma: PrismaService, private readonly repository: ProductionNotesDispatchRepository, private readonly dispatch: ProductionNotesDispatchService) { }
    async ingest(event: ProductionNotesIssued) { await this.repository.stage(event); }
    async flush() {
        if (this.closing || !this.queue)
            return;
        await this.repository.recover();
        for (const row of await this.repository.due()) {
            if (this.closing)
                return;
            try {
                await this.dispatch.process(row.documentId);
            }
            catch { /* Durable authorization/preparation remains pending, no network-error dump. */ }
        }
        const rows = await this.prisma.$queryRawUnsafe<{
            id: string;
            payload: unknown;
        }[]>('SELECT "id","payload" FROM "ProductionNotesStatusOutbox" WHERE "publishedAt" IS NULL ORDER BY "createdAt" LIMIT 30');
        for (const row of rows) {
            if (this.closing)
                return;
            await this.queue.add('production-note-status', row.payload, { jobId: row.id, attempts: 10, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: { age: 86400 }, removeOnFail: { age: 604800 } });
            await this.prisma.$executeRawUnsafe('UPDATE "ProductionNotesStatusOutbox" SET "publishedAt"=now() WHERE "id"=$1::uuid', row.id);
        }
    }
    onApplicationBootstrap() {
        if (!productionNotesEnabled())
            return;
        this.queue = new Queue(PRODUCTION_NOTES_STATUS_QUEUE, { connection: redisConnection() });
        this.queue.on('error', () => { });
        this.worker = new Worker(PRODUCTION_NOTES_REQUEST_QUEUE, job => this.ingest(job.data), { connection: redisConnection(), concurrency: 1 });
        this.worker.on('error', () => { });
        this.timer = setInterval(() => { if (this.closing || this.active)
            return; this.active = this.flush().catch(() => { }).finally(() => { this.active = undefined; }); }, 1000);
    }
    async onModuleDestroy() { this.closing = true; if (this.timer)
        clearInterval(this.timer); await this.worker?.close(); await this.active; await this.queue?.close(); }
}
