import { Controller, Inject, Module, Post, Req, Res, UseFilters, type DynamicModule } from '@nestjs/common';
import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { validB2bGuideBinding, type B2bGuideBinding } from '@factuez/contracts/b2b-guide-security';
import { b2bUuid } from '@factuez/contracts/b2b-read-query';
import { b2bPrivatePeer } from '@factuez/service-access/dist/b2b';
import { correctionEvidenceFreeze } from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import { BillingGuideHttpErrorFilter } from './guide-http';

/** Structural port: this adapter never loads the domain owner's DB dependencies. */
export interface BillingGuidePreparationCore {
  prepare(token: string, kind: 'SERVICE' | 'USER', binding: B2bGuideBinding, id: string, ifMatch: string): Promise<unknown>;
}
const CORE = Symbol('Billing guide preparation'), PEERS = Symbol('Billing guide preparation peers');
function invalid(): never { throw new B2bSecurityError(400, 'INVALID_GUIDE_PREPARATION'); }
function bounded(value: unknown, response = false): any {
  try {
    const copy = correctionEvidenceFreeze(value);
    if (Buffer.byteLength(JSON.stringify(copy)) > (response ? 512 : 128) * 1024)
      throw new B2bSecurityError(413, 'INVALID_GUIDE_PREPARATION');
    return copy;
  } catch (error) {
    if (response) throw new B2bSecurityError(503, 'INCONSISTENT_OWNER_RESPONSE');
    if (error instanceof B2bSecurityError && error.status === 413) throw error;
    return invalid();
  }
}

/** Host must enforce verified client TLS and bounded JSON parsing before dispatch. */
@Controller('internal/b2b')
@UseFilters(BillingGuideHttpErrorFilter)
export class BillingGuidePreparationController {
  constructor(@Inject(CORE) private readonly core: BillingGuidePreparationCore, @Inject(PEERS) private readonly peers: readonly string[]) {}
  @Post('prepare-guide')
  async prepare(@Req() req: any, @Res() res: any) {
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    b2bPrivatePeer(req, this.peers);
    const authorization = req.headers.authorization;
    if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(authorization) ||
      (req.rawHeaders?.filter((v: string, i: number) => i % 2 === 0 && v.toLowerCase() === 'authorization').length ?? 1) !== 1)
      throw new B2bSecurityError(401, 'INVALID_TOKEN');
    if (req.rawHeaders?.some((v: string, i: number) => i % 2 === 0 &&
      req.rawHeaders.filter((h: string, j: number) => j % 2 === 0 && h.toLowerCase() === v.toLowerCase()).length > 1)) invalid();
    if (req.url?.includes('?') || req.query && Object.keys(req.query).length) invalid();
    const body = bounded(req.body);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'binding,id,ifMatch,kind' ||
      !['SERVICE', 'USER'].includes(body.kind) || !validB2bGuideBinding(body.binding) || !b2bUuid(body.id)) invalid();
    if (body.ifMatch === null || body.ifMatch === undefined) throw new B2bSecurityError(428, 'IF_MATCH_REQUIRED');
    if (typeof body.ifMatch !== 'string' || !/^"v[1-9][0-9]{0,8}"$/.test(body.ifMatch)) invalid();
    const result = bounded(await this.core.prepare(authorization.slice(7), body.kind, body.binding, body.id, body.ifMatch), true);
    res.status(200).json(result);
  }
}
@Module({})
export class BillingGuidePreparationModule {
  static isolated(core: BillingGuidePreparationCore, peers: string[]): DynamicModule {
    if (!core || typeof core.prepare !== 'function' || !Array.isArray(peers) || !peers.length || peers.length > 100 ||
      new Set(peers).size !== peers.length || peers.some(p => !/^[a-f0-9]{64}$/.test(p)))
      throw new Error('Explicit guide preparation core and mTLS peers required');
    return { module: BillingGuidePreparationModule, controllers: [BillingGuidePreparationController], providers: [
      { provide: CORE, useValue: core }, { provide: PEERS, useValue: Object.freeze([...peers]) }, BillingGuideHttpErrorFilter,
    ] };
  }
}
