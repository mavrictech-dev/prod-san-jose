import { Controller, Get, Post, Param, Body, Req, Header, UseGuards, StreamableFile } from '@nestjs/common';
import { ConfigurationGuard, type ConfigurationRequest } from './auth/configuration.guard';
import { FiscalBatchQaService } from './application/fiscal-batch-qa.service';
@Controller('api/v1/fiscal-batch-qa')
@UseGuards(ConfigurationGuard)
export class FiscalBatchQaController {
  constructor(private readonly service:FiscalBatchQaService){}
  @Get() @Header('Cache-Control','private, no-store') list(@Req()req:ConfigurationRequest){return this.service.list(req.headers.authorization);}
  @Post() @Header('Cache-Control','private, no-store') start(@Body()body:unknown,@Req()req:ConfigurationRequest & {headers:{'idempotency-key'?:string}}){return this.service.start(body,req.headers['idempotency-key'],req.user!.sub,req.headers.authorization);}
  @Get(':id') @Header('Cache-Control','private, no-store') status(@Param('id')id:string,@Req()req:ConfigurationRequest){return this.service.status(id,req.headers.authorization);}
  @Get(':id/:format') @Header('Cache-Control','private, no-store') @Header('X-Content-Type-Options','nosniff')
  async download(@Param('id')id:string,@Param('format')format:string,@Req()req:ConfigurationRequest){const r=await this.service.download(id,format,req.headers.authorization);return new StreamableFile(r.bytes,{type:r.mediaType,disposition:`attachment; filename="${r.fileName}"`,length:r.bytes.length});}
}
