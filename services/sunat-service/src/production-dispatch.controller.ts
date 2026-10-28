import { Body, Controller, Get, Header, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ConfigurationGuard, type ConfigurationRequest } from './auth/configuration.guard';
import { ProductionDispatchPolicy } from './application/production-dispatch-policy';
@Controller('api/v1/setup/sunat')
@UseGuards(ConfigurationGuard)
export class ProductionDispatchController {
  constructor(private readonly policy: ProductionDispatchPolicy) {}
  @Get(':companyId/:environment/dispatch')
  @Header('Cache-Control', 'private, no-store')
  status(@Param('companyId') companyId: string, @Param('environment') environment: string, @Req() request: ConfigurationRequest) {
    return this.policy.status(companyId, environment, request.headers.authorization!);
  }
  @Post(':companyId/:environment/dispatch')
  @Header('Cache-Control', 'private, no-store')
  configure(@Param('companyId') companyId: string, @Param('environment') environment: string, @Body() input: unknown, @Req() request: ConfigurationRequest) {
    return this.policy.configure(companyId, environment, input, request.headers.authorization!, request.user!.sub);
  }
}
