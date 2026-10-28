import { Body, Controller, Inject, Module, Post, Req, Res, UseFilters, type CanActivate, type DynamicModule } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { b2bPrivatePeer } from '@factuez/service-access/dist/b2b';
import { B2bContextFilter } from './http';
import type { GuideGoods } from './guide-goods';
import type { BillingB2bRuntime } from './runtime';
import { BillingRuntimeLifecycle } from './runtime-lifecycle';

const GOODS = Symbol('Billing runtime goods'), PEERS = Symbol('Billing runtime goods peers');
class RuntimeAdmissionGuard implements CanActivate {
  constructor(private readonly lifecycle: BillingRuntimeLifecycle) {}
  canActivate() { this.lifecycle.authorize(); return true; }
}
@Controller('internal/b2b/guide-goods')
@UseFilters(B2bContextFilter)
class RuntimeGoodsController {
  constructor(@Inject(GOODS) private readonly goods: Pick<GuideGoods,'read'|'replace'>, @Inject(PEERS) private readonly peers: readonly string[]) {}
  private boundary(req: any) {
    const peer = b2bPrivatePeer(req, this.peers), header = req.headers.authorization;
    if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(header)) throw new B2bSecurityError(401, 'INVALID_TOKEN');
    if (req.url.includes('?')) throw new B2bSecurityError(400, 'INVALID_REQUEST');
    return { token: header.slice(7), context: { requestId: randomUUID(), peer } };
  }
  @Post('read') async read(@Req() req: any, @Res() res: any, @Body() body: any) {
    const b = this.boundary(req);
    if (!body || Object.keys(body).join(',') !== 'companyId') throw new B2bSecurityError(400, 'INVALID_REQUEST');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json(await this.goods.read(b.token, body.companyId, b.context));
  }
  @Post('replace') async replace(@Req() req: any, @Res() res: any, @Body() body: any) {
    const b = this.boundary(req);
    if (!body || Object.keys(body).sort().join(',') !== 'companyId,input') throw new B2bSecurityError(400, 'INVALID_REQUEST');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json(await this.goods.replace(b.token, body.companyId, body.input, b.context));
  }
}
@Module({})
export class BillingRuntimeHttpModule {
  static isolated(lifecycle: BillingRuntimeLifecycle, goods: Pick<GuideGoods,'read'|'replace'>, peers: readonly string[]): DynamicModule {
    return { module: BillingRuntimeHttpModule, controllers: [RuntimeGoodsController], providers: [B2bContextFilter,
      { provide: GOODS, useValue: goods }, { provide: PEERS, useValue: [...peers] },
      { provide: APP_GUARD, useValue: new RuntimeAdmissionGuard(lifecycle) },
    ] };
  }
}
/** Dedicated private mTLS host. Does not listen, import AppModule, load env or start legacy workers.
 * The host MUST separately attach its existing legacy lifecycle to the factory's mandatory hooks. */
export async function createBillingB2bRuntimeApplication(runtime: BillingB2bRuntime): Promise<NestExpressApplication> {
  const httpsOptions = { ...runtime.transport.tls, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' as const, maxHeaderSize: 16384 };
  const app = await NestFactory.create<NestExpressApplication>(runtime.module, {
    logger: false, bodyParser: false,
    httpsOptions,
  });
  try {
    const express = createRequire(require.resolve('@nestjs/platform-express/package.json'))('express') as {
      json(options: { limit: string; strict: boolean }): (req: any, res: any, next: (error?: unknown) => void) => void;
    };
    runtime.lifecycle.install(app);
    const parser = express.json({ limit: '256kb', strict: true });
    app.use((req: any, res: any, next: (error?: unknown) => void) => {
      res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
      try {
        b2bPrivatePeer(req, runtime.transport.peers);
        const headers = req.rawHeaders.filter((_v: string, i: number) => i % 2 === 0).map((v: string) => v.toLowerCase());
        if (new Set(headers).size !== headers.length || req.url.includes('?')) throw new B2bSecurityError(400, 'INVALID_REQUEST');
      } catch (error) {
        const status = error instanceof B2bSecurityError ? error.status : 503;
        req.resume(); res.status(status).json({ code: status === 503 ? 'OWNER_UNAVAILABLE' : 'OWNER_REQUEST_DENIED' }); return;
      }
      // The existing establishment module owns its raw bounded reader and deadline.
      if (/^\/internal\/b2b\/guide-establishments\/(read|replace)$/.test(req.path)) { next(); return; }
      parser(req, res, error => {
        if (error) { req.resume(); res.status((error as { status?: number }).status === 413 ? 413 : 400).json({ code: 'INVALID_REQUEST' }); }
        else next();
      });
    });
    app.useGlobalFilters(new B2bContextFilter());
    const server = app.getHttpServer();
    server.headersTimeout = 10000; server.requestTimeout = 15000; server.keepAliveTimeout = 1000;
    await app.init();
    return app;
  } catch (error) { await app.close(); throw error; }
}

