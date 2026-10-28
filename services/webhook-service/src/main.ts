import 'reflect-metadata';
import {B2bIdentityHttp,B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {B2bRuntimeFiles} from '@factuez/service-access/dist/b2b-runtime-files';
import {stopB2bMaintenanceNode} from '@factuez/service-access/dist/b2b-maintenance-node';
import {HookVault,type HookVaultKeyring} from './crypto';
import {HttpsCallbacks} from './destination';
import {HttpDeliveryAuthority} from './authority';
import {createWebhookOwnerRuntime} from './runtime';
export async function bootstrapWebhooks(env:NodeJS.ProcessEnv=process.env){
 if(env.B2B_WEBHOOKS_ENABLED!=='true')return null;
 if(!env.B2B_WEBHOOKS_CONFIG_ROOT)throw Error('WEBHOOKS_CONFIG_ROOT_REQUIRED');const files=new B2bRuntimeFiles(env.B2B_WEBHOOKS_CONFIG_ROOT),c=files.metadata();
 const keys=['schemaVersion','environment','approvedForPrivateBeta','deploymentId','instanceId','host','port','maintenancePort','peers','operatorPeers','identityOrigin','database','destinations','dispatchEnabled','vault'];
 if(Object.keys(c).sort().join(',')!==keys.sort().join(',')||c.schemaVersion!=='factuez.b2b.webhooks-runtime.v1'||c.environment!=='BETA'||c.approvedForPrivateBeta!==true||
  !['127.0.0.1','0.0.0.0'].includes(c.host)||!c.database||Object.keys(c.database).sort().join(',')!=='host,name,user'||c.database.name!=='b2b_webhooks_beta'||
  !/^[a-zA-Z0-9_.-]{1,253}$/.test(c.database.host)||!/^[a-z][a-z0-9_]{0,62}$/.test(c.database.user)||!Array.isArray(c.destinations)||typeof c.dispatchEnabled!=='boolean'||
  !c.peers||Object.keys(c.peers).sort().join(',')!=='billingPublisher,facade'||!Array.isArray(c.operatorPeers)||!c.vault||
  Object.keys(c.vault).some(k=>!['activeKeyVersion','readableKeyVersions','legacyKeyVersion'].includes(k))||!Array.isArray(c.vault.readableKeyVersions)||
  c.vault.readableKeyVersions.length<1||c.vault.readableKeyVersions.length>2||c.vault.readableKeyVersions.some((v:unknown)=>typeof v!=='string'||!/^[a-z][a-z0-9-]{0,40}$/.test(v)))throw Error('WEBHOOK_RUNTIME_METADATA_INVALID');
 const ca=files.publicPem('ca.pem'),tls={ca,cert:files.publicPem('server.crt'),key:files.privatePem('server.key')};
 const client={ca,cert:files.publicPem('resource.crt'),key:files.privatePem('resource.key')},identityHttp=new B2bPrivateHttp(c.identityOrigin,client);
 const keyring:HookVaultKeyring={activeKeyVersion:c.vault.activeKeyVersion,keys:c.vault.readableKeyVersions.map((version:string)=>({version,key:files.secretBytes('vault-'+version+'.bin')})),
  ...(c.vault.legacyKeyVersion!==undefined?{legacyKeyVersion:c.vault.legacyKeyVersion}:{})};
 const vault=new HookVault(keyring),callbacks=new HttpsCallbacks(c.destinations),{Pool}=require('pg');
 const pool=new Pool({host:c.database.host,port:5432,database:c.database.name,user:c.database.user,password:files.secretBytes('database-password.bin').toString('utf8').trim(),
  ssl:{ca:files.publicPem('database-ca.pem').toString('utf8'),rejectUnauthorized:true},max:4,connectionTimeoutMillis:3000,statement_timeout:10000,idleTimeoutMillis:30000});
 let closed:Promise<void>|undefined;
 const database={query:pool.query.bind(pool),connect:pool.connect.bind(pool),end:()=>closed??=Promise.resolve().then(()=>pool.end())};
 try{
  const runtime=await createWebhookOwnerRuntime({enabled:true,deploymentId:c.deploymentId,instanceId:c.instanceId,database,
   identity:new B2bIdentityHttp(identityHttp),authority:new HttpDeliveryAuthority(identityHttp),callbacks,vault,
   peers:c.peers,operatorPeers:c.operatorPeers,tls,host:c.host,port:c.port,maintenancePort:c.maintenancePort,dispatchEnabled:c.dispatchEnabled});
  if(!runtime)throw Error('WEBHOOK_RUNTIME_NOT_CONFIGURED');await runtime.start();
  let closing:Promise<void>|undefined;const stop=()=>closing??=stopB2bMaintenanceNode(runtime.maintenance).catch(()=>{process.exitCode=1;});
  process.once('SIGTERM',()=>{void stop();});process.once('SIGINT',()=>{void stop();});return runtime;
 }catch{await database.end().catch(()=>{});throw Error('WEBHOOK_RUNTIME_STARTUP_BLOCKED');}
}
if(require.main===module)void bootstrapWebhooks().catch(()=>{process.stderr.write('WEBHOOK_RUNTIME_STARTUP_BLOCKED\n');process.exitCode=1;});
