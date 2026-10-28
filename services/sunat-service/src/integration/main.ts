import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { PrivateReadHttp, RemoteReadIdentity, ownerRuntimeConfig } from '@factuez/service-access/dist/integration';
import { PrivateReadFilter,privateReadBoundary } from '@factuez/service-access/dist/integration-http';
import { PrismaService } from '../infrastructure/prisma.service';
import { OriginalArtifactReader } from './artifact-reader';
import { SunatRead, RemoteBillingOwner } from './read';
import { PrismaSunatRead } from './repository';
import { SunatReadModule } from './http';
import { OwnerChanges,PrismaOwnerJournal } from '@factuez/service-access/dist/integration-owner-changes';
export async function bootstrapSunatRead() {
  const c=ownerRuntimeConfig(process.env,'INTEGRATION_SUNAT_READ_ENABLED');if (!c) return;
  const billingOrigin=process.env.INTEGRATION_READ_BILLING_ORIGIN;if (!billingOrigin) throw new Error('Private Billing origin required');
  if (!process.env.ARTIFACTS_ROOT) throw new Error('Explicit owner artifact root required');
  const billing=new RemoteBillingOwner(new PrivateReadHttp(billingOrigin,c.client));
  const identity=new RemoteReadIdentity(new PrivateReadHttp(c.identityOrigin,c.client));
  const db=new PrismaService();let app:Awaited<ReturnType<typeof NestFactory.create>>|undefined;
  const tls={cert:c.cert,key:c.key,ca:c.ca,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2' as const,maxHeaderSize:8192};
  try {
    await db.$connect();const repository=new PrismaSunatRead(db);await repository.ready();
    app=await NestFactory.create(SunatReadModule.isolated(new SunatRead(repository,identity,billing,new OriginalArtifactReader(process.env.ARTIFACTS_ROOT!)),c.peers,
      process.env.INTEGRATION_SUNAT_CHANGES_ENABLED==='true'?new OwnerChanges(new PrismaOwnerJournal(db,'SUNAT'),identity):null),
      {logger:false,bodyParser:false,httpsOptions:tls});
    app.use(privateReadBoundary());app.useGlobalFilters(new PrivateReadFilter());await app.listen(c.port,'127.0.0.1');
    const close=async()=>{await app?.close();await db.$disconnect();};
    process.once('SIGTERM',()=>{void close();});process.once('SIGINT',()=>{void close();});
  } catch {await app?.close();await db.$disconnect();throw new Error('SUNAT private read startup failed; no fallback');}
}
if (require.main===module) void bootstrapSunatRead().catch(()=>{process.exitCode=1;});
