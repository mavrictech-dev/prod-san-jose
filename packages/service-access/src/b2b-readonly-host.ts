import {B2bRuntimeFiles} from './b2b-runtime-files';
import {mountedB2bPostgres} from './b2b-postgres-options';
import {readonlyOwnerOptions,type ReadonlyOwnerOptions} from './b2b-readonly-owner';
type Owner='identity'|'billing'|'fiscal';
/** Explicit mounted configuration for NEW isolated review owners. No discovery,
 * schema installation or fallback to the host application's DATABASE_URL. */
export function readReadonlyOwnerHost(env:NodeJS.ProcessEnv,owner:Owner){
 if(env.B2B_READONLY_OWNER_ENABLED!=='true')return null;
 if(env.B2B_PRIVATE_ACCESS!=='true'||!env.B2B_READONLY_OWNER_CONFIG_ROOT)throw Error('B2B_PRIVATE_ACCESS_AND_READONLY_CONFIG_REQUIRED');
 const files=new B2bRuntimeFiles(env.B2B_READONLY_OWNER_CONFIG_ROOT),c=files.metadata('readonly-owner.json');
 const common=['schemaVersion','profile','owner','environment','approvedForPrivateBeta','deploymentId','listen','callers','database'];
 const extras=owner==='identity'?['tokenPeers','webhookPeers','billingOrigin','tokenIssuer']:owner==='billing'?['registrar','identityOrigin']:['identityOrigin','billingOrigin','artifactsRoot'];
 if(Object.keys(c).sort().join(',')!==[...common,...extras].sort().join(',')||c.schemaVersion!=='factuez.b2b.readonly-owner.v1'||
  c.profile!=='READONLY_OAUTH_WEBHOOKS'||c.owner!==owner||c.environment!=='BETA'||c.approvedForPrivateBeta!==true||
  !c.database||c.database.name!==owner+'_readonly_beta')throw Error('B2B_READONLY_OWNER_MOUNT_INVALID');
 const ca=files.publicPem('ca.pem'),tls={ca,cert:files.publicPem('server.crt'),key:files.privatePem('server.key')};
 const resource={ca,cert:files.publicPem('resource.crt'),key:files.privatePem('resource.key')};
 const options:ReadonlyOwnerOptions={enabled:true,B2B_PRIVATE_ACCESS:true,environment:'BETA',deploymentId:c.deploymentId,listen:c.listen,tls,callers:c.callers};
 readonlyOwnerOptions(options);
 return {files,config:c,options,resource,database:mountedB2bPostgres(files,c.database)};
}
export function readonlyHostShutdown(close:()=>Promise<void>){
 let pending:Promise<void>|undefined;
 const stop=()=>pending??=close();
 const signal=()=>{void stop().catch(()=>{process.exitCode=1;});};
 process.once('SIGTERM',signal);process.once('SIGINT',signal);
 return async()=>{await stop();process.removeListener('SIGTERM',signal);process.removeListener('SIGINT',signal);};
}
