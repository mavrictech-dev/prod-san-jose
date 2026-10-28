import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubmissionReceipt, TicketStatus } from '../services/sunat-service/src/domain/ports/sunat-adapter.port';
import { BetaDispatchPipeline, type BetaDispatchContext, type BetaDispatchPorts, type BetaDispatchRow, type BetaPhase } from '../services/sunat-service/src/application/beta-dispatch-pipeline';
import { assertOfficialFiscalActivation } from '../services/sunat-service/src/application/fiscal-readiness.service';
import { SoapSubmissionError } from '../services/sunat-service/src/infrastructure/sunat/bounded-soap.adapter';

const types = ['07', '08', 'RC', 'RA'] as const;
const ruc = '20615878481', ticket = 'LOCAL-ARCHIVED-TICKET_1';

function fixture(type: typeof types[number], initial: BetaPhase = 'PREPARED') {
  let durable: BetaDispatchRow<BetaDispatchContext> = {
    id: '50000000-0000-4000-8000-000000000952', documentId: '50000000-0000-4000-8000-000000000953',
    phase: initial, attempt: 1, owner: new Date('2026-10-02T12:00:00Z'),
    snapshot: { environment: 'BETA', documentTypeCode: type, issuer: { identityNumber: ruc } },
    ticket: initial === 'WAITING_TICKET' ? ticket : null,
  };
  const batch = type === 'RC' || type === 'RA';
  const reference = batch ? `${type}-20261002-1` : 'FQ01-1';
  const zip = Buffer.from('PREPARED_SYNTHETIC_BYTES_WITHOUT_SIGNATURE');
  const prepared = { fileName: `${ruc}-${batch ? '' : `${type}-`}${reference}.zip`, reference, revision: 7,
    zip, sha256: createHash('sha256').update(zip).digest('hex') };
  const current = () => structuredClone(durable);
  const owned = (row: BetaDispatchRow<BetaDispatchContext>, phase: BetaPhase) =>
    durable.phase === phase && durable.owner.getTime() === row.owner.getTime() && durable.attempt === row.attempt;
  // Small synchronous CAS double, not a database, SOAP, XSD or signature test.
  const ports = {
    authorize: vi.fn<BetaDispatchPorts<BetaDispatchContext>['authorize']>(async () => {}),
    claim: vi.fn<BetaDispatchPorts<BetaDispatchContext>['claim']>(async (row, phase) => {
      if (!owned(row, row.phase)) return null;
      durable = { ...durable, phase, attempt: durable.attempt + 1, owner: new Date(durable.owner.getTime() + 1) };
      return current();
    }),
    prepare: vi.fn<BetaDispatchPorts<BetaDispatchContext>['prepare']>(async () => { throw new Error('PREPARED_MUST_USE_ARCHIVE'); }),
    archived: vi.fn<BetaDispatchPorts<BetaDispatchContext>['archived']>(async () => prepared),
    savePrepared: vi.fn<BetaDispatchPorts<BetaDispatchContext>['savePrepared']>(async row => {
      if (!owned(row, 'PREPARING')) return false;
      durable.phase = 'PREPARED'; return true;
    }),
    owns: vi.fn<BetaDispatchPorts<BetaDispatchContext>['owns']>(async (row, phase) => owned(row, phase)),
    transition: vi.fn<BetaDispatchPorts<BetaDispatchContext>['transition']>(async (row, from, to, details) => {
      if (!owned(row, from)) return false;
      durable.phase = to; if (details?.ticket) durable.ticket = details.ticket; return true;
    }),
    submit: vi.fn<BetaDispatchPorts<BetaDispatchContext>['submit']>(async (): Promise<SubmissionReceipt> =>
      batch ? { kind: 'TICKET', ticket } : { kind: 'CDR', cdrZip: Buffer.from('SYNTHETIC_CDR') }),
    getStatus: vi.fn<BetaDispatchPorts<BetaDispatchContext>['getStatus']>(async (): Promise<TicketStatus> =>
      ({ kind: 'CDR', cdrZip: Buffer.from('SYNTHETIC_CDR') })),
    cdr: vi.fn<BetaDispatchPorts<BetaDispatchContext>['cdr']>(async () =>
      ({ trusted: true, status: 'ACCEPTED', code: '0', description: 'SYNTHETIC_VERIFIER_RESULT', notes: [] })),
  } satisfies BetaDispatchPorts<BetaDispatchContext>;
  // Recreating the pipeline uses the same durable port state, with no in-process dedup cache.
  const run = () => new BetaDispatchPipeline(ports).run(current());
  return { ports, prepared, current, run };
}

beforeEach(() => {
  vi.stubEnv('SUNAT_BETA_TRANSMISSION_ENABLED', 'false');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('NETWORK_FORBIDDEN'); }));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('Existing PREPARED facade for 07/08/RC/RA with isolated ports', () => {
  it.each(types)('%s resumes its archived package and a replay performs no second submission', async type => {
    const f = fixture(type), original = Buffer.from(f.prepared.zip);
    await f.run();
    expect(f.ports.prepare).not.toHaveBeenCalled(); expect(f.ports.archived).toHaveBeenCalledOnce();
    expect(f.ports.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ phase: 'PREPARING' }), f.prepared);
    expect(f.prepared.zip.equals(original)).toBe(true);
    if (type === 'RC' || type === 'RA') {
      expect(f.current()).toMatchObject({ phase: 'WAITING_TICKET', ticket });
      await f.run(); expect(f.ports.getStatus).toHaveBeenCalledWith(expect.objectContaining({ ticket }), ticket);
    }
    expect(f.current().phase).toBe('DONE'); await f.run(); expect(f.ports.submit).toHaveBeenCalledOnce();
    expect(f.ports.transition.mock.calls[0]).toEqual([expect.anything(), 'PREPARED', 'SENDING']);
  });

  it.each(types)('%s concurrent workers share one CAS submission barrier', async type => {
    const f = fixture(type);
    await Promise.all([f.run(), f.run()]);
    expect(f.ports.archived).toHaveBeenCalledOnce(); expect(f.ports.submit).toHaveBeenCalledOnce();
  });

  it.each(types)('%s ambiguous submission is terminal UNKNOWN across a reconstructed pipeline', async type => {
    const f = fixture(type); f.ports.submit.mockRejectedValueOnce(new SoapSubmissionError('UNKNOWN', 'TRANSPORT_OR_RESPONSE'));
    await f.run(); expect(f.current().phase).toBe('UNKNOWN');
    await f.run(); await f.run(); expect(f.ports.submit).toHaveBeenCalledOnce(); expect(f.ports.getStatus).not.toHaveBeenCalled();
  });

  it.each(types)('%s typed business fault blocks without a retry or fabricated CDR', async type => {
    const f = fixture(type); f.ports.submit.mockRejectedValueOnce(new SoapSubmissionError('BUSINESS', '2335'));
    await f.run(); expect(f.current().phase).toBe('BLOCKED'); await f.run();
    expect(f.ports.submit).toHaveBeenCalledOnce(); expect(f.ports.cdr).not.toHaveBeenCalled();
    expect(f.ports.transition).toHaveBeenLastCalledWith(expect.anything(), 'SENDING', 'BLOCKED', { code: '2335' });
  });

  it.each(types)('%s a rejected SENDING CAS does not call the submission port', async type => {
    const f = fixture(type); f.ports.transition.mockResolvedValueOnce(false);
    await f.run(); expect(f.current().phase).toBe('PREPARED'); expect(f.ports.submit).not.toHaveBeenCalled();
    await f.run(); expect(f.ports.submit).toHaveBeenCalledOnce();
  });

  it.each(types)('%s losing ownership after SENDING leaves the barrier closed to replays', async type => {
    const f = fixture(type); f.ports.owns.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await f.run(); expect(f.current().phase).toBe('SENDING'); expect(f.ports.submit).not.toHaveBeenCalled();
    await f.run(); expect(f.ports.submit).not.toHaveBeenCalled();
  });

  it.each(types)('%s malformed archived bytes fail before the submission barrier', async type => {
    const f = fixture(type); f.prepared.sha256 = '0'.repeat(64);
    await f.run(); expect(f.current().phase).toBe('BLOCKED');
    expect(f.ports.savePrepared).not.toHaveBeenCalled(); expect(f.ports.submit).not.toHaveBeenCalled();
  });

  it.each(types)('%s official version guard stops before claim or archive access', async type => {
    const f = fixture(type); f.ports.authorize.mockImplementation(async () => { assertOfficialFiscalActivation(); });
    await expect(f.run()).rejects.toThrow('Emisión oficial bloqueada');
    expect(f.ports.claim).not.toHaveBeenCalled(); expect(f.ports.archived).not.toHaveBeenCalled(); expect(f.ports.submit).not.toHaveBeenCalled();
  });

  it.each(['RC', 'RA'] as const)('%s 98 then CDR consults only the archived ticket after restart', async type => {
    const f = fixture(type, 'WAITING_TICKET'); f.ports.getStatus.mockResolvedValueOnce({ kind: 'PROCESSING' });
    await f.run(); expect(f.current()).toMatchObject({ phase: 'WAITING_TICKET', ticket });
    await f.run(); expect(f.current().phase).toBe('DONE');
    expect(f.ports.getStatus.mock.calls.map(([, value]) => value)).toEqual([ticket, ticket]);
    expect(f.ports.submit).not.toHaveBeenCalled(); expect(f.ports.prepare).not.toHaveBeenCalled(); expect(f.ports.savePrepared).not.toHaveBeenCalled();
  });

  it.each(['RC', 'RA'] as const)('%s a failed ticket publication leaves SENDING and never reposts', async type => {
    const f = fixture(type), transition = f.ports.transition.getMockImplementation()!;
    f.ports.transition.mockImplementation(async (...args) => args[2] === 'WAITING_TICKET' ? false : transition(...args));
    await f.run(); expect(f.current()).toMatchObject({ phase: 'SENDING', ticket: null });
    await f.run(); expect(f.ports.submit).toHaveBeenCalledOnce(); expect(f.ports.getStatus).not.toHaveBeenCalled();
    // Expired SENDING -> UNKNOWN belongs to BetaSupplementRepository; covered by its persistence suite.
  });

  it.each(['RC', 'RA'] as const)('%s an ambiguous poll retains its ticket and cannot trigger a submission', async type => {
    const f = fixture(type, 'WAITING_TICKET');
    f.ports.getStatus.mockRejectedValueOnce(new SoapSubmissionError('UNKNOWN', 'INVALID_STATUS'));
    await f.run(); expect(f.current()).toMatchObject({ phase: 'UNKNOWN', ticket }); await f.run();
    expect(f.ports.getStatus).toHaveBeenCalledOnce(); expect(f.ports.submit).not.toHaveBeenCalled();
  });

  it.each(types)('%s untrusted CDR cannot close as DONE or cause a second submission', async type => {
    const f = fixture(type); f.ports.cdr.mockResolvedValueOnce({ trusted: false, status: 'ACCEPTED', code: '0', description: 'UNVERIFIED', notes: [] });
    await f.run(); if (type === 'RC' || type === 'RA') await f.run();
    expect(f.current().phase).toBe('CDR_UNVERIFIED'); await f.run(); expect(f.ports.submit).toHaveBeenCalledOnce();
  });

  it.each(types)('%s CDR verification failure after a response requires reconciliation without repost', async type => {
    const f = fixture(type); f.ports.cdr.mockRejectedValueOnce(new Error('CDR_REFERENCE_MISMATCH'));
    await f.run(); if (type === 'RC' || type === 'RA') await f.run();
    expect(f.current().phase).toBe('UNKNOWN'); await f.run(); expect(f.ports.submit).toHaveBeenCalledOnce();
    expect(f.ports.cdr).toHaveBeenCalledOnce();
  });
});
