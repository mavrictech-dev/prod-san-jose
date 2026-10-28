import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import type { BetaManifest } from './beta-issuance.repository';
import { makeHistoricalOriginal, checkHistoricalOriginal, type HistoricalOriginal, type HistoricalOriginalStore } from './historical-original-contract';
import { verifyHistoricalOriginal } from './historical-original-verifier';
import type { BatchMemberArtifactPort } from './batch-member-evidence';
import type { BetaOwnerXmlTrust } from '../infrastructure/crypto/beta-owner-xml-trust';

/** Isolated candidate: only an authorized owner may supply the binding, version,
 * artifact IDs and manifest. It does not establish provenance or install a writer. */
export async function linkGeneratedHistoricalOriginal(input: {
  handle: string; version: number; snapshot: FiscalDocumentSnapshot;
  binding: HistoricalOriginal['binding']; snapshotSha256: string; signedXmlId: string; documentZipId: string;
  manifest: BetaManifest; asOf: string;
}, ports: {
  store: HistoricalOriginalStore; artifacts: BatchMemberArtifactPort;
  signatures: Pick<BetaOwnerXmlTrust, 'verifyPreparedDocument'>;
}) {
  const s = input.snapshot, m = input.manifest, asOf = input.asOf;
  if (!s || !m || (s.documentTypeCode !== '01' && s.documentTypeCode !== '03'))
    throw new Error('HISTORICAL_GENERATION_INVALID');
  // In 03 the submitted ZIP is an RC; only individualXmlZip contains this document.
  const zip = s.documentTypeCode === '03' ? m.individualXmlZip : m.zip;
  if (!zip || !m.documentXml) throw new Error('HISTORICAL_GENERATION_INVALID');
  const record = makeHistoricalOriginal({
    handle: input.handle,
    member: { documentId: s.documentId, version: input.version, snapshotSha256: input.snapshotSha256 },
    binding: input.binding,
    snapshot: s, signerFingerprint: m.fingerprint, digestValue: m.digest,
    signedXml: { id: input.signedXmlId, ...m.documentXml },
    documentZip: { id: input.documentZipId, ...zip },
  });
  // Validate the exact bytes and signature before making any record visible.
  await verifyHistoricalOriginal(record.handle, asOf, {
    store: { loadExact: async (handle) => handle === record.handle ? record : null },
    artifacts: ports.artifacts, signatures: ports.signatures,
  });
  await ports.store.insert(record);
  // A failure here is ambiguous: insert may already have committed. Retry only
  // against an idempotent store with the same complete record and handle.
  const stored = await ports.store.loadExact(record.handle);
  if (!stored || checkHistoricalOriginal(stored, record.handle).recordSha256 !== record.recordSha256)
    throw new Error('HISTORICAL_GENERATION_READBACK_FAILED');
  const proof = await verifyHistoricalOriginal(record.handle, asOf, ports);
  if (proof.recordSha256 !== record.recordSha256) throw new Error('HISTORICAL_GENERATION_READBACK_FAILED');
  return proof;
}


