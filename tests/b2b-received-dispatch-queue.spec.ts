import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  B2B_RECEIVED_DISPATCH_JOB, B2B_RECEIVED_DISPATCH_QUEUE, B2B_RECEIVED_READ_ONLY_JOB, B2B_RECEIVED_READ_ONLY_QUEUE, createB2bReceivedDispatchQueue,
  type B2bReceivedDispatchFactories, type B2bReceivedDispatchOptions,
  type B2bReceivedDispatchProcessor, type B2bReceivedDispatchTransport, type B2bReceivedDispatchQueueClient,
} from '../services/received-documents-service/src/b2b/automation-dispatch-queue';

const runId = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';
const secret = 'SYNTHETIC_PRIVATE_password_token_actor';
const connection = { host: 'explicit.invalid', port: 6379, password: secret };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  let process!: B2bReceivedDispatchProcessor;
  const queue = { add: vi.fn<B2bReceivedDispatchQueueClient['add']>(async () => undefined), on: vi.fn(), close: vi.fn(async () => {}) };
  const worker = { on: vi.fn(), close: vi.fn(async () => {}) };
  const ports = { run: vi.fn(async (_id: string): Promise<unknown> => undefined), pending: vi.fn(async (_limit: number): Promise<string[]> => []) };
  const factories = {
    queue: vi.fn<B2bReceivedDispatchFactories['queue']>(() => queue),
    worker: vi.fn<B2bReceivedDispatchFactories['worker']>((_name, processor) => { process = processor; return worker; }),
  };
  return { queue, worker, ports, factories, process: (data: unknown, name = B2B_RECEIVED_DISPATCH_JOB) => process({ name, data }) };
}
const transports: B2bReceivedDispatchTransport[] = [];
async function start(f: ReturnType<typeof fixture>, options: B2bReceivedDispatchOptions = {}) {
  const transport = await createB2bReceivedDispatchQueue(connection, f.ports, { enabled: true, factories: f.factories, ...options });
  transports.push(transport);
  return transport;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => {
  await Promise.allSettled(transports.splice(0).map(transport => transport.close()));
  const timers = vi.getTimerCount();
  vi.useRealTimers();
  vi.restoreAllMocks();
  expect(timers).toBe(0);
});

describe('opt-in B2B LOCAL received dispatch transport (injected factories, no Redis)', () => {
  it('uses a separate queue and job name for READ_ONLY and rejects a LOCAL job on that consumer',async()=>{
    const f=fixture(),transport=await start(f,{profile:'LIVE_READ_ONLY'});
    expect(f.factories.queue).toHaveBeenCalledWith(B2B_RECEIVED_READ_ONLY_QUEUE,expect.any(Object));
    expect(f.factories.worker).toHaveBeenCalledWith(B2B_RECEIVED_READ_ONLY_QUEUE,expect.any(Function),expect.any(Object));
    await transport.enqueue(runId);expect(f.queue.add).toHaveBeenCalledWith(B2B_RECEIVED_READ_ONLY_JOB,{runId},expect.objectContaining({jobId:runId}));
    await expect(f.process({runId},B2B_RECEIVED_DISPATCH_JOB)).rejects.toThrow('B2B_RECEIVED_DISPATCH_INVALID_JOB');
    await f.process({runId},B2B_RECEIVED_READ_ONLY_JOB);expect(f.ports.run).toHaveBeenCalledExactlyOnceWith(runId);
  });
  it('imports without execution and stays disabled by default or explicit false', async () => {
    const f = fixture();
    for (const options of [{ factories: f.factories }, { enabled: false, factories: f.factories }]) {
      const transport = await createB2bReceivedDispatchQueue(connection, f.ports, options);
      expect(transport.enabled).toBe(false);
      expect(await transport.enqueue(runId)).toBe(false);
      await transport.poll();
      await transport.close();
    }
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.factories.queue).not.toHaveBeenCalled();
    expect(f.factories.worker).not.toHaveBeenCalled();
    expect(f.ports.run).not.toHaveBeenCalled();
    expect(f.ports.pending).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses an exclusive queue/job, explicit bounded connections and concurrency one', async () => {
    const f = fixture();
    const transport = await start(f);
    expect(transport.enabled).toBe(true);
    expect(f.factories.queue).toHaveBeenCalledWith('b2b-received-dispatch-v1', expect.any(Object));
    expect(f.factories.worker).toHaveBeenCalledWith(B2B_RECEIVED_DISPATCH_QUEUE, expect.any(Function), expect.objectContaining({ concurrency: 1, maxStartedAttempts: 3, maxStalledCount: 1 }));
    const producer = f.factories.queue.mock.calls[0][1].connection as any;
    const consumer = f.factories.worker.mock.calls[0][2].connection as any;
    for (const config of [producer, consumer]) {
      expect(config).toMatchObject({ ...connection, connectTimeout: 3000, enableOfflineQueue: false, autoResendUnfulfilledCommands: false });
      expect(config.retryStrategy(1)).toBe(250);
      expect(config.retryStrategy(3)).toBe(750);
      expect(config.retryStrategy(4)).toBeNull();
      expect(config.reconnectOnError()).toBe(false);
    }
    expect(producer.maxRetriesPerRequest).toBe(1);
    expect(consumer.maxRetriesPerRequest).toBeNull();
    expect(connection).toEqual({ host: 'explicit.invalid', port: 6379, password: secret });
    await transport.enqueue(runId);
    expect(f.queue.add).toHaveBeenCalledExactlyOnceWith('b2b.received.dispatch.v1', { runId }, {
      jobId: runId, attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: true, removeOnFail: true,
    });
    expect(JSON.stringify(f.queue.add.mock.calls)).not.toContain(secret);
  });

  it('passes only runId to the owner and discards sensitive return values', async () => {
    const f = fixture();
    await start(f);
    f.ports.run.mockResolvedValue({ credentials: secret, actor: secret });
    expect(await f.process({ runId })).toBeUndefined();
    expect(f.ports.run).toHaveBeenCalledExactlyOnceWith(runId);
  });

  it.each([null, [], {}, { runId: 'bad' }, { runId, credentials: secret }, { runId, actor: secret },
    { runId, nested: { token: secret } }, { runId, [Symbol('hidden')]: secret },
    Object.assign(Object.create({ actor: secret }), { runId }),
  ])('rejects bad payload %# without owner execution or retry', async data => {
    const f = fixture();
    await start(f);
    const error = await f.process(data).catch(error => error);
    expect(error).toMatchObject({ name: 'UnrecoverableError', message: 'B2B_RECEIVED_DISPATCH_INVALID_JOB' });
    expect(String(error)).not.toContain(secret);
    expect(f.ports.run).not.toHaveBeenCalled();
    expect(f.queue.add).not.toHaveBeenCalled();
  });

  it('rejects getters, hostile proxies, non-enumerable extras and foreign job names', async () => {
    const f = fixture();
    await start(f);
    const getter = vi.fn(() => { throw new Error(secret); });
    const payload = Object.defineProperty({}, 'runId', { get: getter });
    const extra = Object.defineProperty({ runId }, 'token', { value: secret });
    const proxy = new Proxy({}, { ownKeys() { throw new Error(secret); } });
    for (const data of [payload, extra, proxy]) await expect(f.process(data)).rejects.toThrow('B2B_RECEIVED_DISPATCH_INVALID_JOB');
    await expect(f.process({ runId }, 'received.sync.v1')).rejects.toThrow('B2B_RECEIVED_DISPATCH_INVALID_JOB');
    expect(getter).not.toHaveBeenCalled();
    expect(f.ports.run).not.toHaveBeenCalled();
  });

  it('never logs secrets or places upstream errors/results in retry payloads', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fixture();
    const transport = await start(f);
    const upstream = Object.assign(new Error(secret), { cause: secret, credentials: secret });
    f.ports.run.mockRejectedValue(upstream);
    await transport.enqueue(runId);
    for (let attempt = 0; attempt < 3; attempt++) {
      const error = await f.process({ runId }).catch(error => error);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('B2B_RECEIVED_DISPATCH_RUN_FAILED');
      expect(error.cause).toBeUndefined();
      expect(error.stack).not.toContain(secret);
    }
    f.queue.on.mock.calls[0][1](upstream);
    f.worker.on.mock.calls[0][1](upstream);
    expect(f.queue.add).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.queue.add.mock.calls)).not.toContain(secret);
    expect(log).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('sanitizes producer/pending failures and recovers on the next periodic poll', async () => {
    const f = fixture();
    const transport = await start(f, { batchSize: 2, pollIntervalMs: 1000 });
    f.queue.add.mockRejectedValueOnce(new Error(secret));
    await expect(transport.enqueue(runId)).rejects.toThrow('B2B_RECEIVED_DISPATCH_ENQUEUE_FAILED');
    f.ports.pending.mockRejectedValueOnce(new Error(secret)).mockResolvedValue([runId, otherId]);
    await expect(transport.poll()).rejects.toThrow('B2B_RECEIVED_DISPATCH_POLL_FAILED');
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.ports.pending).toHaveBeenNthCalledWith(2, 2);
    expect(f.queue.add.mock.calls.slice(1).map(call => call[1])).toEqual([{ runId }, { runId: otherId }]);
    expect(f.ports.run).not.toHaveBeenCalled();
  });

  it('handles background rejection without an unhandled promise and schedules recovery', async () => {
    const f = fixture();
    await start(f, { pollIntervalMs: 1000 });
    f.ports.pending.mockRejectedValueOnce(new Error(secret)).mockResolvedValue([runId]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.ports.pending).toHaveBeenCalledTimes(2);
    expect(f.queue.add).toHaveBeenCalledTimes(1);
  });

  it.each([[runId, 'invalid'], [runId, otherId, runId], [runId, { token: secret }]].map(ids => ({ ids })))('validates the entire bounded pending batch before enqueuing %#', async ({ ids }) => {
    const f = fixture();
    const transport = await start(f, { batchSize: 2 });
    f.ports.pending.mockResolvedValue(ids as string[]);
    await expect(transport.poll()).rejects.toThrow('B2B_RECEIVED_DISPATCH_POLL_FAILED');
    expect(f.queue.add).not.toHaveBeenCalled();
  });

  it('deduplicates each recovery batch and requests terminal cleanup on every delivery', async () => {
    const f = fixture();
    const transport = await start(f);
    f.ports.pending.mockResolvedValue([runId, runId]);
    await transport.poll();
    await transport.poll();
    expect(f.queue.add).toHaveBeenCalledTimes(2);
    for (const call of f.queue.add.mock.calls) expect(call[2]).toMatchObject({ jobId: runId, attempts: 3, removeOnComplete: true, removeOnFail: true });
  });

  it.each(['BUSY', 'SERIALIZATION_CONFLICT', 'PG_DOWN'] as const)('redelivers durable PG QUEUED after %s and Redis terminal cleanup', async outcome => {
    const f = fixture();
    const transport = await start(f, { pollIntervalMs: 1000 });
    type Options = Parameters<B2bReceivedDispatchQueueClient['add']>[2];
    const redisJobs = new Map<string, { data: { runId: string }; options: Options }>();
    let created = 0;
    let pgQueued = true;
    f.ports.pending.mockImplementation(async () => pgQueued ? [runId] : []);
    f.queue.add.mockImplementation(async (_name, data, options) => {
      const id = options.jobId!;
      if (!redisJobs.has(id)) {
        redisJobs.set(id, { data, options });
        created++;
      }
    });
    if (outcome === 'BUSY') f.ports.run.mockResolvedValue('BUSY');
    else f.ports.run.mockRejectedValue(new Error(`${outcome}:${secret}`));

    await transport.poll();
    const first = redisJobs.get(runId)!;
    expect(first).toBeDefined();
    await transport.poll();
    expect(created).toBe(1); // Same jobId suppresses another waiting/active delivery.
    expect(redisJobs.get(runId)).toBe(first);

    if (outcome === 'BUSY') {
      expect(await f.process(first.data)).toBeUndefined();
      if (first.options.removeOnComplete === true) redisJobs.delete(runId);
    } else {
      expect(first.options.attempts).toBe(3);
      for (let attempt = 0; attempt < first.options.attempts!; attempt++) {
        await expect(f.process(first.data)).rejects.toThrow('B2B_RECEIVED_DISPATCH_RUN_FAILED');
      }
      if (first.options.removeOnFail === true) redisJobs.delete(runId);
    }
    expect(pgQueued).toBe(true); // BUSY/rollback/outage has not committed a terminal PG state.
    expect(redisJobs.size).toBe(0);

    // The next periodic poll can now insert the same UUID as a fresh delivery.
    await vi.advanceTimersByTimeAsync(1000);
    const recovered = redisJobs.get(runId)!;
    expect(created).toBe(2);
    expect(recovered).toBeDefined();
    expect(recovered).not.toBe(first);
    expect(recovered.data).toEqual({ runId });
    expect(JSON.stringify([...redisJobs.values()])).not.toContain(secret);
    f.ports.run.mockImplementation(async () => { pgQueued = false; return 'COMPLETED'; });
    await f.process(recovered.data);
    if (recovered.options.removeOnComplete === true) redisJobs.delete(runId);
    await transport.poll();
    expect(redisJobs.size).toBe(0);
    expect(created).toBe(2); // Only PG pending() decides eligibility after commit.
  });

  it.each([1, 2, 3, 4, 5])('accepts UUID v%i consistently at enqueue, recovery and delivery', async version => {
    const f = fixture();
    const transport = await start(f);
    const id = `00000000-0000-${version}000-8000-000000000001`;
    await expect(transport.enqueue(id)).resolves.toBe(true);
    f.ports.pending.mockResolvedValue([id]);
    await transport.poll();
    await f.process({ runId: id });
    expect(f.queue.add).toHaveBeenCalledTimes(2);
    expect(f.ports.run).toHaveBeenCalledExactlyOnceWith(id);
  });

  it.each([0, 6, 7, 8, 9])('rejects UUID v%i consistently at enqueue, recovery and delivery', async version => {
    const f = fixture();
    const transport = await start(f);
    const id = `00000000-0000-${version}000-8000-000000000001`;
    await expect(transport.enqueue(id)).rejects.toThrow('B2B_RECEIVED_DISPATCH_INVALID_RUN_ID');
    f.ports.pending.mockResolvedValue([id]);
    await expect(transport.poll()).rejects.toThrow('B2B_RECEIVED_DISPATCH_POLL_FAILED');
    await expect(f.process({ runId: id })).rejects.toMatchObject({ name: 'UnrecoverableError', message: 'B2B_RECEIVED_DISPATCH_INVALID_JOB' });
    expect(f.queue.add).not.toHaveBeenCalled();
    expect(f.ports.run).not.toHaveBeenCalled();
  });

  it('shares manual/periodic polls without overlap, including slow queue adds', async () => {
    const f = fixture();
    const transport = await start(f, { pollIntervalMs: 1000 });
    const pending = deferred<string[]>();
    const add = deferred<undefined>();
    f.ports.pending.mockReturnValueOnce(pending.promise);
    f.queue.add.mockReturnValueOnce(add.promise);
    const first = transport.poll();
    expect(transport.poll()).toBe(first);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.ports.pending).toHaveBeenCalledTimes(1);
    pending.resolve([runId]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.poll()).toBe(first);
    expect(f.ports.pending).toHaveBeenCalledTimes(1);
    add.resolve(undefined);
    await first;
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.ports.pending).toHaveBeenCalledTimes(2);
  });

  it('close is idempotent, cancels polling and drains pending without late enqueues', async () => {
    const f = fixture();
    const transport = await start(f, { pollIntervalMs: 1000 });
    const pending = deferred<string[]>();
    f.ports.pending.mockReturnValueOnce(pending.promise);
    const poll = transport.poll();
    const close = transport.close();
    expect(transport.close()).toBe(close);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.worker.close).not.toHaveBeenCalled();
    await expect(transport.enqueue(runId)).rejects.toThrow('B2B_RECEIVED_DISPATCH_CLOSED');
    await expect(f.process({ runId })).rejects.toMatchObject({ name: 'UnrecoverableError', message: 'B2B_RECEIVED_DISPATCH_CLOSED' });
    pending.resolve([runId]);
    await poll;
    await close;
    await transport.poll();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.ports.pending).toHaveBeenCalledTimes(1);
    expect(f.queue.add).not.toHaveBeenCalled();
    expect(f.worker.close).toHaveBeenCalledTimes(1);
    expect(f.queue.close).toHaveBeenCalledTimes(1);
  });

  it('drains an in-flight add and graceful worker close before closing the queue', async () => {
    const f = fixture();
    const transport = await start(f);
    const add = deferred<undefined>();
    const workerClose = deferred<void>();
    f.queue.add.mockReturnValueOnce(add.promise);
    f.worker.close.mockReturnValueOnce(workerClose.promise);
    const enqueue = transport.enqueue(runId);
    const close = transport.close();
    await Promise.resolve();
    expect(f.worker.close).not.toHaveBeenCalled();
    add.resolve(undefined);
    await enqueue;
    await vi.advanceTimersByTimeAsync(0);
    expect(f.worker.close).toHaveBeenCalledWith();
    expect(f.queue.close).not.toHaveBeenCalled();
    workerClose.resolve();
    await close;
    expect(f.queue.close).toHaveBeenCalledTimes(1);
  });

  it('attempts both closes and sanitizes failures with no timer left', async () => {
    const f = fixture();
    const transport = await start(f);
    f.worker.close.mockRejectedValueOnce(new Error(secret));
    f.queue.close.mockRejectedValueOnce(new Error(secret));
    const close = transport.close();
    await expect(close).rejects.toThrow('B2B_RECEIVED_DISPATCH_CLOSE_FAILED');
    expect(transport.close()).toBe(close);
    expect(f.queue.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up partial startup and sanitizes factory exceptions', async () => {
    const f = fixture();
    f.factories.worker.mockImplementationOnce(() => { throw new Error(secret); });
    f.queue.close.mockRejectedValueOnce(new Error(secret));
    await expect(start(f)).rejects.toThrow('B2B_RECEIVED_DISPATCH_START_FAILED');
    expect(f.queue.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([{ batchSize: 0 }, { batchSize: 101 }, { pollIntervalMs: 0 }, { pollIntervalMs: 300001 }, { batchSize: NaN }])('rejects unbounded settings before constructing resources %#', async options => {
    const f = fixture();
    await expect(start(f, options)).rejects.toThrow('B2B_RECEIVED_DISPATCH_START_FAILED');
    expect(f.factories.queue).not.toHaveBeenCalled();
  });

  it('requires an explicit endpoint and rejects bad enqueue input before queue access', async () => {
    const f = fixture();
    await expect(createB2bReceivedDispatchQueue({ host: '', port: 6379 }, f.ports, { enabled: true, factories: f.factories })).rejects.toThrow('B2B_RECEIVED_DISPATCH_START_FAILED');
    expect(f.factories.queue).not.toHaveBeenCalled();
    const transport = await start(f);
    await expect(transport.enqueue(secret)).rejects.toThrow('B2B_RECEIVED_DISPATCH_INVALID_RUN_ID');
    expect(f.queue.add).not.toHaveBeenCalled();
  });
});
