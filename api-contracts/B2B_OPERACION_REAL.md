# API B2B para operación real

Acuerdo: emitir mediante API los mismos documentos y perfiles habilitados en la pantalla; consultar estado y descargar XML firmado, PDF y CDR originales. Los GET suministran los datos para preparar la solicitud. La creación se hace con POST e Idempotency-Key; un GET nunca consume correlativo ni envía a SUNAT.

## Integración

Se reutilizan los propietarios nativos de facturas/boletas, notas y GRE. No se amplía el circuito BETA ni se convierte una credencial SERVICE en usuario humano. Cada aplicación tiene secreto propio, tokens cortos y permisos explícitos por RUC, sede, punto y serie. La revocación se comprueba en Identity; Billing conserva la reserva transaccional y SUNAT verifica la admisión y la evidencia original.

| Consulta GET | Datos necesarios para crear |
| --- | --- |
| `/b2b/v1/issuers` | Emisores permitidos y ambiente real |
| `/b2b/v1/branches` | Sedes del emisor |
| `/b2b/v1/points` | Puntos autorizados |
| `/b2b/v1/series` | Series, tipo de documento y disponibilidad; nunca asigna un número |
| `/b2b/v1/products` | Producto, categoría, unidad y afectación/tasa efectiva |
| `/b2b/v1/product-categories`, `/b2b/v1/product-units` | Maestros activos |
| `/b2b/v1/customers` | Clientes de documentos dentro del alcance autorizado |
| `/b2b/v1/reference` | Tipos, tratamientos y perfiles soportados |
| `/b2b/v1/documents` y `/{id}` | Documentos y originales para notas |
| `/b2b/v1/documents/{id}/notes/prepare` | Original aceptado y opciones de ajuste |
| `/b2b/v1/guides/capabilities` | Requisitos y perfiles reales del punto |
| `/b2b/v1/documents/{id}/status` | Estado conservado; recepción/ticket no equivalen a aceptación |
| `/b2b/v1/documents/{id}/artifacts/{xml,pdf,cdr}` | Originales autorizados o motivo preciso de indisponibilidad |

La documentación final debe incluir OAuth, permisos, parámetros/filtros, esquemas completos, ejemplos, errores y diferencias entre documento reservado, enviado, incierto, aceptado y rechazado. El contrato no debe anunciar como disponible una operación que aún carece de propietario instalado.

## Errores

Las respuestas conservan el estado HTTP y añaden código estable, mensaje corregible, identificador de solicitud y errores por campo. No devuelven claves, tokens, SQL, rutas privadas ni trazas. Los errores de ítem indican índice/campo; los de configuración identifican el requisito faltante. No se reserva correlativo si falla la validación o admisión.

## Comprobación requerida

Probar OAuth real y revocación, aislamiento entre RUC/sedes/series, GET sin efectos de escritura, rechazo antes de numerar, idempotencia concurrente, emisión mediante los propietarios nativos, consulta de estado y descargas que conserven sus hashes. Los perfiles de combustible y la configuración fiscal mantienen sus requisitos nativos; credenciales guardadas o Swagger publicado no acreditan una aceptación SUNAT.

## Instalación y uso

La implementación nativa se instala mediante las migraciones aditivas de Identity y Billing. En una instalación existente: construir la revisión revisada, ejecutar Update (incluye respaldo de las cinco bases), conservar la identidad GRE existente y ejecutar EnableB2B. El canal utiliza mTLS y huellas por propietario; no cambia las claves JWT, la bóveda, las credenciales SUNAT ni los interruptores de transmisión fiscal.

Administración: Conexiones → Aplicaciones para Producción. Referencia: /b2b-api-reference; contrato descargable: /b2b-production.openapi.json. GET usa tokens SERVICE de 300 segundos. POST /b2b/v1/documents, POST /b2b/v1/documents/{id}/notes y POST /b2b/v1/guides reciben {binding,payload} e Idempotency-Key. La clave es única por aplicación entre todas las operaciones.

La consulta de operaciones distingue PENDING, SUCCEEDED, REJECTED y UNCERTAIN. Un error posterior a una respuesta perdida puede coexistir con un documento registrado: revisar nativeDocument y nunca emitir otra vez con una clave distinta sin conciliación. Los GET no modifican el diario ni los correlativos.

Las guías SERVICE conservan el identificador de principal de aplicación, una concesión por serie y la revisión del cliente dentro del evento firmado. No se crea un usuario humano. Cambiar la revisión, suspender la aplicación o retirar la concesión impide continuar los workers de esa reserva.

## Alcance efectivo

Se conectan los propietarios nativos 01/03, 07/08 y GRE 09/31. Las condiciones fiscales se conservan: soles, perfiles tributarios aprobados, original aceptado para notas, reglas/rutas y concesiones GRE revisadas. Diésel, gasohol premium/regular y GLP usan únicamente los perfiles ordinarios de hidrocarburos admitidos. GNV móvil, GRE-BF y geografía especial siguen pendientes de un perfil específico. Ninguna prueba sintética acredita una aceptación oficial.

La instalación local requiere los datos reales del cliente, certificado/credenciales vigentes, confianza pública revisada y autorizaciones por RUC antes de transmitir. Las credenciales BETA y PRODUCTION se conservan por separado; la reutilización del mismo RUC es explícita y no activa envíos por sí sola.
