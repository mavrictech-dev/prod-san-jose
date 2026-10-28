import { BadRequestException, Body, Controller, Header, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { FiscalIssuanceGuard } from './auth/fiscal-issuance.guard';
import type { ConfigurationRequest } from './auth/configuration.guard';
import { ProductionDispatchPolicy } from './application/production-dispatch-policy';
@Controller('api/v1/setup/sunat')
@UseGuards(FiscalIssuanceGuard)
export class ProductionAdmissionController {
  constructor(private readonly policy: ProductionDispatchPolicy) {}
  @Post(':companyId/PRODUCTION/admission')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  admit(@Param('companyId') companyId: string, @Body() body: unknown, @Req() request: ConfigurationRequest) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join(',') !== 'snapshot') throw new BadRequestException('Envíe únicamente el snapshot');
    return this.policy.admit(companyId, (body as { snapshot: unknown }).snapshot, request.headers.authorization!);
  }
}
