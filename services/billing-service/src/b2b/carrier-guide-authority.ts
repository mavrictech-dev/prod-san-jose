import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { BillingB2bGuideIssueAuthorization } from './guide-issue-authorization';
import { carrierBinding, carrierJson, validateCarrierProof,
  type CarrierGuideAuthority, type CarrierGuideBinding, type CarrierGuideProof } from './carrier-guide-model';

/** Concrete GT31 adapter over the real authenticated Identity client/RPC.
 * No draft-WRITE inheritance, cached proof, synthetic user, or default grant.
 * Identity must enroll this complete 31 tuple and validate its CarrierGuideSeries
 * mapping independently. This only translates a verified LOCAL/BETA capability;
 * it neither activates a producer nor authorizes transmission or transfer. */
export class BillingB2bCarrierGuideAuthority implements CarrierGuideAuthority {
  constructor(private readonly identity: BillingB2bGuideIssueAuthorization) {}

  async current(token: string, kind: 'SERVICE' | 'USER', input: CarrierGuideBinding,
    action: 'ISSUE' | 'READ'): Promise<CarrierGuideProof> {
    const binding = carrierJson<CarrierGuideBinding>(input);
    carrierBinding(binding);
    if (!['SERVICE', 'USER'].includes(kind) || !['ISSUE', 'READ'].includes(action))
      throw new B2bSecurityError(400, 'INVALID_CARRIER_GUIDE_BINDING');
    try {
      // Give the delegate its own copy: the expected scope remains immutable
      // for comparison even if an asynchronous dependency mutates its input.
      const verified = carrierJson(await this.identity.current(token, kind, structuredClone(binding), action)) as Record<string, unknown>;
      if (!verified || verified.capability !== 'BETA_GUIDE_ISSUE_LOCAL')
        throw new B2bSecurityError(503, 'INVALID_CARRIER_GUIDE_AUTHORITY_RESPONSE');
      // The concrete delegate checks the signed/private response's action before
      // returning its narrower GuideIssueProof projection (which omits action).
      return validateCarrierProof({ ...verified, action, capability: 'BETA_CARRIER_GUIDE_ISSUE_LOCAL' }, kind, binding, action);
    } catch (error) {
      if (error instanceof B2bSecurityError && [400, 401, 403, 404, 409, 429].includes(error.status))
        throw new B2bSecurityError(error.status, 'CARRIER_GUIDE_AUTHORIZATION_DENIED');
      throw new B2bSecurityError(503, 'CARRIER_GUIDE_AUTHORITY_UNAVAILABLE');
    }
  }
}
