import { createB2bDraftApplication, type B2bPhase7Modules } from './draft-application';
import type { B2bReads } from './read';
import type { B2bCommands } from './commands';
import type { B2bExports } from './extraction';
import type { B2bWebhooks } from './webhooks';
import type { B2bCommercialCommands } from './commercial';
import type { B2bCorrections } from './corrections';
import type { B2bGuideCommands } from './guides';
import type { B2bGuidePreparations } from './guide-preparation';

/** Explicit candidate composition, not an executable entry point. The host must
 * provide real owners, independent grants and pinned peers. No env defaults,
 * queue consumers, migration, listener bind, Kong change or fiscal activation. */
export function createB2bPhase7Application(options: {
  read:B2bReads; commands:B2bCommands; peers:string[]; tls:{ca:Buffer;cert:Buffer;key:Buffer};
  phase7:B2bPhase7Modules; extraction?:B2bExports; webhooks?:B2bWebhooks;
  commercial?:B2bCommercialCommands; corrections?:B2bCorrections; guides?:B2bGuideCommands;
  preparation?:B2bGuidePreparations;
}) {
  if(!options.phase7 || !options.phase7.guideIssuance || !options.phase7.guideArtifacts || !options.phase7.carrier || !options.phase7.batches || !options.phase7.batchArtifacts)
    throw new Error('EXPLICIT_PHASE7_OWNERS_REQUIRED');
  return createB2bDraftApplication(options.read,options.commands,options.peers,options.tls,options.extraction,options.webhooks,
    options.commercial,options.corrections,options.guides,options.preparation,options.phase7);
}
