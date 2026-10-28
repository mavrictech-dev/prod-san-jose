import { readFileSync } from 'node:fs';
import { ProductionBatchesAuthenticator } from '@factuez/sunat-core/dist/production-batches-proof';
import { ProductionBatchesController } from './production-batches-controller';
import { ProductionBatchesRepository,PRODUCTION_BATCHES_OWNER_VERIFIER,PRODUCTION_BATCHES_STATUS_AUTH } from './production-batches-repository';
import { ProductionBatchesRoutingService } from './production-batches-routing.service';
import { ProductionBatchesNumberingService } from './production-batches-numbering.service';
import { ProductionBatchesPolicyService } from './production-batches-policy.service';
import { ProductionBatchesEvidenceService } from './production-batches-evidence.service';
import { ProductionBatchesDispatchService } from './production-batches-dispatch.service';
import { ProductionBatchesSunatRuntime } from './production-batches-runtime';
const auth=(file:string,audience:'billing-owner'|'sunat-status')=>new ProductionBatchesAuthenticator(()=>{
 const path=process.env[file];if(!path)throw Error('Clave HMAC dedicada de lotes no configurada');
 const key=readFileSync(path);if(key.length<32||key.length>128)throw Error('Clave HMAC de lotes inválida');return key;
},audience);
/** Add to owning AppModule arrays where Prisma, ProductionPdfService, ProductionNotesEvidenceService,
 * FiscalConfigurationService, FiscalReadinessService and existing crypto/artifact services are visible. */
export const PRODUCTION_BATCHES_SUNAT_CONTROLLERS=[ProductionBatchesController];
export const PRODUCTION_BATCHES_SUNAT_PROVIDERS=[
 ProductionBatchesRepository,ProductionBatchesRoutingService,ProductionBatchesNumberingService,ProductionBatchesPolicyService,
 ProductionBatchesEvidenceService,ProductionBatchesDispatchService,ProductionBatchesSunatRuntime,
 {provide:PRODUCTION_BATCHES_OWNER_VERIFIER,useFactory:()=>auth('PRODUCTION_BATCHES_OWNER_KEY_FILE','billing-owner')},
 {provide:PRODUCTION_BATCHES_STATUS_AUTH,useFactory:()=>auth('PRODUCTION_BATCHES_STATUS_KEY_FILE','sunat-status')},
];
export const PRODUCTION_BATCHES_SUNAT_EXPORTS=[ProductionBatchesRoutingService,ProductionBatchesNumberingService,ProductionBatchesEvidenceService,ProductionBatchesRepository,ProductionBatchesSunatRuntime];
