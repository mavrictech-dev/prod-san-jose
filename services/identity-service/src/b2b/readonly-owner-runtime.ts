import 'reflect-metadata';
import {Module} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import type {NestExpressApplication} from '@nestjs/platform-express';
import {B2bPrivateHttp,B2bBindingCatalogueHttp} from '@factuez/service-access/dist/b2b';
import {B2bOwnerRuntimeStatus,B2bOwnerRuntimeStatusModule} from '@factuez/service-access/dist/b2b-runtime-status';
import {readonlyOwnerOptions,readonlyPeers,readonlyTls,installReadonlyOwnerBoundary,b2bReadonlyScopes,type ReadonlyOwnerOptions,type ReadonlyTls} from '@factuez/service-access/dist/b2b-readonly-owner';
import type {TransactionalSql} from '../integration/postgres-store';
import {B2bIdentityModule,B2bErrorFilter} from './http';
import {B2bIdentity} from './service';
import {PostgresB2bStore} from './postgres-store';
import {B2bTokenCodec} from './token';
import {B2bWebhookAuthority,B2bWebhookAuthorityModule} from './webhook-authority';
import {fail} from './model';
@Module({})class IdentityReadonlyOwner{}
const checks=[
 'SELECT "id","label","environment","kind","enabled","revision","secretHash","oidcClientId","scopes","bindings" FROM "B2bClient" WHERE false',
 'SELECT "id","requestId","clientId","actorId","action","outcome","revision","peerHash","at" FROM "B2bAudit" WHERE false',
 'SELECT "keyHash","window","count" FROM "B2bRateBucket" WHERE false',
] as const;
export interface IdentityReadonlyKeys {signingKey:Buffer;pepper:Buffer;humanPublicKey:Buffer;integrationPublicKey:Buffer}
/** SERVICE-only minimal Identity owner. This factory never creates a client or
 * human principal, elevates a machine or substitutes an SSO verifier. USER/SSO
 * and administrative enrollment require the existing full Identity runtime. */
export async function createIdentityReadonlyOwner(options:ReadonlyOwnerOptions&{tokenPeers:string[];webhookPeers:string[];billingOrigin:string;billingTls:ReadonlyTls;tokenIssuer:string},db:TransactionalSql,keys:IdentityReadonlyKeys){
 if(options?.enabled!==true)return null;
 readonlyOwnerOptions(options);const tls=readonlyTls(options.tls),tokenPeers=readonlyPeers(options.tokenPeers),webhookPeers=readonlyPeers(options.webhookPeers);
 if(tokenPeers.some(p=>options.callers.includes(p)||webhookPeers.includes(p)))throw Error('IDENTITY_READONLY_SEPARATE_TOKEN_PEERS_REQUIRED');
 if(!db||typeof db.$transaction!=='function'||typeof db.$queryRawUnsafe!=='function'||!keys)throw Error('IDENTITY_READONLY_OWNED_DATABASE_REQUIRED');
 const catalogue=new B2bBindingCatalogueHttp(new B2bPrivateHttp(options.billingOrigin,readonlyTls(options.billingTls))),store=new PostgresB2bStore(db);
 const codec=new B2bTokenCodec(keys.signingKey,options.tokenIssuer,()=>Math.floor(Date.now()/1000),
  {human:keys.humanPublicKey,integration:keys.integrationPublicKey,tls:tls.cert});
 const core=new B2bIdentity(store,codec,keys.pepper,{verify:async()=>fail(503,'SSO_ADMIN_NOT_PUBLISHED')},catalogue,null,Date.now,[...b2bReadonlyScopes]);
 let gate:ReturnType<typeof installReadonlyOwnerBoundary>|undefined;
 const check=async()=>{if(gate&&!gate.isOpen())throw Error('IDENTITY_READONLY_CLOSING');for(const query of checks)await db.$queryRawUnsafe(query);};
 await check();
 const status=new B2bOwnerRuntimeStatus('identity',options.deploymentId,['IDENTITY','WEBHOOK_AUTHORITY'],check);
 const httpsOptions={...tls,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2' as const,maxHeaderSize:8192};
 const app=await NestFactory.create<NestExpressApplication>({module:IdentityReadonlyOwner,imports:[
  B2bIdentityModule.isolated(core,{token:tokenPeers,resource:options.callers,admin:tokenPeers}),
  B2bWebhookAuthorityModule.isolated(new B2bWebhookAuthority(store,catalogue),webhookPeers),
  B2bOwnerRuntimeStatusModule.isolated(status,options.callers),
 ]},{logger:false,bodyParser:false,httpsOptions});
 gate=installReadonlyOwnerBoundary(app,[...new Set([...options.callers,...tokenPeers,...webhookPeers])],[
  '/b2b/oauth/token','/internal/b2b/introspect','/internal/b2b/authorize-webhook',
 ]);
 app.useBodyParser('json',{limit:262144,strict:true});app.useBodyParser('urlencoded',{extended:false,limit:8192,parameterLimit:5});
 app.useGlobalFilters(new B2bErrorFilter());
 let started=false,closed:Promise<void>|undefined;
 return {app,status,async start(){if(started)throw Error('IDENTITY_READONLY_ALREADY_STARTED');started=true;await status.inspect();await app.listen(options.listen.port,options.listen.host);},
  close:()=>closed??=(async()=>{await gate!.closeAdmission();await app.close();})()};
}
