import { createHash, X509Certificate } from 'node:crypto';
import forge from 'node-forge';
import { unzipSync } from 'fflate';
import { validateGuideIssuanceResponse } from '@factuez/service-access/dist/b2b-guide-issue-wire';
import { boundedSupplementJson } from '@factuez/sunat-core/dist/fiscal-supplement-command';
import { fiscalSnapshotSha256 } from '@factuez/sunat-core/dist/fiscal-note';
import { buildNumberedGuideXml } from '@factuez/sunat-core/dist/numbered-guide-profile';
import type { GuideDispatchManifest, GuideDispatchKey } from '@factuez/sunat-core/dist/guide-dispatch-journal';
import { verifyLocalSignedInvoice } from '../infrastructure/crypto/xml-signer.service';
import { certificateRucCandidates } from '../infrastructure/crypto/certificate-identity';
import { betaCdrZipMetadata, betaCdrCrc32 } from './beta-summary-acceptance';
import { verifyGuideCdrEvidence, type GuideCdrEvidence } from './guide-cdr-evidence';
import type { CdrSignatureTrustService } from '../infrastructure/crypto/cdr-signature-trust.service';
import { isSealedCarrierArtifactOwned, cloneSealedCarrierArtifactOwned, carrierArtifactNumbered } from './guide-carrier-artifact-owner';
import { artifactFailure, validateGuideArtifactScope, type GuideArtifactScope, type GuideArtifactAccess,
  type GuideArtifactOwner, type GuideArtifactOwned, type GuideArtifactAction } from './guide-artifact-owner';

const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const FLAGS = { candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false,
  authorizedForTransfer: false, officialRulesValidated: false, officialCdrVerified: false, certificateTrusted: false,
  signatureVerifiedLocally: true } as const;
export type GuideSignedLocal = { xml: string; zip: Buffer; xmlSha256: string; zipSha256: string;
  digestValue: string; certificateFingerprintSha256: string; certificatePem: string; fileName: string };
/** Host owns key acquisition/disposal. This pipeline never accepts a key, path,
 * password, production mode or caller-supplied XML through its request. */
export interface GuideLocalSigner {
  readonly mode: 'ISOLATED_LOCAL_SIGNER';
  sign(input: { unsignedXml: string; issuerRuc: string; documentType: '09' | '31'; fullNumber: string }): Promise<GuideSignedLocal>;
}
export type GuideArtifactMetadata = typeof FLAGS & {
  schemaVersion: 'factuez.guide-artifacts-local.v1'; environment: 'BETA'; scope: GuideArtifactScope;
  documentId: string; issuerRuc: string; fullNumber: string; guideType: '09' | '31'; ownerRevision: number;
  profile: string; snapshotSha256: string; unsignedXmlSha256: string; xmlSha256: string; zipSha256: string;
  digestValue: string; certificateFingerprintSha256: string; fileName: string;
};
export type GuideArtifactRecord = { metadata: GuideArtifactMetadata; unsignedXml: string; signedXml: string; zip: Buffer; certificatePem: string };
export type GuideCdrArchive = { schemaVersion: 'factuez.guide-cdr-archive-local.v1'; operationId: string;
  packageSha256: string; evidence: GuideCdrEvidence; zip: Buffer };
export interface GuideArtifactTransaction {
  read(): Promise<GuideArtifactRecord | null>;
  insert(record: GuideArtifactRecord): Promise<void>;
  readCdr(): Promise<GuideCdrArchive | null>;
  insertCdr(record: GuideCdrArchive): Promise<void>;
}
export interface GuideArtifactStore {
  transaction<T>(scope: GuideArtifactScope, work: (tx: GuideArtifactTransaction) => Promise<T>): Promise<T>;
}
function numbered(owned: GuideArtifactOwned, scope: GuideArtifactScope) {
  if (isSealedCarrierArtifactOwned(owned)) return carrierArtifactNumbered(owned,scope);
  const r = validateGuideIssuanceResponse(owned.issuance, scope.binding, scope.draftId, scope.operationId), s = r.snapshot;
  return { response: r, rendered: buildNumberedGuideXml({ schemaVersion: 'factuez.numbered-guide-input.v1',
    documentId: s.documentId, operationId: s.operationId, issuer: s.issuer, documentType: '09',
    series: s.series, number: s.number, body: s.body, snapshotSha256: r.snapshotSha256 }) };
}
function detach(r: GuideArtifactRecord): GuideArtifactRecord {
  return { metadata: boundedSupplementJson(r.metadata) as GuideArtifactMetadata, unsignedXml: r.unsignedXml,
    signedXml: r.signedXml, zip: Buffer.from(r.zip), certificatePem: r.certificatePem };
}
/** Every replay/download authenticates the full signed document, never just a
 * stored success flag or checksum. Public certificate is not a PKI trust claim. */
export function validateGuideArtifactRecord(value: GuideArtifactRecord, owned: GuideArtifactOwned, scope: GuideArtifactScope): GuideArtifactRecord {
  try {
    const r = detach(value), m = r.metadata, { response, rendered } = numbered(owned, scope), s = response.snapshot;
    if (Object.keys(value).sort().join(',') !== 'certificatePem,metadata,signedXml,unsignedXml,zip' ||
      Object.keys(m).sort().join(',') !== ['schemaVersion','environment','scope','documentId','issuerRuc','fullNumber','guideType',
        'ownerRevision','profile','snapshotSha256','unsignedXmlSha256','xmlSha256','zipSha256','digestValue',
        'certificateFingerprintSha256','fileName',...Object.keys(FLAGS)].sort().join(',') ||
      m.schemaVersion !== 'factuez.guide-artifacts-local.v1' || m.environment !== 'BETA' ||
      fiscalSnapshotSha256(m.scope) !== fiscalSnapshotSha256(scope) || m.documentId !== s.documentId ||
      m.issuerRuc !== s.issuer.ruc || m.fullNumber !== s.fullNumber || m.guideType !== scope.binding.draft.guideType || m.ownerRevision !== s.draftRevision ||
      m.profile !== rendered.profile || m.snapshotSha256 !== response.snapshotSha256 ||
      Object.entries(FLAGS).some(([k, v]) => m[k as keyof typeof FLAGS] !== v) ||
      typeof r.unsignedXml !== 'string' || r.unsignedXml !== rendered.xml || m.unsignedXmlSha256 !== hash(r.unsignedXml) ||
      typeof r.signedXml !== 'string' || !r.signedXml.length || Buffer.byteLength(r.signedXml) > 2 * 1024 * 1024 ||
      m.xmlSha256 !== hash(r.signedXml) || !Buffer.isBuffer(r.zip) || m.zipSha256 !== hash(r.zip) ||
      typeof r.certificatePem !== 'string' || r.certificatePem.length > 65536 || r.certificatePem.includes('PRIVATE KEY') ||
      m.fileName !== `${s.issuer.ruc}-${m.guideType}-${s.fullNumber}.zip`) throw new Error();
    const cert = new X509Certificate(r.certificatePem);
    const parsedCert = forge.pki.certificateFromPem(r.certificatePem), rucs = certificateRucCandidates(parsedCert.subject.attributes);
    if (rucs.length !== 1 || rucs[0] !== s.issuer.ruc || cert.ca || cert.publicKey.asymmetricKeyType !== 'rsa' ||
      (cert.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
      (parsedCert.getExtension('keyUsage') as { digitalSignature?: boolean } | null)?.digitalSignature !== true) throw new Error();
    if (cert.fingerprint256.replaceAll(':','').toLowerCase() !== m.certificateFingerprintSha256 ||
      verifyLocalSignedInvoice(r.signedXml, r.certificatePem, r.unsignedXml, 'DespatchAdvice') !== m.digestValue) throw new Error();
    const name = m.fileName.replace(/\.zip$/, '.xml'), zipMetadata = betaCdrZipMetadata(r.zip, name);
    const files = unzipSync(r.zip);
    if (Object.keys(files).length !== 1 || !files[name]) throw new Error();
    const xml = Buffer.from(files[name]);
    if (!xml.equals(Buffer.from(r.signedXml)) || xml.length !== zipMetadata.size || betaCdrCrc32(xml) !== zipMetadata.crc) throw new Error();
    return r;
  } catch { return artifactFailure('GUIDE_ARTIFACT_INTEGRITY_FAILED'); }
}

/** Explicit local assembly only. No queue consumption, SOAP/REST, OAuth or fiscal
 * state mutation. Reserving a number stays exclusively in the Billing owner. */
export class GuideArtifactPipeline {
  constructor(private readonly owner: GuideArtifactOwner, private readonly store: GuideArtifactStore,
    private readonly signer: GuideLocalSigner, private readonly allowedRucs: readonly string[],
    private readonly cdrVerifier?: Pick<CdrSignatureTrustService, 'verify'>, private readonly now = () => new Date().toISOString()) {
    if (signer.mode !== 'ISOLATED_LOCAL_SIGNER' || !allowedRucs.length || allowedRucs.length > 100 ||
      new Set(allowedRucs).size !== allowedRucs.length || allowedRucs.some(r => !/^\d{11}$/.test(r)))
      artifactFailure('EXPLICIT_LOCAL_GUIDE_ARTIFACT_POLICY_REQUIRED');
    this.allowedRucs = Object.freeze([...allowedRucs]);
  }
  private async owned(scope: GuideArtifactScope, access: GuideArtifactAccess, action: GuideArtifactAction): Promise<GuideArtifactOwned> {
    if (!this.allowedRucs.includes(scope.binding.draft.anchor.issuerRuc)) artifactFailure('GUIDE_ARTIFACT_RUC_NOT_ALLOWED');
    const o = await this.owner.current(structuredClone(scope), { ...access }, action);
    if (!o || !/^[a-f0-9]{64}$/.test(o.authorizationSha256)) artifactFailure('GUIDE_ARTIFACT_INVALID_OWNER');
    numbered(o, scope);
    if (isSealedCarrierArtifactOwned(o)) return cloneSealedCarrierArtifactOwned(o);
    const issuance = validateGuideIssuanceResponse(o.issuance,scope.binding,scope.draftId,scope.operationId);
    return { issuance, authorizationSha256: o.authorizationSha256 };
  }
  private async fresh(scope: GuideArtifactScope, access: GuideArtifactAccess, action: GuideArtifactAction, baseline: GuideArtifactOwned) {
    if (fiscalSnapshotSha256(await this.owned(scope, access, action)) !== fiscalSnapshotSha256(baseline)) artifactFailure('GUIDE_ARTIFACT_OWNER_CHANGED');
  }
  async prepare(input: unknown, access: GuideArtifactAccess) {
    return this.run(input, access, 'ISSUE');
  }
  async read(input: unknown, access: GuideArtifactAccess) {
    return this.run(input, access, 'READ');
  }
  private async run(input: unknown, access: GuideArtifactAccess, action: GuideArtifactAction): Promise<{ record: GuideArtifactRecord; replayed: boolean }> {
    const scope = validateGuideArtifactScope(input), baseline = await this.owned(scope, access, action);
    const result = await this.store.transaction(scope, async tx => {
      await this.fresh(scope, access, action, baseline);
      const prior = await tx.read();
      if (prior) {
        const record = validateGuideArtifactRecord(prior, baseline, scope);
        await this.fresh(scope, access, action, baseline);
        return { record, replayed: true };
      }
      if (action === 'READ') artifactFailure('GUIDE_ARTIFACT_NOT_PREPARED');
      const { response, rendered } = numbered(baseline, scope), s = response.snapshot;
      const signed = await this.signer.sign({ unsignedXml: rendered.xml, issuerRuc: s.issuer.ruc, documentType: scope.binding.draft.guideType, fullNumber: s.fullNumber });
      const metadata: GuideArtifactMetadata = { schemaVersion: 'factuez.guide-artifacts-local.v1', environment: 'BETA', scope,
        documentId: s.documentId, issuerRuc: s.issuer.ruc, fullNumber: s.fullNumber, guideType: scope.binding.draft.guideType, ownerRevision: s.draftRevision,
        profile: rendered.profile, snapshotSha256: response.snapshotSha256, unsignedXmlSha256: hash(rendered.xml),
        xmlSha256: signed.xmlSha256, zipSha256: signed.zipSha256, digestValue: signed.digestValue,
        certificateFingerprintSha256: signed.certificateFingerprintSha256, fileName: signed.fileName.replace(/\.xml$/, '.zip'), ...FLAGS };
      const record = validateGuideArtifactRecord({ metadata, unsignedXml: rendered.xml, signedXml: signed.xml,
        zip: signed.zip, certificatePem: signed.certificatePem }, baseline, scope);
      await this.fresh(scope, access, action, baseline);
      await tx.insert(detach(record));
      await this.fresh(scope, access, action, baseline);
      return { record, replayed: false };
    });
    await this.fresh(scope, access, action, baseline);
    return { record: detach(result.record), replayed: result.replayed };
  }
  /** Manifest comes from authenticated persisted bytes, not arbitrary hashes.
   * Dispatch remains LOCAL_EMULATOR and retains its own durable intent journal. */
  async manifest(input: unknown, access: GuideArtifactAccess): Promise<GuideDispatchManifest> {
    const { record: { metadata: m } } = await this.read(input, access), a = m.scope.binding.draft.anchor;
    return { schemaVersion: 'factuez.guide-dispatch-manifest.v1', environment: 'BETA',
      key: { companyId: a.issuerId, issuerRuc: a.issuerRuc, operationId: m.scope.operationId }, documentId: m.documentId,
      guideType: m.guideType, fullNumber: m.fullNumber, ownerRevision: m.ownerRevision, snapshotSha256: m.snapshotSha256,
      xmlSha256: m.xmlSha256, zipSha256: m.zipSha256, source: 'LOCAL_EMULATOR' };
  }
  dispatchOwner(input: unknown, access: GuideArtifactAccess) {
    const scope = validateGuideArtifactScope(input);
    return { current: async (key: GuideDispatchKey) => {
      if (key.companyId !== scope.binding.draft.anchor.issuerId || key.issuerRuc !== scope.binding.draft.anchor.issuerRuc ||
        key.operationId !== scope.operationId) return null;
      return this.manifest(scope, access);
    } };
  }
  /** Captures ORIGINAL CDR ZIP bytes, including authenticated rejection. Local
   * provenance remains explicit; no official status, dispatch or owner state is
   * promoted. A conflicting receipt is an incident, never an overwrite. */
  async reviewCdr(input: unknown, access: GuideArtifactAccess, zip: Buffer): Promise<GuideCdrArchive> {
    if (!Buffer.isBuffer(zip) || zip.length < 22 || zip.length > 4 * 1024 * 1024) artifactFailure('GUIDE_ARTIFACT_INVALID_CDR');
    return this.cdr(input, access, Buffer.from(zip), 'ISSUE');
  }
  async readCdr(input: unknown, access: GuideArtifactAccess): Promise<GuideCdrArchive> {
    return this.cdr(input, access, null, 'READ');
  }
  private async cdr(input: unknown, access: GuideArtifactAccess, bytes: Buffer | null, action: GuideArtifactAction): Promise<GuideCdrArchive> {
    if (!this.cdrVerifier) artifactFailure('GUIDE_ARTIFACT_CDR_VERIFIER_REQUIRED');
    const scope = validateGuideArtifactScope(input), baseline = await this.owned(scope, access, action);
    const result = await this.store.transaction(scope, async tx => {
      await this.fresh(scope, access, action, baseline);
      const raw = await tx.read(); if (!raw) artifactFailure('GUIDE_ARTIFACT_NOT_PREPARED');
      const pkg = validateGuideArtifactRecord(raw, baseline, scope), prior = await tx.readCdr();
      if (prior && (prior.schemaVersion !== 'factuez.guide-cdr-archive-local.v1' || prior.operationId !== scope.operationId ||
        prior.packageSha256 !== fiscalSnapshotSha256(pkg.metadata) || !Buffer.isBuffer(prior.zip))) artifactFailure('GUIDE_ARTIFACT_CDR_INTEGRITY_FAILED');
      if (prior && bytes && !prior.zip.equals(bytes)) artifactFailure('GUIDE_ARTIFACT_CDR_CONFLICT');
      if (!prior && !bytes) artifactFailure('GUIDE_ARTIFACT_CDR_NOT_FOUND');
      const zip = Buffer.from(prior?.zip ?? bytes!), m = pkg.metadata;
      const evidence = await verifyGuideCdrEvidence({ issuerRuc: m.issuerRuc, documentType: m.guideType,
        fullNumber: m.fullNumber, requestXmlSha256: m.xmlSha256, requestZipSha256: m.zipSha256,
        issuedAt: baseline.issuance.snapshot.body.issueDate, receivedAt: prior?.evidence.receivedAt ?? this.now(),
        source: 'LOCAL_EMULATOR' }, zip, this.cdrVerifier!);
      if (prior && fiscalSnapshotSha256(prior.evidence) !== fiscalSnapshotSha256(evidence)) artifactFailure('GUIDE_ARTIFACT_CDR_INTEGRITY_FAILED');
      const archive: GuideCdrArchive = { schemaVersion: 'factuez.guide-cdr-archive-local.v1', operationId: scope.operationId,
        packageSha256: fiscalSnapshotSha256(m), evidence, zip };
      await this.fresh(scope, access, action, baseline);
      if (!prior) await tx.insertCdr({ ...archive, zip: Buffer.from(zip) });
      await this.fresh(scope, access, action, baseline);
      return archive;
    });
    await this.fresh(scope, access, action, baseline);
    return { ...result, evidence: boundedSupplementJson(result.evidence) as GuideCdrEvidence, zip: Buffer.from(result.zip) };
  }
}
