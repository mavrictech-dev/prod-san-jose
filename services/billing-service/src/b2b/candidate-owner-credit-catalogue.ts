import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { fiscalSnapshotSha256 as hash } from '@factuez/sunat-core/dist/fiscal-note';
import type { BatchCreditHistoryRequest, BillingBatchCreditHistory } from './batch-credit-history';
import type { BatchMemberVersion } from './batch-member-authority';

/** Candidate only: the independent scan must be owner-controlled and bounded to the
 * same original and full issuer scope. This interface does not establish provenance,
 * authorization, a common transaction, or coverage of all writers. */
export type CandidatePhysicalNote = { documentId: string; originalDocumentId: string;
  documentTypeCode: '07' | '08'; snapshotSha256: string };
export interface CandidatePhysicalNoteScan {
  scan(request: BatchCreditHistoryRequest): Promise<CandidatePhysicalNote[]>;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;
const fail = (): never => { throw new B2bSecurityError(409, 'CANDIDATE_CREDIT_CATALOGUE_UNAVAILABLE'); };
const exact = (x: unknown, keys: string[]): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x) &&
  Object.keys(x).sort().join(',') === [...keys].sort().join(',');
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
function scanRows(value: unknown, originalId: string): CandidatePhysicalNote[] {
  if (!Array.isArray(value) || value.length > 100) return fail();
  const seen = new Set<string>();
  return value.map(row => {
    if (!exact(row, ['documentId', 'originalDocumentId', 'documentTypeCode', 'snapshotSha256']) ||
      !uuid.test(row.documentId) || row.originalDocumentId !== originalId ||
      !['07', '08'].includes(row.documentTypeCode) || !sha.test(row.snapshotSha256) || seen.has(row.documentId)) return fail();
    seen.add(row.documentId);
    return { documentId: row.documentId, originalDocumentId: row.originalDocumentId,
      documentTypeCode: row.documentTypeCode, snapshotSha256: row.snapshotSha256 } as CandidatePhysicalNote;
  }).sort((a,b) => a.documentId.localeCompare(b.documentId));
}

/** Comparison of V2 owner journal, a separate physical scan and exact member versions.
 * Not an implementation of the complete owner catalogue contract; never wire to issuance. */
export class CandidateOwnerCreditCatalogue {
  constructor(private readonly history: Pick<BillingBatchCreditHistory, 'read'>,
    private readonly physical: CandidatePhysicalNoteScan,
    private readonly versions: { resolve(id: string, snapshotSha256: string): Promise<BatchMemberVersion | null> }) {}
  async read(token: string, kind: 'USER' | 'SERVICE', request: BatchCreditHistoryRequest) {
    const q = structuredClone(request);
    // Authorization and the journal's own transaction are provided by the existing reader.
    const load = () => this.history.read(token, kind, structuredClone(q));
    const first = structuredClone(await load());
    if (first.coverage !== 'RECONCILED_JOURNAL_ONLY' || first.signedVersionCoverage !== 'NOT_PROVIDED' ||
      first.acceptanceProof !== 'NOT_PROVIDED' || first.original.snapshotSha256 !== q.originalSnapshotSha256 ||
      first.original.snapshot.documentId !== q.originalDocumentId || first.journal.revision !== q.journalRevision ||
      first.journal.headSha256 !== q.journalHeadSha256 || !Array.isArray(first.entries) || first.entries.length > 100) return fail();
    const expected = scanRows(first.entries.map(e => ({ documentId: e.note.documentId, originalDocumentId: e.note.reference.documentId,
      documentTypeCode: e.note.documentTypeCode, snapshotSha256: e.snapshotSha256 })), q.originalDocumentId);
    const physical = scanRows(await this.physical.scan(structuredClone(q)), q.originalDocumentId);
    if (!same(expected, physical)) return fail();
    const entries: { member: BatchMemberVersion; state: 'RESERVED' | 'ACCEPTED' | 'ACCEPTED_WITH_OBSERVATIONS' | 'REJECTED' }[] = [];
    for (const entry of first.entries) {
      if (entry.state !== 'RESERVED' && entry.state !== 'ACCEPTED' && entry.state !== 'ACCEPTED_WITH_OBSERVATIONS' && entry.state !== 'REJECTED') return fail();
      if (typeof entry.snapshotSha256 !== 'string' || hash(entry.note) !== entry.snapshotSha256) return fail();
      const member = await this.versions.resolve(entry.note.documentId, entry.snapshotSha256);
      if (!exact(member, ['documentId', 'version', 'snapshotSha256']) || member.documentId !== entry.note.documentId ||
        member.snapshotSha256 !== entry.snapshotSha256 || !Number.isSafeInteger(member.version) || member.version < 1) return fail();
      if (entry.note.documentTypeCode === '07') entries.push({ member: { documentId: member.documentId, version: member.version,
        snapshotSha256: member.snapshotSha256 }, state: entry.state });
      // Debit versions are checked too: a missing debit must not be hidden by filtering.
      const again = await this.versions.resolve(entry.note.documentId, entry.snapshotSha256);
      if (!same(member, again)) return fail();
    }
    if (!same(physical, scanRows(await this.physical.scan(structuredClone(q)), q.originalDocumentId))) return fail();
    const last = structuredClone(await load());
    if (!same({ ...first, checkedAt: null }, { ...last, checkedAt: null })) return fail();
    entries.sort((a,b) => a.member.documentId.localeCompare(b.member.documentId));
    return { schemaVersion: 'factuez.billing.candidate-credit-catalogue.v1' as const, environment: 'BETA' as const,
      coverage: 'MATCHED_V2_AND_PHYSICAL_SCAN_ONLY' as const, completeness: 'NOT_PROVEN' as const,
      signedVersionCoverage: 'NOT_PROVIDED' as const, acceptanceProof: 'NOT_PROVIDED' as const,
      original: last.original, journal: last.journal, entries, checkedAt: last.checkedAt };
  }
}

