/** Shared verified-principal vocabulary. Never deserialize this from a public request body. */
export const B2bPhase2Scopes = ['b2b:context:read', 'b2b:catalog:read'] as const;
export const B2bReadScopes = [...B2bPhase2Scopes, 'b2b:documents:read', 'b2b:artifacts:read'] as const;
export const B2bExtractionScopes = [...B2bReadScopes,'b2b:exports:create','b2b:exports:read','b2b:changes:read'] as const;
// Vocabulary ceiling, not automatic activation. Identity still defaults to Phase2Scopes.
// Explicitly authorized vocabulary only. No defaults, persisted grants or clients are changed.
export const B2bPhase8Scopes = ['b2b:customers:read','b2b:customers:write','b2b:products:read','b2b:products:write',
  'b2b:shifts:read','b2b:shifts:write','b2b:cash:write','b2b:received:write','b2b:received:sync','b2b:received:configure',
  'b2b:reports:read','b2b:reports:export','b2b:history:read','b2b:masters:manage','b2b:identity:manage',
  'b2b:branding:manage','b2b:fiscal-config:read','b2b:fiscal-config:write','b2b:email:send','b2b:email:read','b2b:mail-config:manage'] as const;
export const B2bEnabledIdentityScopes = [...B2bExtractionScopes, 'b2b:drafts:write', 'b2b:operations:read', 'b2b:documents:issue', 'b2b:webhooks:read', 'b2b:webhooks:manage', 'b2b:sales-notes:read', 'b2b:sales-notes:write', 'b2b:corrections:read', 'b2b:corrections:write', 'b2b:guides:read', 'b2b:guides:write', 'b2b:guide-operations:read', 'b2b:guides:issue', 'b2b:batches:read', 'b2b:batches:write', 'b2b:received:read', 'b2b:received:artifacts:read',...B2bPhase8Scopes] as const;
export type B2bIdentityScope = typeof B2bEnabledIdentityScopes[number];
export interface B2bBinding {
  issuerId: number;
  issuerRuc: string;
  environment: 'BETA';
  branchId: string;
  pointId: string;
  seriesId: string;
  documentType: '01' | '03';
}
export interface B2bPrincipal {
  kind: 'SERVICE' | 'USER'; clientId: string; revision: number;
  subjectId: string | null; userAuthRevision: number | null;
  scopes: B2bIdentityScope[]; bindings: B2bBinding[]; environment: 'BETA';
}
export class B2bSecurityError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export function validB2bPrincipal(value: unknown): value is B2bPrincipal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as B2bPrincipal;
  return Object.keys(p).sort().join(',') === 'bindings,clientId,environment,kind,revision,scopes,subjectId,userAuthRevision' &&
    uuid(p.clientId) && Number.isSafeInteger(p.revision) && p.revision > 0 && p.environment === 'BETA' &&
    (p.kind === 'SERVICE' ? p.subjectId === null && p.userAuthRevision === null : p.kind === 'USER' && uuid(p.subjectId) && Number.isSafeInteger(p.userAuthRevision) && Number(p.userAuthRevision) >= 0) &&
    Array.isArray(p.scopes) && p.scopes.length > 0 && p.scopes.length <= B2bEnabledIdentityScopes.length && new Set(p.scopes).size === p.scopes.length &&
    p.scopes.every(scope => B2bEnabledIdentityScopes.includes(scope)) && Array.isArray(p.bindings) && p.bindings.length > 0 && p.bindings.length <= 500 &&
    p.bindings.every(validB2bBinding) && new Set(p.bindings.map(b2bBindingKey)).size === p.bindings.length;
}
const uuid = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export function validB2bBinding(value: unknown): value is B2bBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join(',') === 'branchId,documentType,environment,issuerId,issuerRuc,pointId,seriesId' &&
    Number.isSafeInteger(row.issuerId) && Number(row.issuerId) > 0 && Number(row.issuerId) <= 2147483647 &&
    typeof row.issuerRuc === 'string' && /^[0-9]{11}$/.test(row.issuerRuc) &&
    row.environment === 'BETA' && ['01', '03'].includes(String(row.documentType)) &&
    [row.branchId, row.pointId, row.seriesId].every(uuid);
}
export function b2bBindingKey(value: B2bBinding): string {
  return JSON.stringify([value.issuerId, value.issuerRuc, value.environment, value.branchId, value.pointId, value.seriesId, value.documentType]);
}
export function b2bBindingsContain(bindings: readonly B2bBinding[], resource: B2bBinding): boolean {
  return validB2bBinding(resource) && bindings.some(binding => validB2bBinding(binding) && b2bBindingKey(binding) === b2bBindingKey(resource));
}
/** Separate paired permission. Never widen the 01/03 principal or infer a note grant from its label. */
export interface B2bCorrectionBinding {
  reference: B2bBinding;
  noteSeriesId: string;
  noteType: '07' | '08';
}
export function validB2bCorrectionBinding(value: unknown): value is B2bCorrectionBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as B2bCorrectionBinding;
  return Object.keys(row).sort().join(',') === 'noteSeriesId,noteType,reference' &&
    validB2bBinding(row.reference) && uuid(row.noteSeriesId) &&
    row.noteSeriesId !== row.reference.seriesId && ['07', '08'].includes(row.noteType);
}
export function b2bCorrectionBindingKey(value: B2bCorrectionBinding): string {
  return JSON.stringify([b2bBindingKey(value.reference), value.noteSeriesId, value.noteType]);
}
