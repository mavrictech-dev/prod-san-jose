import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { LIVE_QUEUE, redisConnection, UUID } from '@factuez/service-access';
export class ReceivedLivePublisher {
  private queue?: Queue;
  async changed(receivedDocumentId: string) {
    if (process.env.WORKSPACE_LIVE_ENABLED !== 'true' || !UUID.test(receivedDocumentId)) return;
    try {
      if (!this.queue) { this.queue = new Queue(LIVE_QUEUE, { connection: { ...redisConnection(), maxRetriesPerRequest: 1, connectTimeout: 2000 } }); this.queue.on('error', () => {}); }
      let timer: NodeJS.Timeout | undefined;
      try { await Promise.race([this.queue.add('received.changed.v1', { receivedDocumentId }, { jobId: randomUUID(), attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 100, removeOnFail: 100 }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error()), 2500); })]); }
      finally { if (timer) clearTimeout(timer); }
    } catch { /* Best effort; DB + REST polling remain authoritative. */ }
  }
  async close() { await this.queue?.close(); }
}
