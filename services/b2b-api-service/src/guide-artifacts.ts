import { Controller, Get, Inject, Module, Param, Post, Req, Res, UseFilters, type DynamicModule } from '@nestjs/common';
import { B2bSecurityError, b2bBindingsContain } from '@factuez/contracts/b2b-security';
import { b2bGuideIssueScopes, b2bGuideIssueReadScopes } from '@factuez/contracts/b2b-guide-security';
import { b2bIssuerId, b2bQuery } from '@factuez/contracts/b2b-read-query';
import { B2bOwnerReadFrame, type B2bIdentityPort } from '@factuez/service-access/dist/b2b-read-adapter';
import { b2bPrivatePeer, type B2bPrivateHttp } from '@factuez/service-access/dist/b2b';
import { correctionEvidenceFreeze, correctionEvidenceHash } from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import { GUIDE_ARTIFACT_KINDS, guideArtifactWireScope, guideArtifactWireView, guideArtifactWireFile,
  type GuideArtifactKind, type GuideArtifactWireScope, type GuideArtifactWireFile } from '@factuez/service-access/dist/b2b-guide-artifact-wire';
import { B2bGuideIssueHttpErrorFilter } from './guide-issue';
import { b2bReadHeaders } from './http';
type Kind = 'SERVICE' | 'USER';
export interface B2bGuideArtifactOwner {
  view(token: string, kind: Kind, scope: GuideArtifactWireScope, prepare: boolean): Promise<unknown>;
  content(token: string, kind: Kind, scope: GuideArtifactWireScope, artifact: GuideArtifactKind): Promise<GuideArtifactWireFile>;
}
export class HttpB2bGuideArtifactOwner implements B2bGuideArtifactOwner {
  constructor(private readonly http: Pick<B2bPrivateHttp, 'post' | 'guideArtifactFile'>) {}
  view(token: string, kind: Kind, scope: GuideArtifactWireScope, prepare: boolean) {
    return this.http.post('/internal/b2b/guide-artifacts', { kind, scope, action: prepare ? 'PREPARE' : 'READ' }, token);
  }
  content(token: string, kind: Kind, scope: GuideArtifactWireScope, artifact: GuideArtifactKind) {
    return this.http.guideArtifactFile({ kind, scope, action: 'CONTENT', artifact }, token);
  }
}
function invalid(): never { throw new B2bSecurityError(400,'INVALID_GUIDE_ARTIFACT_SCOPE'); }
export class B2bGuideArtifacts {
  constructor(private readonly identity: B2bIdentityPort, private readonly owner: B2bGuideArtifactOwner) {}
  private async frame(token: string, kind: Kind, input: unknown, prepare: boolean) {
    if (!['SERVICE','USER'].includes(kind) || typeof token !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token)) throw new B2bSecurityError(401,'INVALID_TOKEN');
    const scope = guideArtifactWireScope(input), frame = new B2bOwnerReadFrame(this.identity, kind);
    const scopes = [...(prepare ? b2bGuideIssueScopes : b2bGuideIssueReadScopes)];
    const before = await frame.principal(token, scopes);
    if (!b2bBindingsContain(before.bindings, scope.binding.draft.anchor)) throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');
    return { scope, fresh: async () => { const after = await frame.principal(token, scopes);
      if (!b2bBindingsContain(after.bindings, scope.binding.draft.anchor)) throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND'); } };
  }
  async view(token: string, kind: Kind, input: unknown, prepare: boolean) {
    const f = await this.frame(token, kind, input, prepare);
    const result = guideArtifactWireView(await this.owner.view(token, kind, f.scope, prepare), f.scope, prepare);
    await f.fresh(); return result;
  }
  async content(token: string, kind: Kind, input: unknown, artifact: GuideArtifactKind) {
    if (!GUIDE_ARTIFACT_KINDS.includes(artifact)) invalid();
    const f = await this.frame(token, kind, input, false);
    const before = guideArtifactWireView(await this.owner.view(token, kind, f.scope, false), f.scope, false);
    const file = guideArtifactWireFile(await this.owner.content(token, kind, f.scope, artifact), before, artifact);
    const after = guideArtifactWireView(await this.owner.view(token, kind, f.scope, false), f.scope, false);
    if (correctionEvidenceHash(before) !== correctionEvidenceHash(after)) throw new B2bSecurityError(409,'GUIDE_ARTIFACT_CHANGED');
    await f.fresh(); return file;
  }
}
const CORE = Symbol('B2B guide artifacts'), PEERS = Symbol('B2B guide artifact peers');
const QUERY = ['issuerId','issuerRuc','environment','branchId','pointId','seriesId','documentType','guideSeriesId','guideType','fiscalSeriesId'] as const;
@Controller('b2b/v1')
@UseFilters(B2bGuideIssueHttpErrorFilter)
export class B2bGuideArtifactController {
  constructor(@Inject(CORE) private readonly core: B2bGuideArtifacts, @Inject(PEERS) private readonly peers: readonly string[]) {}
  private access(req: any, res: any) {
    b2bReadHeaders(res); b2bPrivatePeer(req,this.peers);
    const names: string[] = (req.rawHeaders ?? []).filter((_v: string,i: number) => i % 2 === 0).map((v: string) => v.toLowerCase());
    const a = req.headers.authorization, k = req.headers['x-factuez-actor-kind'];
    if (typeof a !== 'string' || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(a) || !['SERVICE','USER'].includes(k) ||
      names.filter(n => n === 'authorization').length !== 1 || names.filter(n => n === 'x-factuez-actor-kind').length !== 1)
      throw new B2bSecurityError(401,'INVALID_TOKEN');
    if (new Set(names).size !== names.length || names.some(n => ['authorization','xfactuezactorkind'].includes(n.replace(/[-_]/g,'')) &&
      !['authorization','x-factuez-actor-kind'].includes(n))) invalid();
    return { token: a.slice(7), kind: k as Kind };
  }
  private query(req: any, draftId: string, operationId: string) {
    if (req.headers['transfer-encoding'] !== undefined || req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0' || req.body !== undefined) invalid();
    const params = new URLSearchParams((req.originalUrl ?? req.url).split('?').slice(1).join('?')), keys = [...params.keys()];
    if (new Set(keys).size !== keys.length || keys.length !== QUERY.length || keys.some(k => !QUERY.includes(k as any))) invalid();
    const q = b2bQuery(correctionEvidenceFreeze(req.query), QUERY, QUERY);
    return guideArtifactWireScope({ draftId, operationId, binding: { draft: { anchor: { issuerId: b2bIssuerId(q.issuerId), issuerRuc: q.issuerRuc,
      environment: q.environment, branchId: q.branchId, pointId: q.pointId, seriesId: q.seriesId, documentType: q.documentType },
      guideSeriesId: q.guideSeriesId, guideType: q.guideType }, fiscalSeriesId: q.fiscalSeriesId } });
  }
  @Post('guide-drafts/:id/issuances/:operationId/artifacts')
  async prepare(@Req() req: any, @Res() res: any, @Param('id') id: string, @Param('operationId') operationId: string) {
    const a = this.access(req,res); if (req.url.includes('?') || Object.keys(req.query ?? {}).length) invalid();
    const b: any = correctionEvidenceFreeze(req.body);
    if (!b || Object.keys(b).join(',') !== 'binding' || Buffer.byteLength(JSON.stringify(b)) > 16384) invalid();
    const scope = guideArtifactWireScope({ draftId: id, operationId, binding: b.binding });
    const result = await this.core.view(a.token,a.kind,scope,true);
    res.setHeader('X-Idempotent-Replay',String(result.replayed)); return res.status(200).json(result);
  }
  @Get('guide-drafts/:id/issuances/:operationId/artifacts')
  async read(@Req() req: any, @Res() res: any, @Param('id') id: string, @Param('operationId') operationId: string) {
    const a = this.access(req,res), scope = this.query(req,id,operationId);
    return res.status(200).json(await this.core.view(a.token,a.kind,scope,false));
  }
  @Get('guide-drafts/:id/issuances/:operationId/artifacts/:artifact')
  async content(@Req() req: any, @Res() res: any, @Param('id') id: string, @Param('operationId') operationId: string, @Param('artifact') artifact: GuideArtifactKind) {
    const a = this.access(req,res), scope = this.query(req,id,operationId), file = await this.core.content(a.token,a.kind,scope,artifact);
    res.setHeader('Content-Type',file.mediaType); res.setHeader('Content-Length',String(file.bytes.length));
    res.setHeader('Content-Disposition',`attachment; filename="${file.fileName}"`); res.setHeader('X-Content-Sha256',file.sha256);
    res.setHeader('X-FactuEz-Source','LOCAL_EMULATOR'); return res.status(200).send(file.bytes);
  }
}
@Module({})
export class B2bGuideArtifactModule {
  static isolated(core: B2bGuideArtifacts, peers: readonly string[]): DynamicModule {
    if (!core || typeof core.view !== 'function' || typeof core.content !== 'function' || !Array.isArray(peers) || !peers.length ||
      peers.length > 100 || new Set(peers).size !== peers.length || peers.some(p => !/^[a-f0-9]{64}$/.test(p))) throw new Error('EXPLICIT_GUIDE_ARTIFACT_OWNER_AND_PEERS_REQUIRED');
    return { module: B2bGuideArtifactModule, controllers: [B2bGuideArtifactController], providers: [B2bGuideIssueHttpErrorFilter,
      { provide: CORE, useValue: core }, { provide: PEERS, useValue: Object.freeze([...peers]) }] };
  }
}
