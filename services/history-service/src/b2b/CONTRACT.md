# B2B08 historical reader contract for Main

Exports from `services/history-service/src/b2b/index`: `B2bHistoryReads`, `SyntheticB2bHistoryArchive`, all types from types.ts.

Facade-compatible entry: `new B2bHistoryReads(liveIdentity, archivePort, {enabled:true,environment:'BETA',datasetClass:'SYNTHETIC'})`.
Disabled by default. The `liveIdentity.authenticate(token, scopes, kind)` signature matches existing B2bIdentityPort structurally; history-service needs no new service-access dependency.

`execute({token,kind:'SERVICE'|'USER'}, action, input)`:

- `LIST`: `{binding:B2bBinding,take?:number,afterRecordId?:string}`. take integer 1..100, default 25; cursor is a 64 lowercase hex recordId. No arbitrary RUC/global filters or caller-provided series labels.
- `DETAIL`: `{binding:B2bBinding,recordId:string}`.
- `CONTENT`: `{binding:B2bBinding,recordId:string,artifactKind:'UNSIGNED_XML'|'SIGNED_XML'|'SUBMISSION_ZIP'|'CDR_XML'|'CDR_ZIP'|'PDF_TICKET_80MM'|'PDF_A4'|'DELIVERY_ZIP'}`.

All actions require `b2b:history:read`, a live full binding, and a separately enrolled real archive permission. `CONTENT` additionally requires `b2b:artifacts:read`.

LIST/DETAIL return `{schemaVersion:'factuez.b2b.history.v1',environment:'BETA',datasetClass:'SYNTHETIC',candidateOnly:true,readOnly:true,fiscalAuthority:false,cdrAuthenticityVerified:false,data:...}`. LIST data `{items,nextCursor}`. DETAIL data `{recordId,snapshotSha256,snapshot,candidateOnly:true,disposition:'QUARANTINED',fiscalAuthority:false,cdrAuthenticityVerified:false,transmission:false,countersChanged:false}`; private artifactKeys are omitted.

CONTENT returns `{bytes:Buffer,sha256,mediaType,fileName,sizeBytes}` for generic file transport. No public URL/path, session token or archive capability is returned.

Concrete archive adapter: `new SyntheticB2bHistoryArchive(repository,artifacts,archivePermissionPort)`. It instantiates the actual HistoricalArchiveService for each request with a private random capability whose identity adapter rechecks BOTH live B2B authority and archive enrollment. The B2B token is NEVER forwarded to legacy history session validation. The permission port must return `B2bHistoryArchiveDecision` with exact binding and an independently enrolled ASSIGNED actor limited to precisely that branch/point/series and `history.view` only; GLOBAL/import actors are rejected. Missing permission port is closed, no automatic enrollment.

Original HistoryArchiveRepository + HistoryArtifactStore BETA/SYNTHETIC attestation, role, QA database/storage and integrity guards stay intact. Only bindings with existing synthetic RUC profile `00000000xxx` are supported here. Real archive deployment is explicitly unavailable; Main must not present billing RUCs as backed historical coverage.