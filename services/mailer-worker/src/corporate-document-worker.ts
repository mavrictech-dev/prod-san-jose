import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { redisConnection, UUID } from '@factuez/service-access';
import { Queue, Worker } from 'bullmq';
import { CorporateDocumentStore } from './corporate-document-store';
import { CorporateDocumentService } from './corporate-document-service';
import { CorporateDocumentHealth } from './corporate-document-health';
import { documentSmtpEnabled } from './corporate-document-policy';
export const CORPORATE_DOCUMENT_QUEUE = 'mail-corporate-document-v1';
@Injectable()
export class CorporateDocumentWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private queue?: Queue;
  private worker?: Worker;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private dispatching?: Promise<void>;
  constructor(private readonly store: CorporateDocumentStore, private readonly service: CorporateDocumentService, private readonly health: CorporateDocumentHealth) {}
  onApplicationBootstrap() {
    if (this.timer || this.stopped) return;
    // DB-only cleanup is also allowed while sending is disabled. No startup SMTP, verify, or automatic test.
    this.timer = setInterval(() => { void this.dispatch(); }, 2000);
    this.timer.unref();
    void this.dispatch();
  }
  private startQueue() {
    if (this.queue || this.stopped || !documentSmtpEnabled()) return;
    this.queue = new Queue(CORPORATE_DOCUMENT_QUEUE, { connection: { ...redisConnection(), connectTimeout: 3000, commandTimeout: 5000, maxRetriesPerRequest: 1, enableOfflineQueue: false } });
    this.queue.on('error', () => { this.health.queueReady = false; });
    void this.queue.waitUntilReady().then(() => { if (!this.stopped) this.health.queueReady = true; }, () => {});
    this.worker = new Worker(CORPORATE_DOCUMENT_QUEUE, async job => {
      if (job.name !== 'send-document' || !job.data || Object.keys(job.data).join(',') !== 'id' || !UUID.test(job.data.id)) return;
      try { await this.service.process(job.data.id); } catch { throw new Error('CORPORATE_DOCUMENT_WORKER_UNAVAILABLE'); }
    }, { connection: redisConnection(), concurrency: 2, lockDuration: 60000 });
    this.worker.on('ready', () => { if (!this.stopped) this.health.workerReady = true; });
    this.worker.on('error', () => { this.health.workerReady = false; });
    this.worker.on('closed', () => { this.health.workerReady = false; });
  }
  dispatch(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.dispatching ??= this.batch().finally(() => { this.dispatching = undefined; });
  }
  private async batch() {
    try {
      if (!await this.store.ready()) return;
      await this.store.expire();
      if (this.stopped || !documentSmtpEnabled()) return;
      this.startQueue();
      if (!this.queue || !this.worker) return;
      // An unavailable Redis must not block DB expiry cleanup or application shutdown indefinitely.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const clients = await Promise.race([
        Promise.all([this.queue.client, this.worker.client]),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1000); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (!clients || this.stopped) return;
      const [queueClient, workerClient] = clients;
      this.health.queueReady = queueClient.status === 'ready'; this.health.workerReady = workerClient.status === 'ready';
      if (!this.health.ready) return;
      for (const job of await this.store.pending()) {
        if (this.stopped || !documentSmtpEnabled()) break;
        await this.queue.add('send-document', { id: job.id }, { jobId: job.id, attempts: 1, removeOnComplete: 100, removeOnFail: true });
      }
    } catch { /* Durable DB outbox is authoritative; no secrets or raw errors in queue/logs. */ }
  }
  async onModuleDestroy() {
    this.stopped = true;
    this.health.queueReady = false; this.health.workerReady = false;
    if (this.timer) clearInterval(this.timer);
    await this.dispatching;
    try { await this.worker?.close(); } finally { await this.queue?.close(); }
  }
}
