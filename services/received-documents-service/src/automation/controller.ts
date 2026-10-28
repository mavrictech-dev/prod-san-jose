import { ReceptionProductionWorkflow } from './readiness';
import { Body, Controller, Get, Header, Headers, Patch, Post, Query } from '@nestjs/common';
import { receptionAccess } from '../access';
import { ReceptionAutomationService } from './service';
@Controller('api/v1/received-documents/automation')
export class ReceptionAutomationController {
  constructor(private readonly service: ReceptionAutomationService, private readonly workflow: ReceptionProductionWorkflow) {}
  @Get('readiness') @Header('Cache-Control', 'private, no-store') async readiness(@Headers('authorization') auth: string | undefined, @Query('companyId') companyId: string) { return this.workflow.readiness(await receptionAccess(auth, 'setup.manage'), companyId); }
  @Post('validate') async validate(@Headers('authorization') auth: string | undefined, @Query('companyId') companyId: string, @Body() body: unknown) { return this.workflow.validate(await receptionAccess(auth, 'setup.manage'), companyId, body); }
  @Post('activate') async activate(@Headers('authorization') auth: string | undefined, @Query('companyId') companyId: string, @Body() body: unknown) { return this.workflow.activate(await receptionAccess(auth, 'setup.manage'), companyId, body); }
  @Get('config') @Header('Cache-Control', 'private, no-store') async config(@Headers('authorization') auth: string | undefined, @Query('companyId') companyId: string) { return this.service.config(await receptionAccess(auth, 'setup.manage'), companyId); }
  @Patch('config') async save(@Headers('authorization') auth: string | undefined, @Query('companyId') companyId: string, @Body() body: unknown) { return this.service.save(await receptionAccess(auth, 'setup.manage'), companyId, body); }
  @Get('status') @Header('Cache-Control', 'private, no-store') async status(@Headers('authorization') auth: string | undefined, @Query('companyId') companyId: string) { return this.service.status(await receptionAccess(auth, 'setup.manage'), companyId); }
  @Get('runs') async runs(@Headers('authorization') auth: string | undefined, @Query('companyId') companyId: string) { return this.service.runs(await receptionAccess(auth, 'setup.manage'), companyId); }
  @Get('incidents') async incidents(@Headers('authorization') auth: string | undefined, @Query('companyId') companyId: string) { return this.service.incidents(await receptionAccess(auth, 'setup.manage'), companyId); }
  @Post('sync') async sync(@Headers('authorization') auth: string | undefined, @Body() body: unknown) { return this.service.queue(await receptionAccess(auth, 'setup.manage'), body); }
  @Get('discoveries') async discoveries(@Headers('authorization') auth: string | undefined, @Query() query: Record<string, unknown>) { return this.service.discoveries(await receptionAccess(auth), query); }
}
