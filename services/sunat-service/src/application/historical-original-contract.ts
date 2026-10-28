import { boundedSupplementJson } from '@factuez/sunat-core/dist/fiscal-supplement-command';
import { fiscalSnapshotSha256 } from '@factuez/sunat-core/dist/fiscal-note';
import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import type { BetaAcceptanceArtifact } from '../application/beta-document-acceptance';

/** Candidate record only. The caller must be the trusted signing owner; this module
 * does not authenticate writers, verify signatures or provide durable storage. */
export type HistoricalOriginal = Readonly<{
  handle: string;
  member: Readonly<{ documentId: string; version: number; snapshotSha256: string }>;
  binding: Readonly<{ environment: 'BETA'; issuerRuc: string; companyId: number; branchId: string;
    pointId: string; seriesId: string; series: string; documentType: '01' | '03' }>;
  snapshot: FiscalDocumentSnapshot;
  signerFingerprint: string;
  digestValue: string;
  signedXml: BetaAcceptanceArtifact;
  /** ZIP individual del XML; en boleta no representa el resumen RC enviado. */
  documentZip: BetaAcceptanceArtifact;
  recordSha256: string;
}>;
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };
export type HistoricalOriginalInput = Mutable<Omit<HistoricalOriginal, 'recordSha256'>>;

/** A durable implementation must atomically insert handle AND (documentId,version),
 * reject conflicts, preserve records and artifacts, and never fall back to latest.
 * Access control and publication/recovery belong to that implementation. */
export interface HistoricalOriginalStore {
  insert(record: HistoricalOriginal): Promise<void>;
  loadExact(handle: string): Promise<HistoricalOriginal | null>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const positive = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
const exact = (v: unknown, keys: string[]) => !!v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === keys.slice().sort().join(',');
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') { for (const child of Object.values(v)) freeze(child); Object.freeze(v); }
  return v;
}
function artifact(a: BetaAcceptanceArtifact, max: number): boolean {
  return exact(a, ['id', 'storageKey', 'sha256', 'sizeBytes']) && uuid.test(a.id) && hash.test(a.sha256) &&
    typeof a.storageKey === 'string' && a.storageKey.length > 0 && a.storageKey.length <= 500 &&
    positive(a.sizeBytes) && a.sizeBytes <= max;
}

/** Normalizes bounded JSON, checks the complete binding and freezes a detached copy.
 * A content hash detects changes; it is not proof of provenance or XML validity. */
export function makeHistoricalOriginal(input: HistoricalOriginalInput): HistoricalOriginal {
  try {
    const r = boundedSupplementJson(input) as HistoricalOriginalInput;
    if (!exact(r, ['handle','member','binding','snapshot','signerFingerprint','digestValue','signedXml','documentZip']) ||
        !exact(r.member, ['documentId','version','snapshotSha256']) ||
        !exact(r.binding, ['environment','issuerRuc','companyId','branchId','pointId','seriesId','series','documentType'])) throw 0;
    const { member: m, binding: b, snapshot: s } = r;
    if (typeof r.handle !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(r.handle) ||
        !uuid.test(m.documentId) || !positive(m.version) || !hash.test(m.snapshotSha256) ||
        !s || typeof s !== 'object' || fiscalSnapshotSha256(s) !== m.snapshotSha256 ||
        b.environment !== 'BETA' || !/^\d{11}$/.test(b.issuerRuc) || !positive(b.companyId) ||
        ![b.branchId,b.pointId,b.seriesId].every(x => typeof x === 'string' && uuid.test(x)) ||
        !['01','03'].includes(b.documentType) || !/^[BF][A-Z0-9]{3}$/.test(b.series) ||
        (b.documentType === '01' ? !b.series.startsWith('F') : !b.series.startsWith('B')) ||
        s.environment !== b.environment || s.documentId !== m.documentId || s.companyId !== b.companyId ||
        s.branchId !== b.branchId || s.series !== b.series || s.documentTypeCode !== b.documentType ||
        s.issuer?.identityNumber !== b.issuerRuc || !hash.test(r.signerFingerprint) ||
        !/^[A-Za-z0-9+/]{43}=$/.test(r.digestValue) ||
        !artifact(r.signedXml, 2*1024*1024) || !artifact(r.documentZip, 4*1024*1024) ||
        r.signedXml.id === r.documentZip.id || r.signedXml.storageKey === r.documentZip.storageKey) throw 0;
    return freeze({ ...r, recordSha256: fiscalSnapshotSha256(r) });
  } catch { throw new Error('HISTORICAL_ORIGINAL_INVALID'); }
}

/** Revalidate after every read: neither a mutable store nor a hash establishes provenance. */
export function checkHistoricalOriginal(value: HistoricalOriginal, expectedHandle: string): HistoricalOriginal {
  try {
    const safe = boundedSupplementJson(value) as HistoricalOriginal;
    if (!exact(safe, ['handle','member','binding','snapshot','signerFingerprint','digestValue','signedXml','documentZip','recordSha256'])) throw 0;
    const {recordSha256, ...input} = safe;
    const record = makeHistoricalOriginal(input);
    if (record.handle !== expectedHandle || record.recordSha256 !== recordSha256) throw 0;
    return record;
  } catch { throw new Error('HISTORICAL_ORIGINAL_INVALID'); }
}
