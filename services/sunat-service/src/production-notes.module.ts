import { Module } from '@nestjs/common';
import { PrismaService } from './infrastructure/prisma.service';
import { ArtifactStore } from './infrastructure/artifact-store';
import { SecretVault } from './infrastructure/crypto/secret-vault';
import { CertificateInspectionService } from './infrastructure/crypto/certificate-inspection.service';
import { CertificateTrustService } from './infrastructure/crypto/certificate-trust.service';
import { PublicSignerArchive } from './infrastructure/crypto/public-signer-archive';
import { CdrSignatureTrustService } from './infrastructure/crypto/cdr-signature-trust.service';
import { XsdValidationService } from './infrastructure/sunat/xsd-validation.service';
import { FiscalConfigurationService } from './application/fiscal-configuration.service';
import { FiscalReadinessService } from './application/fiscal-readiness.service';
import { ConfigurationGuard } from './auth/configuration.guard';
import { FiscalIssuanceGuard } from './auth/fiscal-issuance.guard';
import { ProductionNotesArtifactsService } from './application/production-notes-artifacts.service';
import { CurrentPdfService } from './application/current-pdf.service';
import { ProductionNotesController } from './production-notes.controller';
import { ProductionNotesPolicyService } from './application/production-notes-policy.service';
import { ProductionNotesEvidenceService } from './application/production-notes-evidence.service';
import { ProductionNotesDispatchRepository } from './application/production-notes-dispatch.repository';
import { ProductionNotesDispatchService } from './application/production-notes-dispatch.service';
import { ProductionNotesSunatRuntime } from './application/production-notes-runtime.service';
export const PRODUCTION_NOTES_SUNAT_PROVIDERS = [ProductionNotesPolicyService, ProductionNotesEvidenceService, ProductionNotesDispatchRepository, ProductionNotesDispatchService, ProductionNotesSunatRuntime, ProductionNotesArtifactsService];
export const PRODUCTION_NOTES_SUNAT_CONTROLLERS = [ProductionNotesController];
@Module({ controllers: PRODUCTION_NOTES_SUNAT_CONTROLLERS, providers: [PrismaService, ArtifactStore, CurrentPdfService, SecretVault, CertificateInspectionService, CertificateTrustService, PublicSignerArchive, CdrSignatureTrustService, XsdValidationService, FiscalConfigurationService, FiscalReadinessService, ConfigurationGuard, FiscalIssuanceGuard, ...PRODUCTION_NOTES_SUNAT_PROVIDERS], exports: PRODUCTION_NOTES_SUNAT_PROVIDERS })
export class ProductionNotesSunatModule {
}
