import { Catch, Controller, HttpException, Inject, Module, Post, Req, Res, UseFilters,
  type ArgumentsHost, type DynamicModule, type ExceptionFilter } from '@nestjs/common';
import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { b2bPrivatePeer, newB2bRequestId } from '@factuez/service-access/dist/b2b';
import { boundedCarrierGuideWire, carrierGuideWireExact, carrierGuideReadyRequest, carrierGuideIssueRequest,
  carrierGuideWireScope, carrierGuideReadyResponse, carrierGuideIssuanceResponse, carrierGuideArtifactOwnerResponse,
  type CarrierGuideWireIssue, type CarrierGuideWireReady, type CarrierGuideWireScope } from '@factuez/service-access/dist/b2b-carrier-guide-wire';
import type { CarrierGuideOwner } from './carrier-guide-owner';

/** Structural port is implemented directly by CarrierGuideOwner. No synthetic
 * receipts, unsigned XML input or reference/acceptance supplied by consumers. */
export type BillingCarrierGuideHttpCore = Pick<CarrierGuideOwner, 'persistReadyDraft' | 'issue' | 'read' | 'artifactCurrent'>;
const CORE = Symbol('Billing persistent carrier guide owner'), PEERS = Symbol('Billing carrier owner peers');
function invalid(): never { throw new B2bSecurityError(400, 'INVALID_CARRIER_GUIDE_REQUEST'); }
/** Normalize only errors from the known portable request validator. Never
 * duck-type an owner exception into a public status or publish dependency text. */
function wire<T>(work: () => T): T {
  try { return work(); } catch (error) {
    const status = error instanceof Error && Object.getOwnPropertyDescriptor(error, 'status')?.value;
    const code = error instanceof Error && Object.getOwnPropertyDescriptor(error, 'code')?.value;
    if (status === 413 && code === 'INVALID_CARRIER_GUIDE_REQUEST') throw new B2bSecurityError(413, code);
    return invalid();
  }
}
@Catch()
export class BillingCarrierGuideHttpErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const codes: Record<number, string> = { 400: 'INVALID_CARRIER_GUIDE_REQUEST', 401: 'INVALID_TOKEN', 403: 'ACCESS_DENIED',
      404: 'RESOURCE_NOT_FOUND', 409: 'CARRIER_GUIDE_CONFLICT', 412: 'REVISION_CONFLICT', 413: 'INVALID_CARRIER_GUIDE_REQUEST',
      422: 'CARRIER_GUIDE_PROFILE_NOT_SUPPORTED', 428: 'IF_MATCH_REQUIRED', 429: 'RATE_LIMITED', 503: 'OWNER_UNAVAILABLE' };
    let status = 503;
    if (error instanceof B2bSecurityError && Object.hasOwn(codes, error.status)) status = error.status;
    else if (error instanceof HttpException && [400, 404, 413].includes(error.getStatus())) status = error.getStatus();
    else if (error && typeof error === 'object') {
      const type = Object.getOwnPropertyDescriptor(error, 'type')?.value;
      const parserStatus = Object.getOwnPropertyDescriptor(error, 'status')?.value ??
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(error) ?? {}, 'status')?.value;
      if (type === 'entity.too.large' && parserStatus === 413 || type === 'entity.parse.failed' && parserStatus === 400) status = parserStatus;
    }
    const res = host.switchToHttp().getResponse();
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer'); if (status === 429) res.setHeader('Retry-After', '60');
    res.status(status).json({ schemaVersion: 'factuez.b2b.v1', requestId: newB2bRequestId(), code: codes[status],
      message: codes[status], retryable: status === 503 || status === 429 });
  }
}
/** Opt-in private RPC. A dedicated host must verify TLS certificates and bound
 * JSON parsing to 128 KiB. Socket pin/Bearer are checked before body access. */
@Controller('internal/b2b')
@UseFilters(BillingCarrierGuideHttpErrorFilter)
export class BillingCarrierGuideController {
  constructor(@Inject(CORE) private readonly core: BillingCarrierGuideHttpCore, @Inject(PEERS) private readonly peers: readonly string[]) {}
  @Post('carrier-guides')
  async call(@Req() req: any, @Res() res: any) {
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    b2bPrivatePeer(req, this.peers);
    const authorization = req.headers.authorization;
    const headers: string[] = (req.rawHeaders ?? []).filter((_v: string, i: number) => i % 2 === 0).map((v: string) => v.toLowerCase());
    if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(authorization) ||
      headers.filter(n => n === 'authorization').length !== 1) throw new B2bSecurityError(401, 'INVALID_TOKEN');
    if (new Set(headers).size !== headers.length || headers.some(n => n.replace(/[-_]/g, '') === 'authorization' && n !== 'authorization') ||
      req.url?.includes('?') || Object.keys(req.query ?? {}).length) invalid();
    if (typeof req.headers['content-type'] !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'])) invalid();
    const b = wire(() => boundedCarrierGuideWire(req.body)) as any;
    if (!b || !['SERVICE', 'USER'].includes(b.kind) || !['READY', 'ISSUE', 'READ', 'ARTIFACT_OWNER'].includes(b.action)) invalid();
    const token = authorization.slice(7), kind = b.kind as 'SERVICE' | 'USER';
    if (b.action === 'READY') {
      wire(() => carrierGuideWireExact(b, ['action', 'kind', 'request']));
      const request: CarrierGuideWireReady = wire(() => carrierGuideReadyRequest(b.request));
      const value = await this.core.persistReadyDraft(token, kind, request);
      return res.status(200).json(carrierGuideReadyResponse(value, request));
    }
    if (b.action === 'ISSUE') {
      wire(() => carrierGuideWireExact(b, ['action', 'kind', 'request']));
      const request: CarrierGuideWireIssue = wire(() => carrierGuideIssueRequest(b.request));
      const value = await this.core.issue(token, kind, request);
      return res.status(200).json(carrierGuideIssuanceResponse(value, { ...request, operationId: null }, request.expectedRevision));
    }
    wire(() => carrierGuideWireExact(b, b.action === 'READ' ? ['action', 'kind', 'scope'] : ['action', 'kind', 'scope', 'permission']));
    const scope: CarrierGuideWireScope = wire(() => carrierGuideWireScope(b.scope));
    if (b.action === 'READ') return res.status(200).json(carrierGuideIssuanceResponse(await this.core.read(token, kind, scope), scope));
    if (!['ISSUE', 'READ'].includes(b.permission)) invalid();
    const owned = await this.core.artifactCurrent(scope, { token, kind }, b.permission);
    return res.status(200).json(carrierGuideArtifactOwnerResponse(owned, scope));
  }
}
@Module({})
export class BillingCarrierGuideModule {
  static isolated(core: BillingCarrierGuideHttpCore, peers: readonly string[]): DynamicModule {
    if (!core || ['persistReadyDraft', 'issue', 'read', 'artifactCurrent'].some(name => typeof (core as any)[name] !== 'function') ||
      !Array.isArray(peers) || !peers.length || peers.length > 100 || new Set(peers).size !== peers.length || peers.some(p => !/^[a-f0-9]{64}$/.test(p)))
      throw new Error('Explicit persistent GT31 owner and mTLS peers required');
    return { module: BillingCarrierGuideModule, controllers: [BillingCarrierGuideController], providers: [
      { provide: CORE, useValue: core }, { provide: PEERS, useValue: Object.freeze([...peers]) }, BillingCarrierGuideHttpErrorFilter] };
  }
}
