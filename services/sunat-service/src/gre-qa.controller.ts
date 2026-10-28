import { Body, Controller, Get, Post, Param, Query, Headers, Header, StreamableFile, HttpException } from '@nestjs/common';
import { AccessError } from '@factuez/service-access';
import { GreQaService } from './application/gre-qa.service';
/** Toda operación revalida Identity y el catálogo Billing en el caso de uso. */
@Controller('api/v1/gre-qa')
export class GreQaController {
  constructor(private readonly gre: GreQaService) {}
  private async call<T>(operation: () => Promise<T>) { try { return await operation(); } catch (e) { if (e instanceof AccessError) throw new HttpException(e.message,e.status); throw e; } }
  @Get('capabilities') @Header('Cache-Control','private, no-store')
  capabilities(@Headers('authorization') auth?: string) { return this.call(() => this.gre.capabilities(auth)); }
  @Get() @Header('Cache-Control','private, no-store')
  list(@Headers('authorization') auth?: string, @Query('companyId') company?: string) { return this.call(() => this.gre.list(auth,company)); }
  @Post() @Header('Cache-Control','private, no-store')
  prepare(@Body() input: unknown, @Headers('idempotency-key') key?: string, @Headers('authorization') auth?: string) { return this.call(() => this.gre.prepare(input,key,auth)); }
  @Get(':id') @Header('Cache-Control','private, no-store')
  detail(@Param('id') id: string, @Headers('authorization') auth?: string) { return this.call(() => this.gre.detail(id,auth)); }
  @Post(':id/simulate') @Header('Cache-Control','private, no-store')
  simulate(@Param('id') id: string, @Body() input: { scenario?: unknown }, @Headers('authorization') auth?: string) { return this.call(() => this.gre.simulate(id,input?.scenario,auth)); }
  @Get(':id/artifacts/:format') @Header('Cache-Control','private, no-store') @Header('X-Content-Type-Options','nosniff')
  async download(@Param('id') id: string, @Param('format') format: string, @Headers('authorization') auth?: string) {
    const r = await this.call(() => this.gre.download(id,format,auth));
    return new StreamableFile(r.bytes,{type:r.mediaType,disposition:`attachment; filename="${r.fileName}"`,length:r.bytes.length});
  }
}
