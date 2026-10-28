import 'reflect-metadata';
import {PrismaClient} from '../generated/prisma/client';
import {B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {loadB2bHistoryRuntimeMount,b2bHistoryPrismaAdapter} from './runtime-files';
import {createB2bHistoryRuntime,type B2bHistoryOwnerRuntime} from './runtime';
/** Executable SYNTHETIC QA reader host. Disabled imports perform no mounted
 * file reads, database construction, Identity request or socket/listener start. */
export async function bootstrapB2bHistory(env:NodeJS.ProcessEnv=process.env){
 if(env.B2B_HISTORY_ENABLED!=='true')return null;
 if(!env.B2B_HISTORY_CONFIG_ROOT)throw Error('B2B_HISTORY_CONFIG_ROOT_REQUIRED');
 const mounted=loadB2bHistoryRuntimeMount(env.B2B_HISTORY_CONFIG_ROOT);
 let database:PrismaClient|undefined,owner:B2bHistoryOwnerRuntime|undefined;
 try{
  database=new PrismaClient({adapter:b2bHistoryPrismaAdapter(mounted.database)});await database.$connect();
  owner=(await createB2bHistoryRuntime(mounted.config,{database,credentials:mounted.credentials,identityHttp:new B2bPrivateHttp(mounted.config.identityOrigin,mounted.identityTls)}))!;
  const ports=await owner.start(),runtime=owner;let closing:Promise<void>|undefined;
  const close=()=>closing??=(async()=>{await runtime.close();process.off('SIGTERM',stop);process.off('SIGINT',stop);})();
  const stop=()=>{void close().catch(()=>{process.stderr.write('B2B_HISTORY_SHUTDOWN_BLOCKED\n');process.exitCode=1;});};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);return {runtime,ports,close};
 }catch{if(owner)await owner.close();else await database?.$disconnect();throw Error('B2B_HISTORY_STARTUP_BLOCKED');}
}
if(require.main===module)void bootstrapB2bHistory().catch(()=>{process.stderr.write('B2B_HISTORY_STARTUP_BLOCKED\n');process.exitCode=1;});
