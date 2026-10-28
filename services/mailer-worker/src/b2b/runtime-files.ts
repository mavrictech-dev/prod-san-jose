import {createRequire} from 'node:module';
import {B2bRuntimeFiles} from '@factuez/service-access/dist/b2b-runtime-files';
import {mountedB2bPostgres,b2bPostgresOptions,type B2bPostgresOptions} from '@factuez/service-access/dist/b2b-postgres-options';
import type {EmailDeliveryPgPool} from './email-deliveries.store';
import {mailerRuntimeConfig,mailerRuntimeTls} from './runtime-config';
export function loadB2bMailerRuntimeMount(root:string){
 try{
  const files=new B2bRuntimeFiles(root),config=mailerRuntimeConfig(files.metadata() as any);
  const tls=(p:string)=>mailerRuntimeTls({ca:files.publicPem(p+'-ca.pem'),cert:files.publicPem(p+'.crt'),key:files.privatePem(p+'.key')});
  return {config,credentials:{apiTls:tls('api'),controlTls:tls('operator')},identityTls:tls('identity'),billingTls:tls('billing'),authorityTls:config.smtpAdministration?tls('authority'):undefined,workerIdentityTls:config.dispatcher.enabled?tls('email-worker'):undefined,database:mountedB2bPostgres(files,config.database)};
 }catch{throw Error('B2B_MAILER_MOUNTED_CONFIGURATION_INVALID');}
}
/** Supply every connection field, verified CA and a fixed search_path; no connection URL. */
export function createB2bMailerPostgres(options:B2bPostgresOptions):EmailDeliveryPgPool {
 const checked=b2bPostgresOptions(options);
 const {Pool}=createRequire(__filename)('pg') as {Pool:new(options:unknown)=>EmailDeliveryPgPool};
 return new Pool({...checked,options:'-c search_path=public'});
}
