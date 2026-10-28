import type { FiscalDocumentSnapshot, FiscalLineSnapshot } from './events';
export const PRODUCTION_NOTES_PROFILE = '07-08-ON-01-PEN-0101-IGV18-v1';
export const PRODUCTION_NOTES_ISSUED = 'billing.production.notes.issued.v1';
export const PRODUCTION_NOTES_STATUS = 'sunat.production.notes.status.v1';
export const PRODUCTION_NOTES_REQUEST_QUEUE = 'billing-production-notes-v1';
export const PRODUCTION_NOTES_STATUS_QUEUE = 'sunat-production-notes-status-v1';
export type ProductionNotesAdjustment = {
    documentTypeCode: '07';
    reasonCode: '01';
    reasonDescription: string;
} | {
    documentTypeCode: '08';
    reasonCode: '02';
    reasonDescription: string;
    lines: {
        originalLineNumber: number;
        unitPriceAdjustmentWithTax: string;
    }[];
};
export type ProductionNotesAcceptance = {
    profile: 'PRODUCTION-01-ARCHIVE-v1';
    documentId: string;
    snapshotSha256: string;
    signedXmlSha256: string;
    cdrXmlSha256: string;
    cdrZipSha256: string;
    acceptedAt: string;
    checkedAt: string;
};
export type ProductionNotesSnapshot = Omit<FiscalDocumentSnapshot, 'documentTypeCode' | 'environment' | 'paymentTerms' | 'lines'> & {
    environment: 'PRODUCTION';
    documentTypeCode: '07' | '08';
    profile: typeof PRODUCTION_NOTES_PROFILE;
    adjustment: ProductionNotesAdjustment;
    reasonCode: string;
    reasonDescription: string;
    reference: {
        documentId: string;
        documentTypeCode: '01';
        fullNumber: string;
        snapshotSha256: string;
        issueDate: string;
    };
    originalAcceptance: ProductionNotesAcceptance;
    creditHistoryIds: string[];
    lines: (FiscalLineSnapshot & {
        originalLineNumber: number;
    })[];
};
export type ProductionNotesAdmission = {
    authorized: true;
    profile: typeof PRODUCTION_NOTES_PROFILE;
    snapshotSha256: string;
    grantVersion: number;
    credentialRevision: number;
    certificateFingerprint: string;
};
export type ProductionNotesIssued = {
    eventId: string;
    eventName: typeof PRODUCTION_NOTES_ISSUED;
    producer: 'billing-service';
    occurredAt: string;
    correlationId: string;
    ownerProof: ProductionNotesOwnerProof;
    payload: {
        snapshot: ProductionNotesSnapshot;
        original: FiscalDocumentSnapshot;
        creditHistory: ProductionNotesSnapshot[];
        ownerRevisionSha256: string;
        admission: ProductionNotesAdmission;
    };
};
export type ProductionNotesStatus = {
    eventId: string;
    eventName: typeof PRODUCTION_NOTES_STATUS;
    producer: 'sunat-service';
    occurredAt: string;
    ownerProof: ProductionNotesOwnerProof;
    payload: {
        documentId: string;
        snapshotSha256: string;
        originalSnapshotSha256: string;
        issuerRuc: string;
        status: 'SUBMITTED' | 'ACCEPTED' | 'ACCEPTED_WITH_OBSERVATIONS' | 'REJECTED' | 'UNKNOWN' | 'BLOCKED';
        submissionId: string;
        responseCode?: string;
        requestXmlSha256?: string;
        requestZipSha256?: string;
        cdrXmlSha256?: string;
        cdrZipSha256?: string;
        cdrSignatureVerified: boolean;
        environment: 'PRODUCTION';
        profile: typeof PRODUCTION_NOTES_PROFILE;
    };
};
export type ProductionNotesOwnerProof = {
    issuedAt: string;
    bodySha256: string;
    signature: string;
};

/** Explicit opt-in. v1 remains the default transport/admission contract. */
export const PRODUCTION_NOTES_EXTENDED_PROFILE = '07-08-ON-01-03-PEN-0101-IGV18-v2';
export type ProductionNotesProfile = typeof PRODUCTION_NOTES_PROFILE | typeof PRODUCTION_NOTES_EXTENDED_PROFILE;
export type ProductionNotesReceiptSummary = {
    identifier: string;
    summaryXmlSha256: string;
    summaryZipSha256: string;
    individualXmlSha256: string;
    individualZipSha256: string;
    cdrXmlSha256: string;
    cdrZipSha256: string;
};
export type ProductionNotesExtendedAcceptance = Omit<ProductionNotesAcceptance, 'profile'> & {
    profile: 'PRODUCTION-01-ARCHIVE-v1' | 'PRODUCTION-03-RC-ARCHIVE-v1';
    /** For 03 these CDR hashes are the RC CDR, never an individual boleta CDR. */
    receiptSummary?: ProductionNotesReceiptSummary;
};
type ProductionNotesReason = { reasonDescription: string };
export type ProductionNotesExtendedAdjustment = ProductionNotesReason & (
    | { documentTypeCode: '07'; reasonCode: '01' | '02' | '06' }
    | { documentTypeCode: '07'; reasonCode: '03'; lines: { originalLineNumber: number; correctedDescription: string }[] }
    /** Explicit cent allocations must cover every original line and sum to the global amount. */
    | { documentTypeCode: '07'; reasonCode: '04'; amountWithTax: string; lines: { originalLineNumber: number; amountWithTax: string }[] }
    | { documentTypeCode: '07'; reasonCode: '05' | '09'; lines: { originalLineNumber: number; unitPriceAdjustmentWithTax: string }[] }
    | { documentTypeCode: '07'; reasonCode: '07'; lines: { originalLineNumber: number; quantity: string }[] }
    /** Monetary bonus on the original sale, not a new free supply or returned quantity. */
    | { documentTypeCode: '07'; reasonCode: '08'; lines: { originalLineNumber: number; bonusAmountWithTax: string; description: string }[] }
    | { documentTypeCode: '07'; reasonCode: '10'; lines: { originalLineNumber: number; quantity: string; unitPriceAdjustmentWithTax: string; description: string }[] }
    | { documentTypeCode: '08'; reasonCode: '02'; lines: { originalLineNumber: number; unitPriceAdjustmentWithTax: string }[] }
    | { documentTypeCode: '08'; reasonCode: '01'; interestNature: 'MORATORIO'; interestBasis: string;
        lines: { originalLineNumber: number; interestAmount: string }[] }
    | { documentTypeCode: '08'; reasonCode: '03'; lines: { originalLineNumber: number; quantity: string; unitPriceAdjustmentWithTax: string; description: string }[] }
);
export type ProductionNotesExtendedSnapshot = Omit<ProductionNotesSnapshot, 'profile' | 'adjustment' | 'reference' | 'originalAcceptance' | 'totals'> & {
    profile: typeof PRODUCTION_NOTES_EXTENDED_PROFILE;
    adjustment: ProductionNotesExtendedAdjustment;
    reference: Omit<ProductionNotesSnapshot['reference'], 'documentTypeCode'> & { documentTypeCode: '01' | '03' };
    originalAcceptance: ProductionNotesExtendedAcceptance;
    totals: ProductionNotesSnapshot['totals'] & { unaffectedAmount: string };
};
export type ProductionNotesAnySnapshot = ProductionNotesSnapshot | ProductionNotesExtendedSnapshot;
export type ProductionNotesAnyAdjustment = ProductionNotesAdjustment | ProductionNotesExtendedAdjustment;

export const PRODUCTION_NOTES_PROFILES = [PRODUCTION_NOTES_PROFILE, PRODUCTION_NOTES_EXTENDED_PROFILE] as const;
export function isProductionNotesProfile(value: unknown): value is ProductionNotesProfile {
    return typeof value === 'string' && (PRODUCTION_NOTES_PROFILES as readonly string[]).includes(value);
}
/** Wider compile-time envelopes only; admission/policy must explicitly authorize the chosen profile. */
export type ProductionNotesAnyAcceptance = ProductionNotesAcceptance | ProductionNotesExtendedAcceptance;
export type ProductionNotesAnyAdmission = Omit<ProductionNotesAdmission, 'profile'> & { profile: ProductionNotesProfile };
export type ProductionNotesAnyIssued = Omit<ProductionNotesIssued, 'payload'> & {
    payload: Omit<ProductionNotesIssued['payload'], 'snapshot' | 'creditHistory' | 'admission'> & {
        snapshot: ProductionNotesAnySnapshot;
        creditHistory: ProductionNotesAnySnapshot[];
        admission: ProductionNotesAnyAdmission;
    };
};
export type ProductionNotesAnyStatus = Omit<ProductionNotesStatus, 'payload'> & {
    payload: Omit<ProductionNotesStatus['payload'], 'profile'> & { profile: ProductionNotesProfile };
};
