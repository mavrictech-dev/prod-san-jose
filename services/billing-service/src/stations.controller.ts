import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { PermissionCodes } from '@factuez/contracts';
import { StationAdminService } from './application/station-admin.service';
import { JwtPermissionGuard, RequiredPermissions, type AuthenticatedRequest } from './auth/jwt-permission.guard';

@Controller('api/v1/stations')
@UseGuards(JwtPermissionGuard)
export class StationsController {
  constructor(private readonly admin: StationAdminService) {}
  @Get('admin/catalog') @RequiredPermissions(PermissionCodes.SETUP_MANAGE)
  catalog(@Req() request: AuthenticatedRequest) { return this.admin.catalog(request); }
  @Post('issuers') @RequiredPermissions(PermissionCodes.SETUP_MANAGE)
  createIssuer(@Body() body: unknown, @Req() request: AuthenticatedRequest) { return this.admin.createIssuer(body, request); }
  @Patch('issuers/:id') @RequiredPermissions(PermissionCodes.SETUP_MANAGE)
  updateIssuer(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) { return this.admin.updateIssuer(id, body, request); }
  @Post('issuers/:id/environment') @RequiredPermissions(PermissionCodes.SETUP_MANAGE, PermissionCodes.SUNAT_CONFIGURE)
  configureEnvironment(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) { return this.admin.configureEnvironment(id, body, request); }
  @Delete('issuers/:id') @RequiredPermissions(PermissionCodes.SETUP_MANAGE)
  deactivateIssuer(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) { return this.admin.deactivateIssuer(id, body, request); }
  @Post() @RequiredPermissions(PermissionCodes.SETUP_MANAGE)
  create(@Body() body: unknown, @Req() request: AuthenticatedRequest) { return this.admin.createBranch(body, request); }
  @Patch(':id/issuer') @RequiredPermissions(PermissionCodes.SETUP_MANAGE)
  assignIssuer(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) { return this.admin.assignIssuer(id, body, request); }
  @Patch(':id') @RequiredPermissions(PermissionCodes.SETUP_MANAGE)
  update(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) { return this.admin.updateBranch(id, body, request); }
  @Delete(':id') @RequiredPermissions(PermissionCodes.SETUP_MANAGE)
  deactivate(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) { return this.admin.deactivateBranch(id, body, request); }
  @Post(':id/points') @RequiredPermissions(PermissionCodes.SERIES_MANAGE)
  point(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) { return this.admin.createPoint(id, body, request); }
  @Patch('points/:id') @RequiredPermissions(PermissionCodes.SERIES_MANAGE)
  updatePoint(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) { return this.admin.updatePoint(id, body, request); }
  @Delete('points/:id') @RequiredPermissions(PermissionCodes.SERIES_MANAGE)
  deactivatePoint(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) { return this.admin.deactivatePoint(id, body, request); }
  @Post('points/:id/series') @RequiredPermissions(PermissionCodes.SERIES_MANAGE)
  createSeries(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) { return this.admin.createSeries(id, body, request); }
  @Patch('series/:id') @RequiredPermissions(PermissionCodes.SERIES_MANAGE)
  updateSeries(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) { return this.admin.updateSeries(id, body, request); }
  @Delete('series/:id') @RequiredPermissions(PermissionCodes.SERIES_MANAGE)
  deactivateSeries(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) { return this.admin.deactivateSeries(id, body, request); }
}
