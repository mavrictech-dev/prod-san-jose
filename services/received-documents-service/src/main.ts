import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { AccessError } from '@factuez/service-access';
import { AppModule } from './app.module';
@Catch()
class SafeErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const status = error instanceof AccessError ? error.status : error instanceof HttpException ? error.getStatus() : 500;
    host.switchToHttp().getResponse().status(status).json({ message: error instanceof AccessError ? error.message : status === 413 ? 'Carga demasiado grande' : status < 500 ? 'Solicitud inválida' : 'Recepción no disponible temporalmente' });
  }
}
async function bootstrap() {
  if (process.env.B2B_RECEIVED_ENABLED === 'true') {
    const { bootstrapB2bReceivedOwner } = await import('./b2b/main');
    await bootstrapB2bReceivedOwner(); return;
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.useBodyParser('json', { limit: '18mb' });
  app.useGlobalFilters(new SafeErrorFilter()); app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3006), '0.0.0.0');
}
void bootstrap();
