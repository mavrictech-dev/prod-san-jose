import {B2bRuntimeFiles} from '@factuez/service-access/dist/b2b-runtime-files';
import {mountedB2bPostgres} from '@factuez/service-access/dist/b2b-postgres-options';
import {validateB2bReceivedRuntimeConfig,validateB2bReceivedRuntimeCredentials} from './runtime-config';
import type {B2bReceivedRuntimeTls} from './runtime-config';
import type {B2bReceivedStepUpEndpoint} from './runtime-authority';
/** Explicit fixed filenames. Called only after host opt-in; no .env discovery. */
export function loadB2bReceivedRuntimeMount(root:string){
 try{
  const files=new B2bRuntimeFiles(root),m=files.metadata();
  if(Object.keys(m).sort().join(',')!=='database,identityOrigin,runtime,schemaVersion,stepUp'||m.schemaVersion!=='factuez.b2b.received-runtime.v1')throw Error();
  const config=validateB2bReceivedRuntimeConfig(m.runtime);
  // This B2B-only host never starts a scheduler, connector or OAuth worker.
  if(config.readOnlyExecution?.enabled===true)throw Error();
  const identity=new URL(m.identityOrigin);if(identity.protocol!=='https:'||identity.pathname!=='/'||identity.username||identity.password||identity.search||identity.hash)throw Error();
  const stepUp=m.stepUp as B2bReceivedStepUpEndpoint;
  if(!stepUp||Object.keys(stepUp).sort().join(',')!==(Object.hasOwn(stepUp,'prepareEndpoint')?'endpoint,prepareEndpoint,serverFingerprintSha256':'endpoint,serverFingerprintSha256'))throw Error();
  if(stepUp.prepareEndpoint!==undefined){const p=new URL(stepUp.prepareEndpoint),v=new URL(stepUp.endpoint);if(typeof stepUp.prepareEndpoint!=='string'||p.origin!==v.origin||p.protocol!=='https:'||p.username||p.password||p.search||p.hash||p.pathname!=='/internal/b2b/received-stepup/prepare')throw Error();}
  const tls=(prefix:string):B2bReceivedRuntimeTls=>({ca:files.publicPem(prefix+'-ca.pem'),cert:files.publicPem(prefix+'.crt'),key:files.privatePem(prefix+'.key')});
  const credentials=validateB2bReceivedRuntimeCredentials({apiTls:tls('api'),controlTls:tls('operator')});
  const outbound=validateB2bReceivedRuntimeCredentials({apiTls:tls('identity'),controlTls:tls('stepup')});
  const stepUpPrepareTls=stepUp.prepareEndpoint===undefined?undefined:validateB2bReceivedRuntimeCredentials({apiTls:outbound.controlTls,controlTls:tls('stepup-prepare')}).controlTls;
  const database=mountedB2bPostgres(files,m.database);
  const key=files.secretBytes('received-settings.bin');if(key.length!==32){key.fill(0);throw Error();}
  return {config,credentials,database,identityOrigin:identity.origin,identityTls:outbound.apiTls,stepUp,stepUpTls:outbound.controlTls,stepUpPrepareTls,vaultMaster:key};
 }catch{throw Error('B2B_RECEIVED_MOUNTED_CONFIG_INVALID');}
}
