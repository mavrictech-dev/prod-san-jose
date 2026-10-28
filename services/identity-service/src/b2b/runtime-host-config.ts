import {join,resolve} from 'node:path';
import {runtimeObject} from './runtime-config';
import {ownerAdministrationPeers,type OwnerAdministrationPeers} from './owner-administration';
export interface B2bIdentityHostConfig {
 schemaVersion:'factuez.b2b.identity-host.v1';environment:'BETA';mode:'STANDALONE';workerCoordination:'GLOBAL_PHASE_BARRIER';
 database:{host:string;port:number;user:string;name:string;passwordFile:string};
 privileged:{clientId:string;policyRevision:string};
 administrationPeers?:OwnerAdministrationPeers;
 emailWorkerPeers?:readonly string[];
 billingPermissionPeers?:readonly string[];
 receivedApprovals?:{clientId:string;preparePeers:readonly string[];verifyPeers:readonly string[]};
}
export function b2bIdentityHostConfig(value:unknown):B2bIdentityHostConfig {
 try{
  if(!runtimeObject(value,['schemaVersion','environment','mode','workerCoordination','database','privileged'],['administrationPeers','receivedApprovals','emailWorkerPeers','billingPermissionPeers'])||value.schemaVersion!=='factuez.b2b.identity-host.v1'||value.environment!=='BETA'||
   value.mode!=='STANDALONE'||value.workerCoordination!=='GLOBAL_PHASE_BARRIER'||!runtimeObject(value.database,['host','port','user','name','passwordFile'])||!runtimeObject(value.privileged,['clientId','policyRevision']))throw Error();
  const d=value.database,p=value.privileged;
  if(typeof d.host!=='string'||!/^[a-zA-Z0-9.-]{1,253}$/.test(d.host)||!Number.isInteger(d.port)||d.port<1||d.port>65535||
   typeof d.user!=='string'||!/^[a-z][a-z0-9_]{0,62}$/.test(d.user)||typeof d.name!=='string'||!/^[a-z][a-z0-9_]{0,57}_beta$/.test(d.name)||
   typeof d.passwordFile!=='string'||!/^[a-z][a-z0-9-]{0,63}\.bin$/.test(d.passwordFile)||typeof p.clientId!=='string'||!/^[A-Za-z0-9_-]{1,120}$/.test(p.clientId)||
   typeof p.policyRevision!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(p.policyRevision))throw Error();
  if(value.administrationPeers!==undefined)ownerAdministrationPeers(value.administrationPeers);
  if(value.emailWorkerPeers!==undefined&&(!Array.isArray(value.emailWorkerPeers)||!value.emailWorkerPeers.length||value.emailWorkerPeers.length>32||
   new Set(value.emailWorkerPeers).size!==value.emailWorkerPeers.length||value.emailWorkerPeers.some(p=>typeof p!=='string'||!/^[a-f0-9]{64}$/.test(p))))throw Error();
  if(value.billingPermissionPeers!==undefined&&(!Array.isArray(value.billingPermissionPeers)||!value.billingPermissionPeers.length||value.billingPermissionPeers.length>32||
   new Set(value.billingPermissionPeers).size!==value.billingPermissionPeers.length||value.billingPermissionPeers.some(p=>typeof p!=='string'||!/^[a-f0-9]{64}$/.test(p))))throw Error();
  if(value.receivedApprovals!==undefined){
   const a=value.receivedApprovals;if(!runtimeObject(a,['clientId','preparePeers','verifyPeers'])||typeof a.clientId!=='string'||!/^[A-Za-z0-9_-]{1,120}$/.test(a.clientId))throw Error();
   for(const peers of [a.preparePeers,a.verifyPeers])if(!Array.isArray(peers)||!peers.length||peers.length>32||new Set(peers).size!==peers.length||peers.some(p=>typeof p!=='string'||!/^[a-f0-9]{64}$/.test(p)))throw Error();
   if(a.preparePeers.some((p:string)=>a.verifyPeers.includes(p)))throw Error();
  }
  return structuredClone(value) as B2bIdentityHostConfig;
 }catch{throw Error('B2B_IDENTITY_HOST_CONFIGURATION_INVALID');}
}
/** Existing PrismaService consumes this exact owner environment. Never rewrite process.env or accept DATABASE_URL overrides. */
export function checkB2bIdentityDatabaseEnvironment(config:B2bIdentityHostConfig,root:string,env:NodeJS.ProcessEnv){
 const d=config.database;
 if(env.DATABASE_URL!==undefined||env.DB_HOST!==d.host||env.DB_PORT!==String(d.port)||env.DB_USER!==d.user||env.DB_NAME!==d.name||
  typeof env.DB_PASSWORD_FILE!=='string'||resolve(env.DB_PASSWORD_FILE)!==resolve(join(root,d.passwordFile)))throw Error('B2B_IDENTITY_DATABASE_MOUNT_REQUIRED');
}
