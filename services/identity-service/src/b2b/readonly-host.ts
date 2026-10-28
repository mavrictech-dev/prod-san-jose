import 'reflect-metadata';
import {readReadonlyOwnerHost,readonlyHostShutdown} from '@factuez/service-access/dist/b2b-readonly-host';
import {PrismaService} from '../infrastructure/prisma.service';
import {createIdentityReadonlyOwner} from './readonly-owner-runtime';
export async function bootstrapIdentityReadonly(env:NodeJS.ProcessEnv=process.env){
 const loaded=readReadonlyOwnerHost(env,'identity');if(!loaded)return null;
 const {config:c,options,resource,database,files}=loaded,db=new PrismaService(database);
 let runtime:Awaited<ReturnType<typeof createIdentityReadonlyOwner>>|undefined;
 try{
  const keys={signingKey:files.privatePem('signing-key.pem'),pepper:files.secretBytes('pepper.bin'),
   humanPublicKey:files.publicPem('human-public.pem'),integrationPublicKey:files.publicPem('integration-public.pem')};
  await db.$connect();runtime=await createIdentityReadonlyOwner({...options,tokenPeers:c.tokenPeers,webhookPeers:c.webhookPeers,
   billingOrigin:c.billingOrigin,billingTls:resource,tokenIssuer:c.tokenIssuer},db,keys);
  if(!runtime)throw Error();await runtime.start();
 }catch{await runtime?.close().catch(()=>{});await db.$disconnect();throw Error('IDENTITY_READONLY_STARTUP_BLOCKED');}
 const close=readonlyHostShutdown(async()=>{await runtime!.close();await db.$disconnect();});
 return {runtime,close};
}
if(require.main===module)void bootstrapIdentityReadonly().catch(()=>{process.stderr.write('IDENTITY_READONLY_STARTUP_BLOCKED\n');process.exitCode=1;});
