# Owner business engine — integration contract

This source is an opt-in candidate. It is not mounted, migrated, deployed or a claim that all B2B08 is complete.

`index.ts` exports `B2bPhase8Business`, `BusinessExecutor`, `BusinessAction`, `BusinessInputMap`, `BusinessResult`, `BusinessPermissionPort`, `BusinessStore`, `PostgresBusinessStore`, and the explicit PostgreSQL factory. Main owns the private RPC `/internal/b2b/phase8-business`, public controllers, OpenAPI and application composition.

The stable entry point is:

```ts
engine.execute({ token, kind: 'USER' }, 'CUSTOMERS_LIST', { binding, limit: 50 });
// { data, operationId: string | null, replayed: boolean, nextCursor?: string | null }
```

All inputs require the existing complete `B2bBinding`: issuerId, issuerRuc, branchId, pointId, seriesId, documentType and BETA environment. No reduced tuple or caller-supplied principal is accepted. Every operation uses a fresh `B2bOwnerReadFrame`, requires its real Identity scopes, checks current owner context and permission policy, and revalidates before returning/committing. The token and complete grants are not persisted. Concurrent requests cannot share authentication frames.

Actions and payloads:

- CUSTOMERS_LIST / PRODUCTS_LIST / SHIFTS_LIST: optional limit 1–100, UUID after cursor and literal q up to 100 characters.
- CUSTOMERS_DETAIL: id.
- CUSTOMERS_CREATE / PRODUCTS_CREATE: body plus idempotencyKey.
- CUSTOMERS_UPDATE / PRODUCTS_UPDATE: id, expectedRevision, partial body and idempotencyKey.
- SHIFTS_OPEN: openingAmount, currency PEN or USD, idempotencyKey.
- SHIFTS_CLOSE: id, expectedRevision, countedAmount, reason, idempotencyKey.
- SHIFTS_CASH: id, expectedRevision, direction IN or OUT, amount, reason, idempotencyKey.
- REPORTS_SUMMARY: binding only; actual candidate client/actor-point shift counts, real FuelProduct count and separate cash totals per currency. Requires reports:read plus customers/products/shifts:read. It does not compute sales, commercial revenue or physical stock.

Amounts are decimal strings, never JavaScript numbers. Cash has at most two decimals and twelve integer digits; product prices have at most six decimals. Arithmetic uses the Decimal implementation already provided by Prisma, cloned with precision 40. Overflows, insufficient cash and rounding requests are rejected. Revision preconditions and idempotency apply within the same transaction as writes and audit. Audit stores the exact actor/auth revision, owner permission revision and explicit SERVICE policy identifier; SERVICE has no invented user identity.

## Current owner permission adapter

No permission adapter means OWNER_PERMISSION_PORT_REQUIRED (503). An actual trusted owner adapter must implement `authorizeCurrent({ principal, binding, action })` by consulting live owner authorization, admin/role state, relevant owner permissions, current human step-up and any explicit service policy. It must return an attributable stable revision and allowed:true only after that check. Public JSON must never construct this decision or the adapter. B2B scopes, client grants and a RUC binding are necessary boundaries, not owner permissions.

Every SERVICE action additionally requires an explicit current servicePolicyId for that exact action, actor and binding, checked by the adapter. Product writes always require USER and a globalProductAuthority proof matching subjectId and userAuthRevision, GLOBAL scope, current stepUpVerified and product.manage. The owner adapter must enforce the existing product administrator policy; RUC grants cannot create global product authority. Authority is rechecked for idempotent replays too. A changed decision revision during a request aborts the transaction.

## Actual persistence boundaries

Products read and write **the real shared FuelProduct table**, including rows created through the existing POS/admin paths. `B2bP8ProductRevision` is a CAS-only sidecar (product id, integer revision, source SHA-256); it is not a parallel catalogue. Existing `/products` reads can see successful creates immediately. Main may retain `/business-products` temporarily to avoid a controller collision. No source-schema alteration is required, and fields absent from the business patch, such as sunatProductCode, remain intact. Reads observe source fingerprints into the sidecar while locking the source rows; changes by legacy writers advance the observed revision before CAS. A stale source rejects the update, including changes that kept updatedAt unchanged. Fingerprints use numeric text and all source fields; timestamp-without-zone fields follow Prisma's UTC convention.

Customer and shift parity with legacy Customer/Shift remains pending. The engine deliberately uses isolated B2bP8Customer, B2bP8Shift, B2bP8Movement and B2bP8Operation aggregates. Customers are shared per authorized issuer/RUC, with identity type/number unique there. Shifts and their movements belong to the exact actor and binding. A partial unique index permits one open shift per physical point, independent of actor/series/currency; closed aggregates cannot reopen. Opening, cash in/out, closure, revision and audit commit atomically. Closing records counted cash and its difference separately; no movement is treated as a sale or stock movement.

The candidate SQL creates new tables/functions/triggers only and references the existing FuelProduct ID. It does not alter Customer, Shift, FuelProduct schemas, counters, issuance or Outbox. No candidate schema is auto-applied by the constructor or PostgreSQL factory. PostgreSQL values are parametrized; configuration is explicit and does not load .env. Injected pools remain caller-owned unless ownsPool=true. `engine.close()` closes the store; the factory owns and closes its created pool. Escaped transactions and operations after close fail closed.

## Bounded verification

```text
pnpm exec vitest run tests/b2b-phase8-business.spec.ts --maxWorkers=1
node tests/b2b-phase8-business-db.runner.cjs --isolated-synthetic-only
pnpm exec tsc -p services/billing-service/tsconfig.json --noEmit
```

Unit tests have no Docker dependency and do not skip integration tests. PostgreSQL integration lives under a dedicated runner directory and separate config; it never joins the default unit include. The runner requires the explicit flag, a locally available postgres:17-alpine image, and creates one labelled disposable container with network=none, no ports/mounts/URLs, tmpfs data and --pull=never. It reproduces only the existing FuelProduct model in that fresh empty DB, applies the candidate DDL, runs real parametrized store/engine tests and removes the owned container. No migrations, existing DB, QA, .env, production or SUNAT are accessed. Test Identity/permission implementations are confined to synthetic fixtures; production exports no memory fallback.

Verified in this work session: 34/34 dedicated unit tests, 31/31 real isolated PostgreSQL tests, and billing-service `tsc --noEmit` passed. The labelled test container was removed. No broad regression suite was run.

Main integration detail: preserve owner errors 412 REVISION_CONFLICT and 428 PRECONDITION_REQUIRED in the private/public error filters; mapping them to 503 loses the exported CAS contract. Main's public facade may enforce a primary action scope first; the owner still independently requires both shifts:write and cash:write for SHIFTS_CASH, and reports:read plus all three relevant read scopes for REPORTS_SUMMARY.

HTTP composition test fixture: `tests/helpers/b2b-phase8-business.fixture.ts` exports MemoryBusinessStore, fixture, businessFixture and harness (the last three are the same constructor). The helper imports no spec. `fixture()` returns engine/core, identity, context, permissions, store, b/other bindings, auth() and synthetic command helpers. Token: synthetic-token; default actor kind: USER. principal and owner-policy switches remain mutable only inside this test fixture. After extraction, unit 34/34 and isolated PostgreSQL 31/31 passed again.
