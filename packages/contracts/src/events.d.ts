import type { FrozenPrintPresentationV1, PrintOperationSnapshot } from './print-presentation';
export declare const QueueNames: {
    readonly sunatSubmissions: "sunat-submissions";
    readonly billingStatusUpdates: "billing-status-updates";
    readonly betaSupplementRequests: "billing-beta-supplement-requests-v1";
};
export declare const EventNames: {
    readonly documentIssued: "billing.document.issued.v1";
    readonly sunatStatusChanged: "sunat.document.status-changed.v1";
    readonly betaSupplementRequested: "billing.beta.supplement.requested.v1";
};
export type FiscalDocumentTypeCode = "01" | "03" | "07" | "08" | "09";
export type CurrencyCode = "PEN" | "USD";
export interface FiscalPartySnapshot {
    identityType: string;
    identityNumber: string;
    legalName: string;
    address?: string;
}
export interface FiscalLineSnapshot {
    lineNumber: number;
    productCode?: string;
    description: string;
    unitCode: string;
    quantity: string;
    unitValue: string;
    unitPriceWithTax: string;
    taxAffectationCode: string;
    igvRate: string;
    lineExtensionAmount: string;
    igvAmount: string;
    totalAmount: string;
}
export interface FiscalPaymentInstallmentSnapshot {
    /** Decimal exacto de texto, positivo y con hasta dos decimales. */
    amount: string;
    /** Fecha calendario YYYY-MM-DD, comparada con la emisión en Lima. */
    dueDate: string;
    /** Si se declara, debe coincidir con la moneda del documento y del crédito. */
    currencyCode?: CurrencyCode;
}
export type FiscalPaymentTermsSnapshot = {
    type: "CONTADO";
} | {
    type: "CREDITO";
    currencyCode: CurrencyCode;
    pendingAmount: string;
    /** El orden congelado determina Cuota001..Cuota999; no se reordena. */
    installments: FiscalPaymentInstallmentSnapshot[];
};
export interface FiscalDocumentSnapshot {
    /** Contexto fiscal congelado por Billing; nunca derivar de un entorno global. */
    companyId?: number;
    branchId?: string;
    environment?: "BETA" | "PRODUCTION";
    documentId: string;
    documentTypeCode: FiscalDocumentTypeCode;
    series: string;
    number: string;
    fullNumber: string;
    issueDate: string;
    currencyCode: CurrencyCode;
    /** Opcional sólo por compatibilidad histórica; preparación real de 01 lo exige. */
    paymentTerms?: FiscalPaymentTermsSnapshot;
    /** Opcional para eventos antiguos. Sólo presentación; congelada por Billing. */
    printPresentation?: FrozenPrintPresentationV1;
    printOperation?: PrintOperationSnapshot;
    operationTypeCode: string;
    issuer: FiscalPartySnapshot & {
        tradeName?: string;
        ubigeo: string;
        establishmentCode: string;
    };
    customer: FiscalPartySnapshot;
    lines: FiscalLineSnapshot[];
    totals: {
        taxableAmount: string;
        igvAmount: string;
        payableAmount: string;
    };
}
export interface EventEnvelope<TName extends string, TPayload> {
    eventId: string;
    eventName: TName;
    occurredAt: string;
    correlationId: string;
    causationId?: string;
    producer: string;
    payload: TPayload;
}
export type DocumentIssuedEventV1 = EventEnvelope<typeof EventNames.documentIssued, FiscalDocumentSnapshot>;
export type SunatProcessingStatus = "QUEUED" | "BUILDING" | "SIGNED" | "SUBMITTED" | "ACCEPTED" | "ACCEPTED_WITH_OBSERVATIONS" | "REJECTED" | "RETRYABLE_ERROR" | "PERMANENT_ERROR";
export interface SunatStatusPayloadV1 {
    documentId: string;
    status: SunatProcessingStatus;
    responseCode?: string;
    description?: string;
}
export type SunatStatusChangedEventV1 = EventEnvelope<typeof EventNames.sunatStatusChanged, SunatStatusPayloadV1>;
export declare function isDocumentIssuedEventV1(value: unknown): value is DocumentIssuedEventV1;
