import { describe, expect, it, vi } from 'vitest';
import { BatchCreditHistoryVersionBridge } from '../services/billing-service/src/b2b/batch-credit-history-version-bridge';

const snapshot = 'a'.repeat(64);
function fixture() {
  const record = { original: { snapshotSha256: 'b'.repeat(64) }, journal: { revision: 2, headSha256: 'c'.repeat(64) },
    entries: [{ note: { documentId: 'note-1' }, snapshotSha256: snapshot, state: 'RESERVED' }], checkedAt: '2026-01-01T00:00:00Z' };
  const history = { read: vi.fn(async () => structuredClone(record)) };
  const versions = { resolve: vi.fn(async () => ({ documentId: 'note-1', version: 3, snapshotSha256: snapshot })) };
  return { record, history, versions, bridge: new BatchCreditHistoryVersionBridge(history as any, versions) };
}
describe('local credit history version bridge', () => {
  it('connects exact versions and repeats authorized history without claiming proof', async () => {
    const f = fixture(), request = {} as any;
    const result = await f.bridge.read('private', 'SERVICE', request);
    expect(result).toMatchObject({ coverage: 'RECONCILED_JOURNAL_ONLY', signedVersionCoverage: 'NOT_PROVIDED', acceptanceProof: 'NOT_PROVIDED',
      entries: [{ member: { documentId: 'note-1', version: 3, snapshotSha256: snapshot }, state: 'RESERVED' }] });
    expect(f.history.read).toHaveBeenCalledTimes(2);
    expect(f.history.read).toHaveBeenLastCalledWith('private', 'SERVICE', request);
  });
  it.each(['missing', 'hash', 'version', 'extra'])('fails closed for %s version', async variant => {
    const f = fixture();
    f.versions.resolve.mockImplementation(async () => variant === 'missing' ? null as any :
      ({ documentId: 'note-1', version: variant === 'version' ? 0 : 3, snapshotSha256: variant === 'hash' ? 'd'.repeat(64) : snapshot,
        ...(variant === 'extra' ? { accepted: true } : {}) }));
    await expect(f.bridge.read('private', 'SERVICE', {} as any)).rejects.toMatchObject({ code: 'BATCH_CREDIT_HISTORY_VERSION_MISSING' });
  });
  it('rejects a version that changes between reads', async () => {
    const f = fixture(); f.versions.resolve.mockResolvedValueOnce({ documentId: 'note-1', version: 3, snapshotSha256: snapshot });
    f.versions.resolve.mockResolvedValueOnce({ documentId: 'note-1', version: 4, snapshotSha256: snapshot });
    await expect(f.bridge.read('private', 'SERVICE', {} as any)).rejects.toMatchObject({ code: 'BATCH_CREDIT_HISTORY_VERSION_MISSING' });
  });
  it('fails if the journal changes or authorization is revoked during resolution', async () => {
    const f = fixture();
    f.versions.resolve.mockImplementation(async () => { f.record.journal.revision++; return { documentId: 'note-1', version: 3, snapshotSha256: snapshot }; });
    await expect(f.bridge.read('private', 'SERVICE', {} as any)).rejects.toMatchObject({ code: 'BATCH_CREDIT_HISTORY_VERSION_MISSING' });
    const g = fixture(); g.history.read.mockRejectedValueOnce(new Error('DENIED'));
    await expect(g.bridge.read('private', 'SERVICE', {} as any)).rejects.toThrow('DENIED');
    expect(g.versions.resolve).not.toHaveBeenCalled();
    const h = fixture(); h.history.read.mockResolvedValueOnce(structuredClone(h.record)).mockRejectedValueOnce(new Error('REVOKED'));
    await expect(h.bridge.read('private', 'SERVICE', {} as any)).rejects.toThrow('REVOKED');
    expect(h.versions.resolve).toHaveBeenCalledTimes(2);
  });
});


