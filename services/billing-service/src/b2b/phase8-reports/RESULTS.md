# B2B08 reports + history delivery

Candidate code only, disabled by default. No public deployment, real grants, real archive coverage, SUNAT operation or existing database migration is claimed.

## Integration contracts

- Reports exports: `B2bReports`, `PostgresReportsStore`, `createReportsRenderers`, `ReportsInputMap` and remaining types from this directory's index.ts. Exact facade inputs/outputs are in CONTRACT.md.
- History exports: `B2bHistoryReads`, `SyntheticB2bHistoryArchive`, `B2bHistoryInputMap`, permission/live identity/archive port types from `services/history-service/src/b2b/index.ts`. Exact inputs/outputs are in that directory's CONTRACT.md.
- Reports CSV works with no injected dependency. XLSX/PDF work with explicit injection of already-installed ExcelJS Workbook and PDFKit constructors; both actual formats were generated and inspected in tests. No package/dependency changes.
- PostgreSQL is injected as a pool; no env/URL loader, bootstrap, migration runner, application connection or automatic worker. A QUEUED job is resumed by CREATE with the same idempotency key, using the persisted original capture.
- Every captured full binding is rechecked for job access, including empty capture bindings. Fiscal decimals use fixed-point BigInt (up to 12 input decimal places); currencies/types/local statuses are separate, unknown taxes remain unknown.
- History uses actual HistoricalArchiveService + HistoryArchiveRepository + HistoryArtifactStore. Existing BETA/SYNTHETIC, QA DB/role/marker, immutable quarantine, storage and integrity guards remain in place. A separately enrolled exact archive actor and current B2B Identity are required; no automatic archive enrollment or legacy session/token forwarding.

## Final verification

Passed 34 focused unit tests (23 reports, 11 history):

    pnpm exec vitest run tests/b2b-phase8-reports.spec.ts tests/b2b-phase8-reports-history.spec.ts --maxWorkers=1 --testTimeout=30000

Passed both focused PostgreSQL integration tests:

    pnpm exec vitest run tests/b2b-phase8-reports-db.integration.ts tests/b2b-phase8-reports-history-db.integration.ts --config tests/b2b-phase8-reports-db.config.mts --reporter=verbose

The reports integration covers fresh durable capture, process/core reconstruction, same-key replay without recapture, owner privacy, concurrent requests, compare-and-set, rollback and closed-transaction rejection. It resumes a nonempty QUEUED capture after a renderer failure even after source rows disappear.

The history integration imports synthetic fixtures into a completely new archive PostgreSQL database, then reads using the original reader role and real repository/service/artifact classes. It verifies explicit enrollment, bytes/SHA, denied DB mutations, immutable record guards and marker mismatches.

Each PostgreSQL integration creates its own labelled postgres:17-alpine container from an already-installed image, with --pull never, --network none, no published ports and tmpfs storage. Host access uses Docker-exec container-local byte streams. Startup waits for the final TCP listener, avoiding the temporary initialization server. Owned containers were removed and no matching running test container remained at final verification.

Both service typechecks passed without emitting files:

    pnpm exec tsc -p services/billing-service/tsconfig.json --noEmit --pretty false
    pnpm exec tsc -p services/history-service/tsconfig.json --noEmit --pretty false

Only new files in the user's assigned ownership set were created/edited. Main owns all public routes, facade, transport, appfactory, OpenAPI and explicit scope/grant activation. Production deployment and real historical archive activation remain unavailable.

## Ampliación de reportes verificada el 2026-10-25

Entrega interna candidata para 01/03, NC07, ND08, guías locales numeradas 09/31 y
notas de venta NV. La ampliación exige composición explícita de fuentes y
autoridades. El ensamblaje público se completó después del ensayo inicial;
véase el incremento de integración al final. No hay despliegue ni activación.

Resultados de esta ejecución:

- 64 pruebas unitarias aprobadas: 23 originales de reportes, 30 de fuentes
  ampliadas y 11 de compatibilidad con historial.
- 1 integración PostgreSQL original de reportes aprobada: persistencia, reinicio,
  captura inmutable, replay, privacidad, concurrencia, CAS y rollback.
- 1 integración PostgreSQL de fuentes ampliadas aprobada: consultas reales
  NC/ND/NV/09/31, captura actual, replay inmutable, filtros por contexto,
  ambiente y serie, persistencia de reportes y límite de fechas de Lima
  04:59:59 UTC frente a 05:00:00 UTC.
- Typecheck de Billing aprobado con --noEmit.
- Ningún contenedor de reportes quedó activo al terminar.
- CSV, XLSX y PDF generados en memoria para 07, 08, NV, 09 y 31. XLSX se abrió con
  ExcelJS para verificar tipo, importe firmado, celdas de texto y hoja Transfers.
  PDF se verificó como archivo PDFKit real; no se realizó una auditoría visual
  de páginas.

Comandos ejecutados:

    pnpm exec vitest run tests/b2b-phase8-reports.spec.ts tests/b2b-phase8-reports-sources.spec.ts tests/b2b-phase8-reports-history.spec.ts --maxWorkers=1 --testTimeout=30000
    pnpm exec vitest run tests/b2b-phase8-reports-db.integration.ts --config tests/b2b-phase8-reports-db.config.mts --reporter=verbose
    pnpm exec vitest run --config tests/b2b-phase8-reports-sources-db.config.mts --reporter=verbose
    pnpm exec tsc -p services/billing-service/tsconfig.json --noEmit --pretty false

Las integraciones usaron únicamente contenedores nuevos etiquetados del helper
ya existente, imagen local postgres:17-alpine con --pull never, --network none,
sin puertos publicados y almacenamiento tmpfs. El esquema de la nueva prueba es
un fixture de lectura ficticio con los nombres de columnas de los propietarios;
no prueba los invariantes de escritura de los productores y no es una migración.
No se consultó ninguna BD existente, archivo de entorno, credencial real, Solarenv
o red oficial. No se invocó compose, migrador ni reset.

Tipos de renderización:

| Tipo | CSV | XLSX | PDF | Tratamiento |
| --- | --- | --- | --- | --- |
| 01/03 | Sí | Sí, con Workbook inyectado | Sí, con PDFKit inyectado | Compatibilidad original; moneda separada. |
| NC07 | Sí | Sí, con Workbook inyectado | Sí, con PDFKit inyectado | Importe original positivo, efecto agregado/exportado negativo. |
| ND08 | Sí | Sí, con Workbook inyectado | Sí, con PDFKit inyectado | Efecto positivo. |
| Guías 09/31 locales | Sí | Sí, con Workbook inyectado | Sí, con PDFKit inyectado | Cantidades por unidad y peso; sin moneda ni ingresos. |
| NV | Sí | Sí, con Workbook inyectado | Sí, con PDFKit inyectado | Valor comercial separado; nunca suma al neto fiscal local. |

Archivos modificados dentro de services/billing-service/src/b2b/phase8-reports/:

- engine.ts
- types.ts
- validation.ts
- renderers.ts
- index.ts
- CONTRACT.md
- RESULTS.md

Archivos nuevos dentro de services/billing-service/src/b2b/phase8-reports/:

- filters.ts
- source-types.ts
- owner-sources.ts
- source-store.ts

Archivos nuevos dentro de tests/:

- b2b-phase8-reports-sources.fixture.ts
- b2b-phase8-reports-sources.spec.ts
- b2b-phase8-reports-sources-db.integration.ts
- b2b-phase8-reports-sources-db.config.mts

No se modificaron phase8-reports-http.ts, postgres-store.ts, los contratos
compartidos, Swagger, conteos de rutas, package.json, Recibidos, mailer, Identity
ni documentación principal. Los cambios preexistentes del proyecto se
preservaron.

Situación de los contratos después de integrar la ampliación (CONTRACT.md):

1. PostgresReportsCorrectionReadAuthority implementa lectura emparejada NC/ND con
   concesiones independientes, Identity vigente, CAS y auditoría inmutable. Cuatro
   casos adicionales verifican el SQL en una base Billing nueva y separada.
2. API, SDK y OpenAPI reconocen BILLING_OWNER_SOURCES mediante el validador
   compartido de filtros, cobertura, importes firmados y metadatos. Cuatro casos
   verifican SDK → NestJS → propietario por HTTPS/mTLS, descarga y revocación.
3. Sólo se cubren las guías locales de Billing verificadas en el código. Guías de
   otro propietario requieren contrato y adaptador HTTP mTLS explícitos; no hay
   acceso a otra BD ni fallback de fuente inventado.

Las capturas conservan importes decimales exactos, hashes y revisiones de permiso,
incluyendo resultados vacíos. Los permisos de fuente se revalidan al leer y después
de obtener el contenido. Los efectos NC/ND son proyecciones locales, no aceptación
SUNAT, facturación autorizada, balance financiero verificado ni autorización de
traslado. Una captura combinada con 01/03 declara que no constituye una transacción
única entre todas las fuentes.

## Integración posterior del 25/10/2026

La revisión principal integró los contratos compartidos, la autoridad de lectura
persistente y las pruebas de transporte. Las listas de archivos anteriores
describen el trabajo inicial del subagente, no el alcance final. La fuente
PostgreSQL ampliada pasó de nuevo su caso de integración aislada; CSV/PDF/XLSX
se verificaron por contenido, sin auditoría visual de páginas. El resultado
global y los comandos reproducibles están en
docs/B2B_FASE8_CIERRE_INTEGRACION.md. No se aplicó DDL a bases existentes ni se
habilitó transmisión fiscal o acceso a otro propietario.

