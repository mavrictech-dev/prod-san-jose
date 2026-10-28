/** Native GRE contract. No HTTP payload can supply grants, trust, signatures or credentials. */
export const PRODUCTION_GUIDES_VERSION = 'factuez.production-guides.v1' as const;
export const PRODUCTION_GUIDES_ISSUED = 'billing.production-guides.issued.v1';
export const PRODUCTION_GUIDES_STATUS = 'sunat.production-guides.status.v1';
export type ProductionGuidesProfile = 'GRE09_PRIVATE04_V1' | 'GRE09_PUBLIC01_V1' | 'GRE31_PUBLIC_SINGLE09_V1';
export type ProductionGuidesState = 'RESERVED' | 'PREPARED' | 'POSTING' | 'UNKNOWN' | 'TICKET' | 'ACCEPTED' | 'ACCEPTED_WITH_OBSERVATIONS' | 'REJECTED' | 'FAILED_NO_CDR';
export type ProductionGuidesScope = { companyId: number; issuerRuc: string; branchId: string; pointId: string; seriesCounterId: string; establishmentCode: string };
export type ProductionGuidesSnapshot = {
 schemaVersion: typeof PRODUCTION_GUIDES_VERSION; documentId: string; operationId: string; actorId: string;
 scope: ProductionGuidesScope; issuer: { ruc: string; legalName: string }; documentType: '09' | '31';
 profile: ProductionGuidesProfile; series: string; number: string; body: unknown; grantVersion: number;
 createdAt: string; environment: 'PRODUCTION';
};
export type ProductionGuidesSeal = { keyId: string; signature: string };
export type ProductionGuidesIssued = { eventId: string; eventType: typeof PRODUCTION_GUIDES_ISSUED; snapshot: ProductionGuidesSnapshot; snapshotSha256: string; seal: ProductionGuidesSeal };
export type ProductionGuidesResult = { documentId: string; snapshotSha256: string; state: ProductionGuidesState;
 revision: number; ticket?: string; xmlSha256?: string; zipSha256?: string; cdrZipSha256?: string;
 source: 'SUNAT_OFFICIAL' | 'LOCAL_SYNTHETIC'; officialCdrVerified: boolean; authorizedForTransfer: false };
export type ProductionGuidesStatusEvent = { eventId: string; eventType: typeof PRODUCTION_GUIDES_STATUS; result: ProductionGuidesResult; seal: ProductionGuidesSeal };
export type ProductionGuidesGrant = ProductionGuidesScope & { actorId: string; version: number; enabled: boolean;
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
