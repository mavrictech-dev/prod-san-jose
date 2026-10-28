import {PRODUCTION_NOTES_BILLING_PROVIDERS,PRODUCTION_NOTES_BILLING_CONTROLLERS} from './production-notes.module';
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { IssueDocumentService } from './application/issue-document.service';
import { DemoBootstrapService } from './application/demo-bootstrap.service';
import { IssuanceQueryService } from './application/issuance-query.service';
import { DocumentsController } from './documents.controller';
import { StationsController } from './stations.controller';
import { StationAdminService } from './application/station-admin.service';
import { ProductAdminService } from './application/product-admin.service';
import { ProductsController } from './products.controller';
import { ClientIntakeController } from './client-intake.controller';
import { PrintSettingsController } from './print-settings.controller';
import { PrintBrandingService } from './application/print-branding.service';
import { JwtPermissionGuard } from './auth/jwt-permission.guard';
import { HealthController } from './health.controller';
import { OutboxPublisher } from './infrastructure/outbox.publisher';
import { PrismaService } from './infrastructure/prisma.service';
import { SunatStatusConsumer } from './infrastructure/sunat-status.consumer';
import { BetaSupplementCommandRepository } from './application/beta-supplement-command.repository';
import { BetaSupplementCommandService } from './application/beta-supplement-command.service';
import { FinancialLedgerCandidateRepository } from './application/financial-ledger-candidate.repository';
import { FinancialLedgerCandidateService } from './application/financial-ledger-candidate.service';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [...PRODUCTION_NOTES_BILLING_CONTROLLERS, DocumentsController, StationsController, ProductsController, ClientIntakeController, PrintSettingsController, HealthController],
  providers: [
    ...PRODUCTION_NOTES_BILLING_PROVIDERS,
    PrismaService,
    StationAdminService,
    ProductAdminService,
    PrintBrandingService,
    IssueDocumentService,
    IssuanceQueryService,
    DemoBootstrapService,
    OutboxPublisher,
    SunatStatusConsumer,
    { provide: BetaSupplementCommandRepository, inject: [PrismaService],
      useFactory: (prisma: PrismaService) => new BetaSupplementCommandRepository(prisma) },
    BetaSupplementCommandService,
    { provide: FinancialLedgerCandidateRepository, inject: [PrismaService],
      useFactory: (prisma: PrismaService) => new FinancialLedgerCandidateRepository(prisma) },
    FinancialLedgerCandidateService,
    JwtPermissionGuard,
  ],
})
export class AppModule {}
