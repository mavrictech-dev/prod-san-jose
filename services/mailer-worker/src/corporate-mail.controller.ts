import { Body, Controller, Get, Header, HttpException, Param, Post, Req } from '@nestjs/common';
import { AccessError } from '@factuez/service-access';
import { CorporateMailService } from './corporate-mail.service';
type Request = { headers: { authorization?: string; 'idempotency-key'?: string } };
@Controller('api/v1/mail-settings')
export class CorporateMailController {
  constructor(private readonly service: CorporateMailService) {}
  private async run<T>(action: () => Promise<T>) {
    try { return await action(); } catch (error) {
      if (error instanceof AccessError) throw new HttpException(error.message, error.status);
      throw new HttpException('Correo corporativo no disponible', 503);
    }
  }
  @Get(':companyId/corporate') @Header('Cache-Control', 'private, no-store')
  status(@Param('companyId') companyId: string, @Req() req: Request) {
    return this.run(() => this.service.status(companyId, req.headers.authorization ?? ''));
  }
  @Post(':companyId/activation') @Header('Cache-Control', 'private, no-store')
  activate(@Param('companyId') companyId: string, @Body() body: unknown, @Req() req: Request) {
    return this.run(() => this.service.activate(companyId, body, req.headers.authorization ?? ''));
  }
  @Post(':companyId/send-test') @Header('Cache-Control', 'private, no-store')
  sendTest(@Param('companyId') companyId: string, @Body() body: unknown, @Req() req: Request) {
    return this.run(() => this.service.sendTest(companyId, body, req.headers['idempotency-key'], req.headers.authorization ?? ''));
  }
}
