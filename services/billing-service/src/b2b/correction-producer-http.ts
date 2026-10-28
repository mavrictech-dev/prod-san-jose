import { Controller, Inject, Module, Post, Req, Res, UseFilters, type DynamicModule } from '@nestjs/common';
import { B2bSecurityError, validB2bCorrectionBinding, type B2bCorrectionBinding } from '@factuez/contracts/b2b-security';
import { b2bUuid } from '@factuez/contracts/b2b-read-query';
import { b2bPrivatePeer } from '@factuez/service-access/dist/b2b';
import { correctionEvidenceFreeze } from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import { B2bCorrectionProducer, parseCorrectionCreateRequest } from './correction-producer';
import { B2bContextFilter } from './http';

export type BillingCorrectionProducerFactory = (
  token: string, kind: 'SERVICE' | 'USER', binding: B2bCorrectionBinding,
) => B2bCorrectionProducer | Promise<B2bCorrectionProducer>;
const FACTORY = Symbol('Request-scoped Billing correction producer factory');
const PEERS = Symbol('Billing correction producer facade peers');
function invalid(): never { throw new B2bSecurityError(400, 'INVALID_CORRECTION_REQUEST'); }
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
    keys.some(key => !Object.hasOwn(value, key))) invalid();
}
function bounded(value: unknown) {
  try {
    const body = correctionEvidenceFreeze(value);
    if (Buffer.byteLength(JSON.stringify(body)) > 256 * 1024) invalid();
    return body;
  } catch { return invalid(); }
}

/** Isolated owner connection only. Host must enforce TLS requestCert/rejectUnauthorized and bounded JSON parsing.
 * The socket/headers are checked BEFORE accessing req.body or invoking the request-scoped factory. */
@Controller('internal/b2b')
@UseFilters(B2bContextFilter)
export class BillingCorrectionProducerController {
  constructor(@Inject(FACTORY) private readonly factory: BillingCorrectionProducerFactory,
    @Inject(PEERS) private readonly peers: readonly string[]) {}

  @Post('correction-producer')
  async call(@Req() req: any, @Res() res: any) {
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    b2bPrivatePeer(req, this.peers);
    const authorization = req.headers.authorization;
    if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(authorization) ||
      (req.rawHeaders?.filter((value: string, i: number) => i % 2 === 0 && value.toLowerCase() === 'authorization').length ?? 1) !== 1)
      throw new B2bSecurityError(401, 'INVALID_TOKEN');
    if (req.url?.includes('?')) invalid();
    const body = bounded(req.body);
    exact(body, ['action', 'kind', 'args']);
    if (typeof body.action !== 'string' || !['CREATE', 'STATUS', 'SETTLE'].includes(body.action) ||
      typeof body.kind !== 'string' || !['SERVICE', 'USER'].includes(body.kind)) invalid();
    const kind = body.kind as 'SERVICE' | 'USER', token = authorization.slice(7);
    let binding: B2bCorrectionBinding, args: unknown;
    if (body.action === 'CREATE') {
      const request = parseCorrectionCreateRequest(body.args);
      if (typeof request.note.reasonCode !== 'string') invalid();
      binding = request.binding; args = request;
    } else {
      exact(body.args, ['binding', 'operationId']);
      try { if (!validB2bCorrectionBinding(body.args.binding) || !b2bUuid(body.args.operationId)) invalid(); } catch { invalid(); }
      binding = body.args.binding as B2bCorrectionBinding; args = body.args;
      if (binding.reference.documentType !== '01') throw new B2bSecurityError(409, 'CORRECTION_PROFILE_NOT_ENABLED');
    }
    // A new instance/context per call; token or actor state must not bleed between simultaneous requests.
    const core = await this.factory(token, kind, binding);
    const result = body.action === 'CREATE' ? await core.create(token, kind, args) : body.action === 'STATUS' ?
      await core.status(token, kind, binding, (args as { operationId: string }).operationId) :
      await core.settle(token, kind, binding, (args as { operationId: string }).operationId);
    res.status(200).json(result);
  }
}

@Module({})
export class BillingCorrectionProducerModule {
  static isolated(factory: BillingCorrectionProducerFactory, peers: string[]): DynamicModule {
    if (typeof factory !== 'function' || !Array.isArray(peers) || !peers.length || peers.length > 100 ||
      new Set(peers).size !== peers.length || peers.some(peer => !/^[a-f0-9]{64}$/.test(peer)))
      throw new Error('Explicit correction producer factory and mTLS peers required');
    return { module: BillingCorrectionProducerModule, controllers: [BillingCorrectionProducerController], providers: [
      { provide: FACTORY, useValue: factory }, { provide: PEERS, useValue: Object.freeze([...peers]) }, B2bContextFilter,
    ] };
  }
}
