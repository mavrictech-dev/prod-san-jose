import { createCarrierGuide31Profile, validateCarrierGuideInput, type CarrierGuideBody,
  type CarrierGuideXml, type CarrierReference09Evidence } from '@factuez/sunat-core/dist/carrier-guide-profile';
import { boundedSupplementJson } from '@factuez/sunat-core/dist/fiscal-supplement-command';
import { fiscalSnapshotSha256 as hash, fiscalTimestamp } from '@factuez/sunat-core/dist/fiscal-note';
import { b2bUuid } from '@factuez/contracts/b2b-read-query';
import { artifactFailure, validateGuideArtifactScope, type GuideArtifactScope, type GuideArtifactAccess, type GuideArtifactAction,
  type GuideArtifactOwner } from './guide-artifact-owner';

type Snapshot = { schemaVersion: 'factuez.carrier-issued-local.v1'; documentId: string; operationId: string;
  binding: GuideArtifactScope['binding']; draftId: string; draftRevision: number; issuer: { ruc: string; legalName: string };
  series: string; number: string; fullNumber: string; body: CarrierGuideBody; bodySha256: string; contextSha256: string; at: string;
  candidateOnly: true; fiscalExecutionEnabled: false; transmissionAuthorized: false; authorizedForTransfer: false;
  officialRulesValidated: false; officialCdrVerified: false; numberReserved: true };
export type CarrierArtifactIssuance = { schemaVersion: 'factuez.b2b.carrier-guide-issuance.v1'; operationId: string; draftId: string;
  binding: GuideArtifactScope['binding']; snapshot: Snapshot; snapshotSha256: string; replayed: boolean };
export type CarrierArtifactOwned = { issuance: CarrierArtifactIssuance; authorizationSha256: string; referenceSha256: string };
/** Explicit private owner capability. Its implementation authenticates ISSUE or
 * READ and obtains the full immutable receipt/reference in the owner transaction.
 * Never wire it to a request's echoed snapshot, XML or accepted flag. */
export interface CarrierArtifactSource {
  artifactCurrent(scope: GuideArtifactScope, access: GuideArtifactAccess, action: GuideArtifactAction): Promise<{
    issuance: unknown; authorizationSha256: string; reference: CarrierReference09Evidence;
  }>;
}
const rendered = new WeakMap<object, CarrierGuideXml>();
const FLAGS = { candidateOnly:true, fiscalExecutionEnabled:false, transmissionAuthorized:false, authorizedForTransfer:false,
  officialRulesValidated:false, officialCdrVerified:false, numberReserved:true };
function exact(v: any, keys: string[]) { if (!v || typeof v !== 'object' || Array.isArray(v) ||
  Object.keys(v).sort().join(',') !== [...keys].sort().join(',')) throw new Error(); }
export function validateCarrierArtifactIssuance(value: unknown, scope: GuideArtifactScope): CarrierArtifactIssuance {
  try {
    const r = boundedSupplementJson(value) as CarrierArtifactIssuance, s = r.snapshot;
    exact(r,['schemaVersion','operationId','draftId','binding','snapshot','snapshotSha256','replayed']);
    exact(s,['schemaVersion','documentId','operationId','binding','draftId','draftRevision','issuer','series','number','fullNumber',
      'body','bodySha256','contextSha256','at',...Object.keys(FLAGS)]);
    if (r.schemaVersion !== 'factuez.b2b.carrier-guide-issuance.v1' || s.schemaVersion !== 'factuez.carrier-issued-local.v1' ||
      scope.binding.draft.guideType !== '31' || r.operationId !== scope.operationId || s.operationId !== r.operationId ||
      r.draftId !== scope.draftId || s.draftId !== r.draftId || !b2bUuid(s.documentId) || typeof r.replayed !== 'boolean' ||
      hash(r.binding) !== hash(scope.binding) || hash(s.binding) !== hash(scope.binding) ||
      !Number.isSafeInteger(s.draftRevision) || s.draftRevision < 1 || s.draftRevision > 2147483647 ||
      s.fullNumber !== `${s.series}-${s.number}` || r.snapshotSha256 !== hash(s) || s.bodySha256 !== hash(s.body) ||
      !/^[a-f0-9]{64}$/.test(s.contextSha256) || Object.entries(FLAGS).some(([k,v]) => s[k as keyof Snapshot] !== v)) throw new Error();
    fiscalTimestamp(s.at,'at'); if (new Date(s.at).toISOString() !== s.at || s.at < s.body.issueDate) throw new Error();
    validateCarrierGuideInput({ schemaVersion:'factuez.carrier-guide-input.v1', companyId:scope.binding.draft.anchor.issuerId,
      branchId:scope.binding.draft.anchor.branchId, documentId:s.documentId, operationId:s.operationId, issuer:s.issuer,
      documentType:'31', series:s.series, number:s.number, body:s.body, snapshotSha256:r.snapshotSha256 });
    return r;
  } catch { return artifactFailure('GUIDE_ARTIFACT_INVALID_CARRIER_OWNER'); }
}
export function isSealedCarrierArtifactOwned(value: unknown): value is CarrierArtifactOwned {
  return !!value && typeof value === 'object' && rendered.has(value);
}
export function cloneSealedCarrierArtifactOwned(value: CarrierArtifactOwned): CarrierArtifactOwned {
  const xml = rendered.get(value); if (!xml) artifactFailure('GUIDE_ARTIFACT_UNVERIFIED_CARRIER_OWNER');
  const copy = boundedSupplementJson(value) as CarrierArtifactOwned;
  rendered.set(copy, xml!); return copy;
}
export function carrierArtifactNumbered(value: CarrierArtifactOwned, scope: GuideArtifactScope) {
  const xml = rendered.get(value); if (!xml) artifactFailure('GUIDE_ARTIFACT_UNVERIFIED_CARRIER_OWNER');
  const response = validateCarrierArtifactIssuance(value.issuance,scope);
  if (xml!.snapshotSha256 !== response.snapshotSha256 || xml!.documentId !== response.snapshot.documentId ||
    xml!.operationId !== response.operationId || xml!.fullNumber !== response.snapshot.fullNumber) artifactFailure('GUIDE_ARTIFACT_INVALID_CARRIER_OWNER');
  return { response, rendered: structuredClone(xml!) };
}
/** Builds XML independently from the complete owned snapshot + authenticated
 * reference. The executable capability is sealed in-process, never deserialized
 * from HTTP. Rechecks both ownership and reference version before returning. */
export class CarrierGuideArtifactOwner implements GuideArtifactOwner {
  constructor(private readonly source: CarrierArtifactSource) {}
  async current(input: GuideArtifactScope, access: GuideArtifactAccess, action: GuideArtifactAction): Promise<CarrierArtifactOwned> {
    const scope = validateGuideArtifactScope(input);
    try {
      const raw = await this.source.artifactCurrent(scope,access,action), issuance = validateCarrierArtifactIssuance(raw.issuance,scope);
      if (!/^[a-f0-9]{64}$/.test(raw.authorizationSha256)) throw new Error();
      const reference = boundedSupplementJson(raw.reference) as CarrierReference09Evidence, referenceSha256 = hash(reference), s = issuance.snapshot;
      const xml = await createCarrierGuide31Profile({ loadAcceptedReference09: async () => structuredClone(reference) }).buildXml({
        schemaVersion:'factuez.carrier-guide-input.v1', companyId:scope.binding.draft.anchor.issuerId, branchId:scope.binding.draft.anchor.branchId,
        documentId:s.documentId, operationId:s.operationId, issuer:s.issuer, documentType:'31', series:s.series, number:s.number,
        body:s.body, snapshotSha256:issuance.snapshotSha256 });
      const again = await this.source.artifactCurrent(scope,access,action);
      if (hash(validateCarrierArtifactIssuance(again.issuance,scope)) !== hash(issuance) || again.authorizationSha256 !== raw.authorizationSha256 ||
        hash(again.reference) !== referenceSha256) artifactFailure('GUIDE_ARTIFACT_OWNER_CHANGED');
      const result = { issuance, authorizationSha256:raw.authorizationSha256, referenceSha256 };
      rendered.set(result,xml); return result;
    } catch { return artifactFailure('GUIDE_ARTIFACT_INVALID_CARRIER_OWNER'); }
  }
}
