import { BadRequestException, Body, Controller, Header, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ConfigurationGuard } from './auth/configuration.guard';
import { financialDemo, FINANCIAL_DEMO_SCENARIOS } from './application/fiscal-financial-demo';
import { boundedSupplementJson } from '@factuez/sunat-core/dist/fiscal-supplement-command';
@Controller('api/v1/fiscal-rules')
@UseGuards(ConfigurationGuard)
export class FiscalFinancialPreviewController {
  @Post('financial-ledger-preview')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  preview(@Body() body: unknown) {
    try {
      body = boundedSupplementJson(body);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 ||
          !Object.hasOwn(body, 'scenario') || !FINANCIAL_DEMO_SCENARIOS.includes((body as any).scenario)) throw new Error();
      return financialDemo((body as any).scenario);
    } catch { throw new BadRequestException('Seleccione un escenario ficticio de conciliación BETA; no se admiten datos de emisores, evidencia o producción.'); }
  }
}
