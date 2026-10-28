import 'reflect-metadata';
import {randomUUID} from 'node:crypto';
import {B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {B2bRuntimeFiles} from '@factuez/service-access/dist/b2b-runtime-files';
import {B2bMaintenanceNode,stopB2bMaintenanceNode} from '@factuez/service-access/dist/b2b-maintenance-node';
import {b2bOwnerRuntimeCapabilities} from '@factuez/service-access/dist/b2b-runtime-status';
import {assembleB2bFacade,b2bRuntimeOwners,type B2bFacadeTransports} from './runtime-assembly';
import {b2bApiRuntimeConfig} from './runtime-config';
import {B2bOperationalControl} from './operational-control';
import {FileB2bOperationalPolicy} from './operational-policy-file';

/** Readiness only, never credentials or authorization. Actual business requests
 * still introspect Identity and authorize independently in each owner. */
export async function verifyB2bOwnerGraph(resources:B2bFacadeTransports['resources'],deploymentId:string){
 const boots=new Set<string>();
 for(const owner of b2bRuntimeOwners){
  const r:any=await resources[owner].post('/internal/b2b/runtime-status',{});
  if(!r||Object.keys(r).sort().join(',')!=='bootId,capabilities,deploymentId,environment,fiscalActivation,owner,schemaVersion,state'||r.schemaVersion!=='factuez.b2b.owner-runtime.v1'||
   r.environment!=='BETA'||r.owner!==owner||r.deploymentId!==deploymentId||r.state!=='ASSEMBLED_AND_STORAGE_CHECKED'||r.fiscalActivation!==false||
   typeof r.bootId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(r.bootId)||boots.has(r.bootId)||
   !Array.isArray(r.capabilities)||JSON.stringify([...r.capabilities].sort())!==JSON.stringify([...b2bOwnerRuntimeCapabilities[owner]].sort()))throw Error('B2B_OWNER_GRAPH_NOT_READY');
  boots.add(r.bootId);
 }
}
/** Explicit entrypoint; absent opt-in performs no reads, connections or listens.
 * It neither migrates owner databases nor creates clients/grants or emits CPE. */
export async function bootstrapB2bApi(env:NodeJS.ProcessEnv=process.env){
 if(env.B2B_API_ENABLED!=='true')return null;
 const root=env.B2B_API_CONFIG_ROOT;if(!root)throw Error('B2B_API_CONFIG_ROOT_REQUIRED');
 const files=new B2bRuntimeFiles(root),config=b2bApiRuntimeConfig(files.metadata());
 const ca=files.publicPem('ca.pem'),tls={ca,cert:files.publicPem('server.crt'),key:files.privatePem('server.key')};
 const resource={ca,cert:files.publicPem('resource.crt'),key:files.privatePem('resource.key')},admin={ca,cert:files.publicPem('administrator.crt'),key:files.privatePem('administrator.key')};
 const resources=Object.fromEntries(b2bRuntimeOwners.map(owner=>[owner,new B2bPrivateHttp(config.origins[owner],resource)])) as B2bFacadeTransports['resources'];
 const administrators=Object.fromEntries((['identity','billing','fiscal','mailer'] as const).map(owner=>[owner,new B2bPrivateHttp(config.origins[owner],admin)])) as B2bFacadeTransports['administrators'];
 const policy=new FileB2bOperationalPolicy(root);if((await policy.current()).mode!=='PAUSED')throw Error('INITIAL_B2B_API_POLICY_MUST_BE_PAUSED');
 await verifyB2bOwnerGraph(resources,config.deploymentId);
 const operations=new B2bOperationalControl(policy,{enabled:true}),app=await assembleB2bFacade({resources,administrators},{tls,peers:config.edgePeers,operations,
  localIssuanceEnabled:config.localIssuanceEnabled,localConversionEnabled:config.localConversionEnabled,automaticReceivedApprovals:config.automaticReceivedApprovals??false});
 const maintenance=new B2bMaintenanceNode({enabled:true,deploymentId:config.deploymentId,instance:{service:'B2B_API',instanceId:config.instanceId,bootId:randomUUID()},hooks:{
  ADMISSION:async()=>{operations.pause();},PRODUCERS:async()=>{},
  WORKERS:async()=>{while((await operations.drain(30000)).state!=='DRAINED'){/* Never force an unfinished business commit. */}},
  STORAGE:async()=>{await app.close();},
 }});
 try{
  await maintenance.listen({host:config.listen.host,port:config.listen.maintenancePort,tls,operatorPeers:config.operatorPeers});
  await app.listen(config.listen.port,config.listen.host);
 }catch{await app.close();await maintenance.closeListener();throw Error('B2B_API_STARTUP_FAILED');}
 let closing:Promise<void>|undefined;
 const shutdown=()=>closing??=(async()=>{
  try{await stopB2bMaintenanceNode(maintenance);}
  catch{process.exitCode=1;/* No forced process exit or shutdown success receipt. */}
 })();
 process.once('SIGTERM',()=>{void shutdown();});process.once('SIGINT',()=>{void shutdown();});
 return {app,operations,maintenance};
}
if(require.main===module)void bootstrapB2bApi().catch(()=>{process.stderr.write('B2B_API_STARTUP_BLOCKED\n');process.exitCode=1;});
