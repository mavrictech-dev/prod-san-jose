import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../infrastructure/prisma.service';
import { AuthService } from '../application/auth.service';
import { PasswordService } from '../application/password.service';
import { BrowserSessionStore } from '../application/browser-session.store';
import { IntegrationIdentity } from './service';
import { IntegrationTokenCodec } from './token';
import { PostgresIntegrationStore, type TransactionalSql } from './postgres-store';
import { IntegrationErrorFilter, IntegrationIdentityModule } from './http';
import { HumanIntegrationAdministrator, HttpsBillingCatalogue, integrationRuntimeConfig } from './runtime';

/** Separate opt-in executable. No normal AppModule, RBAC seed, migrations or emission providers. */
export async function bootstrapIntegration() {
  const config = integrationRuntimeConfig(process.env);
  if (!config) return; // Disabled means no key read, socket, Redis or DB connection.
  const codec = new IntegrationTokenCodec(config.signingKey, config.issuer);
  const db = new PrismaService();
  const sessions = new BrowserSessionStore();
  let app: NestExpressApplication | undefined;
  try {
    await db.$connect();
    const store = new PostgresIntegrationStore(db as unknown as TransactionalSql);
    await store.ready();
    const core = new IntegrationIdentity(store, codec, config.pepper,
      new HumanIntegrationAdministrator(new AuthService(db, new PasswordService(), sessions)),
      new HttpsBillingCatalogue(config.billingOrigin, config.billingTransport));
    const tls = { cert: config.cert, key: config.key, ca: config.ca,
      requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' as const };
    app = await NestFactory.create<NestExpressApplication>(IntegrationIdentityModule.isolated(core, config.peers), {
      logger: false, bodyParser: false, httpsOptions: tls,
    });
    app.useBodyParser('json', { limit: '32kb', strict: true });
    app.useBodyParser('urlencoded', { limit: '2kb', extended: false, parameterLimit: 4 });
    app.useGlobalFilters(new IntegrationErrorFilter());
    await app.listen(config.port, '127.0.0.1');
    const close = async () => { await app?.close(); sessions.onApplicationShutdown(); await db.$disconnect(); };
    process.once('SIGTERM', () => { void close(); });
    process.once('SIGINT', () => { void close(); });
  } catch {
    await app?.close(); sessions.onApplicationShutdown(); await db.$disconnect();
    throw new Error('Integration startup failed; disabled without fallback');
  }
}
if (require.main === module) void bootstrapIntegration().catch(() => { process.exitCode = 1; });
