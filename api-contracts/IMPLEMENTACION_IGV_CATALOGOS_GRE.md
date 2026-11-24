# Implementación de IGV catálogos y guías de remisión

## Administración por RUC y sede

Sedes y maestros reúne política tributaria, categorías, unidades y productos. La política inicial usa región Costa, tasa general 18 % y afectación 10. El administrador selecciona Costa, Sierra o Selva y configura vigencia y tratamientos permitidos. Cada sede hereda del RUC o guarda una excepción; los puntos utilizan la política de su sede. Restaurar la herencia conserva el registro de revisión.

El catálogo de productos sigue siendo compartido. Las asignaciones tributarias de cada producto se guardan aparte por RUC y sede. Seleccionar Selva no aplica una exoneración automática: se habilita y asigna expresamente el tratamiento 20 cuando corresponde. El tratamiento 30 inafecto también es explícito. Ambos calculan tasa cero. Las tasas personalizadas son configurables, pero una tasa gravada distinta de la admitida por el perfil oficial se rechaza antes de consumir correlativo.

Los productos seleccionan categoría y unidad en maestros persistentes. La migración deduplica categorías por espacios y mayúsculas, mantiene UUID/SKU y registra unidades históricas desconocidas como pendientes de homologación. Los maestros se desactivan sin borrar referencias. Cambiar el nombre de una categoría actualiza su proyección del catálogo, conservando intactos los comprobantes anteriores.

La tasa porcentual y el código de afectación se muestran separados. El modal conserva los valores ante errores, señala el SKU duplicado y muestra el tratamiento efectivo del RUC/sede seleccionados. Su administración se realiza en Política tributaria y GRE.

## Emisión y originales

Billing resuelve la política en servidor, verifica unidades y asignaciones, y fija sus revisiones en el snapshot. Los cálculos usan decimales exactos y separan base gravada, exonerada e inafecta. El perfil productivo `01-03-PEN-0101-TAX10-20-30-v3` requiere una nueva autorización expresa; una autorización antigua de IGV 18 % no se amplía automáticamente.

El perfil de notas mixtas conserva la afectación del original. Factura, boleta por RC y notas usan esquemas tributarios coherentes en XML y PDF. Estos perfiles son acotados: no habilitan automáticamente IVAP, operaciones gratuitas, exportaciones, impuestos especiales o cualquier otro régimen por escribir un código.

Editar tasas, regiones o productos no recalcula documentos, XML ni CDR históricos. Los trabajos y contadores Beta mantienen su ambiente después de pasar el emisor a Producción.

## Credenciales y paso efectivo a producción

Configuración SUNAT abre en el ambiente real del emisor. La vista del ambiente de credenciales, el ambiente de emisión y la autorización efectiva se muestran por separado. Cambiar el selector no activa envíos.

La acción Reutilizar configuración permite copiar grupos elegidos entre ambientes del mismo RUC sin devolver secretos al navegador. El servidor valida permisos actuales, revisiones de origen/destino y reemplazo explícito, descifra y vuelve a cifrar con el contexto destino y registra auditoría. Un certificado para Producción se inspecciona nuevamente y debe ser vigente, del RUC correcto y no autofirmado. Dejar campos vacíos conserva lo guardado.

Para cambiar efectivamente el emisor a Producción se comprueban servidor habilitado, autorización fiscal vigente y turnos cerrados. Si hay historial, deben definirse series nuevas que cubran puntos/tipos activos. La operación es transaccional: una cobertura incompleta conserva todo el estado anterior. Las series nuevas creadas después heredan Producción. Nunca se reinician los contadores Beta.

## Guías y endpoints

`/guides` ofrece el flujo nativo para un emisor real; `/guides/laboratory` conserva el laboratorio. La pantalla muestra capacidades y requisitos del punto, series, concesiones por actor, catálogo revisado de bienes/rutas/vehículos/conductores, formulario de guía, reservas, estado y originales.

Se reutilizan los motores existentes de reserva, Outbox, firma, REST GRE, consulta de ticket y verificación CDR. Los canales privados Billing/SUNAT/Identity usan mTLS y certificados fijados. Los trabajos se recuperan desde PostgreSQL; un resultado incierto de POST no genera una repetición automática ni otro número. La pantalla permite recuperar la reserva por su clave de operación.

| Método | Ruta nativa | Uso |
| --- | --- | --- |
| GET | `/api/v1/stations/product-categories` | Categorías existentes |
| POST/PATCH | `/api/v1/stations/product-categories[/{id}]` | Administrar categorías |
| GET/PATCH | `/api/v1/stations/product-units[/{code}]` | Consultar y administrar unidades soportadas |
| GET/PUT | `/api/v1/stations/companies/{id}/tax-policy?branchId=...` | Política y herencia del RUC/sede |
| GET | `/api/v1/stations/companies/{id}/effective-products?branchId=...` | Tratamiento efectivo por producto |
| GET/PUT | `/api/v1/stations/companies/{id}/product-taxes[/{productId}]?branchId=...` | Asignaciones tributarias |
| POST | `/api/v1/setup/sunat/{id}/{environment}/reuse` | Reutilización explícita de grupos del mismo RUC |
| GET/POST | `/api/v1/setup/sunat/{id}/PRODUCTION/guides/catalogue` | Catálogo GRE revisado por RUC |
| GET | `/api/v1/production-guides/capabilities?pointId=...` | Disponibilidad real y requisitos |
| GET | `/api/v1/production-guides?pointId=...` | Listado paginado |
| POST | `/api/v1/production-guides/series` | Nueva serie GRE |
| GET | `/api/v1/production-guides/series/point/{id}` | Series y concesiones |
| POST | `/api/v1/production-guides/series/{id}/grants` | Autorizar/suspender actor y perfil |
| POST | `/api/v1/production-guides` | Validar y reservar con Idempotency-Key |
| GET | `/api/v1/production-guides/operations/{id}` | Recuperar la reserva de una solicitud |
| GET | `/api/v1/production-guides/{id}/status` | Estado conservado y CDR |
| GET | `/api/v1/production-guides/{id}/artifacts/{kind}` | XML/ZIP originales |
| GET | `/api/v1/production-guides/{id}/pdf` | Representación PDF |

Las rutas mantienen autenticación humana y permisos de lectura, emisión o configuración según la operación, además del alcance RUC/sede/punto/serie. La documentación principal abre la API nativa; la referencia B2B permanece separada en `/api-docs/b2b`. Esta entrega no instala ni habilita un consumidor B2B SERVICE por publicar Swagger.

Los perfiles GRE disponibles son 09 privado motivo 04, 09 público motivo 01 y 31 público con una referencia 09 aceptada, bajo sus restricciones existentes. Sólo cubren bienes no regulados. Un catálogo aprobado y credenciales guardadas no habilitan por sí solos otras modalidades ni el traslado de combustibles regulados.

## Actualización de una instalación Windows existente

Desde la carpeta del cliente, con Docker Desktop activo:

```powershell
git pull --ff-only
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\infra\deployment\windows-test\Install-Test.ps1 -Action Build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\infra\deployment\windows-test\Install-Test.ps1 -Action Update
```

Build conserva los IDs de imágenes anteriores en la carpeta privada. Update detiene todos los escritores, respalda las cinco bases, los volúmenes persistentes, claves y configuración, verifica una restauración aislada, aplica migraciones versionadas y reinicia. La carpeta del respaldo se imprime al terminar; un respaldo sólo local no acredita protección ante pérdida del disco. Ver [operación y recuperación de Windows](WINDOWS_OPERACION_RECUPERACION.md) para destino externo, verificación offline, diagnóstico y restauración sin sobrescribir la instalación. Se verifican identidad del propietario de base, checksum y exclusión mutua de actualizaciones. Si ya existen tablas GRE, su estructura se compara con el DDL revisado antes de adoptarlas. La instalación nueva registra las mismas migraciones para que una actualización futura no repita el backfill.

No ejecutar Prepare, reset ni borrado de volúmenes en una instalación existente. Si una migración falla, conservar respaldo, claves y volúmenes y revisar el error antes de reintentar. No restaurar una base antigua sobre datos nuevos por una reversión de imágenes; la recuperación de base requiere evaluar las escrituras posteriores al respaldo. PostgreSQL, Redis y los archivos privados continúan en sus volúmenes anteriores.

### Activar el servidor y después los emisores

Los gates de transmisión permanecen deshabilitados de forma predeterminada. Los archivos públicos de confianza deben estar revisados, vigentes y disponibles en `.installation/windows-test/pki`: `issuer-roots.pem`, `crls.pem` y `cdr-signers.pem`. El instalador calcula y fija sus hashes. Son distintos del certificado fiscal del emisor.

Para habilitar facturas/boletas en este servidor:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\infra\deployment\windows-test\Install-Test.ps1 -Action EnableProduction -TransmissionConfirmation 'ACTIVAR TRANSMISION FISCAL DEL SERVIDOR'
```

Después, en Configuración SUNAT del RUC, completar o reutilizar credenciales de Producción, resolver los requisitos de certificado/confianza y autorizar el perfil correspondiente. Preparar series productivas nuevas si hay historial Beta y confirmar el cambio real de ambiente del emisor. Revisar el estado persistido antes de operar.

Para GRE, provisionar una sola vez su identidad privada de transporte y habilitar el gate:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\infra\deployment\windows-test\Install-Test.ps1 -Action ProvisionGre
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\infra\deployment\windows-test\Install-Test.ps1 -Action EnableGre -TransmissionConfirmation 'ACTIVAR TRANSMISION FISCAL DEL SERVIDOR'
```

No repetir ProvisionGre para actualizar o reemplazar una identidad existente. En Guías, registrar el catálogo revisado del RUC con su fuente oficial y hash, seleccionar bienes/rutas/transportes admitidos, crear series y conceder perfil al actor. Las capacidades indican requisitos pendientes. `DisableGre` suspende el gate sin borrar reservas, claves ni originales.

## Evidencia y límites de verificación

Se utilizó PostgreSQL 17 temporal en loopback con bases sintéticas independientes; no se accedió a una base del cliente ni a sus secretos. Las pruebas cubren migración legacy, deduplicación, concurrencia, revisiones, aislamiento entre RUC/sedes, preservación de snapshots, reutilización cifrada, transición a series nuevas, HTTP autenticado y canales mTLS.

Se ejecutaron la compilación completa del workspace, las regresiones fiscales pertinentes, las pruebas del motor GRE, el validador de despliegue, las pruebas de release/rollback y el análisis de sintaxis PowerShell. El XML de factura, RC, nota de crédito y débito se firmó y validó offline con el paquete XSD fijado; esa validación no acredita aceptación de SUNAT.

Resultados de los grupos de comprobación, sin sumar pruebas repetidas entre grupos:

| Grupo | Resultado |
| --- | --- |
| Compilación completa PNPM/Turbo y Next | 21 tareas de compilación aprobadas |
| Catálogos, credenciales, impuestos mixtos, HTTP/OpenAPI, admisión y readiness | 11 suites, 277 pruebas aprobadas |
| Regresión de notas, correo documental, maestros y etapas iniciales | 9 suites, 271 pruebas aprobadas |
| Motor GRE, transporte, transacciones, HTTP privado y formulario exacto | 5 suites, 19 pruebas aprobadas |
| Baseline de cinco bases nuevas y actualización legacy | 2 suites, 4 pruebas aprobadas |
| Contratos de release y rollback | 85 pruebas aprobadas |
| Contrato de despliegue core | 18 comprobaciones aprobadas |
| PowerShell y Compose Windows | Sintaxis y configuración válidas |

Las pruebas DB de esta revisión usan `NATIVE_TEST_POSTGRES_BIN` apuntando a herramientas PostgreSQL temporales bajo `.qa`; esa carpeta no se publica ni se incluye en Docker. Los checks de CI incorporan las regresiones nuevas de catálogo, XML y contrato GRE. Las validaciones que requieren PostgreSQL nativo se ejecutaron localmente con datos sintéticos, no se presentan como ejecutadas en el runner Linux.

La interfaz se recorrió en Orca a 1440 px y 390 px usando una sesión y API sintéticas locales, separadas de las pruebas HTTP/DB reales. Se comprobaron selección de RUC/región, guardado de política, vista previa de exoneración, selectores de categoría/unidad, conservación del formulario ante conflicto y ausencia de desbordamiento horizontal del modal móvil.

No se ejecutaron Docker Build/Update/Enable en la PC del cliente, ni transmisiones oficiales, ni pruebas con su certificado real. Docker Desktop no estaba activo en el entorno de revisión; Compose se validó como configuración y los procesos/aplicaciones se compilaron localmente. Publicar en main entrega el código y los pasos anteriores; la PC requiere la actualización y la habilitación operacional correspondiente.
