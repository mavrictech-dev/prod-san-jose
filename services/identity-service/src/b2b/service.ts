import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { B2bIdentityError, bindings, clientView, clientPageQuery, fail, plain, scopes, scopeText, uuid,
  type AdminAuthority, type BindingCatalogue, type Client, type ClientMetadata, type DelegationVerifier, type DelegatedUser, type RequestContext, type Store, type Transaction, type B2bIdentityScope, type B2bPrincipal } from './model';
import { B2bTokenCodec } from './token';
import { B2bPhase2Scopes, B2bPhase8Scopes } from '@factuez/contracts/b2b-security';

/** Phase-8 vocabulary is opt-in. These permissions supplement app/token intersection,
 * and never replace each owner's current resource/action/step-up authorization. */
const phase8Permissions: Record<typeof B2bPhase8Scopes[number], readonly string[]> = {
  'b2b:customers:read': ['document.view'], 'b2b:customers:write': ['document.issue'],
  'b2b:products:read': ['document.view'], 'b2b:products:write': ['product.manage'],
  'b2b:shifts:read': ['report.view'], 'b2b:shifts:write': ['shift.open', 'shift.close'],
  'b2b:cash:write': ['shift.open'], 'b2b:received:write': ['setup.manage'],
  'b2b:received:sync': ['setup.manage'], 'b2b:received:configure': ['setup.manage'],
  'b2b:reports:read': ['report.view'], 'b2b:reports:export': ['report.export'],
  'b2b:history:read': ['document.view'], 'b2b:masters:manage': ['setup.manage', 'series.manage'],
  'b2b:identity:manage': ['user.manage', 'role.manage'], 'b2b:branding:manage': ['setup.manage'],
  'b2b:fiscal-config:read': ['sunat.configure'], 'b2b:fiscal-config:write': ['sunat.configure'],
  'b2b:email:send': ['document.email'], 'b2b:email:read': ['document.view'], 'b2b:mail-config:manage': ['setup.manage'],
};

export class B2bIdentity {
  private readonly pepper: Buffer;
  constructor(private readonly store: Store, private readonly codec: B2bTokenCodec, pepper: Buffer,
    private readonly admin: AdminAuthority, private readonly catalogue: BindingCatalogue,
    private readonly delegation: DelegationVerifier | null = null, private readonly now = Date.now,
    private readonly enabledScopes: readonly B2bIdentityScope[] = B2bPhase2Scopes) {
    if (pepper.length !== 32) throw new Error('Dedicated 32-byte B2B pepper required');
    this.pepper = Buffer.from(pepper);
    scopes([...enabledScopes]);
  }
  private hash(value: string) { return createHmac('sha256', this.pepper).update(value).digest('hex'); }
  private async tx<T>(work: (tx: Transaction) => Promise<T>) {
    try { return await this.store.transaction(work); } catch (error) { if (error instanceof B2bIdentityError) throw error; return fail(503, 'IDENTITY_UNAVAILABLE'); }
  }
  private async quota(ctx: RequestContext, kind: string, count: number) {
    if (!uuid(ctx.requestId) || typeof ctx.peer !== 'string' || !ctx.peer || ctx.peer.length > 256) return fail(400, 'INVALID_REQUEST');
    try { if (!await this.store.rate(this.hash(`${kind}:${ctx.peer}`), Math.floor(this.now() / 60000), count)) return fail(429, 'RATE_LIMITED'); }
    catch (error) { if (error instanceof B2bIdentityError) throw error; return fail(503, 'IDENTITY_UNAVAILABLE'); }
  }
  private audit(tx: Transaction, ctx: RequestContext, action: string, client: Client | null, outcome: string, actorId: string | null = null) {
    return tx.audit({ id: randomUUID(), requestId: ctx.requestId, peerHash: this.hash(ctx.peer), action, outcome,
      clientId: client?.id ?? null, revision: client?.revision ?? null, actorId, at: new Date(this.now()).toISOString() });
  }
  private validateMetadata(client: ClientMetadata) {
    if (!uuid(client.id) || typeof client.label !== 'string' || !client.label.trim() || client.label.length > 120 || /[\x00-\x1f\x7f]/.test(client.label) ||
      !Number.isInteger(client.revision) || client.revision < 1 || client.revision > 2147483647 || typeof client.enabled !== 'boolean' ||
      !['SERVICE', 'USER'].includes(client.kind) || (client.kind === 'SERVICE' ? client.oidcClientId !== null :
        typeof client.oidcClientId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(client.oidcClientId))) return fail(503, 'IDENTITY_UNAVAILABLE');
    // A deployment may have disabled a formerly granted scope; metadata must remain readable for revocation.
    try { scopes(client.scopes); bindings(client.bindings); } catch { return fail(503, 'IDENTITY_UNAVAILABLE'); }
  }
  private validate(client: Client) {
    try {
      this.validateMetadata(client);
      if (!uuid(client.id) || !Number.isSafeInteger(client.revision) || client.revision < 1 || typeof client.enabled !== 'boolean' ||
        !['SERVICE', 'USER'].includes(client.kind) ||
        (client.kind === 'SERVICE' ? !/^[a-f0-9]{64}$/.test(client.secretHash ?? '') || client.oidcClientId !== null :
          client.secretHash !== null || typeof client.oidcClientId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(client.oidcClientId))) throw new Error();
      scopes(client.scopes, this.enabledScopes); bindings(client.bindings);
    } catch { return fail(503, 'IDENTITY_UNAVAILABLE'); }
  }
  private async administrator(token: string, expectedId?: string) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token)) return fail(401, 'INVALID_TOKEN');
    try { const actor = await this.admin.verify(token); if (!actor || !uuid(actor.id) || actor.stepUpVerified !== true ||
      (expectedId !== undefined && actor.id !== expectedId)) return fail(403, 'STEP_UP_REQUIRED'); return { id: actor.id }; }
    catch (error) { if (error instanceof B2bIdentityError) throw error; return fail(503, 'ADMIN_AUTHORITY_UNAVAILABLE'); }
  }
  async create(adminToken: string, body: unknown, ctx: RequestContext) {
    await this.quota(ctx, 'admin', 30); const actor = await this.administrator(adminToken);
    if (!plain(body) || Object.keys(body).some(key => !['label', 'kind', 'oidcClientId', 'scopes', 'bindings'].includes(key)) ||
      typeof body.label !== 'string' || !body.label.trim() || body.label.length > 120 || /[\x00-\x1f\x7f]/.test(body.label) ||
      !['SERVICE', 'USER'].includes(body.kind) || (body.kind === 'SERVICE' ? body.oidcClientId !== undefined : typeof body.oidcClientId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(body.oidcClientId))) return fail(400, 'INVALID_REQUEST');
    const selectedScopes = scopes(body.scopes, this.enabledScopes), selectedBindings = bindings(body.bindings);
    const label = body.label.trim(), kind = body.kind, oidcClientId = body.oidcClientId;
    try { await this.catalogue.validate(selectedBindings); } catch (error) { if (error instanceof B2bIdentityError) throw error; return fail(503, 'CATALOGUE_UNAVAILABLE'); }
    const secret = kind === 'SERVICE' ? randomBytes(32).toString('base64url') : null;
    const client: Client = { id: randomUUID(), label, kind, enabled: true, revision: 1,
      scopes: selectedScopes, bindings: selectedBindings, secretHash: secret ? this.hash('secret:' + secret) : null,
      oidcClientId: kind === 'USER' ? oidcClientId : null };
    await this.tx(async tx => {
      await this.administrator(adminToken, actor.id);
      await tx.create(client); await this.audit(tx, ctx, 'CREATE', client, 'OK', actor.id);
      // Revoked authority or step-up after the write rolls back both mutation and audit.
      await this.administrator(adminToken, actor.id);
    });
    return { client: clientView(client), ...(secret ? { clientSecret: secret } : {}) };
  }
  async change(adminToken: string, id: string, body: unknown, ctx: RequestContext, rotate = false) {
    await this.quota(ctx, 'admin', 30); const actor = await this.administrator(adminToken);
    const keys = rotate ? ['expectedRevision'] : ['expectedRevision', 'label', 'enabled', 'scopes', 'bindings'];
    if (!uuid(id) || !plain(body) || Object.keys(body).some(key => !keys.includes(key)) || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1 || body.expectedRevision >= 2147483647 ||
      (!rotate && Object.keys(body).length < 2) || (body.enabled !== undefined && typeof body.enabled !== 'boolean') ||
      (body.label !== undefined && (typeof body.label !== 'string' || !body.label.trim() || body.label.length > 120 || /[\x00-\x1f\x7f]/.test(body.label)))) return fail(400, 'INVALID_REQUEST');
    const selectedScopes = body.scopes === undefined ? undefined : scopes(body.scopes, this.enabledScopes);
    const selectedBindings = body.bindings === undefined ? undefined : bindings(body.bindings);
    const expectedRevision = body.expectedRevision, enabled = body.enabled, label = body.label?.trim();
    return this.tx(async tx => {
      const client = await tx.get(id); if (!client) return fail(404, 'RESOURCE_NOT_FOUND'); this.validate(client);
      if (client.revision !== expectedRevision) return fail(409, 'REVISION_CONFLICT');
      if (rotate && client.kind !== 'SERVICE') return fail(400, 'CLIENT_KIND_NOT_ALLOWED');
      const secret = rotate ? randomBytes(32).toString('base64url') : null;
      const updated = { ...client, label: label ?? client.label, enabled: enabled ?? client.enabled, revision: client.revision + 1,
        scopes: selectedScopes ?? client.scopes, bindings: selectedBindings ?? client.bindings,
        ...(secret ? { secretHash: this.hash('secret:' + secret) } : {}) };
      if (selectedBindings || (updated.enabled && !client.enabled)) {
        try { await this.catalogue.validate(updated.bindings); } catch (error) { if (error instanceof B2bIdentityError) throw error; return fail(503, 'CATALOGUE_UNAVAILABLE'); }
      }
      await this.administrator(adminToken, actor.id);
      await tx.save(updated, client.revision); await this.audit(tx, ctx, rotate ? 'ROTATE' : 'UPDATE', updated, 'OK', actor.id);
      await this.administrator(adminToken, actor.id);
      return { client: clientView(updated), ...(secret ? { clientSecret: secret } : {}) };
    });
  }
  async read(adminToken: string, id: string, ctx: RequestContext) {
    await this.quota(ctx, 'admin', 30); const actor = await this.administrator(adminToken);
    if (!uuid(id)) return fail(400, 'INVALID_REQUEST');
    return this.tx(async tx => {
      const client = await tx.get(id); if (!client) return fail(404, 'RESOURCE_NOT_FOUND');
      this.validateMetadata(client); await this.audit(tx, ctx, 'READ_METADATA', client, 'OK', actor.id);
      await this.administrator(adminToken, actor.id);
      return clientView(client);
    });
  }
  /** Keyset paging over metadata only; no secret hash is selected by the SQL adapter. */
  async list(adminToken: string, query: unknown, ctx: RequestContext) {
    await this.quota(ctx, 'admin', 30); const actor = await this.administrator(adminToken), page = clientPageQuery(query);
    return this.tx(async tx => {
      if (!tx.list) return fail(503, 'IDENTITY_UNAVAILABLE');
      const rows = await tx.list(page);
      if (!Array.isArray(rows) || rows.length > page.limit + 1) return fail(503, 'IDENTITY_UNAVAILABLE');
      let previous = page.after ?? '';
      for (const row of rows) { this.validateMetadata(row); if (row.id <= previous) return fail(503, 'IDENTITY_UNAVAILABLE'); previous = row.id; }
      const items = rows.slice(0, page.limit).map(clientView);
      await this.audit(tx, ctx, 'LIST_METADATA', null, 'OK', actor.id);
      await this.administrator(adminToken, actor.id);
      return { items, nextAfter: rows.length > page.limit ? items.at(-1)!.id : null };
    });
  }
  private basic(header: unknown) {
    if (typeof header !== 'string' || header.length > 512 || !/^Basic [A-Za-z0-9+/]+={0,2}$/.test(header)) return null;
    const bytes = Buffer.from(header.slice(6), 'base64');
    if (bytes.toString('base64') !== header.slice(6) || [...bytes].some(byte => byte < 33 || byte > 126)) return null;
    const parts = bytes.toString('ascii').split(':');
    return parts.length === 2 && uuid(parts[0]) && /^[A-Za-z0-9_-]{43}$/.test(parts[1]) ? { id: parts[0], secret: parts[1] } : null;
  }
  async token(header: unknown, body: unknown, ctx: RequestContext) {
    await this.quota(ctx, 'token', 60);
    if (!plain(body) || Object.keys(body).sort().join(',') !== 'grant_type,scope' || body.grant_type !== 'client_credentials') return fail(400, 'UNSUPPORTED_GRANT');
    const selected = scopeText(body.scope), credentials = this.basic(header);
    const result = await this.tx(async tx => {
      const client = credentials ? await tx.get(credentials.id) : null; if (client) this.validate(client);
      const correct = timingSafeEqual(Buffer.from(client?.secretHash ?? this.hash('dummy'), 'hex'), Buffer.from(this.hash('secret:' + (credentials?.secret ?? '')), 'hex'));
      if (!client?.enabled || !correct || client.kind !== 'SERVICE') { await this.audit(tx, ctx, 'TOKEN', client, 'INVALID_CLIENT'); return null; }
      if (selected.some(scope => !client.scopes.includes(scope))) { await this.audit(tx, ctx, 'TOKEN', client, 'INVALID_SCOPE'); return { denied: true } as const; }
      const token = this.codec.mint(client, selected); await this.audit(tx, ctx, 'TOKEN', client, 'OK');
      return { access_token: token, token_type: 'Bearer', expires_in: 300, scope: selected.join(' ') };
    });
    if (!result) return fail(401, 'INVALID_CLIENT'); if ('denied' in result) return fail(403, 'INSUFFICIENT_SCOPE'); return result;
  }
  async authenticate(token: string, required: B2bIdentityScope[], ctx: RequestContext, mode: 'SERVICE' | 'USER' = 'SERVICE'): Promise<B2bPrincipal> {
    await this.quota(ctx, 'authenticate', 300); const requested = required.length ? scopes(required) : [];
    if (mode !== 'SERVICE' && mode !== 'USER') return fail(400, 'INVALID_REQUEST');
    let clientId: string, revision: number | null = null, selected: B2bIdentityScope[], delegated: DelegatedUser | null = null;
    if (mode === 'SERVICE') { const claims = this.codec.verify(token); clientId = claims.client_id; revision = claims.revision; selected = scopeText(claims.scope); }
    else {
      if (!this.delegation) return fail(503, 'OIDC_NOT_CONFIGURED');
      try { delegated = await this.delegation.verify(token); } catch (error) { if (error instanceof B2bIdentityError) throw error; return fail(503, 'OIDC_UNAVAILABLE'); }
      const user = delegated;
      clientId = user.clientId; selected = scopes(user.tokenScopes).filter(scope => {
        if ((B2bPhase8Scopes as readonly string[]).includes(scope)) {
          return phase8Permissions[scope as typeof B2bPhase8Scopes[number]].every(permission => user.permissions.includes(permission));
        }
        return scope === 'b2b:context:read' ||
        user.permissions.includes(scope === 'b2b:drafts:write' || scope === 'b2b:operations:read' || scope === 'b2b:documents:issue' ? 'document.issue' : 'document.view') &&
        (!['b2b:sales-notes:write','b2b:corrections:write','b2b:guides:write','b2b:guides:issue','b2b:batches:write'].includes(scope) || user.permissions.includes('document.issue')) &&
        (scope !== 'b2b:webhooks:manage' || user.permissions.includes('setup.manage')) &&
        (!['b2b:exports:create','b2b:exports:read'].includes(scope) || user.permissions.includes('report.export')) &&
        (!['b2b:received:read','b2b:received:artifacts:read'].includes(scope) || user.permissions.includes('report.view')) &&
        (scope !== 'b2b:received:artifacts:read' || user.permissions.includes('report.export'));
      });
    }
    const result = await this.tx(async tx => {
      const client = await tx.get(clientId); if (client) this.validate(client);
      if (!client?.enabled || client.kind !== mode || (revision !== null && client.revision !== revision) ||
        (delegated && (client.oidcClientId !== delegated.oidcClientId || client.revision !== delegated.clientRevision)) || (mode === 'SERVICE' && selected.some(scope => !client.scopes.includes(scope)))) {
        await this.audit(tx, ctx, 'AUTHENTICATE', client, 'INVALID_TOKEN'); return { error: 'INVALID_TOKEN', status: 401 } as const;
      }
      selected = selected.filter(scope => client.scopes.includes(scope));
      if (!selected.length || requested.some(scope => !selected.includes(scope))) { await this.audit(tx, ctx, 'AUTHENTICATE', client, 'FORBIDDEN'); return { error: 'INSUFFICIENT_SCOPE', status: 403 } as const; }
      const scope = delegated?.scope;
      const effective = client.bindings.filter(binding => !scope || scope.kind === 'GLOBAL' || (scope.branchIds.includes(binding.branchId) && scope.emissionPointIds.includes(binding.pointId) && scope.series.includes(binding.seriesId)));
      if (!effective.length) { await this.audit(tx, ctx, 'AUTHENTICATE', client, 'NO_AUTHORIZED_CONTEXT'); return { error: 'NO_AUTHORIZED_CONTEXT', status: 403 } as const; }
      await this.audit(tx, ctx, 'AUTHENTICATE', client, 'OK', delegated?.userId ?? null);
      return { principal: { kind: mode, clientId: client.id, revision: client.revision, environment: 'BETA' as const, subjectId: delegated?.userId ?? null,
        userAuthRevision: delegated?.authRevision ?? null, scopes: selected, bindings: structuredClone(effective) } };
    });
    if (result.error !== undefined) return fail(result.status!, result.error);
    return result.principal;
  }
  jwks() { return this.codec.jwks(); }
}
