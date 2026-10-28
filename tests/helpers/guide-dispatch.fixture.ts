import {vi} from 'vitest';
import {GuideDispatchCoordinator} from '../../services/sunat-service/src/application/guide-dispatch';
import type {
  GuideDispatchEmulator, GuideDispatchOwner, GuideDispatchRecord,
  GuideDispatchStore, GuideDispatchTransaction,
} from '../../services/sunat-service/src/application/guide-dispatch-types';
import {
  appendGuideDispatch, rebuildGuideDispatch, validateGuideDispatchManifest,
  type GuideDispatchChange, type GuideDispatchKey, type GuideDispatchManifest,
} from '../../packages/sunat-core/src/guide-dispatch-journal';
import {fiscalSnapshotSha256} from '../../packages/sunat-core/src/fiscal-note';

// All metadata is fictional. These ports never load credentials or contact a service.
export const guideDispatchClone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const keyId = (key: GuideDispatchKey) => JSON.stringify([key.companyId, key.issuerRuc, key.operationId]);

export function guideDispatchDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

/** Per-key serialization, detached reads and atomic commit, including poisoned callbacks. */
export class GuideDispatchMemoryStore implements GuideDispatchStore {
  private readonly records = new Map<string, GuideDispatchRecord>();
  private readonly tails = new Map<string, Promise<void>>();
  readonly commits: GuideDispatchRecord[] = [];
  readonly control: {
    failAppendKind: GuideDispatchChange['kind'] | null;
    beforeCommit?: (record: GuideDispatchRecord) => void | Promise<void>;
    afterCommit?: (record: GuideDispatchRecord) => void | Promise<void>;
  } = {failAppendKind: null};

  snapshot(key: GuideDispatchKey): GuideDispatchRecord | null {
    const record = this.records.get(keyId(key));
    return record ? guideDispatchClone(record) : null;
  }

  // Explicit corruption/history setup for tests; never exposes a live record reference.
  seed(key: GuideDispatchKey, record: GuideDispatchRecord) {
    this.records.set(keyId(key), guideDispatchClone(record));
  }

  async transaction<T>(key: GuideDispatchKey, work: (tx: GuideDispatchTransaction) => Promise<T>): Promise<T> {
    const id = keyId(key), previous = this.tails.get(id) ?? Promise.resolve();
    const gate = guideDispatchDeferred();
    const tail = previous.then(() => gate.promise);
    this.tails.set(id, tail);
    await previous;
    try {
      let staged = this.snapshot(key), dirty = false, poison: unknown;
      const guarded = async <R>(action: () => R | Promise<R>): Promise<R> => {
        if (poison) throw poison;
        try { return await action(); } catch (error) { poison = error; throw error; }
      };
      const tx: GuideDispatchTransaction = {
        read: () => guarded(() => guideDispatchClone(staged)),
        register: (manifest, event) => guarded(() => {
          if (staged) throw new Error('fixture registration conflict');
          const detached = guideDispatchClone({manifest, events: [event]});
          validateGuideDispatchManifest(detached.manifest);
          if (keyId(detached.manifest.key) !== id) throw new Error('fixture key conflict');
          rebuildGuideDispatch(detached.manifest, detached.events);
          staged = detached;
          dirty = true;
        }),
        append: (event, expectedRevision) => guarded(() => {
          if (!staged || staged.events.length !== expectedRevision) throw new Error('fixture revision conflict');
          const next = guideDispatchClone(event);
          rebuildGuideDispatch(staged.manifest, [...staged.events, next]);
          staged.events.push(next);
          dirty = true;
          // Fail after staging: a transaction must discard every staged change.
          if (this.control.failAppendKind === next.kind) {
            this.control.failAppendKind = null;
            throw new Error(`fixture persist ${next.kind} failed`);
          }
        }),
      };
      const result = await work(tx);
      if (poison) throw poison;
      if (dirty && staged) {
        await this.control.beforeCommit?.(guideDispatchClone(staged));
        this.records.set(id, guideDispatchClone(staged));
        this.commits.push(guideDispatchClone(staged));
        // A crash here deliberately preserves the already committed intention.
        await this.control.afterCommit?.(guideDispatchClone(staged));
      }
      return result;
    } finally {
      gate.resolve();
      if (this.tails.get(id) === tail) this.tails.delete(id);
    }
  }
}

export function guideDispatchFixture(options: {
  guideType?: '09' | '31'; timeoutMs?: number; manifest?: Partial<GuideDispatchManifest>;
} = {}) {
  const key: GuideDispatchKey = {
    companyId: 701, issuerRuc: '20000000001', operationId: '00000000-0000-4000-8000-000000000701',
  };
  const manifest: GuideDispatchManifest = {
    schemaVersion: 'factuez.guide-dispatch-manifest.v1', environment: 'BETA', key: guideDispatchClone(key),
    documentId: '00000000-0000-4000-8000-000000000702', guideType: options.guideType ?? '09',
    fullNumber: options.guideType === '31' ? 'V001-1' : 'T001-1', ownerRevision: 1,
    snapshotSha256: '1'.repeat(64), xmlSha256: '2'.repeat(64), zipSha256: '3'.repeat(64),
    source: 'LOCAL_EMULATOR', ...guideDispatchClone(options.manifest ?? {}),
  };
  const control = {
    currentISO: '2026-10-22T15:00:00.000Z',
    ownerManifest: guideDispatchClone(manifest) as GuideDispatchManifest | null,
    ticket: 'local_ticket_701', receiptSha256: '4'.repeat(64),
    timeoutMs: options.timeoutMs ?? 20,
  };
  const store = new GuideDispatchMemoryStore();
  const owner = {
    current: vi.fn<GuideDispatchOwner['current']>(async () => guideDispatchClone(control.ownerManifest)),
  } satisfies GuideDispatchOwner;
  const emulator = {
    mode: 'ISOLATED_LOCAL_EMULATOR' as GuideDispatchEmulator['mode'],
    submit: vi.fn<GuideDispatchEmulator['submit']>(async () => ({ticket: control.ticket})),
    findTicket: vi.fn<GuideDispatchEmulator['findTicket']>(async () => ({ticket: control.ticket})),
    poll: vi.fn<GuideDispatchEmulator['poll']>(async () => ({state: 'PENDING'})),
  } satisfies GuideDispatchEmulator;
  const restart = () => new GuideDispatchCoordinator(store, owner, emulator, () => control.currentISO, control.timeoutMs);
  const core = restart();
  const actualKey = guideDispatchClone(manifest.key);
  const seed = (...changes: GuideDispatchChange[]) => {
    const events = [appendGuideDispatch(manifest, [], {
      kind: 'REGISTER', data: {manifestSha256: fiscalSnapshotSha256(manifest)},
    }, control.currentISO)];
    for (const change of changes) events.push(appendGuideDispatch(manifest, events, change, control.currentISO));
    store.seed(actualKey, {manifest, events});
    return store.snapshot(actualKey)!;
  };
  return {core, store, owner, emulator, key: actualKey, manifest, control, restart, seed};
}

export type GuideDispatchFixture = ReturnType<typeof guideDispatchFixture>;
