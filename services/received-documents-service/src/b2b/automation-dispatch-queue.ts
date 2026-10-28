import type { JobsOptions, QueueOptions, RedisOptions, WorkerOptions } from 'bullmq';

export const B2B_RECEIVED_DISPATCH_QUEUE = 'b2b-received-dispatch-v1';
export const B2B_RECEIVED_DISPATCH_JOB = 'b2b.received.dispatch.v1';
export const B2B_RECEIVED_READ_ONLY_QUEUE = 'b2b-received-read-only-v1';
export const B2B_RECEIVED_READ_ONLY_JOB = 'b2b.received.read-only.v1';

/** The owner supplies LOCAL-only admission, durable claims and idempotent execution. */
export interface B2bReceivedDispatchPorts {
  run(runId: string): Promise<unknown>;
  pending(limit: number): Promise<string[]>;
}
export type B2bReceivedDispatchConnection = Pick<RedisOptions, 'username' | 'password' | 'db' | 'tls'> & {
  host: string;
  port: number;
};
export interface B2bReceivedDispatchQueueClient {
  add(name: string, data: { runId: string }, options: JobsOptions): Promise<unknown>;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  close(): Promise<void>;
}
export interface B2bReceivedDispatchWorkerClient {
  on(event: 'error', listener: (error: unknown) => void): unknown;
  close(): Promise<void>;
}
export type B2bReceivedDispatchProcessor = (job: { name: string; data: unknown }) => Promise<void>;
export interface B2bReceivedDispatchFactories {
  queue(name: string, options: QueueOptions): B2bReceivedDispatchQueueClient;
  worker(name: string, processor: B2bReceivedDispatchProcessor, options: WorkerOptions): B2bReceivedDispatchWorkerClient;
}
export interface B2bReceivedDispatchOptions {
  enabled?: boolean;
  pollIntervalMs?: number;
  batchSize?: number;
  factories?: B2bReceivedDispatchFactories;
  profile?: 'LOCAL_ONLY' | 'LIVE_READ_ONLY';
}
export interface B2bReceivedDispatchTransport {
  readonly enabled: boolean;
  enqueue(runId: string): Promise<boolean>;
  poll(): Promise<void>;
  close(): Promise<void>;
}

const uuid = (value: unknown): value is string => typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const bounded = (value: number, min: number, max: number) => Number.isSafeInteger(value) && value >= min && value <= max;

/** No environment/config reads, signal handlers or resources at import time.
 * Only an explicitly enabled invocation creates connections and a polling timer.
 * Injected ports must select B2B LOCAL runs; this transport cannot infer admission
 * or provide exactly-once execution from an opaque UUID.
 */
export async function createB2bReceivedDispatchQueue(
  connection: B2bReceivedDispatchConnection,
  ports: B2bReceivedDispatchPorts,
  options: B2bReceivedDispatchOptions = {},
): Promise<B2bReceivedDispatchTransport> {
  if (options.enabled !== true) return {
    enabled: false,
    enqueue: async () => false,
    poll: async () => {},
    close: async () => {},
  };

  let queue: B2bReceivedDispatchQueueClient | undefined;
  let worker: B2bReceivedDispatchWorkerClient | undefined;
  // Never inspect, log, attach as cause, or forward upstream error objects.
  const ignoreError = (_error: unknown) => {};
  try {
    const interval = options.pollIntervalMs ?? 20000;
    const batchSize = options.batchSize ?? 100;
    const profile=options.profile??'LOCAL_ONLY';
    if(!['LOCAL_ONLY','LIVE_READ_ONLY'].includes(profile))throw new Error();
    const queueName=profile==='LOCAL_ONLY'?B2B_RECEIVED_DISPATCH_QUEUE:B2B_RECEIVED_READ_ONLY_QUEUE;
    const jobName=profile==='LOCAL_ONLY'?B2B_RECEIVED_DISPATCH_JOB:B2B_RECEIVED_READ_ONLY_JOB;
    if (!connection || typeof connection.host !== 'string' || !connection.host.trim() ||
      !bounded(connection.port, 1, 65535) ||
      (connection.db !== undefined && !bounded(connection.db, 0, 2147483647)) ||
      !ports || typeof ports.run !== 'function' || typeof ports.pending !== 'function' ||
      !bounded(interval, 1000, 300000) || !bounded(batchSize, 1, 100)) throw new Error();

    // Lazy loading also keeps disabled invocations independent of BullMQ runtime.
    const { Queue, Worker, UnrecoverableError } = await import('bullmq');
    const factories = options.factories ?? {
      queue: (name, opts) => new Queue(name, opts),
      worker: (name, processor, opts) => new Worker(name, processor, opts),
    } satisfies B2bReceivedDispatchFactories;
    // Owned connections only: whitelist fields and bound connection retries.
    const baseConnection: RedisOptions = {
      host: connection.host, port: connection.port,
      username: connection.username, password: connection.password,
      db: connection.db, tls: connection.tls,
      connectTimeout: 3000,
      retryStrategy: attempts => attempts <= 3 ? attempts * 250 : null,
      reconnectOnError: () => false,
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
    };
    queue = factories.queue(queueName, {
      connection: { ...baseConnection, maxRetriesPerRequest: 1 },
    });
    queue.on('error', ignoreError);
    const ownedQueue = queue;
    let stopping = false;
    let polling: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const adds = new Set<Promise<boolean>>();

    const processor: B2bReceivedDispatchProcessor = async job => {
      let runId: string;
      try {
        const data = job.data;
        if (job.name !== jobName || !data || typeof data !== 'object' ||
          ![Object.prototype, null].includes(Object.getPrototypeOf(data)) ||
          Reflect.ownKeys(data).length !== 1) throw new Error();
        const descriptor = Object.getOwnPropertyDescriptor(data, 'runId');
        if (!descriptor || !('value' in descriptor) || !uuid(descriptor.value)) throw new Error();
        runId = descriptor.value;
      } catch {
        throw new UnrecoverableError('B2B_RECEIVED_DISPATCH_INVALID_JOB');
      }
      if (stopping) throw new UnrecoverableError('B2B_RECEIVED_DISPATCH_CLOSED');
      try {
        // Discard results too: owner responses may contain sensitive information.
        // BUSY may leave PG QUEUED; completion cleanup lets polling deliver again.
        await ports.run(runId);
      } catch {
        throw new Error('B2B_RECEIVED_DISPATCH_RUN_FAILED');
      }
    };
    worker = factories.worker(queueName, processor, {
      connection: { ...baseConnection, maxRetriesPerRequest: null },
      concurrency: 1,
      // Per-delivery transport bounds only; PG owns the durable three-attempt
      // budget, and serialization conflicts do not consume that owner budget.
      maxStartedAttempts: 3,
      maxStalledCount: 1,
    });
    worker.on('error', ignoreError);
    const ownedWorker = worker;

    const enqueue = (runId: string): Promise<boolean> => {
      if (stopping) return Promise.reject(new Error('B2B_RECEIVED_DISPATCH_CLOSED'));
      if (!uuid(runId)) return Promise.reject(new Error('B2B_RECEIVED_DISPATCH_INVALID_RUN_ID'));
      const operation = (async () => {
        try {
          await ownedQueue.add(jobName, { runId }, {
            jobId: runId, attempts: 3, backoff: { type: 'exponential', delay: 1000 },
            // PG is the source of truth for QUEUED and the persistent attempt budget.
            // jobId deduplicates while the Redis job exists. Remove terminal jobs so
            // polling can redeliver after BUSY, rollback, crash or transport failures;
            // Redis retry exhaustion must never permanently strand a PG QUEUED run.
            removeOnComplete: true, removeOnFail: true,
          });
          return true;
        } catch {
          throw new Error('B2B_RECEIVED_DISPATCH_ENQUEUE_FAILED');
        }
      })();
      adds.add(operation);
      void operation.then(() => adds.delete(operation), () => adds.delete(operation));
      return operation;
    };
    const poll = (): Promise<void> => {
      if (stopping) return Promise.resolve();
      if (polling) return polling;
      polling = (async () => {
        try {
          const ids = await ports.pending(batchSize);
          if (stopping) return;
          if (!Array.isArray(ids) || ids.length > batchSize || !ids.every(uuid)) throw new Error();
          for (const id of new Set(ids)) {
            if (stopping) break;
            await enqueue(id);
          }
        } catch {
          throw new Error('B2B_RECEIVED_DISPATCH_POLL_FAILED');
        }
      })().finally(() => { polling = undefined; });
      return polling;
    };
    const schedule = () => {
      if (stopping) return;
      timer = setTimeout(() => {
        timer = undefined;
        void poll().catch(ignoreError).finally(schedule);
      }, interval);
      timer.unref();
    };
    const close = (): Promise<void> => {
      if (closing) return closing;
      stopping = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      closing = (async () => {
        await polling?.catch(ignoreError);
        await Promise.allSettled([...adds]);
        let failed = false;
        try { await ownedWorker.close(); } catch { failed = true; }
        try { await ownedQueue.close(); } catch { failed = true; }
        if (failed) throw new Error('B2B_RECEIVED_DISPATCH_CLOSE_FAILED');
      })();
      return closing;
    };
    schedule();
    return { enabled: true, enqueue, poll, close };
  } catch {
    // Partial construction must release every resource it acquired.
    try { await worker?.close(); } catch { /* sanitized below */ }
    try { await queue?.close(); } catch { /* sanitized below */ }
    throw new Error('B2B_RECEIVED_DISPATCH_START_FAILED');
  }
}
