/** Native GRE contract. No HTTP payload can supply grants, trust, signatures or credentials. */
export const PRODUCTION_GUIDES_VERSION = 'factuez.production-guides.v1' as const;
export const PRODUCTION_GUIDES_ISSUED = 'billing.production-guides.issued.v1';
export const PRODUCTION_GUIDES_STATUS = 'sunat.production-guides.status.v1';
export const PRODUCTION_GUIDES_PROFILES = ['GRE09_PRIVATE04_V1','GRE09_PUBLIC01_V1','GRE31_PUBLIC_SINGLE09_V1','GRE09_HYDROCARBON_PRIVATE04_V1','GRE09_HYDROCARBON_PUBLIC01_V1','GRE09_HYDROCARBON_PRIVATE02_V1'] as const;
export type ProductionGuidesProfile = typeof PRODUCTION_GUIDES_PROFILES[number];
export const GRE_GOODS_FAMILIES = ['UNCLASSIFIED','NON_REGULATED','DIESEL','GASOHOL_PREMIUM','GASOHOL_REGULAR','GLP','GNV'] as const;
export type GreGoodsFamily = typeof GRE_GOODS_FAMILIES[number];
export type HydrocarbonFamily = Exclude<GreGoodsFamily,'UNCLASSIFIED'|'NON_REGULATED'|'GNV'>;
/** Application metadata, never an invented SUNAT API field or BF document. One cargo family per guide. */
export type HydrocarbonCargo = {schemaVersion:'factuez.gre-hydrocarbon.v1';family:HydrocarbonFamily;scopCode:string|null;handoverDate:string|null;
 senderRegistration:string;carrierRegistration:string|null;vehicleAuthorization:string|null};
export type PurchaseFuelFamily = 'DIESEL'|'GASOHOL_REGULAR'|'GASOHOL_PREMIUM';
/** Only PRIVATE02: exact product codes bind quantities/units in body.items to family and SCOP.
 * UBL represents the distinct SCOPs as related documents (catalogue 61, code 81).
 * No proprietary per-line SUNAT fields are invented. Existing cargo v1 is unchanged. */
export type HydrocarbonPurchaseCargo = {schemaVersion:'factuez.gre-hydrocarbon.v2';
 items:{code:string;family:PurchaseFuelFamily;scopCode:string}[];
 handoverDate:null;senderRegistration:string;carrierRegistration:null;vehicleAuthorization:string};
export type HydrocarbonGuideCargo = HydrocarbonCargo|HydrocarbonPurchaseCargo;
/** Reviewed per branch, product, exact route and modality. No regional tax exemption is inferred. */
export type HydrocarbonApprovalV1 = {branchId:string;profile:'GRE09_HYDROCARBON_PRIVATE04_V1'|'GRE09_HYDROCARBON_PUBLIC01_V1';
 family:HydrocarbonFamily;routeSha256:string;routeUbigeos:string[];geography:'OUTSIDE_SPECIAL_ZONE'|'SPECIAL_ZONE';
 documentRegime:'ORDINARY_GRE';senderRegistration:string;carrierRuc:string|null;carrierLegalName:string|null;mtcRegistration:string|null;carrierRegistration:string|null;
 vehiclePlate:string|null;vehicleAuthorization:string|null;scopRequired:boolean;sourceUrl:string;sourceSha256:string;validUntil:string};
export type HydrocarbonPurchaseApproval = Omit<HydrocarbonApprovalV1,'profile'|'family'> & {
 profile:'GRE09_HYDROCARBON_PRIVATE02_V1';family:PurchaseFuelFamily;supplier:{ruc:string;legalName:string}};
export type HydrocarbonApproval = HydrocarbonApprovalV1|HydrocarbonPurchaseApproval;
export type ProductionGuidesState = 'RESERVED' | 'PREPARED' | 'POSTING' | 'UNKNOWN' | 'TICKET' | 'ACCEPTED' | 'ACCEPTED_WITH_OBSERVATIONS' | 'REJECTED' | 'FAILED_NO_CDR';
/** Compra09/private02 only: a supplied code belongs to supplier at origin, issuer at arrival.
 * Omit the property when not declared; branch authorization does not select the destination. */
export type ProductionGuidesPurchaseAddress = {ubigeo:string;address:string;establishmentCode?:string};
export type ProductionGuidesScope = { companyId: number; issuerRuc: string; branchId: string; pointId: string; seriesCounterId: string; establishmentCode: string };
export type ProductionGuidesServiceActor = {kind:'SERVICE';clientId:string;revision:number;environment:'PRODUCTION'};
export type ProductionGuidesSnapshot = {
 createdByActor?:ProductionGuidesServiceActor;
 schemaVersion: typeof PRODUCTION_GUIDES_VERSION; documentId: string; operationId: string; actorId: string;
 scope: ProductionGuidesScope; issuer: { ruc: string; legalName: string }; documentType: '09' | '31';
 profile: ProductionGuidesProfile; series: string; number: string; body: unknown; grantVersion: number;
 createdAt: string; environment: 'PRODUCTION';
};
export type ProductionGuidesSeal = { keyId: string; signature: string };
export type ProductionGuidesIssued = { eventId: string; eventType: typeof PRODUCTION_GUIDES_ISSUED; snapshot: ProductionGuidesSnapshot; snapshotSha256: string; seal: ProductionGuidesSeal };
export type ProductionGuidesResult = { documentId: string; snapshotSha256: string; state: ProductionGuidesState;
 revision: number; ticket?: string; xmlSha256?: string; zipSha256?: string; cdrZipSha256?: string;
 source: 'SUNAT_OFFICIAL' | 'LOCAL_SYNTHETIC'; officialCdrVerified: boolean; authorizedForTransfer: false;
 /** Bounded public details from verified CDR; raw signed originals remain the evidence. */
 responseCode?: string; description?: string; notes?: string[];
 /** Unauthenticated ticket diagnostic, never evidence of acceptance. */
 functionalError?: { code?: string; message?: string };
 /** Only from an accepted, authenticated and document-bound official CDR. */
 qrUrl?: string };
export type ProductionGuidesStatusEvent = { eventId: string; eventType: typeof PRODUCTION_GUIDES_STATUS; result: ProductionGuidesResult; seal: ProductionGuidesSeal };
export type ProductionGuidesGrant = ProductionGuidesScope & { createdByActor?:ProductionGuidesServiceActor; actorId: string; version: number; enabled: boolean;
 profiles: ProductionGuidesProfile[]; credentialRevision: number; certificateFingerprint: string;
 rulesSha256: string; xsdSha256: string; expiresAt: string };
export interface ProductionGuidesSigner { sign(value: unknown, purpose: 'ISSUED' | 'STATUS'): ProductionGuidesSeal }
export interface ProductionGuidesVerifier { verify(value: unknown, seal: ProductionGuidesSeal, purpose: 'ISSUED' | 'STATUS'): boolean }
export interface ProductionGuidesOwnerPort {
 /** Revalidate current native owner, grant version and scope; never trust an event alone. */
 current(event: ProductionGuidesIssued): Promise<ProductionGuidesGrant>;
 reference09(snapshot: ProductionGuidesSnapshot): Promise<ProductionGuidesReference09>;
}
export type ProductionGuidesReference09 = { snapshot: ProductionGuidesSnapshot; projection: unknown;
 projectionSha256: string; cdrZipSha256: string; source: 'SUNAT_OFFICIAL'; signatureTrusted: true;
 state: 'ACCEPTED' | 'ACCEPTED_WITH_OBSERVATIONS'; acceptedAt: string };
export type ProductionGuidesArtifactKind = 'signed-xml' | 'submission-zip' | 'cdr-xml' | 'cdr-zip';
export type ProductionGuidesArtifact = { name: string; mediaType: string; sha256: string; bytes: Buffer };
export interface ProductionGuidesReadPort {
 status(event: ProductionGuidesIssued): Promise<ProductionGuidesResult>;
 artifact(event: ProductionGuidesIssued, kind: ProductionGuidesArtifactKind): Promise<ProductionGuidesArtifact>;
 pdf(event: ProductionGuidesIssued): Promise<Buffer>;
}
