import { readFileSync } from 'node:fs';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { EventNames, QueueNames } from '@factuez/contracts';
import { PrismaService } from './prisma.service';
import { LivePublisher } from '@factuez/service-access';

function redisConnection() {
  const passwordFile = process.env.REDIS_PASSWORD_FILE;
  return {
    host: process.env.REDIS_HOST ?? 'redis',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: passwordFile ? readFileSync(passwordFile, 'utf8').trim() : undefined,
  };
}

@Injectable()
export class OutboxPublisher implements OnModuleDestroy {
  private readonly queue = new Queue(QueueNames.sunatSubmissions, { connection: redisConnection() });
  private supplementQueue?: Queue;
  private running = false;
  private stopped = false;
  private active?: Promise<void>;
  private closing?: Promise<void>;
  private readonly live = new LivePublisher();

  constructor(private readonly prisma: PrismaService) {}

  @Interval(1_000)
  flush(): Promise<void> {
    if(this.stopped)return Promise.resolve();if(this.active)return this.active;
    const pending=this.flushBatch();this.active=pending;void pending.then(()=>{if(this.active===pending)this.active=undefined;},()=>{if(this.active===pending)this.active=undefined;});return pending;
  }
  private async flushBatch() {
    if (this.running) return;
    this.running = true;
    try {
      const events = await this.prisma.outboxEvent.findMany({ where: { publishedAt: null }, orderBy: { occurredAt: 'asc' }, take: 50 });
      for (const event of events) {
        if(this.stopped)break;
        if (![EventNames.documentIssued, EventNames.betaSupplementRequested].includes(event.eventType as typeof EventNames.documentIssued))
          throw new Error('Contrato Outbox de Billing no soportado');
        if (event.eventType === EventNames.betaSupplementRequested && !this.supplementQueue) {
          this.supplementQueue = new Queue(QueueNames.betaSupplementRequests, { connection: redisConnection() });
          this.supplementQueue.on('error', () => {});
        }
        const queue = event.eventType === EventNames.betaSupplementRequested ? this.supplementQueue! : this.queue;
        await queue.add(event.eventType, event.payload, {
          jobId: event.id,
          attempts: 8,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: { age: 86_400 },
          removeOnFail: { age: 604_800 },
        });
        await this.prisma.outboxEvent.update({ where: { id: event.id }, data: { publishedAt: new Date(), attempts: { increment: 1 } } });
        const envelope = event.payload as { payload?: { documentId?: string } };
        if (envelope.payload?.documentId) await this.live.changed(envelope.payload.documentId);
      }
    } finally {
      this.running = false;
    }
  }

  close():Promise<void> {
    if(this.closing)return this.closing;this.stopped=true;
    this.closing=(async()=>{
      let failed=false;try{await this.active;}catch{failed=true;}
      for(const close of [()=>this.queue.close(),()=>this.supplementQueue?.close(),()=>this.live.close()])try{await close();}catch{failed=true;}
      if(failed)throw Error('BILLING_OUTBOX_CLOSE_FAILED');
    })();return this.closing;
  }
  onModuleDestroy(){return this.close();}
}
