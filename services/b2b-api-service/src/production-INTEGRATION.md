# B2B PRODUCTION: integration handoff (additive, no BETA graph changes)

## Status

The new profile is `B2B_PRODUCTION`. It has its own OAuth SERVICE clients, opaque 300-second tokens, explicit scope+RUC/branch/point/series grants, PostgreSQL journal, private HTTP listener, native billing/fiscal ports, webhook outbox and OpenAPI JSON.

**Native production integration is NOT complete until the main-owned methods below exist and are wired.** `createProductionCoreHost` requires all three concrete native SERVICE ports and fails construction when any is missing. `ADAPTER_REGISTERED` is registration only, never a claim of fiscal readiness. Fiscal configuration, current grant, certificate, notes arithmetic, native reservation locks and official dispatch remain with the native owners.

No current AppModule/main, BETA source, shared index, compose, UI or native-owner file was changed by this component. It neither calls official SUNAT nor starts eight BETA owner processes. It does not mint/impersonate a human JWT. Verification uses synthetic databases/certificates and loopback stubs only.

## Exact imports and native signatures for main

- `production-assembly.ts`: export `productionB2bCoreProviders`, `PRODUCTION_B2B_CORE`, `ProductionB2bCoreLifecycle`. Spread its provider array into the SAME core module as the native billing providers; it deliberately avoids nested-module visibility assumptions. The lifecycle starts one private HTTPS/mTLS listener and shuts it down with core. `dispatchEnabled` defaults false (no sends); main can explicitly enable its single-flight callback worker after integration. Native business commands still run in native owners.
- `production-core-host.ts`: `createProductionCoreHost(options)` can instead be mounted manually. `listen(port,host)` probes the durable journal and starts OAuth+facade in core. `close()` stops the listener. `tick()` sends at most one callback. `outbox.accept(source,eventId)` projects a committed native outbox row into durable webhook deliveries without touching native `publishedAt`.
- `production-native-billing.ts`: `ProductionNativeOwnerContext`, `ProductionIssuePort`, `ProductionNotesPort`, `ProductionGuidesPort`, `ProductionNativeCatalogue`, `createProductionNativeBillingProviders`.

Required SERVICE entrypoints (separate from human controllers):

```ts
issue.executeB2B(input: unknown, context: ProductionNativeOwnerContext): Promise<unknown>
notes.issueB2B(originalId: string, input: unknown, operationId: string,
              context: ProductionNativeOwnerContext): Promise<unknown>
guides.issueB2B(input: unknown, operationId: string,
               context: ProductionNativeOwnerContext): Promise<unknown>
```

The context has `userId: null`, `createdByActor: {kind:'SERVICE',clientId,revision,subjectId:null,userAuthRevision:null,environment:'PRODUCTION'}`, an exact ASSIGNED scope containing native UUIDs, `productionBinding` with native issuer/series IDs and document type, a durable UUIDv5 `operationId`, client-specific idempotency key, correlationId and the original opaque machine bearer in `authorization`. Never put bearer/secret into snapshots, audits, createdByActor or outbox payloads. The existing BETA `context.b2b` / B2bBinding remains BETA; **do not cast this context into it**.

The new catalogue resolves active PRODUCTION CompanySettings → Branch → EmissionPoint → SeriesCounter. The private billing middleware re-introspects tokens, consumes a one-use signed nonce and verifies operation, path, body, binding, client revision and operation ID. Native methods must STILL reload/lock actual rows and commit native dedupe+business write atomically. Notes must also revalidate the original against the same company/branch/point. No financial arithmetic is implemented in the facade.

## Main-owned files requiring integration

1. `services/billing-service/src/application/issue-document.service.ts`: implement `executeB2B` for this dedicated context; preserve human `execute` and BETA guards; allow PRODUCTION SERVICE only through verified native port; save createdByActor and null human FK; use machine fiscal admission rather than `/auth/me`.
2. `services/billing-service/src/application/production-notes-owner.service.ts`: implement `issueB2B`; machine-safe actor identity in reservation/dedupe and createdByActor; retain native exact adjustment/history arithmetic and original evidence/admission checks. Existing human-only `actor.userId` cannot be populated with a client ID.
3. `services/billing-service/src/production-guides-owner.ts` and `production-guides-runtime.ts`: implement `issueB2B`; distinguish SERVICE grant/reservation identity, store createdByActor, revalidate current machine grants in `current()`; retain native GRE profiles/signers/status/reference validation. Client UUID must not be passed as a human UUID merely to satisfy legacy checks.
4. Fiscal counterparts: `services/sunat-service/src/production-admission.controller.ts`, `production-notes.controller.ts`, `production-guides.controller.ts`, their native policy/provider methods and `auth/fiscal-issuance.guard.ts` (or separate private routes/providers). Register the new private SERVICE port, without removing human guards. Native fiscal policy must validate PRODUCTION owner/body/binding, live authorization, readiness and certificate before a number is committed.
5. Core `app.module.ts` / `main.ts`: import the new provider array or manually construct the host; supply existing native instances, production journal pool, explicit admin authority, TLS material, distinct attestation key and webhook vault key. No shared index is necessary: import built `dist/production-*` and `@factuez/service-access/dist/b2b-production-*` paths directly. Deployment/installer owns port exposure and additive SQL application.
6. Native outbox publishers (`services/billing-service/src/infrastructure/outbox.publisher.ts`, notes runtime and guide runtime): after native commit, call `host.outbox.accept('BILLING_OUTBOX'|'NOTES_OUTBOX',eventId)` and durably acknowledge relay only after it succeeds. The relay reads the actual stored native event and matching Document snapshot, rejects BETA, and dedupes webhook event IDs. It never changes native fiscal publication state. Status-change events still require an explicit native status-event relay; subscriptions alone do not establish that integration.

## Minimal composition

```ts
// In main-owned core module composition, with real owner instances/tokens:
...productionB2bCoreProviders({
  settings: {port: productionPrivatePort, host: privateBindAddress, dispatchEnabled: false},
  tokens: {
    billing: PrismaService, store: PRODUCTION_JOURNAL,
    issue: IssueDocumentService, notes: ProductionNotesOwnerService,
    guides: ProductionGuidesOwner, callbacks: PRODUCTION_CALLBACK_TRANSPORT,
    identityAdmin: PRODUCTION_CLIENT_ADMIN_AUTHORITY,
  },
  createIdentity: (store, catalogue, admin) =>
    new ProductionIdentity(store, admin as ProductionAdmin, catalogue),
  host: {
    profile: 'B2B_PRODUCTION', tls: privateTls, peers: approvedEdgeFingerprints,
    attestation: privateAttestationKey, vaultKey: webhookVaultKey,
  },
})
```

`ProductionIdentity` lives in `services/identity-service/src/b2b/production-identity.ts`. The composition callback allows it to live in the same core process; no BETA identity bootstrap is imported. Identity's separately authorized client-administration HTTP router is `productionIdentityRouter` in `production-http.ts`; mount it with role-specific mTLS peers if administrative HTTP is required. The core OAuth endpoint is already concrete and does not depend on that optional admin router.

## Private fiscal port

`packages/service-access/src/b2b-production-fiscal.ts` provides `ProductionFiscalClient` and `productionFiscalRouter`. Register concrete native providers for `admission01`, `admission03`, `noteOriginal07/08`, `noteAdmission07/08`, `guideAdmission09/31`. Each provider has separate `authorize` and `execute` callbacks. The transport introspects the original SERVICE bearer and signs a FRESH body-bound attestation for each billing → fiscal hop. The receiving router verifies real TLS peer, live identity, nonce, revision and body before native policy execution. Existing human `/api/v1/setup/sunat/...` routes are not repurposed.

## Public contract behind approved mTLS ingress

- POST `/b2b/production/oauth/token`: HTTP Basic clientId:secret; form `grant_type=client_credentials&scope=...`; no wildcard scopes.
- POST `/b2b/production/v1/operations/{read|issue01|issue03|note07|note08|guide09|guide31}` with `{binding:{ruc,branchId,pointId,series},payload}`. Writes require Idempotency-Key. Notes payload is `{originalId,input:{seriesCounterId,adjustment,profile?}}`. Guides use the exact native `{seriesCounterId,profile,body}`.
- GET `/b2b/production/openapi.json`: machine-authenticated OpenAPI 3.0.3 for Swagger tooling, JSON only; no UI changed.
- GET `/b2b/production/v1/capabilities`: registration only; no global ready claim.
- Webhooks: POST/GET `/b2b/production/v1/webhooks`; POST `/{id}/pause`, `resume`, `rotate` with `{revision}`; GET `/{id}/deliveries`. Plaintext secret is returned once on create/rotation; ciphertext is never returned. Destinations are approved IDs, pinned HTTPS public addresses, no redirects or private/metadata addresses.
- Maestros/users retain distinct scopes and per-operation activation, default off. Core's required native provider set contains no legacy CRUD grants.

Commands have durable PENDING/SUCCEEDED/UNCERTAIN states. A repeated uncertain/pending request returns 409 and does not automatically emit again; operator/native reconciliation is still required. Webhook states: QUEUED, IN_FLIGHT (leased), RETRY_SCHEDULED, ACKNOWLEDGED (only matching durable consumer ACK), DEAD. Eight attempts, stable event/delivery IDs, bounded retry delay, current client grant check on dispatch. Receiver signature window is 300s; effect+inbox must commit in one consumer transaction before ACK. Delivery remains at least once.

## Persistence and verification

Apply `services/identity-service/src/b2b/production-schema.sql` using the installer migration role; runtime needs its isolated journal pool. An append-only audit trigger rejects UPDATE/DELETE of audit records. No existing schema/migration/index entrypoint is edited. Journal and native database may be separately supplied; cross-store native event handoff is retry/dedupe, not a claimed distributed transaction. The initial journal implementation lists entire subscription/delivery namespaces; main should cap tenant volumes or add indexed paging/claim queries before high-volume rollout. It is not a claim of unlimited throughput.

Run `node node_modules/vitest/vitest.mjs run --config tests/b2b-production.config.mts`. Tests create owned ephemeral PostgreSQL containers with no network, no host DB port and tmpfs storage; clean up only those containers. They use local TLS PKI and synthetic data. Native core tests invoke explicit stub SERVICE ports against real synthetic native tables, **not shipping human-only producers**. Fiscal tests use local native policy stubs and make no official calls.
