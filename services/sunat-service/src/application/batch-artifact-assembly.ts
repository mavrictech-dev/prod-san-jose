import type {B2bIdentityHttp,B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import type {GuideDispatchDatabase} from './guide-dispatch-store';
import type {CdrSignatureTrustService} from '../infrastructure/crypto/cdr-signature-trust.service';
import {BatchLocalArtifactPipeline,PostgresBatchLocalArtifactStore,createBatchLocalSigner,
  type BatchLocalKeyProvider,type BatchLocalCdrSource} from './batch-local-artifacts';
import {PrivateBatchArtifactOwner} from './batch-artifact-api';

/** Host-owned, opt-in composition. Only the authenticated private owner can load
 * an already persisted batch command and authorize its full dependency closure.
 * Keys are explicitly LOCAL_SYNTHETIC_BATCH; no production/default key fallback.
 * Construction does not access keys, migrate a DB, enroll grants or dispatch. */
export function createLocalPhase7BatchArtifactPipeline(options:{
  database:GuideDispatchDatabase;identity:Pick<B2bIdentityHttp,'authenticate'>;
  billingHttp:Pick<B2bPrivateHttp,'post'>;keys:BatchLocalKeyProvider;allowedRucs:readonly string[];
  cdrSource?:BatchLocalCdrSource;cdrVerifier?:Pick<CdrSignatureTrustService,'verify'>;
}){
  return new BatchLocalArtifactPipeline(new PrivateBatchArtifactOwner(options.identity,options.billingHttp),
    new PostgresBatchLocalArtifactStore(options.database),createBatchLocalSigner(options.keys),options.allowedRucs,
    options.cdrSource,options.cdrVerifier);
}
