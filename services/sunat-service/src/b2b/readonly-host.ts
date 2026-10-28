import 'reflect-metadata';
import {readReadonlyOwnerHost,readonlyHostShutdown} from '@factuez/service-access/dist/b2b-readonly-host';
import {PrismaService} from '../infrastructure/prisma.service';
import {createFiscalReadonlyOwner} from './readonly-owner-runtime';
export async function bootstrapFiscalReadonly(env:NodeJS.ProcessEnv=process.env){
 const loaded=readReadonlyOwnerHost(env,'fiscal');if(!loaded)return null;
 const {config:c,options,resource,database}=loaded,db=new PrismaService(database);
 let runtime:Awaited<ReturnType<typeof createFiscalReadonlyOwner>>|undefined;
 try{
  await db.$connect();runtime=await createFiscalReadonlyOwner({...options,identityOrigin:c.identityOrigin,identityTls:resource,
   billingOrigin:c.billingOrigin,billingTls:resource,artifactsRoot:c.artifactsRoot},db);
  if(!runtime)throw Error();await runtime.start();
 }catch{await runtime?.close().catch(()=>{});await db.$disconnect();throw Error('FISCAL_READONLY_STARTUP_BLOCKED');}
 const close=readonlyHostShutdown(async()=>{await runtime!.close();await db.$disconnect();});
 return {runtime,close};
}
if(require.main===module)void bootstrapFiscalReadonly().catch(()=>{process.stderr.write('FISCAL_READONLY_STARTUP_BLOCKED\n');process.exitCode=1;});
