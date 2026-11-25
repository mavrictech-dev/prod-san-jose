import {startNativeGreListener} from '@factuez/service-access';
import 'reflect-metadata';
import {ApiProblemFilter} from '@factuez/service-access/dist/api-problem.filter';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
async function bootstrap() {
  if (process.env.B2B_SUNAT_RUNTIME_ENABLED === 'true') {
    const { bootstrapB2bSunatHost } = await import('./b2b/main');
    // Full owner bindings must be supplied by the deployment composition. Missing
    // actual authority/lifecycle ports is fatal; never start a partial or legacy fallback.
    await bootstrapB2bSunatHost({ enabled: true, configRoot: process.env.B2B_SUNAT_CONFIG_ROOT });
    return;
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.useGlobalFilters(new ApiProblemFilter());
  // JSON con PKCS#12 base64, acotado también por Kong. Nunca logging de bodies.
  app.useBodyParser('json', { limit: '768kb' });
  app.enableShutdownHooks();
  await app.init();
  await startNativeGreListener(app);
  await app.listen(Number(process.env.PORT ?? 3003), '0.0.0.0');
}
void bootstrap();
