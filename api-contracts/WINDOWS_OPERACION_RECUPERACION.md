# Operación y recuperación local de Windows

Este procedimiento conserva el proyecto Compose **`factuez-san-jose-test`**, la carpeta **`.installation/windows-test`**, las cinco bases, los usuarios y las claves de una instalación existente. El nombre histórico del proyecto no determina el ambiente fiscal. `Operate-Production.ps1` es una entrada operacional al mismo proyecto: no crea otra instalación ni omite los controles de certificado, RUC, confianza, perfil o autorización.

Ejecutar desde la carpeta original del cliente, con PowerShell y Docker Desktop en contenedores Linux. No requiere Node.js ni PostgreSQL en Windows. Si no se encuentra `prepared.marker`, ubicar la carpeta instalada o su respaldo; **nunca ejecutar Prepare/reset para reparar una instalación**. No usar `down --volumes`, prune ni borrar los volúmenes.

## Estado real y activación

```powershell
$ops = '.\infra\deployment\windows-test\Operate-Production.ps1'
& $ops -Action Status
```

El informe JSON muestra IDs reales de imágenes y servicios, revisión cuando existe etiqueta de imagen, manifiesto de compilación, montajes persistentes, configuración efectiva de durabilidad de PostgreSQL, gates del servidor, bootstrap y metadatos SHA-256 de PKI/GRE. No imprime contraseñas, certificados privados, tokens, XML, CDR ni cuerpos de documentos. Imágenes antiguas pueden carecer de revisión: sus IDs se muestran y la revisión queda `UNKNOWN`. Una compilación registrada no prueba que esas imágenes estén ejecutándose: comparar sus IDs con los de los contenedores.

`machine=READY` exige salud de los once servicios esperados, volúmenes con propiedad verificada, durabilidad, bootstrap deshabilitado, par JWT accesible por UID 1000 y página de inicio de sesión accesible en el puerto local esperado. También exige al menos 5 GiB libres en las unidades de la instalación y del VHD de Docker. Un motor o transporte inaccesible produce `UNKNOWN` o un bloqueo explícito, nunca una activación inferida. `serverActivation` informa los gates efectivos de Billing/SUNAT sin convertirlos en aceptación por RUC. `fiscalAcceptance=NOT_ESTABLISHED` se conserva: un servidor sano no acredita aceptación de SUNAT. `fuelRegulatedGre=CHECK_RUC_CAPABILITIES` exige consultar la configuración concreta: los perfiles ordinarios GRE 09 de diésel, gasoholes y GLP tienen límites de ruta y transporte; GNV móvil, GRE 31 de combustibles y regímenes especiales no están habilitados. Véase `IMPLEMENTACION_GRE_COMBUSTIBLES.md`.

Después del primer inicio de sesión, deshabilitar el bootstrap sin alterar el administrador existente:

```powershell
& $ops -Action DisableBootstrap
& $ops -Action Status
```

Opcionalmente, un administrador puede preparar fuera del repositorio un archivo JSON privado con `companyId` y `accessToken` de su sesión vigente, protegido por ACL de Windows. No pasar el token por línea de comandos ni pegarlo en tickets o informes. El diagnóstico sólo realiza GET contra `http://127.0.0.1:8091/api/v1/setup/sunat/{companyId}/PRODUCTION/readiness`, con redirecciones deshabilitadas, y devuelve códigos/estados permitidos. No guarda el token ni la respuesta completa. Eliminar el archivo de sesión después de usarlo:

```powershell
& $ops -Action Status -ReadinessSessionFile 'C:\ruta-privada\sesion-readiness.json'
```

Sin sesión, la disponibilidad por RUC queda `NOT_AUTHENTICATED` y su estado `UNKNOWN`. Un rechazo de autorización, error HTTP o transporte inaccesible produce `UNREACHABLE_OR_UNAUTHORIZED/UNKNOWN`. Incluso una respuesta autenticada `READY` describe los requisitos locales establecidos por ese endpoint, no un CDR oficial ni todos los perfiles GRE.

La activación del servidor sigue siendo una decisión expresa:

```powershell
& $ops -Action EnableProduction -TransmissionConfirmation 'ACTIVAR TRANSMISION FISCAL DEL SERVIDOR'
# Sólo si todavía no existe identidad GRE; nunca reprovisionar claves existentes:
& $ops -Action ProvisionGre
& $ops -Action EnableGre -TransmissionConfirmation 'ACTIVAR TRANSMISION FISCAL DEL SERVIDOR'
# Suspender gates sin borrar claves, documentos, usuarios ni autorizaciones persistidas:
& $ops -Action DisableGre
& $ops -Action DisableProduction
```

Antes de habilitar, disponer de `pki/issuer-roots.pem`, `pki/crls.pem` y `pki/cdr-signers.pem` oficiales y revisados, vigentes y con sus cadenas/CRL correctas. No sustituirlos por material sintético. Por RUC, configurar o reutilizar credenciales de Producción del mismo RUC, resolver certificado/RUC/confianza/revisión, autorizar el perfil admitido, cerrar turnos y preparar series nuevas cuando exista historial Beta. Confirmar la transición real y revisar nuevamente readiness. Para GRE se requieren además catálogo revisado, series y concesiones al actor: habilitar un gate no amplía el perfil a combustible regulado. Ver [alcance fiscal existente](IMPLEMENTACION_IGV_CATALOGOS_GRE.md).

## Respaldo consistente

```powershell
# Ventana de mantenimiento: detiene temporalmente todos los servicios salvo PostgreSQL.
& $ops -Action Backup
# Destino previamente revisado y existente; contiene claves y datos fiscales sensibles.
& $ops -Action Backup -ExternalDestination 'E:\FactuEz-Respaldo' -ExternalDestinationReviewed
```

El respaldo detiene todos los escritores del proyecto, incluidos recepción, correo, Redis, web y gateway. Rechaza conexiones adicionales a PostgreSQL antes de extraer los cinco dumps: `factuez_identity`, `factuez_billing`, `factuez_sunat`, `factuez_mailer` y `factuez_received`. No modifica usuarios ni contraseñas. Comprobar que herramientas administrativas externas estén cerradas durante la ventana.

Incluye dumps custom con comprobación de salida y lectura del índice; volúmenes Redis, branding, originales SUNAT, almacenamiento privado SUNAT y caché web; secretos completos (JWT, bóveda, claves de correo/recepción/notas); identidad GRE completa; PKI; esquemas; configuración y marcadores. Conserva además los cuatro archivos estándar de configuración PostgreSQL y las definiciones de roles sin contraseñas para revisión; el destino aislado recrea los cinco propietarios con sus secretos originales, sin ejecutar automáticamente configuraciones/roles globales que pudieran alterar la seguridad o abrir comunicaciones. PostgreSQL se recupera mediante los cinco dumps lógicos, no copiando un PGDATA activo. Registra IDs inmutables de las imágenes presentes y hashes versionados de los scripts, Dockerfiles y SQL de actualización.

Cada respaldo se restaura realmente en un PostgreSQL temporal con **network none**, sin puertos, con límites de memoria/CPU y sin contacto oficial. La restauración usa `pg_restore --exit-on-error --single-transaction`, verifica propietarios y vuelve a extraer cada base. Usa un volumen temporal con nombre/etiqueta exclusivos y lo elimina sólo después de comprobar su propiedad. Reservar espacio para los dumps, archivos persistentes y otra copia PostgreSQL sin comprimir; un volumen insuficiente, dump inválido o error de restauración impide la finalización.

Los directorios se crean con ACL restringida al usuario actual y SYSTEM. El manifiesto contiene rutas relativas, tamaños y hashes, nunca contraseñas ni tokens. `COMPLETE` contiene el hash del manifiesto y se escribe después de las verificaciones. Los fallos conservan una carpeta `.incomplete`, un estado `FAILED.json` y `operations.log` con fase/código de salida; no se imprimen respuestas crudas que puedan contener secretos. Tras un fallo normal de respaldo se intenta reanudar sólo los servicios previamente activos. Ante interrupción del proceso, revisar servicios y la última fase antes de actuar.

`operations.lock` y `build.lock` excluyen operaciones concurrentes. Si quedan tras una interrupción, comprobar que ningún proceso siga trabajando y conservar los registros antes de retirar manualmente el archivo exacto. Nunca borrar bloqueos, claves o volúmenes como solución automática.

Un respaldo local **no protege de pérdida del disco**. El destino externo exige revisión explícita, recibe otra copia con ACL y se comprueba byte a byte antes de finalizar. `EXTERNAL_COPY_VERIFIED` acredita la copia, no que otro directorio sea otro disco ni una política de retención. El responsable debe confirmar un disco físico distinto o almacenamiento fuera del equipo, acceso restringido y retención. También debe custodiar la contraseña del disco/almacenamiento; las ACL no sustituyen cifrado en reposo.

## Verificación sin Docker y restauración aislada

```powershell
& $ops -Action VerifyBackup -BackupPath 'E:\FactuEz-Respaldo\<respaldo-completo>'
& $ops -Action RestoreBackup -BackupPath 'E:\FactuEz-Respaldo\<respaldo-completo>' `
  -RecoveryPath 'C:\FactuEz-Recuperacion-20261124' `
  -RecoveryProject 'factuez-recovery-20261124-review'
```

VerifyBackup funciona sin Docker y no requiere instalación local. Comprueba marcador, versión, hash de manifiesto, inventario exacto y tamaño/hash de cada archivo; detecta corrupción accidental. No es una firma de autenticidad: custodiar el respaldo y el hash por separado conforme a la política del cliente.

RestoreBackup requiere Docker y la imagen PostgreSQL exacta indicada en el manifiesto. Los respaldos nuevos incluyen `release/postgres-image.tar`; si falta la imagen local, se carga esa copia previamente verificada por hash. No necesita secretos en argumentos ni descarga imágenes automáticamente. El destino debe ser nuevo y estar fuera de la instalación activa; el nombre debe comenzar por `factuez-recovery-`. Rechaza proyectos o volúmenes existentes. Crea volúmenes nuevos con etiquetas de propiedad, restaura las cinco bases y los archivos de cada volumen, conserva las claves y deja **cero aplicaciones fiscales iniciadas y cero puertos publicados**. Los fallos conservan el destino y sus volúmenes etiquetados para diagnóstico, sin borrar datos de la instalación activa.

`recovery.json` identifica los volúmenes recuperados y el hash del origen. `recovery-compose.json` permite una inspección PostgreSQL sin red; no contiene servicios fiscales. Las copias en `release/` y `state/` son referencias de configuración, **no instrucciones para iniciar el Compose original**: apuntaría a rutas históricas y gates que requieren revisión.

La restauración aislada no cambia el equipo en servicio. Un retorno al cliente requiere comparar escrituras posteriores al respaldo, revisar la versión exacta de las imágenes, mounts, permisos de archivos, claves, PKI y autorizaciones por RUC; acordar el corte y verificar originales/correlativos. Nunca restaurar una base antigua sobre actividad posterior sin reconciliación. Una reversión de imágenes tampoco revierte de forma segura los datos.

## Actualización existente

```powershell
git pull --ff-only
& $ops -Action Build
& $ops -Action CheckUpdate
# CheckUpdate devuelve código no cero si hay migraciones pendientes; revisarlas antes de aplicar.
& $ops -Action Update -ExternalDestination 'E:\FactuEz-Respaldo' -ExternalDestinationReviewed
& $ops -Action Status
```

Build conserva IDs anteriores y registra imágenes nuevas y hashes de la fuente cuando existe instalación preparada. Update realiza el respaldo completo y su restauración de prueba antes de migrar. Los escritores permanecen detenidos desde el respaldo hasta completar las migraciones por propietario, con checksum y bloqueo de base existentes. Una migración fallida deja los escritores detenidos: conservar el respaldo y revisar los registros antes de reiniciar. Los gates y claves existentes se conservan; Update no autoriza un RUC ni transmite documentos.

## Evidencia de esta entrega

La evidencia concreta de compilación y pruebas sintéticas se registra junto con sus límites en el informe de validación de esta revisión. No existe instalación del cliente en este checkout y no se dispone de credenciales, certificado o CDR reales autorizados. Ninguna prueba de reinicio o SIGKILL acredita por sí sola una garantía ante corte eléctrico del PC/disco/WSL; PostgreSQL exige además almacenamiento que respete fsync y una política de recuperación probada.
