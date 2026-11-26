# GRE nativa PRODUCTION y ambiente de ventas independientes

La empresa de negocio puede conservar `CompanySettings.environment=BETA` y todo su historial de ventas mientras usa GRE nativa productiva. La autoridad GRE procede exclusivamente del runtime nativo explícitamente habilitado, credenciales/certificado **PRODUCTION** del mismo RUC, catálogo revisado, serie activa **DESPATCH_ADVICE / PRODUCTION** y concesión vigente para actor/serie/perfil con revisión de credencial y hashes actuales. Tener credenciales guardadas, ver el catálogo o cambiar el ambiente de ventas no concede esa autoridad.

## Comportamiento

- `ProductionGuidesOwner` acepta negocio activo en ventas BETA o PRODUCTION con RUC fiscal válido. RUC00 de laboratorio, establecimientos/maestros inactivos, otras sedes/RUC y series BETA siguen bloqueados. El ambiente fiscal del snapshot GRE sigue siendo PRODUCTION.
- Las series T/V nuevas se crean exclusivamente en PRODUCTION por ADMIN GLOBAL con `sunat.configure` y gates GRE completos. El endpoint no acepta correlativo ni ambiente arbitrario. Nunca mueve ni convierte series Beta; las concesiones continúan siendo explícitas y con CAS.
- Las capacidades devuelven `environment=PRODUCTION`, `greServiceEnvironment=PRODUCTION` y `salesEnvironment` por separado. Las series GRE devuelven su ambiente PRODUCTION. El catálogo compartido sigue mostrando el ambiente de ventas de cada empresa.
- El catálogo y `pointWhere` pueden mostrar empresas PRODUCTION activas si ambos gates nativos GRE están habilitados, aunque el flag de facturas sea falso. Conservan AccessScope, sedes, puntos y series autorizadas. Sin gates GRE completos ni facturas habilitadas se conserva el filtro BETA anterior; las lecturas históricas no se restringen por esta visibilidad.
- `IssueDocumentService`, `StationAdminService.configureEnvironment`, notas, los flags de ventas y las autoridades B2B no se flexibilizan. B2B conserva sus bindings y ambiente exigidos; la ampliación de este flujo humano GRE no otorga permisos a aplicaciones. El catálogo es visibilidad, no admisión fiscal.
- `/guides` identifica servicio GRE PRODUCTION y envío real, muestra el ambiente de ventas aparte y exige revisión final inequívoca. Su banner no usa el aviso general Beta para describir una GRE real. `/guides/laboratory` sigue siendo laboratorio local sin validez tributaria ni envío real. Abrir cualquiera de las pantallas no cambia la empresa ni activa permisos.
- El selector de Configuración SUNAT elige únicamente el almacén de credenciales. GRE no necesita copiar credenciales a BETA ni activar facturas 01/03. El cambio global de ventas a PRODUCTION conserva sus locks, historial, reglas y autorizaciones actuales; no hay nuevo endpoint que lo eluda.

## Secuencia posterior a publicación y actualización

1. El operador conserva instalación y backup existentes; revisa el commit publicado. `ApplyFiscalPki` puede aplicarse según la entrega A sin Build. Renovar CRL si expiraron; presencia de archivos no equivale a confianza fiscal vigente.
2. Para instalar esta corrección C, el operador ejecuta los Build/Update existentes después de la revisión/publicación del arquitecto. No hay DDL nuevo; no repetir Prepare ni regenerar claves o contadores.
3. Mantener el ambiente de ventas actual. En Configuración SUNAT seleccionar almacén PRODUCTION del mismo RUC y revisar la configuración ya guardada sin copiarla a Beta. Revisar certificado, confianza PKI/CRL y CDR; no interpretar el readiness general 01/03 como autorización GRE.
4. El operador autoriza expresamente los gates GRE nativos completos. Mantener `BILLING_PRODUCTION_ISSUANCE_ENABLED`, `SUNAT_PRODUCTION_WORKFLOW_ENABLED` y los gates de notas desactivados si no se autorizó ventas productivas.
5. Revisar catálogo, productos/familias, recorrido y transporte; crear una **serie GRE PRODUCTION nueva** T/V, con permiso ADMIN GLOBAL actual. Conceder explícitamente actor/serie/perfil, expiración, revisión de credencial y hashes. No usar una serie Beta existente ni elegir correlativo.
6. En Emisión GRE, confirmar que el servicio muestra PRODUCTION y el ambiente de ventas permanece el esperado. Revisar la operación real y confirmar una vez. Ante incertidumbre, conservar operationId y consultar reserva/ticket; UNKNOWN no se reenvía automáticamente.
7. Primera emisión y aceptación reales sólo por el operador tras autorización, con CDR íntegro verificado. Las pruebas sintéticas no acreditan aceptación SUNAT del cliente.

## Validación aislada

`tests/production-guides-environment-db.spec.ts` usa una empresa de negocio con ventas BETA, historial y contadores Beta ya consumidos, credenciales PRODUCTION cifradas con vault y certificado efímeros, y flags de facturas/notas apagados. Prueba gates GRE incompletos, nueva serie PRODUCTION, grant, catálogo, emisión Compra por Nest/HTTPS loopback y CDR sintético íntegro, más ausencia/revisión de credenciales PRODUCTION sin fallback Beta, RUC/alcance/serie incorrectos, revocación y UNKNOWN sin rePOST. Verifica que empresa, historial, contadores Beta y gates de ventas no cambian.

Los tests de catálogo comprueban visibilidad y alcance, y los de admisión de ventas mantienen sus bloqueos. La PWA usa Chrome/Playwright con APIs sintéticas en 1440×900 y 390×844: servicio real separado de ventas Beta, confirmación explícita, laboratorio local, permisos, cambio de contexto, errores e incertidumbre. Evidencias y comandos están en `output/gre-environment/report.md`.

## CDR externo inspeccionado por el arquitecto

El hallazgo forense recibido se conserva: un SignedInfo matemáticamente válido y un certificado esperado no sustituyen el digest del documento. El CDR aportado tiene discrepancia de digest reproducida independientemente por dos librerías, por lo que continúa rechazado. Esta corrección no toca canonicalización, algoritmos, pins ni verificaciones de firma/CDR; no normaliza bytes para obtener un match. Los archivos reales y sus datos no se incorporan a fuentes, fixtures ni pruebas.
