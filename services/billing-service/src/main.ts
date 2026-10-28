import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import type { NestExpressApplication } from '@nestjs/platform-express';

async function bootstrap() {
  if (process.env.BILLING_B2B_STANDALONE === 'true') {
    const { bootstrapBillingB2b, reportBillingHostStartupFailure } = await import('./b2b/main');
    await bootstrapBillingB2b().catch(reportBillingHostStartupFailure);
    return;
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Logo original <=256 KB codificado en base64; DTOs siguen acotados por campo.
  app.useBodyParser('json', { limit: '512kb' });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3002), '0.0.0.0');
}

void bootstrap();
