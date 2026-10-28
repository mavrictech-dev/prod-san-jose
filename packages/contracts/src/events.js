"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventNames = exports.QueueNames = void 0;
exports.isDocumentIssuedEventV1 = isDocumentIssuedEventV1;
exports.QueueNames = {
    sunatSubmissions: "sunat-submissions",
    billingStatusUpdates: "billing-status-updates",
    betaSupplementRequests: "billing-beta-supplement-requests-v1",
};
exports.EventNames = {
    documentIssued: "billing.document.issued.v1",
    sunatStatusChanged: "sunat.document.status-changed.v1",
    betaSupplementRequested: "billing.beta.supplement.requested.v1",
};
function isDocumentIssuedEventV1(value) {
    if (!value || typeof value !== "object")
        return false;
    const candidate = value;
    return (candidate.eventName === exports.EventNames.documentIssued &&
        typeof candidate.eventId === "string" &&
        typeof candidate.correlationId === "string" &&
        typeof candidate.payload?.documentId === "string" &&
        Array.isArray(candidate.payload?.lines));
}
//# sourceMappingURL=events.js.map