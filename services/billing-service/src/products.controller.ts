import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { PermissionCodes } from '@factuez/contracts';
import { JwtPermissionGuard, RequiredPermissions, type AuthenticatedRequest } from './auth/jwt-permission.guard';
import { ProductAdminService } from './application/product-admin.service';
@Controller('api/v1/stations/products')
@UseGuards(JwtPermissionGuard)
@RequiredPermissions(PermissionCodes.PRODUCT_MANAGE)
export class ProductsController {
  constructor(private readonly products: ProductAdminService) {}
  @Get() list(@Req() request: AuthenticatedRequest) { return this.products.list(request); }
  @Post() create(@Body() body: unknown, @Req() request: AuthenticatedRequest) { return this.products.save(undefined, body, request); }
  @Patch(':id') update(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) { return this.products.save(id, body, request); }
}
