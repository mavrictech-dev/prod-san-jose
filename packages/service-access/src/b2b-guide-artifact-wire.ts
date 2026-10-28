import { createHash } from 'node:crypto';
import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { b2bUuid } from '@factuez/contracts/b2b-read-query';
import { validB2bGuideIssueBinding, type B2bGuideIssueBinding } from '@factuez/contracts/b2b-guide-security';
import { correctionEvidenceFreeze, correctionEvidenceHash } from './b2b-correction-evidence-wire';

export const GUIDE_ARTIFACT_KINDS = ['xml', 'zip', 'cdr-xml', 'cdr-zip'] as const;
export type GuideArtifactKind = typeof GUIDE_ARTIFACT_KINDS[number];
export type GuideArtifactWireScope = { binding: B2bGuideIssueBinding; draftId: string; operationId: string };
const flags = { candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false,
  authorizedForTransfer: false, officialRulesValidated: false, officialCdrVerified: false,
  certificateTrusted: false, signatureVerifiedLocally: true } as const;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function exact(value: any, keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys.sort().join(',')) throw new Error();
}
export function guideArtifactWireScope(value: unknown): GuideArtifactWireScope {
  try {
    const s = correctionEvidenceFreeze(value) as GuideArtifactWireScope;
    exact(s, ['binding', 'draftId', 'operationId']);
    if (!validB2bGuideIssueBinding(s.binding) || !b2bUuid(s.draftId) || !b2bUuid(s.operationId) ||
      s.binding.draft.anchor.environment !== 'BETA') throw new Error();
    return s;
  } catch { throw new B2bSecurityError(400, 'INVALID_GUIDE_ARTIFACT_SCOPE'); }
}
export type GuideArtifactWireView = {
  schemaVersion: 'factuez.b2b.guide-artifacts.v1'; scope: GuideArtifactWireScope;
  metadata: typeof flags & { schemaVersion: 'factuez.guide-artifacts-local.v1'; environment: 'BETA'; scope: GuideArtifactWireScope;
    documentId: string; issuerRuc: string; fullNumber: string; guideType: '09' | '31'; ownerRevision: number; profile: string;
    snapshotSha256: string; unsignedXmlSha256: string; xmlSha256: string; zipSha256: string; digestValue: string;
    certificateFingerprintSha256: string; fileName: string };
  replayed: boolean | null;
};
/** Metadata only, no keys, PEM, storage paths, actor/key digests or bearer. */
export function guideArtifactWireView(value: unknown, input: GuideArtifactWireScope, prepare: boolean): GuideArtifactWireView {
  try {
    const s = guideArtifactWireScope(input), v = correctionEvidenceFreeze(value) as GuideArtifactWireView;
    if (Buffer.byteLength(JSON.stringify(v)) > 32768) throw new Error();
    exact(v, ['schemaVersion', 'scope', 'metadata', 'replayed']);
    const m = v.metadata;
    exact(m, ['schemaVersion','environment','scope','documentId','issuerRuc','fullNumber','guideType','ownerRevision','profile',
      'snapshotSha256','unsignedXmlSha256','xmlSha256','zipSha256','digestValue','certificateFingerprintSha256','fileName', ...Object.keys(flags)]);
    if (v.schemaVersion !== 'factuez.b2b.guide-artifacts.v1' || correctionEvidenceHash(v.scope) !== correctionEvidenceHash(s) ||
      correctionEvidenceHash(m.scope) !== correctionEvidenceHash(s) || (prepare ? typeof v.replayed !== 'boolean' : v.replayed !== null) ||
      m.schemaVersion !== 'factuez.guide-artifacts-local.v1' || m.environment !== 'BETA' || !b2bUuid(m.documentId) ||
      m.issuerRuc !== s.binding.draft.anchor.issuerRuc || m.guideType !== s.binding.draft.guideType ||
      typeof m.fullNumber !== 'string' || !(m.guideType === '09' ? /^T[A-Z0-9]{3}-[1-9][0-9]{0,7}$/ : /^V[A-Z0-9]{3}-[1-9][0-9]{0,7}$/).test(m.fullNumber) ||
      !Number.isSafeInteger(m.ownerRevision) || m.ownerRevision < 1 || m.ownerRevision > 2147483647 ||
      typeof m.profile !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(m.profile) ||
      ![m.snapshotSha256,m.unsignedXmlSha256,m.xmlSha256,m.zipSha256,m.certificateFingerprintSha256].every(hash) ||
      typeof m.digestValue !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(m.digestValue) ||
      m.fileName !== `${m.issuerRuc}-${m.guideType}-${m.fullNumber}.zip` ||
      Object.entries(flags).some(([key, expected]) => m[key as keyof typeof flags] !== expected)) throw new Error();
    return v;
  } catch { throw new B2bSecurityError(503, 'INCONSISTENT_GUIDE_ARTIFACTS'); }
}
export type GuideArtifactWireFile = { bytes: Buffer; sha256: string; fileName: string; mediaType: string };
export function guideArtifactWireFile(value: GuideArtifactWireFile, view: GuideArtifactWireView, kind: GuideArtifactKind): GuideArtifactWireFile {
  try {
    if (!GUIDE_ARTIFACT_KINDS.includes(kind)) throw new Error();
    const m = view.metadata, xml = kind === 'xml' || kind === 'cdr-xml', cdr = kind.startsWith('cdr-');
    const fileName = `${cdr ? 'R-' : ''}${m.issuerRuc}-${m.guideType}-${m.fullNumber}.${xml ? 'xml' : 'zip'}`;
    if (!value || !Buffer.isBuffer(value.bytes) || !value.bytes.length || value.bytes.length > 4 * 1024 * 1024 ||
      !hash(value.sha256) || createHash('sha256').update(value.bytes).digest('hex') !== value.sha256 ||
      value.fileName !== fileName || value.mediaType !== (xml ? 'application/xml' : 'application/zip') ||
      !cdr && value.sha256 !== (xml ? m.xmlSha256 : m.zipSha256)) throw new Error();
    return { bytes: Buffer.from(value.bytes), sha256: value.sha256, fileName, mediaType: value.mediaType };
  } catch { throw new B2bSecurityError(503, 'INCONSISTENT_GUIDE_ARTIFACT'); }
}
