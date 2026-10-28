import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrivateReadHttp, RemoteReadIdentity, ownerRuntimeConfig } from '@factuez/service-access/dist/integration';
import { PrivateReadFilter,privateReadBoundary } from '@factuez/service-access/dist/integration-http';
import { PrismaService } from '../infrastructure/prisma.service';
import { BillingRead } from './read';
import { PrismaBillingRead } from './repository';
import { BillingReadModule, billingCapturePostPaths } from './http';
import { BillingCapture } from './capture';
import { PrismaBillingCapture } from './capture-repository';
import { OwnerChanges,PrismaOwnerJournal } from '@factuez/service-access/dist/integration-owner-changes';
export async function bootstrapBillingRead() {
  const c=ownerRuntimeConfig(process.env,'INTEGRATION_BILLING_READ_ENABLED'); if (!c) return;
  const db=new PrismaService(); let app:NestExpressApplication|undefined;
  const tls={cert:c.cert,key:c.key,ca:c.ca,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2' as const,maxHeaderSize:8192};
  try {
    const identity=new RemoteReadIdentity(new PrivateReadHttp(c.identityOrigin,c.client)); await db.$connect();
    const enabled=process.env.INTEGRATION_BILLING_CAPTURE_ENABLED==='true';
    const changesEnabled=process.env.INTEGRATION_BILLING_CHANGES_ENABLED==='true';
    if(changesEnabled&&!enabled)throw new Error('Changes require consistent capture');
    app=await NestFactory.create<NestExpressApplication>(BillingReadModule.isolated(new BillingRead(new PrismaBillingRead(db),identity),c.peers,
      enabled?new BillingCapture(new PrismaBillingCapture(db,changesEnabled),identity):null,
      changesEnabled?new OwnerChanges(new PrismaOwnerJournal(db),identity):null),
      {logger:false,bodyParser:false,httpsOptions:tls});
    app.use(privateReadBoundary(enabled?billingCapturePostPaths:{},enabled?2:16));
    if(enabled) app.useBodyParser('json',{limit:'4mb',strict:true});app.useGlobalFilters(new PrivateReadFilter()); await app.listen(c.port,'127.0.0.1');
    const close=async()=>{await app?.close();await db.$disconnect();};
    process.once('SIGTERM',()=>{void close();});process.once('SIGINT',()=>{void close();});
  } catch { await app?.close();await db.$disconnect();throw new Error('Billing private read startup failed; no fallback'); }
}
if (require.main===module) void bootstrapBillingRead().catch(()=>{process.exitCode=1;});
