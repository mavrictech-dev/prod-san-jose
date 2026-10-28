/** SOURCE candidate, LOCAL/BETA only. This module has no listener or production wiring.
 *
 * Main assembly:
 * new B2bIntegrationAdmin(new HttpB2bIntegrationAdminOwner(privateHttp))
 * B2bIntegrationAdminModule.isolated(core, approvedEdgeFingerprints)
 * Identity must receive its existing liveAdminAuthority, including current human
 * authorization and step-up proofs. The facade neither creates claims nor calls
 * SERVICE introspection. No SERVICE/admin scope is required or auto-granted.
 * Main-owned B2bPrivateHttp must allow POST /internal/b2b/integration-admin and a
 * 16 MiB bounded JSON response for this fixed path (requests stay <=256 KiB).
 *
 * Public contract (a separate admin port; never send PWA passwords):
 * All calls require Authorization: Bearer <current human step-up admin token>.
 * Every URL requires exactly one environment=BETA. Only LIST also accepts
 * limit=1..50 (default 25) and after=<last UUID>; order is ascending UUID.
 * GET /b2b/v1/admin/applications?environment=BETA[&limit=25][&after=<uuid>]
 * POST /b2b/v1/admin/applications?environment=BETA
 * GET /b2b/v1/admin/applications/:id?environment=BETA
 * PATCH /b2b/v1/admin/applications/:id?environment=BETA
 * POST /b2b/v1/admin/applications/:id/rotate-secret?environment=BETA
 * CREATE body: {label,kind:'SERVICE'|'USER',scopes:string[],bindings:B2bBinding[],
 *               oidcClientId?:string}; oidcClientId required only for USER.
 * UPDATE body: {expectedRevision:number,label?:string,enabled?:boolean,
 *               scopes?:string[],bindings?:B2bBinding[]}; at least one change.
 * ROTATE body: {expectedRevision:number}; only SERVICE supports rotation.
 * B2bBinding: {issuerId:number,issuerRuc:11digits,environment:'BETA',branchId:uuid,
 *              pointId:uuid,seriesId:uuid,documentType:'01'|'03'}.
 * Each scope still requires explicit deployment activation and app enrollment.
 *
 * All success bodies contain schemaVersion:'factuez.b2b.v1',source:'SOURCE',
 * environment:'BETA',candidateOnly:true, and either {items,nextAfter:null|uuid}
 * for LIST or {application:B2bApplicationMetadata} for READ/CREATE/UPDATE/ROTATE.
 * Only successful SERVICE CREATE/ROTATE additionally returns clientSecret once.
 * GET/PATCH=200, CREATE=201, ROTATE=200. Never persist that secret in browser
 * state/storage/logs; subsequent metadata cannot recover it. Expected revision
 * is an integer in 1..2147483646; conflicts return 409, limits 429, outages 503.
 *
 * Private owner protocol: POST only, response 200 on success, envelope
 * {action:'LIST'|'READ'|'CREATE'|'UPDATE'|'ROTATE',args:{environment:'BETA',...}}.
 * LIST args: {environment,limit:number,after?:uuid}; READ: {environment,id};
 * CREATE: {environment,body}; UPDATE/ROTATE: {environment,id,body}.
 * Owner LIST returns {items:ClientMetadata[],nextAfter:null|uuid}; READ returns
 * ClientMetadata; CREATE/UPDATE/ROTATE return {client:ClientMetadata,clientSecret?}.
 * The mTLS owner peer must be enrolled in Identity peers.admin. Actor, proof,
 * context and roles cannot be supplied in args. Owner owns rate/audit/rollback.
 */
import { Body, Catch, Controller, Get, HttpException, Inject, Module, Param, Patch, Post, Query, Req, Res, UseFilters,
  type ArgumentsHost, type DynamicModule, type ExceptionFilter } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { B2bEnabledIdentityScopes, B2bSecurityError, b2bBindingKey, validB2bBinding,
  type B2bBinding, type B2bIdentityScope } from '@factuez/contracts/b2b-security';
import { b2bPrivatePeer, type B2bPrivateHttp } from '@factuez/service-access/dist/b2b';

export const B2B_INTEGRATION_ADMIN_OWNER_PATH = '/internal/b2b/integration-admin';
export interface B2bApplicationMetadata {
  id: string; label: string; kind: 'SERVICE' | 'USER'; enabled: boolean; revision: number;
  oidcClientId: string | null; scopes: B2bIdentityScope[]; bindings: B2bBinding[];
}
export interface B2bApplicationCreate {
  label: string; kind: 'SERVICE' | 'USER'; oidcClientId?: string; scopes: B2bIdentityScope[]; bindings: B2bBinding[];
}
export interface B2bApplicationUpdate {
  expectedRevision: number; label?: string; enabled?: boolean; scopes?: B2bIdentityScope[]; bindings?: B2bBinding[];
}
export type B2bIntegrationAdminRequest =
  | { action: 'LIST'; args: { environment: 'BETA'; limit: number; after?: string } }
  | { action: 'READ'; args: { environment: 'BETA'; id: string } }
  | { action: 'CREATE'; args: { environment: 'BETA'; body: B2bApplicationCreate } }
  | { action: 'UPDATE'; args: { environment: 'BETA'; id: string; body: B2bApplicationUpdate } }
  | { action: 'ROTATE'; args: { environment: 'BETA'; id: string; body: { expectedRevision: number } } };
/** Separate admin port. No SERVICE introspection, PWA credentials, or asserted roles in the payload. */
export interface B2bIntegrationAdminOwner {
  execute(adminBearer: string, request: B2bIntegrationAdminRequest): Promise<unknown>;
}
export class HttpB2bIntegrationAdminOwner implements B2bIntegrationAdminOwner {
  constructor(private readonly http: Pick<B2bPrivateHttp, 'post'>) {}
  async execute(adminBearer: string, request: B2bIntegrationAdminRequest): Promise<unknown> {
    try { return await this.http.post(B2B_INTEGRATION_ADMIN_OWNER_PATH, request, adminBearer); }
    catch (error) {
      // The existing bounded mTLS transport deliberately does not relay arbitrary owner error bodies.
      if (error instanceof B2bSecurityError && error.code === 'OWNER_REQUEST_DENIED') {
        const codes: Record<number, string> = { 400: 'INVALID_REQUEST', 401: 'INVALID_TOKEN', 403: 'ADMIN_ACCESS_DENIED',
          404: 'RESOURCE_NOT_FOUND', 409: 'REVISION_CONFLICT', 429: 'RATE_LIMITED' };
        throw new B2bSecurityError(codes[error.status] ? error.status : 503, codes[error.status] ?? 'OWNER_UNAVAILABLE');
      }
      throw error;
    }
  }
}
const fail = (status: number, code: string): never => { throw new B2bSecurityError(status, code); };
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const record = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: unknown, keys: string) => record(v) && Object.keys(v).sort().join(',') === keys;
const revision = (v: unknown, maximum = 2147483647): v is number => Number.isInteger(v) && Number(v) >= 1 && Number(v) <= maximum;
const label = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 120 && !/[\x00-\x1f\x7f]/.test(v);
const oidc = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(v);
const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._~-]{1,8192}$/.test(v);
function selectedScopes(v: unknown): v is B2bIdentityScope[] {
  return Array.isArray(v) && v.length > 0 && v.length <= B2bEnabledIdentityScopes.length && new Set(v).size === v.length &&
    v.every(scope => B2bEnabledIdentityScopes.includes(scope)) &&
    (!v.includes('b2b:artifacts:read') || v.includes('b2b:documents:read')) &&
    (!v.includes('b2b:received:artifacts:read') || v.includes('b2b:received:read')) &&
    (!v.some(scope => ['b2b:exports:create', 'b2b:exports:read', 'b2b:changes:read'].includes(scope)) || v.includes('b2b:documents:read'));
}
function selectedBindings(v: unknown): v is B2bBinding[] {
  return Array.isArray(v) && v.length > 0 && v.length <= 500 && v.every(validB2bBinding) && new Set(v.map(b2bBindingKey)).size === v.length;
}
/** Bound and copy data without running getters, toJSON, or proxy traps from an injected port. */
function json(input: unknown, owner = false): any {
  const status = owner ? 503 : 400, code = owner ? 'INVALID_ADMIN_OWNER_RESPONSE' : 'INVALID_REQUEST';
  let nodes = 0, bytes = 0;
  const seen = new WeakSet<object>(), maximum = owner ? 16 * 1024 * 1024 : 256 * 1024;
  const copy = (v: unknown, depth: number): any => {
    if (++nodes > (owner ? 400000 : 20000) || depth > 10) return fail(status, code);
    if (v === null || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') { bytes += Buffer.byteLength(v); if (bytes > maximum) return fail(status, code); return v; }
    if (!v || typeof v !== 'object' || types.isProxy(v) || seen.has(v)) return fail(status, code);
    const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return fail(status, code);
    seen.add(v);
    const desc = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(desc), result: any = array ? [] : {};
    if (array && (v.length > 500 || keys.length !== v.length + 1)) return fail(status, code);
    for (const key of keys) {
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) return fail(status, code);
      if (array && key === 'length') continue;
      const field = desc[key];
      if (!field.enumerable || !('value' in field) || array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= v.length)) return fail(status, code);
      bytes += Buffer.byteLength(key); if (bytes > maximum) return fail(status, code);
      result[key] = copy(field.value, depth + 1);
    }
    return result;
  };
  return copy(input, 0);
}
function metadata(value: unknown): B2bApplicationMetadata {
  if (!exact(value, 'bindings,enabled,id,kind,label,oidcClientId,revision,scopes')) return fail(503, 'INVALID_ADMIN_OWNER_RESPONSE');
  const v = value as B2bApplicationMetadata;
  if (!uuid(v.id) || !label(v.label) || v.label.trim() !== v.label || !revision(v.revision) || typeof v.enabled !== 'boolean' ||
    (v.kind === 'SERVICE' ? v.oidcClientId !== null : v.kind !== 'USER' || !oidc(v.oidcClientId)) ||
    !selectedScopes(v.scopes) || !selectedBindings(v.bindings)) return fail(503, 'INVALID_ADMIN_OWNER_RESPONSE');
  return v;
}
function query(input: unknown, list = false) {
  const q = json(input);
  if (!record(q) || q.environment !== 'BETA' || Object.keys(q).some(key => !(list ? ['environment', 'limit', 'after'] : ['environment']).includes(key))) return fail(400, 'INVALID_QUERY');
  const limit = q.limit === undefined ? 25 : typeof q.limit === 'string' && /^[1-9][0-9]?$/.test(q.limit) ? Number(q.limit) : q.limit;
  if (list && (!Number.isInteger(limit) || limit < 1 || limit > 50 || q.after !== undefined && !uuid(q.after))) return fail(400, 'INVALID_QUERY');
  return { environment: 'BETA' as const, ...(list ? { limit: Number(limit), ...(q.after === undefined ? {} : { after: q.after as string }) } : {}) };
}
function createBody(input: unknown): B2bApplicationCreate {
  const b = json(input);
  if (!record(b) || Object.keys(b).some(key => !['label', 'kind', 'oidcClientId', 'scopes', 'bindings'].includes(key)) ||
    !label(b.label) || (b.kind === 'SERVICE' ? b.oidcClientId !== undefined : b.kind !== 'USER' || !oidc(b.oidcClientId)) ||
    !selectedScopes(b.scopes) || !selectedBindings(b.bindings)) return fail(400, 'INVALID_REQUEST');
  return b as B2bApplicationCreate;
}
function updateBody(input: unknown, rotate: boolean): B2bApplicationUpdate {
  const b = json(input), allowed = rotate ? ['expectedRevision'] : ['expectedRevision', 'label', 'enabled', 'scopes', 'bindings'];
  if (!record(b) || Object.keys(b).some(key => !allowed.includes(key)) || !revision(b.expectedRevision, 2147483646) ||
    (!rotate && Object.keys(b).length < 2) || b.label !== undefined && !label(b.label) ||
    b.enabled !== undefined && typeof b.enabled !== 'boolean' || b.scopes !== undefined && !selectedScopes(b.scopes) ||
    b.bindings !== undefined && !selectedBindings(b.bindings)) return fail(400, 'INVALID_REQUEST');
  return b as B2bApplicationUpdate;
}
const provenance = { schemaVersion: 'factuez.b2b.v1' as const, source: 'SOURCE' as const, environment: 'BETA' as const, candidateOnly: true as const };
const equivalent = (a: unknown[], b: unknown[]) => JSON.stringify(a.map(v => JSON.stringify(v)).sort()) === JSON.stringify(b.map(v => JSON.stringify(v)).sort());
/** Owner holds current admin, step-up, catalogue, rate and transactional audit proofs. No local claim manufacture. */
export class B2bIntegrationAdmin {
  constructor(private readonly owner: B2bIntegrationAdminOwner) {}
  private async run(bearer: string, request: B2bIntegrationAdminRequest) {
    if (!token(bearer)) return fail(401, 'INVALID_TOKEN');
    let result: any;
    try { result = json(await this.owner.execute(bearer, request), true); }
    catch (error) { if (error instanceof B2bSecurityError) throw error; return fail(503, 'OWNER_UNAVAILABLE'); }
    if (request.action === 'LIST') {
      if (!exact(result, 'items,nextAfter') || !Array.isArray(result.items) || result.items.length > request.args.limit) return fail(503, 'INVALID_ADMIN_OWNER_RESPONSE');
      let previous = request.args.after ?? '';
      for (const row of result.items) { metadata(row); if (row.id <= previous) return fail(503, 'INVALID_ADMIN_OWNER_RESPONSE'); previous = row.id; }
      if (result.nextAfter !== null && (!result.items.length || result.items.length !== request.args.limit || result.nextAfter !== previous)) return fail(503, 'INVALID_ADMIN_OWNER_RESPONSE');
      return { ...provenance, items: result.items as B2bApplicationMetadata[], nextAfter: result.nextAfter as string | null };
    }
    if (request.action === 'READ') {
      const application = metadata(result);
      if (application.id !== request.args.id) return fail(503, 'INVALID_ADMIN_OWNER_RESPONSE');
      return { ...provenance, application };
    }
    if (!record(result) || !['client', 'client,clientSecret'].includes(Object.keys(result).sort().join(','))) return fail(503, 'INVALID_ADMIN_OWNER_RESPONSE');
    const application = metadata(result.client), hasSecret = Object.hasOwn(result, 'clientSecret');
    const needsSecret = application.kind === 'SERVICE' && ['CREATE', 'ROTATE'].includes(request.action);
    if (hasSecret !== needsSecret || hasSecret && (typeof result.clientSecret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.clientSecret))) return fail(503, 'INVALID_ADMIN_OWNER_RESPONSE');
    if (request.action === 'CREATE') {
      const body = request.args.body;
      if (application.revision !== 1 || !application.enabled || application.kind !== body.kind || application.label !== body.label.trim() ||
        application.oidcClientId !== (body.oidcClientId ?? null) || !equivalent(application.scopes, body.scopes) ||
        !equivalent(application.bindings.map(b2bBindingKey), body.bindings.map(b2bBindingKey))) return fail(503, 'INVALID_ADMIN_OWNER_RESPONSE');
    } else {
      const body: B2bApplicationUpdate = request.args.body;
      if (application.id !== request.args.id || application.revision !== body.expectedRevision + 1 || request.action === 'ROTATE' && application.kind !== 'SERVICE') return fail(503, 'INVALID_ADMIN_OWNER_RESPONSE');
      if (request.action === 'UPDATE' && (body.label !== undefined && application.label !== body.label.trim() || body.enabled !== undefined && application.enabled !== body.enabled ||
        body.scopes !== undefined && !equivalent(application.scopes, body.scopes) || body.bindings !== undefined && !equivalent(application.bindings.map(b2bBindingKey), body.bindings.map(b2bBindingKey)))) return fail(503, 'INVALID_ADMIN_OWNER_RESPONSE');
    }
    // Never keep a secret on the facade; only this create/rotate response contains it.
    return { ...provenance, application, ...(hasSecret ? { clientSecret: result.clientSecret as string } : {}) };
  }
  async list(bearer: string, q: unknown) { const args = query(q, true); return this.run(bearer, { action: 'LIST', args: { ...args, limit: args.limit! } }); }
  async read(bearer: string, id: string, q: unknown) { if (!uuid(id)) return fail(400, 'INVALID_REQUEST'); return this.run(bearer, { action: 'READ', args: { ...query(q), id } }); }
  async create(bearer: string, q: unknown, body: unknown) { return this.run(bearer, { action: 'CREATE', args: { ...query(q), body: createBody(body) } }); }
  async update(bearer: string, id: string, q: unknown, body: unknown) { if (!uuid(id)) return fail(400, 'INVALID_REQUEST'); return this.run(bearer, { action: 'UPDATE', args: { ...query(q), id, body: updateBody(body, false) } }); }
  async rotate(bearer: string, id: string, q: unknown, body: unknown) { if (!uuid(id)) return fail(400, 'INVALID_REQUEST'); const b = updateBody(body, true); return this.run(bearer, { action: 'ROTATE', args: { ...query(q), id, body: { expectedRevision: b.expectedRevision } } }); }
}
function headers(res: any) { res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Pragma', 'no-cache'); res.setHeader('X-Content-Type-Options', 'nosniff'); }
@Catch()
export class B2bIntegrationAdminErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse(); headers(res);
    const status = error instanceof B2bSecurityError && [400,401,403,404,409,429,503].includes(error.status) ? error.status :
      error instanceof HttpException && [400,404,413,415].includes(error.getStatus()) ? error.getStatus() : 503;
    const safe = ['INVALID_REQUEST','INVALID_QUERY','INVALID_TOKEN','ADMIN_ACCESS_DENIED','FORBIDDEN','STEP_UP_REQUIRED','RESOURCE_NOT_FOUND',
      'REVISION_CONFLICT','CLIENT_KIND_NOT_ALLOWED','INVALID_SCOPE','INVALID_BINDINGS','RATE_LIMITED','IDENTITY_UNAVAILABLE',
      'ADMIN_AUTHORITY_UNAVAILABLE','CATALOGUE_UNAVAILABLE','OWNER_UNAVAILABLE','INVALID_ADMIN_OWNER_RESPONSE'];
    const code = error instanceof B2bSecurityError && safe.includes(error.code) ? error.code : status < 500 ? 'INVALID_REQUEST' : 'OWNER_UNAVAILABLE';
    if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
    if (status === 429) res.setHeader('Retry-After', '60');
    res.status(status).json({ ...provenance, requestId: randomUUID(), code, message: code, retryable: status === 429 || status === 503 });
  }
}
const CORE = Symbol('B2B integration admin'), PEERS = Symbol('B2B integration admin edge peers');
@Controller('b2b/v1/admin/applications')
@UseFilters(B2bIntegrationAdminErrorFilter)
export class B2bIntegrationAdminController {
  constructor(@Inject(CORE) private readonly core: B2bIntegrationAdmin, @Inject(PEERS) private readonly peers: string[]) {}
  private context(req: any, res: any) {
    headers(res); b2bPrivatePeer(req, this.peers);
    const authorization = req.headers.authorization;
    if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(authorization)) return fail(401, 'INVALID_TOKEN');
    return authorization.slice(7);
  }
  @Get() list(@Req()r: any, @Res({passthrough:true})s: any, @Query()q: unknown) { return this.core.list(this.context(r,s), q); }
  @Post() create(@Req()r: any, @Res({passthrough:true})s: any, @Query()q: unknown, @Body()b: unknown) { return this.core.create(this.context(r,s), q, b); }
  @Get(':id') read(@Req()r: any, @Res({passthrough:true})s: any, @Param('id')id: string, @Query()q: unknown) { return this.core.read(this.context(r,s), id, q); }
  @Patch(':id') update(@Req()r: any, @Res({passthrough:true})s: any, @Param('id')id: string, @Query()q: unknown, @Body()b: unknown) { return this.core.update(this.context(r,s), id, q, b); }
  @Post(':id/rotate-secret') rotate(@Req()r: any, @Res({passthrough:true})s: any, @Param('id')id: string, @Query()q: unknown, @Body()b: unknown) { const bearer = this.context(r,s); s.status(200); return this.core.rotate(bearer, id, q, b); }
}
@Module({})
export class B2bIntegrationAdminModule {
  static isolated(core: B2bIntegrationAdmin, peers: string[]): DynamicModule {
    if (!(core instanceof B2bIntegrationAdmin) || !Array.isArray(peers) || !peers.length || peers.length > 100 || new Set(peers).size !== peers.length || peers.some(p => !/^[a-f0-9]{64}$/.test(p))) throw new Error('Explicit integration admin mTLS edge peers required');
    return { module: B2bIntegrationAdminModule, controllers: [B2bIntegrationAdminController], providers: [
      { provide: CORE, useValue: core }, { provide: PEERS, useValue: [...peers] }, B2bIntegrationAdminErrorFilter ] };
  }
}
