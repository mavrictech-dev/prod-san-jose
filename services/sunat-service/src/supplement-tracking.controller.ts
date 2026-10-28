import { Controller, Get, Header, Headers, Param } from '@nestjs/common';
import { SupplementTrackingService } from './application/supplement-tracking.service';
@Controller('api/v1/fiscal-evidence')
export class SupplementTrackingController {
  constructor(private readonly tracking: SupplementTrackingService) {}
  @Get(':documentId')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  list(@Param('documentId') id: string, @Headers('authorization') authorization?: string) {
    return this.tracking.list(id, authorization);
  }
}
