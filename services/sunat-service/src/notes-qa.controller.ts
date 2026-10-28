import { Body, Controller, Get, Header, Param, Post, Req, StreamableFile } from '@nestjs/common';
import { NotesQaService } from './application/notes-qa.service';

type NotesQaRequest = { headers: { authorization?: string } };
/** Cada método del servicio verifica identidad activa + ADMIN GLOBAL + Billing autorizado. */
@Controller('api/v1/notes-qa')
export class NotesQaController {
  constructor(private readonly service: NotesQaService) {}
  @Get('reference/:documentId') @Header('Cache-Control', 'private, no-store')
  list(@Param('documentId') id: string, @Req() request: NotesQaRequest) { return this.service.list(id, request.headers.authorization); }
  @Post('reference/:documentId') @Header('Cache-Control', 'private, no-store')
  create(@Param('documentId') id: string, @Body() body: unknown, @Req() request: NotesQaRequest) { return this.service.create(id, body, request.headers.authorization); }
  @Get(':id') @Header('Cache-Control', 'private, no-store')
  detail(@Param('id') id: string, @Req() request: NotesQaRequest) { return this.service.detail(id, request.headers.authorization); }
  @Post(':id/transport') @Header('Cache-Control', 'private, no-store')
  enqueueTransport(@Param('id') id: string, @Body() body: unknown, @Req() request: NotesQaRequest) { return this.service.enqueueTransport(id, body, request.headers.authorization); }
  @Get(':id/:format') @Header('Cache-Control', 'private, no-store') @Header('X-Content-Type-Options', 'nosniff')
  async download(@Param('id') id: string, @Param('format') format: string, @Req() request: NotesQaRequest) {
    const result = await this.service.download(id, format, request.headers.authorization);
    return new StreamableFile(result.bytes, { type: result.mediaType, disposition: `attachment; filename="${result.fileName}"`, length: result.bytes.length });
  }
}
