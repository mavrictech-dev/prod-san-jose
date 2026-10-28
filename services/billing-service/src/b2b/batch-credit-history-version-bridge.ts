import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { fiscalSnapshotSha256 as hash } from '@factuez/sunat-core/dist/fiscal-note';
import type { BatchCreditHistoryRequest, BillingBatchCreditHistory } from './batch-credit-history';
import type { BatchMemberVersion } from './batch-member-authority';

/** Read-only reconciliation. The version source is private and must resolve exactly the
 * requested snapshot; this projection is not evidence of signature, CDR or completeness. */
export class BatchCreditHistoryVersionBridge {
  constructor(private readonly history: Pick<BillingBatchCreditHistory, 'read'>,
    private readonly versions: { resolve(documentId: string, snapshotSha256: string): Promise<BatchMemberVersion | null> }) {}

  async read(token: string, kind: 'USER' | 'SERVICE', request: BatchCreditHistoryRequest) {
    const load = () => this.history.read(token, kind, request);
    const first = await load();
    const entries = [];
    for (const entry of first.entries) {
      const version = await this.versions.resolve(entry.note.documentId, entry.snapshotSha256);
      if (!version || Object.keys(version).sort().join(',') !== 'documentId,snapshotSha256,version' ||
        version.documentId !== entry.note.documentId || version.snapshotSha256 !== entry.snapshotSha256 ||
        !Number.isSafeInteger(version.version) || version.version < 1)
        throw new B2bSecurityError(409, 'BATCH_CREDIT_HISTORY_VERSION_MISSING');
      entries.push({ member: { ...version }, state: entry.state });
    }
    // Confirm that every exact version remains unchanged across the read.
    for (const entry of entries) {
      const current = await this.versions.resolve(entry.member.documentId, entry.member.snapshotSha256);
      if (!current || hash(current) !== hash(entry.member))
        throw new B2bSecurityError(409, 'BATCH_CREDIT_HISTORY_VERSION_MISSING');
    }
    // Re-run the authorization and owner reconciliation after all version lookups.
    const second = await load();
    if (hash({ ...first, checkedAt: null }) !== hash({ ...second, checkedAt: null }))
      throw new B2bSecurityError(409, 'BATCH_CREDIT_HISTORY_VERSION_MISSING');
    return { schemaVersion: 'factuez.billing.batch-credit-history-versions.v1' as const,
      environment: 'BETA' as const, coverage: 'RECONCILED_JOURNAL_ONLY' as const,
      signedVersionCoverage: 'NOT_PROVIDED' as const, acceptanceProof: 'NOT_PROVIDED' as const,
      original: second.original, journal: second.journal, entries, checkedAt: second.checkedAt };
  }
}

