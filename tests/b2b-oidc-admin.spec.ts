import { describe, expect, it, vi } from 'vitest';
import {
  OidcB2bAdministrator, OidcB2bAdminAudience, OidcB2bAdminScope, PostgresOidcAdminDirectory,
  type OidcB2bAdministratorOptions, type OidcAdminUser, type UserDirectory,
} from '../services/identity-service/src/b2b/oidc-admin';
import type { ProviderIntrospection } from '../services/identity-service/src/b2b/oidc';
import { fixture as identityFixture, id, input, ctx, basic } from './b2b-identity.fixture';

const issuer = 'https://oidc.invalid/realms/factuez';
const clientId = 'factuez-admin-bff';
const acr = 'urn:factuez:acr:admin-mfa';
const accessToken = 'opaque-admin-token-0001';
const epoch = 1800000000;
const permissions = ['setup.manage', 'user.manage', 'role.manage'];
function adminFixture(overrides: Partial<OidcB2bAdministratorOptions> = {}) {
  let time = epoch * 1000;
  const claims: Record<string, unknown> = {
    active: true, token_type: 'Bearer', iss: issuer, sub: 'opaque-admin-subject', client_id: clientId,
    aud: OidcB2bAdminAudience, iat: epoch - 10, exp: epoch + 290, nbf: epoch - 10,
    auth_time: epoch - 30, amr: ['pwd', 'mfa'], acr, scope: `openid ${OidcB2bAdminScope}`,
  };
  const user: OidcAdminUser = { userId: id(9), linkRevision: 'link-1:1', active: true, authVersion: 3,
    roles: ['ADMIN'], permissions: [...permissions], scope: { kind: 'GLOBAL' } };
  const provider = { introspect: vi.fn<ProviderIntrospection['introspect']>(async () => structuredClone(claims)) };
  const directory = { resolve: vi.fn<UserDirectory['resolve']>(async () => structuredClone(user)) };
  const options: OidcB2bAdministratorOptions = { issuer, clientId, acceptedAcr: [acr], provider, directory,
    enabled: true, now: () => time, ...overrides };
  const authority = new OidcB2bAdministrator(options);
  return { authority, claims, user, provider, directory, options, advance: (ms: number) => { time += ms; } };
}
function coreFixture() {
  const o = adminFixture(), f = identityFixture();
  // Replace the fixture verifier completely: human-step-up must never bypass this authority.
  f.admin.verify.mockImplementation(token => o.authority.verify(token));
  return { ...o, ...f };
}

describe('B2B08 OIDC administrative configuration and step-up', () => {
  it('is disabled by default, without constructor or verify I/O or clock reads', async () => {
    const o = adminFixture(), now = vi.fn(() => epoch * 1000);
    const { enabled: _enabled, ...options } = o.options;
    const authority = new OidcB2bAdministrator({ ...options, now });
    expect(o.provider.introspect).not.toHaveBeenCalled();
    expect(o.directory.resolve).not.toHaveBeenCalled();
    await expect(authority.verify(accessToken)).rejects.toMatchObject({ status: 503, code: 'OIDC_ADMIN_NOT_CONFIGURED' });
    expect(o.provider.introspect).not.toHaveBeenCalled();
    expect(o.directory.resolve).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });
  it.each(['http://oidc.invalid', 'https://user:pass@oidc.invalid', 'https://oidc.invalid?x=1',
    'https://oidc.invalid#x', ' https://oidc.invalid', 'https://oidc.invalid?', 'https:oidc.invalid', ''])('rejects issuer %s', issuer => {
    const f = adminFixture();
    expect(() => new OidcB2bAdministrator({ ...f.options, issuer })).toThrow();
    expect(f.provider.introspect).not.toHaveBeenCalled();
  });
  it.each(['', 'two clients', 'admin/client', 'x'.repeat(121)])('rejects invalid fixed client %s', clientId => {
    expect(() => adminFixture({ clientId })).toThrow();
  });
  it.each([undefined, null, [], [''], [' '], [acr, acr], [7]])('requires an explicit valid ACR list %j', acceptedAcr => {
    expect(() => adminFixture({ acceptedAcr: acceptedAcr as unknown as string[] })).toThrow();
  });
  it('copies fixed configuration so later option/allowlist edits cannot broaden access', async () => {
    const acceptedAcr = [acr], f = adminFixture({ acceptedAcr });
    acceptedAcr.push('weak'); f.options.issuer = 'https://other.invalid'; f.options.clientId = 'other'; f.options.enabled = false;
    await expect(f.authority.verify(accessToken)).resolves.toEqual({ id: id(9), stepUpVerified: true });
    f.claims.acr = 'weak';
    await expect(f.authority.verify(accessToken)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });
  it('uses Date.now milliseconds by default', async () => {
    const f = adminFixture(), clock = vi.spyOn(Date, 'now').mockReturnValue(epoch * 1000);
    try {
      const { now: _now, ...options } = f.options;
      await expect(new OidcB2bAdministrator(options).verify(accessToken)).resolves.toMatchObject({ id: id(9) });
      expect(clock).toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });
  it.each(['', 'short', 'Bearer opaque-admin-token', 'human-step-up', 'x'.repeat(8193), 'bad token with spaces'])('rejects malformed token before I/O: %s', async token => {
    const f = adminFixture();
    await expect(f.authority.verify(token)).rejects.toMatchObject({ status: 401 });
    expect(f.provider.introspect).not.toHaveBeenCalled(); expect(f.directory.resolve).not.toHaveBeenCalled();
  });
  it('introspects twice and resolves only the exact fixed issuer/subject/client tuple', async () => {
    const f = adminFixture();
    await expect(f.authority.verify(accessToken)).resolves.toEqual({ id: id(9), stepUpVerified: true });
    expect(f.provider.introspect.mock.calls).toEqual([[accessToken], [accessToken]]);
    expect(f.directory.resolve.mock.calls).toEqual([[issuer, f.claims.sub, clientId], [issuer, f.claims.sub, clientId]]);
    expect(f.provider.introspect.mock.invocationCallOrder[0]).toBeLessThan(f.directory.resolve.mock.invocationCallOrder[0]);
    expect(f.directory.resolve.mock.invocationCallOrder[0]).toBeLessThan(f.provider.introspect.mock.invocationCallOrder[1]);
  });
  it.each([
    { active: false }, { active: 'true' }, { token_type: 'bearer' }, { token_type: 'Refresh' },
    { iss: issuer + '/' }, { iss: 'https://evil.invalid' }, { client_id: 'other-client' }, { sub: '' }, { sub: undefined },
    { aud: 'factuez-b2b-v1' }, { aud: 'factuez-services' }, { aud: `${OidcB2bAdminAudience} factuez-b2b-v1` },
    { aud: [] }, { aud: [OidcB2bAdminAudience, OidcB2bAdminAudience] }, { aud: [OidcB2bAdminAudience, 1] },
    { aud: { includes: OidcB2bAdminAudience } }, { aud: ['not-admin'] },
    { exp: epoch }, { exp: epoch - 1 }, { exp: epoch + 291 }, { exp: epoch - 10 }, { exp: undefined },
    { exp: String(epoch + 290) }, { exp: epoch + 0.5 }, { exp: Infinity },
    { iat: epoch + 1 }, { iat: undefined }, { iat: -1 }, { iat: epoch - 10.5 },
    { nbf: epoch + 1 }, { nbf: epoch + 290 }, { nbf: '1800000000' }, { nbf: -1 }, { nbf: null },
    { scope: 'openid profile email' }, { scope: `${OidcB2bAdminScope} b2b:identity:manage` },
    { scope: `${OidcB2bAdminScope} b2b:documents:read` }, { scope: `${OidcB2bAdminScope} integration:documents:read` },
    { scope: `${OidcB2bAdminScope} setup.manage` }, { scope: `${OidcB2bAdminScope} *` },
    { scope: `${OidcB2bAdminScope} ${OidcB2bAdminScope}` }, { scope: ` ${OidcB2bAdminScope}` },
    { scope: `${OidcB2bAdminScope} ` }, { scope: `openid  ${OidcB2bAdminScope}` },
    { scope: `openid\t${OidcB2bAdminScope}` }, { scope: [OidcB2bAdminScope] }, { scope: undefined },
  ])('denies invalid introspected authorization claims %j', async patch => {
    const f = adminFixture(); Object.assign(f.claims, patch);
    await expect(f.authority.verify(accessToken)).rejects.toMatchObject({ status: 401, code: 'INVALID_TOKEN' });
    expect(f.directory.resolve).not.toHaveBeenCalled();
  });
  it.each([null, [], 'signed.payload.signature', { active: true }, Object.create({ active: true })])('denies non-introspection responses %j', async value => {
    const f = adminFixture(); f.provider.introspect.mockResolvedValue(value);
    await expect(f.authority.verify(accessToken)).rejects.toMatchObject({ status: 401 });
  });
  it.each([
    { auth_time: undefined }, { auth_time: epoch - 301 }, { auth_time: epoch + 1 }, { auth_time: epoch - 9 },
    { auth_time: epoch - 30.5 }, { auth_time: String(epoch - 30) }, { auth_time: -1 },
    { amr: undefined }, { amr: 'mfa' }, { amr: [] }, { amr: ['pwd'] }, { amr: ['MFA'] },
    { amr: ['mfa', 1] }, { amr: ['mfa', 'mfa'] }, { acr: undefined }, { acr: 'weak' }, { acr: [acr] },
  ])('requires recent provider MFA with allowlisted ACR %j', async patch => {
    const f = adminFixture(); Object.assign(f.claims, patch);
    await expect(f.authority.verify(accessToken)).rejects.toMatchObject({ status: 403, code: 'STEP_UP_REQUIRED' });
    expect(f.directory.resolve).not.toHaveBeenCalled();
  });
  it.each([OidcB2bAdminScope, `email ${OidcB2bAdminScope} profile openid`])('accepts only the admin scope plus optional OIDC scopes: %s', async scope => {
    const f = adminFixture(); Object.assign(f.claims, { scope, aud: ['another-resource', OidcB2bAdminAudience],
      iat: epoch, exp: epoch + 300, auth_time: epoch - 300, nbf: undefined });
    await expect(f.authority.verify(accessToken)).resolves.toMatchObject({ id: id(9) });
  });
  it.each([NaN, Infinity, -1, 1.5])('fails closed on invalid local clock %s', async ms => {
    const f = adminFixture({ now: () => ms });
    await expect(f.authority.verify(accessToken)).rejects.toMatchObject({ status: 503 });
  });
});

describe('B2B08 live owner authority and asynchronous revocation', () => {
  it.each([
    { userId: 'external-subject' }, { linkRevision: '' }, { linkRevision: 1 }, { active: false }, { active: 'true' },
    { authVersion: -1 }, { authVersion: 3.1 }, { authVersion: '3' },
    { roles: ['CASHIER'] }, { roles: ['admin'] }, { roles: [] }, { roles: 'ADMIN' },
    ...permissions.map(missing => ({ permissions: permissions.filter(p => p !== missing) })),
    { permissions: ['*'] }, { permissions: 'setup.manage user.manage role.manage' }, { scope: { kind: 'ASSIGNED' } },
    { scope: null },
  ])('requires the actual current GLOBAL ADMIN and all three owner permissions %j', async patch => {
    const f = adminFixture(); f.directory.resolve.mockResolvedValue({ ...f.user, ...patch } as OidcAdminUser);
    Object.assign(f.claims, { roles: ['ADMIN'], permissions, scopeKind: 'GLOBAL', stepUpVerified: true, admin: true });
    await expect(f.authority.verify(accessToken)).rejects.toMatchObject({ status: 403 });
  });
  it('never auto-links by issuer email, username, supplied user ID or external ADMIN flags', async () => {
    const f = adminFixture(); f.directory.resolve.mockResolvedValue(null);
    Object.assign(f.claims, { email: 'admin@example.invalid', preferred_username: 'admin', userId: id(9), roles: ['ADMIN'], admin: true });
    await expect(f.authority.verify(accessToken)).rejects.toMatchObject({ status: 403 });
    expect(f.directory.resolve).toHaveBeenCalledExactlyOnceWith(issuer, 'opaque-admin-subject', clientId);
  });
  it('ignores OIDC roles and permission assertions even when they contradict current local grants', async () => {
    const f = adminFixture(); Object.assign(f.claims, { roles: ['CASHIER'], permissions: [], scopeKind: 'ASSIGNED', stepUpVerified: false });
    await expect(f.authority.verify(accessToken)).resolves.toEqual({ id: id(9), stepUpVerified: true });
  });
  it.each([
    { linkRevision: 'link-1:2' }, { userId: id(10) }, { authVersion: 4 },
    { roles: ['ADMIN', 'AUDITOR'] }, { permissions: [...permissions, 'document.view'] },
  ])('denies directory revisions or grants changing across awaits %j', async patch => {
    const f = adminFixture();
    f.directory.resolve.mockResolvedValueOnce(structuredClone(f.user)).mockResolvedValueOnce({ ...f.user, ...patch });
    await expect(f.authority.verify(accessToken)).rejects.toMatchObject({ code: 'USER_ACCESS_CHANGED' });
  });
  it('captures mutable owner snapshots before waiting on the second provider call', async () => {
    const f = adminFixture(); f.directory.resolve.mockImplementation(async () => f.user);
    f.provider.introspect.mockImplementationOnce(async () => f.claims).mockImplementationOnce(async () => {
      f.user.linkRevision = 'link-1:2'; f.user.permissions.push('document.view'); return f.claims;
    });
    await expect(f.authority.verify(accessToken)).rejects.toMatchObject({ code: 'USER_ACCESS_CHANGED' });
  });
  it.each([{ active: false }, { roles: ['CASHIER'] }, { scope: { kind: 'ASSIGNED' as const } }, { permissions: [] }])('denies revocation on the second directory read %j', async patch => {
    const f = adminFixture();
    f.directory.resolve.mockResolvedValueOnce(structuredClone(f.user)).mockResolvedValueOnce({ ...f.user, ...patch });
    await expect(f.authority.verify(accessToken)).rejects.toMatchObject({ status: 403 });
  });
  it.each([{ active: false }, { sub: 'other-subject' }, { auth_time: epoch - 31 },
    { acr: 'weak' }, { amr: ['pwd'] }, { exp: epoch }, { scope: `${OidcB2bAdminScope} email` }])('denies provider revocation or changed token inputs %j', async patch => {
    const f = adminFixture();
    f.provider.introspect.mockResolvedValueOnce(structuredClone(f.claims)).mockResolvedValueOnce({ ...f.claims, ...patch });
    await expect(f.authority.verify(accessToken)).rejects.toMatchObject({ status: expect.any(Number) });
  });
  it('captures a mutable provider response before directory awaits', async () => {
    const f = adminFixture(); f.provider.introspect.mockImplementation(async () => f.claims);
    f.directory.resolve.mockImplementationOnce(async () => { f.claims.auth_time = epoch - 31; return f.user; });
    await expect(f.authority.verify(accessToken)).rejects.toMatchObject({ code: 'USER_ACCESS_CHANGED' });
  });
  it.each(['expiry', 'MFA'])('rechecks %s after the final directory await', async which => {
    const f = adminFixture();
    f.directory.resolve.mockImplementationOnce(async () => structuredClone(f.user)).mockImplementationOnce(async () => {
      f.advance(which === 'expiry' ? 290000 : 271000); return structuredClone(f.user);
    });
    await expect(f.authority.verify(accessToken)).rejects.toMatchObject({ status: which === 'expiry' ? 401 : 403 });
  });
  it('compares sets independently of provider/owner array order', async () => {
    const f = adminFixture(); f.claims.aud = ['another-resource', OidcB2bAdminAudience];
    f.provider.introspect.mockResolvedValueOnce(structuredClone(f.claims)).mockResolvedValueOnce({ ...f.claims,
      aud: [OidcB2bAdminAudience, 'another-resource'], amr: ['mfa', 'pwd'], scope: `${OidcB2bAdminScope} openid` });
    f.directory.resolve.mockResolvedValueOnce(structuredClone(f.user)).mockResolvedValueOnce({ ...f.user, permissions: [...permissions].reverse() });
    await expect(f.authority.verify(accessToken)).resolves.toMatchObject({ id: id(9) });
  });
  it.each(['provider', 'directory'] as const)('fails closed without leaking %s errors', async dependency => {
    const f = adminFixture(); const error = new Error(`private dependency detail ${accessToken}`);
    if (dependency === 'provider') f.provider.introspect.mockRejectedValue(error); else f.directory.resolve.mockRejectedValue(error);
    await expect(f.authority.verify(accessToken)).rejects.toMatchObject({ status: 503, code: 'ADMIN_AUTHORITY_UNAVAILABLE' });
    await expect(f.authority.verify(accessToken)).rejects.not.toThrow(accessToken);
  });
  it('does not cache prior successful grants', async () => {
    const f = adminFixture(); await f.authority.verify(accessToken); f.user.active = false;
    await expect(f.authority.verify(accessToken)).rejects.toMatchObject({ status: 403 });
    expect(f.provider.introspect).toHaveBeenCalledTimes(3);
  });
});

function postgresFixture() {
  const link = { id: id(40), userId: id(9), enabled: true, userAuthRevision: 3, linkRevision: '7' };
  const role = (code: 'ADMIN' | 'CASHIER', active: boolean, codes: string[]) => ({ role: { code, active,
    permissions: codes.map(code => ({ permission: { code } })) } });
  const user = { active: true, authVersion: 3, roles: [role('ADMIN', true, ['SETUP_MANAGE', 'USER_MANAGE', 'ROLE_MANAGE']),
    role('CASHIER', false, ['DOCUMENT_ISSUE'])] };
  const db = { $queryRawUnsafe: vi.fn(async (..._args: unknown[]) => [structuredClone(link)]),
    user: { findUnique: vi.fn(async (..._args: unknown[]) => structuredClone(user)) } };
  const extra = { effective: vi.fn(async (_userId: string): Promise<string[]> => ['document.view']) };
  const directory = new PostgresOidcAdminDirectory(db as unknown as ConstructorParameters<typeof PostgresOidcAdminDirectory>[0],
    extra as ConstructorParameters<typeof PostgresOidcAdminDirectory>[1]);
  return { directory, db, extra, link, user, role };
}

describe('B2B08 candidate Postgres directory (fake calls only)', () => {
  it('performs parameterized explicit-link SELECTs and owner user/role/extra reads without writes', async () => {
    const f = postgresFixture(), subject = "sub' OR true--";
    expect(f.db.$queryRawUnsafe).not.toHaveBeenCalled();
    await expect(f.directory.resolve(issuer, subject, clientId)).resolves.toEqual({ userId: id(9), linkRevision: `${id(40)}:7`,
      active: true, authVersion: 3, roles: ['ADMIN'], permissions: ['document.view', 'role.manage', 'setup.manage', 'user.manage'], scope: { kind: 'GLOBAL' } });
    expect(f.db.$queryRawUnsafe).toHaveBeenCalledTimes(2);
    for (const [sql, ...args] of f.db.$queryRawUnsafe.mock.calls) {
      expect(sql).toMatch(/^SELECT .* FROM "B2bAdminOidcLink" WHERE "issuer"=\$1 AND "subject"=\$2 AND "oidcClientId"=\$3$/);
      expect(sql).not.toContain(subject); expect(sql).not.toMatch(/INSERT|UPDATE|DELETE|CREATE|ALTER|email|username/);
      expect(args).toEqual([issuer, subject, clientId]);
    }
    expect(f.db.user.findUnique).toHaveBeenCalledTimes(2);
    expect(f.db.user.findUnique).toHaveBeenCalledWith({ where: { id: id(9) }, select: { active: true, authVersion: true,
      roles: { select: { role: { select: { code: true, active: true, permissions: { select: { permission: { select: { code: true } } } } } } } } } });
    expect(f.extra.effective).toHaveBeenCalledExactlyOnceWith(id(9));
  });
  it('does not use inactive ADMIN roles or their permissions', async () => {
    const f = postgresFixture(); f.user.roles = [f.role('ADMIN', false, ['SETUP_MANAGE', 'USER_MANAGE', 'ROLE_MANAGE']), f.role('CASHIER', true, ['DOCUMENT_VIEW'])];
    await expect(f.directory.resolve(issuer, 'sub', clientId)).resolves.toMatchObject({ roles: ['CASHIER'], permissions: ['document.view'], scope: { kind: 'ASSIGNED' } });
    const o = adminFixture({ directory: f.directory });
    await expect(o.authority.verify(accessToken)).rejects.toMatchObject({ status: 403 });
  });
  it.each([
    { enabled: false }, { enabled: 'true' }, { userAuthRevision: 2 }, { userAuthRevision: -1 },
    { userId: 'admin@example.invalid' }, { id: 'not-uuid' }, { linkRevision: '' }, { linkRevision: '0' }, { linkRevision: 7 },
  ])('denies missing, disabled, malformed or stale mappings %j', async patch => {
    const f = postgresFixture(); Object.assign(f.link, patch);
    await expect(f.directory.resolve(issuer, 'sub', clientId)).resolves.toBeNull();
    expect(f.extra.effective).not.toHaveBeenCalled();
  });
  it.each([0, 2])('denies %s explicit links without attempting user lookup/autolink', async count => {
    const f = postgresFixture(); f.db.$queryRawUnsafe.mockResolvedValue(Array.from({ length: count }, () => f.link));
    await expect(f.directory.resolve(issuer, 'admin@example.invalid', clientId)).resolves.toBeNull();
    expect(f.db.user.findUnique).not.toHaveBeenCalled(); expect(f.extra.effective).not.toHaveBeenCalled();
  });
  it.each([{ active: false }, { authVersion: 4 }])('denies inactive or authVersion changed owner %j', async patch => {
    const f = postgresFixture(); Object.assign(f.user, patch);
    await expect(f.directory.resolve(issuer, 'sub', clientId)).resolves.toBeNull(); expect(f.extra.effective).not.toHaveBeenCalled();
  });
  it('denies deleted owner users', async () => {
    const f = postgresFixture(); f.db.user.findUnique.mockResolvedValue(null as unknown as typeof f.user);
    await expect(f.directory.resolve(issuer, 'sub', clientId)).resolves.toBeNull();
  });
  it.each(['link', 'user', 'roles'] as const)('denies %s changes while awaiting extra.effective', async changed => {
    const f = postgresFixture(); f.extra.effective.mockImplementation(async () => {
      if (changed === 'link') f.link.linkRevision = '8';
      if (changed === 'user') f.user.authVersion = 4;
      if (changed === 'roles') f.user.roles = [f.role('CASHIER', true, ['DOCUMENT_VIEW'])];
      return ['document.view'];
    });
    await expect(f.directory.resolve(issuer, 'sub', clientId)).rejects.toMatchObject({ code: 'USER_ACCESS_CHANGED' });
  });
  it('detects mapping replacement even if the numeric revision was reused', async () => {
    const f = postgresFixture(); f.db.$queryRawUnsafe.mockResolvedValueOnce([f.link]).mockResolvedValueOnce([{ ...f.link, id: id(41) }]);
    await expect(f.directory.resolve(issuer, 'sub', clientId)).rejects.toMatchObject({ code: 'USER_ACCESS_CHANGED' });
  });
  it('snapshots mapping fields before asynchronous owner lookup', async () => {
    const f = postgresFixture(); f.db.$queryRawUnsafe.mockImplementation(async () => [f.link]);
    f.db.user.findUnique.mockImplementationOnce(async () => { f.link.linkRevision = '8'; return f.user; });
    await expect(f.directory.resolve(issuer, 'sub', clientId)).rejects.toMatchObject({ code: 'USER_ACCESS_CHANGED' });
  });
  it('deduplicates actual role and extra permissions', async () => {
    const f = postgresFixture(); f.extra.effective.mockResolvedValue(['setup.manage', 'document.view']);
    const result = await f.directory.resolve(issuer, 'sub', clientId);
    expect(result?.permissions).toEqual(['document.view', 'role.manage', 'setup.manage', 'user.manage']);
  });
  it.each(['link', 'owner', 'extra'] as const)('fails closed through the authority when %s storage is unavailable', async dependency => {
    const f = postgresFixture();
    if (dependency === 'link') f.db.$queryRawUnsafe.mockRejectedValue(new Error('missing candidate table'));
    if (dependency === 'owner') f.db.user.findUnique.mockRejectedValue(new Error('owner down'));
    if (dependency === 'extra') f.extra.effective.mockRejectedValue(new Error('extra down'));
    const o = adminFixture({ directory: f.directory });
    await expect(o.authority.verify(accessToken)).rejects.toMatchObject({ status: 503, code: 'ADMIN_AUTHORITY_UNAVAILABLE' });
  });
  it('integrates actual current Prisma roles with the administrative verifier', async () => {
    const f = postgresFixture(), o = adminFixture({ directory: f.directory });
    await expect(o.authority.verify(accessToken)).resolves.toEqual({ id: id(9), stepUpVerified: true });
    expect(f.db.$queryRawUnsafe).toHaveBeenCalledTimes(4); expect(f.extra.effective).toHaveBeenCalledTimes(2);
    f.user.roles[0].role.active = false;
    await expect(o.authority.verify(accessToken)).rejects.toMatchObject({ status: 403 });
  });
});

describe('B2B08 OIDC authority wired into B2bIdentity admin fixture', () => {
  it('creates and mutates clients with the real OIDC authority and audits the owner user', async () => {
    const f = coreFixture(), made = await f.core.create(accessToken, input(), ctx());
    expect(made.client.kind).toBe('SERVICE'); expect(made.clientSecret).toBeTruthy();
    expect(f.provider.introspect).toHaveBeenCalledTimes(6);
    await f.core.change(accessToken, made.client.id, { expectedRevision: 1, enabled: false }, ctx());
    expect(f.store.clients.get(made.client.id)?.enabled).toBe(false);
    expect(f.store.audits.every(event => event.actorId === id(9))).toBe(true);
  });
  it('removes the human-step-up fixture bypass completely', async () => {
    const f = coreFixture();
    await expect(f.core.create('human-step-up', input(), ctx())).rejects.toMatchObject({ status: 401 });
    expect(f.provider.introspect).not.toHaveBeenCalled(); expect(f.store.clients.size).toBe(0);
  });
  it.each(['roles', 'permissions', 'admin', 'stepUpVerified', 'userId'])('does not allow caller-supplied %s to elevate an administrative request', async field => {
    const f = coreFixture();
    await expect(f.core.create(accessToken, { ...input(), [field]: true }, ctx())).rejects.toMatchObject({ status: 400 });
    expect(f.store.clients.size).toBe(0);
  });
  it('rejects SERVICE access tokens as admin tokens without interpreting signed claims/ADMIN flags', async () => {
    const f = coreFixture(), made = await f.core.create(accessToken, input(), ctx());
    const service = await f.core.token(basic(made.client.id, made.clientSecret!),
      { grant_type: 'client_credentials', scope: 'b2b:context:read' }, ctx());
    f.provider.introspect.mockResolvedValue({ active: false });
    await expect(f.core.create(service.access_token!, input(), ctx())).rejects.toMatchObject({ status: 401 });
    expect(f.store.clients.size).toBe(1);
  });
  it('rolls back creation and audit when revocation occurs after the owner mutation', async () => {
    const f = coreFixture();
    f.directory.resolve.mockImplementation(async () => {
      if (f.directory.resolve.mock.calls.length === 5) f.user.active = false;
      return structuredClone(f.user);
    });
    await expect(f.core.create(accessToken, input(), ctx())).rejects.toMatchObject({ status: 403 });
    expect(f.store.clients.size).toBe(0); expect(f.store.audits).toHaveLength(0);
  });
  it('rolls back a rotation and audit when the admin link changes during the final verification', async () => {
    const f = coreFixture(), made = await f.core.create(accessToken, input(), ctx());
    const previous = structuredClone(f.store.clients), auditCount = f.store.audits.length;
    f.directory.resolve.mockClear();
    f.directory.resolve.mockImplementation(async () => {
      if (f.directory.resolve.mock.calls.length === 6) f.user.linkRevision = 'link-1:2';
      return structuredClone(f.user);
    });
    await expect(f.core.change(accessToken, made.client.id, { expectedRevision: 1 }, ctx(), true)).rejects.toMatchObject({ code: 'USER_ACCESS_CHANGED' });
    expect(f.store.clients).toEqual(previous); expect(f.store.audits).toHaveLength(auditCount);
  });
  it('denies create without current owner grants despite a valid OIDC MFA token', async () => {
    const f = coreFixture(); f.user.roles = ['CASHIER'];
    await expect(f.core.create(accessToken, input(), ctx())).rejects.toMatchObject({ status: 403 });
    expect(f.store.clients.size).toBe(0);
  });
});
