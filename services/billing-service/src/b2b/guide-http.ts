import { Catch, Controller, HttpException, Inject, Module, Post, Req, Res, UseFilters, type ArgumentsHost, type DynamicModule, type ExceptionFilter } from '@nestjs/common';
import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { validB2bGuideBinding } from '@factuez/contracts/b2b-guide-security';
import { b2bUuid } from '@factuez/contracts/b2b-read-query';
import { b2bPrivatePeer, newB2bRequestId } from '@factuez/service-access/dist/b2b';
import { correctionEvidenceFreeze } from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import type { B2bGuides } from './guide-drafts';

const CORE = Symbol('Billing draft guides'), PEERS = Symbol('Billing guide private peers');
function invalid(): never { throw new B2bSecurityError(400, 'INVALID_GUIDE_REQUEST'); }
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) invalid();
}
function bounded(value: unknown) {
  try {
    const result = correctionEvidenceFreeze(value);
    if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) invalid();
    return result;
  } catch { return invalid(); }
}
/** Install globally as well on a dedicated host to sanitize parser failures before controller dispatch. */
@Catch()
export class BillingGuideHttpErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse(), parser = error as { type?: unknown; status?: unknown } | null;
    const parserStatus = parser?.type === 'entity.too.large' && parser.status === 413 ? 413 : parser?.type === 'entity.parse.failed' && parser.status === 400 ? 400 : null;
    const status = parserStatus ?? (error instanceof B2bSecurityError ? error.status : error instanceof HttpException && [400, 404, 413].includes(error.getStatus()) ? error.getStatus() : 503);
    const code = error instanceof B2bSecurityError ? error.code : status < 500 ? 'INVALID_REQUEST' : 'OWNER_UNAVAILABLE';
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
    if (status === 429) res.setHeader('Retry-After', '60');
    res.status(status).json({ schemaVersion: 'factuez.b2b.v1', requestId: newB2bRequestId(), code, message: code, retryable: status === 503 || status === 429 });
  }
}

/** One private RPC, no fiscal execution. Host must request/verify TLS certificates and bound JSON parsing.
 * The pinned socket and Bearer are checked BEFORE the controller accesses any request body. */
@Controller('internal/b2b')
@UseFilters(BillingGuideHttpErrorFilter)
export class BillingGuideController {
  constructor(@Inject(CORE) private readonly core: B2bGuides, @Inject(PEERS) private readonly peers: readonly string[]) {}
  @Post('guides')
  async call(@Req() req: any, @Res() res: any) {
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    b2bPrivatePeer(req, this.peers);
    const authorization = req.headers.authorization;
    if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(authorization) ||
      (req.rawHeaders?.filter((v: string, i: number) => i % 2 === 0 && v.toLowerCase() === 'authorization').length ?? 1) !== 1)
      throw new B2bSecurityError(401, 'INVALID_TOKEN');
    if (req.url?.includes('?')) invalid();
    const envelope = bounded(req.body); exact(envelope, ['kind', 'action', 'args']);
    if (typeof envelope.kind !== 'string' || !['SERVICE', 'USER'].includes(envelope.kind) || typeof envelope.action !== 'string' ||
      !['CREATE', 'PATCH', 'READY', 'CANCEL', 'READ', 'LIST', 'OPERATION'].includes(envelope.action)) invalid();
    const kind = envelope.kind as 'SERVICE' | 'USER', action = envelope.action, args = envelope.args, token = authorization.slice(7);
    const writing = ['CREATE', 'PATCH', 'READY', 'CANCEL'].includes(action);
    exact(args, writing ? ['binding', 'id', 'key', 'ifMatch', 'body'] : action === 'LIST' ? ['binding', 'limit', 'after'] : ['binding', 'id']);
    if (!validB2bGuideBinding(args.binding) || typeof args.binding.anchor.documentType !== 'string') invalid();
    let result: unknown;
    if (writing) {
      if (typeof args.key !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(args.key) ||
        (action === 'CREATE' ? args.id !== null || args.ifMatch !== null : !b2bUuid(args.id))) invalid();
      if (action !== 'CREATE' && args.ifMatch === null) throw new B2bSecurityError(428, 'IF_MATCH_REQUIRED');
      if (action !== 'CREATE' && (typeof args.ifMatch !== 'string' || !/^"v[1-9][0-9]{0,8}"$/.test(args.ifMatch))) invalid();
      if (action === 'CREATE' || action === 'PATCH') {
        if (!args.body || typeof args.body !== 'object' || Array.isArray(args.body)) invalid();
      } else exact(args.body, []);
      result = await this.core.command(token, kind, args.binding, action as 'CREATE' | 'PATCH' | 'READY' | 'CANCEL', args.id as string | null,
        args.key, args.ifMatch === null ? undefined : args.ifMatch as string, args.body);
    } else if (action === 'LIST') {
      if (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 10 || args.after !== null && !b2bUuid(args.after)) invalid();
      result = await this.core.list(token, kind, args.binding, args.limit as number, args.after as string | null);
    } else {
      if (!b2bUuid(args.id)) invalid();
      result = action === 'READ' ? await this.core.read(token, kind, args.binding, args.id) : await this.core.operation(token, kind, args.binding, args.id);
    }
    res.status(200).json(result);
  }
}
@Module({})
export class BillingGuideModule {
  static isolated(core: B2bGuides, peers: string[]): DynamicModule {
    if (!core || !Array.isArray(peers) || !peers.length || peers.length > 100 || new Set(peers).size !== peers.length || peers.some(p => !/^[a-f0-9]{64}$/.test(p)))
      throw new Error('Explicit guide core and mTLS peers required');
    return { module: BillingGuideModule, controllers: [BillingGuideController], providers: [
      { provide: CORE, useValue: core }, { provide: PEERS, useValue: Object.freeze([...peers]) }, BillingGuideHttpErrorFilter,
    ] };
  }
}
