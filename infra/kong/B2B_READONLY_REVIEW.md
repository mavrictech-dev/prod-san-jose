# Tramo operativo READONLY_OAUTH_WEBHOOKS

Se añadió una composición real y separada de los AppModules y mains actuales. No se modificó Kong ni QA existente. El guard original de ocho owners permanece intacto.

## Camino ejecutable

- `createIdentityReadonlyOwner` en `services/identity-service/src/b2b/readonly-owner-runtime.ts`: B2bIdentity + PostgresB2bStore + claves explícitas; OAuth client_credentials, introspección y autoridad SERVICE de webhooks. No provisioning ni SSO administrativo.
- `createBillingReadonlyOwner` en `services/billing-service/src/b2b/readonly-owner-runtime.ts`: PrismaB2bReadRepository y PrismaB2bContextRepository reales, autorización Identity por mTLS; READ y validación privada de bindings. Sin IssueDocumentService, host adapters de escritura, workers ni SQL hacia otra base.
- `createFiscalReadonlyOwner` en `services/sunat-service/src/b2b/readonly-owner-runtime.ts`: PrismaB2bSunatRead + ArtifactStore explícito + PostgresB2bDownloadAudit; reautoriza en Identity y consulta documentos exclusivamente por RPC a Billing.
- Webhooks reutiliza `createWebhookOwnerRuntime`, PostgresHookStore, HookVault y HttpDeliveryAuthority existentes.
- `bootstrapB2bReadonly` ensambla cuatro transportes HTTPS reales y el nuevo B2bOAuthHttp. Los runtime-status pertenecen a esas factories, comprueban proyecciones SQL reales al crear el owner y en cada consulta de estado. La fachada sólo certifica esas capacidades y guarda NOT_PROBED para ejecución. Ningún estado sintético concede permisos.

El flag B2B_PRIVATE_ACCESS=true es obligatorio en los nuevos hosts y el punto de entrada READONLY. Cada factory exige también B2B_PRIVATE_ACCESS=true explícito. TLS/mTLS y fingerprints se comprueban en listeners y controllers; cada operación conserva scopes, bindings y revalidación independiente. Los puertos privados sólo aceptan los RPC fijados, nunca administración pública.

## Prueba aislada reproducible

Prerrequisitos: dependencias locales y clientes Prisma generados/compilados existentes de Billing y Fiscal, Docker con postgres:17-alpine ya disponible. No se descarga ninguna imagen.

```powershell
pnpm --filter @factuez/service-access build
pnpm --filter @factuez/b2b-api-service typecheck
pnpm exec tsc -p tests/tsconfig.b2b-readonly.json
pnpm exec vitest run --config tests/b2b-readonly-publication.config.mts --reporter=verbose
```

La suite crea un contenedor NUEVO etiquetado, sin red, sin puertos publicados y con PGDATA en tmpfs. Usa cuatro bases nuevas separadas y SQL a través de docker exec; no accede a puertos PostgreSQL del host, DATABASE_URL actual ni credenciales de cliente. El esquema se deriva localmente de los Prisma actuales, sin modificarlos. Las conexiones HTTP son HTTPS/mTLS real en 127.0.0.1:9000–9099, con PKI efímera.

Las factories productivas reciben sus repositorios PostgreSQL reales. No hay doubles de puertos para producir lecturas ni estados. El transporte callback de prueba está limitado al receptor HTTPS sintético de loopback y comprueba la firma HMAC real. El cliente/grants iniciales son fixtures insertados sólo en la base nueva. Se prueban OAuth → documento Billing → XML original Fiscal en disco y auditoría SQL, scopes, peers, aislamiento RUC/BETA, rechazo de escrituras, reinicio de fachada, persistencia de suscripción, challenge HTTPS, evento local privado, entrega HMAC, deduplicación y revocación inmediata, además de pérdida real de almacenamiento.

## Hosts separados y montaje

Los tres nuevos `src/b2b/readonly-host.ts` se ejecutan por separado desde sus `dist/b2b/readonly-host.js`. Exigen B2B_READONLY_OWNER_ENABLED=true y B2B_READONLY_OWNER_CONFIG_ROOT absoluto. Instancian sólo PrismaService con opciones PostgreSQL explícitas y TLS verificado; nunca usan DATABASE_URL heredado. No migran ni aprovisionan.

Cada raíz monta `readonly-owner.json`, `ca.pem`, `server.crt`, `server.key`, `resource.crt`, `resource.key`, `database-ca.pem` y el archivo passwordFile de database. Identity añade `signing-key.pem`, `pepper.bin` (32 bytes), `human-public.pem` y `integration-public.pem`: son claves dedicadas, no claves humanas privadas ni certificados de cliente.

Metadata común de readonly-owner.json:
```json
{
  "schemaVersion": "factuez.b2b.readonly-owner.v1",
  "profile": "READONLY_OAUTH_WEBHOOKS",
  "owner": "billing",
  "environment": "BETA",
  "approvedForPrivateBeta": true,
  "deploymentId": "UUID_V4_DE_LA_REVISION",
  "listen": {"host": "0.0.0.0", "port": 9020},
  "callers": ["SHA256_CERT_RESOURCE"],
  "database": {"host": "review-db", "port": 5432, "name": "billing_readonly_beta", "user": "billing_readonly", "passwordFile": "database-password.bin"},
  "registrar": ["SHA256_CERT_RESOURCE_IDENTITY"],
  "identityOrigin": "https://identity-readonly:9010"
}
```

Los placeholders deben sustituirse por valores sintéticos válidos. Identity cambia owner/database por identity/identity_readonly_beta y requiere tokenPeers (certificado OAuth dedicado), webhookPeers, billingOrigin y tokenIssuer, sin registrar ni identityOrigin. Fiscal cambia owner/database por fiscal/fiscal_readonly_beta y requiere identityOrigin, billingOrigin y artifactsRoot, sin registrar. Todas las bases son del owner respectivo; el nombre fijado de los nuevos hosts impide apuntar accidentalmente a la base habitual. Los certificados deben incluir SAN de su servicio y 127.0.0.1 para healthchecks. Los certificados resource de healthcheck deben estar en callers.

La fachada monta `readonly-runtime.json` con schemaVersion=factuez.b2b.readonly-runtime.v1, profile=READONLY_OAUTH_WEBHOOKS, environment=BETA, approvedForPrivateBeta=true, deploymentId/instanceId UUID v4, listen={host,port:9000,maintenancePort:9001}, edgePeers, operatorPeers y origins exactamente identity/billing/fiscal/webhooks. Esas origins deben ser distintas, HTTPS y usar 9000–9099. Monta además los PEM habituales, `oauth.crt`/`oauth.key` separados del resource y de los peers edge/operator, y `b2b-operations.json` inicialmente:
```json
{"environment":"BETA","revision":1,"mode":"PAUSED"}
```
La apertura exige reemplazar esa política por OPEN con revisión mayor. El montaje del proceso es de sólo lectura; el operador dueño del directorio cambia el archivo en el host. Pausa/cierre drenan operaciones antes de liberar listeners; ningún guard se abre por el perfil.

## Compose de revisión

`compose.b2b-readonly.review.yml` es independiente, no se levantó ni se fusionó con un stack existente. Sólo publica 127.0.0.1:9000 y :9001. Los owners y PostgreSQL quedan en una red interna, sin puertos del host ni salida oficial. Las imágenes deben estar previamente construidas localmente con contracts/service-access/Billing/Identity/Fiscal/Webhooks/API compilados, incluidos los nuevos hosts. No se hace pull.

Variables requeridas para revisar `docker compose -f infra/kong/compose.b2b-readonly.review.yml config --quiet`: B2B_READONLY_REVIEW_IMAGE, B2B_READONLY_POSTGRES_IMAGE y B2B_READONLY_REVIEW_ROOT. La raíz NUEVA debe tener subdirectorios api/identity/billing/fiscal/webhooks/postgres/init/originals con ACL/ownership de sus respectivos procesos. PostgreSQL exige TLS server.crt/server.key/password.bin en postgres; init contiene exclusivamente los esquemas y fixtures sintéticos para las bases separadas, con roles propios y mínimos permisos (lectura en Billing, lectura y auditoría en Fiscal, auditoría/rate buckets en Identity). No se incluye SQL de provisioning automático en código de arranque.

Webhooks conserva su bootstrap actual, database=b2b_webhooks_beta, TLS a PostgreSQL, vault dedicado, destinations=[], dispatchEnabled=false, puerto 9040 y maintenancePort=9041; resource/callers deben permitir sus RPC privados y status. No salen callbacks desde este fragmento; la prueba HTTPS local valida la entrega por separado.

## Límites reales

- Perfil de negocio READONLY con gestión de suscripciones; no habilita emisión, numeración, borradores, exports, recepción, maestros, reportes, history o mailer. No representa el grafo completo listo.
- PDF está fuera del perfil: routes y localRepresentations deshabilitadas. Sólo entrega originales ya existentes con integridad; no inventa XML firmado ni CDR y no afirma aceptación fiscal.
- La factory mínima Identity publica sólo SERVICE. USER requiere delegación/SSO del runtime Identity completo; sin él falla cerrado. No hay usuario ficticio de máquina ni elevación para obtener grants.
- Para uso fuera del test hacen falta un cliente SERVICE y bindings previamente autorizados/provisionados por `B2bIdentity.create` del owner Identity con su autoridad administrativa SSO real. Las factories mínimas no publican ese método ni el endpoint de alta. La prueba sólo inserta un cliente sintético en su base nueva. Los clientes deben tener scopes compatibles con el perfil mínimo.
- La publicación de eventos necesita el publisher real del Billing de escritura y sus commits persistidos; el Billing READ mínimo no emite eventos. La suite inyecta por el RPC privado un evento marcado NOT_ASSERTED y comprueba entrega persistente. El fragmento no activa el publisher, workers ni callbacks.
- El SQL completo e integración general del Billing actual pertenecen a main. Estas factories no alteran ese código ni resuelven implícitamente su grafo de escritura.

## Verificación de esta entrega

La suite exclusiva terminó con 15 pruebas aprobadas (10 de integración HTTPS/mTLS) en 3 archivos. El typecheck de todos los archivos nuevos pasó con tests/tsconfig.b2b-readonly.json; también pasaron los typechecks de service-access, B2B API, Billing e Identity. Se validó el compose con docker compose config --quiet usando un env vacío y valores sintéticos, sin arrancarlo. El contenedor PostgreSQL etiquetado de la suite se destruyó al finalizar.

El typecheck global de Fiscal encontró errores ajenos a estos archivos nuevos en src/application/production-pdf.service.ts (exports renderProductionInvoicePdf y ProductionPdfEvidence) y src/infrastructure/crypto/public-signer-archive.ts:115 (string | undefined). No se modificaron: pertenecen al trabajo paralelo de PDF/firma. No se afirma que el build global esté cerrado mientras persistan esos errores.