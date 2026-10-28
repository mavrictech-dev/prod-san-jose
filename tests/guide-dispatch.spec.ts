import {afterEach, describe, expect, it, vi} from 'vitest';
import {GuideDispatchCoordinator} from '../services/sunat-service/src/application/guide-dispatch';
import type {GuideDispatchEmulator} from '../services/sunat-service/src/application/guide-dispatch-types';
import {
  appendGuideDispatch, rebuildGuideDispatch, validateGuideDispatchManifest,
  type GuideDispatchChange,
} from '../packages/sunat-core/src/guide-dispatch-journal';
import {
  guideDispatchClone as clone, guideDispatchDeferred as deferred, guideDispatchFixture,
  type GuideDispatchFixture,
} from './helpers/guide-dispatch.fixture';

const flags = {
  candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false,
  authorizedForTransfer: false, officialCdrVerified: false,
};
const attemptId = '00000000-0000-4000-8000-000000000703';
const attempt: GuideDispatchChange = {kind: 'ATTEMPT', data: {attemptId}};
const lost: GuideDispatchChange = {kind: 'NO_RESPONSE', data: {attemptId}};
const ticket = (f: GuideDispatchFixture): GuideDispatchChange => ({
  kind: 'TICKET', data: {attemptId, ticket: f.control.ticket},
});
const kinds = (f: GuideDispatchFixture) => f.store.snapshot(f.key)?.events.map(e => e.kind);
const projection = (f: GuideDispatchFixture) => {
  const record = f.store.snapshot(f.key)!;
  return rebuildGuideDispatch(record.manifest, record.events);
};
function noTransport(f: GuideDispatchFixture) {
  expect(f.emulator.submit).not.toHaveBeenCalled();
  expect(f.emulator.findTicket).not.toHaveBeenCalled();
  expect(f.emulator.poll).not.toHaveBeenCalled();
}
async function recovered(f: GuideDispatchFixture, originalAttempt: string) {
  const uncertain = await f.core.status(f.key);
  expect(uncertain).toMatchObject({...flags, state: 'UNCERTAIN', requiresReconciliation: true});
  expect(await f.restart().dispatch(f.key)).toEqual(uncertain);
  expect(f.emulator.submit).toHaveBeenCalledTimes(1);
  const result = await f.restart().reconcile(f.key);
  expect(result).toMatchObject({...flags, state: 'TICKET_RECEIVED', ticket: f.control.ticket,
    attemptId: originalAttempt, requiresReconciliation: false});
  expect(f.emulator.findTicket).toHaveBeenCalledExactlyOnceWith(f.manifest, originalAttempt, expect.any(AbortSignal));
  expect(f.emulator.submit).toHaveBeenCalledTimes(1);
  expect(kinds(f)).toEqual(['REGISTER', 'ATTEMPT', 'NO_RESPONSE', 'TICKET']);
}

afterEach(() => { vi.useRealTimers(); });

describe('guide dispatch: isolated fixture and atomic serial memory transactions', () => {
  it('serializes same-key transactions and hides staged writes until commit', async () => {
    const f = guideDispatchFixture(), entered = deferred(), release = deferred();
    const registered = f.seed();
    const first = f.store.transaction(f.key, async tx => {
      const row = (await tx.read())!;
      await tx.append(appendGuideDispatch(row.manifest, row.events, attempt, f.control.currentISO), 1);
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    expect(f.store.snapshot(f.key)).toEqual(registered);
    const secondWork = vi.fn(async tx => (await tx.read())!.events.length);
    const second = f.store.transaction(clone(f.key), secondWork);
    await Promise.resolve();
    expect(secondWork).not.toHaveBeenCalled();
    release.resolve();
    await first;
    expect(await second).toBe(2);
    const detached = f.store.snapshot(f.key)!;
    detached.events.length = 0;
    expect(f.store.snapshot(f.key)!.events).toHaveLength(2);
  });

  it('rolls back registration and intention when the transaction callback throws', async () => {
    const f = guideDispatchFixture(), registered = f.seed();
    const empty = guideDispatchFixture();
    await expect(empty.store.transaction(empty.key, async tx => {
      await tx.register(registered.manifest, registered.events[0]);
      await tx.append(appendGuideDispatch(registered.manifest, registered.events, attempt, f.control.currentISO), 1);
      throw new Error('callback crash');
    })).rejects.toThrow('callback crash');
    expect(empty.store.snapshot(empty.key)).toBeNull();
    expect(empty.store.commits).toEqual([]);
  });

  it('a caught staged append failure still poisons and rolls back the callback', async () => {
    const f = guideDispatchFixture(), registered = f.seed();
    f.store.control.failAppendKind = 'ATTEMPT';
    await expect(f.store.transaction(f.key, async tx => {
      try { await tx.append(appendGuideDispatch(f.manifest, registered.events, attempt, f.control.currentISO), 1); }
      catch { /* A caller swallowing an error cannot authorize a partial commit. */ }
      return 'apparently successful';
    })).rejects.toThrow('fixture persist ATTEMPT failed');
    expect(f.store.snapshot(f.key)).toEqual(registered);
    expect(f.store.commits).toEqual([]);
    expect(await f.core.status(f.key)).toMatchObject({state: 'READY', revision: 1, ...flags});
  });
});

describe('actual GuideDispatchCoordinator: intention and duplicate workers', () => {
  it('status of an authorized absent source journal returns null without creating it', async () => {
    const f = guideDispatchFixture();
    expect(f.core).toBeInstanceOf(GuideDispatchCoordinator);
    expect(await f.core.status(f.key)).toBeNull();
    expect(f.store.commits).toEqual([]);
    noTransport(f);
  });

  it('commits REGISTER and ATTEMPT before submit, passing only the owned manifest and attempt', async () => {
    const f = guideDispatchFixture();
    expect(validateGuideDispatchManifest(f.manifest)).toEqual(f.manifest);
    expect(f.manifest).toMatchObject({environment: 'BETA', source: 'LOCAL_EMULATOR', guideType: '09', fullNumber: 'T001-1'});
    expect(f.key.issuerRuc).toBe('20000000001');
    f.emulator.submit.mockImplementation(async (manifest, id, signal) => {
      expect(f.store.commits).toHaveLength(1);
      expect(kinds(f)).toEqual(['REGISTER', 'ATTEMPT']);
      expect(projection(f)).toMatchObject({state: 'INTENT_RECORDED', attemptId: id, ...flags});
      expect(manifest).toEqual(f.manifest);
      expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      expect(signal.aborted).toBe(false);
      return {ticket: f.control.ticket};
    });
    const result = await f.core.dispatch(f.key);
    expect(result).toMatchObject({schemaVersion: 'factuez.guide-dispatch.v1', state: 'TICKET_RECEIVED',
      revision: 3, key: f.key, documentId: f.manifest.documentId, ticket: f.control.ticket,
      requiresReconciliation: false, ...flags});
    expect(f.emulator.submit).toHaveBeenCalledTimes(1);
    expect(f.store.commits).toHaveLength(2);
    expect(kinds(f)).toEqual(['REGISTER', 'ATTEMPT', 'TICKET']);
  });

  it('coordinates a distinct 31/V manifest without claiming official verification', async () => {
    const f = guideDispatchFixture({guideType: '31'});
    expect(await f.core.dispatch(f.key)).toMatchObject({guideType: '31', fullNumber: 'V001-1', ...flags});
    expect(f.emulator.submit.mock.calls[0][0]).toEqual(f.manifest);
  });

  it('duplicate dispatch after a ticket is a read-only projection', async () => {
    const f = guideDispatchFixture(), first = await f.core.dispatch(f.key);
    const before = f.store.snapshot(f.key), commits = f.store.commits.length;
    expect(await f.core.dispatch(clone(f.key))).toEqual(first);
    expect(await f.restart().dispatch(f.key)).toEqual(first);
    expect(f.emulator.submit).toHaveBeenCalledTimes(1);
    expect(f.store.snapshot(f.key)).toEqual(before);
    expect(f.store.commits).toHaveLength(commits);
  });

  it('concurrent independent workers submit once while the first reply is in flight', async () => {
    const f = guideDispatchFixture(), entered = deferred(), reply = deferred<{ticket: string}>();
    f.emulator.submit.mockImplementation(async () => { entered.resolve(); return reply.promise; });
    const first = f.core.dispatch(f.key);
    await entered.promise;
    const duplicate = await f.restart().dispatch(f.key);
    expect(duplicate).toMatchObject({state: 'INTENT_RECORDED', revision: 2, requiresReconciliation: true, ...flags});
    expect(f.emulator.submit).toHaveBeenCalledTimes(1);
    reply.resolve({ticket: f.control.ticket});
    expect(await first).toMatchObject({state: 'TICKET_RECEIVED', attemptId: duplicate.attemptId});
    expect(kinds(f)).toEqual(['REGISTER', 'ATTEMPT', 'TICKET']);
  });

  it('detaches transport manifests and returned views from owner and persisted history', async () => {
    const f = guideDispatchFixture();
    f.emulator.submit.mockImplementation(async manifest => {
      manifest.key.companyId++;
      manifest.zipSha256 = 'f'.repeat(64);
      return {ticket: f.control.ticket};
    });
    const result = await f.core.dispatch(f.key);
    result.key.companyId++;
    expect((await f.core.status(f.key))!.key).toEqual(f.key);
    expect(f.store.snapshot(f.key)!.manifest).toEqual(f.manifest);
    expect(await f.owner.current(f.key)).toEqual(f.manifest);
  });
});

describe('lost replies, crashes and reconciliation without resubmission', () => {
  it('submit error becomes UNCERTAIN, duplicate dispatch stays quiet and findTicket recovers', async () => {
    const f = guideDispatchFixture();
    f.emulator.submit.mockRejectedValue(new Error('synthetic lost reply'));
    const result = await f.core.dispatch(f.key);
    await recovered(f, result.attemptId!);
  });

  it.each([
    ['extra response field', {ticket: 'local_ticket_701', verified: true}],
    ['ticket with trailing LF', {ticket: 'local_ticket_701\n'}],
  ])('submit %s becomes UNCERTAIN and only findTicket can recover it', async (_label, response) => {
    const f = guideDispatchFixture();
    f.emulator.submit.mockResolvedValue(response as never);
    const result = await f.core.dispatch(f.key);
    await recovered(f, result.attemptId!);
  });

  it('submit timeout aborts after 20 ms and recovers through findTicket without resending', async () => {
    vi.useFakeTimers();
    const f = guideDispatchFixture(), entered = deferred();
    let signal!: AbortSignal;
    f.emulator.submit.mockImplementation(async (_m, _id, s) => {
      signal = s; entered.resolve(); return new Promise(() => {});
    });
    const pending = f.core.dispatch(f.key);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(19);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await recovered(f, result.attemptId!);
  });

  it('a crash immediately after intention commit preserves it across restart and reconciliation', async () => {
    const f = guideDispatchFixture();
    f.store.control.afterCommit = () => { throw new Error('crash after durable intention'); };
    await expect(f.core.dispatch(f.key)).rejects.toThrow('crash after durable intention');
    f.store.control.afterCommit = undefined;
    expect(projection(f)).toMatchObject({state: 'INTENT_RECORDED', revision: 2, ...flags});
    expect(await f.restart().dispatch(f.key)).toMatchObject({state: 'INTENT_RECORDED', requiresReconciliation: true});
    noTransport(f);
    expect(await f.restart().reconcile(f.key)).toMatchObject({state: 'TICKET_RECEIVED', revision: 4, ...flags});
    expect(f.emulator.submit).not.toHaveBeenCalled();
    expect(f.emulator.findTicket).toHaveBeenCalledTimes(1);
  });

  it('failure to persist TICKET after submit leaves INTENT and restart reconciles without another submit', async () => {
    const f = guideDispatchFixture();
    f.store.control.failAppendKind = 'TICKET';
    await expect(f.core.dispatch(f.key)).rejects.toThrow('fixture persist TICKET failed');
    expect(kinds(f)).toEqual(['REGISTER', 'ATTEMPT']);
    expect(f.store.commits).toHaveLength(1);
    const id = projection(f).attemptId;
    expect(await f.restart().dispatch(f.key)).toMatchObject({state: 'INTENT_RECORDED', attemptId: id});
    expect(await f.restart().reconcile(f.key)).toMatchObject({state: 'TICKET_RECEIVED', attemptId: id, ...flags});
    expect(f.emulator.submit).toHaveBeenCalledTimes(1);
    expect(f.emulator.findTicket).toHaveBeenCalledExactlyOnceWith(f.manifest, id, expect.any(AbortSignal));
    expect(kinds(f)).toEqual(['REGISTER', 'ATTEMPT', 'NO_RESPONSE', 'TICKET']);
  });

  it('intention append failure rolls back initial registration and prevents submit', async () => {
    const f = guideDispatchFixture();
    f.store.control.failAppendKind = 'ATTEMPT';
    await expect(f.core.dispatch(f.key)).rejects.toThrow('fixture persist ATTEMPT failed');
    expect(f.store.snapshot(f.key)).toBeNull();
    expect(f.store.commits).toEqual([]);
    noTransport(f);
  });

  it('failure to persist NO_RESPONSE still leaves an intention that cannot be resubmitted', async () => {
    const f = guideDispatchFixture();
    f.emulator.submit.mockRejectedValue(new Error('lost reply'));
    f.store.control.failAppendKind = 'NO_RESPONSE';
    await expect(f.core.dispatch(f.key)).rejects.toThrow('fixture persist NO_RESPONSE failed');
    expect(kinds(f)).toEqual(['REGISTER', 'ATTEMPT']);
    expect(await f.restart().dispatch(f.key)).toMatchObject({state: 'INTENT_RECORDED'});
    expect(await f.restart().reconcile(f.key)).toMatchObject({state: 'TICKET_RECEIVED', ...flags});
    expect(f.emulator.submit).toHaveBeenCalledTimes(1);
  });

  it('findTicket null keeps UNCERTAIN without granting a second send or adding events', async () => {
    const f = guideDispatchFixture();
    f.seed(attempt, lost);
    f.emulator.findTicket.mockResolvedValue(null);
    const before = f.store.snapshot(f.key);
    expect(await f.core.reconcile(f.key)).toMatchObject({state: 'UNCERTAIN', revision: 3, requiresReconciliation: true, ...flags});
    expect(await f.core.dispatch(f.key)).toMatchObject({state: 'UNCERTAIN'});
    expect(f.store.snapshot(f.key)).toEqual(before);
    expect(f.emulator.submit).not.toHaveBeenCalled();
  });

  it('findTicket error reports the private reconciliation error without changing UNCERTAIN', async () => {
    const f = guideDispatchFixture();
    f.seed(attempt, lost);
    f.emulator.findTicket.mockRejectedValue(new Error('local lookup failed'));
    const before = f.store.snapshot(f.key);
    await expect(f.core.reconcile(f.key)).rejects.toMatchObject({code: 'GUIDE_DISPATCH_RECONCILIATION_UNAVAILABLE'});
    expect(f.store.snapshot(f.key)).toEqual(before);
    expect(f.emulator.submit).not.toHaveBeenCalled();
  });

  it('findTicket timeout is bounded, aborts and leaves reconciliation required', async () => {
    vi.useFakeTimers();
    const f = guideDispatchFixture(), entered = deferred();
    f.seed(attempt, lost);
    let signal!: AbortSignal;
    f.emulator.findTicket.mockImplementation(async (_m, _id, s) => {
      signal = s; entered.resolve(); return new Promise(() => {});
    });
    const pending = f.core.reconcile(f.key);
    const rejected = expect(pending).rejects.toMatchObject({code: 'GUIDE_DISPATCH_RECONCILIATION_UNAVAILABLE'});
    await entered.promise;
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(signal.aborted).toBe(true);
    expect(projection(f)).toMatchObject({state: 'UNCERTAIN', revision: 3});
    expect(f.emulator.submit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('malformed lookup tickets are rejected without persisting a fabricated ticket', async () => {
    const f = guideDispatchFixture();
    f.seed(attempt, lost);
    f.emulator.findTicket.mockResolvedValue({ticket: f.control.ticket, receiptSha256: '4'.repeat(64)} as never);
    const before = f.store.snapshot(f.key);
    await expect(f.core.reconcile(f.key)).rejects.toMatchObject({code: 'INVALID_GUIDE_DISPATCH_RESPONSE'});
    expect(f.store.snapshot(f.key)).toEqual(before);
    expect(f.emulator.submit).not.toHaveBeenCalled();
  });

  it('two concurrent reconciliations finding one ticket append TICKET only once', async () => {
    const f = guideDispatchFixture(), both = deferred(), reply = deferred<{ticket: string}>();
    f.seed(attempt, lost);
    let calls = 0;
    f.emulator.findTicket.mockImplementation(async () => {
      if (++calls === 2) both.resolve();
      return reply.promise;
    });
    const a = f.core.reconcile(f.key), b = f.restart().reconcile(f.key);
    await both.promise;
    reply.resolve({ticket: f.control.ticket});
    const [first, second] = await Promise.all([a, b]);
    expect(second).toEqual(first);
    expect(kinds(f)).toEqual(['REGISTER', 'ATTEMPT', 'NO_RESPONSE', 'TICKET']);
    expect(f.emulator.submit).not.toHaveBeenCalled();
  });

});

describe('trusted owner and local emulator boundaries', () => {
  it('revoked source rejects every entry point with its private error and no writes or transport', async () => {
    const f = guideDispatchFixture();
    f.control.ownerManifest = null;
    for (const method of ['status', 'dispatch', 'reconcile', 'poll'] as const) {
      await expect(f.core[method](f.key)).rejects.toMatchObject({code: 'GUIDE_DISPATCH_SOURCE_NOT_FOUND'});
    }
    expect(f.store.commits).toEqual([]);
    noTransport(f);
  });

  it('owner failures are mapped to the private unavailable code before registration', async () => {
    const f = guideDispatchFixture();
    f.owner.current.mockRejectedValue(new Error('synthetic owner failure'));
    await expect(f.core.dispatch(f.key)).rejects.toMatchObject({code: 'GUIDE_DISPATCH_OWNER_UNAVAILABLE'});
    expect(f.store.snapshot(f.key)).toBeNull();
    noTransport(f);
  });

  it.each([
    ['company', {companyId: 702}], ['issuer', {issuerRuc: '20000000010'}],
    ['operation', {operationId: '00000000-0000-4000-8000-000000000799'}],
  ])('foreign owner %s scope cannot read, write, reconcile or send the requested operation', async (_label, foreign) => {
    const f = guideDispatchFixture();
    f.seed(attempt, lost);
    Object.assign(f.control.ownerManifest!.key, foreign);
    const before = f.store.snapshot(f.key);
    for (const method of ['status', 'dispatch', 'reconcile', 'poll'] as const) {
      await expect(f.core[method](f.key)).rejects.toMatchObject({code: 'INVALID_GUIDE_DISPATCH_OWNER'});
    }
    expect(f.store.snapshot(f.key)).toEqual(before);
    expect(f.store.commits).toEqual([]);
    noTransport(f);
  });

  it('invalid owner metadata is rejected before it can become a journal manifest', async () => {
    const f = guideDispatchFixture();
    f.control.ownerManifest!.fullNumber = 'T001-1\n';
    await expect(f.core.dispatch(f.key)).rejects.toMatchObject({code: 'INVALID_GUIDE_DISPATCH_OWNER'});
    expect(f.store.snapshot(f.key)).toBeNull();
    noTransport(f);
  });

  it('a changed persisted source hash blocks every entry point without another append or transport', async () => {
    const f = guideDispatchFixture();
    f.seed(attempt, lost);
    f.control.ownerManifest!.zipSha256 = 'a'.repeat(64);
    const before = f.store.snapshot(f.key);
    for (const method of ['status', 'dispatch', 'reconcile', 'poll'] as const) {
      await expect(f.core[method](f.key)).rejects.toMatchObject({code: 'GUIDE_DISPATCH_SOURCE_CHANGED'});
    }
    expect(f.store.snapshot(f.key)).toEqual(before);
    expect(f.store.commits).toEqual([]);
    noTransport(f);
  });

  it('owner revocation during intention staging rolls the entire transaction back', async () => {
    const f = guideDispatchFixture(), append = f.store.transaction.bind(f.store);
    vi.spyOn(f.store, 'transaction').mockImplementation((key, work) => append(key, async tx => work({
      ...tx, append: async (event, revision) => {
        await tx.append(event, revision);
        f.control.ownerManifest = null;
      },
    })));
    await expect(f.core.dispatch(f.key)).rejects.toMatchObject({code: 'GUIDE_DISPATCH_SOURCE_NOT_FOUND'});
    expect(f.store.snapshot(f.key)).toBeNull();
    expect(f.store.commits).toEqual([]);
    noTransport(f);
  });

  it('owner change during registration staging rejects and rolls back intention', async () => {
    const f = guideDispatchFixture(), original = f.store.transaction.bind(f.store);
    vi.spyOn(f.store, 'transaction').mockImplementation((key, work) => original(key, async tx => work({
      ...tx, register: async (manifest, event) => {
        await tx.register(manifest, event);
        f.control.ownerManifest!.ownerRevision++;
      },
    })));
    await expect(f.core.dispatch(f.key)).rejects.toMatchObject({code: 'GUIDE_DISPATCH_OWNER_CHANGED'});
    expect(f.store.snapshot(f.key)).toBeNull();
    noTransport(f);
  });

  it('revocation after intention commit prevents submit while preserving the committed intent', async () => {
    const f = guideDispatchFixture();
    f.store.control.afterCommit = () => { f.control.ownerManifest = null; };
    await expect(f.core.dispatch(f.key)).rejects.toMatchObject({code: 'GUIDE_DISPATCH_SOURCE_NOT_FOUND'});
    expect(kinds(f)).toEqual(['REGISTER', 'ATTEMPT']);
    noTransport(f);
    f.store.control.afterCommit = undefined;
    f.control.ownerManifest = clone(f.manifest);
    expect(await f.restart().dispatch(f.key)).toMatchObject({state: 'INTENT_RECORDED'});
    noTransport(f);
  });

  it('revocation after a submit reply prevents ticket persistence without erasing the intent', async () => {
    const f = guideDispatchFixture();
    f.emulator.submit.mockImplementation(async () => {
      f.control.ownerManifest = null;
      return {ticket: f.control.ticket};
    });
    await expect(f.core.dispatch(f.key)).rejects.toMatchObject({code: 'GUIDE_DISPATCH_SOURCE_NOT_FOUND'});
    expect(kinds(f)).toEqual(['REGISTER', 'ATTEMPT']);
    expect(f.store.commits).toHaveLength(1);
    expect(f.emulator.submit).toHaveBeenCalledTimes(1);
  });

  it('constructor rejects a nonlocal mode and each missing emulator method', () => {
    const f = guideDispatchFixture();
    const invalid = [null, {...f.emulator, mode: 'FOREIGN'}, ...['submit', 'findTicket', 'poll'].map(method => ({...f.emulator, [method]: undefined}))];
    for (const emulator of invalid) {
      expect(() => new GuideDispatchCoordinator(f.store, f.owner, emulator as GuideDispatchEmulator))
        .toThrow('LOCAL_GUIDE_EMULATOR_REQUIRED');
    }
    noTransport(f);
  });

  it.each(['dispatch', 'reconcile', 'poll'] as const)('%s rejects a mode mutated after construction before owner, writes or transport', async method => {
    const f = guideDispatchFixture();
    f.seed(attempt, lost);
    const before = f.store.snapshot(f.key);
    f.emulator.mode = 'FOREIGN' as never;
    await expect(f.core[method](f.key)).rejects.toMatchObject({code: 'LOCAL_GUIDE_EMULATOR_REQUIRED'});
    expect(f.owner.current).not.toHaveBeenCalled();
    expect(f.store.snapshot(f.key)).toEqual(before);
    expect(f.store.commits).toEqual([]);
    noTransport(f);
  });

  it('revalidates a mode changed after the entry check before invoking poll transport', async () => {
    const f = guideDispatchFixture();
    f.seed(attempt, ticket(f));
    let reads = 0;
    f.owner.current.mockImplementation(async () => {
      if (++reads === 4) f.emulator.mode = 'FOREIGN' as never;
      return clone(f.manifest);
    });
    const before = f.store.snapshot(f.key);
    await expect(f.core.poll(f.key)).rejects.toMatchObject({code: 'GUIDE_DISPATCH_POLL_UNAVAILABLE'});
    expect(f.store.snapshot(f.key)).toEqual(before);
    noTransport(f);
  });

});

describe('ticket polling, bounded history and late worker replies', () => {
  it('PENDING retains TICKET_RECEIVED, appends one event and reflects the injected clock', async () => {
    const f = guideDispatchFixture();
    f.seed(attempt, ticket(f));
    f.control.currentISO = '2026-10-22T15:01:00.000Z';
    expect(await f.core.poll(f.key)).toMatchObject({state: 'TICKET_RECEIVED', revision: 4,
      lastAt: f.control.currentISO, receiptSha256: null, requiresReconciliation: false, ...flags});
    expect(f.emulator.poll).toHaveBeenCalledExactlyOnceWith(f.manifest, f.control.ticket, expect.any(AbortSignal));
    expect(kinds(f)).toEqual(['REGISTER', 'ATTEMPT', 'TICKET', 'POLL_PENDING']);
    expect(f.emulator.submit).not.toHaveBeenCalled();
  });

  it('RESULT remains pending independent verification and completed operations do not resend or repoll', async () => {
    const f = guideDispatchFixture();
    f.seed(attempt, ticket(f));
    f.emulator.poll.mockResolvedValue({state: 'RESULT', receiptSha256: f.control.receiptSha256});
    const complete = await f.core.poll(f.key), before = f.store.snapshot(f.key);
    expect(complete).toMatchObject({state: 'RESULT_PENDING_VERIFICATION', revision: 4,
      receiptSha256: f.control.receiptSha256, requiresReconciliation: false, ...flags});
    expect(await f.restart().poll(f.key)).toEqual(complete);
    expect(await f.restart().dispatch(f.key)).toEqual(complete);
    expect(await f.restart().reconcile(f.key)).toEqual(complete);
    expect(await f.core.status(f.key)).toEqual(complete);
    expect(f.store.snapshot(f.key)).toEqual(before);
    expect(f.emulator.poll).toHaveBeenCalledTimes(1);
    expect(f.emulator.submit).not.toHaveBeenCalled();
    expect(f.emulator.findTicket).not.toHaveBeenCalled();
  });

  it.each([
    ['PENDING with claims', {state: 'PENDING', officialCdrVerified: true}],
    ['RESULT with invalid hash', {state: 'RESULT', receiptSha256: '4'.repeat(64) + '\n'}],
    ['RESULT with extra claims', {state: 'RESULT', receiptSha256: '4'.repeat(64), officialCdrVerified: true}],
  ])('poll rejects %s without changing persisted ticket or flags', async (_label, response) => {
    const f = guideDispatchFixture();
    f.seed(attempt, ticket(f));
    f.emulator.poll.mockResolvedValue(response as never);
    const before = f.store.snapshot(f.key);
    await expect(f.core.poll(f.key)).rejects.toMatchObject({code: 'INVALID_GUIDE_DISPATCH_RESPONSE'});
    expect(f.store.snapshot(f.key)).toEqual(before);
    expect(projection(f)).toMatchObject({state: 'TICKET_RECEIVED', ...flags});
  });

  it('poll transport error returns its private code and retains the ticket for another query', async () => {
    const f = guideDispatchFixture();
    f.seed(attempt, ticket(f));
    f.emulator.poll.mockRejectedValueOnce(new Error('local polling error'));
    const before = f.store.snapshot(f.key);
    await expect(f.core.poll(f.key)).rejects.toMatchObject({code: 'GUIDE_DISPATCH_POLL_UNAVAILABLE'});
    expect(f.store.snapshot(f.key)).toEqual(before);
    expect(await f.core.poll(f.key)).toMatchObject({state: 'TICKET_RECEIVED', revision: 4, ...flags});
    expect(f.emulator.submit).not.toHaveBeenCalled();
  });

  it('poll timeout aborts after 20 ms without adding an event', async () => {
    vi.useFakeTimers();
    const f = guideDispatchFixture(), entered = deferred();
    f.seed(attempt, ticket(f));
    let signal!: AbortSignal;
    f.emulator.poll.mockImplementation(async (_m, _ticket, s) => {
      signal = s; entered.resolve(); return new Promise(() => {});
    });
    const before = f.store.snapshot(f.key), pending = f.core.poll(f.key);
    const rejected = expect(pending).rejects.toMatchObject({code: 'GUIDE_DISPATCH_POLL_UNAVAILABLE'});
    await entered.promise;
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(signal.aborted).toBe(true);
    expect(f.store.snapshot(f.key)).toEqual(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('poll requires an existing ticket and never uses lookup or submit as a fallback', async () => {
    const f = guideDispatchFixture();
    await expect(f.core.poll(f.key)).rejects.toMatchObject({code: 'GUIDE_DISPATCH_NOT_FOUND'});
    for (const history of [[], [attempt], [attempt, lost]]) {
      f.seed(...history);
      await expect(f.core.poll(f.key)).rejects.toMatchObject({code: 'GUIDE_DISPATCH_TICKET_REQUIRED'});
    }
    expect(f.store.commits).toEqual([]);
    noTransport(f);
  });

  it('the history limit rejects a new query before calling the emulator', async () => {
    const f = guideDispatchFixture();
    const pending: GuideDispatchChange = {kind: 'POLL_PENDING', data: {ticket: f.control.ticket}};
    f.seed(attempt, ticket(f), ...Array.from({length: 125}, () => pending));
    expect(projection(f).revision).toBe(128);
    const before = f.store.snapshot(f.key);
    await expect(f.core.poll(f.key)).rejects.toMatchObject({code: 'GUIDE_DISPATCH_HISTORY_LIMIT'});
    expect(f.store.snapshot(f.key)).toEqual(before);
    noTransport(f);
  });

  it('a late PENDING from another worker never regresses a completed result', async () => {
    const f = guideDispatchFixture(), entered = deferred(), reply = deferred<{state: 'PENDING'}>();
    f.seed(attempt, ticket(f));
    f.emulator.poll.mockResolvedValue({state: 'RESULT', receiptSha256: f.control.receiptSha256})
      .mockImplementationOnce(async () => { entered.resolve(); return reply.promise; });
    const late = f.core.poll(f.key);
    await entered.promise;
    const complete = await f.restart().poll(f.key), before = f.store.snapshot(f.key);
    reply.resolve({state: 'PENDING'});
    expect(await late).toEqual(complete);
    expect(f.store.snapshot(f.key)).toEqual(before);
    expect(kinds(f)).toEqual(['REGISTER', 'ATTEMPT', 'TICKET', 'POLL_RESULT']);
  });

  it('concurrent identical RESULT receipts are idempotent and append only one result', async () => {
    const f = guideDispatchFixture(), both = deferred(), reply = deferred<{state: 'RESULT'; receiptSha256: string}>();
    f.seed(attempt, ticket(f));
    let calls = 0;
    f.emulator.poll.mockImplementation(async () => { if (++calls === 2) both.resolve(); return reply.promise; });
    const a = f.core.poll(f.key), b = f.restart().poll(f.key);
    await both.promise;
    reply.resolve({state: 'RESULT', receiptSha256: f.control.receiptSha256});
    const [first, second] = await Promise.all([a, b]);
    expect(second).toEqual(first);
    expect(first).toMatchObject({state: 'RESULT_PENDING_VERIFICATION', ...flags});
    expect(kinds(f)).toEqual(['REGISTER', 'ATTEMPT', 'TICKET', 'POLL_RESULT']);
  });

  it('a conflicting late receipt hash is rejected and cannot replace the completed receipt', async () => {
    const f = guideDispatchFixture(), entered = deferred(), reply = deferred<{state: 'RESULT'; receiptSha256: string}>();
    f.seed(attempt, ticket(f));
    f.emulator.poll.mockResolvedValue({state: 'RESULT', receiptSha256: f.control.receiptSha256})
      .mockImplementationOnce(async () => { entered.resolve(); return reply.promise; });
    const late = f.core.poll(f.key);
    const rejected = expect(late).rejects.toMatchObject({code: 'GUIDE_DISPATCH_RESULT_CONFLICT'});
    await entered.promise;
    const complete = await f.restart().poll(f.key), before = f.store.snapshot(f.key);
    reply.resolve({state: 'RESULT', receiptSha256: 'f'.repeat(64)});
    await rejected;
    expect(f.store.snapshot(f.key)).toEqual(before);
    expect(await f.core.status(f.key)).toEqual(complete);
    expect(complete).toMatchObject({receiptSha256: f.control.receiptSha256, ...flags});
  });
});
