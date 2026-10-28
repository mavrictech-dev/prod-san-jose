import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrivateReadHttp,RemoteReadIdentity,ownerRuntimeConfig } from '@factuez/service-access/dist/integration';
import { PrivateReadFilter,privateReadBoundary } from '@factuez/service-access/dist/integration-http';
import { IntegrationReads } from './read';
import { IntegrationReadModule } from './http';
export async function bootstrapIntegrationReads() {
  const c=ownerRuntimeConfig(process.env,'INTEGRATION_READ_ENABLED');if (!c) return;
  const billingOrigin=process.env.INTEGRATION_READ_BILLING_ORIGIN,sunatOrigin=process.env.INTEGRATION_READ_SUNAT_ORIGIN;
  if (!billingOrigin || !sunatOrigin) throw new Error('Fixed owner HTTPS origins required');
  const exportOrigin=process.env.INTEGRATION_READ_EXPORT_ORIGIN;
  if(process.env.INTEGRATION_EXPORT_FORWARD_ENABLED==='true'&&!exportOrigin) throw new Error('Fixed export owner HTTPS origin required');
  const enabled=process.env.INTEGRATION_EXPORT_FORWARD_ENABLED==='true';
  const core=new IntegrationReads(new RemoteReadIdentity(new PrivateReadHttp(c.identityOrigin,c.client)),
    new PrivateReadHttp(billingOrigin,c.client),new PrivateReadHttp(sunatOrigin,c.client),()=>Date.now(),
    enabled?new PrivateReadHttp(exportOrigin!,c.client):undefined);
  const tls={cert:c.cert,key:c.key,ca:c.ca,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2' as const,maxHeaderSize:8192};
  const app=await NestFactory.create<NestExpressApplication>(IntegrationReadModule.isolated(core,c.peers),{logger:false,bodyParser:false,httpsOptions:tls});
  app.use(privateReadBoundary(enabled?{'/integration/v1/exports':16384}:{},enabled?2:16));
  if(enabled) app.useBodyParser('json',{limit:'16kb',strict:true});app.useGlobalFilters(new PrivateReadFilter());
  try {await app.listen(c.port,'127.0.0.1');} catch {await app.close();throw new Error('Integration read startup failed; no fallback');}
  process.once('SIGTERM',()=>{void app.close();});process.once('SIGINT',()=>{void app.close();});
}
if (require.main===module) void bootstrapIntegrationReads().catch(()=>{process.exitCode=1;});
