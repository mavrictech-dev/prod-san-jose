import { Controller, Get, Post, Param, Body, Req, Header, UseGuards, StreamableFile, BadRequestException } from '@nestjs/common';
import { ConfigurationGuard, type ConfigurationRequest } from './auth/configuration.guard';
import { FiscalCircuitQaService } from './application/fiscal-circuit-qa.service';
import { LocalEmissionWorkflowService } from './application/local-emission-workflow.service';
@Controller('api/v1/fiscal-circuit-qa')
@UseGuards(ConfigurationGuard)
export class FiscalCircuitQaController {
  constructor(private readonly service: FiscalCircuitQaService, private readonly workflow: LocalEmissionWorkflowService) {}
  @Post(':documentId/workflow') @Header('Cache-Control', 'private, no-store')
  workflowStart(@Param('documentId') id: string, @Body() body: unknown, @Req() req: ConfigurationRequest) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new BadRequestException('El flujo local no admite ambiente, credenciales ni escenario del cliente');
    return this.workflow.run(id, req.user!.sub, req.headers.authorization);
  }
  @Get(':documentId') @Header('Cache-Control', 'private, no-store')
  status(@Param('documentId') id: string, @Req() req: ConfigurationRequest) { return this.service.status(id, req.headers.authorization); }
  @Post(':documentId') @Header('Cache-Control', 'private, no-store')
  start(@Param('documentId') id: string, @Body() body: { scenario?: unknown }, @Req() req: ConfigurationRequest) { return this.service.start(id, req.user!.sub, body?.scenario, req.headers.authorization); }
  @Get(':documentId/:format') @Header('Cache-Control', 'private, no-store') @Header('X-Content-Type-Options', 'nosniff')
  async download(@Param('documentId') id: string, @Param('format') format: string, @Req() req: ConfigurationRequest) {
    const result = await this.service.download(id, format, req.headers.authorization);
    return new StreamableFile(result.bytes, { type: result.mediaType, disposition: `attachment; filename="${result.fileName}"`, length: result.bytes.length });
  }
}
