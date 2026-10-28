import { Module,type DynamicModule } from '@nestjs/common';
import { PrismaService } from './infrastructure/prisma.service';
import { FiscalIssuanceGuard } from './auth/fiscal-issuance.guard';
import type { ProductionGuidesSigner } from '@factuez/contracts/production-guides';
import { ProductionGuidesStore,type ProductionGuidesDatabase } from './production-guides-store';
import { ProductionGuidesService,type ProductionGuidesSunatOptions } from './production-guides-service';
import { ProductionGuidesSunatController } from './production-guides.controller';
import { createProductionGuidesSunat,type ProductionGuidesSunatAssemblyInput } from './production-guides-assembly';
import { ProductionGuidesSunatRuntime } from './production-guides-runtime';
import { ProductionGuidesSunatPrivateController,PRODUCTION_GUIDES_SUNAT_PRIVATE_PEERS,PRODUCTION_GUIDES_GRANT_EVIDENCE } from './production-guides-private';
export const PRODUCTION_GUIDES_SUNAT_OPTIONS='PRODUCTION_GUIDES_SUNAT_OPTIONS';
export type ProductionGuidesAssembly={service:ProductionGuidesSunatOptions;statusSigner:ProductionGuidesSigner};
export const PRODUCTION_GUIDES_SUNAT_PROVIDERS=[
 {provide:ProductionGuidesStore,inject:[PrismaService,PRODUCTION_GUIDES_SUNAT_OPTIONS],useFactory:(db:PrismaService,o:ProductionGuidesAssembly|null)=>new ProductionGuidesStore(db as unknown as ProductionGuidesDatabase,o?.statusSigner??{sign(){throw Error('GRE_STATUS_SIGNING_DISABLED');}},o?.service.transport.source??'LOCAL_SYNTHETIC')},
 {provide:ProductionGuidesService,inject:[ProductionGuidesStore,PRODUCTION_GUIDES_SUNAT_OPTIONS],useFactory:(s:ProductionGuidesStore,o:ProductionGuidesAssembly|null)=>new ProductionGuidesService(s,o?.service)}
];
export const PRODUCTION_GUIDES_SUNAT_CONTROLLERS=[ProductionGuidesSunatController,ProductionGuidesSunatPrivateController];
@Module({}) export class ProductionGuidesSunatModule {
 static native(input:ProductionGuidesSunatAssemblyInput):DynamicModule{
  const a=createProductionGuidesSunat(input);return {module:ProductionGuidesSunatModule,controllers:PRODUCTION_GUIDES_SUNAT_CONTROLLERS,
   providers:[FiscalIssuanceGuard,{provide:ProductionGuidesService,useValue:a.service},{provide:ProductionGuidesStore,useValue:a.store},{provide:ProductionGuidesSunatRuntime,useValue:a.runtime},{provide:PRODUCTION_GUIDES_SUNAT_PRIVATE_PEERS,useValue:a.privatePeers},{provide:PRODUCTION_GUIDES_GRANT_EVIDENCE,useValue:a.grantEvidence},{provide:'PRODUCTION_GUIDES_SUNAT_CLEANUP',useValue:{onModuleDestroy:a.close}}],exports:[ProductionGuidesService,ProductionGuidesStore,ProductionGuidesSunatRuntime]};
 }
 static register(options?:ProductionGuidesAssembly):DynamicModule{return {module:ProductionGuidesSunatModule,controllers:PRODUCTION_GUIDES_SUNAT_CONTROLLERS,providers:[PrismaService,FiscalIssuanceGuard,{provide:PRODUCTION_GUIDES_SUNAT_OPTIONS,useValue:options??null},{provide:PRODUCTION_GUIDES_SUNAT_PRIVATE_PEERS,useValue:[]},{provide:PRODUCTION_GUIDES_GRANT_EVIDENCE,useValue:async()=>{throw Error('GRE_CONFIGURATION_DISABLED');}},...PRODUCTION_GUIDES_SUNAT_PROVIDERS],exports:[ProductionGuidesStore,ProductionGuidesService]};}
}
