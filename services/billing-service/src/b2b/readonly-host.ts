import 'reflect-metadata';
import {readReadonlyOwnerHost,readonlyHostShutdown} from '@factuez/service-access/dist/b2b-readonly-host';
import {PrismaService} from '../infrastructure/prisma.service';
import {createBillingReadonlyOwner} from './readonly-owner-runtime';
/** Separate read-only owner process; never imports the legacy AppModule. */
export async function bootstrapBillingReadonly(env:NodeJS.ProcessEnv=process.env){
 const loaded=readReadonlyOwnerHost(env,'billing');if(!loaded)return null;
 const {config:c,options,resource,database}=loaded,db=new PrismaService(database);
 let runtime:Awaited<ReturnType<typeof createBillingReadonlyOwner>>|undefined;
 try{
  await db.$connect();runtime=await createBillingReadonlyOwner({...options,identityOrigin:c.identityOrigin,identityTls:resource,registrar:c.registrar},db);
  if(!runtime)throw Error();await runtime.start();
 }catch{await runtime?.close().catch(()=>{});await db.$disconnect();throw Error('BILLING_READONLY_STARTUP_BLOCKED');}
 const close=readonlyHostShutdown(async()=>{await runtime!.close();await db.$disconnect();});
 return {runtime,close};
}
if(require.main===module)void bootstrapBillingReadonly().catch(()=>{process.stderr.write('BILLING_READONLY_STARTUP_BLOCKED\n');process.exitCode=1;});
