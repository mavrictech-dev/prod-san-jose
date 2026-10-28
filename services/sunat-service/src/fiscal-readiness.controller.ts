import { Body, Controller, Get, Header, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ConfigurationGuard, type ConfigurationRequest } from './auth/configuration.guard';
import { FiscalReadinessService } from './application/fiscal-readiness.service';

@Controller('api/v1/setup/sunat')
@UseGuards(ConfigurationGuard)
export class FiscalReadinessController {
  constructor(private readonly readiness: FiscalReadinessService) {}
  @Get(':companyId/:environment/readiness')
  @Header('Cache-Control', 'private, no-store')
  inspect(@Param('companyId') companyId: string, @Param('environment') environment: string, @Req() request: ConfigurationRequest) {
    return this.readiness.inspect(companyId, environment, request.headers.authorization!);
  }
  @Post(':companyId/:environment/readiness/validate')
  @Header('Cache-Control', 'private, no-store')
  validate(@Param('companyId') companyId: string, @Param('environment') environment: string, @Body() body: unknown, @Req() request: ConfigurationRequest) {
    return this.readiness.validate(companyId, environment, body, request.headers.authorization!);
  }
}
