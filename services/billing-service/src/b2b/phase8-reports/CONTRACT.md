# B2B08 reports owner contract for Main

Import `B2bReports`, `PostgresReportsStore`, `createReportsRenderers` from `services/billing-service/src/b2b/phase8-reports/index`.

Construction: `new B2bReports(store, identity, billingReads, {enabled: true, renderers})`. Disabled unless explicitly enabled. `identity` is the existing B2bIdentityPort; `billingReads` is the existing B2bBillingReads (execute token/kind/capture), not a legacy token exchange. Store takes an explicitly supplied pg pool; no env, URLs, auto migrations or bootstrap.

`execute({token,kind:'SERVICE'|'USER'}, 'DASHBOARD'|'CREATE'|'READ'|'CONTENT', input)`.

- DASHBOARD: `{filters:{issuerId:string,environment:'BETA',from:'YYYY-MM-DD',to:'YYYY-MM-DD',types?:'01'|'03'|'01,03',branchId?,pointId?,seriesId?}}`.
- CREATE: `{filters,format:'CSV'|'XLSX'|'PDF',idempotencyKey:string}` (16-100 URL-safe characters). A durable QUEUED job stores the bounded capture before rendering; replay resumes the same capture. No independent worker/bootstrap. Complete jobs are READY.
- READ / CONTENT: `{id:uuid}`. Private to the same actor including client/kind/subject and authorization revisions. All saved full bindings must remain allowed.
- All actions require `b2b:reports:read` + `b2b:documents:read`; CREATE and CONTENT also require `b2b:reports:export`.
- Metadata: `{schemaVersion:'factuez.b2b.reports.v1',environment:'BETA',source:'BILLING_01_03',candidateOnly:true,fiscalAuthority:false,data: ...}`. DASHBOARD data: capturedAt, captureSha256, filters, count, groups by currency/type/local status. Job data: id,state,revision,format,capturedAt,captureSha256,count,createdAt,content metadata or null; replayed boolean at envelope level. No tokens, storage paths, private row payloads or URLs.
- CONTENT is a file result `{bytes:Buffer,sha256,mediaType,fileName,sizeBytes}` for Main's generic file transport. READ content metadata uses the same names, without bytes.
- CSV built in. XLSX renderer can be injected using an already installed ExcelJS constructor; decimal/number identifiers must be text. PDF renderer can use already installed PDFKit. Unconfigured formats fail 422 FORMAT_NOT_AVAILABLE before capture.
- SQL candidate: `services/billing-service/b2b-phase8-reports.candidate.sql`. No automatic application to any DB.
- Errors use existing B2bSecurityError(status,code). Main owns facade, public transport, appfactory, OpenAPI and explicit permission activation.

History will use an independent explicit archive permission port and a real HistoricalArchiveService under its original BETA+SYNTHETIC guards. A B2B token is never forwarded to a legacy session adapter. No archive enrollment is inferred from billing bindings/scopes.

## Owner-local extension: 07 / 08 / 09 / 31 / NV (2026-10-25)

This section extends the owner composition. The default 01/03
envelope, filters, persisted jobs, CSV column positions and authorization remain
compatible. The integration now includes the shared public validator, facade,
SDK and OpenAPI for the extended envelope. No deployment or grants are implied.

Explicit construction:

    const sources = new BillingOwnerReportSources(
      new PostgresBillingReportSources(explicitBillingPool),
      {
        corrections: { bindings: explicitCorrectionPairs, authority: correctionReadAuthority },
        guides: {
          bindings: explicitNumberedGuideBindings,
          authority09: existingGuide09ReadAuthority,
          authority31: existingCarrierGuideReadAuthority
        },
        salesNotes: true
      }
    );
    const reports = new B2bReports(jobStore, identity, billingReads, {
      enabled: true, sources,
      renderers: createReportsRenderers({ Workbook, PdfDocument })
    });

All constructor arguments above are explicit dependencies. Bindings configure
candidate coverage; they do not enroll or grant access. The pool belongs
exclusively to Billing. The code loads no environment, credentials or default
connection and performs no DDL or bootstrap.

Extended filters keep the existing fields, accept comma-separated subsets of
01,03,07,08,09,31,NV, and optionally accept issuerRuc as an exact 11-digit string.
Default types remain 01,03. Dates are inclusive Lima calendar dates; 366 days is
the maximum difference between endpoints. Series filters refer to the actual
note series, actual numbered guide series, or sales-note conversion series.
No 01/03 anchor implies a correction or guide permission.

Sources and rendering:

| Type | Verified local source | Amounts and status |
| --- | --- | --- |
| 01 / 03 | Existing B2bBillingReads current Document capture | Original amounts and existing CSV fields remain unchanged. |
| 07 / 08 | Billing Document + same-owner original Document + exact paired counters | One current immutable snapshot per document. No union with correction journal/ledger history. Original NC values stay nonnegative; signed aggregate/export effects are negative for 07 and positive for 08. |
| 09 | B2bGuideIssueDocument, receipt, ordered items, dedicated local outbox | Existing owner receipt validator, matching physical bundle and hash. LOCAL_NUMBERED; money and currency are null. |
| 31 | CarrierGuideDocument, receipt, ordered items, dedicated local outbox | Existing carrier issuance validator and matching physical bundle/hash. LOCAL_NUMBERED; money and currency are null. |
| NV | B2bCommercialResource, exact client/actor/binding, current revision | Only COMPLETED/CONVERTED/CANCELLED with a valid completed body SHA. DRAFT, correction requests and never-completed cancellations are excluded. Commercial values remain separate from fiscal sales. |

CSV, XLSX and PDF support every configured type. CSV works without extra
dependencies. XLSX and PDF require injected already-installed Workbook/PDFKit
constructors; no dependency changes were made.

Extended CSV appends category, signedPayableAmount, signedTaxableAmount,
signedIgvAmount, referenceDocumentId, convertedDocumentId, grossWeight,
weightUnit and quantities to the original fourteen columns. The seriesId cell
contains the actual note/guide series. Original amounts retain their source
sign. Monetary negative decimal cells are emitted as ordinary quoted decimals;
other potential spreadsheet formulas are escaped.

Extended XLSX contains Documents, Summary, Transfers, NetSales and Coverage.
Identifiers, decimals and counts remain text. PDF labels commercial/transfer
rows, original amounts and signed effects explicitly. Null taxes stay unknown.
Weights/quantities are never money, and heterogeneous quantity units are not
added together. NetSales sums only local ISSUED 01/03/07/08 by currency; it
excludes cancelled documents, NV and guides. NetSales does not assert accounting
recognition, fiscal acceptance, a verified ledger balance or transfer permission.

Permissions and persistence:

- All original report scopes remain required. Additional source scopes are
  b2b:corrections:read, b2b:sales-notes:read, or b2b:guides:read plus
  b2b:guide-operations:read as applicable.
- Correction pairs and numbered guide bindings are individually authorized;
  exact authority grant revisions are saved even when the capture has no rows.
- Existing guide READ authorities can be injected directly.
- Captured source permissions are rechecked at job read, replay, rendering
  completion and download, including after content I/O. Revision changes or
  revoked access fail closed. A missing source adapter also fails closed.
- Source SQL uses REPEATABLE READ READ ONLY. RUC, environment, branch, point,
  series, type, reference, actor and date restrictions apply before LIMIT.
  The store repeats principal/context/scope checks before opening its pool.
- The report job stores the normalized rows and access snapshot in the existing
  payload. No schema change is needed. Idempotent retries preserve the original
  capture; a new key captures the current Document snapshot.
- The existing 01/03 capture and supplemental capture are separate transactions.
  Coverage states OWNER_CAPTURE_NOT_A_CROSS_SOURCE_TRANSACTION explicitly.

Integrated contracts and independent authorization:

1. PostgresReportsCorrectionReadAuthority implements the source-types.ts READ
   port with current Identity and an exact persisted actor/reference/correction
   pair grant. Candidate SQL b2b-report-correction-read.candidate.sql requires
   canonical hashes, immutable context, revision CAS and a matching immutable
   audit entry. setGrant requires a separately injected current administrator
   authority; it is not a public endpoint or automatic enrollment. Issue/write
   authorization does not substitute for READ. No policy has been installed in
   the existing QA database.
2. BILLING_OWNER_SOURCES, coverage, netSales/transfers and job types are now
   recognized by the public facade and SDK through the shared
   assertPhase8ReportView validator. It binds normalized filters to the request,
   recomputes fixed-point signed totals and rejects private fields or fiscal
   acceptance claims. OpenAPI describes both the legacy and extended envelope.
   The SDK uses an internal workspace dependency on @factuez/contracts; build
   and distribute both packages together. Existing BILLING_01_03 remains valid.

These adapters cover only the verified local Billing sources above. An externally
owned 09/31 requires a separately agreed bounded capture/read contract and an
explicit HTTP mTLS adapter. No external-owner DB access, public snapshot source,
shared-DB fallback or purported SUNAT acceptance is implemented.

