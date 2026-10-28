import {createB2bDraftApplication,type B2bPhase8Modules} from './draft-application';
import type {createB2bPhase7Application} from './phase7-application';
/** Explicit phase08 composition. Each optional owner is independently supplied;
 * absent owners do not register routes or gain capabilities. No main/bootstrap,
 * automatic grants, SIRE execution or current-stack deployment. */
export function createB2bPhase8Application(options:Parameters<typeof createB2bPhase7Application>[0]&{phase8:B2bPhase8Modules}){
  if(!options.phase8?.received)throw new Error('EXPLICIT_PHASE8_RECEPTION_REQUIRED');
  return createB2bDraftApplication(options.read,options.commands,options.peers,options.tls,options.extraction,options.webhooks,
    options.commercial,options.corrections,options.guides,options.preparation,options.phase7,options.phase8);
}
