import { Controller, Get, Inject, Module, Param, Post, Req, Res, UseFilters, type DynamicModule } from '@nestjs/common';
import { B2bSecurityError, b2bBindingsContain } from '@factuez/contracts/b2b-security';
import { b2bGuideIssueScopes, b2bGuideIssueReadScopes } from '@factuez/contracts/b2b-guide-security';
import { b2bIssuerId, b2bQuery } from '@factuez/contracts/b2b-read-query';
import { B2bPrivateHttp, b2bPrivatePeer } from '@factuez/service-access/dist/b2b';
import { B2bOwnerReadFrame, type B2bIdentityPort } from '@factuez/service-access/dist/b2b-read-adapter';
import { boundedCarrierGuideWire, carrierGuideWireExact, carrierGuideWireBinding, carrierGuideReadyRequest, carrierGuideIssueRequest,
  carrierGuideWireScope, carrierGuideReadyResponse, carrierGuideIssuanceResponse, carrierGuideArtifactOwnerResponse,
  type CarrierGuideWireIssue, type CarrierGuideWireReady, type CarrierGuideWireScope } from '@factuez/service-access/dist/b2b-carrier-guide-wire';
import { B2bGuideIssueHttpErrorFilter } from './guide-issue';
import { b2bReadHeaders } from './http';

type Kind = 'SERVICE' | 'USER';
export interface B2bCarrierGuideOwner {
  ready(token: string, kind: Kind, request: CarrierGuideWireReady): Promise<unknown>;
  issue(token: string, kind: Kind, request: CarrierGuideWireIssue): Promise<unknown>;
  read(token: string, kind: Kind, scope: CarrierGuideWireScope): Promise<unknown>;
}
/** Fixed endpoint only. Main controls its explicit production transport allowlist.
 * ARTIFACT_OWNER is private and is deliberately absent from the public facade. */
export class HttpB2bCarrierGuideOwner implements B2bCarrierGuideOwner {
  constructor(private readonly http: Pick<B2bPrivateHttp, 'post'>) {}
  ready(token: string, kind: Kind, request: CarrierGuideWireReady) {
    return this.http.post('/internal/b2b/carrier-guides', { action: 'READY', kind, request }, token);
  }
  issue(token: string, kind: Kind, request: CarrierGuideWireIssue) {
    return this.http.post('/internal/b2b/carrier-guides', { action: 'ISSUE', kind, request }, token);
  }
  read(token: string, kind: Kind, scope: CarrierGuideWireScope) {
    return this.http.post('/internal/b2b/carrier-guides', { action: 'READ', kind, scope }, token);
  }
  async artifactCurrent(scope: CarrierGuideWireScope, access: { token: string; kind: Kind }, permission: 'ISSUE' | 'READ') {
    const checked = requestWire(() => carrierGuideWireScope(scope)); credentials(access.token, access.kind);
    if (!['ISSUE', 'READ'].includes(permission)) invalid();
    return carrierGuideArtifactOwnerResponse(await this.http.post('/internal/b2b/carrier-guides', {
      action: 'ARTIFACT_OWNER', kind: access.kind, scope: checked, permission }, access.token), checked);
  }
}
function invalid(): never { throw new B2bSecurityError(400, 'INVALID_CARRIER_GUIDE_REQUEST'); }
function requestWire<T>(work: () => T): T {
  try { return work(); } catch (error) {
    if (error instanceof Error && Object.getOwnPropertyDescriptor(error, 'status')?.value === 413 &&
      Object.getOwnPropertyDescriptor(error, 'code')?.value === 'INVALID_CARRIER_GUIDE_REQUEST')
      throw new B2bSecurityError(413, 'INVALID_CARRIER_GUIDE_REQUEST');
    return invalid();
  }
}
function credentials(token: string, kind: Kind) {
  if (!['SERVICE', 'USER'].includes(kind) || typeof token !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token))
    throw new B2bSecurityError(401, 'INVALID_TOKEN');
}
export class B2bCarrierGuideOperations {
  constructor(private readonly identity: B2bIdentityPort, private readonly owner: B2bCarrierGuideOwner) {}
  private async call<T>(token: string, kind: Kind, binding: CarrierGuideWireReady['binding'], action: 'ISSUE' | 'READ', work: () => Promise<T>) {
    credentials(token, kind);
    const frame = new B2bOwnerReadFrame(this.identity, kind);
    const required = [...(action === 'ISSUE' ? b2bGuideIssueScopes : b2bGuideIssueReadScopes)];
    const before = await frame.principal(token, required);
    if (!b2bBindingsContain(before.bindings, binding.draft.anchor)) throw new B2bSecurityError(404, 'RESOURCE_NOT_FOUND');
    const result = await work();
    const after = await frame.principal(token, required);
    if (!b2bBindingsContain(after.bindings, binding.draft.anchor)) throw new B2bSecurityError(404, 'RESOURCE_NOT_FOUND');
    return result;
  }
  async ready(token: string, kind: Kind, input: unknown) {
    const r = requestWire(() => carrierGuideReadyRequest(input));
    return this.call(token, kind, r.binding, 'ISSUE', async () => carrierGuideReadyResponse(await this.owner.ready(token, kind, r), r));
  }
  async issue(token: string, kind: Kind, input: unknown) {
    const r = requestWire(() => carrierGuideIssueRequest(input));
    return this.call(token, kind, r.binding, 'ISSUE', async () =>
      carrierGuideIssuanceResponse(await this.owner.issue(token, kind, r), { ...r, operationId: null }, r.expectedRevision));
  }
  async read(token: string, kind: Kind, input: unknown) {
    const s = requestWire(() => carrierGuideWireScope(input));
    return this.call(token, kind, s.binding, 'READ', async () => carrierGuideIssuanceResponse(await this.owner.read(token, kind, s), s));
  }
}
const CORE = Symbol('B2B carrier guide operations'), PEERS = Symbol('B2B carrier guide peers');
const QUERY = ['issuerId', 'issuerRuc', 'environment', 'branchId', 'pointId', 'seriesId', 'documentType', 'guideSeriesId', 'guideType', 'fiscalSeriesId'] as const;
@Controller('b2b/v1')
@UseFilters(B2bGuideIssueHttpErrorFilter)
export class B2bCarrierGuideController {
  constructor(@Inject(CORE) private readonly core: B2bCarrierGuideOperations, @Inject(PEERS) private readonly peers: readonly string[]) {}
  private context(req: any, res: any) {
    b2bReadHeaders(res); b2bPrivatePeer(req, this.peers);
    const authorization = req.headers.authorization, kind = req.headers['x-factuez-actor-kind'];
    const names: string[] = (req.rawHeaders ?? []).filter((_v: string, i: number) => i % 2 === 0).map((v: string) => v.toLowerCase());
    if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(authorization) ||
      !['SERVICE', 'USER'].includes(kind) || ['authorization', 'x-factuez-actor-kind'].some(name => names.filter(n => n === name).length !== 1))
      throw new B2bSecurityError(401, 'INVALID_TOKEN');
    if (new Set(names).size !== names.length || names.some(name => ['authorization', 'xfactuezactorkind', 'idempotencykey', 'ifmatch'].includes(name.replace(/[-_]/g, '')) &&
      !['authorization', 'x-factuez-actor-kind', 'idempotency-key', 'if-match'].includes(name))) invalid();
    return { token: authorization.slice(7), kind: kind as Kind };
  }
  private postBody(req: any, keys: string[]) {
    if (req.url?.includes('?') || Object.keys(req.query ?? {}).length || typeof req.headers['content-type'] !== 'string' ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'])) invalid();
    const value = requestWire(() => boundedCarrierGuideWire(req.body)); requestWire(() => carrierGuideWireExact(value, keys));
    return value as Record<string, unknown>;
  }
  @Post('carrier-guide-drafts/:id/ready')
  async ready(@Req() req: any, @Res() res: any, @Param('id') id: string) {
    const c = this.context(req, res), b = this.postBody(req, ['binding', 'body']);
    const result = await this.core.ready(c.token, c.kind, { binding: b.binding, draftId: id, body: b.body });
    res.setHeader('ETag', result.revision); res.status(200).json(result);
  }
  @Post('carrier-guide-drafts/:id/issuance')
  async issue(@Req() req: any, @Res() res: any, @Param('id') id: string) {
    const c = this.context(req, res), b = this.postBody(req, ['binding']);
    if (req.headers['if-match'] === undefined) throw new B2bSecurityError(428, 'IF_MATCH_REQUIRED');
    const request = requestWire(() => carrierGuideIssueRequest({ schemaVersion: 'factuez.b2b.carrier-guide-issue.v1',
      binding: b.binding, draftId: id, expectedRevision: req.headers['if-match'], idempotencyKey: req.headers['idempotency-key'] }));
    const result = await this.core.issue(c.token, c.kind, request);
    res.setHeader('ETag', request.expectedRevision); res.setHeader('Idempotency-Key', request.idempotencyKey);
    res.setHeader('X-Operation-Id', result.operationId); res.setHeader('X-Idempotent-Replay', String(result.replayed));
    res.status(200).json(result);
  }
  @Get('carrier-guide-drafts/:id/issuances/:operationId')
  async read(@Req() req: any, @Res() res: any, @Param('id') id: string, @Param('operationId') operationId: string) {
    const c = this.context(req, res);
    if (req.headers['transfer-encoding'] !== undefined || req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0' || req.body !== undefined) invalid();
    const raw = new URLSearchParams((req.originalUrl ?? req.url ?? '').split('?').slice(1).join('?')), names = [...raw.keys()];
    if (new Set(names).size !== names.length || names.some(n => !QUERY.includes(n as typeof QUERY[number]))) invalid();
    const q = b2bQuery(requestWire(() => boundedCarrierGuideWire(req.query)), QUERY, QUERY);
    const binding = requestWire(() => carrierGuideWireBinding({ draft: { anchor: { issuerId: b2bIssuerId(q.issuerId), issuerRuc: q.issuerRuc,
      environment: q.environment, branchId: q.branchId, pointId: q.pointId, seriesId: q.seriesId, documentType: q.documentType },
      guideSeriesId: q.guideSeriesId, guideType: q.guideType }, fiscalSeriesId: q.fiscalSeriesId }));
    const result = await this.core.read(c.token, c.kind, { binding, draftId: id, operationId });
    res.setHeader('ETag', `"v${result.snapshot.draftRevision}"`); res.status(200).json(result);
  }
}
@Module({})
export class B2bCarrierGuideModule {
  static isolated(core: B2bCarrierGuideOperations, peers: readonly string[]): DynamicModule {
    if (!core || ['ready', 'issue', 'read'].some(name => typeof (core as any)[name] !== 'function') || !Array.isArray(peers) ||
      !peers.length || peers.length > 100 || new Set(peers).size !== peers.length || peers.some(p => !/^[a-f0-9]{64}$/.test(p)))
      throw new Error('Explicit GT31 facade and mTLS peers required');
    return { module: B2bCarrierGuideModule, controllers: [B2bCarrierGuideController], providers: [
      { provide: CORE, useValue: core }, { provide: PEERS, useValue: Object.freeze([...peers]) }, B2bGuideIssueHttpErrorFilter] };
  }
}
