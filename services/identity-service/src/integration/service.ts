import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IntegrationScope } from '@factuez/contracts/integration';
import { IntegrationIdentityError, fail, grants, plain, scopes, scopeText, uuid, view,
  type AdminAuthority, type Audit, type Client, type GrantCatalogue, type Principal,
  type RequestContext, type Store, type Transaction } from './model';
import { IntegrationTokenCodec } from './token';

export class IntegrationIdentity {
  private readonly pepper: Buffer;
  constructor(private readonly store: Store, private readonly codec: IntegrationTokenCodec, pepper: Buffer,
    private readonly authority: AdminAuthority, private readonly catalogue: GrantCatalogue,
    private readonly clock: () => number = Date.now) {
    if (pepper.length < 32) throw new Error('Dedicated integration pepper required');
    this.pepper = Buffer.from(pepper);
  }
  private hash(value: string) { return createHmac('sha256', this.pepper).update(value).digest('hex'); }
  private async tx<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    try { return await this.store.transaction(work); }
    catch (error) { if (error instanceof IntegrationIdentityError) throw error; return fail(503, 'temporarily_unavailable'); }
  }
  private audit(tx: Transaction, ctx: RequestContext, action: Audit['action'], client: Client | null,
    outcome: string, actorId: string | null = null) {
    if (!uuid(ctx.requestId) || typeof ctx.peer !== 'string' || !ctx.peer || ctx.peer.length > 256) return fail(400, 'invalid_request');
    return tx.audit({ id: randomUUID(), clientId: client?.id ?? null, actorId, requestId: ctx.requestId,
      peerHash: this.hash('peer:' + ctx.peer), action, outcome, revision: client?.revision ?? null, at: new Date(this.clock()).toISOString() });
  }
  private validClient(client: Client) {
    try {
      if (!uuid(client.id) || !Number.isSafeInteger(client.revision) || client.revision < 1 || typeof client.enabled !== 'boolean' ||
          !/^[a-f0-9]{64}$/.test(client.secretHash)) throw new Error();
      scopes(client.scopes); grants(client.grants);
    } catch { return fail(503, 'temporarily_unavailable'); }
  }
  private async quota(ctx: RequestContext, name: string, limit: number, limiter: Pick<Store, 'rate'> = this.store) {
    if (!uuid(ctx.requestId) || typeof ctx.peer !== 'string' || !ctx.peer || ctx.peer.length > 256) return fail(400, 'invalid_request');
    try {
      if (!await limiter.rate(this.hash(name), Math.floor(this.clock() / 60000), limit)) return fail(429, 'RATE_LIMITED');
    } catch (e) { if (e instanceof IntegrationIdentityError) throw e; return fail(503, 'temporarily_unavailable'); }
  }
  private basic(header: unknown): { id: string; secret: string } | null {
    if (typeof header !== 'string' || header.length > 512 || !/^Basic [A-Za-z0-9+/]+={0,2}$/.test(header)) return null;
    const encoded = header.slice(6), decoded = Buffer.from(encoded, 'base64');
    if (decoded.toString('base64') !== encoded) return null;
    if ([...decoded].some(byte => byte < 33 || byte > 126)) return null;
    const pair = decoded.toString('ascii').split(':');
    return pair.length === 2 && uuid(pair[0]) && /^[A-Za-z0-9_-]{43}$/.test(pair[1]) ? { id: pair[0].toLowerCase(), secret: pair[1] } : null;
  }
  async token(authorization: unknown, body: unknown, ctx: RequestContext) {
    await this.quota(ctx, 'token-peer:' + ctx.peer, 60);
    if (!plain(body) || Object.keys(body).some(k => !['grant_type', 'scope'].includes(k)) ||
        typeof body.grant_type !== 'string') return fail(400, 'invalid_request');
    if (body.grant_type !== 'client_credentials') return fail(400, 'unsupported_grant_type');
    const credentials = this.basic(authorization);
    const outcome = await this.tx(async tx => {
      const client = credentials ? await tx.get(credentials.id) : null;
      if (client) this.validClient(client);
      const expected = Buffer.from(client?.secretHash ?? this.hash('dummy:unknown-client'), 'hex');
      const actual = Buffer.from(this.hash('secret:' + (credentials?.secret ?? '')), 'hex');
      const matches = timingSafeEqual(expected, actual);
      if (!client?.enabled || !matches) {
        await this.audit(tx, ctx, 'TOKEN', client, 'invalid_client');
        return { error: 'invalid_client', status: 401 } as const;
      }
      await this.quota(ctx, 'token-client:' + client.id, 30, tx);
      let requested: IntegrationScope[];
      try { requested = scopeText(body.scope); } catch {
        await this.audit(tx, ctx, 'TOKEN', client, 'invalid_scope');
        return { error: 'invalid_scope', status: 400 } as const;
      }
      if (requested.some(s => !client.scopes.includes(s))) {
        await this.audit(tx, ctx, 'TOKEN', client, 'invalid_scope');
        return { error: 'invalid_scope', status: 400 } as const;
      }
      const signed = this.codec.mint(client, requested);
      await this.audit(tx, ctx, 'TOKEN', client, 'OK');
      return { response: { access_token: signed.token, token_type: 'Bearer' as const, expires_in: signed.expiresIn, scope: requested.join(' ') } };
    });
    if (outcome.error !== undefined) return fail(outcome.status!, outcome.error);
    return outcome.response;
  }
  /** Every resource request must call this. A cryptographic/JWKS check alone is insufficient. */
  async authenticate(token: string, required: IntegrationScope[], ctx: RequestContext): Promise<Principal> {
    const claims = this.codec.verify(token);
    const requiredScopes = required.length ? scopes(required) : [];
    await this.quota(ctx, 'read-client:' + claims.client_id, 300);
    const result = await this.tx(async tx => {
      const client = await tx.get(claims.client_id);
      if (client) this.validClient(client);
      const tokenScopes = scopeText(claims.scope);
      if (!client?.enabled || client.revision !== claims.client_revision || tokenScopes.some(s => !client.scopes.includes(s))) {
        await this.audit(tx, ctx, 'AUTHENTICATE', client, 'invalid_token');
        return { error: 'invalid_token', status: 401 } as const;
      }
      if (requiredScopes.some(s => !tokenScopes.includes(s))) {
        await this.audit(tx, ctx, 'AUTHENTICATE', client, 'INSUFFICIENT_SCOPE');
        return { error: 'INSUFFICIENT_SCOPE', status: 403 } as const;
      }
      await this.audit(tx, ctx, 'AUTHENTICATE', client, 'OK');
      return { principal: { clientId: client.id, revision: client.revision, environment: 'BETA' as const,
        scopes: tokenScopes, grants: structuredClone(client.grants) } };
    });
    if (result.error !== undefined) return fail(result.status!, result.error);
    return result.principal;
  }
  private async admin(bearer: string) {
    try { const actor = await this.authority.verify(bearer); if (!uuid(actor.id)) return fail(403, 'FORBIDDEN'); return actor; }
    catch (e) { if (e instanceof IntegrationIdentityError) throw e; return fail(503, 'temporarily_unavailable'); }
  }
  async list(bearer: string) {
    await this.admin(bearer);
    try { return await this.store.list(); } catch { return fail(503, 'temporarily_unavailable'); }
  }
  async create(bearer: string, body: unknown, ctx: RequestContext) {
    const actor = await this.admin(bearer);
    if (!plain(body) || Object.keys(body).some(k => !['label', 'scopes', 'grants'].includes(k)) ||
        typeof body.label !== 'string' || !body.label.trim() || body.label.length > 120 || /[\x00-\x1f\x7f]/.test(body.label)) return fail(400, 'invalid_request');
    const selectedScopes = scopes(body.scopes), selectedGrants = grants(body.grants);
    await this.catalogue.validate(bearer, selectedGrants);
    const secret = randomBytes(32).toString('base64url'), at = new Date(this.clock()).toISOString();
    const client: Client = { id: randomUUID(), label: body.label.trim(), enabled: true, revision: 1,
      secretHash: this.hash('secret:' + secret), scopes: selectedScopes, grants: selectedGrants,
      createdAt: at, updatedAt: at, secretRotatedAt: at };
    await this.tx(async tx => { await tx.create(client); await this.audit(tx, ctx, 'CREATE', client, 'OK', actor.id); });
    return { client: view(client), clientSecret: secret };
  }
  async change(bearer: string, id: string, body: unknown, ctx: RequestContext, rotate = false) {
    const actor = await this.admin(bearer);
    const keys = rotate ? ['expectedRevision'] : ['expectedRevision', 'label', 'enabled', 'scopes', 'grants'];
    if (!uuid(id) || !plain(body) || Object.keys(body).some(k => !keys.includes(k)) || !Number.isSafeInteger(body.expectedRevision) ||
        Number(body.expectedRevision) < 1 || (!rotate && Object.keys(body).length < 2) ||
        (body.enabled !== undefined && typeof body.enabled !== 'boolean') || (body.label !== undefined &&
          (typeof body.label !== 'string' || !body.label.trim() || body.label.length > 120 || /[\x00-\x1f\x7f]/.test(body.label)))) return fail(400, 'invalid_request');
    const selectedScopes = body.scopes === undefined ? undefined : scopes(body.scopes);
    const selectedGrants = body.grants === undefined ? undefined : grants(body.grants);
    const secret = rotate ? randomBytes(32).toString('base64url') : undefined;
    return this.tx(async tx => {
      const client = await tx.get(id.toLowerCase());
      if (!client) return fail(404, 'RESOURCE_NOT_FOUND');
      this.validClient(client);
      if (client.revision !== body.expectedRevision) return fail(409, 'REVISION_CONFLICT');
      const updated: Client = { ...client, label: typeof body.label === 'string' ? body.label.trim() : client.label,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : client.enabled,
        scopes: selectedScopes ?? client.scopes, grants: selectedGrants ?? client.grants,
        revision: client.revision + 1, updatedAt: new Date(this.clock()).toISOString(),
        ...(secret ? { secretHash: this.hash('secret:' + secret), secretRotatedAt: new Date(this.clock()).toISOString() } : {}) };
      // A disabled historical account can always be revoked without Billing being available.
      if (selectedGrants || (body.enabled === true && !client.enabled)) await this.catalogue.validate(bearer, updated.grants);
      await tx.save(updated, client.revision);
      await this.audit(tx, ctx, rotate ? 'ROTATE' : 'UPDATE', updated, 'OK', actor.id);
      return { client: view(updated), ...(secret ? { clientSecret: secret } : {}) };
    });
  }
  jwks() { return this.codec.jwks(); }
}
