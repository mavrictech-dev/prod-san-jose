import { expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  B2B_RECEIVED_DISPATCH_JOB, B2B_RECEIVED_DISPATCH_QUEUE, createB2bReceivedDispatchQueue,
  type B2bReceivedDispatchFactories, type B2bReceivedDispatchTransport,
} from '../services/received-documents-service/src/b2b/automation-dispatch-queue';

const local = createRequire(resolve(process.cwd(), 'package.json'));
const service = createRequire(resolve(process.cwd(), 'services/received-documents-service/package.json'));
const { testCapability, createDockerConnector } = local('./tests/helpers/b2b-received-dispatch-redis.cjs');
const real = service('bullmq');
const delay = (ms: number) => new Promise<void>(resolveDelay => setTimeout(resolveDelay, ms));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function within<T>(operation: Promise<T>, ms = 10000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('ISOLATED_REDIS_OPERATION_TIMEOUT')), ms);
    })]);
  } finally { clearTimeout(timeout); }
}
async function eventually(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await within(Promise.resolve(check()), 2000)) return;
    await delay(25);
  }
  throw new Error('ISOLATED_REDIS_CONDITION_TIMEOUT');
}

it('real BullMQ over owned network-none Redis: BUSY recovery, three retries, strict payloads and secret hygiene', async () => {
  const capability = testCapability(); // Only the explicit runner provides this synthetic capability.
  const tunnel = createDockerConnector(capability);
  const connection = { host: '127.0.0.1', port: 6379, password: capability.password };
  const logs: string[] = [];
  const spies = ['log', 'warn', 'error'].map(method =>
    vi.spyOn(console, method as 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); }));
  let queue: any;
  let worker: any;
  let transport: B2bReceivedDispatchTransport | undefined;
  const busyEntered = deferred();
  const releaseBusy = deferred();
  const busyId = randomUUID();
  const failureId = randomUUID();
  // These rows model durable PG eligibility and its persistent attempt budget.
  // No SQL, live configuration, application credentials or external adapter is used.
  const rows = new Map<string, { state: string; calls: number; imports: number; attempts: number }>([
    [busyId, { state: 'QUEUED', calls: 0, imports: 0, attempts: 0 }],
  ]);
  const completed: string[] = [];
  const failures: { id: string; reason: string; attempts: number }[] = [];
  const factories: B2bReceivedDispatchFactories = {
    queue(name, options) {
      // The only connection change is the explicitly supported ioredis Connector.
      // Job options, processor, concurrency and retry settings come from the transport.
      queue = new real.Queue(name, { ...options, connection: { ...options.connection, Connector: tunnel.Connector } });
      return queue;
    },
    worker(name, processor, options) {
      worker = new real.Worker(name, processor, { ...options, connection: { ...options.connection, Connector: tunnel.Connector } });
      worker.on('completed', (job: { id: string }) => { completed.push(job.id!); });
      worker.on('failed', (job: { id: string; attemptsMade: number }, error: Error) => { failures.push({ id: job!.id!, reason: error.message, attempts: job!.attemptsMade }); });
      return worker;
    },
  };
  const ports = {
    async pending(limit: number) {
      return [...rows].filter(([, row]) => row.state === 'QUEUED').slice(0, limit).map(([id]) => id);
    },
    async run(id: string) {
      const row = rows.get(id);
      if (!row) throw new Error('UNEXPECTED_OWNER_EXECUTION');
      row.calls++;
      if (id === busyId && row.calls === 1) {
        busyEntered.resolve();
        await releaseBusy.promise;
        return 'BUSY'; // No import/commit: the PG row remains eligible.
      }
      if (id === failureId) {
        row.attempts++;
        if (row.attempts === 3) row.state = 'FAILED';
        throw new Error(capability.upstreamSecret);
      }
      if (row.state !== 'COMPLETED') {
        row.imports++;
        row.state = 'COMPLETED';
      }
      return { state: 'COMPLETED', privateOwnerResult: capability.upstreamSecret };
    },
  };
  try {
    transport = await createB2bReceivedDispatchQueue(connection, ports, { enabled: true, factories, pollIntervalMs: 1000 });
    const q = queue!;
    const w = worker!;
    await within(Promise.all([q.waitUntilReady(), w.waitUntilReady()]));
    expect(q.name).toBe(B2B_RECEIVED_DISPATCH_QUEUE);
    expect(w.opts.concurrency).toBe(1);
    await within(transport.poll());
    await within(busyEntered.promise);
    const active = await within<any>(q.getJob(busyId));
    expect(active?.data).toEqual({ runId: busyId });
    expect(active?.opts).toMatchObject({ jobId: busyId, attempts: 3, removeOnComplete: true, removeOnFail: true });
    const client = await q.client;
    const activeHash = await within<Record<string, string>>(client.hgetall(q.toKey(busyId)));
    expect(JSON.parse(activeHash.data)).toEqual({ runId: busyId });
    expect(activeHash.data).not.toContain(capability.password);
    expect(activeHash.data).not.toContain(capability.upstreamSecret);
    await transport.poll(); // Real Redis deduplicates this UUID while the job is active.
    expect(rows.get(busyId)?.calls).toBe(1);
    releaseBusy.resolve();
    await eventually(() => completed.filter(id => id === busyId).length === 2);
    await eventually(async () => !await q.getJob(busyId));
    expect(rows.get(busyId)).toMatchObject({ state: 'COMPLETED', calls: 2, imports: 1, attempts: 0 });
    await transport.poll();
    expect(await q.getJob(busyId)).toBeUndefined();

    rows.set(failureId, { state: 'QUEUED', calls: 0, imports: 0, attempts: 0 });
    await transport.poll();
    await eventually(() => failures.filter(event => event.id === failureId).length === 3);
    await eventually(async () => !await q.getJob(failureId));
    expect(rows.get(failureId)).toEqual({ state: 'FAILED', calls: 3, imports: 0, attempts: 3 });
    expect(failures.filter(event => event.id === failureId)).toEqual([1, 2, 3].map(attempts => ({
      id: failureId, reason: 'B2B_RECEIVED_DISPATCH_RUN_FAILED', attempts,
    })));
    await transport.poll();
    expect(await q.getJob(failureId)).toBeUndefined();

    // Directly inject malformed, non-secret fixtures to test the actual processor.
    for (const data of [{ runId: randomUUID(), actor: 'synthetic-forbidden' }, {}, { runId: 'not-a-uuid' }]) {
      const id = randomUUID();
      await q.add(B2B_RECEIVED_DISPATCH_JOB, data, { jobId: id, attempts: 3, removeOnComplete: true, removeOnFail: true });
      await eventually(() => failures.some(event => event.id === id));
      await eventually(async () => !await q.getJob(id));
      expect(failures.filter(event => event.id === id)).toEqual([{
        id, reason: 'B2B_RECEIVED_DISPATCH_INVALID_JOB', attempts: 1,
      }]);
    }
    expect([...rows.values()].reduce((sum, row) => sum + row.calls, 0)).toBe(5);
    expect(await q.getJobCounts('wait', 'active', 'delayed', 'completed', 'failed')).toMatchObject({
      wait: 0, active: 0, delayed: 0, completed: 0, failed: 0,
    });
    // Inspect real Redis event data after job removal, not just mock add arguments.
    const events = await within(client.xrange(q.toKey('events'), '-', '+'));
    const serializedEvents = JSON.stringify(events);
    expect(serializedEvents).toContain('B2B_RECEIVED_DISPATCH_RUN_FAILED');
    expect(serializedEvents).toContain('B2B_RECEIVED_DISPATCH_INVALID_JOB');
    for (const secret of [capability.password, capability.upstreamSecret]) {
      expect(serializedEvents).not.toContain(secret);
      expect(JSON.stringify(logs)).not.toContain(secret);
    }
    const closing = transport.close();
    expect(transport.close()).toBe(closing);
    await within(closing);
    await tunnel.drain();
    expect(w.closed).toBe(true);
    expect(q.closed).toBe(true);
  } finally {
    releaseBusy.resolve();
    try { if (transport) await within(transport.close(), 8000); }
    finally {
      try { await tunnel.shutdown(); }
      finally { spies.forEach(spy => spy.mockRestore()); }
    }
  }
});
