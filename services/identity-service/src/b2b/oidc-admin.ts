import { PermissionCodes } from '@factuez/contracts';
import { inspect } from 'node:util';
import type { UserPermissionsService } from '../application/user-permissions.service';
import type { PrismaService } from '../infrastructure/prisma.service';
import { B2bIdentityError, fail, plain, uuid, type AdminAuthority } from './model';
import type { ProviderIntrospection } from './oidc';

export const OidcB2bAdminAudience = 'factuez-b2b-admin' as const;
export const OidcB2bAdminScope = 'factuez.b2b.admin' as const;
const requiredPermissions = ['setup.manage', 'user.manage', 'role.manage'] as const;
const allowedScopes: readonly string[] = ['openid', 'profile', 'email', OidcB2bAdminScope];
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
  value.length <= 255 && value.trim() === value && !/[\x00-\x20\x7f]/.test(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) &&
  value.every(text) && new Set(value).size === value.length;
const seconds = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

export interface OidcAdminUser {
  userId: string;
  linkRevision: string;
  active: boolean;
  authVersion: number;
  roles: string[];
  permissions: string[];
  scope: { kind: 'GLOBAL' | 'ASSIGNED' };
}
/** Only an explicit issuer/subject/client mapping to an existing owner user may resolve. */
export interface UserDirectory {
  resolve(issuer: string, subject: string, oidcClientId: string): Promise<OidcAdminUser | null>;
}
export interface OidcB2bAdministratorOptions {
  issuer: string;
  clientId: string;
  acceptedAcr: readonly string[];
  provider: ProviderIntrospection;
  directory: UserDirectory;
  enabled?: boolean;
  /** Milliseconds since epoch, matching Date.now (not NumericDate seconds). */
  now?: () => number;
}

/** Inject the existing authenticated, fixed-HTTPS ProviderIntrospection implementation.
 * No discovery, JWT decoding, external role trust, SERVICE principal or password fallback. */
export class OidcB2bAdministrator implements AdminAuthority {
  toJSON(){return {service:'OidcB2bAdministrator',credentials:'PRIVATE'};}
  [inspect.custom](){return 'OidcB2bAdministrator { credentials: [PRIVATE] }';}
  private readonly issuer: string;
  private readonly clientId: string;
  private readonly acceptedAcr: ReadonlySet<string>;
  private readonly provider: ProviderIntrospection;
  private readonly directory: UserDirectory;
  private readonly enabled: boolean;
  private readonly now: () => number;

  constructor(options: OidcB2bAdministratorOptions) {
    const { issuer, clientId, acceptedAcr, provider, directory } = options;
    const url = new URL(issuer);
    if (typeof issuer !== 'string' || !issuer.startsWith('https://') || /\s|[?#]/.test(issuer) || url.protocol !== 'https:' ||
      !url.hostname || url.username || url.password) throw new Error('Fixed HTTPS OIDC admin issuer required');
    if (typeof clientId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(clientId)) throw new Error('Fixed OIDC admin client required');
    if (!Array.isArray(acceptedAcr) || !acceptedAcr.length || !strings(acceptedAcr)) throw new Error('Explicit nonempty OIDC admin ACR allowlist required');
    if (!provider || typeof provider.introspect !== 'function' || !directory || typeof directory.resolve !== 'function' ||
      (options.enabled !== undefined && typeof options.enabled !== 'boolean') ||
      (options.now !== undefined && typeof options.now !== 'function')) throw new Error('Invalid OIDC admin dependencies');
    this.issuer = issuer;
    this.clientId = clientId;
    this.acceptedAcr = new Set(acceptedAcr);
    this.provider = provider;
    this.directory = directory;
    this.enabled = options.enabled === true;
    this.now = options.now ?? Date.now;
  }

  private claims(value: unknown) {
    const ms = this.now(), now = Math.floor(ms / 1000);
    if (!Number.isSafeInteger(ms) || ms < 0) return fail(503, 'ADMIN_AUTHORITY_UNAVAILABLE');
    if (!plain(value) || value.active !== true || value.token_type !== 'Bearer' || value.iss !== this.issuer ||
      value.client_id !== this.clientId || !text(value.sub) ||
      !(value.aud === OidcB2bAdminAudience || strings(value.aud) && value.aud.includes(OidcB2bAdminAudience)) ||
      !seconds(value.iat) || !seconds(value.exp) || value.iat > now || value.exp <= now ||
      value.exp <= value.iat || value.exp - value.iat > 300 ||
      (value.nbf !== undefined && (!seconds(value.nbf) || value.nbf > now || value.nbf >= value.exp)) ||
      typeof value.scope !== 'string') return fail(401, 'INVALID_TOKEN');
    const scopes = value.scope.split(' ');
    if (!strings(scopes) || !scopes.includes(OidcB2bAdminScope) || scopes.some(scope => !allowedScopes.includes(scope))) return fail(401, 'INVALID_TOKEN');
    if (!seconds(value.auth_time) || value.auth_time > now || now - value.auth_time > 300 || value.auth_time > value.iat ||
      !strings(value.amr) || !value.amr.includes('mfa') || !text(value.acr) || !this.acceptedAcr.has(value.acr)) return fail(403, 'STEP_UP_REQUIRED');
    // Snapshot only validated authorization inputs; external roles/flags are never read.
    const validated = { active: true, token_type: 'Bearer', iss: this.issuer, client_id: this.clientId,
      sub: value.sub as string, aud: typeof value.aud === 'string' ? value.aud : [...value.aud],
      iat: value.iat, exp: value.exp, nbf: value.nbf, auth_time: value.auth_time,
      amr: [...value.amr], acr: value.acr, scope: value.scope };
    return { subject: value.sub as string, validated, fingerprint: JSON.stringify([
      value.iss, value.client_id, value.sub, typeof value.aud === 'string' ? [value.aud] : [...value.aud].sort(),
      value.iat, value.exp, value.nbf ?? null, value.auth_time, [...value.amr].sort(), value.acr, [...scopes].sort(),
    ]) };
  }

  private user(value: unknown) {
    if (!plain(value) || !uuid(value.userId) || !text(value.linkRevision) || value.active !== true ||
      !seconds(value.authVersion) || !strings(value.roles) || !strings(value.permissions) || !plain(value.scope) ||
      value.scope.kind !== 'GLOBAL' || !value.roles.includes('ADMIN') ||
      !requiredPermissions.every(permission => value.permissions.includes(permission))) return fail(403, 'FORBIDDEN');
    return { id: value.userId as string, fingerprint: JSON.stringify([
      value.userId, value.linkRevision, value.active, value.authVersion,
      [...value.roles].sort(), [...value.permissions].sort(), value.scope.kind,
    ]) };
  }

  async verify(accessToken: string): Promise<{ id: string; stepUpVerified: true }> {
    if (!this.enabled) return fail(503, 'OIDC_ADMIN_NOT_CONFIGURED');
    if (typeof accessToken !== 'string' || !/^[A-Za-z0-9._~-]{16,8192}$/.test(accessToken)) return fail(401, 'INVALID_TOKEN');
    try {
      const beforeClaims = this.claims(await this.provider.introspect(accessToken));
      const beforeUser = this.user(await this.directory.resolve(this.issuer, beforeClaims.subject, this.clientId));
      const afterClaims = this.claims(await this.provider.introspect(accessToken));
      if (beforeClaims.fingerprint !== afterClaims.fingerprint) return fail(401, 'USER_ACCESS_CHANGED');
      const afterUser = this.user(await this.directory.resolve(this.issuer, afterClaims.subject, this.clientId));
      if (beforeUser.fingerprint !== afterUser.fingerprint) return fail(401, 'USER_ACCESS_CHANGED');
      // The last directory await can outlive exp or the MFA freshness window.
      this.claims(afterClaims.validated);
      return { id: afterUser.id, stepUpVerified: true };
    } catch (error) {
      if (error instanceof B2bIdentityError) throw error;
      return fail(503, 'ADMIN_AUTHORITY_UNAVAILABLE');
    }
  }
}

interface AdminLinkRow {
  id: string;
  userId: string;
  enabled: boolean;
  userAuthRevision: number;
  linkRevision: string;
}
/** Candidate read-only adapter. Requires a separately provisioned B2bAdminOidcLink:
 * id/userId UUID (userId FK User.id), issuer/subject/oidcClientId explicit UNIQUE tuple,
 * enabled boolean, userAuthRevision integer authVersion stamp, revision positive bigint.
 * This module never creates the table, migrates, links by email/username or writes data. */
export class PostgresOidcAdminDirectory implements UserDirectory {
  toJSON(){return {service:'PostgresOidcAdminDirectory',credentials:'PRIVATE'};}
  [inspect.custom](){return 'PostgresOidcAdminDirectory { credentials: [PRIVATE] }';}
  constructor(private readonly db: Pick<PrismaService, '$queryRawUnsafe' | 'user'>,
    private readonly extra: Pick<UserPermissionsService, 'effective'>) {}

  private async read(issuer: string, subject: string, oidcClientId: string) {
    const rows = await this.db.$queryRawUnsafe<AdminLinkRow[]>(
      'SELECT "id","userId","enabled","userAuthRevision","revision"::text AS "linkRevision" FROM "B2bAdminOidcLink" WHERE "issuer"=$1 AND "subject"=$2 AND "oidcClientId"=$3',
      issuer, subject, oidcClientId);
    if (rows.length !== 1) return null;
    const link = { ...rows[0] };
    if (!uuid(link.id) || !uuid(link.userId) || link.enabled !== true || !seconds(link.userAuthRevision) ||
      typeof link.linkRevision !== 'string' || !/^[1-9][0-9]{0,18}$/.test(link.linkRevision)) return null;
    const user = await this.db.user.findUnique({ where: { id: link.userId }, select: {
      active: true, authVersion: true,
      roles: { select: { role: { select: { code: true, active: true,
        permissions: { select: { permission: { select: { code: true } } } } } } } },
    } });
    if (!user || user.active !== true || !seconds(user.authVersion) || user.authVersion !== link.userAuthRevision) return null;
    const roles = user.roles.map(row => row.role).filter(role => role.active === true);
    const permissions = [...new Set(roles.flatMap(role => role.permissions.map(row => PermissionCodes[row.permission.code])))].sort();
    if (!strings(permissions)) return fail(503, 'ADMIN_AUTHORITY_UNAVAILABLE');
    // Copy scalars and arrays before another await; fake/owner objects can be mutable.
    const result: OidcAdminUser = { userId: link.userId, linkRevision: `${link.id}:${link.linkRevision}`,
      active: roles.length > 0, authVersion: user.authVersion, roles: [...new Set(roles.map(role => role.code))].sort(),
      permissions, scope: { kind: roles.some(role => role.code === 'ADMIN') ? 'GLOBAL' : 'ASSIGNED' } };
    return result;
  }

  async resolve(issuer: string, subject: string, oidcClientId: string): Promise<OidcAdminUser | null> {
    const before = await this.read(issuer, subject, oidcClientId);
    if (!before) return null;
    const snapshot = JSON.stringify(before);
    const extra = await this.extra.effective(before.userId);
    if (!strings(extra)) return fail(503, 'ADMIN_AUTHORITY_UNAVAILABLE');
    const permissions = [...new Set([...before.permissions, ...extra])].sort();
    const after = await this.read(issuer, subject, oidcClientId);
    if (!after || snapshot !== JSON.stringify(after)) return fail(401, 'USER_ACCESS_CHANGED');
    return { ...after, permissions };
  }
}
