import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrivateReadHttp, RemoteReadIdentity, ownerRuntimeConfig } from '@factuez/service-access/dist/integration';
import { PrivateReadFilter, privateReadBoundary } from '@factuez/service-access/dist/integration-http';
import { PostgresExportStore, type ExportPool } from './postgres-store';
import { ExportVault } from './vault';
import { IntegrationExports } from './core';
import { IntegrationExportModule, exportPostPaths } from './http';
import { IntegrationChanges } from './changes';
import { PostgresChangeDeliveryStore } from './change-store';
export async function bootstrapIntegrationExports() {
  const c=ownerRuntimeConfig(process.env,'INTEGRATION_EXPORT_ENABLED');if(!c) return;
  const required=(name:string)=>{const value=process.env[name];if(!value) throw new Error('Missing dedicated export configuration');return value;};
  if(required('INTEGRATION_EXPORT_DB_NAME')!=='integration_exports_beta') throw new Error('Dedicated BETA export database required');
  const {Pool}=require('pg') as {Pool:new (config:unknown)=>ExportPool};
  const key=readFileSync(required('INTEGRATION_EXPORT_KEY_FILE'));const vault=new ExportVault(key);
  const pool=new Pool({host:required('INTEGRATION_EXPORT_DB_HOST'),port:5432,database:'integration_exports_beta',
    user:required('INTEGRATION_EXPORT_DB_USER'),password:readFileSync(required('INTEGRATION_EXPORT_DB_PASSWORD_FILE'),'utf8').trim(),
    ssl:{ca:readFileSync(required('INTEGRATION_EXPORT_DB_CA_FILE'),'utf8'),rejectUnauthorized:true},max:4,
    connectionTimeoutMillis:3000,statement_timeout:10000,idleTimeoutMillis:30000});
  let app:NestExpressApplication|undefined,timer:ReturnType<typeof setTimeout>|undefined,stopping=false;
  try {
    const store=new PostgresExportStore(pool);await store.readySchema();
    const identity=new RemoteReadIdentity(new PrivateReadHttp(c.identityOrigin,c.client));
    const billing=new PrivateReadHttp(required('INTEGRATION_READ_BILLING_ORIGIN'),c.client),sunat=new PrivateReadHttp(required('INTEGRATION_READ_SUNAT_ORIGIN'),c.client);
    const changeStore=process.env.INTEGRATION_CHANGES_ENABLED==='true'?new PostgresChangeDeliveryStore(pool):null;
    if(changeStore)await changeStore.readySchema();
    const feed=changeStore?new IntegrationChanges(changeStore,vault,identity,billing,sunat):null;
    const core=new IntegrationExports(store,vault,identity,billing,sunat,Date.now,feed);
    const tls={cert:c.cert,key:c.key,ca:c.ca,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2' as const,maxHeaderSize:8192};
    app=await NestFactory.create<NestExpressApplication>(IntegrationExportModule.isolated(core,identity,billing,c.peers),{logger:false,bodyParser:false,httpsOptions:tls});
    app.use(privateReadBoundary(exportPostPaths,2));app.useBodyParser('json',{limit:'16kb',strict:true});app.useGlobalFilters(new PrivateReadFilter());
    await app.listen(c.port,'127.0.0.1');
    // One bounded durable worker per process; no queue payload contains an access token. Restart recovers expiring leases.
    const work=async()=>{if(stopping) return;
      try{await core.sweep();if(feed)await feed.sweep();await core.runOne();}catch{process.stderr.write('Export worker unavailable; no fallback\n');}
      if(!stopping) timer=setTimeout(()=>{void work();},1000);};void work();
    const close=async()=>{stopping=true;if(timer) clearTimeout(timer);await app?.close();await pool.end();};
    process.once('SIGTERM',()=>{void close();});process.once('SIGINT',()=>{void close();});
  }catch{stopping=true;if(timer) clearTimeout(timer);await app?.close();await pool.end();throw new Error('Export runtime startup failed; no fallback');}
}
if(require.main===module){
 if(process.env.B2B_EXPORTS_ENABLED==='true')void import('./b2b/main').then(m=>m.bootstrapB2bExports()).catch(()=>{process.stderr.write('EXPORT_RUNTIME_STARTUP_BLOCKED\n');process.exitCode=1;});
 else void bootstrapIntegrationExports().catch(()=>{process.exitCode=1;});
}
