import { Body, Catch, Controller, Get, HttpException, Inject, Param, Patch, Post, Req, Res,
  type ArgumentsHost, type CanActivate, type ExceptionFilter, type ExecutionContext, type DynamicModule, Module } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import type { IntegrationScope } from '@factuez/contracts/integration';
import { fail, IntegrationIdentityError, plain, scopes, type Principal } from './model';
import { IntegrationIdentity } from './service';

export const IntegrationCore = Symbol('integration-core');
export const IntegrationPeers = Symbol('integration-peers');
export interface Peers { token: string[]; admin: string[]; resource: string[] }
interface Request {
  headers: Record<string, string | string[] | undefined>; socket: TLSSocket;
  integrationPrincipal?: Principal;
}
interface Response { setHeader(name: string, value: string): void; status(code: number): Response; json(value: unknown): void }
function context(req: Request, peers: Peers, plane: keyof Peers) {
  if (req.socket.encrypted !== true || req.socket.authorized !== true) return fail(403, 'PRIVATE_TRANSPORT_REQUIRED');
  const fingerprint = req.socket.getPeerCertificate().fingerprint256?.replace(/:/g, '').toLowerCase();
  if (!fingerprint || !peers[plane].includes(fingerprint)) return fail(403, 'PRIVATE_PEER_REQUIRED');
  return { requestId: randomUUID(), peer: `${req.socket.remoteAddress}:${fingerprint}` };
}
function bearer(req: Request): string {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_.-]{1,8192}$/.test(header)) return fail(401, 'invalid_token');
  return header.slice(7);
}
function protect(res: Response) { res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Pragma', 'no-cache'); }
@Catch()
export class IntegrationErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const inputStatus = error instanceof HttpException ? error.getStatus() : 503;
    const status = error instanceof IntegrationIdentityError ? error.status : [400, 404, 413, 415].includes(inputStatus) ? inputStatus : 503;
    let code = error instanceof IntegrationIdentityError ? error.code : status === 404 ? 'RESOURCE_NOT_FOUND' : status < 500 ? 'invalid_request' : 'temporarily_unavailable';
    const url = host.switchToHttp().getRequest<{ url?: string }>().url ?? '';
    if (url.split('?')[0] === '/integration/oauth/token' && code === 'RATE_LIMITED') code = 'temporarily_unavailable';
    protect(res);
    if (status === 401) res.setHeader('WWW-Authenticate', code === 'invalid_client' ? 'Basic realm="FactuEz integration"' : 'Bearer');
    if (status === 429) res.setHeader('Retry-After', '60');
    res.status(status).json({ error: code });
  }
}
@Controller('integration/oauth')
export class IntegrationOAuthController {
  constructor(@Inject(IntegrationCore) private readonly core: IntegrationIdentity, @Inject(IntegrationPeers) private readonly peers: Peers) {}
  @Post('token')
  async token(@Req() req: Request, @Res() res: Response, @Body() body: unknown) {
    protect(res);
    const ctx = context(req, this.peers, 'token');
    if (typeof req.headers['content-type'] !== 'string' || !/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']))
      return fail(400, 'invalid_request');
    res.status(200).json(await this.core.token(req.headers.authorization, body, ctx));
  }
}
@Controller('internal/integration')
export class IntegrationInternalController {
  constructor(@Inject(IntegrationCore) private readonly core: IntegrationIdentity, @Inject(IntegrationPeers) private readonly peers: Peers) {}
  @Post('introspect')
  async introspect(@Req() req: Request, @Res() res: Response, @Body() body: unknown) {
    protect(res); const ctx = context(req, this.peers, 'resource');
    if (!plain(body) || Object.keys(body).some(k => k !== 'requiredScopes') || !Array.isArray(body.requiredScopes)) return fail(400, 'invalid_request');
    const required = body.requiredScopes.length ? scopes(body.requiredScopes) : [];
    res.status(200).json(await this.core.authenticate(bearer(req), required, ctx));
  }
  @Get('jwks')
  jwks(@Req() req: Request, @Res() res: Response) {
    protect(res); context(req, this.peers, 'resource'); res.status(200).json(this.core.jwks());
  }
  @Get('clients')
  async list(@Req() req: Request, @Res() res: Response) {
    protect(res); context(req, this.peers, 'admin'); res.status(200).json(await this.core.list(bearer(req)));
  }
  @Post('clients')
  async create(@Req() req: Request, @Res() res: Response, @Body() body: unknown) {
    protect(res); const ctx = context(req, this.peers, 'admin'); res.status(201).json(await this.core.create(bearer(req), body, ctx));
  }
  @Patch('clients/:id')
  async change(@Req() req: Request, @Res() res: Response, @Param('id') id: string, @Body() body: unknown) {
    protect(res); const ctx = context(req, this.peers, 'admin'); res.status(200).json(await this.core.change(bearer(req), id, body, ctx));
  }
  @Post('clients/:id/rotate')
  async rotate(@Req() req: Request, @Res() res: Response, @Param('id') id: string, @Body() body: unknown) {
    protect(res); const ctx = context(req, this.peers, 'admin'); res.status(200).json(await this.core.change(bearer(req), id, body, ctx, true));
  }
}
/** Explicit opt-in guard for phase-4 routes. Never silently accept PWA claims. */
export class IntegrationPermissionGuard implements CanActivate {
  constructor(@Inject(IntegrationCore) private readonly core: IntegrationIdentity, @Inject(IntegrationPeers) private readonly peers: Peers,
    @Inject(Reflector) private readonly reflector: Reflector) {}
  async canActivate(contextValue: ExecutionContext) {
    const required = this.reflector.getAllAndOverride<IntegrationScope[]>('factuez:integration-scopes', [contextValue.getHandler(), contextValue.getClass()]);
    if (!required?.length) return fail(403, 'INTEGRATION_POLICY_REQUIRED');
    const req = contextValue.switchToHttp().getRequest<Request>();
    req.integrationPrincipal = await this.core.authenticate(bearer(req), required, context(req, this.peers, 'resource'));
    return true;
  }
}
@Module({})
export class IntegrationIdentityModule {
  static isolated(core: IntegrationIdentity, peers: Peers): DynamicModule {
    return { module: IntegrationIdentityModule, controllers: [IntegrationOAuthController, IntegrationInternalController],
      providers: [{ provide: IntegrationCore, useValue: core }, { provide: IntegrationPeers, useValue: peers }] };
  }
}
