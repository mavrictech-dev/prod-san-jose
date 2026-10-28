import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BetaDispatchPipeline, type BetaCdr, type BetaDispatchContext, type BetaDispatchPorts, type BetaDispatchRow, type BetaPhase,
} from '../services/sunat-service/src/application/beta-dispatch-pipeline';
import type { SubmissionReceipt, TicketStatus } from '../services/sunat-service/src/domain/ports/sunat-adapter.port';
import { LocalPreparationUnavailableError } from '../services/sunat-service/src/application/local-preparation-policy';

// Only port orchestration is under test: buffers are opaque doubles, not signed ZIPs or official CDRs.
const RUC = '20615878481';
type Row = BetaDispatchRow<BetaDispatchContext>;
type TransitionDetails = Parameters<BetaDispatchPorts<BetaDispatchContext>['transition']>[3];
function fixture(initial: BetaPhase = 'AWAITING_AUTHORIZATION') {
  const row: Row = { id: '50000000-0000-4000-8000-000000000881', documentId: '50000000-0000-4000-8000-000000000882',
    phase: initial, attempt: 1, owner: new Date('2026-10-28T18:00:00Z'), ticket: initial === 'WAITING_TICKET' ? 'ISOLATED_TICKET' : null,
    snapshot: { environment: 'PRODUCTION', documentTypeCode: '01', issuer: { identityNumber: RUC } } };
  const zip = Buffer.from('OPAQUE ISOLATED PREPARATION DOUBLE');
  const prepared = { zip, sha256: createHash('sha256').update(zip).digest('hex'), fileName: `${RUC}-01-F001-1.zip`, reference: 'F001-1', revision: 4 };
  const cdrBytes = Buffer.from('OPAQUE ISOLATED CDR DOUBLE');
  const verified: BetaCdr = { trusted: true, status: 'ACCEPTED', code: '0', description: 'VERIFIER DOUBLE', notes: [] as string[] };
  const readSecrets = vi.fn();
  const ports = {
    authorize: vi.fn(async (_row: Row) => {}),
    claim: vi.fn(async (_row: Row, phase: 'PREPARING' | 'POLLING'): Promise<Row | null> => { row.phase = phase; return row; }),
    prepare: vi.fn(async (_row: Row) => { readSecrets(); return prepared; }),
    archived: vi.fn(async (_row: Row) => prepared),
    savePrepared: vi.fn(async (_row: Row, _prepared: typeof prepared) => { row.phase = 'PREPARED'; return true; }),
    owns: vi.fn(async (_row: Row, _phase: BetaPhase) => true),
    transition: vi.fn(async (_row: Row, from: BetaPhase, to: BetaPhase, details?: TransitionDetails) => {
      if (row.phase !== from) return false;
      row.phase = to; if (details?.ticket) row.ticket = details.ticket; return true;
    }),
    submit: vi.fn(async (_row: Row, _prepared: typeof prepared): Promise<SubmissionReceipt> => ({ kind: 'CDR', cdrZip: cdrBytes })),
    getStatus: vi.fn(async (_row: Row, _ticket: string): Promise<TicketStatus> => ({ kind: 'CDR', cdrZip: cdrBytes })),
    cdr: vi.fn(async (_row: Row, _prepared: typeof prepared, _bytes: Buffer) => verified),
  } satisfies BetaDispatchPorts<BetaDispatchContext>;
  const pipeline = new BetaDispatchPipeline(ports, 'PRODUCTION');
  const run = () => pipeline.run({ ...row, snapshot: { ...row.snapshot, issuer: { ...row.snapshot.issuer } } });
  return { row, ports, prepared, cdrBytes, verified, readSecrets, pipeline, run };
}
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('NETWORK_FORBIDDEN'); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe('BetaDispatchPipeline with explicit PRODUCTION environment and isolated ports', () => {
  it('reaches DONE only after a verifier reports a trusted accepted CDR for the submitted artifact', async () => {
    const f = fixture(); await f.run();
    expect(f.row.phase).toBe('DONE'); expect(f.ports.submit).toHaveBeenCalledExactlyOnceWith(f.row, f.prepared);
    expect(f.ports.cdr).toHaveBeenCalledExactlyOnceWith(f.row, f.prepared, f.cdrBytes);
    expect(f.ports.transition).toHaveBeenLastCalledWith(f.row, 'SENDING', 'DONE', { cdr: f.verified, code: '0' });
    expect(f.ports.authorize).toHaveBeenCalledTimes(2); expect(f.ports.getStatus).not.toHaveBeenCalled();
    const calls = f.ports.authorize.mock.invocationCallOrder;
    expect(calls[0]).toBeLessThan(f.ports.prepare.mock.invocationCallOrder[0]);
    expect(calls[1]).toBeGreaterThan(f.ports.savePrepared.mock.invocationCallOrder[0]);
    expect(calls[1]).toBeLessThan(f.ports.submit.mock.invocationCallOrder[0]);
  });
  it.each(['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS', 'REJECTED'] as const)('untrusted CDR claiming %s cannot produce DONE or an automatic resubmission', async status => {
    const f = fixture(); f.ports.cdr.mockResolvedValueOnce({ ...f.verified, trusted: false, status });
    await f.run(); expect(f.row.phase).toBe('CDR_UNVERIFIED');
    expect(f.ports.transition).toHaveBeenLastCalledWith(f.row, 'SENDING', 'CDR_UNVERIFIED', { cdr: expect.objectContaining({ trusted: false, status }), code: 'CDR_SIGNATURE_UNVERIFIED' });
    expect(f.ports.transition.mock.calls.some(call => call[2] === 'DONE')).toBe(false);
    await f.run(); expect(f.ports.submit).toHaveBeenCalledOnce(); expect(f.ports.prepare).toHaveBeenCalledOnce();
  });
  it.each(['timeout', 'local-busy-after-post'])('post-submission %s becomes UNKNOWN and replay never retries POST', async reason => {
    const f = fixture(); f.ports.submit.mockRejectedValueOnce(reason === 'timeout' ? new Error('ISOLATED_POST_TIMEOUT') : new LocalPreparationUnavailableError());
    await f.run(); expect(f.row.phase).toBe('UNKNOWN');
    expect(f.ports.transition).toHaveBeenLastCalledWith(f.row, 'SENDING', 'UNKNOWN', { code: 'RECONCILIATION_REQUIRED' });
    await f.run(); expect(f.ports.submit).toHaveBeenCalledOnce(); expect(f.ports.prepare).toHaveBeenCalledOnce();
    expect(f.ports.authorize).toHaveBeenCalledTimes(2); expect(f.ports.cdr).not.toHaveBeenCalled();
    expect(f.ports.transition.mock.calls.some(call => call[2] === 'RETRY_PREPARATION')).toBe(false);
  });
  it('a verifier exception after POST requires reconciliation instead of DONE or retry', async () => {
    const f = fixture(); f.ports.cdr.mockRejectedValueOnce(new Error('ISOLATED_INVALID_CDR'));
    await f.run(); expect(f.row.phase).toBe('UNKNOWN'); await f.run(); expect(f.ports.submit).toHaveBeenCalledOnce();
    expect(f.ports.transition.mock.calls.some(call => call[2] === 'DONE')).toBe(false);
  });
  it.each(['AWAITING_AUTHORIZATION', 'PREPARED', 'WAITING_TICKET'] as const)('failed initial policy in %s prevents secret-bearing preparation, artifacts, claim and all outbound ports', async initial => {
    const f = fixture(initial); f.ports.authorize.mockRejectedValueOnce(new Error('ISOLATED_POLICY_DENIED'));
    await expect(f.run()).rejects.toThrow('ISOLATED_POLICY_DENIED');
    expect(f.row.phase).toBe(initial); expect(f.readSecrets).not.toHaveBeenCalled();
    for (const port of [f.ports.claim, f.ports.prepare, f.ports.archived, f.ports.savePrepared, f.ports.submit, f.ports.getStatus, f.ports.cdr, f.ports.transition]) expect(port).not.toHaveBeenCalled();
  });
  it('revocation after preparation is checked again and blocks POST', async () => {
    const f = fixture(); f.ports.authorize.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('ISOLATED_REVOKED'));
    await f.run(); expect(f.row.phase).toBe('BLOCKED'); expect(f.ports.prepare).toHaveBeenCalledOnce();
    expect(f.ports.authorize).toHaveBeenCalledTimes(2); expect(f.ports.submit).not.toHaveBeenCalled(); expect(f.ports.cdr).not.toHaveBeenCalled();
    expect(f.ports.transition).toHaveBeenLastCalledWith(f.row, 'PREPARED', 'BLOCKED', { code: 'LOCAL_PREFLIGHT_FAILED' });
  });
  it.each(['BETA', 'missing-environment', '07', '08', 'RC', 'RA'])('rejects %s before policy, secrets, preparation or transport', async change => {
    const f = fixture();
    if (change === 'BETA') f.row.snapshot.environment = 'BETA';
    else if (change === 'missing-environment') delete f.row.snapshot.environment;
    else f.row.snapshot.documentTypeCode = change;
    await expect(f.run()).rejects.toThrow('perfil de despacho');
    for (const port of Object.values(f.ports)) expect(port).not.toHaveBeenCalled(); expect(f.readSecrets).not.toHaveBeenCalled();
  });
  it('reuses the archived exact artifact for PREPARED and never prepares another signed package', async () => {
    const f = fixture('PREPARED'); await f.run(); expect(f.row.phase).toBe('DONE');
    expect(f.ports.archived).toHaveBeenCalledOnce(); expect(f.ports.prepare).not.toHaveBeenCalled(); expect(f.readSecrets).not.toHaveBeenCalled();
    expect(f.ports.submit).toHaveBeenCalledExactlyOnceWith(f.row, f.prepared);
  });
  it('a timed-out poll becomes UNKNOWN without a new POST', async () => {
    const f = fixture('WAITING_TICKET'); f.ports.getStatus.mockRejectedValueOnce(new Error('ISOLATED_POLL_TIMEOUT'));
    await f.run(); expect(f.row.phase).toBe('UNKNOWN'); await f.run();
    expect(f.ports.getStatus).toHaveBeenCalledExactlyOnceWith(f.row, 'ISOLATED_TICKET'); expect(f.ports.submit).not.toHaveBeenCalled(); expect(f.ports.prepare).not.toHaveBeenCalled();
  });
  it('a tampered archived package never reaches POST even after initial authorization', async () => {
    const f = fixture('PREPARED'); f.prepared.sha256 = '0'.repeat(64);
    await f.run(); expect(f.row.phase).toBe('BLOCKED'); expect(f.ports.submit).not.toHaveBeenCalled(); expect(f.ports.cdr).not.toHaveBeenCalled();
  });
  it('losing the lease before POST cannot publish another send', async () => {
    const f = fixture(); f.ports.owns.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await f.run(); expect(f.ports.submit).not.toHaveBeenCalled(); expect(f.ports.cdr).not.toHaveBeenCalled();
  });
});

describe('production 03 orchestration: ticket, poll and reconciliation', () => {
  it('sends once, then polls the same archived RC without preparing or submitting another package', async () => {
    const f = fixture(); f.row.snapshot.documentTypeCode = '03'; f.prepared.fileName = RUC + '-RC-20261028-1.zip'; f.prepared.reference = 'RC-20261028-1';
    f.ports.submit.mockResolvedValueOnce({ kind: 'TICKET', ticket: 'ISOLATED_RC_TICKET' });
    await f.run(); expect(f.row.phase).toBe('WAITING_TICKET'); await f.run(); expect(f.row.phase).toBe('DONE');
    expect(f.ports.prepare).toHaveBeenCalledOnce(); expect(f.ports.submit).toHaveBeenCalledOnce();
    expect(f.ports.getStatus).toHaveBeenCalledExactlyOnceWith(f.row, 'ISOLATED_RC_TICKET');
  });
  it('a lost 03 POST becomes UNKNOWN and never reposts', async () => {
    const f = fixture(); f.row.snapshot.documentTypeCode = '03'; f.ports.submit.mockRejectedValueOnce(new Error('LOST_RC_RESPONSE'));
    await f.run(); expect(f.row.phase).toBe('UNKNOWN'); await f.run(); expect(f.ports.submit).toHaveBeenCalledOnce();
  });
});
