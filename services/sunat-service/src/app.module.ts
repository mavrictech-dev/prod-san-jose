import {NativeB2bFiscalController,NativeB2bFiscalAuthority} from './native-b2b.controller';
import {ProductionGuidesAdministration,ProductionGuidesAdministrationController} from './production-guides-administration';
import {ProductionGuidesCatalogueAdmin,ProductionGuidesCatalogueController} from './production-guides-catalogue';
import {productionGuidesSunatHost} from './production-guides-host';
import {ProductionGuidesService} from './production-guides-service';
import {ProductionGuidesSunatRuntime} from './production-guides-runtime';
import {PRODUCTION_GUIDES_SUNAT_CONTROLLERS} from './production-guides.module';
import {ProductionGuidesStore} from './production-guides-store';
import {PRODUCTION_GUIDES_SUNAT_PRIVATE_PEERS,PRODUCTION_GUIDES_GRANT_EVIDENCE,PRODUCTION_GUIDES_READINESS} from './production-guides-private';
import {NativeGreListenerLifecycle} from '@factuez/service-access';
import {PRODUCTION_NOTES_SUNAT_PROVIDERS,PRODUCTION_NOTES_SUNAT_CONTROLLERS} from './production-notes.module';
import {ProductionNotesArtifactsService} from './application/production-notes-artifacts.service';
import { FiscalRuntimeOpenApiController } from './runtime-openapi.controller';
import { ProductionPdfService, PRODUCTION_PDF_PUBLIC_CERTIFICATES } from './application/production-pdf.service';
import { PublicSignerArchive } from './infrastructure/crypto/public-signer-archive';
import { FiscalOriginalsService } from './application/fiscal-originals.service';
import { ProductionAdmissionController } from './production-admission.controller';
import { FiscalIssuanceGuard } from './auth/fiscal-issuance.guard';
import { ProductionDispatchController } from './production-dispatch.controller';
import { ProductionDispatchPolicy } from './application/production-dispatch-policy';
import { ProductionIssuanceRepository } from './application/production-issuance.repository';
import { ProductionIssuanceService } from './application/production-issuance.service';
import { Module } from "@nestjs/common";
import { DocumentIssuedConsumer } from "./application/document-issued.consumer";
import { HealthController } from "./health.controller";
import { ArtifactStore } from "./infrastructure/artifact-store";
import { PrismaService } from "./infrastructure/prisma.service";
import { StatusOutboxPublisher } from "./infrastructure/status-outbox.publisher";
import { FiscalArtifactsController } from "./fiscal-artifacts.controller";
import { ArtifactDeliveryService } from "./application/artifact-delivery.service";
import { FiscalConfigurationController } from "./fiscal-configuration.controller";
import { FiscalConfigurationService } from "./application/fiscal-configuration.service";
import { SecretVault } from "./infrastructure/crypto/secret-vault";
import { ConfigurationGuard } from "./auth/configuration.guard";
import { CertificateInspectionService } from "./infrastructure/crypto/certificate-inspection.service";
import { LocalXmlWorkerService } from "./infrastructure/crypto/local-xml-worker.service";
import { LocalXmlValidationService } from "./application/local-xml-validation.service";
import { LocalXmlValidationController } from "./local-xml-validation.controller";
import { FiscalCircuitQaService } from './application/fiscal-circuit-qa.service';
import { FiscalCircuitQaController } from './fiscal-circuit-qa.controller';
import { XsdValidationService } from './infrastructure/sunat/xsd-validation.service';
import { FiscalBatchQaService } from './application/fiscal-batch-qa.service';
import { FiscalBatchQaController } from './fiscal-batch-qa.controller';
import { BatchQaWorkerService } from './infrastructure/crypto/batch-qa-worker.service';
import { NotesQaService, NOTES_QA_PDF_RENDERER, type NotesQaPdfRenderer } from './application/notes-qa.service';
import { NotesQaRepository } from './application/notes-qa.repository';
import { NotesQaSigningService } from './application/notes-qa-signing.service';
import { NotesQaController } from './notes-qa.controller';
import { GreQaController } from './gre-qa.controller';
import { GreQaService } from './application/gre-qa.service';
import { GreQaSigningService } from './application/gre-qa-sign.service';
import { FiscalReadinessController } from './fiscal-readiness.controller';
import { FiscalReadinessService } from './application/fiscal-readiness.service';
import { CertificateTrustService } from './infrastructure/crypto/certificate-trust.service';
import { LocalEmissionWorkflowService } from './application/local-emission-workflow.service';
import { renderLocalDocumentPdf } from '@factuez/pdf-renderer';
import { BetaIssuanceService } from './application/beta-issuance.service';
import { BetaIssuanceRepository } from './application/beta-issuance.repository';
import { BetaXmlWorkerService } from './infrastructure/crypto/beta-xml-worker.service';
import { CdrSignatureTrustService } from './infrastructure/crypto/cdr-signature-trust.service';
import { NotesTransportQaService } from './application/notes-transport-qa.service';
import { BetaSupplementService } from './application/beta-supplement.service';
import { BetaSupplementRepository } from './application/beta-supplement.repository';
import { BetaFiscalPackageWorkerService } from './infrastructure/crypto/beta-fiscal-package-worker.service';
import { FiscalRulesPreviewController } from './fiscal-rules-preview.controller';
import { SupplementTrackingController } from './supplement-tracking.controller';
import { SupplementTrackingService } from './application/supplement-tracking.service';
import { BetaSupplementEvidenceConsumer } from './application/beta-supplement-evidence.consumer';
import { BetaSupplementCommandConsumer } from './application/beta-supplement-command.consumer';
import { FiscalFinancialPreviewController } from './fiscal-financial-preview.controller';
import { CurrentPdfService } from './application/current-pdf.service';

@Module({
  controllers: [ProductionGuidesAdministrationController,NativeB2bFiscalController,ProductionGuidesCatalogueController,...PRODUCTION_GUIDES_SUNAT_CONTROLLERS,...PRODUCTION_NOTES_SUNAT_CONTROLLERS, FiscalRuntimeOpenApiController, ProductionAdmissionController, ProductionDispatchController, HealthController, FiscalArtifactsController, FiscalConfigurationController, LocalXmlValidationController, FiscalCircuitQaController, FiscalBatchQaController, NotesQaController, GreQaController, FiscalReadinessController, FiscalRulesPreviewController, SupplementTrackingController, FiscalFinancialPreviewController],
  providers: [{provide:ProductionGuidesAdministration,inject:[PrismaService,FiscalConfigurationService,ProductionGuidesCatalogueAdmin,'NATIVE_GRE_ASSEMBLY'],useFactory:(db:PrismaService,fiscal:FiscalConfigurationService,catalogue:ProductionGuidesCatalogueAdmin,a:any)=>new ProductionGuidesAdministration(db,fiscal,catalogue,a.catalogueSource??(async()=>{throw Error('GRE_PRIVATE_RUNTIME_REQUIRED');}))},NativeB2bFiscalAuthority,{provide:ProductionGuidesCatalogueAdmin,inject:[PrismaService,FiscalConfigurationService,'NATIVE_GRE_ASSEMBLY'],useFactory:(db:PrismaService,fiscal:FiscalConfigurationService,a:any)=>new ProductionGuidesCatalogueAdmin(db,fiscal,a.catalogueSource??(async()=>{throw Error('GRE_PRIVATE_RUNTIME_REQUIRED');}))},{provide:'NATIVE_GRE_ASSEMBLY',inject:[PrismaService],useFactory:productionGuidesSunatHost},
    {provide:ProductionGuidesService,inject:['NATIVE_GRE_ASSEMBLY'],useFactory:(a:any)=>a.service},
    {provide:ProductionGuidesSunatRuntime,inject:['NATIVE_GRE_ASSEMBLY'],useFactory:(a:any)=>a.runtime??{}},
    {provide:PRODUCTION_GUIDES_SUNAT_PRIVATE_PEERS,inject:['NATIVE_GRE_ASSEMBLY'],useFactory:(a:any)=>a.privatePeers},
    {provide:'NATIVE_GRE_CLEANUP',inject:['NATIVE_GRE_ASSEMBLY'],useFactory:(a:any)=>({onModuleDestroy:async()=>{await a.runtime?.onModuleDestroy();a.close();}})},
{provide:ProductionGuidesStore,inject:['NATIVE_GRE_ASSEMBLY'],useFactory:(a:any)=>a.store},{provide:PRODUCTION_GUIDES_GRANT_EVIDENCE,inject:['NATIVE_GRE_ASSEMBLY'],useFactory:(a:any)=>a.grantEvidence},{provide:PRODUCTION_GUIDES_READINESS,inject:['NATIVE_GRE_ASSEMBLY'],useFactory:(a:any)=>a.readiness},
{provide:'NATIVE_GRE_LISTENER',useClass:NativeGreListenerLifecycle},
    ...PRODUCTION_NOTES_SUNAT_PROVIDERS, ProductionNotesArtifactsService,
    FiscalIssuanceGuard, ProductionDispatchPolicy, ProductionIssuanceRepository, ProductionIssuanceService,
    PrismaService,
    ArtifactStore,
    DocumentIssuedConsumer,
    StatusOutboxPublisher,
    ArtifactDeliveryService, FiscalOriginalsService, ProductionPdfService, PublicSignerArchive,
    { provide: PRODUCTION_PDF_PUBLIC_CERTIFICATES, useExisting: PublicSignerArchive },
    CurrentPdfService,
    FiscalConfigurationService,
    SecretVault,
    ConfigurationGuard,
    CertificateInspectionService,
    LocalXmlWorkerService,
    LocalXmlValidationService,
    FiscalCircuitQaService,
    LocalEmissionWorkflowService,
    XsdValidationService,
    FiscalBatchQaService, BatchQaWorkerService,
    NotesQaService, NotesQaRepository, NotesQaSigningService, NotesTransportQaService,
    { provide: NOTES_QA_PDF_RENDERER, useValue: { render: (note, format, proof) => renderLocalDocumentPdf(note, format, { digestValue: proof.digestValue, status: 'SIGNED_LOCAL' }) } satisfies NotesQaPdfRenderer },
    GreQaService, GreQaSigningService,
    FiscalReadinessService, CertificateTrustService,
    BetaIssuanceRepository, BetaIssuanceService, BetaXmlWorkerService, CdrSignatureTrustService,
    BetaSupplementRepository, BetaSupplementService, BetaFiscalPackageWorkerService,
    SupplementTrackingService, BetaSupplementEvidenceConsumer, BetaSupplementCommandConsumer,
  ],
})
export class AppModule {}
