import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { redisConnection, UUID } from '@factuez/service-access';
import { Queue, Worker } from 'bullmq';
import { CorporateMailStore } from './corporate-mail.store';
import { CorporateMailService } from './corporate-mail.service';
import { CorporateMailHealth } from './corporate-mail.health';
import { corporateSmtpEnabled } from './corporate-mail.policy';
export const CORPORATE_TEST_QUEUE = 'mail-corporate-test-v1';
@Injectable()
export class CorporateMailWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private queue?: Queue;
  private worker?: Worker;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private dispatching?: Promise<void>;
  constructor(private readonly store: CorporateMailStore, private readonly service: CorporateMailService, private readonly health: CorporateMailHealth) {}
  onApplicationBootstrap() {
    if (this.timer || this.stopped) return;
    // DB-only cleanup is also allowed while sending is disabled. No startup SMTP, verify, or automatic test.
    this.timer = setInterval(() => { void this.dispatch(); }, 2000);
    this.timer.unref();
    void this.dispatch();
  }
  private startQueue() {
    if (this.queue || this.stopped || !corporateSmtpEnabled()) return;
    this.queue = new Queue(CORPORATE_TEST_QUEUE, { connection: { ...redisConnection(), connectTimeout: 3000, commandTimeout: 5000, maxRetriesPerRequest: 1, enableOfflineQueue: false } });
    this.queue.on('error', () => { this.health.queueReady = false; });
    void this.queue.waitUntilReady().then(() => { if (!this.stopped) this.health.queueReady = true; }, () => {});
    this.worker = new Worker(CORPORATE_TEST_QUEUE, async job => {
      if (job.name !== 'send-test' || !job.data || Object.keys(job.data).join(',') !== 'id' || !UUID.test(job.data.id)) return;
      try { await this.service.process(job.data.id); } catch { throw new Error('CORPORATE_TEST_WORKER_UNAVAILABLE'); }
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
      if (this.stopped || !corporateSmtpEnabled()) return;
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
        if (this.stopped || !corporateSmtpEnabled()) break;
        await this.queue.add('send-test', { id: job.id }, { jobId: job.id, attempts: 1, removeOnComplete: 100, removeOnFail: true });
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
