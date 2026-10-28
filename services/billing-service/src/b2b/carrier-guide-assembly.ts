import type { GuideEstablishmentDatabase } from './guide-establishment-store';
import type { CarrierGuideAuthority } from './carrier-guide-model';
import type { CarrierReferenceSignatureCdrValidator } from './carrier-guide-reference';
import { CarrierGuideOwner } from './carrier-guide-owner';
import { PostgresCarrierGuideStore } from './carrier-guide-store';

/** Inert, opt-in assembly. The actual PostgreSQL reference adapter is constructed
 * INSIDE the owner's transaction; callers cannot substitute an approved boolean
 * or a fake owner projection into the profile renderer. */
export function createCarrierGuideOwner(dependencies: {
  database: GuideEstablishmentDatabase; authority: CarrierGuideAuthority;
  referenceValidator: CarrierReferenceSignatureCdrValidator; allowedRucs: readonly string[]; now?: () => string;
}) {
  return new CarrierGuideOwner(new PostgresCarrierGuideStore(dependencies.database), dependencies.authority,
    dependencies.referenceValidator, dependencies.allowedRucs, dependencies.now);
}
export { CarrierGuideOwner } from './carrier-guide-owner';
export { PostgresCarrierGuideStore } from './carrier-guide-store';
export { PostgresCarrierReference09Owner, createCarrierReference09Ingestion, projectCarrierPublic09Owner } from './carrier-guide-reference';
export type { CarrierGuideAuthority, CarrierGuideBinding, CarrierGuideIssuance, CarrierGuideProof,
  CarrierGuideRequest, CarrierGuideScope, CarrierIssuedSnapshot } from './carrier-guide-model';
export type { CarrierReferenceSignatureCdrValidator, CarrierPublic09OwnerSnapshot, CarrierReferenceValidationInput } from './carrier-guide-reference';
