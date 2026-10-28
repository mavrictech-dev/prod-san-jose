import { Body, Controller, Get, Header, Param, Post, Query, Req, StreamableFile, UseGuards } from '@nestjs/common';
import { PermissionCodes } from '@factuez/contracts';
import { PrintBrandingService } from './application/print-branding.service';
import { JwtPermissionGuard, RequiredPermissions, type AuthenticatedRequest } from './auth/jwt-permission.guard';

@Controller('api/v1/stations/print-settings')
@UseGuards(JwtPermissionGuard)
@RequiredPermissions(PermissionCodes.SETUP_MANAGE)
export class PrintSettingsController {
  constructor(private readonly printing: PrintBrandingService) {}
  @Get(':companyId/snapshot')
  @Header('Cache-Control', 'private, no-store')
  @RequiredPermissions(PermissionCodes.DOCUMENT_VIEW)
  snapshot(@Param('companyId') companyId: string, @Query('branchId') branchId: unknown, @Req() request: AuthenticatedRequest) {
    return this.printing.snapshot(companyId, branchId, request.user);
  }
  @Get(':companyId')
  @Header('Cache-Control', 'private, no-store')
  settings(@Param('companyId') companyId: string, @Query('branchId') branchId: unknown, @Req() request: AuthenticatedRequest) {
    return this.printing.settings(companyId, branchId, request.user);
  }
  @Post(':companyId')
  @Header('Cache-Control', 'private, no-store')
  save(@Param('companyId') companyId: string, @Query('branchId') branchId: unknown, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.printing.save(companyId, branchId, body, request.user);
  }
  @Post(':companyId/preview')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async preview(@Param('companyId') companyId: string, @Query('branchId') branchId: unknown, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const result = await this.printing.preview(companyId, branchId, body, request.user);
    return new StreamableFile(result.bytes, { type: 'application/pdf', disposition: `inline; filename="${result.fileName}"` });
  }
}
