import 'reflect-metadata';
import {X509Certificate} from 'node:crypto';
import {B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {B2bOAuthHttp} from '@factuez/service-access/dist/b2b-oauth-http';
import {B2bRuntimeFiles} from '@factuez/service-access/dist/b2b-runtime-files';
import {B2bMaintenanceNode,stopB2bMaintenanceNode} from '@factuez/service-access/dist/b2b-maintenance-node';
import {FileB2bOperationalPolicy} from './operational-policy-file';
import {B2bOperationalControl} from './operational-control';
import {b2bReadonlyConfig,readonlyOwners} from './readonly-runtime-config';
import {assembleB2bReadonlyFacade,type ReadonlyTransports} from './readonly-runtime-assembly';
/** Separate executable; never selected automatically by the fullgraph entrypoint.
 * Only mounted configuration is read; no enrollment, schema writes or worker starts. */
export async function bootstrapB2bReadonly(env:NodeJS.ProcessEnv=process.env){
 if(env.B2B_READONLY_API_ENABLED!=='true')return null;
 if(env.B2B_PRIVATE_ACCESS!=='true')throw Error('B2B_PRIVATE_ACCESS_REQUIRED');
 if(!env.B2B_READONLY_CONFIG_ROOT)throw Error('B2B_READONLY_CONFIG_ROOT_REQUIRED');
 const root=env.B2B_READONLY_CONFIG_ROOT,files=new B2bRuntimeFiles(root),config=b2bReadonlyConfig(files.metadata('readonly-runtime.json'));
 const ca=files.publicPem('ca.pem'),tls={ca,cert:files.publicPem('server.crt'),key:files.privatePem('server.key')};
 const resource={ca,cert:files.publicPem('resource.crt'),key:files.privatePem('resource.key')};
 const token={ca,cert:files.publicPem('oauth.crt'),key:files.privatePem('oauth.key')};
 const fp=(cert:Buffer)=>new X509Certificate(cert).fingerprint256.replace(/:/g,'').toLowerCase(),r=fp(resource.cert),t=fp(token.cert);
 if(r===t||[...config.edgePeers,...config.operatorPeers].some(p=>p===r||p===t))throw Error('B2B_READONLY_SEPARATE_RESOURCE_AND_TOKEN_PEERS_REQUIRED');
 const policy=new FileB2bOperationalPolicy(root);
 if((await policy.current()).mode!=='PAUSED')throw Error('INITIAL_B2B_READONLY_POLICY_MUST_BE_PAUSED');
 const operations=new B2bOperationalControl(policy,{enabled:true});
 const resources=Object.fromEntries(readonlyOwners.map(owner=>[owner,new B2bPrivateHttp(config.origins[owner],resource)])) as ReadonlyTransports;
 const {app,proof,bootId}=await assembleB2bReadonlyFacade(resources,{deploymentId:config.deploymentId,tls,peers:config.edgePeers,operations,oauth:new B2bOAuthHttp(config.origins.identity,token)});
 const maintenance=new B2bMaintenanceNode({enabled:true,deploymentId:config.deploymentId,instance:{service:'B2B_API',instanceId:config.instanceId,bootId},hooks:{
  ADMISSION:async()=>{operations.pause();},PRODUCERS:async()=>{},
  WORKERS:async()=>{while((await operations.drain(30000)).state!=='DRAINED'){/* Retain active owner work until completion. */}},
  STORAGE:async()=>{await app.close();},
 }});
 try{
  await maintenance.listen({host:config.listen.host,port:config.listen.maintenancePort,tls,operatorPeers:config.operatorPeers});
  await app.listen(config.listen.port,config.listen.host);
 }catch{await app.close();await maintenance.closeListener();throw Error('B2B_READONLY_STARTUP_FAILED');}
 let closing:Promise<void>|undefined;
 const shutdown=()=>closing??=stopB2bMaintenanceNode(maintenance);
 const onSignal=()=>{void shutdown().catch(()=>{process.exitCode=1;});};
 process.once('SIGTERM',onSignal);process.once('SIGINT',onSignal);
 return {app,proof,operations,maintenance,async close(){
  await shutdown();await maintenance.closeListener();process.removeListener('SIGTERM',onSignal);process.removeListener('SIGINT',onSignal);
 }};
}
if(require.main===module)void bootstrapB2bReadonly().catch(()=>{process.stderr.write('B2B_READONLY_STARTUP_BLOCKED\n');process.exitCode=1;});
