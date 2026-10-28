import { ReceptionProductionWorkflow } from './automation/readiness';
import { Module, Controller, Get } from '@nestjs/common';
import { ReceptionPrisma } from './prisma.service';
import { ReceptionService } from './reception.service';
import { ReceivedController } from './received.controller';
import { ReceptionAutomationController } from './automation/controller';
import { ReceptionAutomationService } from './automation/service';
@Controller('health')
class HealthController {
  constructor(private readonly db: ReceptionPrisma) {}
  @Get() async health() { await this.db.$queryRaw`SELECT 1`; return { status: 'ok', mode: 'LOCAL_BETA_RECEPTION', officialTransmission: false }; }
}
@Module({ controllers: [ReceptionAutomationController, ReceivedController, HealthController], providers: [ReceptionPrisma, ReceptionService, ReceptionAutomationService, ReceptionProductionWorkflow] })
export class AppModule {}
