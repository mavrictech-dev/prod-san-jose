import { b2bBindingsContain, validB2bPrincipal } from '@factuez/contracts/b2b-security';
import { b2bGuideIssueScopes, b2bGuideIssueReadScopes, validB2bGuideIssueBinding, b2bGuideIssueBindingKey,
  type B2bGuideIssueBinding } from '@factuez/contracts/b2b-guide-security';
import { b2bUuid } from '@factuez/contracts/b2b-read-query';
import type { B2bPrivateHttp, B2bIdentityHttp } from '@factuez/service-access/dist/b2b';
import { validateGuideIssuanceResponse, type GuideIssuanceResponse } from '@factuez/service-access/dist/b2b-guide-issue-wire';
import { boundedSupplementJson } from '@factuez/sunat-core/dist/fiscal-supplement-command';
import { fiscalSnapshotSha256 } from '@factuez/sunat-core/dist/fiscal-note';
import type { CarrierArtifactOwned } from './guide-carrier-artifact-owner';

export type GuideArtifactScope = { binding: B2bGuideIssueBinding; draftId: string; operationId: string };
export type GuideArtifactAccess = { token: string; kind: 'SERVICE' | 'USER' };
export type GuideArtifactAction = 'ISSUE' | 'READ';
export type GuideArtifactOwned = { issuance: GuideIssuanceResponse; authorizationSha256: string } | CarrierArtifactOwned;
export interface GuideArtifactOwner {
  current(scope: GuideArtifactScope, access: GuideArtifactAccess, action: GuideArtifactAction): Promise<GuideArtifactOwned>;
}
export class GuideArtifactError extends Error { constructor(readonly code: string) { super(code); } }
export function artifactFailure(code: string): never { throw new GuideArtifactError(code); }
export function validateGuideArtifactScope(value: unknown): GuideArtifactScope {
  try {
    const s = boundedSupplementJson(value) as GuideArtifactScope;
    if (!s || Object.keys(s).sort().join(',') !== 'binding,draftId,operationId' || !validB2bGuideIssueBinding(s.binding) ||
      !b2bUuid(s.draftId) || !b2bUuid(s.operationId) || s.binding.draft.anchor.environment !== 'BETA') throw new Error();
    return s;
  } catch { return artifactFailure('INVALID_GUIDE_ARTIFACT_SCOPE'); }
}

/** Owner-specific mTLS RPCs only. No database sharing, JWT decoding, implicit
 * draft grant or public response flag can authorize signing an issued guide. */
export class PrivateGuideArtifactOwner implements GuideArtifactOwner {
  constructor(private readonly identity: Pick<B2bIdentityHttp, 'authenticate'>,
    private readonly identityHttp: Pick<B2bPrivateHttp, 'post'>,
    private readonly billingHttp: Pick<B2bPrivateHttp, 'post'>) {}
  async current(input: GuideArtifactScope, access: GuideArtifactAccess, action: GuideArtifactAction): Promise<GuideArtifactOwned> {
    const scope = validateGuideArtifactScope(input);
    if (!access || !['SERVICE', 'USER'].includes(access.kind) || typeof access.token !== 'string' ||
      !/^[A-Za-z0-9._~-]{1,8192}$/.test(access.token) || !['ISSUE', 'READ'].includes(action))
      artifactFailure('GUIDE_ARTIFACT_ACCESS_DENIED');
    try {
      const required = [...(action === 'ISSUE' ? b2bGuideIssueScopes : b2bGuideIssueReadScopes)];
      const authorize = async () => {
        const p = await this.identity.authenticate(access.token, required, access.kind);
        if (!validB2bPrincipal(p) || p.kind !== access.kind || required.some(s => !p.scopes.includes(s)) ||
          !b2bBindingsContain(p.bindings, scope.binding.draft.anchor)) throw new Error();
        const r = boundedSupplementJson(await this.identityHttp.post('/internal/b2b/authorize-guide-issue',
          { binding: scope.binding, kind: access.kind, action }, access.token)) as any;
        if (!r || Object.keys(r).sort().join(',') !== 'action,actor,binding,candidateOnly,capability,clientRevision,fiscalExecutionEnabled,grantRevision,schemaVersion,transmissionAuthorized' ||
          r.schemaVersion !== 'factuez.b2b.guide-issue-authorization.v1' || r.action !== action || r.capability !== 'BETA_GUIDE_ISSUE_LOCAL' ||
          !validB2bGuideIssueBinding(r.binding) || b2bGuideIssueBindingKey(r.binding) !== b2bGuideIssueBindingKey(scope.binding) ||
          r.clientRevision !== p.revision || !Number.isSafeInteger(r.grantRevision) || r.grantRevision < 1 || r.grantRevision > 2147483647 ||
          r.candidateOnly !== true || r.fiscalExecutionEnabled !== false || r.transmissionAuthorized !== false) throw new Error();
        const a = r.actor, b = a?.b2b, s = a?.scope, d = scope.binding.draft;
        if (!a || Object.keys(a).sort().join(',') !== 'b2b,scope,userId' || !b ||
          Object.keys(b).sort().join(',') !== 'clientId,kind,revision,subjectId,userAuthRevision' ||
          b.kind !== p.kind || b.clientId !== p.clientId || b.revision !== p.revision || b.subjectId !== p.subjectId ||
          b.userAuthRevision !== p.userAuthRevision || a.userId !== (p.kind === 'USER' ? p.subjectId : null) || !s ||
          Object.keys(s).sort().join(',') !== 'branchIds,emissionPointIds,kind,series' || s.kind !== 'ASSIGNED' ||
          !Array.isArray(s.branchIds) || s.branchIds.length !== 1 || s.branchIds[0] !== d.anchor.branchId ||
          !Array.isArray(s.emissionPointIds) || s.emissionPointIds.length !== 1 || s.emissionPointIds[0] !== d.anchor.pointId ||
          !Array.isArray(s.series) || s.series.length !== 3 || new Set(s.series).size !== 3 ||
          ![d.anchor.seriesId, d.guideSeriesId, scope.binding.fiscalSeriesId].every(id => s.series.includes(id))) throw new Error();
        return fiscalSnapshotSha256({ principal: p, proof: r });
      };
      const authorizationSha256 = await authorize();
      const issuance = validateGuideIssuanceResponse(await this.billingHttp.post('/internal/b2b/read-guide-issuance',
        { ...scope, kind: access.kind }, access.token), scope.binding, scope.draftId, scope.operationId);
      if (await authorize() !== authorizationSha256) artifactFailure('GUIDE_ARTIFACT_OWNER_CHANGED');
      return { issuance, authorizationSha256 };
    } catch (e) {
      if (e instanceof GuideArtifactError) throw e;
      return artifactFailure('GUIDE_ARTIFACT_OWNER_UNAVAILABLE_OR_DENIED');
    }
  }
}
