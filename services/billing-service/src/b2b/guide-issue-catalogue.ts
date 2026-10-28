import { Controller, Inject, Module, Post, Req, Res, UseFilters, type DynamicModule } from '@nestjs/common';
import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { validB2bGuideIssueBinding, b2bGuideIssueBindingKey,
  type B2bGuideIssueBinding, type B2bGuideIssueAction } from '@factuez/contracts/b2b-guide-security';
import { b2bPrivatePeer } from '@factuez/service-access/dist/b2b';
import { boundedSupplementJson } from '@factuez/sunat-core/dist/fiscal-supplement-command';
import type { GuideEstablishmentSql } from './guide-establishment-store';
import { BillingGuideHttpErrorFilter } from './guide-http';

/** SQL identifiers and patterns are closed source literals, never supplied by
 * callers. A valid 31 pair cannot fall back to the remitente 09 mapping. */
const issueProfiles = Object.freeze({
  '09': Object.freeze({ table: '"B2bGuideIssueSeries"', type: "'09'", series: "'^T[A-Z0-9]{3}$'" }),
  '31': Object.freeze({ table: '"CarrierGuideSeries"', type: "'31'", series: "'^V[A-Z0-9]{3}$'" }),
});

/** Metadata-only owner port. No secrets, number reservation or cross-owner SQL.
 * READ permits inactive historical slots but requires the exact linked identity.
 * ISSUE additionally requires active masters. Counter availability belongs to
 * the producer transaction, NOT authorization: consuming the last number must
 * not revoke the same command's post-commit proof or its idempotent retry. */
export class BillingGuideIssueCatalogue {
  constructor(private readonly db: Pick<GuideEstablishmentSql, '$queryRawUnsafe'>) {}
  async validate(input: B2bGuideIssueBinding[], action: B2bGuideIssueAction): Promise<void> {
    let bindings: B2bGuideIssueBinding[];
    try { bindings = boundedSupplementJson(input) as B2bGuideIssueBinding[]; }
    catch { throw new B2bSecurityError(400, 'INVALID_GUIDE_ISSUE_BINDINGS'); }
    if (!['READ', 'ISSUE'].includes(action) || !Array.isArray(bindings) || !bindings.length || bindings.length > 500 ||
      !bindings.every(validB2bGuideIssueBinding) || new Set(bindings.map(b2bGuideIssueBindingKey)).size !== bindings.length)
      throw new B2bSecurityError(400, 'INVALID_GUIDE_ISSUE_BINDINGS');
    for (const binding of bindings) {
      const b = binding.draft, a = b.anchor;
      const profile = issueProfiles[b.guideType];
      if (!profile) throw new B2bSecurityError(400, 'INVALID_GUIDE_ISSUE_BINDINGS');
      const rows = await this.db.$queryRawUnsafe<{ valid: boolean }[]>(`SELECT true AS valid
        FROM ${profile.table} m
        JOIN "B2bGuideDraftSeries" g ON g."id"=m."draftSeriesId" AND g."companyId"=m."companyId"
        JOIN "SeriesCounter" f ON f."id"=m."fiscalSeriesId" AND f."companyId"=m."companyId"
        JOIN "CompanySettings" c ON c."id"=m."companyId" AND c."ruc"=$2 AND c."environment"='BETA'
        JOIN "EmissionPoint" p ON p."id"=g."pointId" AND p."companyId"=c."id"
        JOIN "Branch" z ON z."id"=p."branchId" AND z."companyId"=c."id"
        JOIN "SeriesCounter" s ON s."id"=$5::uuid AND s."companyId"=c."id" AND s."emissionPointId"=p."id"
        WHERE c."id"=$1 AND z."id"=$3::uuid AND p."id"=$4::uuid
          AND s."documentType"::text=$6 AND g."id"=$7::uuid AND g."guideType"=$8 AND g."guideType"=${profile.type}
          AND f."id"=$9::uuid AND f."emissionPointId"=p."id" AND f."documentType"='DESPATCH_ADVICE'
          AND f."series"=g."label" AND f."series" ~ ${profile.series}
          AND m."purpose"='LOCAL_CANDIDATE' AND g."purpose"='DRAFT_ONLY'
          AND ($10::boolean=false OR (c."active" AND z."active" AND p."active" AND s."active" AND m."active" AND g."active" AND f."active"))`, a.issuerId, a.issuerRuc, a.branchId, a.pointId,
      a.seriesId, a.documentType === '01' ? 'INVOICE' : 'SALES_RECEIPT', b.guideSeriesId, b.guideType, binding.fiscalSeriesId, action === 'ISSUE');
      if (rows.length !== 1 || rows[0].valid !== true) throw new B2bSecurityError(404, 'GUIDE_ISSUE_CONTEXT_NOT_FOUND');
    }
  }
}

const CORE = Symbol('Guide issue catalogue'), PEERS = Symbol('Guide issue registrar peers');
@Controller('internal/b2b')
@UseFilters(BillingGuideHttpErrorFilter)
export class BillingGuideIssueCatalogueController {
  constructor(@Inject(CORE) private readonly core: BillingGuideIssueCatalogue, @Inject(PEERS) private readonly peers: readonly string[]) {}
  @Post('validate-guide-issue-bindings')
  async validate(@Req() req: any, @Res() res: any) {
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); b2bPrivatePeer(req, this.peers);
    if (req.url?.includes('?') || Object.keys(req.query ?? {}).length || req.rawHeaders?.some((v: string, i: number) => i % 2 === 0 &&
      req.rawHeaders.filter((h: string, j: number) => j % 2 === 0 && h.toLowerCase() === v.toLowerCase()).length > 1))
      throw new B2bSecurityError(400, 'INVALID_GUIDE_ISSUE_BINDINGS');
    let b: any;
    try { b = boundedSupplementJson(req.body); } catch { throw new B2bSecurityError(400, 'INVALID_GUIDE_ISSUE_BINDINGS'); }
    if (!b || Object.keys(b).sort().join(',') !== 'action,bindings') throw new B2bSecurityError(400, 'INVALID_GUIDE_ISSUE_BINDINGS');
    await this.core.validate(b.bindings, b.action); res.status(200).json({ valid: true });
  }
}
@Module({})
export class BillingGuideIssueCatalogueModule {
  static isolated(core: BillingGuideIssueCatalogue, peers: string[]): DynamicModule {
    if (!core || typeof core.validate !== 'function' || !Array.isArray(peers) || !peers.length || peers.length > 100 ||
      new Set(peers).size !== peers.length || peers.some(p => !/^[a-f0-9]{64}$/.test(p))) throw new Error('Explicit guide issue registrar peers required');
    return { module: BillingGuideIssueCatalogueModule, controllers: [BillingGuideIssueCatalogueController], providers: [
      { provide: CORE, useValue: core }, { provide: PEERS, useValue: Object.freeze([...peers]) }, BillingGuideHttpErrorFilter] };
  }
}
