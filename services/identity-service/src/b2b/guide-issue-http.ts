import { Body, Controller, Get, Inject, Module, Param, Post, Req, Res, UseFilters, type DynamicModule } from '@nestjs/common';
import { B2bGuideIssueAuthority, guideIssueJson } from './guide-issue-authority';
import { B2bErrorFilter, b2bPrivateContext, b2bPrivateHeaders } from './http';
import { fail } from './model';

const CORE = Symbol('B2B guide issue authority'), PEERS = Symbol('B2B guide issue peers');
export interface GuideIssueAuthorityPeers { admin: readonly string[]; owner: readonly string[] }
function bearer(req: any) {
  if (typeof req.headers.authorization !== 'string' || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(req.headers.authorization)) return fail(401, 'INVALID_TOKEN');
  return req.headers.authorization.slice(7);
}
@Controller('internal/b2b')
@UseFilters(B2bErrorFilter)
export class B2bGuideIssueAuthorityController {
  constructor(@Inject(CORE) private readonly core: B2bGuideIssueAuthority, @Inject(PEERS) private readonly peers: GuideIssueAuthorityPeers) {}
  @Get('clients/:id/guide-issue-grants')
  async read(@Req() req: any, @Res() res: any, @Param('id') id: string) {
    b2bPrivateHeaders(res); const context = b2bPrivateContext(req, this.peers.admin);
    res.status(200).json(await this.core.read(bearer(req), id, context));
  }
  @Post('clients/:id/guide-issue-grants')
  async replace(@Req() req: any, @Res() res: any, @Param('id') id: string, @Body() body: unknown) {
    b2bPrivateHeaders(res); const context = b2bPrivateContext(req, this.peers.admin);
    res.status(200).json(await this.core.replace(bearer(req), id, body, context));
  }
  @Post('authorize-guide-issue')
  async authorize(@Req() req: any, @Res() res: any, @Body() body: unknown) {
    b2bPrivateHeaders(res); const context = b2bPrivateContext(req, this.peers.owner);
    res.status(200).json(await this.core.authorize(bearer(req), body, context));
  }
}
@Module({})
export class B2bGuideIssueAuthorityModule {
  static isolated(core: B2bGuideIssueAuthority, peers: GuideIssueAuthorityPeers): DynamicModule {
    const row = guideIssueJson(peers);
    if (!row || Object.keys(row).sort().join(',') !== 'admin,owner' ||
      Object.values(row).some((ids: any) => !Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length ||
        ids.some((id: unknown) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)))) throw new Error('Explicit guide issue authority mTLS peers required');
    if (row.admin.some((id: string) => row.owner.includes(id))) throw new Error('Separate guide issue enrollment and owner peers required');
    const detached = Object.freeze({ admin: Object.freeze([...row.admin]), owner: Object.freeze([...row.owner]) });
    return { module: B2bGuideIssueAuthorityModule, controllers: [B2bGuideIssueAuthorityController],
      providers: [{ provide: CORE, useValue: core }, { provide: PEERS, useValue: detached }] };
  }
}
