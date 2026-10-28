import { readFileSync } from 'node:fs';
import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { QueueNames } from '@factuez/contracts';
import { PrismaService } from './prisma.service';

@Injectable()
export class StatusOutboxPublisher implements OnApplicationBootstrap, OnModuleDestroy {
  private evidenceQueue?: Queue;
  private readonly queue = new Queue(QueueNames.billingStatusUpdates, { connection: {
    host: process.env.REDIS_HOST ?? 'redis', port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD_FILE ? readFileSync(process.env.REDIS_PASSWORD_FILE, 'utf8').trim() : undefined,
  }});
  private timer?: NodeJS.Timeout;
  private stopped=false;private active?:Promise<void>;private closing?:Promise<void>;
  constructor(private readonly prisma: PrismaService) {}
  onApplicationBootstrap() { if(this.stopped||this.timer)throw Error('STATUS_PUBLISHER_NOT_STARTABLE');this.timer = setInterval(() => {void this.flush().catch(()=>{});}, 1_000); }
  flush():Promise<void> {
    if(this.stopped)return Promise.resolve();if(this.active)return this.active;
    const pending=this.flushBatch();this.active=pending;void pending.then(()=>{if(this.active===pending)this.active=undefined;},()=>{if(this.active===pending)this.active=undefined;});return pending;
  }
  private async flushBatch() {
    const events = await this.prisma.outboxEvent.findMany({ where: { publishedAt: null }, orderBy: { occurredAt: 'asc' }, take: 50 });
    for (const event of events) {
      if(this.stopped)break;
      // No enviar un contrato de lote/nota a la cola que sólo consume estados
      // Billing v1. Cada consumidor mantiene su contrato/versionado propio.
      if (event.eventType === 'sunat.beta.supplement.evidence.v1' && !this.evidenceQueue) {
        this.evidenceQueue = new Queue('sunat-beta-supplement-evidence-v1', { connection: {
          host: process.env.REDIS_HOST ?? 'redis', port: Number(process.env.REDIS_PORT ?? 6379),
          password: process.env.REDIS_PASSWORD_FILE ? readFileSync(process.env.REDIS_PASSWORD_FILE, 'utf8').trim() : undefined,
        } });
        this.evidenceQueue.on('error', () => {});
      }
      const queue = event.eventType === 'sunat.beta.supplement.evidence.v1' ? this.evidenceQueue! : this.queue;
      await queue.add(event.eventType, event.payload, { jobId: event.id, attempts: 10, backoff: { type: 'exponential', delay: 1_000 } });
      await this.prisma.outboxEvent.update({ where: { id: event.id }, data: { publishedAt: new Date(), attempts: { increment: 1 } } });
    }
  }
  close():Promise<void>{
    if(this.closing)return this.closing;this.stopped=true;if(this.timer)clearInterval(this.timer);
    this.closing=(async()=>{let failed=false;try{await this.active;}catch{failed=true;}
      for(const close of [()=>this.queue.close(),()=>this.evidenceQueue?.close()])try{await close();}catch{failed=true;}
      if(failed)throw Error('SUNAT_STATUS_OUTBOX_CLOSE_FAILED');})();return this.closing;
  }
  onModuleDestroy(){return this.close();}
}
