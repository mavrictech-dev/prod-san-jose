import { B2bSecurityError, b2bBindingsContain, validB2bPrincipal } from '@factuez/contracts/b2b-security';
import { b2bGuideIssueScopes, b2bGuideIssueReadScopes, validB2bGuideIssueBinding,
  b2bGuideIssueBindingKey, type B2bGuideIssueAction } from '@factuez/contracts/b2b-guide-security';
import type { B2bPrivateHttp } from '@factuez/service-access/dist/b2b';
import { boundedSupplementJson } from '@factuez/sunat-core/dist/fiscal-supplement-command';
import { supplementActor } from '../application/supplement-actor';
import type { ContextIdentity } from './context';
import type { GuideIssueAuthority, GuideIssueBinding, GuideIssueProof } from './guide-issue-model';

/** Verifies Identity's independently enrolled three-series grant. No draft WRITE
 * fallback, DB sharing, token parsing or implicit SERVICE administrator. */
export class BillingB2bGuideIssueAuthorization implements GuideIssueAuthority {
  constructor(private readonly identity: ContextIdentity, private readonly owner: Pick<B2bPrivateHttp, 'post'>) {}
  async current(token: string, kind: 'SERVICE' | 'USER', input: GuideIssueBinding, action: B2bGuideIssueAction): Promise<GuideIssueProof> {
    let binding: GuideIssueBinding;
    try { binding = boundedSupplementJson(input) as GuideIssueBinding; }
    catch { throw new B2bSecurityError(400, 'INVALID_GUIDE_ISSUE_BINDING'); }
    if (!validB2bGuideIssueBinding(binding) || !['ISSUE', 'READ'].includes(action) || !['SERVICE', 'USER'].includes(kind))
      throw new B2bSecurityError(400, 'INVALID_GUIDE_ISSUE_BINDING');
    const required = action === 'ISSUE' ? [...b2bGuideIssueScopes] : [...b2bGuideIssueReadScopes];
    const principal = await this.identity.authenticate(token, required, kind);
    if (!validB2bPrincipal(principal) || principal.kind !== kind || required.some(s => !principal.scopes.includes(s)) ||
      !b2bBindingsContain(principal.bindings, binding.draft.anchor)) throw new B2bSecurityError(401, 'INVALID_PRINCIPAL');
    let raw: unknown;
    try { raw = await this.owner.post('/internal/b2b/authorize-guide-issue', { binding, kind, action }, token); }
    catch (e) {
      if (e instanceof B2bSecurityError && [400, 401, 403, 404, 409, 429].includes(e.status))
        throw new B2bSecurityError(e.status, 'GUIDE_ISSUE_AUTHORIZATION_DENIED');
      throw new B2bSecurityError(503, 'GUIDE_ISSUE_AUTHORITY_UNAVAILABLE');
    }
    try {
      const r = boundedSupplementJson(raw) as any;
      if (!r || Object.keys(r).sort().join(',') !== 'action,actor,binding,candidateOnly,capability,clientRevision,fiscalExecutionEnabled,grantRevision,schemaVersion,transmissionAuthorized' ||
        r.schemaVersion !== 'factuez.b2b.guide-issue-authorization.v1' || r.action !== action ||
        r.capability !== 'BETA_GUIDE_ISSUE_LOCAL' || !validB2bGuideIssueBinding(r.binding) ||
        b2bGuideIssueBindingKey(r.binding) !== b2bGuideIssueBindingKey(binding) || r.clientRevision !== principal.revision ||
        !Number.isSafeInteger(r.grantRevision) || r.grantRevision < 1 || r.grantRevision > 2147483647 ||
        r.candidateOnly !== true || r.fiscalExecutionEnabled !== false || r.transmissionAuthorized !== false) throw new Error();
      const actor = supplementActor(r.actor), a = actor.b2b, s = actor.scope, b = binding.draft;
      if (!a || a.kind !== kind || a.clientId !== principal.clientId || a.revision !== principal.revision ||
        a.subjectId !== principal.subjectId || a.userAuthRevision !== principal.userAuthRevision || s.kind !== 'ASSIGNED' ||
        s.branchIds.length !== 1 || s.branchIds[0] !== b.anchor.branchId || s.emissionPointIds.length !== 1 ||
        s.emissionPointIds[0] !== b.anchor.pointId || s.series.length !== 3 || new Set(s.series).size !== 3 ||
        ![b.anchor.seriesId, b.guideSeriesId, binding.fiscalSeriesId].every(id => s.series.includes(id))) throw new Error();
      return { capability: 'BETA_GUIDE_ISSUE_LOCAL', binding, actor, clientRevision: principal.revision, grantRevision: r.grantRevision };
    } catch { throw new B2bSecurityError(503, 'INVALID_GUIDE_ISSUE_AUTHORITY_RESPONSE'); }
  }
}
