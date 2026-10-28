import { randomUUID } from 'node:crypto';
import { Controller, Inject, Module, Post, Req, Res, UseFilters, type DynamicModule, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { b2bPrivatePeer } from '@factuez/service-access/dist/b2b';
import { correctionEvidenceFreeze } from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import type { EstablishmentContext } from './guide-establishments';
import { BillingGuideHttpErrorFilter } from './guide-http';

/** Structural port for GuideEstablishments; no store, identity or fiscal owner is constructed here. */
export interface BillingGuideEstablishmentCore {
  read(token: string, companyId: number, ctx: EstablishmentContext): Promise<unknown>;
  replace(token: string, companyId: number, input: unknown, ctx: EstablishmentContext): Promise<unknown>;
}
const CORE = Symbol('Guide establishment registry'), PEERS = Symbol('Guide establishment admin peers');
const REQUEST_LIMIT = 128 * 1024, RESPONSE_LIMIT = 512 * 1024;
const BODY_DEADLINE_MS = 10_000;
function invalid(): never { throw new B2bSecurityError(400, 'INVALID_ESTABLISHMENT_REQUEST'); }
function tooLarge(): never { throw new B2bSecurityError(413, 'INVALID_ESTABLISHMENT_REQUEST'); }
function exact(value: any, keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
    keys.some(key => !Object.hasOwn(value, key))) invalid();
}
function bounded(value: unknown, response = false): any {
  try {
    const copy = correctionEvidenceFreeze(value);
    if (Buffer.byteLength(JSON.stringify(copy)) > (response ? RESPONSE_LIMIT : REQUEST_LIMIT)) tooLarge();
    return copy;
  } catch (error) {
    if (response) throw new B2bSecurityError(503, 'INCONSISTENT_OWNER_RESPONSE');
    if (error instanceof B2bSecurityError && error.status === 413) throw error;
    return invalid();
  }
}
/** Use raw headers so Node's normalization cannot hide duplicate authorization or other headers. */
function boundary(req: any, peers: readonly string[]) {
  const peer = b2bPrivatePeer(req, peers);
  let raw: unknown;
  try { raw = correctionEvidenceFreeze(Object.getOwnPropertyDescriptor(req, 'rawHeaders')?.value); } catch { invalid(); }
  if (!Array.isArray(raw) || raw.length % 2 || raw.some(v => typeof v !== 'string')) invalid();
  const headers = new Map<string, string>(), duplicates = new Set<string>();
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i].toLowerCase();
    if (headers.has(name)) duplicates.add(name);
    headers.set(name, raw[i + 1]);
  }
  const authorization = headers.get('authorization');
  if (duplicates.has('authorization') || typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(authorization))
    throw new B2bSecurityError(401, 'INVALID_TOKEN');
  if (duplicates.size || req.url?.includes('?') || req.originalUrl?.includes('?')) invalid();
  return { peer, token: authorization.slice(7), headers };
}

/** Private BETA local registry only, not official establishment validation or fiscal authorization.
 * Dedicated HTTPS host MUST request and verify client certificates and set bodyParser:false.
 * This module installs its own bounded JSON reader with a 10-second total deadline AFTER pin/header validation; do not add a host parser.
 */
@Controller('internal/b2b/guide-establishments')
@UseFilters(BillingGuideHttpErrorFilter)
export class BillingGuideEstablishmentController {
  constructor(@Inject(CORE) private readonly core: BillingGuideEstablishmentCore, @Inject(PEERS) private readonly peers: readonly string[]) {}
  @Post('read')
  async read(@Req() req: any, @Res() res: any) { return this.call(req, res, false); }
  @Post('replace')
  async replace(@Req() req: any, @Res() res: any) { return this.call(req, res, true); }
  private async call(req: any, res: any, replace: boolean) {
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    const { peer, token } = boundary(req, this.peers);
    // An in-process call must not execute a caller-supplied body getter either.
    const descriptor = Object.getOwnPropertyDescriptor(req, 'body');
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
    const body = bounded(descriptor.value);
    exact(body, replace ? ['companyId', 'input'] : ['companyId']);
    if (!Number.isInteger(body.companyId) || body.companyId < 1 || body.companyId > 2147483647) invalid();
    if (replace) {
      exact(body.input, ['expectedRevision', 'expectedIssuerRevision', 'entries']);
      if (!Array.isArray(body.input.entries)) invalid();
      for (const entry of body.input.entries) exact(entry, ['branchId', 'branchRevision', 'establishmentCode', 'ubigeo', 'address']);
    }
    const ctx = Object.freeze({ requestId: randomUUID(), peer });
    // Verified human GLOBAL/setup.manage/series.manage/step-up belong exclusively to the core.
    const result = replace ? await this.core.replace(token, body.companyId, body.input, ctx) : await this.core.read(token, body.companyId, ctx);
    return res.status(200).json(bounded(result, true));
  }
}

@Module({})
export class BillingGuideEstablishmentModule implements NestModule {
  constructor(@Inject(PEERS) private readonly peers: readonly string[]) {}
  configure(consumer: MiddlewareConsumer) {
    consumer.apply((req: any, res: any, next: (error?: unknown) => void) => {
      try {
        const { headers } = boundary(req, this.peers);
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(headers.get('content-type') ?? '') ||
          headers.has('content-encoding') && headers.get('content-encoding') !== 'identity') invalid();
        const length = headers.get('content-length');
        if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > REQUEST_LIMIT)) tooLarge();
        const chunks: Buffer[] = [];
        let bytes = 0, finished = false;
        const timer = setTimeout(() => {
          // Finish the sanitized response and close even if the client never finishes its body.
          res.setHeader('Connection', 'close');
          fail(new B2bSecurityError(408, 'ESTABLISHMENT_BODY_TIMEOUT'));
        }, BODY_DEADLINE_MS);
        timer.unref();
        const fail = (error: unknown) => {
          if (finished) return;
          finished = true; clearTimeout(timer); chunks.length = 0; req.resume(); next(error);
        };
        req.on('data', (chunk: Buffer) => {
          if (finished) return;
          bytes += chunk.length;
          if (bytes > REQUEST_LIMIT) { fail(new B2bSecurityError(413, 'INVALID_ESTABLISHMENT_REQUEST')); return; }
          chunks.push(chunk);
        });
        req.once('error', () => fail(new B2bSecurityError(400, 'INVALID_ESTABLISHMENT_REQUEST')));
        req.once('aborted', () => fail(new B2bSecurityError(400, 'INVALID_ESTABLISHMENT_REQUEST')));
        req.once('end', () => {
          if (finished) return;
          try { req.body = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); }
          catch { fail(new B2bSecurityError(400, 'INVALID_ESTABLISHMENT_REQUEST')); return; }
          finished = true; clearTimeout(timer); chunks.length = 0; next();
        });
      } catch (error) { req.resume(); next(error); }
    }).forRoutes(BillingGuideEstablishmentController);
  }
  static isolated(core: BillingGuideEstablishmentCore, peers: readonly string[]): DynamicModule {
    if (!core || typeof core.read !== 'function' || typeof core.replace !== 'function' || !Array.isArray(peers) ||
      !peers.length || peers.length > 100 || new Set(peers).size !== peers.length || peers.some(p => typeof p !== 'string' || !/^[a-f0-9]{64}$/.test(p)))
      throw new Error('Explicit establishment core and pinned admin mTLS peers required');
    return { module: BillingGuideEstablishmentModule, controllers: [BillingGuideEstablishmentController], providers: [
      { provide: CORE, useValue: core }, { provide: PEERS, useValue: Object.freeze([...peers]) },
      { provide: APP_FILTER, useClass: BillingGuideHttpErrorFilter }, BillingGuideHttpErrorFilter,
    ] };
  }
}
