import { Catch, Controller, Get, HttpException, Inject, Module, Param, Patch, Post, Req, Res, UseFilters, type ArgumentsHost, type DynamicModule } from '@nestjs/common';
import { B2bSecurityError, b2bBindingsContain, type B2bIdentityScope } from '@factuez/contracts/b2b-security';
import { b2bGuideBindingKey, validB2bGuideBinding, type B2bGuideBinding } from '@factuez/contracts/b2b-guide-security';
import { b2bIssuerId, b2bQuery, b2bUuid } from '@factuez/contracts/b2b-read-query';
import { B2bOwnerReadFrame, type B2bIdentityPort } from '@factuez/service-access/dist/b2b-read-adapter';
import { B2bPrivateHttp, b2bPrivatePeer } from '@factuez/service-access/dist/b2b';
import { correctionEvidenceFreeze, correctionEvidenceHash } from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import { B2bReadErrorFilter, b2bReadHeaders } from './http';

type Kind = 'SERVICE' | 'USER';
export type B2bGuideAction = 'CREATE' | 'PATCH' | 'READY' | 'CANCEL' | 'READ' | 'LIST' | 'OPERATION';
export interface B2bGuideOwner {
  execute(token: string, kind: Kind, action: B2bGuideAction, args: unknown): Promise<unknown>;
}
/** Fixed owner path. Its transport allowlist is configured separately; this module does not activate it. */
export class HttpB2bGuideOwner implements B2bGuideOwner {
  constructor(private readonly http: Pick<B2bPrivateHttp, 'post'>) {}
  execute(token: string, kind: Kind, action: B2bGuideAction, args: unknown) {
    return this.http.post('/internal/b2b/guides', { kind, action, args }, token);
  }
}

function invalid(): never { throw new B2bSecurityError(400, 'INVALID_GUIDE_REQUEST'); }
function inconsistent(): never { throw new B2bSecurityError(503, 'INCONSISTENT_OWNER_RESPONSE'); }
function bounded<T>(value: T, response = false): T {
  try {
    const copy = correctionEvidenceFreeze(value);
    if (Buffer.byteLength(JSON.stringify(copy)) > (response ? 2 * 1024 * 1024 : 256 * 1024)) throw new Error();
    return copy;
  } catch { return response ? inconsistent() : invalid(); }
}
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
    keys.some(key => !Object.hasOwn(value, key))) invalid();
}
function pair(value: unknown): B2bGuideBinding {
  const copy = bounded(value);
  if (!validB2bGuideBinding(copy) || typeof copy.anchor.documentType !== 'string') invalid();
  return copy;
}
function revision(value: unknown): value is string {
  return typeof value === 'string' && /^"v[1-9][0-9]{0,8}"$/.test(value);
}
function key(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(value); }
function flags(value: Record<string, unknown>) {
  if (value.candidateOnly !== true || value.fiscalExecutionEnabled !== false || value.transmissionAuthorized !== false) inconsistent();
}
/** A nested client/body claim is never allowed to turn a draft into fiscal/transport authority. */
function noActivation(value: unknown) {
  if (!value || typeof value !== 'object') return;
  for (const [name, item] of Object.entries(value)) {
    if (['fiscalExecutionEnabled', 'transmissionAuthorized', 'authorizedForTransfer'].includes(name) && item !== false ||
      name === 'candidateOnly' && item !== true || name === 'referenceVerification' && item !== 'NOT_VERIFIED') inconsistent();
    noActivation(item);
  }
}
function instant(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
}
function view(value: unknown, binding: B2bGuideBinding, id: string | null = null) {
  exact(value, ['schemaVersion', 'id', 'binding', 'revision', 'state', 'body', 'bodySha256', 'createdAt', 'updatedAt',
    'candidateOnly', 'fiscalExecutionEnabled', 'transmissionAuthorized', 'authorizedForTransfer', 'referenceVerification']);
  flags(value); noActivation(value);
  if (value.schemaVersion !== 'factuez.b2b.guide-draft.v1' || !b2bUuid(value.id) || id !== null && value.id !== id ||
    !validB2bGuideBinding(value.binding) || b2bGuideBindingKey(value.binding) !== b2bGuideBindingKey(binding) ||
    !revision(value.revision) || typeof value.state !== 'string' || !['DRAFT', 'READY', 'CANCELLED'].includes(value.state) ||
    !value.body || typeof value.body !== 'object' || Array.isArray(value.body) ||
    typeof value.bodySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.bodySha256) || correctionEvidenceHash(value.body) !== value.bodySha256 ||
    !instant(value.createdAt) || !instant(value.updatedAt) || Date.parse(value.updatedAt) < Date.parse(value.createdAt) ||
    value.authorizedForTransfer !== false || value.referenceVerification !== 'NOT_VERIFIED') inconsistent();
  return value;
}
function operationView(value: unknown, binding: B2bGuideBinding, operationId: string | null = null, draftId: string | null = null, action?: B2bGuideAction) {
  exact(value, ['operationId', 'requestId', 'draftId', 'action', 'state', 'binding', 'candidateOnly', 'fiscalExecutionEnabled', 'transmissionAuthorized']);
  flags(value);
  if (!b2bUuid(value.operationId) || !b2bUuid(value.requestId) || !b2bUuid(value.draftId) ||
    operationId !== null && value.operationId !== operationId || draftId !== null && value.draftId !== draftId ||
    typeof value.action !== 'string' || !['CREATE', 'PATCH', 'READY', 'CANCEL'].includes(value.action) || action !== undefined && value.action !== action ||
    value.state !== 'SUCCEEDED_LOCAL' || !validB2bGuideBinding(value.binding) || b2bGuideBindingKey(value.binding) !== b2bGuideBindingKey(binding)) inconsistent();
  return value;
}

/** Seven draft-only operations. Identity is re-introspected before AND after each owner call.
 * The anchor is checked as a whole tuple, not Cartesian issuer/branch/series grants.
 * A guide-series grant is additionally enforced by the Billing owner; an anchor alone cannot create it. */
export class B2bGuideCommands {
  constructor(private readonly identity: B2bIdentityPort, private readonly owner: B2bGuideOwner) {}
  async call(token: string, kind: Kind, action: B2bGuideAction, input: unknown): Promise<any> {
    if (!['SERVICE', 'USER'].includes(kind) || typeof token !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token))
      throw new B2bSecurityError(401, 'INVALID_TOKEN');
    if (!['CREATE', 'PATCH', 'READY', 'CANCEL', 'READ', 'LIST', 'OPERATION'].includes(action)) invalid();
    const args = bounded(input), writing = ['CREATE', 'PATCH', 'READY', 'CANCEL'].includes(action);
    exact(args, writing ? ['binding', 'id', 'key', 'ifMatch', 'body'] : action === 'LIST' ? ['binding', 'limit', 'after'] : ['binding', 'id']);
    const binding = pair(args.binding);
    if (writing) {
      if (!key(args.key)) invalid();
      if (action === 'CREATE' ? args.id !== null || args.ifMatch !== null : !b2bUuid(args.id)) invalid();
      if (action !== 'CREATE' && args.ifMatch === null) throw new B2bSecurityError(428, 'IF_MATCH_REQUIRED');
      if (action !== 'CREATE' && !revision(args.ifMatch)) invalid();
      if (action === 'CREATE' || action === 'PATCH') {
        if (!args.body || typeof args.body !== 'object' || Array.isArray(args.body)) invalid();
      } else exact(args.body, []);
    } else if (action === 'LIST') {
      if (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 10 || args.after !== null && !b2bUuid(args.after)) invalid();
    } else if (!b2bUuid(args.id)) invalid();
    const required: B2bIdentityScope[] = [writing ? 'b2b:guides:write' : 'b2b:guides:read', 'b2b:documents:read'];
    if (action === 'OPERATION') required.push('b2b:guide-operations:read');
    const frame = new B2bOwnerReadFrame(this.identity, kind), principal = await frame.principal(token, required);
    if (!b2bBindingsContain(principal.bindings, binding.anchor)) throw new B2bSecurityError(404, 'RESOURCE_NOT_FOUND');
    const result = bounded(await this.owner.execute(token, kind, action, args), true);
    try {
      if (writing) {
        exact(result, ['response', 'operation', 'replayed']);
        if (typeof result.replayed !== 'boolean') inconsistent();
        const v = view(result.response, binding, args.id as string | null);
        operationView(result.operation, binding, null, v.id as string, action);
        const expectedRevision = action === 'CREATE' ? '"v1"' : `"v${Number((args.ifMatch as string).slice(2, -1)) + 1}"`;
        if (v.revision !== expectedRevision || (action === 'CREATE' || action === 'PATCH') && v.state !== 'DRAFT' ||
          action === 'READY' && v.state !== 'READY' || action === 'CANCEL' && v.state !== 'CANCELLED') inconsistent();
      } else if (action === 'READ') view(result, binding, args.id as string);
      else if (action === 'OPERATION') operationView(result, binding, args.id as string);
      else {
        exact(result, ['items', 'page']); exact(result.page, ['limit', 'hasMore', 'nextAfter', 'consistency']);
        if (!Array.isArray(result.items) || result.items.length > Number(args.limit) || result.page.limit !== args.limit ||
          typeof result.page.hasMore !== 'boolean' || result.page.nextAfter !== null && !b2bUuid(result.page.nextAfter) ||
          result.page.hasMore && (result.items.length !== args.limit || result.page.nextAfter !== result.items.at(-1)?.id) ||
          !result.page.hasMore && result.page.nextAfter !== null || result.page.consistency !== 'LIVE_KEYSET_NOT_A_SNAPSHOT') inconsistent();
        const items = result.items, after = args.after as string | null;
        for (const item of items) view(item, binding);
        if (new Set(items.map(item => item.id)).size !== items.length || items.some((item, index) =>
          after !== null && item.id <= after || index > 0 && item.id <= items[index - 1].id)) inconsistent();
      }
    } catch { inconsistent(); }
    await frame.principal(token, required);
    return result;
  }
  command(token: string, kind: Kind, binding: B2bGuideBinding, action: 'CREATE' | 'PATCH' | 'READY' | 'CANCEL', id: string | null, key: string, ifMatch: string | undefined, body: unknown) {
    return this.call(token, kind, action, { binding, id, key, ifMatch: ifMatch ?? null, body: body ?? (action === 'READY' || action === 'CANCEL' ? {} : null) });
  }
  read(token: string, kind: Kind, binding: B2bGuideBinding, id: string) { return this.call(token, kind, 'READ', { binding, id }); }
  list(token: string, kind: Kind, binding: B2bGuideBinding, limit: number, after: string | null) { return this.call(token, kind, 'LIST', { binding, limit, after }); }
  operation(token: string, kind: Kind, binding: B2bGuideBinding, id: string) { return this.call(token, kind, 'OPERATION', { binding, id }); }
}

const CORE = Symbol('Draft-only B2B guide facade'), PEERS = Symbol('B2B guide facade peers');
const QUERY = ['issuerId', 'issuerRuc', 'environment', 'branchId', 'pointId', 'seriesId', 'documentType', 'guideSeriesId', 'guideType'] as const;
/** Hosts must also install this filter globally to sanitize JSON-parser failures occurring before controllers. */
@Catch()
export class B2bGuideHttpErrorFilter extends B2bReadErrorFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const parser = error as { type?: unknown; status?: unknown } | null;
    if (parser?.type === 'entity.too.large' && parser.status === 413) return super.catch(new HttpException('INVALID_REQUEST', 413), host);
    if (parser?.type === 'entity.parse.failed' && parser.status === 400) return super.catch(new HttpException('INVALID_REQUEST', 400), host);
    return super.catch(error, host);
  }
}
@Controller('b2b/v1')
@UseFilters(B2bGuideHttpErrorFilter)
export class B2bGuideController {
  constructor(@Inject(CORE) private readonly core: B2bGuideCommands, @Inject(PEERS) private readonly peers: readonly string[]) {}
  private context(req: any, res: any) {
    b2bReadHeaders(res); b2bPrivatePeer(req, this.peers);
    const authorization = req.headers.authorization, kind = req.headers['x-factuez-actor-kind'];
    if (typeof kind !== 'string' || !['SERVICE', 'USER'].includes(kind) || typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(authorization) ||
      ['authorization', 'x-factuez-actor-kind', 'idempotency-key', 'if-match'].some(name =>
        (req.rawHeaders?.filter((v: string, i: number) => i % 2 === 0 && v.toLowerCase() === name).length ?? 0) > 1))
      throw new B2bSecurityError(401, 'INVALID_TOKEN');
    return { token: authorization.slice(7), kind: kind as Kind };
  }
  private query(req: any, listing = false) {
    if (req.headers['transfer-encoding'] || req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0' || req.body !== undefined) invalid();
    const q = b2bQuery(bounded(req.query), listing ? [...QUERY, 'limit', 'after'] : QUERY, QUERY);
    const binding = pair({ anchor: { issuerId: b2bIssuerId(q.issuerId), issuerRuc: q.issuerRuc, environment: q.environment,
      branchId: q.branchId, pointId: q.pointId, seriesId: q.seriesId, documentType: q.documentType }, guideSeriesId: q.guideSeriesId, guideType: q.guideType });
    if (listing && (q.limit !== undefined && (!/^[1-9][0-9]?$/.test(q.limit) || Number(q.limit) > 10) || q.after !== undefined && !b2bUuid(q.after))) invalid();
    return { binding, limit: q.limit === undefined ? 10 : Number(q.limit), after: q.after ?? null };
  }
  private async write(action: 'CREATE' | 'PATCH' | 'READY' | 'CANCEL', req: any, res: any, id: string | null) {
    const c = this.context(req, res); b2bQuery(bounded(req.query), []);
    const body = bounded(req.body); exact(body, action === 'CREATE' || action === 'PATCH' ? ['binding', 'body'] : ['binding']);
    const result = await this.core.command(c.token, c.kind, pair(body.binding), action, id, req.headers['idempotency-key'], req.headers['if-match'],
      action === 'CREATE' || action === 'PATCH' ? body.body : {});
    res.setHeader('ETag', result.response.revision); res.setHeader('Idempotency-Key', req.headers['idempotency-key']);
    res.setHeader('X-Operation-Id', result.operation.operationId); res.setHeader('X-Idempotent-Replay', String(result.replayed));
    res.status(action === 'CREATE' && !result.replayed ? 201 : 200);
    return result.response;
  }
  @Post('guide-drafts') create(@Req() req: any, @Res({ passthrough: true }) res: any) { return this.write('CREATE', req, res, null); }
  @Get('guide-drafts') list(@Req() req: any, @Res({ passthrough: true }) res: any) {
    const c = this.context(req, res), q = this.query(req, true); return this.core.list(c.token, c.kind, q.binding, q.limit, q.after);
  }
  @Get('guide-drafts/:id') async read(@Req() req: any, @Res({ passthrough: true }) res: any, @Param('id') id: string) {
    const c = this.context(req, res), q = this.query(req); const result = await this.core.read(c.token, c.kind, q.binding, id); res.setHeader('ETag', result.revision); return result;
  }
  @Patch('guide-drafts/:id') patch(@Req() req: any, @Res({ passthrough: true }) res: any, @Param('id') id: string) { return this.write('PATCH', req, res, id); }
  @Post('guide-drafts/:id/ready') ready(@Req() req: any, @Res({ passthrough: true }) res: any, @Param('id') id: string) { return this.write('READY', req, res, id); }
  @Post('guide-drafts/:id/cancel') cancel(@Req() req: any, @Res({ passthrough: true }) res: any, @Param('id') id: string) { return this.write('CANCEL', req, res, id); }
  @Get('guide-operations/:id') operation(@Req() req: any, @Res({ passthrough: true }) res: any, @Param('id') id: string) {
    const c = this.context(req, res), q = this.query(req); return this.core.operation(c.token, c.kind, q.binding, id);
  }
}
@Module({})
export class B2bGuideModule {
  static isolated(core: B2bGuideCommands, peers: string[]): DynamicModule {
    if (!core || !Array.isArray(peers) || !peers.length || peers.length > 100 || new Set(peers).size !== peers.length || peers.some(p => !/^[a-f0-9]{64}$/.test(p)))
      throw new Error('Explicit guide facade and mTLS peers required');
    return { module: B2bGuideModule, controllers: [B2bGuideController], providers: [
      { provide: CORE, useValue: core }, { provide: PEERS, useValue: Object.freeze([...peers]) }, B2bGuideHttpErrorFilter,
    ] };
  }
}
