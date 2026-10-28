# Production notes bounded vertical v1 — frozen integration contract

Scope: 07 motive 01 (complete annulment) and 08 motive 02 (positive unit-price delta at the original quantity), only against this owner's accepted invoice 01, PRODUCTION/PEN/0101/IGV18, explicit CONTADO, 1..100 original lines. Own snapshot, issuer, buyer, quantities, taxes and reference are rebuilt by Billing. No Beta environment conversion, fixture gate, 07/08-on-03, interest, other motives, original credit installments or mixed debit/credit histories. Reasons/catalog sources are pinned in PRODUCTION_NOTES_RULES; mathematical and official local XSD tests exercise both notes.

## Main assembly (no AppModule or existing route edits by this block)

Billing may import ProductionNotesBillingModule from src/production-notes.module.ts, OR spread PRODUCTION_NOTES_BILLING_CONTROLLERS and PRODUCTION_NOTES_BILLING_PROVIDERS into the existing module (preferred to share its existing PrismaService/JwtPermissionGuard):
- ProductionNotesOwnerController
- ProductionNotesOwnerService
- ProductionNotesOwnerRuntime

SUNAT may import ProductionNotesSunatModule, OR spread PRODUCTION_NOTES_SUNAT_CONTROLLERS and PRODUCTION_NOTES_SUNAT_PROVIDERS into the existing module:
- ProductionNotesController
- ProductionNotesPolicyService
- ProductionNotesEvidenceService
- ProductionNotesDispatchRepository
- ProductionNotesDispatchService
- ProductionNotesSunatRuntime
- ProductionNotesArtifactsService (Goodall sidecar; CurrentPdfService dependency)

Concrete prerequisites already present in SUNAT: PrismaService, ArtifactStore, SecretVault, CertificateInspectionService, CertificateTrustService, PublicSignerArchive, CdrSignatureTrustService, XsdValidationService, FiscalConfigurationService, FiscalReadinessService, ConfigurationGuard, FiscalIssuanceGuard. No empty factory/adapter is registered. Signature worker is compiled alongside production-notes-crypto.worker.ts. Build contracts, sunat-core and pdf-renderer before Billing/SUNAT.

## Offline DDL to review/install separately

1. services/billing-service/prisma/production-notes-schema.sql: ProductionNotesReservation (owner document/original/operation/actor/request/snapshot/event/payload/outcome), ProductionNotesOutbox, ProductionNotesInbox.
2. services/sunat-service/prisma/production-notes-schema.sql: ProductionNotesGrant, ProductionNotesGrantAudit, ProductionNotesDispatch, ProductionNotesStatusOutbox.

Both are additive DDL with transaction advisory lock and lock/statement timeouts. They intentionally fail if these named tables already exist; do not silently trust an incompatible schema. No application code runs DDL. This block has not executed SQL, changed counters or grants in a live database.

## Configuration

BILLING_PRODUCTION_NOTES_ENABLED=true (Billing); SUNAT_PRODUCTION_NOTES_ENABLED=true plus existing SUNAT_PRODUCTION_WORKFLOW_ENABLED=true (SUNAT). Server flags confer no issuer grant.

PRODUCTION_NOTES_OWNER_KEY_FILE must point to the same private, service-owned file containing a dedicated 32-byte random key encoded as 64 hexadecimal characters, in an absolute regular file (maximum 128 bytes, no symlinks/hardlinks, POSIX mode 0600), mounted ONLY in Billing and SUNAT. Do not reuse SOL/P12/JWT secrets. The file is required before enabling the new notes grant. Billing signs exact admission bodies including ownerRevisionSha256 under its RUC lock and Serializable transaction. SUNAT refuses user/global client admission without that owner HMAC; it independently revalidates original XML/ZIP/CDR with current public signer/PKI/CRL. Issued and status events are also purpose-bound HMAC envelopes. No bearer or secret enters Outbox. Admission proof expires after 30 seconds; durable event proof remains bound to the exact immutable body. Key rotation of pending events requires a separate reviewed transition; never silently re-sign historical events.

## Human routes (existing Kong prefixes /api/v1/documents and /api/v1/setup/sunat)

GET /api/v1/documents/:originalId/production-notes/ready (DOCUMENT_ISSUE, live scope)
Returns serverEnabled (Billing flag only), original {documentId,fullNumber,customer,lines,totals}, series [{id,series,documentTypeCode,nextNumber}], profile, supportedReasons {'07':['01'],'08':['02']}, note. No fabricated remote readiness or grants.

POST /api/v1/documents/:originalId/production-notes (DOCUMENT_ISSUE)
Idempotency-Key: UUID
Body: {seriesCounterId,adjustment}
07: {documentTypeCode:'07',reasonCode:'01',reasonDescription}
08: {documentTypeCode:'08',reasonCode:'02',reasonDescription,lines:[{originalLineNumber,unitPriceAdjustmentWithTax}]}
The positive delta includes IGV; it is not the replacement unit price. Reply {documentId,eventId,deduplicated}. Different actors/content cannot reuse an operation. Billing locks its own SeriesCounter FOR UPDATE, uses CAS and commits Document + items/tax + reference + reservation + dedicated Outbox atomically; original/counters are never reset. Owner RUC locks serialize credit capacity checks, including pending/UNKNOWN/rejected credits. Unknown preexisting corrections or mixed debit/credit histories fail closed.

GET/POST /api/v1/setup/sunat/:companyId/PRODUCTION/notes/authorization (global ConfigurationGuard)
Status: profile,issuerRuc,version,credentialRevision,supportedDocumentTypes ['07','08'],supportedReasons,serverEnabled,enabled.
POST {enabled,expectedVersion,expectedRevision,authorizedDocumentTypes:['07','08'],confirmation:'AUTORIZAR NOTAS REALES 07 Y 08 SOBRE FACTURA 01'}.
Suspension needs only enabled:false plus expectedVersion/expectedRevision. This writes a separate ProductionNotesGrant/Audit; old 01 and 01/03 grants never widen.

POST .../notes/original-evidence is a private scoped bridge that loads Billing's exact own original and SUNAT's physical production archives/submission/CDR; HTTP booleans do not prove acceptance.
POST .../notes/admission additionally requires X-Factuez-Notes-Owner (base64url JSON proof signed by Billing). Body is owner-built {snapshot,original,creditHistory,ownerRevisionSha256}; arbitrary user bodies have no authority.

## Durable processing and evidence

Dedicated queues billing-production-notes-v1 and sunat-production-notes-status-v1 use dedicated owner Outbox/Inbox tables. Existing Billing/SUNAT publishers/consumers are untouched. New runtime providers must be registered or no queue is started. Receipt/factura/Beta queues and grants are unchanged.

SUNAT registers immutable FiscalDocument and one SunatSubmission with idempotencyKey production-notes:<id>:v1, SOAP_SEND_BILL, attempt 1. ProductionNotesDispatch.payload is the full ProductionNotesIssued envelope; payload.payload holds snapshot/original/creditHistory/ownerRevisionSha256/admission. Manifest {xml,zip,fileName,digest,fingerprint,revision,xsdEvidence}; each file {storageKey,sha256,sizeBytes}. Both individual signed XML and ZIP are stored under the note documentId and match canonical production note UBL. PublicSignerArchive is published only after exact signature/PKI/XSD checks. No client chooses a signer or grants transport. sendBill capability is RUC-specific and re-reads the exact grantVersion/credentialRevision/fingerprint immediately before POST; sendSummary/getStatus are not allowed for notes.

SENDING is persisted before external submit. Lost responses, post-send verifier/storage failures and interrupted SENDING become UNKNOWN, publish a signed status and cannot auto-repost. Interrupted preparation may only reuse the exact frozen manifest; active PREPARED leases cannot be stolen. Trusted final CDR requires matching ZIP/XML, issuer/type/reference, current signature chain and request canonical archive reread. Final status evidence carries request XML/ZIP and CDR XML/ZIP hashes plus note/original snapshot hashes. Billing validates its private signed envelope against its own frozen snapshot before projection and preserves final outcomes. Rejected credits conservatively retain capacity; release/reconciliation is deliberately not automated.

ProductionNotesArtifactsService.download(id,'signed-xml'|'submission-zip'|'cdr-xml'|'cdr-zip',bearer) and pdf(id,'a4'|'ticket',bearer) return {bytes,fileName,mediaType,sha256}. Main routes these to existing delivery endpoints and no-store headers. Goodall owns renderer and sidecar; this block does not edit existing delivery/PDF/originals.

## Verification and explicit limits

Local tests use ephemeral keys and fictitious documents, real XML signatures/physical archives, local official XSDs, and explicit PKI/CRL/transport/database doubles. The double-credit race exercises the owner lock/CAS/Serializable protocol with a serializable in-memory transaction double; no claim of live PostgreSQL concurrency, real SUNAT acceptance or a real certificate is made. Install/bootstrap/Kong/PWA/Swagger and end-to-end deployment are Main's integration work. No QA SQL, Docker, real P12 or SUNAT request has been executed here. Historical PKI remains current-time validation; archived issueDate does not establish historical trust.
