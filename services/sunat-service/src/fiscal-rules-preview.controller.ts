import { BadRequestException, Body, Controller, Header, HttpCode, Post, UseGuards } from '@nestjs/common';
import { calculateSaleAdjustments, SaleAdjustmentError, type SaleAdjustmentsInput } from '@factuez/sunat-core';
import { ConfigurationGuard } from './auth/configuration.guard';

/** Stateless preview. Registration in AppModule is deliberately left to the caller. */
@Controller('api/v1/fiscal-rules')
@UseGuards(ConfigurationGuard)
export class FiscalRulesPreviewController {
  @Post('preview')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  preview(@Body() body: unknown) {
    try {
      const calculation = calculateSaleAdjustments(body as SaleAdjustmentsInput);
      return {
        profile: 'SALE_ADJUSTMENTS_BETA_V1' as const,
        source: {
          documentation: 'docs/REGLAS_AJUSTES_BETA.md',
          primaryUrls: [
            'https://www.sunat.gob.pe/legislacion/superin/2019/anexo-244-2019.pdf',
            'https://orientacion.sunat.gob.pe/apendices-del-sistema-de-detracciones',
          ],
        },
        localOnly: true as const,
        transmissionAuthorized: false as const,
        calculation,
      };
    } catch (error) {
      // Never expose exception text, supplied values, stack, paths from private I/O,
      // or nested cause. Known calculation paths/codes contain only schema metadata.
      throw new BadRequestException({
        message: 'Datos inválidos para la vista previa fiscal BETA.',
        code: error instanceof SaleAdjustmentError ? error.code : 'PREVIEW_INVALID',
        ...(error instanceof SaleAdjustmentError ? { field: error.path } : {}),
      });
    }
  }
}
