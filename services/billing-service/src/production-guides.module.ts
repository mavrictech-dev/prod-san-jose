import { Module,type DynamicModule } from '@nestjs/common';
import { PrismaService } from './infrastructure/prisma.service';
import { JwtPermissionGuard } from './auth/jwt-permission.guard';
import { ProductionGuidesOwner,type ProductionGuidesBillingOptions,type ProductionGuidesBillingDb } from './production-guides-owner';
import { ProductionGuidesBillingController } from './production-guides.controller';
import { createProductionGuidesBilling,type ProductionGuidesBillingAssemblyInput } from './production-guides-assembly';
import { ProductionGuidesBillingRuntime } from './production-guides-runtime';
import { ProductionGuidesBillingPrivateController,PRODUCTION_GUIDES_BILLING_PRIVATE_PEERS } from './production-guides-private';
export const PRODUCTION_GUIDES_BILLING_OPTIONS='PRODUCTION_GUIDES_BILLING_OPTIONS';
export const PRODUCTION_GUIDES_BILLING_PROVIDERS=[{provide:ProductionGuidesOwner,inject:[PrismaService,PRODUCTION_GUIDES_BILLING_OPTIONS],useFactory:(db:PrismaService,options?:ProductionGuidesBillingOptions)=>new ProductionGuidesOwner(db as unknown as ProductionGuidesBillingDb,options)}];
export const PRODUCTION_GUIDES_BILLING_CONTROLLERS=[ProductionGuidesBillingController,ProductionGuidesBillingPrivateController];
@Module({}) export class ProductionGuidesBillingModule {
 static native(input:ProductionGuidesBillingAssemblyInput):DynamicModule{
  const a=createProductionGuidesBilling(input);return {module:ProductionGuidesBillingModule,controllers:PRODUCTION_GUIDES_BILLING_CONTROLLERS,
   providers:[JwtPermissionGuard,{provide:ProductionGuidesOwner,useValue:a.owner},{provide:ProductionGuidesBillingRuntime,useValue:a.runtime},{provide:PRODUCTION_GUIDES_BILLING_PRIVATE_PEERS,useValue:a.privatePeers},{provide:'PRODUCTION_GUIDES_BILLING_CLEANUP',useValue:{onModuleDestroy:a.close}}],exports:[ProductionGuidesOwner,ProductionGuidesBillingRuntime]};
 }
 static register(options?:ProductionGuidesBillingOptions):DynamicModule{return {module:ProductionGuidesBillingModule,controllers:PRODUCTION_GUIDES_BILLING_CONTROLLERS,providers:[PrismaService,JwtPermissionGuard,{provide:PRODUCTION_GUIDES_BILLING_OPTIONS,useValue:options??null},{provide:PRODUCTION_GUIDES_BILLING_PRIVATE_PEERS,useValue:[]},...PRODUCTION_GUIDES_BILLING_PROVIDERS],exports:[ProductionGuidesOwner]};}
}
