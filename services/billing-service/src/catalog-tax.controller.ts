import {Body,Controller,Get,Param,Patch,Post,Put,Query,Req,UseGuards} from '@nestjs/common';
import {PermissionCodes} from '@factuez/contracts';
import {JwtPermissionGuard,RequiredPermissions,type AuthenticatedRequest} from './auth/jwt-permission.guard';
import {CatalogTaxService} from './application/catalog-tax.service';
@Controller('api/v1/stations') @UseGuards(JwtPermissionGuard)
export class CatalogTaxController {
 constructor(private readonly service:CatalogTaxService){}
 @Get('product-categories') categories(@Req() r:AuthenticatedRequest){return this.service.masters(r,'categories');}
 @Post('product-categories') @RequiredPermissions(PermissionCodes.PRODUCT_MANAGE) create(@Body() b:unknown,@Req() r:AuthenticatedRequest){return this.service.saveMaster('categories',undefined,b,r);}
 @Patch('product-categories/:id') @RequiredPermissions(PermissionCodes.PRODUCT_MANAGE) category(@Param('id') id:string,@Body() b:unknown,@Req() r:AuthenticatedRequest){return this.service.saveMaster('categories',id,b,r);}
 @Get('product-units') units(@Req() r:AuthenticatedRequest){return this.service.masters(r,'units');}
 @Patch('product-units/:id') @RequiredPermissions(PermissionCodes.PRODUCT_MANAGE) unit(@Param('id') id:string,@Body() b:unknown,@Req() r:AuthenticatedRequest){return this.service.saveMaster('units',id,b,r);}
 @Get('companies/:id/tax-policy') policy(@Param('id') id:string,@Query('branchId') branchId:string|undefined,@Req() r:AuthenticatedRequest){return this.service.view(Number(id),branchId??null,r);}
 @Put('companies/:id/tax-policy') @RequiredPermissions(PermissionCodes.SETUP_MANAGE) save(@Param('id') id:string,@Query('branchId') branchId:string|undefined,@Body() b:unknown,@Req() r:AuthenticatedRequest){return this.service.save(Number(id),branchId??null,b,r);}
 @Get('companies/:id/effective-products') effective(@Param('id') id:string,@Query('branchId') branchId:string|undefined,@Req() r:AuthenticatedRequest){return this.service.effectiveProducts(Number(id),branchId??null,r);}
 @Get('companies/:id/product-taxes') taxes(@Param('id') id:string,@Query('branchId') branchId:string|undefined,@Req() r:AuthenticatedRequest){return this.service.productTaxes(Number(id),branchId??null,r);}
 @Put('companies/:id/product-taxes/:productId') @RequiredPermissions(PermissionCodes.SETUP_MANAGE) tax(@Param('id') id:string,@Param('productId') p:string,@Query('branchId') branchId:string|undefined,@Body() b:unknown,@Req() r:AuthenticatedRequest){return this.service.saveProductTax(Number(id),branchId??null,p,b,r);}
}
