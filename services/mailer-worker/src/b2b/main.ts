import 'reflect-metadata';
import {B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {loadB2bMailerRuntimeMount,createB2bMailerPostgres} from './runtime-files';
import {createB2bMailerRuntime,requireMailerHostPorts,type MailerHostPorts,type B2bMailerOwnerRuntime,type B2bMailerRuntimeConfig} from './runtime';
import {createBuiltinMailerHostPorts} from './host';
export interface MailerHostFactoryContext {
 config:B2bMailerRuntimeConfig;identityHttp:B2bPrivateHttp;billingHttp:B2bPrivateHttp;
 authorityHttp?:B2bPrivateHttp;workerIdentityHttp?:B2bPrivateHttp;
}
export type MailerHostPortsFactory=(context:MailerHostFactoryContext)=>MailerHostPorts|Promise<MailerHostPorts>;
/** Default CLI constructs the in-repository owner adapters. Explicit embeddings
 * remain supported; no environment module path or permissive port is loaded. */
export async function bootstrapB2bMailer(env:NodeJS.ProcessEnv=process.env,bindings?:MailerHostPorts|MailerHostPortsFactory){
 if(env.B2B_MAILER_ENABLED!=='true')return null;
 if(bindings!==undefined&&typeof bindings!=='function')requireMailerHostPorts(bindings);
 if(!env.B2B_MAILER_CONFIG_ROOT)throw Error('B2B_MAILER_CONFIG_ROOT_REQUIRED');
 const mounted=loadB2bMailerRuntimeMount(env.B2B_MAILER_CONFIG_ROOT);
 const clients:MailerHostFactoryContext={config:mounted.config,
  identityHttp:new B2bPrivateHttp(mounted.config.identityOrigin,mounted.identityTls),
  billingHttp:new B2bPrivateHttp(mounted.config.billingOrigin,mounted.billingTls),
  authorityHttp:mounted.authorityTls?new B2bPrivateHttp(mounted.config.identityOrigin,mounted.authorityTls):undefined,
  workerIdentityHttp:mounted.workerIdentityTls?new B2bPrivateHttp(mounted.config.identityOrigin,mounted.workerIdentityTls):undefined};
 let ports=typeof bindings==='function'?await bindings(clients):bindings;
 if(bindings!==undefined)requireMailerHostPorts(ports,mounted.config);
 const pool=createB2bMailerPostgres(mounted.database);let runtime:B2bMailerOwnerRuntime|undefined;
 try{
  ports??=await createBuiltinMailerHostPorts(env.B2B_MAILER_CONFIG_ROOT,pool,clients);requireMailerHostPorts(ports,mounted.config);
  runtime=(await createB2bMailerRuntime(mounted.config,{...ports,...clients,pool,credentials:mounted.credentials}))!;
  const addresses=await runtime.start(),owner=runtime;let closing:Promise<void>|undefined;
  const close=()=>closing??=(async()=>{await owner.close();process.off('SIGTERM',stop);process.off('SIGINT',stop);})();
  const stop=()=>{void close().catch(()=>{process.stderr.write('B2B_MAILER_SHUTDOWN_BLOCKED\n');process.exitCode=1;});};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);return {runtime,ports:addresses,close};
 }catch{if(runtime)await runtime.close();else {await ports?.emailSource?.close?.();await ports?.smtpOwner?.close();await pool.end();}throw Error('B2B_MAILER_STARTUP_BLOCKED');}
}
if(require.main===module)void bootstrapB2bMailer().catch(()=>{process.stderr.write('B2B_MAILER_STARTUP_BLOCKED\n');process.exitCode=1;});
