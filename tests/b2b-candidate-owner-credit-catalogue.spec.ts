import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fiscalSnapshotSha256 as hash } from '../packages/sunat-core/src/fiscal-note';
import { CandidateOwnerCreditCatalogue } from '../services/billing-service/src/b2b/candidate-owner-credit-catalogue';

function fixture() {
  const originalDocumentId = randomUUID();
  const q: any = { binding: { environment: 'BETA' }, originalDocumentId, originalSnapshotSha256: 'a'.repeat(64),
    journalRevision: 2, journalHeadSha256: 'b'.repeat(64) };
  const note = (type: '07' | '08') => ({ documentId: randomUUID(), documentTypeCode: type, reference: { documentId: originalDocumentId } });
  const credit = note('07'), debit = note('08');
  const row = (n: typeof credit, state: string) => ({ note: n, snapshotSha256: hash(n), state });
  const record: any = { coverage: 'RECONCILED_JOURNAL_ONLY', signedVersionCoverage: 'NOT_PROVIDED', acceptanceProof: 'NOT_PROVIDED',
    original: { snapshot: { documentId: originalDocumentId }, snapshotSha256: q.originalSnapshotSha256 },
    journal: { revision: q.journalRevision, headSha256: q.journalHeadSha256 },
    entries: [row(credit, 'ACCEPTED_WITH_OBSERVATIONS'), row(debit, 'RESERVED')], checkedAt: '2026-10-27T00:00:00Z' };
  const physical = record.entries.map((e: any) => ({ documentId: e.note.documentId, originalDocumentId,
    documentTypeCode: e.note.documentTypeCode, snapshotSha256: e.snapshotSha256 }));
  const history = { read: vi.fn(async () => structuredClone(record)) };
  const scan = { scan: vi.fn(async () => structuredClone(physical)) };
  const versions = { resolve: vi.fn(async (id: string, snapshotSha256: string) => ({ documentId: id, version: 1, snapshotSha256 })) };
  return { q, record, physical, history, scan, versions, candidate: new CandidateOwnerCreditCatalogue(history as any, scan, versions) };
}
describe('isolated candidate credit catalogue', () => {
  it('compares both note types, returns only credits and does not assert completeness or acceptance', async () => {
    const f = fixture(), result = await f.candidate.read('token', 'SERVICE', f.q);
    expect(result).toMatchObject({ completeness: 'NOT_PROVEN', acceptanceProof: 'NOT_PROVIDED', signedVersionCoverage: 'NOT_PROVIDED',
      entries: [{ member: { documentId: f.record.entries[0].note.documentId }, state: 'ACCEPTED_WITH_OBSERVATIONS' }] });
    expect(f.scan.scan).toHaveBeenCalledTimes(2); expect(f.history.read).toHaveBeenCalledTimes(2);
    expect(f.versions.resolve).toHaveBeenCalledTimes(4);
  });
  it('allows an empty comparison without claiming exhaustiveness', async () => {
    const f = fixture(); f.record.entries = []; f.physical.splice(0);
    expect(await f.candidate.read('token', 'SERVICE', f.q)).toMatchObject({ entries: [], completeness: 'NOT_PROVEN' });
  });
  it.each(['missing', 'extra', 'duplicate', 'type', 'hash', 'original'] as const)('rejects inconsistent physical %s', async change => {
    const f = fixture();
    if (change === 'missing') f.physical.pop();
    if (change === 'extra') f.physical.push({ ...f.physical[0], documentId: randomUUID() });
    if (change === 'duplicate') f.physical.push({ ...f.physical[0] });
    if (change === 'type') f.physical[0].documentTypeCode = '08';
    if (change === 'hash') f.physical[0].snapshotSha256 = 'c'.repeat(64);
    if (change === 'original') f.physical[0].originalDocumentId = randomUUID();
    await expect(f.candidate.read('token', 'SERVICE', f.q)).rejects.toMatchObject({ code: 'CANDIDATE_CREDIT_CATALOGUE_UNAVAILABLE' });
  });
  it('rejects a snapshot different from the journal hash', async () => {
    const f = fixture(); f.record.entries[0].note.other = true;
    await expect(f.candidate.read('token', 'SERVICE', f.q)).rejects.toMatchObject({ code: 'CANDIDATE_CREDIT_CATALOGUE_UNAVAILABLE' });
  });
  it('rejects a changed physical scan and a changed version', async () => {
    const f = fixture(); f.scan.scan.mockResolvedValueOnce(structuredClone(f.physical)).mockResolvedValueOnce([]);
    await expect(f.candidate.read('token', 'SERVICE', f.q)).rejects.toMatchObject({ code: 'CANDIDATE_CREDIT_CATALOGUE_UNAVAILABLE' });
    const g = fixture(); g.versions.resolve.mockResolvedValueOnce({ documentId: g.physical[0].documentId, snapshotSha256: g.physical[0].snapshotSha256, version: 1 })
      .mockResolvedValueOnce({ documentId: g.physical[0].documentId, snapshotSha256: g.physical[0].snapshotSha256, version: 2 });
    await expect(g.candidate.read('token', 'SERVICE', g.q)).rejects.toMatchObject({ code: 'CANDIDATE_CREDIT_CATALOGUE_UNAVAILABLE' });
  });
  it('propagates denied or revoked authorization and does not scan before authorization', async () => {
    const f = fixture(); f.history.read.mockRejectedValueOnce(new Error('DENIED'));
    await expect(f.candidate.read('token', 'SERVICE', f.q)).rejects.toThrow('DENIED'); expect(f.scan.scan).not.toHaveBeenCalled();
    const g = fixture(); g.history.read.mockResolvedValueOnce(structuredClone(g.record)).mockRejectedValueOnce(new Error('REVOKED'));
    await expect(g.candidate.read('token', 'SERVICE', g.q)).rejects.toThrow('REVOKED');
  });
  it('rejects journal changes between authorized reads', async () => {
    const f = fixture(); f.scan.scan.mockImplementation(async () => { f.record.journal.revision++; return structuredClone(f.physical); });
    await expect(f.candidate.read('token', 'SERVICE', f.q)).rejects.toMatchObject({ code: 'CANDIDATE_CREDIT_CATALOGUE_UNAVAILABLE' });
  });
});
