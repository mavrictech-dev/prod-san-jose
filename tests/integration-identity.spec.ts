import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { integrationGrantAllows } from '../packages/contracts/src/integration-extraction';
import { IntegrationTokenCodec } from '../services/identity-service/src/integration/token';
import { validateCatalogue } from '../services/identity-service/src/integration/catalogue';
import { HumanIntegrationAdministrator, integrationRuntimeConfig } from '../services/identity-service/src/integration/runtime';
import { PostgresIntegrationStore } from '../services/identity-service/src/integration/postgres-store';
import { actor, basic, branch, catalogue, ctx, fixture, grant, input, point, series } from './integration-identity.fixture';

describe('Integration client identity, isolated from human sessions', () => {
  it('returns a 256-bit secret only once, persists its hash and safe audit metadata', async () => {
    const { core, store } = fixture(), made = await core.create('human-fixture', input(), ctx());
    expect(made.clientSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(made.client).not.toHaveProperty('secretHash');
    expect(await core.list('human-fixture')).toEqual([made.client]);
    expect(store.clients.get(made.client.id)?.secretHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(store.audits)).not.toContain(made.clientSecret);
    expect(Object.keys(store.audits[0]).sort()).toEqual(['action','actorId','at','clientId','id','outcome','peerHash','requestId','revision']);
  });
  it('issues an explicit narrow scope, 5 minute token, no refresh token and current grants', async () => {
    const { core, codec } = fixture(), made = await core.create('human-fixture', input(), ctx());
    const token = await core.token(basic(made.client.id, made.clientSecret), { grant_type: 'client_credentials', scope: 'integration:documents:read' }, ctx());
    expect(token.expires_in).toBe(300); expect(token).not.toHaveProperty('refresh_token');
    expect(codec.verify(token.access_token)).toMatchObject({ aud: 'factuez-integration-v1', principal_type: 'integration_client', environment: 'BETA' });
    const principal = await core.authenticate(token.access_token, ['integration:documents:read'], ctx());
    expect(principal.grants).toEqual([grant]);
    const resource = { issuerRuc: grant.issuerRuc, environment: 'BETA' as const, dataset: 'ISSUED_BUSINESS' as const, type: '01' as const,
      branchId: branch, pointId: point, seriesCounterId: series };
    expect(integrationGrantAllows(principal.grants, resource)).toBe(true);
    expect(integrationGrantAllows(principal.grants, { ...resource, issuerRuc: '20444444444' })).toBe(false);
    expect(integrationGrantAllows(principal.grants, { ...resource, pointId: randomUUID() })).toBe(false);
  });
  it.each([undefined, 'Bearer human', 'Basic AAA', 'Basic !!!', basic(randomUUID(), 'wrong'), ['Basic abc']])('generic invalid_client for bad Basic %j', async header => {
    const { core } = fixture();
    await expect(core.token(header, { grant_type: 'client_credentials', scope: 'integration:documents:read' }, ctx())).rejects.toMatchObject({ status: 401, code: 'invalid_client' });
  });
  it.each([undefined, '', 'document.view', 'integration:documents:read integration:documents:read',
    ' integration:documents:read', 'integration:documents:read  integration:catalog:read', ['integration:documents:read']])('rejects scope ambiguity %j', async scope => {
    const { core } = fixture(), made = await core.create('human-fixture', input(), ctx());
    await expect(core.token(basic(made.client.id, made.clientSecret), { grant_type: 'client_credentials', scope }, ctx())).rejects.toMatchObject({ status: 400, code: 'invalid_scope' });
  });
  it('cannot request a broader scope or administrate using an integration token', async () => {
    const { core } = fixture(), made = await core.create('human-fixture', input(), ctx());
    await expect(core.token(basic(made.client.id, made.clientSecret), { grant_type: 'client_credentials', scope: 'integration:catalog:read' }, ctx())).rejects.toMatchObject({ code: 'invalid_scope' });
    const token = await core.token(basic(made.client.id, made.clientSecret), { grant_type: 'client_credentials', scope: 'integration:documents:read' }, ctx());
    await expect(core.authenticate(token.access_token, ['integration:catalog:read'], ctx())).rejects.toMatchObject({ status: 403 });
    await expect(core.create(token.access_token, input(), ctx())).rejects.toMatchObject({ status: 403 });
  });
  it.each(['password', 'refresh_token', 'authorization_code'])('does not implement %s grant', async grant_type => {
    await expect(fixture().core.token('Bearer human', { grant_type, scope: 'integration:documents:read' }, ctx())).rejects.toMatchObject({ code: 'unsupported_grant_type' });
  });
  it.each([{ grant_type: 'client_credentials', client_secret: 'leak' }, { grant_type: 'client_credentials', audience: 'humans' },
    { grant_type: 'client_credentials', environment: 'PRODUCTION' }, { grant_type: ['client_credentials'] }, null])('rejects unsolicited fields %j', async body => {
    await expect(fixture().core.token(undefined, body, ctx())).rejects.toMatchObject({ code: 'invalid_request' });
  });
  it.each(['enabled', 'scopes', 'grants', 'label'])('changing %s increments revision and revokes issued tokens', async key => {
    const { core } = fixture(), made = await core.create('human-fixture', input(), ctx());
    const token = await core.token(basic(made.client.id, made.clientSecret), { grant_type: 'client_credentials', scope: 'integration:documents:read' }, ctx());
    const values = { enabled: false, scopes: ['integration:documents:read', 'integration:catalog:read'], grants: [grant], label: 'Renamed ERP' };
    await core.change('human-fixture', made.client.id, { expectedRevision: 1, [key]: values[key as keyof typeof values] }, ctx());
    await expect(core.authenticate(token.access_token, [], ctx())).rejects.toMatchObject({ status: 401 });
  });
  it('rotation invalidates old secret and old JWT; new secret works', async () => {
    const { core } = fixture(), made = await core.create('human-fixture', input(), ctx());
    const body = { grant_type: 'client_credentials', scope: 'integration:documents:read' };
    const old = await core.token(basic(made.client.id, made.clientSecret), body, ctx());
    const rotated = await core.change('human-fixture', made.client.id, { expectedRevision: 1 }, ctx(), true);
    expect(rotated.clientSecret).not.toBe(made.clientSecret);
    await expect(core.token(basic(made.client.id, made.clientSecret), body, ctx())).rejects.toMatchObject({ status: 401 });
    await expect(core.authenticate(old.access_token, [], ctx())).rejects.toMatchObject({ status: 401 });
    expect(await core.token(basic(made.client.id, rotated.clientSecret!), body, ctx())).toHaveProperty('access_token');
  });
  it('re-enabling never revives old tokens', async () => {
    const { core, cataloguePort } = fixture(), made = await core.create('human-fixture', input(), ctx());
    const old = await core.token(basic(made.client.id, made.clientSecret), { grant_type: 'client_credentials', scope: 'integration:documents:read' }, ctx());
    await core.change('human-fixture', made.client.id, { expectedRevision: 1, enabled: false }, ctx());
    await core.change('human-fixture', made.client.id, { expectedRevision: 2, enabled: true }, ctx());
    expect(cataloguePort.validate).toHaveBeenCalledTimes(2);
    await expect(core.authenticate(old.access_token, [], ctx())).rejects.toMatchObject({ status: 401 });
  });
  it('revocation remains possible without Billing availability', async () => {
    const { core, cataloguePort } = fixture(), made = await core.create('human-fixture', input(), ctx());
    cataloguePort.validate.mockRejectedValue(new Error('Billing down'));
    expect((await core.change('human-fixture', made.client.id, { expectedRevision: 1, enabled: false }, ctx())).client.enabled).toBe(false);
  });
  it('lost updates conflict and only one concurrent rotation can commit', async () => {
    const { core, store } = fixture(), made = await core.create('human-fixture', input(), ctx());
    const results = await Promise.allSettled([1,2].map(() => core.change('human-fixture', made.client.id, { expectedRevision: 1 }, ctx(), true)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(store.clients.get(made.client.id)?.revision).toBe(2);
    expect(store.audits.filter(a => a.action === 'ROTATE')).toHaveLength(1);
  });
  it('audit failure rolls back creation and rotation; no secret/token is returned', async () => {
    const { core, store } = fixture(); store.failAudit = true;
    await expect(core.create('human-fixture', input(), ctx())).rejects.toMatchObject({ status: 503 });
    expect(store.clients.size).toBe(0); store.failAudit = false;
    const made = await core.create('human-fixture', input(), ctx()), before = structuredClone(store.clients);
    store.failAudit = true;
    await expect(core.change('human-fixture', made.client.id, { expectedRevision: 1 }, ctx(), true)).rejects.toMatchObject({ status: 503 });
    expect(store.clients).toEqual(before);
    await expect(core.token(basic(made.client.id, made.clientSecret), { grant_type: 'client_credentials', scope: 'integration:documents:read' }, ctx())).rejects.toMatchObject({ status: 503 });
  });
  it('DB down denies both token issuance and resource checks, never falls back to JWT alone', async () => {
    const { core, store } = fixture(), made = await core.create('human-fixture', input(), ctx());
    const token = await core.token(basic(made.client.id, made.clientSecret), { grant_type: 'client_credentials', scope: 'integration:documents:read' }, ctx());
    store.down = true;
    await expect(core.authenticate(token.access_token, [], ctx())).rejects.toMatchObject({ status: 503 });
    await expect(core.token(basic(made.client.id, made.clientSecret), { grant_type: 'client_credentials', scope: 'integration:documents:read' }, ctx())).rejects.toMatchObject({ status: 503 });
  });
  it('limits issuance by client and resets only the minute window', async () => {
    const { core, advance } = fixture(), made = await core.create('human-fixture', input(), ctx());
    const issue = () => core.token(basic(made.client.id, made.clientSecret), { grant_type: 'client_credentials', scope: 'integration:documents:read' }, ctx());
    for (let i = 0; i < 30; i++) await issue();
    await expect(issue()).rejects.toMatchObject({ status: 429 });
    advance(60000); expect(await issue()).toHaveProperty('access_token');
  });
  it('unknown random IDs cannot allocate unlimited client rate buckets', async () => {
    const { core, store } = fixture();
    for (let i = 0; i < 60; i++) await core.token(basic(randomUUID(), randomBytes(32).toString('base64url')), { grant_type: 'client_credentials', scope: 'integration:documents:read' }, ctx()).catch(() => {});
    expect(store.buckets.size).toBe(1);
    await expect(core.token(undefined, { grant_type: 'client_credentials' }, ctx())).rejects.toMatchObject({ status: 429 });
  });
  it.each([{ ...input(), environment: 'PRODUCTION' }, { ...input(), label: 'bad\nlabel' }, { ...input(), scopes: ['integration:artifacts:read'] },
    { ...input(), grants: [{ ...grant, environment: 'PRODUCTION' }] }, { ...input(), grants: [{ ...grant, issuerRuc: '00111111111' }] },
    { ...input(), grants: [] }, { ...input(), scopes: ['document.issue'] }])('denies invalid admin configuration %j', async body => {
    await expect(fixture().core.create('human-fixture', body, ctx())).rejects.toMatchObject({ status: 400 });
  });
  it('prevents changing credential hashes, caller IDs and revision without expectedRevision', async () => {
    const { core } = fixture(), made = await core.create('human-fixture', input(), ctx());
    for (const body of [{ expectedRevision: 1, secretHash: 'x' }, { revision: 2, enabled: false }, { expectedRevision: 0, enabled: true }])
      await expect(core.change('human-fixture', made.client.id, body, ctx())).rejects.toMatchObject({ status: 400 });
  });
  it('rejects persisted malformed policy rather than silently widening grants', async () => {
    const { core, store } = fixture(), made = await core.create('human-fixture', input(), ctx());
    store.clients.get(made.client.id)!.grants[0].environment = 'PRODUCTION' as 'BETA';
    await expect(core.token(basic(made.client.id, made.clientSecret), { grant_type: 'client_credentials', scope: 'integration:documents:read' }, ctx())).rejects.toMatchObject({ status: 503 });
  });
});

describe('Dedicated access-token crypto profile', () => {
  it('rejects an expired token', async () => {
    const { core, advance } = fixture(), made = await core.create('human-fixture', input(), ctx());
    const token = await core.token(basic(made.client.id, made.clientSecret), { grant_type: 'client_credentials', scope: 'integration:documents:read' }, ctx());
    advance(300000); await expect(core.authenticate(token.access_token, [], ctx())).rejects.toMatchObject({ status: 401 });
  });
  it.each(['', 'human.jwt.token', 'x.y', 'x.y.z.more', 'a'.repeat(8193)])('rejects malformed token %s', token => {
    expect(() => fixture().codec.verify(token)).toThrow('invalid_token');
  });
  it.each([{ aud: 'factuez-services' }, { iss: 'https://evil.invalid' }, { environment: 'PRODUCTION' }, { principal_type: 'human' },
    { username: 'admin' }, { roles: ['ADMIN'] }, { client_revision: 0 }, { exp: 1_800_000_301 }, { nbf: 1 },
    { sub: randomUUID() }, { scope: 'document.view' }, { iat: 1_800_000_001 }])('denies signed but invalid claims %j', async patch => {
    const { core, codec, key } = fixture(), made = await core.create('human-fixture', input(), ctx());
    const result = await core.token(basic(made.client.id, made.clientSecret), { grant_type: 'client_credentials', scope: 'integration:documents:read' }, ctx());
    const header = result.access_token.split('.')[0];
    const body = Buffer.from(JSON.stringify({ ...codec.verify(result.access_token), ...patch })).toString('base64url');
    const data = header + '.' + body;
    expect(() => codec.verify(data + '.' + sign('RSA-SHA256', Buffer.from(data), key).toString('base64url'))).toThrow('invalid_token');
  });
  it.each([{ alg: 'none' }, { alg: 'HS256' }, { typ: 'JWT' }, { kid: 'evil' }, { jku: 'https://evil.invalid' }, { crit: [] }, { jwk: {} }])('rejects algorithm/header injection %j', async patch => {
    const { core, codec, key } = fixture(), made = await core.create('human-fixture', input(), ctx());
    const result = await core.token(basic(made.client.id, made.clientSecret), { grant_type: 'client_credentials', scope: 'integration:documents:read' }, ctx());
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'at+jwt', kid: codec.kid, ...patch })).toString('base64url');
    const data = header + '.' + result.access_token.split('.')[1];
    expect(() => codec.verify(data + '.' + sign('RSA-SHA256', Buffer.from(data), key).toString('base64url'))).toThrow('invalid_token');
  });
  it('rejects duplicate claims and tampered signature; JWKS never exposes the private key', async () => {
    const { core, codec, key } = fixture(), made = await core.create('human-fixture', input(), ctx());
    const result = await core.token(basic(made.client.id, made.clientSecret), { grant_type: 'client_credentials', scope: 'integration:documents:read' }, ctx());
    const [h,b,s] = result.access_token.split('.');
    const duplicate = Buffer.from(Buffer.from(b, 'base64url').toString().replace('"environment":"BETA"', '"environment":"PRODUCTION","environment":"BETA"')).toString('base64url');
    const data = h + '.' + duplicate;
    expect(() => codec.verify(data + '.' + sign('RSA-SHA256', Buffer.from(data), key).toString('base64url'))).toThrow();
    const signature = Buffer.from(s, 'base64url'); signature[0] ^= 255;
    expect(() => codec.verify(h + '.' + b + '.' + signature.toString('base64url'))).toThrow();
    expect(codec.jwks().keys[0]).not.toHaveProperty('d');
  });
  it('requires HTTPS issuer, TTL <= 300 and dedicated strong asymmetric key', () => {
    const { key } = fixture();
    expect(() => new IntegrationTokenCodec(Buffer.from(key), 'http://localhost')).toThrow();
    expect(() => new IntegrationTokenCodec(Buffer.from(key), 'https://identity.invalid', 301)).toThrow();
    const small = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    expect(() => new IntegrationTokenCodec(Buffer.from(small), 'https://identity.invalid')).toThrow();
  });
});

describe('Canonical grants and fresh human administration', () => {
  it('validates canonical ownership and rejects cross-company and cross-type selections', () => {
    expect(() => validateCatalogue(catalogue, [grant])).not.toThrow();
    for (const patch of [{ issuerRuc: '20444444444' }, { points: { kind: 'IDS', ids: [randomUUID()] } },
      { branches: { kind: 'IDS', ids: [] } }, { documentTypes: ['03'] }])
      expect(() => validateCatalogue(catalogue, [{ ...grant, ...patch } as typeof grant])).toThrow('INVALID_GRANTS');
  });
  it('never grants a synthetic company or unavailable source', () => {
    expect(() => validateCatalogue({ ...catalogue, companies: [{ ...catalogue.companies[0], source: 'SYNTHETIC' }] }, [grant])).toThrow();
    expect(() => validateCatalogue({}, [grant])).toThrow('CATALOGUE_UNAVAILABLE');
  });
  it('rejects ambiguous ownership from duplicated company, branch, point or series IDs', () => {
    for (const key of ['companies','branches','emissionPoints'] as const) {
      const duplicated = structuredClone(catalogue);
      (duplicated[key] as any[]).push(structuredClone(duplicated[key][0]));
      expect(() => validateCatalogue(duplicated, [grant])).toThrow('CATALOGUE_UNAVAILABLE');
    }
    const duplicated = structuredClone(catalogue);
    duplicated.emissionPoints[0].series.push(structuredClone(duplicated.emissionPoints[0].series[0]));
    expect(() => validateCatalogue(duplicated, [grant])).toThrow('CATALOGUE_UNAVAILABLE');
  });
  it.each(['role', 'scope', 'permission', 'revoked', 'signature'])('checks %s of the current administrator', async kind => {
    const claims = { sub: actor, roles: ['ADMIN'], scope: { kind: 'GLOBAL' }, permissions: ['setup.manage','user.manage','document.view'] };
    const auth = { verifyAccessToken: vi.fn(() => { if (kind === 'signature') throw new Error(); return { ...claims,
      roles: kind === 'role' ? ['STATION_MANAGER'] : claims.roles, scope: kind === 'scope' ? { kind: 'ASSIGNED' } : claims.scope,
      permissions: kind === 'permission' ? ['document.view'] : claims.permissions }; }),
      assertActive: vi.fn(async () => { if (kind === 'revoked') throw new Error(); }) };
    await expect(new HumanIntegrationAdministrator(auth as never).verify('human')).rejects.toThrow();
    if (kind !== 'signature') expect(auth.assertActive).toHaveBeenCalledOnce();
  });
  it('disabled runtime does not read files; production and external bindings are rejected before IO', () => {
    expect(integrationRuntimeConfig({})).toBeNull();
    expect(() => integrationRuntimeConfig({ INTEGRATION_IDENTITY_ENABLED: 'true', INTEGRATION_ENVIRONMENT: 'PRODUCTION' })).toThrow('BETA');
    expect(() => integrationRuntimeConfig({ INTEGRATION_IDENTITY_ENABLED: 'true', INTEGRATION_ENVIRONMENT: 'BETA', INTEGRATION_HOST: '0.0.0.0' })).toThrow('loopback');
  });
});

describe('PostgreSQL adapter uses bound parameters and transactional audit', () => {
  it('readiness validates table columns without selecting client or audit rows', async () => {
    const query = vi.fn(async () => []);
    const repository = new PostgresIntegrationStore({ $queryRawUnsafe: query } as never);
    await repository.ready();
    expect(String(query.mock.calls[0][0])).toContain('WHERE false');
    expect(String(query.mock.calls[0][0])).not.toContain('SELECT *');
  });
  it('selects only metadata for lists, locks client revisions and keeps audit in the same transaction', async () => {
    const execute = vi.fn(async () => 1), query = vi.fn(async () => []);
    const sql = { $queryRawUnsafe: query, $executeRawUnsafe: execute };
    const db = { ...sql, $transaction: vi.fn(async (work: (sql: unknown) => unknown) => work(sql)) };
    const repository = new PostgresIntegrationStore(db as never);
    await repository.list(); expect(query.mock.calls[0][0]).not.toContain('secretHash');
    const f = fixture(), made = await f.core.create('human-fixture', input(), ctx()), client = f.store.clients.get(made.client.id)!;
    await repository.transaction(async tx => { await tx.get(client.id); await tx.create(client); await tx.save({ ...client, label: "x'); DROP TABLE anything; --", revision: 2 }, 1);
      await tx.audit(f.store.audits[0]); await tx.rate('a'.repeat(64), 1, 30); });
    expect(query.mock.calls.some(c => String(c[0]).includes('FOR UPDATE'))).toBe(true);
    expect(execute.mock.calls.every(c => !String(c[0]).includes('DROP TABLE'))).toBe(true);
    expect(execute.mock.calls.some(c => c.includes("x'); DROP TABLE anything; --" as never))).toBe(true);
    expect(db.$transaction).toHaveBeenCalledOnce();
  });
  it('checks optimistic update count and does not allow an empty rate result', async () => {
    const sql = { $queryRawUnsafe: vi.fn(async () => []), $executeRawUnsafe: vi.fn(async () => 0) };
    const repository = new PostgresIntegrationStore({ ...sql, $transaction: async (work: (sql: unknown) => unknown) => work(sql) } as never);
    const f = fixture(), made = await f.core.create('human-fixture', input(), ctx());
    await expect(repository.transaction(tx => tx.save(f.store.clients.get(made.client.id)!, 1))).rejects.toMatchObject({ status: 409 });
    expect(await repository.rate('a'.repeat(64), 1, 30)).toBe(false);
  });
});
