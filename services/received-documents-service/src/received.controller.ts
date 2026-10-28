import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Res, type OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AccessError } from '@factuez/service-access';
import { PdfPreviewCache } from '@factuez/pdf-renderer';
import { receptionAccess } from './access';
import { ReceptionService } from './reception.service';
import { receivedReadingPdf, receivedWorkbook } from './exports';
import { ReceivedLivePublisher } from './automation/live';

type DownloadResponse = { setHeader(name: string, value: string): void; end(bytes: Buffer): void };
export function sendOriginal(res: DownloadResponse, bytes: Uint8Array, media: string, fileName: string) {
  res.setHeader('Content-Type', media);
  res.setHeader('Content-Disposition', `attachment; filename="documento${media.includes('pdf') ? '.pdf' : media.includes('sheet') ? '.xlsx' : media.includes('zip') ? '.zip' : '.xml'}"; filename*=UTF-8''${encodeURIComponent(fileName).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16))}`);
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.end(Buffer.from(bytes));
}
@Controller('api/v1/received-documents')
export class ReceivedController implements OnModuleDestroy {
  private readonly pdfCache = new PdfPreviewCache();
  private readonly live = new ReceivedLivePublisher();
  constructor(private readonly reception: ReceptionService) {}
  async onModuleDestroy() { this.pdfCache.close(); await this.live.close(); }
  @Get() async list(@Headers('authorization') auth: string | undefined, @Query() query: Record<string, unknown>) { return this.reception.list(await receptionAccess(auth), query); }
  @Post() async import(@Headers('authorization') auth: string | undefined, @Body() body: unknown) { return this.reception.import(await receptionAccess(auth, 'setup.manage'), body); }
  @Get('export.xlsx') async export(@Headers('authorization') auth: string | undefined, @Query() query: Record<string, unknown>, @Res() res: DownloadResponse) {
    const rows = await this.reception.exportRows(await receptionAccess(auth, 'report.export'), query);
    sendOriginal(res, await receivedWorkbook(rows), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'documentos-recibidos.xlsx');
  }
  @Get(':id') async detail(@Headers('authorization') auth: string | undefined, @Param('id') id: string) { return this.reception.detail(await receptionAccess(auth), id); }
  @Get(':id/pdf') async pdf(@Headers('authorization') auth: string | undefined, @Param('id') id: string, @Res() res: DownloadResponse) {
    // Reauthorize every download, including cache hits. The rendering version invalidates prior templates.
    const detail = await this.reception.detail(await receptionAccess(auth, 'report.export'), id);
    const key = createHash('sha256').update(JSON.stringify(['received-reading-v1', detail.id, detail.projection])).digest('hex');
    let bytes: Buffer;
    try { bytes = await this.pdfCache.getOrRender(key, () => receivedReadingPdf(detail)); }
    catch { throw new AccessError(503, 'PDF no disponible temporalmente; reintente'); }
    sendOriginal(res, bytes, 'application/pdf', `${detail.fullNumber}-lectura-no-fiscal.pdf`);
  }
  @Get(':id/artifacts/:artifactId') async artifact(@Headers('authorization') auth: string | undefined, @Param('id') id: string, @Param('artifactId') artifactId: string, @Res() res: DownloadResponse) {
    const file = await this.reception.artifact(await receptionAccess(auth, 'report.export'), id, artifactId);
    sendOriginal(res, file.bytes, file.kind === 'PROVIDER_PDF' ? 'application/pdf' : /\.zip$/i.test(file.fileName) ? 'application/zip' : 'application/xml', file.fileName);
  }
  @Post(':id/artifacts') async attach(@Headers('authorization') auth: string | undefined, @Param('id') id: string, @Body() body: unknown) { return this.reception.attach(await receptionAccess(auth, 'setup.manage'), id, body); }
  @Patch(':id/registration') async registration(@Headers('authorization') auth: string | undefined, @Param('id') id: string, @Body() body: unknown) { return this.reception.registration(await receptionAccess(auth, 'setup.manage'), id, body); }
  @Patch(':id/assignment') async assignment(@Headers('authorization') auth: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    const result = await this.reception.assignment(await receptionAccess(auth, 'setup.manage'), id, body);
    await this.live.changed(id); return result;
  }
}
