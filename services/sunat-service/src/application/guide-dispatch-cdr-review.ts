import { createHash } from 'node:crypto';
import { fiscalSnapshotSha256 } from '@factuez/sunat-core/dist/fiscal-note';
import type { GuideDispatchCoordinator } from './guide-dispatch';
import { GuideArtifactPipeline } from './guide-artifact-pipeline';
import { artifactFailure, validateGuideArtifactScope, type GuideArtifactAccess } from './guide-artifact-owner';

/** Completes the LOCAL dispatch chain. Receipt bytes must match the durable
 * journal result, not just the same number in an uploaded XML. The coordinator
 * reauthenticates its owner on each status read; no find-by-hash SUNAT API,
 * automatic resubmission or accepted fiscal projection is invented here. */
export class GuideDispatchCdrReview {
  constructor(private readonly artifacts: GuideArtifactPipeline, private readonly dispatch: Pick<GuideDispatchCoordinator, 'status'>) {}
  async review(input: unknown, access: GuideArtifactAccess, bytes: Buffer) {
    const scope = validateGuideArtifactScope(input);
    if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > 4 * 1024 * 1024) artifactFailure('GUIDE_ARTIFACT_INVALID_CDR');
    const zip = Buffer.from(bytes), sha = createHash('sha256').update(zip).digest('hex');
    const manifest = await this.artifacts.manifest(scope, access);
    const check = async () => {
      const state = await this.dispatch.status(manifest.key);
      if (!state || state.state !== 'RESULT_PENDING_VERIFICATION' || state.receiptSha256 !== sha || state.documentId !== manifest.documentId ||
        state.guideType !== manifest.guideType || state.fullNumber !== manifest.fullNumber || state.officialCdrVerified !== false ||
        state.transmissionAuthorized !== false || state.authorizedForTransfer !== false ||
        fiscalSnapshotSha256(state.key) !== fiscalSnapshotSha256(manifest.key)) artifactFailure('GUIDE_ARTIFACT_DISPATCH_RECEIPT_MISMATCH');
      return fiscalSnapshotSha256(state);
    };
    const baseline = await check(), archive = await this.artifacts.reviewCdr(scope, access, zip);
    if (await check() !== baseline || archive.evidence.cdrZipSha256 !== sha) artifactFailure('GUIDE_ARTIFACT_DISPATCH_CHANGED');
    return archive;
  }
}
