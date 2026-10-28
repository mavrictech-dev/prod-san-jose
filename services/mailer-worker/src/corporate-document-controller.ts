import { Body, Controller, Get, Header, HttpException, Inject, Param, Post, Req } from '@nestjs/common';
import { AccessError } from '@factuez/service-access';
import { CorporateDocumentService } from './corporate-document-service';
type Request = { headers: { authorization?: string; 'idempotency-key'?: string } };
@Controller('api/v1/mail-settings')
export class CorporateDocumentController {
  constructor(@Inject(CorporateDocumentService) private readonly service: CorporateDocumentService) {}
  private async run<T>(action: () => Promise<T>) {
    try { return await action(); } catch (error) {
      if (error instanceof AccessError) throw new HttpException(error.message, error.status);
      throw new HttpException('Correo documental no disponible', 503);
    }
  }
  @Get(':companyId/documents/:documentId') @Header('Cache-Control', 'private, no-store')
  status(@Param('companyId') companyId: string, @Param('documentId') documentId: string, @Req() req: Request) {
    return this.run(() => this.service.status(companyId, documentId, req.headers.authorization ?? ''));
  }
  @Post(':companyId/document-activation') @Header('Cache-Control', 'private, no-store')
  activate(@Param('companyId') companyId: string, @Body() body: unknown, @Req() req: Request) {
    return this.run(() => this.service.activate(companyId, body, req.headers.authorization ?? ''));
  }
  @Post(':companyId/send-document') @Header('Cache-Control', 'private, no-store')
  enqueue(@Param('companyId') companyId: string, @Body() body: unknown, @Req() req: Request) {
    return this.run(() => this.service.enqueue(companyId, body, req.headers['idempotency-key'], req.headers.authorization ?? ''));
  }
}
