import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infrastructure/prisma.service';
import { BetaIssuanceRepository } from './beta-issuance.repository';
/** Separate durable namespace; no Beta row, counter or archive can be reused. */
@Injectable()
export class ProductionIssuanceRepository extends BetaIssuanceRepository {
  protected readonly environment = 'PRODUCTION' as const;
  constructor(prisma: PrismaService) { super(prisma); }
}
