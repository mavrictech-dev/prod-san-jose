import { Controller, Inject, Module, Param, Post, Req, Res, UseFilters, type DynamicModule } from '@nestjs/common';
import { B2bSecurityError, b2bBindingsContain, type B2bIdentityScope } from '@factuez/contracts/b2b-security';
import { validB2bGuideBinding, type B2bGuideBinding } from '@factuez/contracts/b2b-guide-security';
import { b2bUuid } from '@factuez/contracts/b2b-read-query';
import { B2bOwnerReadFrame, type B2bIdentityPort } from '@factuez/service-access/dist/b2b-read-adapter';
import { B2bPrivateHttp, b2bPrivatePeer } from '@factuez/service-access/dist/b2b';
import { correctionEvidenceFreeze } from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import { validateGuidePreparationResponse } from '@factuez/service-access/dist/b2b-guide-preparation-wire';
import { B2bGuideHttpErrorFilter } from './guides';
import { b2bReadHeaders } from './http';

type Kind = 'SERVICE' | 'USER';
export type B2bGuidePreparation = ReturnType<typeof validateGuidePreparationResponse>;
export interface B2bGuidePreparationOwner {
  prepare(token: string, kind: Kind, binding: B2bGuideBinding, id: string, ifMatch: string): Promise<unknown>;
}
/** Fixed read/preflight RPC. The production allowlist is owned by the host. */
export class HttpB2bGuidePreparationOwner implements B2bGuidePreparationOwner {
  constructor(private readonly http: Pick<B2bPrivateHttp, 'post'>) {}
  prepare(token: string, kind: Kind, binding: B2bGuideBinding, id: string, ifMatch: string) {
    return this.http.post('/internal/b2b/prepare-guide', { kind, binding, id, ifMatch }, token);
  }
}
function invalid(): never { throw new B2bSecurityError(400, 'INVALID_GUIDE_PREPARATION'); }
function inconsistent(): never { throw new B2bSecurityError(503, 'INCONSISTENT_OWNER_RESPONSE'); }
function bounded(value: unknown, response = false): any {
  try {
    // Reject getters, proxies and JSON hooks before any inspection or hashing.
    const copy = correctionEvidenceFreeze(value);
    if (Buffer.byteLength(JSON.stringify(copy)) > (response ? 512 : 128) * 1024)
      throw new B2bSecurityError(413, 'INVALID_GUIDE_PREPARATION');
    return copy;
  } catch (error) {
    if (response) return inconsistent();
    if (error instanceof B2bSecurityError && error.status === 413) throw error;
    return invalid();
  }
}
function revision(value: unknown): value is string { return typeof value === 'string' && /^"v[1-9][0-9]{0,8}"$/.test(value); }
function requestBinding(value: unknown): B2bGuideBinding {
  if (!validB2bGuideBinding(value)) invalid();
  return value;
}
function response(value: unknown, binding: B2bGuideBinding, id: string, ifMatch: string): B2bGuidePreparation {
  try {
    return validateGuidePreparationResponse(bounded(value, true), binding, id, ifMatch);
  } catch { return inconsistent(); }
}

/** Read-only preparation: no idempotency key, command, operation or fiscal authority. */
export class B2bGuidePreparations {
  constructor(private readonly identity: B2bIdentityPort, private readonly owner: B2bGuidePreparationOwner) {}
  async prepare(token: string, kind: Kind, bindingInput: unknown, id: string, ifMatch: string | undefined): Promise<B2bGuidePreparation> {
    if (!['SERVICE', 'USER'].includes(kind) || typeof token !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token))
      throw new B2bSecurityError(401, 'INVALID_TOKEN');
    const binding = requestBinding(bounded(bindingInput));
    if (!b2bUuid(id)) invalid();
    if (ifMatch === undefined || ifMatch === null) throw new B2bSecurityError(428, 'IF_MATCH_REQUIRED');
    if (!revision(ifMatch)) invalid();
    const required: B2bIdentityScope[] = ['b2b:guides:read', 'b2b:documents:read'];
    const frame = new B2bOwnerReadFrame(this.identity, kind);
    const before = await frame.principal(token, [...required]);
    if (!b2bBindingsContain(before.bindings, binding.anchor)) throw new B2bSecurityError(404, 'RESOURCE_NOT_FOUND');
    const result = response(await this.owner.prepare(token, kind, binding, id, ifMatch), binding, id, ifMatch);
    const after = await frame.principal(token, [...required]);
    if (!b2bBindingsContain(after.bindings, binding.anchor)) throw new B2bSecurityError(404, 'RESOURCE_NOT_FOUND');
    return result;
  }
}
const CORE = Symbol('B2B guide preparations'), PEERS = Symbol('B2B guide preparation peers');
@Controller('b2b/v1')
@UseFilters(B2bGuideHttpErrorFilter)
export class B2bGuidePreparationController {
  constructor(@Inject(CORE) private readonly core: B2bGuidePreparations, @Inject(PEERS) private readonly peers: readonly string[]) {}
  @Post('guide-drafts/:id/preparation')
  async prepare(@Req() req: any, @Res() res: any, @Param('id') id: string) {
    b2bReadHeaders(res); b2bPrivatePeer(req, this.peers);
    const authorization = req.headers.authorization, kind = req.headers['x-factuez-actor-kind'];
    if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(authorization) ||
      typeof kind !== 'string' || !['SERVICE', 'USER'].includes(kind) ||
      ['authorization', 'x-factuez-actor-kind'].some(name =>
        (req.rawHeaders?.filter((v: string, i: number) => i % 2 === 0 && v.toLowerCase() === name).length ?? 1) !== 1))
      throw new B2bSecurityError(401, 'INVALID_TOKEN');
    if (req.rawHeaders?.some((v: string, i: number) => i % 2 === 0 &&
      req.rawHeaders.filter((h: string, j: number) => j % 2 === 0 && h.toLowerCase() === v.toLowerCase()).length > 1)) invalid();
    if (req.url?.includes('?') || req.query && Object.keys(req.query).length) invalid();
    if (req.headers['if-match'] === undefined) throw new B2bSecurityError(428, 'IF_MATCH_REQUIRED');
    if (!revision(req.headers['if-match'])) invalid();
    const body = bounded(req.body);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'binding')) invalid();
    const result = await this.core.prepare(authorization.slice(7), kind as Kind, body.binding, id, req.headers['if-match']);
    res.setHeader('ETag', result.plan.draftRevision); res.status(200).json(result);
  }
}
@Module({})
export class B2bGuidePreparationModule {
  static isolated(core: B2bGuidePreparations, peers: string[]): DynamicModule {
    if (!core || typeof core.prepare !== 'function' || !Array.isArray(peers) || !peers.length || peers.length > 100 ||
      new Set(peers).size !== peers.length || peers.some(p => !/^[a-f0-9]{64}$/.test(p)))
      throw new Error('Explicit guide preparation facade and mTLS peers required');
    return { module: B2bGuidePreparationModule, controllers: [B2bGuidePreparationController], providers: [
      { provide: CORE, useValue: core }, { provide: PEERS, useValue: Object.freeze([...peers]) }, B2bGuideHttpErrorFilter,
    ] };
  }
}
