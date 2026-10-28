import { Body, Controller, Get, Header, Headers, Param, Post, Req, UseGuards } from '@nestjs/common';
import { PermissionCodes } from '@factuez/contracts';
import { JwtPermissionGuard, RequiredPermissions, type AuthenticatedRequest } from './auth/jwt-permission.guard';
import { ProductionNotesOwnerService } from './application/production-notes-owner.service';
@Controller('api/v1/documents')
@UseGuards(JwtPermissionGuard)
export class ProductionNotesOwnerController {
    constructor(private readonly owner: ProductionNotesOwnerService) { }
    private actor(r: AuthenticatedRequest) { return { userId: r.user!.sub, scope: r.user!.scope, authorization: r.headers.authorization as string }; }
    @Get(':originalId/production-notes/ready')
    @RequiredPermissions(PermissionCodes.DOCUMENT_ISSUE)
    @Header('Cache-Control', 'private, no-store')
    ready(
    @Param('originalId')
    id: string, 
    @Req()
    r: AuthenticatedRequest) { return this.owner.ready(id, this.actor(r)); }
    @Post(':originalId/production-notes')
    @RequiredPermissions(PermissionCodes.DOCUMENT_ISSUE)
    issue(
    @Param('originalId')
    id: string, 
    @Body()
    body: unknown, 
    @Headers('idempotency-key')
    key: string, 
    @Req()
    r: AuthenticatedRequest) { return this.owner.issue(id, body, key, this.actor(r)); }
}
