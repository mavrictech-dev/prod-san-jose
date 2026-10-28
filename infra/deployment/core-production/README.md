# Core producciÃ³n â€” Compose ejecutable para revisiÃ³n TI, sin arranque

Incluye docker-compose.yml y kong.yml (JSON vÃ¡lido como YAML), esta guÃ­a, validate.mjs y preflight.mjs. Los verificadores contrastan el contrato y la preparaciÃ³n del servidor. No cambia root compose, QA, AppModules ni PWA. No ejecuta imÃ¡genes, contenedores, red, SQL ni instalaciÃ³n. No usa profiles ni shells que rechazan arrancar: cada proceso usa su host real.

## Arquitectura y presupuesto

| Proceso | Puerto interno / health real | RAM mÃ¡xima bytes | CPU |
| --- | --- | ---: | ---: |
| PostgreSQL 17 | 5432 / pg_isready | 1.400.000.000 | 1,5 |
| Redis 7.4 | 6379 / redis-cli PING autenticado | 450.000.000 | 0,5 |
| Identity Nest | 3001 /health | 450.000.000 | 0,5 |
| Billing Nest | 3002 /health | 750.000.000 | 1 |
| SUNAT Nest | 3003 /health | 1.800.000.000 | 2 |
| Mailer Nest | 3004 /health | 450.000.000 | 0,5 |
| Realtime Nest | 3005 /health | 250.000.000 | 0,25 |
| PWA Next | 3000 /login | 900.000.000 | 1 |
| Kong | 8000 / kong health | 350.000.000 | 0,5 |
| Received Nest | 3006 /health (consulta DB) | 550.000.000 | 0,5 |
| Received sync | 3007 /health (latido scheduler) | 350.000.000 | 0,25 |
| **Total de lÃ­mites** | **11 procesos** | **7.700.000.000** | **8,5** |

No se aÃ±ade un proceso reporting inventado: el servicio de reporting del compose raÃ­z no es parte de este core. Received se incluye porque sus dos entrypoints y healthchecks ya existen; usa factuez_received y no comparte tablas Billing/SUNAT.

Tope solicitado: 8.000.000.000 bytes para contenedores, memswap_limit igual a mem_limit. No es promesa de RSS ni suma de memoria reservada del host: quedan recursos para SO/otros procesos en la mÃ¡quina de 10 cores. Logs por servicio json-file, 10m Ã— 3, restart=unless-stopped. CPU total limitado a 8,5. Sin builds, apt, seed, migradores ni pulls automÃ¡ticos.

SÃ³lo Kong publica **127.0.0.1:9000 â†’ 8000**. PostgreSQL/Redis no publican puertos. private-db, core y edge son redes internas; Kong no estÃ¡ en private-db y PWA sÃ³lo estÃ¡ en edge. SÃ³lo SUNAT/Mailer tienen red egress no interna. Eso permite las conexiones oficiales/SMTP autorizadas; no es un firewall por hostname. TI controla egreso/DNS/firewall exterior hacia SUNAT y SMTP aprobados, sin abrir DB a Internet.

Kong recibe HTTP en loopback; el terminador HTTPS del host de TI publica el origen canÃ³nico y proxy de websockets a 127.0.0.1:9000. No se agrega otro contenedor/proxy ni puerto pÃºblico. AUTH_BROWSER_ORIGINS y WS_ALLOWED_ORIGINS deben ser ese origen HTTPS, conservando Origin/Host y cookies Secure. Las llamadas entre hosts nativos usan HTTP en redes Docker privadas: no se finge mTLS B2B ni cifrado PostgreSQL que estos hosts nativos no configuran.

## ImÃ¡genes y variables obligatorias

Cada imagen debe ser repository@sha256:<64 hex>, digest aprobado por TI y disponible localmente antes del arranque. El Compose tiene variables REQUIRED sin valores locales/ficticios. No hay imagen construida ni digest inventado en esta entrega.

Variables pÃºblicas: ejecutar `node infra/deployment/core-production/validate.mjs` imprime la lista exacta requerida. Guardarlas en un JSON pÃºblico para validar y en un env de Compose revisado por TI (ninguno contiene secretos):

- CORE_POSTGRES_IMAGE (contrato PostgreSQL 17), CORE_REDIS_IMAGE (7.4), CORE_KONG_IMAGE.
- CORE_IDENTITY_SERVICE_IMAGE, CORE_BILLING_SERVICE_IMAGE, CORE_SUNAT_SERVICE_IMAGE, CORE_MAILER_WORKER_IMAGE, CORE_REALTIME_SERVICE_IMAGE, CORE_RECEIVED_DOCUMENTS_SERVICE_IMAGE, CORE_WEB_PWA_IMAGE. La imagen Received se reutiliza para su worker.
- CORE_ROOT: directorio NUEVO existente bajo /srv, por ejemplo el elegido por TI para esta instalaciÃ³n; nunca /var ni el data root QA.
- CORE_PG_ADMIN_USER: rol administrador YA creado en el cluster manual.
- CORE_INITIAL_ADMIN_USERNAME y CORE_INITIAL_ADMIN_FULL_NAME: identidad humana aprobada por TI, ambas obligatorias, sin cuenta demo por defecto. La contraseÃ±a procede sÃ³lo del secret initial_admin_password.
- CORE_HTTPS_ORIGIN: origen HTTPS exacto, sin slash final.
- CORE_SMTP_APPROVED_HOSTS: lista DNS explÃ­cita separada por comas; no credenciales.
- CORE_ISSUER_ROOTS_SHA256, CORE_CRLS_SHA256, CORE_CDR_SIGNERS_SHA256: hashes hex de los pÃºblicos exactos montados.
- CORE_SUNAT_PRODUCTION_WSDL: endpoint oficial HTTPS vigente verificado por TI. Ninguna conexiÃ³n de prueba oficial se hace aquÃ­.

Contrato de imÃ¡genes: Node 22, workspace /workspace, servicios compilados en services/<owner>/dist/main.js y deps/clientes Prisma preparados por CI/TI segÃºn docker/Dockerfile.service. Las imÃ¡genes deben poder ejecutarse como uid/gid 1000:1000. PWA usa el layout real de docker/Dockerfile.web-pwa: /workspace/apps/web-pwa, Next ya compilado y node_modules/next/dist/bin/next disponible; NEXT_PUBLIC_API_BASE_URL vacÃ­o y B2B_ADMIN_PROFILE=SSO se fijan TAMBIÃ‰N al compilar esa imagen. Cambiar el env runtime no modifica un bundle Next pÃºblico ya compilado.

SUNAT requiere /usr/bin/openssl y /usr/bin/xmllint ya incluidos en su imagen aprobada. No instalar paquetes al arrancar. El ZIP XSD se monta en el path real que usa XsdValidationService, no mediante un env inexistente.

## Datos, secretos y montajes

TI crea previamente cada directorio/archivo y ajusta propietario/ACL. Todos son bind explÃ­citos con create_host_path=false. El Compose no crea carpetas del host.

Bajo CORE_ROOT:
- data/postgres: cluster preinicializado, ownership del usuario postgres real de la imagen.
- data/redis: ownership uid/gid 1000:1000. Redis se ejecuta expresamente con ese usuario para poder leer sus secretos 0600, compartidos con los servicios Node, sin abrir permisos a otros usuarios.
- data/artifacts y data/sunat-private: originales/vault SUNAT propios, uid 1000.
- data/print-branding y data/next-cache: uid 1000.
- config/pg_hba.conf: reglas revisadas scram-sha-256 para los roles y red private-db; sin reglas trust ni escucha pÃºblica.
- kong.yml incluido junto al Compose: declarativo core listo; bind relativo ./kong.yml, readonly, sin creaciÃ³n de rutas a mano. Distribuir estos archivos juntos conservando esa ruta.
- config/pki/issuer-roots.pem, crls.pem, cdr-signers.pem: pÃºblicos fijados por SHA256, montados readonly.
- config/xsd/xsd-20220228.zip: pÃºblico oficial exacto, readonly. TamaÃ±o 609363, SHA256 **5cac9d9353521340fbc15d23f465a4946b004535b9ff411541c87da01694dbd5** segÃºn el cÃ³digo actual.

Archivos secretos requeridos en secrets/:
identity_db_password, billing_db_password, sunat_db_password, mailer_db_password, received_db_password,
redis_password, redis_acl, jwt_private_key, jwt_public_key, internal_service_token,
app_master_key, smtp_settings_key, reception_settings_key, **production_notes_owner_key**, **initial_admin_password**.

No se incluye ninguna contraseÃ±a por defecto, RUC, P12, SOL, cliente SMTP, grant ni valor de secreto. redis_acl debe configurar el usuario default autenticado con el MISMO password de redis_password (el cliente actual no manda username), permisos de comandos/canales necesarios para BullMQ y sin modo sin contraseÃ±a. No imprimir ese ACL ni passwords.

**Clave de propietario de notas:** PRODUCTION_NOTES_OWNER_KEY_FILE=/run/secrets/production_notes_owner_key en Billing y SUNAT; ambos referencian el MISMO source secret production_notes_owner_key del host, no dos copias independientes. Contenido: 64 hex (32 bytes), opcional newline; archivo regular real, sin symlink en ningÃºn componente, nlink=1, POSIX mode EXACTO 0600, owner uid 1000 y legible por ambos procesos. El Compose declara uid/gid 1000 y mode 0600, pero Docker Compose local file secrets puede ignorar el remapeo/mode: **el fichero fuente ya debe tener ownership y 0600 correctos**. Un secret driver que usa symlink o 0444 es incompatible con el cargador actual. No hardlink ni sustituciÃ³n por JWT, SOL, P12, app_master_key o smtp_settings_key.

smtp_settings_key es dedicada a la configuraciÃ³n SMTP cifrada; no reutilizar app_master_key, reception_settings_key o production_notes_owner_key. TI verifica formato contra SmtpConfigurationVault antes de arrancar, sin revelar su valor. Todos los privados quedan fuera de contexto de build y repositorio. Los P12/SOL/SMTP reales se configuran posteriormente por los controllers autorizados; no se montan ni se importan desde esta entrega.

## InicializaciÃ³n y DDL: tarea manual revisada, nunca runtime

PostgreSQL utiliza entrypoint real `postgres` como usuario postgres sobre PGDATA existente: no ejecuta docker-entrypoint.sh, initdb ni /docker-entrypoint-initdb.d al levantar este stack. Si PGDATA estÃ¡ vacÃ­o, debe fallar: TI prepara el cluster antes, en una tarea manual independiente, con su password/roles. No se proporciona comando de aprovisionamiento automÃ¡tico ni se rota un password.

Crear cinco DBs owner-separated: factuez_identity, factuez_billing, factuez_sunat, factuez_mailer, factuez_received, con roles homÃ³nimos de mÃ­nimo privilegio y passwords desde sus archivos. El esquema se prepara en una tarea revisada ANTES de `up`.

Para una base NUEVA, usar el exportador offline del proyecto: `scripts/export-production-schemas.cjs`. Su bundle verificado es `output/install/core-schema-20261028-v2`, con un SQL por owner y `manifest.json` con bytes/SHA256, generado desde Prisma `migrate diff --from-empty` + DDL actual de notas/mail y CHECKs baseline de FiscalDispatch v2. El script sÃ³lo empaqueta SQL, no conecta a una BD; no lo ejecutÃ³ este bloque.

```sh
# Main/TI, generaciÃ³n offline hacia una salida ABSOLUTA NUEVA cuyo padre existe:
node scripts/export-production-schemas.cjs /srv/LA_INSTALACION_ELEGIDA/core-schema-review-NUEVO
```

TI debe revisar el bundle final y comparar cada fichero con SHA256/bytes del manifest.json antes de una aplicaciÃ³n MANUAL en la DB exacta vacÃ­a. El bundle exige `factuez.schema_target` igual a current_database() y rechaza tablas/enums ya existentes. Validar los guards del exportador y el orden de aplicaciÃ³n antes de ejecutar; la generaciÃ³n por sÃ­ sola no certifica instalaciÃ³n SQL. No aÃ±adir migradores a Compose, no `db push`, no seed y no reconstruir un bundle distinto concatenando viejos SQL a mano.

Correspondencia SQL/DB: identity-service.sql â†’ factuez_identity; billing-service.sql â†’ factuez_billing; sunat-service.sql â†’ factuez_sunat; mailer-worker.sql â†’ factuez_mailer; received-documents-service.sql â†’ factuez_received. TI aplica cada fichero como el dueÃ±o de esa DB; no SQL crossDB.

**Exclusiones crÃ­ticas:** NO incluir `services/billing-service/prisma/constraints.sql` antiguo (restricciÃ³n singleton incompatible con multi-RUC). NO reejecutar `services/sunat-service/prisma/production-dispatch.sql`: FiscalDispatchAuthorization/Audit ya vienen de Prisma; el exportador aÃ±ade CHECKs baseline nuevos compatibles con 01/03 y v2, sin duplicar esas tablas. Tampoco aplicar instaladores SMTP sobre tablas que el baseline ya haya creado: el bundle final de exportador ya resuelve esa composiciÃ³n. Los SQL raw de notas/mail que no figuran en Prisma deben estar incorporados UNA VEZ en el bundle y en su manifest, no ejecutados otra vez desde runtime.

Identity actual mantiene un upsert real de catÃ¡logo RBAC/roles en RbacBootstrapService al iniciar, sin flag para desactivarlo. Sobre Identity NUEVO con cero usuarios, el bootstrap existente crea **un primer administrador humano configurado explÃ­citamente por TI**:
- INITIAL_ADMIN_USERNAME=${CORE_INITIAL_ADMIN_USERNAME:?} e INITIAL_ADMIN_FULL_NAME=${CORE_INITIAL_ADMIN_FULL_NAME:?}; faltan valores â†’ Compose no se resuelve. No hay username/fullname demo ni usuario ficticio.
- INITIAL_ADMIN_PASSWORD_FILE=/run/secrets/initial_admin_password. El Ãºnico source es CORE_ROOT/secrets/initial_admin_password, preparado por TI antes del arranque: archivo regular real, sin symlink ni hardlink, nlink=1, owner uid 1000, POSIX 0600. Contenido de contraseÃ±a humana aprobada (12â€“256 caracteres despuÃ©s del trim), nunca env/log/repositorio ni clave reutilizada. El Compose declara uid/gid 1000, mode 0600, pero el source local DEBE tener esos permisos ya aplicados porque el driver file-secret puede ignorarlos.
- RbacBootstrapService lee ese archivo TI y usa PasswordService.hash actual, crea el rol/asignaciÃ³n ADMIN en su esquema propio y no inserta RUC, cliente, producto, series ni negocio. Esto es inicializaciÃ³n humana autorizada, no seed de negocio ni sustituciÃ³n del auth.
- Si ya existe ese username, el cÃ³digo actual lo conserva y NO cambia su contraseÃ±a. Mantener estable el username aprobado tras la primera instalaciÃ³n: cambiarlo por otro ausente puede crear otro admin; no usar ese mecanismo para rotaciones ni para introducir una cuenta adicional.
- El alta ocurre al arrancar Identity sÃ³lo despuÃ©s de que main/TI revisen la configuraciÃ³n y preparen la DB vacÃ­a. Este bloque no leyÃ³ el password ni ejecutÃ³ el bootstrap. La autenticaciÃ³n posterior y setup de emisor/certificados/grants se hace por la app con ese humano.

Received conserva API y worker reales, pero RECEIVED_LIVE_READ_ALLOWED=false, fixtures=false y allowlist IMAP vacÃ­a. No se afirma recepciÃ³n externa automatizada habilitada: requiere setup separado y autorizaciÃ³n de cliente posterior.

**InstalaciÃ³n inicial sin grants/jobs:** FiscalDispatchAuthorization y ProductionNotesGrant sin autorizaciones activas; CorporateSmtpActivation y CorporateDocumentActivation sin activaciones activas; colas Redis/jobs/outboxes de una instalaciÃ³n NUEVA vacÃ­os. No reutilizar volÃºmenes/Redis de QA u otra instalaciÃ³n, no importar grants desde dumps. Si TI restaura datos, debe auditar/revocar grants y trabajos pendientes antes de habilitar estos flags, en otro procedimiento explÃ­cito.

## Servidor instalado â‰  envÃ­o autorizado

Se instalan en true los flags solicitados:
BILLING_PRODUCTION_ISSUANCE_ENABLED, SUNAT_PRODUCTION_WORKFLOW_ENABLED,
BILLING_PRODUCTION_NOTES_ENABLED, SUNAT_PRODUCTION_NOTES_ENABLED,
SERVER_SMTP_ENABLED, SERVER_SMTP_DOCUMENTS_ENABLED.

No son grants por RUC. ConfiguraciÃ³n por admin GLOBAL, permisos actuales, credenciales/revisiÃ³n, PKI/CRL/XSD/CDR, readiness autenticado y confirmaciÃ³n explÃ­cita por RUC siguen siendo obligatorios. Sin grants actuales vÃ¡lidos, no debe haber envÃ­o. No hay RUC autorizado por env, ni activar/reautorizar silenciosamente en startup.

Los QA/BETA flags permanecen false, incluyendo transmisiÃ³n beta/GRE/laboratorio, LocalMail/Mailpit, diagnÃ³sticos SMTP y fixtures de recepciÃ³n. Se permiten controllers SMTP reales con allowlist global y grants separados TEST/DOCUMENT por RUC; no se manda test automÃ¡ticamente. El worker corporativo existente usa concurrency=2 interna aunque MAIL_CONCURRENCY sea 1 para otros caminos; el lÃ­mite de memoria/CPU controla ese proceso, no se finge reducir ese worker con un env que no usa.

Healthchecks usan endpoints reales. Identity/Billing/SUNAT /health prueban HTTP liveness; Mailer /health informa CORPORATE_SMTP, LOCAL_MAILPIT o DISABLED segÃºn los flags reales y marca readiness NOT_PROBED; nunca acredita preparaciÃ³n SMTP ni entrega. Received /health consulta su DB, worker consulta latido. No confundir ningÃºn health green con autorizaciÃ³n fiscal, PKI o entrega SMTP. Tras admin, revisar PWA/readiness/estado de grants por sus APIs reales antes de una operaciÃ³n real autorizada.

## Kong declarativo incluido: rutas reales, sin reconstrucciÃ³n por TI

El archivo **kong.yml** adjunto ya contiene _format_version 3.0, los siete upstreams core reales, doce rutas y plugins. Las expresiones usan el prefijo Kong `~/`; el router las ancla al comienzo de la ruta. No usar `~^/` ni lookbehind: el parser real rechaza esas variantes en este runtime. El Compose lo monta directamente desde ./kong.yml en /run/factuez/kong.yml readonly. No copiar el Kong raÃ­z/QA ni inventar rutas; distribuir estos archivos de esta carpeta juntos.

Rutas permitidas, verificadas contra controllers actuales:
- Identity 3001: /api/v1/auth (incluye browser-session), /api/v1/users, /api/v1/roles.
- Billing 3002: /api/v1/documents y /api/v1/stations. **Productos estÃ¡n en /api/v1/stations/products**; impresiÃ³n en /api/v1/stations/print-settings. Notas producciÃ³n en /api/v1/documents/:id/production-notes. No existen rutas core /api/v1/setup/company, /api/v1/products, /api/v1/customers ni /api/v1/daily-summaries; se devuelven 404.
- SUNAT 3003: /api/v1/fiscal-artifacts, /api/v1/fiscal-rules, /api/v1/fiscal-evidence; regex exactos de configuraciÃ³n /api/v1/setup/sunat/:companyId/(BETA|PRODUCTION), audit, readiness[/validate], dispatch, PRODUCTION/notes/authorization y reference. No se publica un prefijo setup/sunat abierto que incluya admission o pruebas internas del owner.
- Mailer 3004: /api/v1/mail-settings (configuraciÃ³n, autorizaciÃ³n y envÃ­o, protegidos por sus controllers nativos).
- Received 3006: /api/v1/received-documents; lectura externa sigue apagada y requiere setup separado.
- Realtime 3005: /socket.io con upgrade websocket a travÃ©s del proxy HTTPS del host.
- PWA 3000: /, como fallback web.

Denegaciones explÃ­citas request-termination 404 con regex_priority superior para laboratorios (/stations/client-intake, mail-qa, local-xml-validation, fiscal-circuit-qa, fiscal-batch-qa, notes-qa, gre-qa), ademÃ¡s de sus flags server=false. Un catch-all API/interno de prioridad inferior deniega toda API no publicada, /internal/*, /b2b/* y /api/v1/b2b-admin; no se envÃ­an ni siquiera al fallback PWA. Los endpoints internos production admission y notes admission/original-evidence quedan denegados; sÃ³lo los servicios privados los llaman entre sÃ­.

strip_path=false en todas las rutas. Listener host Ãºnico loopback 9000 detrÃ¡s del HTTPS de TI. Incluye correlation-id, rate-limit local y lÃ­mite de cuerpo global 1 MiB (sobre el mÃ¡ximo JSON de certificado de 768 KiB); recepciÃ³n tiene su override de 18 MiB. No body logs ni Authorization/Cookie/password/clientSecret. CORS no se abre: la app es mismo origen y Auth verifica los Origin autorizados existentes.

B2B NO se ensambla: todos sus flags/OnPrem/readonly/private-access siguen false y no hay upstream/route B2B. Nada habilita el fullgraph de ocho owners ni finge readiness.

## ValidaciÃ³n sin contenedores y Ãºnico arranque posterior autorizado

```sh
node infra/deployment/core-production/validate.mjs
node infra/deployment/core-production/validate.mjs --test
node infra/deployment/core-production/validate.mjs --variables /srv/LA_INSTALACION_ELEGIDA/config/core-public.json
```

El JSON pÃºblico contiene sÃ³lo las variables listadas arriba. --variables verifica sintaxis de digests/HTTPS/hash/rutas, no prueba aprobaciÃ³n TI, existencia de montajes, grants o conectividad. --test usa referencias de imagen claramente ficticias sÃ³lo en memoria del test, nunca las guarda en Compose ni ejecuta/pull/build.

SÃ³lo DESPUÃ‰S de revisiÃ³n TI, imÃ¡genes aprobadas presentes, carpetas/archivos/ACL, PGDATA/DBs/esquemas listos y grants/jobs vacÃ­os de instalaciÃ³n nueva:

```sh
docker compose --env-file /srv/LA_INSTALACION_ELEGIDA/config/core.env \
  -f infra/deployment/core-production/docker-compose.yml config --quiet
# Arranque REAL, exclusivamente por main/TI tras esos prerrequisitos:
docker compose --env-file /srv/LA_INSTALACION_ELEGIDA/config/core.env \
  -f infra/deployment/core-production/docker-compose.yml up -d --no-build --pull never --wait
```

No ejecutar en la entrega/revisiÃ³n. El compose es un arranque nativo real sujeto a estos requisitos, no un script bloqueado ni un instalador de BD. No se ejecutaron los comandos anteriores en esta entrega.

ValidaciÃ³n de esta entrega: parser JSON/YAML-compatible y comprobaciones de hosts/healths/recursos aprobadas; 18 comprobaciones estÃ¡ticas incorporadas aprobadas, incluidas negativas para DB expuesta, puerto pÃºblico, exceso de RAM, flags QA/producciÃ³n errÃ³neos, key de notas ausente, mounts PKI escribibles y perfiles/imÃ¡genes sin digest. Total 7.700.000.000 bytes y 8,5 CPU; once servicios; Ãºnico bind host 127.0.0.1:9000. Se entregan los archivos de esta carpeta y no se iniciÃ³ ningÃºn contenedor ni red ni BD.

## ComprobaciÃ³n con el parser real de Kong

Se verificÃ³ el declarativo con el binario Kong del QA local, sin recargar su configuraciÃ³n ni llamar a upstreams. La comprobaciÃ³n repetible estÃ¡ en `scripts/verify-core-kong-qa.cjs`; estÃ¡ limitada a Docker Desktop y al contenedor QA exacto. No debe apuntarse al VPS. El resultado contiene Ãºnicamente hash del archivo pÃºblico, imagen de Kong, cantidad de rutas y resultado del parser.

## Esquemas y verificaciÃ³n final

Usar exclusivamente `output/install/core-schema-20261028-v2`, cinco SQL y su manifiesto SHA-256. Su README explica la aplicaciÃ³n con el rol propietario y `SET factuez.schema_target` en una base nueva y vacÃ­a. El paquete anterior estÃ¡ marcado SUPERSEDED y no se usa. No concatenar otros DDL ni instalar sobre una base existente.

VerificaciÃ³n realizada en PostgreSQL 17 efÃ­mero sin red externa: 15/25/25/12/11 tablas por servicio, cero filas, rechazo de destino sin confirmar, propietario incorrecto y reinstalaciÃ³n. Este ensayo no instala datos del negocio ni reemplaza el respaldo del servidor.

Compose: validaciÃ³n de sintaxis con Docker Compose sin interpolar secretos, 18 comprobaciones del contrato y verificaciÃ³n de las rutas reales de Kong aprobadas. Los builds de Identity, Billing, SUNAT, Mailer y PWA se verificaron localmente; TI debe aprobar las imÃ¡genes/digests que use en el VPS. La evidencia local no acredita conectividad del servidor, carga real o aceptaciÃ³n de SUNAT.

El core mantiene B2B completo y recepciÃ³n externa automÃ¡tica fuera de esta activaciÃ³n. Disponer de Swagger o de la pantalla de conexiones no significa que sus propietarios B2B estÃ©n publicados. La guÃ­a de preparaciÃ³n privada adicional estÃ¡ en `infra/b2b/install-plan/README.md`.

## Ajuste de permisos al finalizar la entrega

El proceso Redis usa uid/gid 1000:1000, al igual que los consumidores Node, para que redis_password y redis_acl puedan permanecer 0600. Docker Compose con secretos basados en archivos conserva los permisos del archivo fuente; declarar un usuario con otro UID y asumir que Docker remapearÃ¡ el secreto impedirÃ­a arrancar Redis o su healthcheck. TI crea data/redis y ambos secretos con propietario 1000:1000. Este ajuste no cambia puertos, memoria, redes ni autorizaciones fiscales del Compose aprobado.

## ComprobaciÃ³n previa en el VPS, sin arranque

Tras preparar archivos, imÃ¡genes aprobadas y un JSON con las variables pÃºblicas, ejecutar como responsable autorizado del servidor:

```sh
node infra/deployment/core-production/preflight.mjs --read-only /srv/LA_INSTALACION_ELEGIDA/config/core-public.json
```

Requiere Node disponible en la mÃ¡quina que ejecuta la comprobaciÃ³n. No instala paquetes. Es una comprobaciÃ³n Linux x86_64 del VPS; los mÃ³dulos de evaluaciÃ³n y sus 26 casos de evaluación tambiÃ©n se prueban en desarrollo. Verifica Docker local con soporte de límites cgroup y sin remapeo de UID, al menos nueve CPU lógicas para el presupuesto de8,5CPU, almacenamiento de Docker y del proceso containerd activo fuera de /var, espacio libre mÃ­nimo 10 GB por almacÃ©n, al menos 8,7 GB de memoria disponible, puerto 9000 libre, mounts existentes, secretos por metadatos (sin leer su contenido), archivos PKI/XSD por hash y diez imÃ¡genes locales Linux/amd64 por digest. Los secretos de Node/Redis deben ser archivos regulares sin enlaces, uid1000, modo0600; el root no debe contener symlinks. PostgreSQL conserva su usuario postgres y su propietario de PGDATA.

La comprobaciÃ³n falla cerrada si no puede verificar metadatos del servicio containerd activo. No modificar el servidor para ocultar ese error; TI confirma su configuraciÃ³n real. El resultado incluye Ãºnicamente nombres de comprobaciones y estado; no publica contraseÃ±as ni valores de entorno. No inicia contenedores, no escribe archivos, no consulta DNS/SUNAT/SMTP y no valida tablas, credenciales ni autorizaciones fiscales. PASS significa preparaciÃ³n del host, no aceptaciÃ³n fiscal.

## Correo de notas y compatibilidad de autorizaciones

DOCUMENT admite01/03 y las notas productivas integradas07 motivo01 y08 motivo02 sobre factura01 aceptada. La ampliaciÃ³n usa el perfil `factuez.mail.document.01-03-07-08.v2` en la huella de autorizaciÃ³n. Un permiso guardado por la versiÃ³n anterior queda obsoleto: el administrador debe confirmar nuevamente DOCUMENT para ese RUC/revisiÃ³n. No se cambian contraseÃ±as, permisos TEST, destinatarios ni tablas al actualizarlo. Cada trabajo revalida autorizaciÃ³n, sesiÃ³n y originales antes de SMTP; los anteriores que ya no corresponden se cancelan sin reenvÃ­o automÃ¡tico.

## ConstrucciÃ³n fuera del VPS de producciÃ³n

`build-release.mjs` prepara o construye las siete imÃ¡genes nativas Linux/amd64 del core desde el repositorio completo. Requiere un repositorio de imÃ¡genes privado elegido por TI, una versiÃ³n explÃ­cita y la base Node22-bookworm-slim fijada por SHA-256; no acepta latest ni una base sin digest. La PWA se compila para el mismo origen, perfilSSO del Composecore; cambiar variables pÃºblicas despuÃ©s del build no recompila Next. El manifiesto de construcciÃ³n conserva IDs de imagen y el hash de lockfile/Dockerfiles; ese hash no representa todo el Ã¡rbol de cÃ³digo.

```sh
# SÃ³lo prepara el manifiesto con los argumentos exactos de cada build; no ejecuta Docker:
node infra/deployment/core-production/build-release.mjs --plan REPOSITORIO_PRIVADO VERSION NODE22_POR_DIGEST /RUTA_ABSOLUTA_NUEVA/plan.json
# ConstrucciÃ³n explÃ­cita desde el checkout completo, fuera del VPS que ya tiene producciÃ³n:
node infra/deployment/core-production/build-release.mjs --build REPOSITORIO_PRIVADO VERSION NODE22_POR_DIGEST /RUTA_ABSOLUTA_NUEVA/build.json
```

El constructor no hace login al registro, no publica ni arranca servicios. El manifiesto incluye los argumentos de publicaciÃ³n para que TI los use tras confirmar la privacidad y los permisos del registro. DespuÃ©s de publicar, obtener el RepoDigest de cada imagen; los `CORE_*_IMAGE` del Compose deben contener `repositorio@sha256:...`, no el ImageID de Docker ni sÃ³lo una etiqueta local. PostgreSQL17, Redis7.4 y Kong necesitan sus propios digests aprobados; no son imÃ¡genes construidas por este script. Los tests del plan usan nombres ficticios invalid que nunca se construyen ni se publican.
