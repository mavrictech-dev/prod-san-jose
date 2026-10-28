/** Candidate owner bridge. No HTTP registration, env reads or credential I/O. */
import { createHash } from 'node:crypto';
import type { AccessTokenClaims, PermissionCode, RoleCode } from '@factuez/contracts';
import { B2bSecurityError, validB2bBinding, validB2bPrincipal, b2bBindingsContain,
  type B2bBinding, type B2bIdentityScope } from '@factuez/contracts/b2b-security';
import { correctionEvidenceFreeze } from './b2b-correction-evidence-wire';
import type { B2bIdentityPort } from './b2b-read-adapter';

export const phase8AdminPolicy = {
  MASTERS_READ: ['b2b:masters:manage','setup.manage'],
  ISSUER_CREATE: ['b2b:masters:manage','setup.manage'],
  ISSUER_UPDATE: ['b2b:masters:manage','setup.manage'],
  BRANCH_CREATE: ['b2b:masters:manage','setup.manage'],
  BRANCH_UPDATE: ['b2b:masters:manage','setup.manage'],
  POINT_CREATE: ['b2b:masters:manage','series.manage'],
  POINT_UPDATE: ['b2b:masters:manage','series.manage'],
  SERIES_CREATE: ['b2b:masters:manage','series.manage'],
  SERIES_UPDATE: ['b2b:masters:manage','series.manage'],
  USERS_LIST: ['b2b:identity:manage','user.manage'],
  USERS_CREATE: ['b2b:identity:manage','user.manage'],
  USERS_UPDATE: ['b2b:identity:manage','user.manage'],
  ROLES_LIST: ['b2b:identity:manage','role.manage'],
  ROLES_UPDATE: ['b2b:identity:manage','role.manage'],
  PRINT_READ: ['b2b:branding:manage','setup.manage'],
  PRINT_SAVE: ['b2b:branding:manage','setup.manage'],
  PRINT_PREVIEW: ['b2b:branding:manage','setup.manage'],
  FISCAL_READ: ['b2b:fiscal-config:read','sunat.configure'],
  FISCAL_AUDIT: ['b2b:fiscal-config:read','sunat.configure'],
  FISCAL_SAVE: ['b2b:fiscal-config:write','sunat.configure'],
  SMTP_READ: ['b2b:mail-config:manage','document.email'],
  SMTP_SAVE: ['b2b:mail-config:manage','document.email'],
} as const satisfies Record<string,readonly [B2bIdentityScope,PermissionCode]>;
export type Phase8AdminAction = keyof typeof phase8AdminPolicy;
export interface Phase8AdminAccess { token: string; kind: 'USER'|'SERVICE' }
export interface Phase8AdminInput { binding: B2bBinding; payload: Record<string,unknown>; id?: string }
export interface Phase8AdminResult<T = unknown> {
  data: T; candidateOnly: true; environment: 'BETA'; fiscalExecutionEnabled: false;
}
export interface PrivilegedHumanRequest {
  token: string; kind: 'USER'; action: Phase8AdminAction; binding: B2bBinding; payloadDigest: string; id?: string;
}
/** Trusted owner only: verifies an actual human, current owner policy and step-up.
 * Never construct claims or populate this decision from a public request body. */
export interface PrivilegedHumanAuthority {
  authorize(request: PrivilegedHumanRequest): Promise<{
    claims: AccessTokenClaims; policyRevision: string; stepUpVerified: true; expiresAt: number;
  }>;
}
/** Live Identity owner projection, including current roles/permissions. */
export interface Phase8LiveHumanIdentity { current(subjectId: string): Promise<AccessTokenClaims|null> }
export interface Phase8AdminBindingOwner {
  revalidate(binding: B2bBinding): Promise<{ binding: B2bBinding; revision: string }>;
}
export interface Phase8AdminDependencies {
  identity: B2bIdentityPort; authority?: PrivilegedHumanAuthority;
  liveIdentity?: Phase8LiveHumanIdentity; bindingOwner?: Phase8AdminBindingOwner; enabled?: boolean;
}
export const adminDenied = (status: number,code: string): never => { throw new B2bSecurityError(status,code); };
export function adminSnapshot<T>(value: T): T { return correctionEvidenceFreeze(value) as T; }
export function adminDigest(value: unknown): string {
  const sort = (v: any): any => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k,sort(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(sort(adminSnapshot(value)))).digest('hex');
}
export function adminInput(value: unknown): Phase8AdminInput {
  const v = adminSnapshot(value) as Phase8AdminInput;
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !['binding','payload','id'].includes(k)) ||
    !validB2bBinding(v.binding) || !v.payload || typeof v.payload !== 'object' || Array.isArray(v.payload) ||
    (v.id !== undefined && (typeof v.id !== 'string' || !v.id || v.id.length > 80))) return adminDenied(400,'INVALID_ADMIN_INPUT');
  return v;
}
function humanStamp(c: AccessTokenClaims) {
  return adminDigest({sub:c.sub,authVersion:c.authVersion,roles:c.roles,permissions:c.permissions,scope:c.scope});
}
function checkHuman(c: AccessTokenClaims|null,subject: string|null,revision: number|null,permission: PermissionCode) {
  if (!c || c.sub !== subject || c.authVersion !== revision || !Number.isSafeInteger(c.authVersion) || c.authVersion < 0 ||
    c.scope?.kind !== 'GLOBAL' || !Array.isArray(c.roles) || !c.roles.includes('ADMIN') ||
    !Array.isArray(c.permissions) || !c.permissions.includes(permission) ||
    !Number.isSafeInteger(c.exp) || c.exp * 1000 <= Date.now()) adminDenied(403,'CURRENT_GLOBAL_HUMAN_REQUIRED');
}
export class Phase8AdminOperation {
  private stamp: string|null = null;
  private closed = false;
  private readonly deadline = Date.now() + 30000;
  private constructor(private readonly deps: Phase8AdminDependencies,readonly access: Phase8AdminAccess,
    readonly action: Phase8AdminAction,readonly input: Phase8AdminInput) {}
  static async open(deps: Phase8AdminDependencies,access: Phase8AdminAccess,action: Phase8AdminAction,input: unknown) {
    if (deps.enabled !== true) return adminDenied(503,'ADMIN_OWNER_DISABLED');
    if (!Object.hasOwn(phase8AdminPolicy,action)) return adminDenied(400,'INVALID_ADMIN_ACTION');
    const a = adminSnapshot(access);
    if (!a || Object.keys(a).sort().join(',') !== 'kind,token' || a.kind !== 'USER' ||
      typeof a.token !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(a.token)) return adminDenied(403,'DELEGATED_HUMAN_REQUIRED');
    if (!deps.authority || !deps.liveIdentity || !deps.bindingOwner) return adminDenied(503,'ADMIN_AUTHORITY_UNAVAILABLE');
    const operation = new Phase8AdminOperation(deps,a,action,adminInput(input));
    await operation.revalidate(); return operation;
  }
  get payloadDigest() { return adminDigest(this.input.payload); }
  close() { this.closed = true; }
  async revalidate(): Promise<AccessTokenClaims> {
    if (this.deps.enabled !== true) return adminDenied(503,'ADMIN_OWNER_DISABLED');
    if (this.closed || Date.now() >= this.deadline) return adminDenied(401,'ADMIN_CAPABILITY_EXPIRED');
    const [scope,permission] = phase8AdminPolicy[this.action];
    const p = adminSnapshot(await this.deps.identity.authenticate(this.access.token,[scope],'USER'));
    if (!validB2bPrincipal(p) || p.kind !== 'USER' || !p.scopes.includes(scope) || !b2bBindingsContain(p.bindings,this.input.binding))
      return adminDenied(403,'ADMIN_BINDING_DENIED');
    const d = adminSnapshot(await this.deps.authority!.authorize({token:this.access.token,kind:'USER',action:this.action,
      binding:this.input.binding,payloadDigest:this.payloadDigest,...(this.input.id === undefined ? {} : {id:this.input.id})}));
    if (!d || d.stepUpVerified !== true || typeof d.policyRevision !== 'string' || !d.policyRevision.trim() ||
      !Number.isSafeInteger(d.expiresAt) || d.expiresAt <= Date.now()) return adminDenied(403,'ADMIN_STEP_UP_REQUIRED');
    const live = adminSnapshot(await this.deps.liveIdentity!.current(p.subjectId!));
    checkHuman(d.claims,p.subjectId,p.userAuthRevision,permission); checkHuman(live,p.subjectId,p.userAuthRevision,permission);
    if (humanStamp(d.claims) !== humanStamp(live!)) return adminDenied(401,'ADMIN_IDENTITY_CHANGED');
    if (this.action.startsWith('SMTP_') && !live!.permissions.includes('setup.manage')) return adminDenied(403,'ADMIN_PERMISSION_REQUIRED');
    const owner = adminSnapshot(await this.deps.bindingOwner!.revalidate(this.input.binding));
    if (!owner || !validB2bBinding(owner.binding) || adminDigest(owner.binding) !== adminDigest(this.input.binding) ||
      typeof owner.revision !== 'string' || !owner.revision) return adminDenied(403,'ADMIN_OWNER_BINDING_CHANGED');
    const stamp = adminDigest({principal:p,human:humanStamp(live!),policy:d.policyRevision,binding:owner});
    if (this.stamp !== null && this.stamp !== stamp) return adminDenied(401,'ADMIN_AUTHORITY_CHANGED');
    if (this.closed || Date.now() >= this.deadline) return adminDenied(401,'ADMIN_CAPABILITY_EXPIRED');
    this.stamp = stamp; return d.claims;
  }
}
export type Phase8AdminContextAction = 'FISCAL_READ'|'FISCAL_AUDIT'|'FISCAL_SAVE'|'SMTP_READ'|'SMTP_SAVE';
export interface Phase8AdminContextRequest { action: Phase8AdminContextAction; companyId: string; environment: string; payload: unknown }
export interface Phase8AdminOwnerContext { issuer: {companyId:number;ruc:string}; environment:'BETA'; actorId:string }
export interface Phase8AdminContextResolver {
  resolve(handle: object,request: Phase8AdminContextRequest): Promise<Phase8AdminOwnerContext>;
}
/** Nonserializable, request-local handles, revoked on every exit; never bearer credentials. */
export class Phase8AdminCapabilities implements Phase8AdminContextResolver, Phase8AdminUserResourceResolver {
  private readonly entries = new WeakMap<object,Phase8AdminOperation>();
  open(operation: Phase8AdminOperation): object {
    const handle = Object.freeze(Object.create(null)) as object;
    this.entries.set(handle,operation); return handle;
  }
  revoke(handle: object) { this.entries.delete(handle); }
  async validateUserResources(handle: object, request: Phase8AdminUserResourceRequest): Promise<void> {
    const op = this.entries.get(handle);
    if (!op || !['USERS_CREATE','USERS_UPDATE'].includes(op.action) || request.action !== op.action ||
      request.id !== op.input.id || adminDigest(request.payload) !== op.payloadDigest)
      return adminDenied(403,'INVALID_ADMIN_CAPABILITY');
    const actor = await op.revalidate();
    if (humanStamp(actor) !== humanStamp(request.actor) || this.entries.get(handle) !== op)
      return adminDenied(403,'INVALID_ADMIN_CAPABILITY');
    const selection = request.selection, binding = op.input.binding;
    // A real, current Billing owner proof covers exactly these resource IDs. No global catalogue is invented.
    for (const [ids,expected] of [[selection.branchIds,binding.branchId],
      [selection.emissionPointIds,binding.pointId],[selection.series,binding.seriesId]] as const) {
      if (!Array.isArray(ids) || ids.length > 1 || ids.some(id => id !== expected))
        return adminDenied(403,'ADMIN_USER_RESOURCES_OUTSIDE_BINDING');
    }
    if (!Array.isArray(selection.roles) || !selection.roles.length ||
      selection.roles.some(role => !['ADMIN','STATION_MANAGER','CASHIER','TRACK_OPERATOR','AUDITOR'].includes(role)))
      return adminDenied(403,'ADMIN_USER_RESOURCES_OUTSIDE_BINDING');
  }
  async resolve(handle: object,request: Phase8AdminContextRequest): Promise<Phase8AdminOwnerContext> {
    const op = this.entries.get(handle);
    if (!op || request.action !== op.action || op.input.id !== undefined ||
      request.companyId !== String(op.input.binding.issuerId) || request.environment !== 'BETA' ||
      adminDigest(request.payload) !== op.payloadDigest) return adminDenied(403,'INVALID_ADMIN_CAPABILITY');
    const actor = await op.revalidate();
    if (this.entries.get(handle) !== op) return adminDenied(403,'INVALID_ADMIN_CAPABILITY');
    return {issuer:{companyId:op.input.binding.issuerId,ruc:op.input.binding.issuerRuc},environment:'BETA',actorId:actor.sub};
  }
}
export function adminResult<T>(data: T): Phase8AdminResult<T> {
  return {data,candidateOnly:true,environment:'BETA',fiscalExecutionEnabled:false};
}


/** Allowlist projections only, including serialized dates. No owner records escape whole. */
export function adminPick(value: unknown,keys: readonly string[]): Record<string,any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return adminDenied(503,'INVALID_ADMIN_OWNER_RESPONSE');
  const row = value as Record<string,any>, result: Record<string,any> = {};
  for (const key of keys) if (Object.hasOwn(row,key) && row[key] !== undefined)
    result[key] = row[key] instanceof Date ? row[key].toISOString() : adminSnapshot(row[key]);
  return result;
}
/** Never return an owner's exception text, certificate paths, transport errors or secrets. */
export function adminOwnerError(error: unknown): B2bSecurityError {
  if (error instanceof B2bSecurityError && /^(ADMIN_|INVALID_ADMIN_|CURRENT_GLOBAL_|DELEGATED_HUMAN_)/.test(error.code)) return error;
  const e = error as {status?:number;getStatus?:()=>number};
  const status = typeof e?.getStatus === 'function' ? e.getStatus() : e?.status;
  return new B2bSecurityError([400,401,403,404,409,413,422,429].includes(Number(status)) ? Number(status) : 503,
    status === 409 ? 'ADMIN_OWNER_CONFLICT' : 'ADMIN_OWNER_REJECTED');
}



/** Public transport/factory ownership stays with Main. These types describe only the owner boundary.
 *
 * Id rules: ISSUER_UPDATE = decimal issuerId; BRANCH_UPDATE/POINT_CREATE = binding.branchId;
 * POINT_UPDATE/SERIES_CREATE = binding.pointId; SERIES_UPDATE = binding.seriesId;
 * ROLES_UPDATE = RoleCode; USERS_UPDATE = target user UUID. Other actions omit id. Read payloads are empty except
 * FISCAL_AUDIT, which requires {page:"1"}. Payloads go unchanged to the actual save core.
 *
 * Configure Fiscal/Smtp with one request capability vault per bridge:
 *   const caps = new Phase8AdminCapabilities();
 *   const service = FiscalConfigurationService.createWithOwnerContext(prisma,vault,inspector,caps);
 *   const bridge = new B2bPhase8FiscalAdmin(deps,service,caps);
 * SMTP uses the corresponding createWithOwnerContext(store,vault,transport,caps).
 * No default Nest provider or public factory is changed or registered by these modules.
 *
 * USERS_CREATE/UPDATE use UserAdministrationService.createWithOwnerResources(prisma,passwords,caps).
 * Its opaque resource proof admits only the exact branch/point/series from the current operation binding.
 * No reset, owner transfer, series rename/counter edit, fiscal removal/official activation,
 * SMTP removal/connection test/send action exists here.
 *
 * Rechecks bound responses to current authorization; they are not distributed rollback.
 * Fiscal additionally rechecks inside its existing transaction. A revocation after a committed
 * owner write can suppress the response but cannot undo an already committed master/logo/SMTP/role
 * write. Callers must reconcile owner revision after an ambiguous response; never blindly replay.
 * Existing optimistic revisions are retained; this bridge does not add idempotent replay.
 */
export type Phase8AdminEmptyPayload = Record<string,never>;
type MasterRevision = {expectedRevision:number};
type IssuerEditable = {legalName?:string;taxAddress?:string;ubigeo?:string;tradeName?:string|null;phone?:string|null;contactEmails?:string[];active?:boolean};
type MasterEditable = {code?:string;name?:string;address?:string|null;active?:boolean};
export interface Phase8AdminPayloadMap {
  MASTERS_READ: Phase8AdminEmptyPayload;
  ISSUER_CREATE: {ruc:string;legalName:string;taxAddress:string;ubigeo:string;tradeName?:string|null;phone?:string|null;contactEmails?:string[]};
  ISSUER_UPDATE: MasterRevision & IssuerEditable;
  BRANCH_CREATE: {companyId:number;code:string;name:string;address?:string|null};
  BRANCH_UPDATE: MasterRevision & MasterEditable;
  POINT_CREATE: {code:string;name:string;invoiceSeries:string;receiptSeries:string;address?:string|null;trackNumber?:number|null};
  POINT_UPDATE: MasterRevision & MasterEditable & {trackNumber?:number|null};
  SERIES_CREATE: {documentType:'INVOICE'|'SALES_RECEIPT'|'CREDIT_NOTE'|'DEBIT_NOTE'|'DESPATCH_ADVICE';series:string};
  SERIES_UPDATE: MasterRevision & {active:boolean};
  USERS_LIST: Phase8AdminEmptyPayload;
  USERS_CREATE: {username:string;fullName:string;password:string;roles:RoleCode[];branchIds:string[];emissionPointIds:string[];series:string[]};
  USERS_UPDATE: {active?:boolean;roles?:RoleCode[];branchIds?:string[];emissionPointIds?:string[];series?:string[]};
  ROLES_LIST: Phase8AdminEmptyPayload;
  ROLES_UPDATE: {permissions:PermissionCode[];expectedPermissions:PermissionCode[]};
  PRINT_READ: Phase8AdminEmptyPayload;
  PRINT_SAVE: import('@factuez/contracts').SavePrintSettingsRequest;
  PRINT_PREVIEW: import('@factuez/contracts').PrintPreviewRequest;
  FISCAL_READ: Phase8AdminEmptyPayload;
  FISCAL_AUDIT: {page:string};
  FISCAL_SAVE: {expectedRevision:number;certificate?:{fileName:string;base64:string;password:string};
    sol?:{username:string;password:string};gre?:{clientId:string;clientSecret:string}};
  SMTP_READ: Phase8AdminEmptyPayload;
  SMTP_SAVE: {expectedRevision:number;settings:{host:string;port:465|587;tlsMode:'TLS'|'STARTTLS';fromName:string;fromAddress:string;replyTo?:string|null};
    credentials?:{username:string;password:string}};
}
type Phase8AdminIdAction = 'ISSUER_UPDATE'|'BRANCH_UPDATE'|'POINT_CREATE'|'POINT_UPDATE'|'SERIES_CREATE'|'SERIES_UPDATE'|'ROLES_UPDATE'|'USERS_UPDATE';
export type Phase8AdminInputFor<A extends Phase8AdminAction> = {binding:B2bBinding;payload:Phase8AdminPayloadMap[A]} &
  (A extends Phase8AdminIdAction ? {id:string} : {id?:never});
export interface Phase8AdminUserResourceRequest {
  action: 'USERS_CREATE'|'USERS_UPDATE'; id?: string; payload: unknown; actor: AccessTokenClaims;
  selection: {roles:RoleCode[];branchIds:string[];emissionPointIds:string[];series:string[]};
}
export interface Phase8AdminUserResourceResolver {
  validateUserResources(handle:object,request:Phase8AdminUserResourceRequest):Promise<void>;
}
export interface Phase8AdminOwnerPort {
  execute(access:Phase8AdminAccess,action:Phase8AdminAction,input:unknown):Promise<Phase8AdminResult>;
}

