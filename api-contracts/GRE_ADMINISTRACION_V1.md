# Administración GRE v1

El centro `/guide-settings` separa preparación administrativa, catálogo fiscal revisado y autorizaciones de emisión. Ventas BETA y sus documentos se conservan; GRE PRODUCTION no habilita facturas, notas ni B2B. `/guides` conserva emisión/consulta y enlaza la administración. No hay emisión al guardar preparación, publicar catálogo o crear serie.

## Interfaz y permisos

Vehículos, conductores, rutas, bienes/unidades, revisión y series/permisos tienen subrutas independientes. El contexto muestra RUC, sede y punto. La preparación es por RUC; las habilitaciones y series conservan su sede/punto. Los identificadores de filas son UUID internos estables. No hay borrado destructivo: se desactivan registros y se conserva historial. Cambiar el borrador no desactiva automáticamente un registro del catálogo fiscal: hace falta revisión/publicación explícita.

El centro se ve con `sunat.configure` o `setup.manage`; cada acción mantiene su guardia. Administración fiscal exige sesión humana ADMIN GLOBAL y `sunat.configure`, con autorización Identity vigente y contexto empresarial revalidado. SERVICE/B2B no acceden. Las declaraciones v1 anteriores permanecen en `/guide-settings/declarations` con `setup.manage`; no se reinterpretan ni migran.

## API exacta

Todas las respuestas son privadas `no-store`. Rutas bajo `/api/v1/setup/sunat/:positiveCompanyId/PRODUCTION/guides/administration`:

| Método | Sufijo | Cuerpo |
|---|---|---|
| GET | ninguno | sin cuerpo |
| PUT | ninguno | `{expectedRevision, draft, reviewGoods}` |
| POST | `/publish` | `{expectedRevision, expectedCatalogueRevision, confirmed: true}` |
| POST | `/import` | `{expectedRevision, expectedCatalogueRevision, confirmed: true}` |

GET devuelve versión, RUC/companyId, revisión, borrador, historial acotado, revisión fiscal, bienes del maestro con disponibilidad separada, reglas fijas verificadas en servidor y bloqueos por sección. El cliente usa las versiones conocidas; el usuario no escribe hashes/versiones/UUID de control. Un 409 conserva los cambios locales y requiere releer/conciliar. Ante respuesta incierta no se reenvía escritura: se consulta primero el estado persistido.

El borrador `factuez.gre-administration.v1` contiene `vehicles`, `drivers`, `routes`, `goodsCodes`, `approvals`; permite listas vacías, máximo 100 filas por grupo y 384 KiB de JSON. Valida claves exactas, texto sin controles y límites por campo. Placas, tipo/documento y rutas equivalentes no se duplican. Vehículos/conductores/rutas se guardan por separado sin credenciales fiscales, PKI, workers o concesiones. Una caída del source de productos se informa sin impedir guardar transporte.

Los bienes son referencias `goodsCodes` al maestro Billing activo existente: código, descripción, unidad y familia exactos. El source reutiliza mTLS; SUNAT no accede a la BD Billing. No hay maestro paralelo ni conversión de cantidades/densidad. Confirmar selección fija el contenido revisado; cambio/inactivación posterior exige nueva revisión antes de publicar.

## Persistencia y publicación

`ProductionGuidesAdministrationDraft` pertenece a SUNAT: `(issuerRuc, revision)`, companyId, payload acotado con borrador v1 y bindings internos, SHA256, actor y fecha. Historial append-only con trigger que impide UPDATE/DELETE, CAS y lock transaccional por RUC. No modifica originales fiscales ni correlativos.

Publicación exige confirmación humana y ambas revisiones actuales; toma locks y reutiliza las validaciones del catálogo existente en la misma transacción. Verifica productos/familias/unidades actuales, referencias activas y vigentes, proveedor, establecimientos, habilitaciones/evidencia y perfil. Metadatos administrativos no entran en el contrato fiscal. Editar ruta/vehículo obliga a resolver sus habilitaciones con nueva revisión explícita; no refresca enlaces ni hashes silenciosamente. Compra privada conserva Diesel/Regular/Premium, origen proveedor, destino comprador y SCOP por producto. No amplía BF/GNV/perfiles.

La versión HYDROCARBON_RULES y su URL/hash se fijan y verifican en servidor; se muestran como detalle de lectura. Esto no verifica registros OSINERGMIN ni rutas. La evidencia de habilitación continúa siendo real, explícita y obligatoria; no se inventa ni descarga desde URLs arbitrarias.

Antes del commit, se compara también la proyección de bienes realmente insertada por el catálogo con sus bindings confirmados; divergencia entre lecturas revierte la transacción. Compra revalida establecimiento comprador y proveedor con la sede vigente. No constituye atomicidad global entre BDs: el snapshot confirmado, esta revalidación y el preadmit Billing existente siguen siendo controles complementarios.

El catálogo previo se conserva. Importación es una acción confirmada hacia preparación vacía y comprueba ambas revisiones; nunca sobrescribe un borrador no vacío ni sincroniza al abrir. Publicar cambia el hash fiscal y las concesiones anteriores requieren revalidación como antes; no se autorizan automáticamente.

Series y permisos reutilizan endpoints nativos existentes, Identity vivo y CAS. Series T admiten perfiles09; V admite31. Autorizar combinación incompatible falla antes de evidencia/concesión/correlativo; suspender concesión previa incompatible sigue permitido por la API guardada. La interfaz solicita confirmación y no presenta correlativo editable.

## Instalación existente

La DDL aditiva `services/sunat-service/prisma/updates/20261126_gre_administration_v1.sql` está registrada en el actualizador con checksum y en la exportación de esquemas nuevos. El Update existente hace backup verificado, detiene writers durante migraciones y conserva claves/volúmenes/gates/contadores. No ejecutar de nuevo Prepare, ProvisionGre, ApplyFiscalPki ni habilitar flags por esta entrega.

Después de revisión y publicación del arquitecto, desde el checkout instalado limpio, actualizar exclusivamente desde `https://github.com/mavrictech-dev/prod-san-jose.git` al SHA aprobado y ejecutar una sola vez:

```powershell
git status --short
git pull --ff-only https://github.com/mavrictech-dev/prod-san-jose.git main
if ($LASTEXITCODE -ne 0) { throw 'SOURCE_UPDATE_FAILED' }
git rev-parse HEAD
.\infra\deployment\windows-test\Operate-Production.ps1 -Action Build
if ($LASTEXITCODE -ne 0) { throw 'BUILD_FAILED' }
.\infra\deployment\windows-test\Operate-Production.ps1 -Action Update
if ($LASTEXITCODE -ne 0) { throw 'UPDATE_FAILED' }
.\infra\deployment\windows-test\Operate-Production.ps1 -Action Status
```

Si el checkout tiene cambios locales, detenerse y revisarlos antes del pull. Comparar revisiones de Identity/Billing/SUNAT/PWA con el SHA aprobado. Conservar GRE/workers true y facturas/notas/B2B false. Verificar en la misma sesión y RUC: centro y estados, guardar/releer transporte real cuando el operador decida, bienes enlazados al maestro y declaraciones previas. No conceder ni emitir durante esta verificación de software. El informe reproducible y evidencias sintéticas están en `output/gre-administration-modules-20261126/report.md`; su aprobación no constituye aceptación SUNAT ni verificación de registros reales.
