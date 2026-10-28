import 'reflect-metadata';
import {Module} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import type {INestApplicationContext} from '@nestjs/common';
import {B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {ReceptionPrisma} from '../prisma.service';
import {ReceptionService} from '../reception.service';
import {ReceptionAutomationService} from '../automation/service';
import {createReceptionAutomationVault} from './automation';
import {loadB2bReceivedRuntimeMount} from './runtime-files';
import {B2bReceivedStepUpHttp} from './runtime-authority';
import {B2bReceivedIsolatedHostLifecycle} from './runtime-host-lifecycle';
import {createB2bReceivedRuntime,type B2bReceivedOwnerRuntime} from './runtime';
@Module({})
class ReceivedOwnerHostModule {}
/** Concrete opt-in host. No legacy AppModule, background connector, DDL,
 * OAuth request, global shutdown claim or synthetic owner replacement. */
export async function bootstrapB2bReceivedOwner(env:NodeJS.ProcessEnv=process.env){
 if(env.B2B_RECEIVED_ENABLED!=='true')return null;
 if(!env.B2B_RECEIVED_CONFIG_ROOT)throw Error('B2B_RECEIVED_CONFIG_ROOT_REQUIRED');
 const mounted=loadB2bReceivedRuntimeMount(env.B2B_RECEIVED_CONFIG_ROOT);
 let authority:B2bReceivedStepUpHttp|undefined;
 let db:ReceptionPrisma|undefined,context:INestApplicationContext|undefined,runtime:B2bReceivedOwnerRuntime|undefined;
 try{
  const vault=createReceptionAutomationVault(mounted.vaultMaster);mounted.vaultMaster.fill(0);
  authority=new B2bReceivedStepUpHttp(mounted.stepUp,mounted.stepUpTls,mounted.stepUpPrepareTls);
  const lifecycle=new B2bReceivedIsolatedHostLifecycle(),stepUp=authority;
  const legacyLifecycle={pauseCommands:lifecycle.pauseCommands.bind(lifecycle),drainCommands:lifecycle.drainCommands.bind(lifecycle),stopProducers:lifecycle.stopProducers.bind(lifecycle),
   stopWorkers:lifecycle.stopWorkers.bind(lifecycle),drainMutations:lifecycle.drainMutations.bind(lifecycle),closeAdmission:lifecycle.closeAdmission.bind(lifecycle),drainAll:lifecycle.drainAll.bind(lifecycle),
   closeListeners:async()=>{await lifecycle.closeListeners();stepUp.dispose();}}; // Runtime invokes this only AFTER its ALL drain.
  const identityHttp=new B2bPrivateHttp(mounted.identityOrigin,mounted.identityTls);
  db=new ReceptionPrisma(mounted.database);await db.$connect();const ownerDb=db;
  // Database lifecycle belongs to the runtime. The DI context must not register
  // Prisma's OnModuleInit/Destroy again under another provider token.
  context=await NestFactory.createApplicationContext({module:ReceivedOwnerHostModule,providers:[
   {provide:ReceptionService,useFactory:()=>new ReceptionService(ownerDb)},
   {provide:ReceptionAutomationService,useFactory:()=>new ReceptionAutomationService(ownerDb)},
  ]},{logger:false,abortOnError:false});
  runtime=(await createB2bReceivedRuntime(mounted.config,{database:ownerDb,
   legacy:{reception:context.get(ReceptionService),automation:context.get(ReceptionAutomationService)},
   identityHttp,grantAdministrator:authority.grantAdministrator,userAdministrator:authority.userAdministrator,vault,
   credentials:mounted.credentials,legacyLifecycle,
  }))!;
  const ports=await runtime.start(),owned=runtime,di=context;
  let closing:Promise<void>|undefined;
  const close=()=>closing??=(async()=>{await owned.close();await di.close();process.off('SIGTERM',signal);process.off('SIGINT',signal);})();
  const signal=()=>{void close().catch(()=>{process.stderr.write('B2B_RECEIVED_SHUTDOWN_BLOCKED\n');process.exitCode=1;});};
  process.once('SIGTERM',signal);process.once('SIGINT',signal);
  return {runtime,ports,close};
 }catch{
  mounted.vaultMaster.fill(0);
  // Never close a pool behind work whose ordered drain failed.
  if(runtime)await runtime.close();else{authority?.dispose();await db?.$disconnect();}await context?.close();
  throw Error('B2B_RECEIVED_STARTUP_BLOCKED');
 }
}
if(require.main===module)void bootstrapB2bReceivedOwner().catch(()=>{process.stderr.write('B2B_RECEIVED_STARTUP_BLOCKED\n');process.exitCode=1;});
