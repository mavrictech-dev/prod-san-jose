import { Catch, Controller, Get, HttpException, Inject, Module, Param, Post, Req, Res, UseFilters, type ArgumentsHost, type DynamicModule } from '@nestjs/common';
import { B2bSecurityError, b2bBindingsContain, type B2bIdentityScope } from '@factuez/contracts/b2b-security';
import { b2bGuideIssueScopes, b2bGuideIssueReadScopes, validB2bGuideIssueBinding, type B2bGuideIssueBinding } from '@factuez/contracts/b2b-guide-security';
import { b2bIssuerId, b2bQuery, b2bUuid } from '@factuez/contracts/b2b-read-query';
import { B2bOwnerReadFrame, type B2bIdentityPort } from '@factuez/service-access/dist/b2b-read-adapter';
import { B2bPrivateHttp, b2bPrivatePeer } from '@factuez/service-access/dist/b2b';
import { boundedGuideIssueRequest as sharedBoundedRequest, validateGuideIssueRequest as sharedIssueRequest, validateGuideIssuanceResponse, type GuideIssueWireRequest } from '@factuez/service-access/dist/b2b-guide-issue-wire';
import { B2bGuideHttpErrorFilter } from './guides';
import { b2bReadHeaders } from './http';

type Kind = 'SERVICE' | 'USER';
export interface B2bGuideIssueOwner {
  issue(token: string, kind: Kind, request: GuideIssueWireRequest): Promise<unknown>;
  read(token: string, kind: Kind, binding: B2bGuideIssueBinding, draftId: string, operationId: string): Promise<unknown>;
}
/** Fixed RPC paths; production transport allowlists are configured separately. */
export class HttpB2bGuideIssueOwner implements B2bGuideIssueOwner {
  constructor(private readonly http: Pick<B2bPrivateHttp, 'post'>) {}
  issue(token: string, kind: Kind, request: GuideIssueWireRequest) {
    return this.http.post('/internal/b2b/issue-guide', { kind, request }, token);
  }
  read(token: string, kind: Kind, binding: B2bGuideIssueBinding, draftId: string, operationId: string) {
    return this.http.post('/internal/b2b/read-guide-issuance', { kind, binding, draftId, operationId }, token);
  }
}
function invalid(): never { throw new B2bSecurityError(400, 'INVALID_GUIDE_ISSUE_REQUEST'); }
/** Only exceptions from these two known request validators cross this adapter.
 * Source/dist packages may have distinct Error constructors. Inspect own data
 * descriptors to preserve their single 413 case without trusting owner errors. */
function requestWire<T>(work: () => T): T {
  try { return work(); } catch (error) {
    if (error instanceof Error && Object.getOwnPropertyDescriptor(error, 'status')?.value === 413 &&
      Object.getOwnPropertyDescriptor(error, 'code')?.value === 'INVALID_GUIDE_ISSUE_REQUEST')
      throw new B2bSecurityError(413, 'INVALID_GUIDE_ISSUE_REQUEST');
    return invalid();
  }
}
function boundedGuideIssueRequest<T>(value: T): T { return requestWire(() => sharedBoundedRequest(value)); }
function validateGuideIssueRequest(value: unknown): GuideIssueWireRequest { return requestWire(() => sharedIssueRequest(value)); }
function credentials(token: string, kind: Kind) {
  if (!['SERVICE', 'USER'].includes(kind) || typeof token !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token))
    throw new B2bSecurityError(401, 'INVALID_TOKEN');
}
function bindingInput(input: unknown): B2bGuideIssueBinding {
  const binding = boundedGuideIssueRequest(input);
  if (!validB2bGuideIssueBinding(binding)) invalid();
  return binding;
}
/** A fresh identity frame per invocation; neither drafts nor a catalogue anchor grant ISSUE. */
export class B2bGuideIssuances {
  constructor(private readonly identity: B2bIdentityPort, private readonly owner: B2bGuideIssueOwner) {}
  private async call(token: string, kind: Kind, binding: B2bGuideIssueBinding, draftId: string,
    operationId: string | null, request?: GuideIssueWireRequest) {
    const required: B2bIdentityScope[] = [...(operationId === null ? b2bGuideIssueScopes : b2bGuideIssueReadScopes)];
    const frame = new B2bOwnerReadFrame(this.identity, kind);
    const before = await frame.principal(token, [...required]);
    if (!b2bBindingsContain(before.bindings, binding.draft.anchor)) throw new B2bSecurityError(404, 'RESOURCE_NOT_FOUND');
    const value = operationId === null ? await this.owner.issue(token, kind, request!) : await this.owner.read(token, kind, binding, draftId, operationId);
    const result = validateGuideIssuanceResponse(value, binding, draftId, operationId, request?.expectedRevision);
    const after = await frame.principal(token, [...required]);
    if (!b2bBindingsContain(after.bindings, binding.draft.anchor)) throw new B2bSecurityError(404, 'RESOURCE_NOT_FOUND');
    return result;
  }
  async issue(token: string, kind: Kind, input: unknown) {
    credentials(token, kind);
    const request = validateGuideIssueRequest(input);
    return this.call(token, kind, request.binding, request.draftId, null, request);
  }
  async read(token: string, kind: Kind, input: unknown, draftId: string, operationId: string) {
    credentials(token, kind);
    const binding = bindingInput(input);
    if (!b2bUuid(draftId) || !b2bUuid(operationId)) invalid();
    return this.call(token, kind, binding, draftId, operationId);
  }
}

/** Normalize every dependency error to a finite code set before public serialization. */
@Catch()
export class B2bGuideIssueHttpErrorFilter extends B2bGuideHttpErrorFilter {
  catch(error: unknown, host: ArgumentsHost) {
    if (error instanceof B2bSecurityError) {
      const codes: Record<number, string> = { 400: 'INVALID_GUIDE_ISSUE_REQUEST', 401: 'INVALID_TOKEN', 403: 'ACCESS_DENIED',
        404: 'RESOURCE_NOT_FOUND', 409: 'GUIDE_ISSUE_CONFLICT', 412: 'REVISION_CONFLICT', 413: 'INVALID_GUIDE_ISSUE_REQUEST',
        422: 'GUIDE_ISSUE_PROFILE_NOT_SUPPORTED', 428: 'IF_MATCH_REQUIRED', 429: 'RATE_LIMITED', 503: 'OWNER_UNAVAILABLE' };
      const status = typeof error.status === 'number' && Object.hasOwn(codes, error.status) ? error.status : 503;
      return super.catch(new B2bSecurityError(status, codes[status]), host);
    }
    // Do not inherit another adapter's trust in arbitrary dependency error codes.
    // Parser metadata is read through data descriptors; http-errors stores the
    // numeric status on its immediate prototype. Parser text is never copied.
    if (error && typeof error === 'object') {
      const type = Object.getOwnPropertyDescriptor(error, 'type')?.value;
      const status = Object.getOwnPropertyDescriptor(error, 'status')?.value ??
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(error) ?? {}, 'status')?.value;
      if (type === 'entity.too.large' && status === 413 || type === 'entity.parse.failed' && status === 400)
        return super.catch(new HttpException('INVALID_REQUEST', status), host);
    }
    if (error instanceof HttpException && [400, 404, 413].includes(error.getStatus())) return super.catch(error, host);
    return super.catch(new B2bSecurityError(503, 'OWNER_UNAVAILABLE'), host);
  }
}
const CORE = Symbol('Local candidate B2B guide issuance'), PEERS = Symbol('Guide issuance peers');
const QUERY = ['issuerId', 'issuerRuc', 'environment', 'branchId', 'pointId', 'seriesId', 'documentType', 'guideSeriesId', 'guideType', 'fiscalSeriesId'] as const;
@Controller('b2b/v1')
@UseFilters(B2bGuideIssueHttpErrorFilter)
export class B2bGuideIssueController {
  constructor(@Inject(CORE) private readonly core: B2bGuideIssuances, @Inject(PEERS) private readonly peers: readonly string[]) {}
  private context(req: any, res: any) {
    b2bReadHeaders(res); b2bPrivatePeer(req, this.peers);
    const authorization = req.headers.authorization, kind = req.headers['x-factuez-actor-kind'];
    const names: string[] = (req.rawHeaders ?? []).filter((_v: string, i: number) => i % 2 === 0).map((v: string) => v.toLowerCase());
    if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(authorization) ||
      typeof kind !== 'string' || !['SERVICE', 'USER'].includes(kind) ||
      ['authorization', 'x-factuez-actor-kind'].some(name => names.filter(n => n === name).length !== 1)) throw new B2bSecurityError(401, 'INVALID_TOKEN');
    if (new Set(names).size !== names.length || names.some(name => {
      const normalized = name.replace(/[-_]/g, '');
      return ['authorization', 'xfactuezactorkind', 'idempotencykey', 'ifmatch'].includes(normalized) &&
        !['authorization', 'x-factuez-actor-kind', 'idempotency-key', 'if-match'].includes(name);
    })) invalid();
    return { token: authorization.slice(7), kind: kind as Kind };
  }
  @Post('guide-drafts/:id/issuance')
  async issue(@Req() req: any, @Res() res: any, @Param('id') id: string) {
    const c = this.context(req, res);
    if (req.url?.includes('?') || req.query && Object.keys(req.query).length) invalid();
    if (req.headers['if-match'] === undefined) throw new B2bSecurityError(428, 'IF_MATCH_REQUIRED');
    const body: any = boundedGuideIssueRequest(req.body);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'binding')) invalid();
    const request = validateGuideIssueRequest({ schemaVersion: 'factuez.b2b.guide-issue.v1', binding: body.binding,
      draftId: id, expectedRevision: req.headers['if-match'], idempotencyKey: req.headers['idempotency-key'] });
    const result = await this.core.issue(c.token, c.kind, request);
    res.setHeader('ETag', request.expectedRevision); res.setHeader('Idempotency-Key', request.idempotencyKey);
    res.setHeader('X-Operation-Id', result.operationId); res.setHeader('X-Idempotent-Replay', String(result.replayed));
    res.status(200).json(result);
  }
  @Get('guide-drafts/:id/issuances/:operationId')
  async read(@Req() req: any, @Res() res: any, @Param('id') id: string, @Param('operationId') operationId: string) {
    const c = this.context(req, res);
    if (req.headers['transfer-encoding'] !== undefined || req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0' || req.body !== undefined) invalid();
    // Inspect the raw URL too: parsed query objects can collapse duplicate keys.
    const raw = new URLSearchParams((req.originalUrl ?? req.url ?? '').split('?').slice(1).join('?'));
    const names = [...raw.keys()];
    if (new Set(names).size !== names.length || names.some(name => !QUERY.includes(name as typeof QUERY[number]))) invalid();
    const q = b2bQuery(boundedGuideIssueRequest(req.query), QUERY, QUERY);
    const binding = bindingInput({ draft: { anchor: { issuerId: b2bIssuerId(q.issuerId), issuerRuc: q.issuerRuc,
      environment: q.environment, branchId: q.branchId, pointId: q.pointId, seriesId: q.seriesId, documentType: q.documentType },
      guideSeriesId: q.guideSeriesId, guideType: q.guideType }, fiscalSeriesId: q.fiscalSeriesId });
    const result = await this.core.read(c.token, c.kind, binding, id, operationId);
    res.setHeader('ETag', `"v${result.snapshot.draftRevision}"`); res.status(200).json(result);
  }
}
@Module({})
export class B2bGuideIssueModule {
  static isolated(core: B2bGuideIssuances, peers: string[]): DynamicModule {
    if (!core || typeof core.issue !== 'function' || typeof core.read !== 'function' || !Array.isArray(peers) || !peers.length ||
      peers.length > 100 || new Set(peers).size !== peers.length || peers.some(p => !/^[a-f0-9]{64}$/.test(p)))
      throw new Error('Explicit guide issuance facade and mTLS peers required');
    return { module: B2bGuideIssueModule, controllers: [B2bGuideIssueController], providers: [
      { provide: CORE, useValue: core }, { provide: PEERS, useValue: Object.freeze([...peers]) }, B2bGuideIssueHttpErrorFilter,
    ] };
  }
}
// Keep the earlier inventory spelling compatible with the agreed primary class.
export { B2bGuideIssueController as B2bGuideIssuanceController };
