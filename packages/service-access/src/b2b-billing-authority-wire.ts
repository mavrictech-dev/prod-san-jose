import { createHash } from 'node:crypto';
import { PermissionCodes, type AccessTokenClaims } from '@factuez/contracts';
import { B2bSecurityError, validB2bBinding, validB2bPrincipal, b2bBindingsContain,
  type B2bBinding, type B2bPrincipal, type B2bIdentityScope } from '@factuez/contracts/b2b-security';
import { adminDigest, adminSnapshot } from './b2b-phase8-admin-wire';
import { currentGlobalClaims } from './b2b-owner-administration';


export const billingAuthoritySchema = 'factuez.b2b.billing-authority.v1' as const;
export const billingAuthorityPath = '/internal/b2b/billing-authority';
export const billingPermissionPolicy = {
  CUSTOMERS_LIST: [['b2b:customers:read'], ['document.view']],
  CUSTOMERS_DETAIL: [['b2b:customers:read'], ['document.view']],
  CUSTOMERS_CREATE: [['b2b:customers:write'], ['document.issue']],
  CUSTOMERS_UPDATE: [['b2b:customers:write'], ['document.issue']],
  PRODUCTS_LIST: [['b2b:products:read'], ['document.view']],
  PRODUCTS_CREATE: [['b2b:products:write'], ['product.manage']],
  PRODUCTS_UPDATE: [['b2b:products:write'], ['product.manage']],
  SHIFTS_LIST: [['b2b:shifts:read'], ['report.view']],
  SHIFTS_OPEN: [['b2b:shifts:write'], ['shift.open','shift.close']],
  SHIFTS_CLOSE: [['b2b:shifts:write'], ['shift.open','shift.close']],
  SHIFTS_CASH: [['b2b:shifts:write','b2b:cash:write'], ['shift.open','shift.close']],
  REPORTS_SUMMARY: [['b2b:reports:read','b2b:customers:read','b2b:products:read','b2b:shifts:read'], ['report.view','document.view']],
  ESTABLISHMENTS: [['b2b:masters:manage'], ['setup.manage','series.manage']],
} as const;
export type BillingPermissionAction = keyof typeof billingPermissionPolicy;
export const billingPermissionFailure = (status = 503): never => { throw new B2bSecurityError(status,'BILLING_CURRENT_AUTHORITY_REQUIRED'); };
export const billingDigest = adminDigest;
export const billingSnapshot = adminSnapshot;
export const billingHash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export function billingPolicy(action: unknown) {
  if (typeof action !== 'string' || !Object.hasOwn(billingPermissionPolicy,action)) return billingPermissionFailure(400);
  return billingPermissionPolicy[action as BillingPermissionAction] as readonly [readonly B2bIdentityScope[], readonly string[]];
}
export function billingAdminAction(action: BillingPermissionAction) {
  return action === 'ESTABLISHMENTS' || action === 'PRODUCTS_CREATE' || action === 'PRODUCTS_UPDATE';
}
export interface BillingAuthorityRequest {
  action: 'AUTHORIZE'; requestId: string; operation: BillingPermissionAction; binding: B2bBinding;
}
export interface BillingAuthorityReceipt {
  schemaVersion: typeof billingAuthoritySchema; requestSha256: string; principal: B2bPrincipal;
  permissions: string[]; administrator: AccessTokenClaims | null; stepUpVerified: boolean;
  revision: string; expiresAt: number;
}
export function billingReceipt(value: unknown, request: BillingAuthorityRequest): BillingAuthorityReceipt {
  const r = billingSnapshot(value) as BillingAuthorityReceipt;
  const [scopes,permissions] = billingPolicy(request.operation);
  if (!r || Object.keys(r).sort().join(',') !== 'administrator,expiresAt,permissions,principal,requestSha256,revision,schemaVersion,stepUpVerified' ||
      r.schemaVersion !== billingAuthoritySchema || r.requestSha256 !== billingDigest(request) || !validB2bBinding(request.binding) ||
      !validB2bPrincipal(r.principal) || r.principal.kind !== 'USER' || !b2bBindingsContain(r.principal.bindings,request.binding) ||
      scopes.some(s=>!r.principal.scopes.includes(s)) || !Array.isArray(r.permissions) || r.permissions.length > Object.keys(PermissionCodes).length ||
      new Set(r.permissions).size !== r.permissions.length || r.permissions.some(p=>!Object.values(PermissionCodes).includes(p as any)) ||
      permissions.some(p=>!r.permissions.includes(p)) || typeof r.revision !== 'string' || !/^[a-f0-9]{64}$/.test(r.revision) ||
      !Number.isSafeInteger(r.expiresAt) || r.expiresAt <= Date.now() || r.expiresAt > Date.now()+30000) return billingPermissionFailure();
  if (billingAdminAction(request.operation)) {
    if (r.stepUpVerified !== true || !currentGlobalClaims(r.administrator) || r.administrator.sub !== r.principal.subjectId ||
        r.administrator.authVersion !== r.principal.userAuthRevision ||
        billingDigest([...r.administrator.permissions].sort()) !== billingDigest([...r.permissions].sort())) return billingPermissionFailure();
  } else if (r.administrator !== null || r.stepUpVerified !== false) return billingPermissionFailure();
  return r;
}
