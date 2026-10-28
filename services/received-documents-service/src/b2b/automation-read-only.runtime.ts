import type {B2bIdentityPort} from '@factuez/service-access/dist/b2b-read-adapter';
import type {ReceivedDatabase} from './store';
import type {ReceptionAutomationAuthority} from './automation-authority';
import type {ReceptionWriteAuthority} from './commands';
import type {ReceptionDispatchAuthority} from './automation-dispatch';
import {B2bReceptionReadOnlyDispatch} from './automation-read-only';
import {FixedReceptionReadOnlyAdmission,ServiceReceptionDispatchAuthority} from './automation-read-only.authority';
import {B2bReceptionReadOnlySource,type B2bReceptionReadOnlySourceOptions} from './automation-read-only.source';
import {HttpReceptionServiceTokenProvider,type ReceptionServiceTokenConfig} from './automation-read-only.token';
import type {ReceptionAutomationVault} from './automation';
import type {ReadOnlyReceptionBinding,ReadOnlyReceptionSource} from './automation-read-only.types';
import {createB2bReceivedDispatchQueue,type B2bReceivedDispatchConnection,type B2bReceivedDispatchOptions} from './automation-dispatch-queue';
export type ReadOnlyReceptionDependencies={database:ReceivedDatabase;identity:B2bIdentityPort;automationAuthority:ReceptionAutomationAuthority;
 writeAuthority:ReceptionWriteAuthority;executionAuthority:ReceptionDispatchAuthority;bindings:readonly ReadOnlyReceptionBinding[];
 source:ReadOnlyReceptionSource;connection:B2bReceivedDispatchConnection};
/** Explicit private deployment composition. Separate queue and protocol; does
 * not modify LOCAL guards, install DDL, enable an issuer or make network calls
 * until the caller enables this runtime AND a matching approved task exists. */
export async function createB2bReceptionReadOnlyRuntime(d:ReadOnlyReceptionDependencies,options:B2bReceivedDispatchOptions={}){
 if(options?.enabled!==true)return createB2bReceivedDispatchQueue(d?.connection,{} as never,{enabled:false});
 if(options.profile!==undefined&&options.profile!=='LIVE_READ_ONLY'||!d||typeof d.database?.$transaction!=='function'||typeof d.identity?.authenticate!=='function'||
  typeof d.automationAuthority?.authorize!=='function'||typeof d.writeAuthority?.authorize!=='function'||typeof d.executionAuthority?.authorize!=='function'||typeof d.source?.read!=='function')throw new Error('B2B_RECEIVED_READ_ONLY_EXPLICIT_OWNER_REQUIRED');
 const admission=new FixedReceptionReadOnlyAdmission(d.bindings),core=new B2bReceptionReadOnlyDispatch(d.database,d.identity,d.automationAuthority,d.writeAuthority,d.source,{enabled:true,executionAuthority:d.executionAuthority,admission});
 return createB2bReceivedDispatchQueue(d.connection,{run:id=>core.run(id),pending:limit=>core.pending(limit)},{...options,profile:'LIVE_READ_ONLY'});
}
/** Complete original-SERVICE assembly: private OAuth/mTLS -> current Identity
 * -> independent grants/deployment admission -> vault -> read-only source ->
 * transactional owner commit. TI supplies configuration/secret readers only;
 * there is no custom execution-authority implementation left to invent. */
export async function createB2bServiceReceptionReadOnlyRuntime(
 d:Omit<ReadOnlyReceptionDependencies,'executionAuthority'|'source'> & {
  vault:Pick<ReceptionAutomationVault,'open'>;token:ReceptionServiceTokenConfig;sourceOptions?:B2bReceptionReadOnlySourceOptions;
 },options:B2bReceivedDispatchOptions={}){
 if(options?.enabled!==true)return createB2bReceivedDispatchQueue(d?.connection,{} as never,{enabled:false});
 const provider=new HttpReceptionServiceTokenProvider({...d.token,enabled:true});
 const executionAuthority=new ServiceReceptionDispatchAuthority(d.identity,c=>provider.credentials(c));
 const source=new B2bReceptionReadOnlySource(d.vault,d.sourceOptions);
 return createB2bReceptionReadOnlyRuntime({...d,executionAuthority,source},options);
}
