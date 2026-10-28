import { productionReceivedWorkerHealth } from './automation/production-received-health';
import 'reflect-metadata';
import http from 'node:http';
import { Queue, Worker } from 'bullmq';
import { AccessError, redisConnection, UUID } from '@factuez/service-access';
import { ReceptionPrisma } from './prisma.service';
import { createSyncRun } from './automation/service';
import { NativeReceptionScheduler, nativeReceptionCloseOnce } from './automation/scheduler';
import { RECEIVED_SYNC_QUEUE } from './automation/policy';
import { ReceptionSyncProcessor } from './automation/processor';
import { ReceivedLivePublisher } from './automation/live';

async function main() {
  const db = new ReceptionPrisma(); await db.$connect();
  const live = new ReceivedLivePublisher(), processor = new ReceptionSyncProcessor(db, id => live.changed(id));
  const queue = new Queue(RECEIVED_SYNC_QUEUE, { connection: { ...redisConnection(), maxRetriesPerRequest: 1, connectTimeout: 3000 } });
  queue.on('error', () => {});
  const worker = new Worker(RECEIVED_SYNC_QUEUE, async job => {
    if (!UUID.test(job.data?.runId ?? '') || job.name !== 'received.sync.v1') return;
    try { await processor.run(job.data.runId); }
    catch (error) {
      const blocked = error instanceof AccessError && [400, 403, 409].includes(error.status);
      if (blocked || job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) await db.receptionSyncRun.updateMany({ where: { id: job.data.runId, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: blocked ? 'BLOCKED' : 'FAILED', activeKey: null, finishedAt: new Date(), errorCode: blocked ? 'CONNECTION_OR_SCOPE_CHANGED' : 'CONNECTOR_UNAVAILABLE' } });
      // Do not let BullMQ serialize upstream error bodies/URLs/credentials into Redis.
      if (!blocked) throw new Error('RECEPTION_CONNECTOR_UNAVAILABLE');
    }
  }, { connection: redisConnection(), concurrency: 1, lockDuration: 120000 });
  worker.on('error', () => {});
  const scheduler = new NativeReceptionScheduler(db, async runId => {
    const existing=await queue.getJob(runId);
    if(existing && ['completed','failed'].includes(await existing.getState())) await existing.remove();
    await queue.add('received.sync.v1', {runId}, {jobId:runId,attempts:3,backoff:{type:'exponential',delay:3000},removeOnComplete:500,removeOnFail:500});
  });
  const health = http.createServer((req, res) => {
    const state=productionReceivedWorkerHealth(scheduler.lastTick),ok=req.url==='/health'&&state.schedulerHealthy;
    res.writeHead(ok?200:503,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({...state,status:ok?'ok':'unavailable'}));
  });
  let stopping = false, healthStarting: Promise<void> | undefined;
  const stop = nativeReceptionCloseOnce({ scheduler, closeWorker: () => worker.close(), closeQueue: () => queue.close(), closeLive: () => live.close(),
    closeHealth: async () => { await healthStarting?.catch(() => {}); await new Promise<void>((resolve, reject) => { if (!health.listening) return resolve(); health.close(error => error ? reject(error) : resolve()); }); },
    closeDatabase: () => db.$disconnect(),
  });
  const shutdown = () => { stopping = true; void stop().catch(() => { process.stderr.write('Recepción: cierre incompleto\n'); process.exitCode = 1; }); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  try { await scheduler.start(); if (stopping) { await stop(); return; } healthStarting = new Promise<void>((resolve, reject) => { health.once('error', reject); health.listen(3007, '0.0.0.0', resolve); }); await healthStarting; }
  catch { await stop(); throw new Error('RECEPTION_WORKER_START_BLOCKED'); }
}
if (require.main === module) void main().catch(() => { process.stderr.write('Recepción automática no disponible\n'); process.exitCode = 1; });
