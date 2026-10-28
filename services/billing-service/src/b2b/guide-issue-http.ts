import { Controller, Inject, Module, Post, Req, Res, UseFilters, type DynamicModule } from '@nestjs/common';
import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { validB2bGuideIssueBinding, type B2bGuideIssueBinding } from '@factuez/contracts/b2b-guide-security';
import { b2bUuid } from '@factuez/contracts/b2b-read-query';
import { b2bPrivatePeer } from '@factuez/service-access/dist/b2b';
import { validateGuideIssuanceResponse } from '@factuez/service-access/dist/b2b-guide-issue-wire';
import { boundedSupplementJson } from '@factuez/sunat-core/dist/fiscal-supplement-command';
import type { GuideIssueRequest, GuideIssueReceipt } from './guide-issue-model';
import { BillingGuideHttpErrorFilter } from './guide-http';

export interface BillingGuideIssueHttpCore {
  issue(token: string, kind: 'SERVICE' | 'USER', input: unknown): Promise<{ receipt: GuideIssueReceipt; replayed: boolean }>;
  read(token: string, kind: 'SERVICE' | 'USER', binding: B2bGuideIssueBinding, draftId: string, operationId: string): Promise<GuideIssueReceipt>;
}
function invalid(): never { throw new B2bSecurityError(400, 'INVALID_GUIDE_ISSUE_REQUEST'); }
function view(r: GuideIssueReceipt, replayed: boolean | null, binding: B2bGuideIssueBinding, draftId: string, operationId: string | null, expectedRevision?: string) {
  // Never publish the receipt's actor, request/key digests or internal grant revisions.
  try { return validateGuideIssuanceResponse({ schemaVersion: 'factuez.b2b.guide-issuance.v1', operationId: r.id,
    draftId: r.snapshot.draftId, binding: r.snapshot.binding, snapshot: r.snapshot,
    snapshotSha256: r.snapshotSha256, replayed }, binding, draftId, operationId, expectedRevision); }
  catch { throw new B2bSecurityError(503, 'INCONSISTENT_OWNER_RESPONSE'); }
}
const CORE = Symbol('Billing guide issuer'), PEERS = Symbol('Billing guide issuer peers');
@Controller('internal/b2b')
@UseFilters(BillingGuideHttpErrorFilter)
export class BillingGuideIssueController {
  constructor(@Inject(CORE) private readonly core: BillingGuideIssueHttpCore, @Inject(PEERS) private readonly peers: readonly string[]) {}
  private request(req: any, res: any): { token: string; body: any } {
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); b2bPrivatePeer(req, this.peers);
    const a = req.headers.authorization;
    if (typeof a !== 'string' || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(a)) throw new B2bSecurityError(401, 'INVALID_TOKEN');
    if (req.rawHeaders?.some((v: string, i: number) => i % 2 === 0 && req.rawHeaders.filter((h: string, j: number) =>
      j % 2 === 0 && h.toLowerCase() === v.toLowerCase()).length > 1) || req.url?.includes('?') || Object.keys(req.query ?? {}).length) invalid();
    let b: any; try { b = boundedSupplementJson(req.body); } catch { return invalid(); }
    if (Buffer.byteLength(JSON.stringify(b)) > 128 * 1024) throw new B2bSecurityError(413, 'INVALID_GUIDE_ISSUE_REQUEST');
    if (!b || typeof b !== 'object' || Array.isArray(b) || !['SERVICE', 'USER'].includes(b.kind)) invalid();
    return { token: a.slice(7), body: b };
  }
  @Post('issue-guide')
  async issue(@Req() req: any, @Res() res: any) {
    const { token, body: b } = this.request(req, res);
    if (Object.keys(b).sort().join(',') !== 'kind,request' || !b.request || !validB2bGuideIssueBinding(b.request.binding)) invalid();
    const request = b.request as GuideIssueRequest;
    const result = await this.core.issue(token, b.kind, request);
    const response = view(result.receipt, result.replayed, request.binding, request.draftId, null, request.expectedRevision);
    res.status(200).json(response);
  }
  @Post('read-guide-issuance')
  async read(@Req() req: any, @Res() res: any) {
    const { token, body: b } = this.request(req, res);
    if (Object.keys(b).sort().join(',') !== 'binding,draftId,kind,operationId' || !validB2bGuideIssueBinding(b.binding) ||
      !b2bUuid(b.draftId) || !b2bUuid(b.operationId)) invalid();
    const r = await this.core.read(token, b.kind, b.binding, b.draftId, b.operationId);
    res.status(200).json(view(r, null, b.binding, b.draftId, b.operationId));
  }
}
@Module({})
export class BillingGuideIssueModule {
  static isolated(core: BillingGuideIssueHttpCore, peers: string[]): DynamicModule {
    if (!core || typeof core.issue !== 'function' || typeof core.read !== 'function' || !Array.isArray(peers) || !peers.length ||
      peers.length > 100 || new Set(peers).size !== peers.length || peers.some(p => !/^[a-f0-9]{64}$/.test(p)))
      throw new Error('Explicit guide issuer and mTLS peers required');
    return { module: BillingGuideIssueModule, controllers: [BillingGuideIssueController], providers: [
      { provide: CORE, useValue: core }, { provide: PEERS, useValue: Object.freeze([...peers]) }, BillingGuideHttpErrorFilter] };
  }
}
