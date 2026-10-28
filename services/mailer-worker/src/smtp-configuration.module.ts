import { Body, Controller, Get, Header, HttpException, Module, Param, Post, Query, Req } from '@nestjs/common';
import { AccessError } from '@factuez/service-access';
import { PrismaService } from './prisma.service';
import { SmtpConfigurationVault } from './smtp-configuration.crypto';
import { SmtpConfigurationStore } from './smtp-configuration.store';
import { SmtpConfigurationService } from './smtp-configuration.service';
import { PreparedCorporateSmtp } from './smtp-configuration.transport';
import { SmtpLiveDiagnostic } from './smtp-live-diagnostic';

import { CorporateMailController } from './corporate-mail.controller';
import { CorporateMailStore } from './corporate-mail.store';
import { CorporateMailHealth } from './corporate-mail.health';
import { CorporateMailSmtp } from './corporate-mail.transport';
import { CorporateMailService } from './corporate-mail.service';
import { CorporateMailWorker } from './corporate-mail.worker';

type AuthorizedRequest = { headers: { authorization?: string } };
@Controller('api/v1/mail-settings')
export class SmtpConfigurationController {
  constructor(private readonly service: SmtpConfigurationService) {}
  private async run<T>(action: () => Promise<T>) {
    try { return await action(); }
    catch (error) { if (error instanceof AccessError) throw new HttpException(error.message, error.status); throw new HttpException('Configuración SMTP no disponible', 503); }
  }
  @Get(':companyId') @Header('Cache-Control', 'private, no-store')
  status(@Param('companyId') companyId: string, @Req() req: AuthorizedRequest) {
    return this.run(() => this.service.status(companyId, req.headers.authorization ?? ''));
  }
  @Post(':companyId') @Header('Cache-Control', 'private, no-store')
  save(@Param('companyId') companyId: string, @Body() body: unknown, @Req() req: AuthorizedRequest) {
    return this.run(() => this.service.save(companyId, body, req.headers.authorization ?? ''));
  }
  @Post(':companyId/remove') @Header('Cache-Control', 'private, no-store')
  remove(@Param('companyId') companyId: string, @Body() body: unknown, @Req() req: AuthorizedRequest) {
    return this.run(() => this.service.remove(companyId, body, req.headers.authorization ?? ''));
  }
  @Get(':companyId/audit') @Header('Cache-Control', 'private, no-store')
  audit(@Param('companyId') companyId: string, @Query('page') page: string | undefined, @Req() req: AuthorizedRequest) {
    return this.run(() => this.service.audit(companyId, req.headers.authorization ?? '', page));
  }
  @Post(':companyId/verify-connection') @Header('Cache-Control', 'private, no-store')
  verifyConnection(@Param('companyId') companyId: string, @Body() body: unknown, @Req() req: AuthorizedRequest) {
    return this.run(() => this.service.verifyConnection(companyId, body, req.headers.authorization ?? ''));
  }
  @Post(':companyId/dry-run') @Header('Cache-Control', 'private, no-store')
  dryRun(@Param('companyId') companyId: string, @Body() body: unknown, @Req() req: AuthorizedRequest) {
    return this.run(() => this.service.dryRun(companyId, body, req.headers.authorization ?? ''));
  }
}

@Module({ controllers: [SmtpConfigurationController, CorporateMailController], providers: [PrismaService, SmtpConfigurationStore,
  SmtpConfigurationVault, PreparedCorporateSmtp, { provide: SmtpLiveDiagnostic, useFactory: () => new SmtpLiveDiagnostic() }, SmtpConfigurationService, CorporateMailStore, CorporateMailHealth,
  { provide: CorporateMailSmtp, useFactory: () => new CorporateMailSmtp() }, CorporateMailService, CorporateMailWorker] })
export class SmtpConfigurationModule {}
