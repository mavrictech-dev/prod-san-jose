import {createB2bDraftApplication} from './draft-application';
import type {createB2bPhase8Application} from './phase8-application';
import {B2bOperationalControl} from './operational-control';

/** Private operational composition. Does not bind a listener, enroll clients,
 * install schemas, schedule workers, change Kong or activate any fiscal path. */
export function createB2bPhase9Application(options:Parameters<typeof createB2bPhase8Application>[0]&{operations:B2bOperationalControl}){
 if(!options?.phase8?.received||!(options.operations instanceof B2bOperationalControl))throw new Error('EXPLICIT_B2B_PHASE9_OPERATIONS_REQUIRED');
 return createB2bDraftApplication(options.read,options.commands,options.peers,options.tls,options.extraction,options.webhooks,
  options.commercial,options.corrections,options.guides,options.preparation,options.phase7,options.phase8,options.operations);
}
