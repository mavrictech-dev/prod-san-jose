# Descriptor OnPrem + READONLY — consulta de comprobantes y gestión de webhooks

**Significado de READONLY:** consulta de comprobantes y gestión de webhooks. No permite mutaciones fiscales ni emisión, pero sí mutaciones de suscripciones/secretos/verificación/replay de webhooks mediante `b2b:webhooks:manage`, sujetas a sus guards y scopes actuales. No significa “100 % sin mutaciones”. No se cambió la API ni el conjunto de permisos probado.

Este sidecar prepara exclusivamente configuración pública para una instalación NUEVA BETA. No modifica App/PWA, el bloque OnPrem congelado, Kong, rollout QA, datos, procesos ni esquemas.

## Revisión de generadores existentes

Se revisaron antes de implementar:

- `../ubuntu-vps/generate-review.mjs`: genera revisión VPS con `review-blocked.sh`, inventario global y configuración sin ensamblar. No emite `onprem-admin.json` ni `readonly-owner.json`; no sirve como instalador de este tramo. Se conserva intacto.
- `../deployment-backup/synthetic-local-bundle.mjs`: empaqueta/restaura archivos sintéticos, no genera configuración de arranque. Se conserva intacto.
- `../../kong/compose.b2b-readonly.review.yml`: ya describe imágenes, red y montajes de revisión, pero requiere JSON/PKI preparados por TI; no es generador.
- Hosts reales revisados: Identity/Billing/Fiscal `src/b2b/readonly-host.ts`, Webhooks `src/main.ts`, fachada `src/readonly-main.ts` y OnPrem `onprem-admin-runtime.ts`.

`plan.mjs` resuelve esa preparación pública; no intenta reemplazar esos hosts ni sus guards.

## Uso para TI, sin inventar JSON ni fingerprints

1. Copiar `descriptor.example.json` a una carpeta NUEVA de preparación. Editar sólo datos de instalación: origen PWA HTTPS, sus orígenes browser YA autorizados, issuer B2B, direcciones privadas TLS, metadatos públicos de las bases y rutas Linux de montaje. Usar UUID v4 propios para deployment/instancias; los UUID del ejemplo son sólo de ejemplo. No poner passwords, claves, DSN, credenciales ni tokens en el descriptor.
2. Obtener del responsable PKI los certificados y SPKI PÚBLICOS con los nombres declarados en `caFiles`, `certificateFiles`, `publicKeyFiles`; ubicarlos en `publicFilesRoot` relativo al descriptor. Se admiten .crt/.pem públicos, archivos regulares sin symlinks/hardlinks. El CLI no emite ni solicita private keys. Los certificados reales deben ser suministrados por TI, no tomados del fixture de pruebas.
3. Ejecutar desde la raíz del repositorio, con un destino NUEVO cuyo padre ya exista:

```powershell
node infra/b2b/install-plan/plan.mjs --descriptor D:\\PreparacionNueva\\descriptor.json --out D:\\PreparacionNueva\\plan-01
```

También funciona con rutas Linux absolutas. No requiere pnpm, Docker ni compilación de servicios. Sólo Node con X509Certificate (Node 22 o posterior recomendado para coincidir con las imágenes existentes). No lee .env ni variables de credenciales.

La salida contiene:

- `plan.json`: problemas exactos por rol/archivo y acción, fingerprints derivados, comandos de bootstrap existentes, roots de configuración, esquema/routing/runtime pendientes. Nunca afirma que el servicio esté listo.
- `mount-layout.json`: cada fuente pública y target de montaje; cada private key/pepper/password/vault figura como `PRIVATE_NOT_INSPECTED`, con requisito exacto y grupo compartido cuando corresponde.
- `install.disabled.env`: TODOS los flags del tramo en false y UI SSO; cada subcarpeta incluye además su `install.disabled.env` con el CONFIG_ROOT correspondiente y B2B_PRIVATE_ACCESS=false para esta instalación NUEVA.
- `b2b-operations.json`: PAUSED, revisión 1.
- Cuando todos los públicos validan: `onprem/onprem-admin.json`, `identity|billing|fiscal/readonly-owner.json`, `webhooks/runtime.json`, `api/readonly-runtime.json`, `api/b2b-operations.json`.

Los JSON se derivan de un solo descriptor: no hay que calcular/manualizar fingerprints, pares caller/registrar ni las listas OAuth/edge/operator. El planner NO copia PEM ni material privado: el manifiesto permite a TI montar cada archivo autorizado.

No se fusiona ni sobrescribe un directorio existente. Un ensayo nuevo debe usar otra carpeta nueva. El CLI tampoco borra archivos.

Códigos de salida:

| Código | Resultado | Acción |
| --- | --- | --- |
| 0 | PUBLIC_CONFIGURATION_VALIDATED | Públicos válidos; revisar el plan y aportar privados externamente. No significa runtime listo. |
| 2 | PUBLIC_INPUTS_NEED_ACTION | Leer issues de plan.json; aporta los archivos públicos precisos o corrige certificado/CA/SAN/EKU. No se generan JSON runtime incompletos. |
| 1 | Descriptor/salida inválidos | Corregir el código concreto: origen, puertos, nombres de DB, Identity compartido, rutas o destino existente. No se arranca nada. |

## PKI: comprobaciones públicas y límites

Se comprueba localmente vigencia, CA raíz autofirmada directa, firma de cada leaf con la CA privada declarada, clave TLS RSA ≥2048/curva admitida, EKU serverAuth o clientAuth, y SAN del hostname de cada origin. Los cinco certificados servidor incluyen además SAN 127.0.0.1 para los healthchecks del compose existente.

Este sidecar v1 admite CA raíz directa → leaf. Si la PKI corporativa usa intermediarias, TI debe adaptar la preparación a ese modelo o extender el validador antes de usarlo; el CLI rechaza esa cadena en lugar de ignorarla. No consulta CRL/OCSP ni prueba DNS/handshakes.

Roles públicos:

| Rol | Uso |
| --- | --- |
| identityServer/billingServer/fiscalServer/webhooksServer/apiServer | server.crt del owner correspondiente; SAN de su origin + 127.0.0.1 |
| resource | cliente mTLS de fachada y owners para introspección/read/status |
| oauth | cliente dedicado hacia /b2b/oauth/token; separado de resource |
| edge | cliente del edge hacia fachada; separado de OAuth/resource/operator |
| operator | mantenimiento privado; separado de todos los anteriores |
| onpremResource | catálogo Billing desde Identity nativo; puede compartir resource, nunca edge/operator/OAuth |
| webhookPublisher | ingestión privada de eventos desde Billing escritura; certificado dedicado |

No se reutiliza el mismo certificado entre roles dedicados. La clave pública de firma B2B debe ser RSA ≥2048 y distinta de las públicas humana/integración y de todas las claves TLS. Los SPKI sólo sirven para comprobar separación y declarar el privado esperado; NO prueban que la private key montada corresponda. Un PEM privado disfrazado de público se rechaza y no se refleja en salida.

El CLI no abre, imprime, compara ni firma con ningún .key/.bin. Por ello declara explícitamente pendientes: correspondencia cert↔private key, firma B2B↔SPKI, igualdad del pepper entre procesos, passwords correctos, vault, ACL y custodia. Estas verificaciones deben hacerse con tooling autorizado de TI, sin enviar claves al planner.

## Restricción operativa decisiva: base de Identity compartida

Los hosts readonly actuales fijan:

| Host | Nombre de DB obligatorio |
| --- | --- |
| Identity readonly | identity_readonly_beta |
| Billing readonly | billing_readonly_beta |
| Fiscal readonly | fiscal_readonly_beta |
| Webhooks | b2b_webhooks_beta, puerto PostgreSQL 5432 fijo |

`nativeIdentityDatabase` debe declarar el MISMO host/puerto/nombre que `databases.identity`. Puede usar un rol PostgreSQL distinto con permisos propios. Un descriptor con bases Identity diferentes se rechaza: crear el cliente en OnPrem y autenticar contra otra base nunca funcionaría. No hay SQL crossDB ni copia/sincronización automática.

Para cliente NUEVO, main debe preparar Identity nativo con su esquema User/RBAC, sesiones browser y las tres tablas B2B en esa misma base autorizada. Si el nombre de DB nativo real difiere de identity_readonly_beta, este host readonly no sirve sin adaptación: main puede componer `createIdentityReadonlyOwner` con el Prisma nativo apropiado (factory existente), o revisar el guard de nombre del host en otro bloque explícito. Este sidecar no debilita ese guard ni renombra/copía una base.

Además, Identity nativo OnPrem y Identity readonly deben compartir issuer B2B, signing-key y pepper. El descriptor genera el mismo issuer, y el manifiesto agrupa esos dos privados. El matching privado queda sin inspeccionar; no se finge verificación.

## Montajes y aprobación, por main

Todos los flags generados permanecen false. Todos los JSON contienen `approvedForPrivateBeta:false` o `approvedForLocalSetup:false`: reflejan que generar un plan no es aprobarlo. Los parsers reales rechazarán arrancarlos así. Los env por host también contienen B2B_PRIVATE_ACCESS=false para la instalación NUEVA; main debe aprobar y establecer true al habilitar el acceso privado. No copiar ese valor sobre el flag compartido de un stack QA existente. Cuando main revise y apruebe los valores, puede cambiar esas aprobaciones en los montajes finales y habilitar cada flag de forma controlada. El CLI no realiza ese paso.

Los paths destino son Linux de despliegue; `publicFilesRoot` es local al ordenador de preparación. El output no es un directorio listo para montar completo: TI distribuye sus archivos según `mount-layout.json`.

Material privado requerido, nunca generado:

- server.key para cada uno de los cinco listeners y resource.key para sus clientes.
- api/oauth.key; onprem/resource.key.
- identity y onprem/signing-key.pem, pepper.bin compartidos entre ambos.
- identity/billing/fiscal/webhooks/database-password.bin de su rol propio; database-ca.pem público.
- webhooks/vault-v1.bin de 32 bytes, independiente del pepper.
- originales Fiscal en artifactsRoot del owner; no inventar XML/CDR ni importar archivos cliente en el ensayo.

Los certificados de edge/operator/webhookPublisher se usan como allowlists; sus claves deben quedar en sus hosts propietarios, fuera de este plan.

Rutas Kong, sólo fragmentos a incorporar manualmente por main:

- `/api/v1/b2b-admin` → servicio Identity nativo, HTTPS, `strip_path:false`, mismo origen de PWA.
- Edge mTLS privado hacia fachada READONLY para `/b2b/oauth/token` y `/b2b/v1`, presentando certificado edge. No publicar puertos owner ni `/internal/b2b/*`.
- Mantenimiento separado con certificado operator. Conservar host bindings de revisión únicamente 127.0.0.1, puertos 9000–9099.

No se modifica el Kong/compose QA existente. El compose de revisión actual usa PostgreSQL único para su ensayo; si el descriptor usa hosts PostgreSQL por owner, main ajusta su NUEVA composición expresamente. No asumir que copiar el JSON cambia la red o los mounts de ese compose.

## Qué falta para un B2B operativo, con acciones verificables

1. **Públicos correctos:** el planner indica exactamente cuáles faltan. Ningún certificado real de cliente se ha leído en esta entrega.
2. **Privados y ACL:** aprovisionar por canal TI y comprobar match externamente según manifiesto.
3. **Storage owner real:** esquema Prisma Billing/Fiscal, auditoría B2bArtifactAudit, Webhooks dedicado y originales propios. Identity: DDL mínimo existente `services/identity-service/src/b2b/onprem-admin.minimal.sql` sólo tras revisar si faltan tablas; no se genera/applica un duplicado. Permisos y snapshots activos reales deben existir.
4. **Admin humano válido:** User ADMIN/GLOBAL activo con setup.manage/user.manage/role.manage y sesión browser actual válida en Redis; sin usuarios ficticios ni bypass SSO. El usuario vuelve a escribir su contraseña actual en OnPrem.
5. **Imágenes y wiring:** compilar hosts existentes, configurar mTLS/DNS/red privada, ruta de PWA y mismo almacén Identity. Los puertos/restricciones no se prueban contra QA.
6. **Ensayo de main:** owners publican status tras storage check; fachada inicia PAUSED; OnPrem confirma enabled; contraseña real → crear SERVICE BETA → OAuth → documento/XML original con auditoría → revocar y comprobar rechazo. No se ejecuta desde este CLI.
7. **Webhooks:** suscripciones y persistencia disponibles, pero el Billing READ NO produce eventos. Para emitir eventos reales falta integrar el publisher persistente del Billing de escritura; destinations y dispatch se dejan deshabilitados.
8. **Cobertura acotada:** no están habilitados por este perfil emisión, numeración, producción fiscal, PDF, recepción, history, exports, mailer o el fullgraph de ocho owners.

## Ensayo de este sidecar

```powershell
node --check infra/b2b/install-plan/plan.mjs
node --test tests/b2b-install-plan.node-test.mjs
pnpm exec vitest run tests/b2b-install-plan-compatibility.spec.ts --maxWorkers=1
```

Las pruebas emiten PKI SINTÉTICA sólo dentro del fixture temporal, aportan sus certificados públicos al CLI y destruyen el directorio propio al finalizar. La implementación del CLI no importa el fixture ni incluye generación de claves. Las pruebas verifican faltantes, firma incorrecta, SAN/EKU, vencimiento, separación de roles/firma, rechazo de material privado, no sobrescritura y compatibilidad de los JSON con parsers públicos actuales. No hay red, subprocess runtime, SQL, Docker ni arranque de servicios.

Resultado de esta entrega: 9 pruebas Node + 1 prueba de compatibilidad aprobadas, sintaxis CLI correcta. La invocación real del descriptor de ejemplo sin públicos terminó con exit 2, 16 archivos públicos concretos ausentes y acciones por archivo; también se ensayó la compilación completa con PKI pública sintética temporal. Los resultados están en rehearsal.result.json. No se ejecutó red/SQL/Docker, no se leyó material privado real, no se modificó App/PWA ni el bloque OnPrem congelado. El nombre READONLY conserva su significado acotado: consulta de comprobantes y gestión de webhooks; no significa ausencia total de mutaciones. Sidecar cerrado para integración por main.