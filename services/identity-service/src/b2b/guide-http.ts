import { Body, Controller, Get, Inject, Module, Param, Post, Req, Res, UseFilters, type DynamicModule } from '@nestjs/common';
import { B2bGuideAuthority } from './guide-authority';
import { B2bErrorFilter, b2bPrivateContext, b2bPrivateHeaders } from './http';
import { fail } from './model';

const CORE = Symbol('B2B paired guide authority'), PEERS = Symbol('B2B paired guide peers');
export interface GuideAuthorityPeers { admin: readonly string[]; owner: readonly string[] }
function bearer(req: any) {
  if (typeof req.headers.authorization !== 'string' || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(req.headers.authorization)) return fail(401, 'INVALID_TOKEN');
  return req.headers.authorization.slice(7);
}
@Controller('internal/b2b')
@UseFilters(B2bErrorFilter)
export class B2bGuideAuthorityController {
  constructor(@Inject(CORE) private readonly core: B2bGuideAuthority, @Inject(PEERS) private readonly peers: GuideAuthorityPeers) {}
  @Get('clients/:id/guide-grants')
  async read(@Req() req: any, @Res() res: any, @Param('id') id: string) {
    b2bPrivateHeaders(res); const context = b2bPrivateContext(req, this.peers.admin);
    res.status(200).json(await this.core.read(bearer(req), id, context));
  }
  @Post('clients/:id/guide-grants')
  async replace(@Req() req: any, @Res() res: any, @Param('id') id: string, @Body() body: unknown) {
    b2bPrivateHeaders(res); const context = b2bPrivateContext(req, this.peers.admin);
    res.status(200).json(await this.core.replace(bearer(req), id, body, context));
  }
  @Post('authorize-guide')
  async authorize(@Req() req: any, @Res() res: any, @Body() body: unknown) {
    b2bPrivateHeaders(res); const context = b2bPrivateContext(req, this.peers.owner);
    res.status(200).json(await this.core.authorize(bearer(req), body, context));
  }
}
@Module({})
export class B2bGuideAuthorityModule {
  static isolated(core: B2bGuideAuthority, peers: GuideAuthorityPeers): DynamicModule {
    if (!peers || Object.keys(peers).sort().join(',') !== 'admin,owner' ||
      Object.values(peers).some(ids => !Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)))) throw new Error('Explicit guide authority mTLS peers required');
    if (peers.admin.some(id => peers.owner.includes(id))) throw new Error('Separate guide enrollment and owner peers required');
    const detached = Object.freeze({ admin: Object.freeze([...peers.admin]), owner: Object.freeze([...peers.owner]) });
    return { module: B2bGuideAuthorityModule, controllers: [B2bGuideAuthorityController],
      providers: [{ provide: CORE, useValue: core }, { provide: PEERS, useValue: detached }] };
  }
}
