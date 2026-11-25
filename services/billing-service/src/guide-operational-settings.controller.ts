import { Body, Controller, Get, Header, Param, Put, Req, UseGuards } from '@nestjs/common';
import { PermissionCodes } from '@factuez/contracts';
import { GuideOperationalSettingsService } from './application/guide-operational-settings.service';
import { JwtPermissionGuard, RequiredPermissions, type AuthenticatedRequest } from './auth/jwt-permission.guard';

@Controller('api/v1/stations/issuers/:companyId/guide-settings')
@UseGuards(JwtPermissionGuard)
@RequiredPermissions(PermissionCodes.SETUP_MANAGE)
export class GuideOperationalSettingsController {
  constructor(private readonly settings: GuideOperationalSettingsService) {}
  @Get() @Header('Cache-Control', 'private, no-store')
  get(@Param('companyId') companyId: string, @Req() request: AuthenticatedRequest) { return this.settings.get(companyId, request); }
  @Put() @Header('Cache-Control', 'private, no-store')
  put(@Param('companyId') companyId: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) { return this.settings.put(companyId, body, request); }
}
