import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { fiscalSnapshotSha256 as hash } from '@factuez/sunat-core/dist/fiscal-note';
import type { BatchCreditHistoryRequest } from './batch-credit-history';
import type { BatchCreditHistoryVersionBridge } from './batch-credit-history-version-bridge';
import type { BatchMemberVersion } from './batch-member-authority';

type State = 'RESERVED' | 'ACCEPTED' | 'ACCEPTED_WITH_OBSERVATIONS' | 'REJECTED';
type Entry = { member: BatchMemberVersion; state: State };
/** An independent owner inventory, pinned to the original and the journal head.
 * Its implementation must enumerate all writers and physical records; this module
 * cannot prove that promise and is deliberately not connected to a runtime. */
export type CreditHistoryInventory = { originalDocumentId: string; originalSnapshotSha256: string;
  journalRevision: number; journalHeadSha256: string; entries: Entry[] };
export interface CreditHistoryInventoryPort {
  read(token: string, kind: 'USER' | 'SERVICE', request: BatchCreditHistoryRequest): Promise<CreditHistoryInventory>;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;
const bad = (): never => { throw new B2bSecurityError(409, 'BATCH_CREDIT_HISTORY_RECONCILIATION_FAILED'); };
function exact(value: unknown, keys: string[]): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === keys.sort().join(',');
}
function entries(value: unknown): Entry[] {
  if (!Array.isArray(value) || value.length > 100) return bad();
  const seen = new Set<string>();
  return value.map(row => {
    if (!exact(row, ['member', 'state']) || !exact(row.member, ['documentId', 'version', 'snapshotSha256']) ||
      typeof row.member.documentId !== 'string' || !uuid.test(row.member.documentId) ||
      !Number.isSafeInteger(row.member.version) || row.member.version < 1 ||
      typeof row.member.snapshotSha256 !== 'string' || !sha.test(row.member.snapshotSha256) ||
      !['RESERVED', 'ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS', 'REJECTED'].includes(row.state) || seen.has(row.member.documentId)) return bad();
    seen.add(row.member.documentId);
    return { member: { documentId: row.member.documentId, version: row.member.version, snapshotSha256: row.member.snapshotSha256 }, state: row.state as State };
  }).sort((a, b) => a.member.documentId.localeCompare(b.member.documentId));
}
/** Comparison only. No complete:true, acceptance proof, write capability or fiscal execution. */
export class BatchCreditHistoryReconciliation {
  constructor(private readonly history: Pick<BatchCreditHistoryVersionBridge, 'read'>,
    private readonly inventory: CreditHistoryInventoryPort) {}
  async read(token: string, kind: 'USER' | 'SERVICE', request: BatchCreditHistoryRequest) {
    // The existing bridge performs authorization and exact-version checks before inventory access.
    const q = structuredClone(request);
    const loadHistory = () => this.history.read(token, kind, structuredClone(q));
    const loadInventory = () => this.inventory.read(token, kind, structuredClone(q));
    const first = structuredClone(await loadHistory());
    const inspect = (record: CreditHistoryInventory) => {
      if (!exact(record, ['originalDocumentId', 'originalSnapshotSha256', 'journalRevision', 'journalHeadSha256', 'entries']) ||
        record.originalDocumentId !== q.originalDocumentId || record.originalSnapshotSha256 !== q.originalSnapshotSha256 ||
        record.journalRevision !== q.journalRevision || record.journalHeadSha256 !== q.journalHeadSha256) return bad();
      return entries(record.entries);
    };
    if (first.original.snapshotSha256 !== q.originalSnapshotSha256 || first.journal.revision !== q.journalRevision ||
      first.journal.headSha256 !== q.journalHeadSha256 || first.coverage !== 'RECONCILED_JOURNAL_ONLY' ||
      first.signedVersionCoverage !== 'NOT_PROVIDED' || first.acceptanceProof !== 'NOT_PROVIDED') return bad();
    const expected = entries(first.entries), inventory = inspect(structuredClone(await loadInventory()));
    if (hash(expected) !== hash(inventory)) return bad();
    const again = inspect(structuredClone(await loadInventory()));
    if (hash(inventory) !== hash(again)) return bad();
    const last = structuredClone(await loadHistory());
    if (hash({ ...first, checkedAt: null }) !== hash({ ...last, checkedAt: null })) return bad();
    return { schemaVersion: 'factuez.billing.credit-history-reconciliation.v1' as const,
      environment: 'BETA' as const, comparison: 'MATCHED_OWNER_INVENTORY' as const,
      completeness: 'NOT_PROVEN' as const, signedVersionCoverage: 'NOT_PROVIDED' as const,
      acceptanceProof: 'NOT_PROVIDED' as const, original: last.original, journal: last.journal,
      entries: expected, checkedAt: last.checkedAt };
  }
}
