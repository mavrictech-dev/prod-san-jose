import { b2bBindingsContain } from '@factuez/contracts/b2b-security';
import { b2bGuideIssueScopes, b2bGuideIssueReadScopes } from '@factuez/contracts/b2b-guide-security';
import { B2bOwnerReadFrame } from '@factuez/service-access/dist/b2b-read-adapter';
import type { B2bIdentityHttp, B2bPrivateHttp } from '@factuez/service-access/dist/b2b';
import { boundedSupplementJson } from '@factuez/sunat-core/dist/fiscal-supplement-command';
import type { CarrierReference09Evidence } from '@factuez/sunat-core/dist/carrier-guide-profile';
import { validateGuideArtifactScope, artifactFailure, type GuideArtifactAccess, type GuideArtifactAction, type GuideArtifactScope } from './guide-artifact-owner';
import { validateCarrierArtifactIssuance, type CarrierArtifactSource } from './guide-carrier-artifact-owner';

/** Fixed owner RPC over pinned mTLS. The verified public-09 reference is supplied
 * by Billing's reference owner, never echoed from a public artifact request.
 * CarrierGuideArtifactOwner independently rebuilds XML and seals the capability.
 * No database sharing, key lookup or implicit extension of an invoice grant. */
export class PrivateCarrierArtifactSource implements CarrierArtifactSource {
  constructor(private readonly identity: Pick<B2bIdentityHttp, 'authenticate'>,
    private readonly billing: Pick<B2bPrivateHttp, 'post'>) {}
  async artifactCurrent(input: GuideArtifactScope, access: GuideArtifactAccess, action: GuideArtifactAction) {
    const scope = validateGuideArtifactScope(input);
    if (scope.binding.draft.guideType !== '31' || !access || !['SERVICE','USER'].includes(access.kind) ||
      typeof access.token !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(access.token) || !['ISSUE','READ'].includes(action))
      return artifactFailure('GUIDE_ARTIFACT_ACCESS_DENIED');
    try {
      const frame = new B2bOwnerReadFrame(this.identity,access.kind), required = [...(action === 'ISSUE' ? b2bGuideIssueScopes : b2bGuideIssueReadScopes)];
      const before = await frame.principal(access.token,required);
      if (!b2bBindingsContain(before.bindings,scope.binding.draft.anchor)) throw new Error();
      const value: any = boundedSupplementJson(await this.billing.post('/internal/b2b/carrier-guides',
        {action:'ARTIFACT_OWNER',kind:access.kind,scope,permission:action},access.token));
      if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'authorizationSha256,issuance,reference' ||
        !/^[a-f0-9]{64}$/.test(value.authorizationSha256) || !value.reference || typeof value.reference !== 'object') throw new Error();
      const issuance = validateCarrierArtifactIssuance(value.issuance,scope);
      const after = await frame.principal(access.token,required);
      if (!b2bBindingsContain(after.bindings,scope.binding.draft.anchor)) throw new Error();
      return {issuance,authorizationSha256:value.authorizationSha256 as string,reference:value.reference as CarrierReference09Evidence};
    } catch { return artifactFailure('GUIDE_ARTIFACT_OWNER_UNAVAILABLE_OR_DENIED'); }
  }
}
