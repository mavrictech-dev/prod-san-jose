import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { SmtpConfigurationStore } from './smtp-configuration.store';
import { SmtpConfigurationVault } from './smtp-configuration.crypto';
import { PreparedCorporateSmtp } from './smtp-configuration.transport';
import { SmtpLiveDiagnostic } from './smtp-live-diagnostic';
import { SmtpConfigurationService } from './smtp-configuration.service';
import { CorporateDocumentController } from './corporate-document-controller';
import { CorporateDocumentService } from './corporate-document-service';
import { CorporateDocumentStore } from './corporate-document-store';
import { CorporateDocumentSource } from './corporate-document-source';
import { CorporateDocumentSmtp } from './corporate-document-transport';
import { CorporateDocumentHealth } from './corporate-document-health';
import { CorporateDocumentWorker } from './corporate-document-worker';
/** Main imports this module explicitly. No registration or enablement at import time. */
export const CORPORATE_DOCUMENT_CONTROLLERS = [CorporateDocumentController];
export const CORPORATE_DOCUMENT_PROVIDERS = [PrismaService,
  { provide: SmtpConfigurationStore, useFactory: (db: PrismaService) => new SmtpConfigurationStore(db), inject: [PrismaService] },
  SmtpConfigurationVault, PreparedCorporateSmtp,
  { provide: SmtpLiveDiagnostic, useFactory: () => new SmtpLiveDiagnostic() },
  { provide: SmtpConfigurationService, useFactory: (store: SmtpConfigurationStore, vault: SmtpConfigurationVault, transport: PreparedCorporateSmtp, diagnostic: SmtpLiveDiagnostic) =>
    new SmtpConfigurationService(store, vault, transport, diagnostic), inject: [SmtpConfigurationStore, SmtpConfigurationVault, PreparedCorporateSmtp, SmtpLiveDiagnostic] },
  { provide: CorporateDocumentStore, useFactory: (db: PrismaService) => new CorporateDocumentStore(db), inject: [PrismaService] },
  CorporateDocumentHealth,
  { provide: CorporateDocumentSource, useFactory: () => new CorporateDocumentSource() },
  { provide: CorporateDocumentSmtp, useFactory: () => new CorporateDocumentSmtp() },
  { provide: CorporateDocumentService, useFactory: (settings: SmtpConfigurationService, store: CorporateDocumentStore, vault: SmtpConfigurationVault,
      health: CorporateDocumentHealth, smtp: CorporateDocumentSmtp, source: CorporateDocumentSource) =>
    new CorporateDocumentService(settings, store, vault, health, smtp, source),
    inject: [SmtpConfigurationService, CorporateDocumentStore, SmtpConfigurationVault, CorporateDocumentHealth, CorporateDocumentSmtp, CorporateDocumentSource] },
  { provide: CorporateDocumentWorker, useFactory: (store: CorporateDocumentStore, service: CorporateDocumentService, health: CorporateDocumentHealth) =>
    new CorporateDocumentWorker(store, service, health), inject: [CorporateDocumentStore, CorporateDocumentService, CorporateDocumentHealth] }];
@Module({ controllers: CORPORATE_DOCUMENT_CONTROLLERS, providers: CORPORATE_DOCUMENT_PROVIDERS })
export class CorporateDocumentModule {}
