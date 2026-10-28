import 'reflect-metadata';
import {B2bRuntimeFiles} from '@factuez/service-access/dist/b2b-runtime-files';
import {B2bIdentityHttp,B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {stopB2bMaintenanceNode} from '@factuez/service-access/dist/b2b-maintenance-node';
import {HttpB2bExtractionOwner} from './core';
import {createB2bExportRuntime} from './runtime';
export function b2bExportRuntimeMetadata(c:any){
 const keys=['schemaVersion','environment','approvedForPrivateBeta','deploymentId','instanceId','host','port','maintenancePort','peers','operatorPeers','origins','database','workerEnabled'];
 if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).sort().join(',')!==keys.sort().join(',')||c.schemaVersion!=='factuez.b2b.export-runtime.v1'||c.environment!=='BETA'||c.approvedForPrivateBeta!==true||
  !c.database||Object.keys(c.database).sort().join(',')!=='host,name,user'||c.database.name!=='b2b_exports_beta'||!/^[a-zA-Z0-9.-]{1,253}$/.test(c.database.host)||!/^[a-z][a-z0-9_]{0,62}$/.test(c.database.user)||
  !c.origins||Object.keys(c.origins).sort().join(',')!=='billing,fiscal,identity'||typeof c.workerEnabled!=='boolean')throw Error('EXPORT_RUNTIME_METADATA_INVALID');
 for(const origin of Object.values(c.origins)){
  if(typeof origin!=='string')throw Error('EXPORT_RUNTIME_METADATA_INVALID');const url=new URL(origin);
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('EXPORT_RUNTIME_METADATA_INVALID');
 }return structuredClone(c);
}
/** Dedicated BETA entrypoint. Absent flag performs no mounted-file/DB I/O. */
export async function bootstrapB2bExports(env:NodeJS.ProcessEnv=process.env){
 if(env.B2B_EXPORTS_ENABLED!=='true')return null;
 if(!env.B2B_EXPORTS_CONFIG_ROOT)throw Error('EXPORT_RUNTIME_CONFIG_ROOT_REQUIRED');
 const files=new B2bRuntimeFiles(env.B2B_EXPORTS_CONFIG_ROOT),c=b2bExportRuntimeMetadata(files.metadata());
 const ca=files.publicPem('ca.pem'),tls={ca,cert:files.publicPem('server.crt'),key:files.privatePem('server.key')};
 const client={ca,cert:files.publicPem('resource.crt'),key:files.privatePem('resource.key')},key=files.secretBytes('export-vault.bin');
 if(key.length!==32){key.fill(0);throw Error('EXPORT_RUNTIME_VAULT_REQUIRED');}
 const {Pool}=require('pg'),pool=new Pool({host:c.database.host,port:5432,database:c.database.name,user:c.database.user,password:files.secretBytes('database-password.bin').toString('utf8').trim(),
  ssl:{ca:files.publicPem('database-ca.pem').toString('utf8'),rejectUnauthorized:true},max:4,connectionTimeoutMillis:3000,statement_timeout:10000,idleTimeoutMillis:30000});
 let closing:Promise<void>|undefined;const database={query:pool.query.bind(pool),connect:pool.connect.bind(pool),end:()=>closing??=Promise.resolve().then(()=>pool.end())};
 try{
  const identity=new B2bIdentityHttp(new B2bPrivateHttp(c.origins.identity,client));
  const runtime=await createB2bExportRuntime({...c,enabled:true,pool:database,vaultKey:key,identity,
   billing:new HttpB2bExtractionOwner(new B2bPrivateHttp(c.origins.billing,client)),fiscal:new HttpB2bExtractionOwner(new B2bPrivateHttp(c.origins.fiscal,client),true),tls});
  key.fill(0);if(!runtime)throw Error();await runtime.start();let stopping:Promise<void>|undefined;
  const stop=()=>stopping??=stopB2bMaintenanceNode(runtime.maintenance).catch(()=>{process.exitCode=1;});
  process.once('SIGTERM',()=>{void stop();});process.once('SIGINT',()=>{void stop();});return runtime;
 }catch{key.fill(0);await database.end().catch(()=>{});throw Error('EXPORT_RUNTIME_STARTUP_BLOCKED');}
}
if(require.main===module)void bootstrapB2bExports().catch(()=>{process.stderr.write('EXPORT_RUNTIME_STARTUP_BLOCKED\n');process.exitCode=1;});
