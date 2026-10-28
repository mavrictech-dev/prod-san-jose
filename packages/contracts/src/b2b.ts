/** Design-time contract. This module neither authenticates callers nor enables routes. */
import inventory from './b2b-inventory.v1.json';

export const B2bContractVersion = 'factuez.b2b.v1' as const;
export const B2bAudience = 'factuez-b2b-v1' as const;
export const B2bContractState = 'DESIGN_ONLY_NOT_IMPLEMENTED' as const;
export const B2bEnvironments = ['BETA'] as const;
export const B2bOperationStates = [
  'RECEIVED', 'VALIDATING', 'COMMITTED', 'WAITING_EXTERNAL', 'SUCCEEDED',
  'FAILED', 'UNKNOWN_REQUIRES_RECONCILIATION',
] as const;
export type B2bOperationState = typeof B2bOperationStates[number];
export const B2bErrorCodes = [
  'UNAUTHENTICATED', 'AUDIENCE_INVALID', 'FORBIDDEN', 'RESOURCE_NOT_FOUND',
  'INVALID_REQUEST', 'ENVIRONMENT_NOT_ALLOWED', 'IDEMPOTENCY_CONFLICT',
  'REVISION_CONFLICT', 'DOCUMENT_IMMUTABLE', 'PROFILE_NOT_ENABLED',
  'ARTIFACT_NOT_AVAILABLE', 'RATE_LIMITED', 'OWNER_UNAVAILABLE',
  'RECONCILIATION_REQUIRED', 'NOT_IMPLEMENTED',
] as const;
export type B2bFeature = typeof inventory.features[number];
export function b2bInventory(): typeof inventory {
  return structuredClone(inventory);
}
/** Proposed scopes are vocabulary, NOT grants, token claims or executable authorization. */
export function b2bScopeCatalog(): string[] {
  return [...new Set(inventory.features.flatMap(feature => feature.scopes))].sort();
}

export type B2bActorReference =
  | { kind: 'SERVICE'; clientId: string; grantRevision: string }
  | { kind: 'USER'; clientId: string; subjectId: string; grantRevision: string; userAuthRevision: string };
/** Produced only after verified authentication in B2B-02; never accepted from request JSON. */
export interface B2bVerifiedCommandContext {
  actor: B2bActorReference;
  audience: typeof B2bAudience;
  environment: 'BETA';
  commandId: string;
  requestId: string;
  idempotencyKey: string;
  canonicalBodySha256: string;
}
export interface B2bOperationReference {
  schemaVersion: typeof B2bContractVersion;
  operationId: string;
  commandId: string;
  requestId: string;
  state: B2bOperationState;
  environment: 'BETA';
  /** A committed local command is NOT a verified SUNAT acceptance. */
  fiscalAcceptance: 'NOT_ASSERTED';
}

/** Descriptive invariants, consumed by the audit/tests; no runtime enforcement claimed. */
export const B2bRequiredInvariants = {
  existingReadOnlyAudienceUnchanged: true,
  ownerAuthorizationRequired: true,
  clientAndUserPermissionsIntersect: true,
  canonicalResourceHierarchyRequired: true,
  productionExcluded: true,
  fiscalActivationUnchanged: true,
  ownerTransactionalDeduplicationRequired: true,
  queuedEffectsReauthorize: true,
  issuedFiscalFactsImmutable: true,
  independentOutboxFanoutRequired: true,
  originalArtifactsPreserved: true,
  batchArtifactsRequireAllMembers: true,
  callbacksRequireVerifiedDestination: true,
} as const;
