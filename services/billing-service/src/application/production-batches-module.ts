import { readFileSync } from 'node:fs';
import { ProductionBatchesAuthenticator } from '@factuez/sunat-core/dist/production-batches-proof';
import { ProductionBatchesOwnerService,ProductionBatchesEvidencePort,PRODUCTION_BATCHES_OWNER_AUTH } from './production-batches-owner.service';
import { ProductionBatchesEvidenceClient } from '../infrastructure/production-batches-evidence.client';
import { ProductionBatchesRouteController } from './production-batches-route-controller';
import { ProductionBatchesOwnerController } from './production-batches-controller';
import { ProductionBatchesOwnerRuntime,PRODUCTION_BATCHES_STATUS_VERIFIER } from './production-batches-runtime';
/** Lazy key loading: disabled module construction reads no secrets and starts no worker.
 * Dedicated keys, not notes/issuance keys. Main supplies local secret mounts; no placeholder keys. */
const auth=(file:string,audience:'billing-owner'|'sunat-status')=>new ProductionBatchesAuthenticator(()=>{
 const path=process.env[file];if(!path)throw Error('Clave HMAC dedicada de lotes no configurada');
 const key=readFileSync(path);if(key.length<32||key.length>128)throw Error('Clave HMAC de lotes inválida');return key;
},audience);
export const PRODUCTION_BATCHES_BILLING_CONTROLLERS=[ProductionBatchesOwnerController,ProductionBatchesRouteController];
export const PRODUCTION_BATCHES_BILLING_PROVIDERS=[
 ProductionBatchesOwnerService,ProductionBatchesEvidenceClient,ProductionBatchesOwnerRuntime,
 {provide:ProductionBatchesEvidencePort,useExisting:ProductionBatchesEvidenceClient},
 {provide:PRODUCTION_BATCHES_OWNER_AUTH,useFactory:()=>auth('PRODUCTION_BATCHES_OWNER_KEY_FILE','billing-owner')},
 {provide:PRODUCTION_BATCHES_STATUS_VERIFIER,useFactory:()=>auth('PRODUCTION_BATCHES_STATUS_KEY_FILE','sunat-status')},
];
export const PRODUCTION_BATCHES_BILLING_EXPORTS=[ProductionBatchesOwnerService,ProductionBatchesOwnerRuntime];
