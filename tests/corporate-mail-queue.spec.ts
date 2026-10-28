import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const queues = vi.hoisted(() => ({ queues: [] as any[], workers: [] as any[], process: undefined as any }));
vi.mock('../services/mailer-worker/node_modules/bullmq', () => ({
  Queue: class extends EventEmitter {
    client = Promise.resolve({ status: 'ready' }); add = vi.fn().mockResolvedValue(undefined); close = vi.fn().mockResolvedValue(undefined);
    waitUntilReady = vi.fn().mockResolvedValue(undefined);
    constructor(public name: string, public options: any) { super(); queues.queues.push(this); }
  },
  Worker: class extends EventEmitter {
    client = Promise.resolve({ status: 'ready' }); close = vi.fn().mockResolvedValue(undefined);
    constructor(public name: string, process: any, public options: any) { super(); queues.workers.push(this); queues.process = process; }
  },
}));
import { CorporateMailWorker, CORPORATE_TEST_QUEUE } from '../services/mailer-worker/src/corporate-mail.worker';
import { CorporateMailHealth } from '../services/mailer-worker/src/corporate-mail.health';
beforeEach(() => { queues.queues.length = 0; queues.workers.length = 0; queues.process = undefined; vi.stubEnv('SERVER_SMTP_ENABLED', 'true'); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function fixture() {
  const job = { id: randomUUID() };
  const store = { ready: vi.fn().mockResolvedValue(true), expire: vi.fn().mockResolvedValue(undefined), pending: vi.fn().mockResolvedValue([job]) };
  const service = { process: vi.fn().mockResolvedValue(undefined) }, health = new CorporateMailHealth();
  return { store, service, health, job, worker: new CorporateMailWorker(store as never, service as never, health) };
}
describe('BullMQ runtime PWA separado del dispatcher B2B', () => {
  it('arranca opt-in, máximo dos, sólo IDs de tarea en Redis, no retries de SMTP', async () => {
    const f = fixture(); await f.worker.dispatch();
    expect(queues.workers[0].options).toMatchObject({ concurrency: 2, lockDuration: 60000 });
    expect(queues.queues[0].name).toBe(CORPORATE_TEST_QUEUE);
    expect(queues.queues[0].add).toHaveBeenCalledWith('send-test', { id: f.job.id }, { jobId: f.job.id, attempts: 1, removeOnComplete: 100, removeOnFail: true });
    expect(JSON.stringify(queues.queues[0].add.mock.calls)).not.toMatch(/recipient|authorization|password|attachments|Bearer/);
    expect(f.service.process).not.toHaveBeenCalled();
    await queues.process({ name: 'send-test', data: { id: f.job.id } }); expect(f.service.process).toHaveBeenCalledWith(f.job.id);
    await f.worker.onModuleDestroy(); expect(queues.workers[0].close).toHaveBeenCalledOnce(); expect(queues.queues[0].close).toHaveBeenCalledOnce(); expect(f.health.ready).toBe(false);
  });
  it('flag deshabilitado sólo permite limpieza DB; nunca crea cola/worker ni envío de arranque', async () => {
    vi.stubEnv('SERVER_SMTP_ENABLED', 'false'); const f = fixture(); await f.worker.dispatch();
    expect(queues.queues).toHaveLength(0); expect(f.store.expire).toHaveBeenCalledOnce(); expect(f.service.process).not.toHaveBeenCalled(); await f.worker.onModuleDestroy();
  });
  it('sin tablas no arranca ni intenta instalaciones automáticas', async () => {
    const f = fixture(); f.store.ready.mockResolvedValue(false); await f.worker.dispatch(); expect(queues.queues).toHaveLength(0); expect(f.store.expire).not.toHaveBeenCalled(); await f.worker.onModuleDestroy();
  });
  it('sanea fallo interno y rechaza payloads Redis con destinatarios o campos ajenos', async () => {
    const f = fixture(); await f.worker.dispatch(); f.service.process.mockRejectedValue(new Error('PRIVATE recipient@example.invalid Bearer raw'));
    await expect(queues.process({ name: 'send-test', data: { id: f.job.id } })).rejects.toThrow('CORPORATE_TEST_WORKER_UNAVAILABLE');
    f.service.process.mockClear();
    for (const job of [{ name: 'other', data: { id: f.job.id } }, { name: 'send-test', data: { id: f.job.id, recipient: 'x@example.invalid' } }, { name: 'send-test', data: { id: '../wrong' } }]) await queues.process(job);
    expect(f.service.process).not.toHaveBeenCalled();
    queues.queues[0].emit('error', Error('PRIVATE')); queues.workers[0].emit('error', Error('PRIVATE')); expect(f.health.ready).toBe(false);
    await f.worker.onModuleDestroy();
  });
  it('despacho recupera outbox DB después de fallo de Redis sin cambiar la tarea', async () => {
    const f = fixture(); await f.worker.dispatch(); queues.queues[0].add.mockRejectedValueOnce(Error('PRIVATE'));
    await f.worker.dispatch(); await f.worker.dispatch(); expect(queues.queues[0].add).toHaveBeenCalledTimes(3);
    expect(queues.queues[0].add.mock.calls.every((call: any) => JSON.stringify(call[1]) === JSON.stringify({ id: f.job.id }))).toBe(true);
    await f.worker.onModuleDestroy();
  });
});
