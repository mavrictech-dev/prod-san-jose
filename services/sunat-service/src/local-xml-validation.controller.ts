import { Controller, Get, Post, Param, Req, UseGuards, Header, StreamableFile } from '@nestjs/common';
import { ConfigurationGuard, type ConfigurationRequest } from './auth/configuration.guard';
import { LocalXmlValidationService } from './application/local-xml-validation.service';

@Controller('api/v1/local-xml-validation')
@UseGuards(ConfigurationGuard)
export class LocalXmlValidationController {
  constructor(private readonly service: LocalXmlValidationService) {}
  @Get(':documentId')
  @Header('Cache-Control', 'private, no-store')
  status(@Param('documentId') id: string, @Req() request: ConfigurationRequest) {
    return this.service.status(id, request.headers.authorization);
  }
  @Post(':documentId')
  @Header('Cache-Control', 'private, no-store')
  prepare(@Param('documentId') id: string, @Req() request: ConfigurationRequest) {
    return this.service.prepare(id, request.user!.sub, request.headers.authorization);
  }
  @Get(':documentId/zip')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async download(@Param('documentId') id: string, @Req() request: ConfigurationRequest) {
    const result = await this.service.download(id, request.headers.authorization);
    return new StreamableFile(result.bytes, { type: 'application/zip', disposition: `attachment; filename="${result.fileName}"`, length: result.bytes.length });
  }
}
