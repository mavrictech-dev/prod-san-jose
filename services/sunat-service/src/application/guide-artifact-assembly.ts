import type { B2bIdentityHttp, B2bPrivateHttp } from '@factuez/service-access/dist/b2b';
import type { GuideDispatchDatabase } from './guide-dispatch-store';
import type { CdrSignatureTrustService } from '../infrastructure/crypto/cdr-signature-trust.service';
import { signLocalGuideXml, type LocalGuideSigningInput } from '../infrastructure/crypto/guide-artifact-crypto';
import { PrivateGuideArtifactOwner } from './guide-artifact-owner';
import { GuideArtifactPipeline, type GuideLocalSigner } from './guide-artifact-pipeline';
import { PostgresGuideArtifactStore } from './guide-artifact-store';
import { CarrierGuideArtifactOwner } from './guide-carrier-artifact-owner';
import { PrivateCarrierArtifactSource } from './private-carrier-artifact-source';
import { validateGuideArtifactScope, type GuideArtifactOwner } from './guide-artifact-owner';

/** Owner-controlled callback. Not a request path, environment lookup or key
 * resolver fallback. The host must authenticate the purpose/RUC, dispose the
 * P12 buffer after the callback and never log the password or decrypted key. */
export interface LocalGuideKeys {
  withKey<T>(issuerRuc: string, purpose: 'LOCAL_GUIDE_ARTIFACT', work: (pkcs12: Buffer, password: string) => Promise<T>): Promise<T>;
}
export class LocalGuideKeySigner implements GuideLocalSigner {
  readonly mode = 'ISOLATED_LOCAL_SIGNER' as const;
  constructor(private readonly keys: LocalGuideKeys) {}
  sign(input: LocalGuideSigningInput) {
    return this.keys.withKey(input.issuerRuc, 'LOCAL_GUIDE_ARTIFACT', async (p12, password) => signLocalGuideXml(input, p12, password));
  }
}
/** Explicit assembly over the existing mTLS Identity/Billing RPCs and SUNAT-owned
 * append-only originals. Construction is inert: no bootstrap registration,
 * migration, queue, external transmission or private key acquisition. */
export function createLocalGuideArtifactPipeline(dependencies: {
  database: GuideDispatchDatabase; identity: Pick<B2bIdentityHttp, 'authenticate'>;
  identityHttp: Pick<B2bPrivateHttp, 'post'>; billingHttp: Pick<B2bPrivateHttp, 'post'>;
  keys: LocalGuideKeys; cdr: Pick<CdrSignatureTrustService, 'verify'>;
  allowedRucs: readonly string[]; now?: () => string;
}) {
  return new GuideArtifactPipeline(new PrivateGuideArtifactOwner(dependencies.identity, dependencies.identityHttp, dependencies.billingHttp),
    new PostgresGuideArtifactStore(dependencies.database), new LocalGuideKeySigner(dependencies.keys),
    dependencies.allowedRucs, dependencies.cdr, dependencies.now);
}

/** Complete opt-in 09/31 composition. Profile selection is by a validated owned
 * binding; a 09/private snapshot cannot be relabelled as a 31/public reference.
 * Construction never signs, enrolls an issuer, applies SQL or enables transport. */
export function createLocalPhase7GuideArtifactPipeline(dependencies: Parameters<typeof createLocalGuideArtifactPipeline>[0]) {
  const guide09 = new PrivateGuideArtifactOwner(dependencies.identity,dependencies.identityHttp,dependencies.billingHttp);
  const carrier31 = new CarrierGuideArtifactOwner(new PrivateCarrierArtifactSource(dependencies.identity,dependencies.billingHttp));
  const owner: GuideArtifactOwner = { current(input,access,action) {
    const scope = validateGuideArtifactScope(input);
    return (scope.binding.draft.guideType === '31' ? carrier31 : guide09).current(scope,access,action);
  } };
  return new GuideArtifactPipeline(owner,new PostgresGuideArtifactStore(dependencies.database),new LocalGuideKeySigner(dependencies.keys),
    dependencies.allowedRucs,dependencies.cdr,dependencies.now);
}
