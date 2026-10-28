import { Catch, Controller, Inject, Module, Post, Req, Res, UseFilters, type ArgumentsHost, type DynamicModule } from '@nestjs/common';
import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { b2bPrivatePeer } from '@factuez/service-access/dist/b2b';
import { GUIDE_ARTIFACT_KINDS, guideArtifactWireScope } from '@factuez/service-access/dist/b2b-guide-artifact-wire';
import { boundedSupplementJson } from '@factuez/sunat-core/dist/fiscal-supplement-command';
import { GuideArtifactApi } from './application/guide-artifact-api';
import { GuideArtifactError } from './application/guide-artifact-owner';
const CORE = Symbol('Guide artifact API'), PEERS = Symbol('Guide artifact mTLS peers');
@Catch()
export class GuideArtifactHttpFilter {
  catch(error: unknown, host: ArgumentsHost) {
    let status = 503, code = 'GUIDE_ARTIFACT_UNAVAILABLE';
    if (error instanceof B2bSecurityError && [400,401,403,404,409,413,429].includes(error.status)) {
      status = error.status; code = status === 401 ? 'INVALID_TOKEN' : status === 403 ? 'PRIVATE_ACCESS_DENIED' : 'GUIDE_ARTIFACT_REQUEST_DENIED';
    } else if (error instanceof GuideArtifactError) {
      if (['GUIDE_ARTIFACT_NOT_PREPARED','GUIDE_ARTIFACT_CDR_NOT_FOUND'].includes(error.code)) { status = 404; code = 'GUIDE_ARTIFACT_NOT_FOUND'; }
      if (['GUIDE_ARTIFACT_IDENTITY_CONFLICT','GUIDE_ARTIFACT_CDR_CONFLICT','GUIDE_ARTIFACT_OWNER_CHANGED'].includes(error.code)) { status = 409; code = 'GUIDE_ARTIFACT_CONFLICT'; }
    }
    host.switchToHttp().getResponse().status(status).json({ code });
  }
}
@Controller('internal/b2b')
@UseFilters(GuideArtifactHttpFilter)
export class GuideArtifactController {
  constructor(@Inject(CORE) private readonly core: GuideArtifactApi, @Inject(PEERS) private readonly peers: readonly string[]) {}
  @Post('guide-artifacts')
  async execute(@Req() req: any, @Res() res: any) {
    res.setHeader('Cache-Control','private, no-store'); res.setHeader('X-Content-Type-Options','nosniff');
    b2bPrivatePeer(req, this.peers);
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(auth)) throw new B2bSecurityError(401,'INVALID_TOKEN');
    const headers: string[] = req.rawHeaders ?? [];
    if (headers.some((v, i) => i % 2 === 0 && headers.filter((n, j) => j % 2 === 0 && n.toLowerCase() === v.toLowerCase()).length > 1) ||
      req.url.includes('?') || Object.keys(req.query ?? {}).length) throw new B2bSecurityError(400,'INVALID_REQUEST');
    let b: any; try { b = boundedSupplementJson(req.body); } catch { throw new B2bSecurityError(400,'INVALID_REQUEST'); }
    if (!b || typeof b !== 'object' || Array.isArray(b) || Buffer.byteLength(JSON.stringify(b)) > 32768 ||
      !['SERVICE','USER'].includes(b.kind) || !['PREPARE','READ','CONTENT'].includes(b.action) ||
      Object.keys(b).sort().join(',') !== (b.action === 'CONTENT' ? 'action,artifact,kind,scope' : 'action,kind,scope') ||
      b.action === 'CONTENT' && !GUIDE_ARTIFACT_KINDS.includes(b.artifact)) throw new B2bSecurityError(400,'INVALID_REQUEST');
    const scope = guideArtifactWireScope(b.scope), access = { token: auth.slice(7), kind: b.kind };
    if (b.action !== 'CONTENT') return res.status(200).json(await this.core.view(scope, access, b.action === 'PREPARE'));
    const file = await this.core.content(scope, access, b.artifact);
    res.setHeader('Content-Type',file.mediaType); res.setHeader('Content-Length',String(file.bytes.length));
    res.setHeader('Content-Disposition',`attachment; filename="${file.fileName}"`); res.setHeader('X-Content-Sha256',file.sha256);
    res.setHeader('X-FactuEz-Source','LOCAL_EMULATOR'); return res.status(200).send(file.bytes);
  }
}
@Module({})
export class GuideArtifactModule {
  static isolated(core: GuideArtifactApi, peers: readonly string[]): DynamicModule {
    if (!core || typeof core.view !== 'function' || typeof core.content !== 'function' || !Array.isArray(peers) || !peers.length ||
      peers.length > 100 || new Set(peers).size !== peers.length || peers.some(p => !/^[a-f0-9]{64}$/.test(p))) throw new Error('EXPLICIT_GUIDE_ARTIFACT_OWNER_AND_PEERS_REQUIRED');
    return { module: GuideArtifactModule, controllers: [GuideArtifactController], providers: [GuideArtifactHttpFilter,
      { provide: CORE, useValue: core }, { provide: PEERS, useValue: Object.freeze([...peers]) }] };
  }
}
