import { BadRequestException, Body, Controller, Get, Header, Headers, ForbiddenException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { allowsResource, type FiscalDocumentSnapshot, type ProductionNotesAnySnapshot as ProductionNotesSnapshot } from '@factuez/contracts';
import { FiscalIssuanceGuard } from './auth/fiscal-issuance.guard';
import { ConfigurationGuard, type ConfigurationRequest } from './auth/configuration.guard';
import { ProductionNotesPolicyService } from './application/production-notes-policy.service';
import { ProductionNotesEvidenceService } from './application/production-notes-evidence.service';
@Controller('api/v1/setup/sunat')
export class ProductionNotesController {
    constructor(private readonly policy: ProductionNotesPolicyService, private readonly evidence: ProductionNotesEvidenceService) { }
    @Get(':companyId/PRODUCTION/notes/authorization')
    @UseGuards(ConfigurationGuard)
    @Header('Cache-Control', 'private, no-store')
    status(
    @Param('companyId')
    companyId: string, 
    @Req()
    r: ConfigurationRequest) { return this.policy.status(companyId, r.headers.authorization!); }
    @Post(':companyId/PRODUCTION/notes/authorization')
    @UseGuards(ConfigurationGuard)
    configure(
    @Param('companyId')
    companyId: string, 
    @Body()
    input: unknown, 
    @Req()
    r: ConfigurationRequest) { return this.policy.configure(companyId, input, r.headers.authorization!, r.user!.sub); }
    private async original(companyId: string, snapshot: FiscalDocumentSnapshot, r: ConfigurationRequest) {
        if (!snapshot || String(snapshot.companyId) !== companyId || !snapshot.branchId || !allowsResource(r.user!.scope, snapshot.branchId))
            throw new BadRequestException('Original fuera del alcance');
        // Billing authorizes the exact owner document using the same live human bearer.
        const response = await fetch((process.env.BILLING_INTERNAL_URL ?? 'http://billing-service:3002') + '/api/v1/documents/' + snapshot.documentId, { headers: { Authorization: r.headers.authorization!, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(5000) });
        if (!response.ok)
            throw new BadRequestException('Original propio no autorizado');
        const own = await response.json() as {
            immutableSnapshot: unknown;
        };
        const { fiscalSnapshotSha256 } = await import('@factuez/sunat-core');
        if (fiscalSnapshotSha256(own.immutableSnapshot) !== fiscalSnapshotSha256(snapshot))
            throw new BadRequestException('Snapshot original ajeno');
    }
    @Post(':companyId/PRODUCTION/notes/original-evidence')
    @UseGuards(FiscalIssuanceGuard)
    async accepted(
    @Param('companyId')
    companyId: string, 
    @Body()
    body: {
        original: FiscalDocumentSnapshot;
    }, 
    @Req()
    r: ConfigurationRequest) {
        if (!body || Object.keys(body).join(',') !== 'original')
            throw new BadRequestException('Envíe sólo original');
        await this.original(companyId, body.original, r);
        return this.evidence.original(body.original);
    }
    @Post(':companyId/PRODUCTION/notes/admission')
    @UseGuards(FiscalIssuanceGuard)
    async admit(
    @Param('companyId')
    companyId: string, 
    @Body()
    body: {
        snapshot: ProductionNotesSnapshot;
        original: FiscalDocumentSnapshot;
        creditHistory: ProductionNotesSnapshot[];
        ownerRevisionSha256: string;
    }, 
    @Headers('x-factuez-notes-owner')
    owner: string, 
    @Req()
    r: ConfigurationRequest) {
        if (!body || Object.keys(body).sort().join(',') !== 'creditHistory,original,ownerRevisionSha256,snapshot')
            throw new BadRequestException('Solicitud inválida');
        try {
            if (typeof owner !== 'string' || owner.length > 2048 || !/^[a-f0-9]{64}$/.test(body.ownerRevisionSha256))
                throw Error();
            const { assertProductionNotesOwner } = await import('@factuez/sunat-core');
            assertProductionNotesOwner(body, 'admission', JSON.parse(Buffer.from(owner, 'base64url').toString('utf8')));
        }
        catch {
            throw new ForbiddenException('Admisión reservada a la atestación transaccional de Billing');
        }
        await this.original(companyId, body.original, r);
        return this.policy.admit(body.snapshot, body.original, body.creditHistory);
    }
}
