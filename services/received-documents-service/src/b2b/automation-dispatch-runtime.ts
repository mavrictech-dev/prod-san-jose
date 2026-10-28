import type {B2bIdentityPort} from '@factuez/service-access/dist/b2b-read-adapter';
import type {ReceivedDatabase} from './store';
import type {ReceptionAutomationAuthority} from './automation-authority';
import type {ReceptionWriteAuthority} from './commands';
import {B2bReceptionDispatch,type ReceptionDispatchAuthority} from './automation-dispatch';
import {createB2bReceivedDispatchQueue,type B2bReceivedDispatchConnection,type B2bReceivedDispatchOptions} from './automation-dispatch-queue';

export type ReceptionDispatchRuntimeDependencies={database:ReceivedDatabase;identity:B2bIdentityPort;
 automationAuthority:ReceptionAutomationAuthority;writeAuthority:ReceptionWriteAuthority;
 executionAuthority:ReceptionDispatchAuthority;connection:B2bReceivedDispatchConnection};
/** Private composition only. Not installed by AppModule, CLI auto-main, HTTP,
 * Docker Compose or a settings save. Never changes a connection's enabled flag.
 * The execution authority must be provided by the owner, not by a public caller. */
export async function createB2bReceptionDispatchRuntime(dependencies:ReceptionDispatchRuntimeDependencies,options:B2bReceivedDispatchOptions={}){
 if(options?.enabled!==true)return createB2bReceivedDispatchQueue(dependencies?.connection,{} as never,{enabled:false});
 if(!dependencies?.executionAuthority||typeof dependencies.executionAuthority.authorize!=='function'||
  typeof dependencies.database?.$transaction!=='function'||typeof dependencies.identity?.authenticate!=='function'||
  typeof dependencies.automationAuthority?.authorize!=='function'||typeof dependencies.writeAuthority?.authorize!=='function')throw new Error('B2B_RECEIVED_DISPATCH_EXPLICIT_OWNER_REQUIRED');
 const core=new B2bReceptionDispatch(dependencies.database,dependencies.identity,dependencies.automationAuthority,dependencies.writeAuthority,
  {enabled:true,authority:dependencies.executionAuthority});
 if(options.profile!==undefined&&options.profile!=='LOCAL_ONLY')throw new Error('B2B_RECEIVED_DISPATCH_PROFILE_MISMATCH');
 return createB2bReceivedDispatchQueue(dependencies.connection,{run:id=>core.run(id),pending:limit=>core.pending(limit)},{...options,profile:'LOCAL_ONLY'});
}
