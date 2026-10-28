/**
 * Contrato de autorización compartido por el emisor de tokens y los servicios
 * protegidos. No contiene lógica de infraestructura ni secretos.
 */
export const RoleCodes = {
  ADMIN: "ADMIN",
  STATION_MANAGER: "STATION_MANAGER",
  CASHIER: "CASHIER",
  TRACK_OPERATOR: "TRACK_OPERATOR",
  AUDITOR: "AUDITOR",
} as const;

export type RoleCode = (typeof RoleCodes)[keyof typeof RoleCodes];

export const PermissionCodes = {
  SETUP_MANAGE: "setup.manage",
  USER_MANAGE: "user.manage",
  ROLE_MANAGE: "role.manage",
  PRODUCT_MANAGE: "product.manage",
  SERIES_MANAGE: "series.manage",
  SUNAT_CONFIGURE: "sunat.configure",
  DOCUMENT_ISSUE: "document.issue",
  DOCUMENT_VIEW: "document.view",
  DOCUMENT_RETRY: "document.retry",
  DOCUMENT_EMAIL: "document.email",
  SHIFT_OPEN: "shift.open",
  SHIFT_CLOSE: "shift.close",
  REPORT_VIEW: "report.view",
  REPORT_EXPORT: "report.export",
  AUDIT_VIEW: "audit.view",
} as const;

export type PermissionCode =
  (typeof PermissionCodes)[keyof typeof PermissionCodes];

/** Claims mínimos de un access token RS256 emitido por identity-service. */
export interface AccessTokenClaims {
  sub: string;
  username: string;
  roles: RoleCode[];
  permissions: PermissionCode[];
  /** Compatibilidad de transporte; la autorización usa scope explícito. */
  emissionPointIds?: string[];
  scope: AccessScope;
  authVersion: number;
  /** Sesión web opaca validada por Identity; no es una credencial de renovación. */
  browserSessionId?: string;
  fullName?: string;
  iss: string;
  aud: string | string[];
  exp: number;
  iat: number;
}

export const DefaultRolePermissions: Record<
  RoleCode,
  readonly PermissionCode[]
> = {
  [RoleCodes.ADMIN]: Object.values(PermissionCodes),
  [RoleCodes.STATION_MANAGER]: [
    PermissionCodes.USER_MANAGE,
    PermissionCodes.ROLE_MANAGE,
    PermissionCodes.PRODUCT_MANAGE,
    PermissionCodes.SERIES_MANAGE,
    PermissionCodes.DOCUMENT_ISSUE,
    PermissionCodes.DOCUMENT_VIEW,
    PermissionCodes.DOCUMENT_RETRY,
    PermissionCodes.DOCUMENT_EMAIL,
    PermissionCodes.SHIFT_OPEN,
    PermissionCodes.SHIFT_CLOSE,
    PermissionCodes.REPORT_VIEW,
    PermissionCodes.REPORT_EXPORT,
  ],
  [RoleCodes.CASHIER]: [
    PermissionCodes.DOCUMENT_ISSUE,
    PermissionCodes.DOCUMENT_VIEW,
    PermissionCodes.DOCUMENT_EMAIL,
    PermissionCodes.SHIFT_OPEN,
    PermissionCodes.SHIFT_CLOSE,
  ],
  [RoleCodes.TRACK_OPERATOR]: [
    PermissionCodes.DOCUMENT_ISSUE,
    PermissionCodes.DOCUMENT_VIEW,
  ],
  [RoleCodes.AUDITOR]: [
    PermissionCodes.DOCUMENT_VIEW,
    PermissionCodes.REPORT_VIEW,
    PermissionCodes.AUDIT_VIEW,
  ],
};

export type AccessScope =
  | { kind: "GLOBAL" }
  | {
      kind: "ASSIGNED";
      branchIds: string[];
      emissionPointIds: string[];
      /** UUIDs externos de SeriesCounter; F001 no identifica un emisor. */
      series: string[];
    };

/** Las series asignadas se identifican por UUID de Billing, nunca por etiqueta. */
export function isSeriesCounterId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );
}

export function validScope(
  scope: unknown,
  roles: readonly string[],
): scope is AccessScope {
  if (!scope || typeof scope !== "object") return false;
  const value = scope as Partial<Extract<AccessScope, { kind: "ASSIGNED" }>>;
  if ((scope as { kind?: string }).kind === "GLOBAL")
    return roles.includes(RoleCodes.ADMIN);
  return (
    value.kind === "ASSIGNED" &&
    [value.branchIds, value.emissionPointIds, value.series].every(
      (ids) =>
        Array.isArray(ids) &&
        ids.every((id) => typeof id === "string" && id.length > 0),
    ) &&
    (value.series as string[]).every(isSeriesCounterId)
  );
}

export function allowsResource(
  scope: AccessScope | undefined,
  branchId: string,
  pointId?: string,
  seriesCounterId?: string,
) {
  if (!scope) return false;
  if (scope.kind === "GLOBAL") return true;
  return (
    scope.branchIds.includes(branchId) &&
    (pointId === undefined || scope.emissionPointIds.includes(pointId)) &&
    (seriesCounterId === undefined || scope.series.includes(seriesCounterId))
  );
}

export function canDelegate(
  actor: AccessTokenClaims,
  roles: readonly RoleCode[],
  scope: AccessScope,
): boolean {
  if (actor.scope.kind === "GLOBAL" && actor.roles.includes(RoleCodes.ADMIN))
    return true;
  if (scope.kind !== "ASSIGNED" || actor.scope.kind !== "ASSIGNED")
    return false;
  if (
    !scope.branchIds.length ||
    roles.some(
      (role) => role === RoleCodes.ADMIN || role === RoleCodes.STATION_MANAGER,
    )
  )
    return false;
  return (
    roles.every((role) =>
      DefaultRolePermissions[role]?.every((permission) =>
        actor.permissions.includes(permission),
      ),
    ) &&
    scope.branchIds.every(
      (id) =>
        actor.scope.kind === "ASSIGNED" && actor.scope.branchIds.includes(id),
    ) &&
    scope.emissionPointIds.every(
      (id) =>
        actor.scope.kind === "ASSIGNED" &&
        actor.scope.emissionPointIds.includes(id),
    ) &&
    scope.series.every(
      (id) =>
        actor.scope.kind === "ASSIGNED" && actor.scope.series.includes(id),
    )
  );
}

export function hasRequiredPermissions(
  granted: readonly PermissionCode[],
  required: readonly PermissionCode[],
): boolean {
  const grantedSet = new Set(granted);
  return required.every((permission) => grantedSet.has(permission));
}
