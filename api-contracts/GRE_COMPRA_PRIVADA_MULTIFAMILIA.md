# Compra privada de combustible — GRE 09

Perfil aditivo: `GRE09_HYDROCARBON_PRIVATE02_V1`. Motivo `02` (Compra), modalidad `02` (privada). Los perfiles PRIVATE04/PUBLIC01 y su cargo v1 conservan sus reglas. No se amplían concesiones existentes ni se habilitan gates al guardar configuraciones.

## Evidencia y límites fiscales

Se revisaron los archivos oficiales ya fijados en `services/sunat-service/assets/sunat`: `gre-rules-20261106.xlsx` (SHA-256 `5e1aed6df969afafca284e1cda228d36336ebf1ac31ea84f877f8170f584ec01`), `gre-xsl-20261001.zip` (`bcaa31e7195295372e905374f6b4adcd1b40bf4ba05b989132e34c03d484aeb7`), XSD GRE 2.1 y comunes SFS 2.6 con sus pins existentes. El catálogo `cpe/catalogo/cat_20.xml` del paquete común identifica Compra como `02`; el catálogo 61 representa cada SCOP con el código `81`.

La [pregunta 35 de SUNAT](https://cpe.sunat.gob.pe/node/122) distingue quién organiza el traslado: el comprador emite cuando decide trasladar los bienes adquiridos. El perfil implementa ese caso estrecho. La [RS 123-2022](https://www.sunat.gob.pe/legislacion/superin/2022/anexo-123-2022.pdf) y las [reglas publicadas](https://cpe.sunat.gob.pe/node/116) sustentan los campos del proveedor y del traslado. El XSL fijado contiene `SellerSupplierParty` para Compra y los controles 4375/3447/3448; la asociación del origen tiene el control 3411. La validación offline ejecuta las reglas y XSD fijados con el adaptador de portabilidad existente; no acredita aceptación SUNAT ni consulta RUC activo/habido.

Se exige comprador = emisor = remitente = destinatario; proveedor tercero con RUC y razón social explícitos. El origen declarado corresponde al proveedor, la llegada al establecimiento de la sede autorizada del comprador. Los códigos de establecimiento pueden coincidir numéricamente porque pertenecen a RUC diferentes. El XML emite el RUC del proveedor en `DespatchAddress/AddressTypeCode@listID`, el del comprador en llegada y el proveedor en `SellerSupplierParty`. La firma sigue perteneciendo al emisor; no se implementa PSE ni se firma con el proveedor.

Se admiten DIESEL, GASOHOL_REGULAR y GASOHOL_PREMIUM en el mismo documento, sólo en GLL o LTR revisadas; el peso bruto se declara por separado en KGM o TNE. BJ se bloquea con explicación y no se transforma en GLL. No se infieren densidad, peso ni conversiones. GLP, GNV, BF, zonas especiales, transporte público de Compra, proveedor sin RUC y entrega a terceros quedan fuera del perfil. Las restricciones geográficas existentes se comprueban para todas las familias y para el recorrido completo declarado.

## Contrato y autorización

`body` añade `supplier: {ruc, legalName}` y usa `reasonCode: "02"`. Los demás datos privados son explícitos: fechas, remitente/destinatario, origen/llegada, productos exactos, cantidades, peso, conductor, vehículo y registro. `references` sigue vacío en este subconjunto.

El cargo nuevo usa `schemaVersion: "factuez.gre-hydrocarbon.v2"`, `items: [{code, family, scopCode}]`, `senderRegistration`, `vehicleAuthorization`, `handoverDate: null` y `carrierRegistration: null`. Cada producto fiscal debe tener exactamente un metadato vinculado por su código. Se rechazan duplicados, referencias ajenas, cantidades no positivas, familias no aprobadas y SCOP nulo/cero/mal formado. Dos productos pueden compartir el SCOP declarado; nunca se rellena automáticamente. Los códigos distintos se serializan una vez cada uno como documentos relacionados `81` en UBL; la relación por producto permanece en el snapshot inmutable, PDF y revisión. No se inventa un campo SUNAT por línea.

Cada familia exige una habilitación nueva para el perfil, sede, ruta completa, vehículo, registros, vigencia y proveedor exactos. Los hashes del catálogo incluyen esas revisiones. El maestro vigente de productos debe coincidir en código, descripción, unidad y familia antes de consumir correlativo. Las concesiones siguen requiriendo ADMIN GLOBAL vigente, CAS de versión, actor/serie, revisión de credencial, certificado y hashes. Guardar declaraciones, catálogo o familia no crea una concesión ni modifica correlativos. Identity se revalida en los jobs y las operaciones `UNKNOWN` no se reenvían.

El lector ZIP CDR ahora admite CDATA estándar sólo por su ruta de entrada explícita; conserva límites, rechazo de DTD/entidades/comentarios y verificación integral de firma, digest y vínculo. Las reglas de documentos salientes no cambian. El ensayo altera texto CDATA después de firmar y comprueba rechazo antes de estado aceptado, sin repetir el POST.

## Operación posterior a revisión y publicación

1. Conservar la instalación/proyecto existente y su backup; revisar la versión publicada y el resultado de A (`ApplyFiscalPki`). A por sí solo no requiere Build/Update y no activa transmisión.
2. Para instalar B, el arquitecto publica el código revisado; el operador ejecuta Build y Update desde ese checkout limpio mediante los comandos existentes. B requiere imágenes nuevas de los servicios/PWA; no hay DDL adicional en B y no debe repetirse Prepare ni regenerar claves.
3. En Configuración de guías, declarar Compra privada, familias, unidades, ruta y requisito SCOP. En el catálogo revisado del RUC, seleccionar productos vigentes, ruta con establecimientos de proveedor/comprador, conductor/vehículo y una habilitación Compra por cada familia con proveedor y evidencia revisados. Conservar el régimen ordinario sólo cuando corresponda tras revisión territorial.
4. Revisar credenciales y PKI actuales del emisor/CDR. Renovar CRL antes de expirar y aplicar pins sin transmisión. La pantalla general 01/03 puede seguir bloqueando facturas y no habilita ni certifica GRE.
5. El operador autorizado decide expresamente EnableGre y las concesiones nuevas por actor/serie/perfil; esta entrega no realiza esos pasos. Conceder el perfil sólo tras revisar proveedor, recorrido, registros y todas las familias. No habilitar facturas/notas como condición ficticia.
6. En Emisión GRE, seleccionar Compra privada y su serie autorizada, proveedor/ruta/conductor/vehículo, cantidades y peso, habilitación y SCOP por producto. Revisar la operación y confirmar una única reserva. Si la respuesta es incierta, conservar la operación y consultar la reserva; `UNKNOWN` exige conciliación, nunca otro POST automático.
7. Primera emisión real sólo por el operador tras autorización y revisión. Confirmar ticket, CDR íntegro y originales. Los ensayos sintéticos de esta entrega no establecen aceptación real ni que SOL esté autenticado en el servidor.

## Ensayos reproducibles

```powershell
corepack pnpm exec vitest run --config tests/production-guides.config.mts
corepack pnpm exec vitest run tests/guide-fuel-settings.spec.ts tests/guide-operational-settings.spec.ts tests/fiscal-configuration.spec.ts tests/fiscal-readiness.spec.ts tests/certificate-identity.spec.ts tests/browser-session.spec.ts tests/native-b2b-contract.spec.ts --maxWorkers=1 --testTimeout=60000 --hookTimeout=60000
node tests/production-guides-purchase.browser.cjs --synthetic-only
```

El ensayo durable usa PostgreSQL Docker efímero sin red, PKI efímera, controlador Nest real con guard de autenticación sintético explícito, y OAuth/ZIP/ticket/CDR por HTTPS loopback real. La regresión host separada verifica Identity real en otra BD sintética, JWT y mTLS. Los emisores son ficticios y no se contactan autoridades reales. La PWA usa APIs sintéticas con Chrome/Playwright ya instalados; no ejecutar su Next dev simultáneamente con Build. Resultados, capturas, traces y límites están en `output/gre-runtime-next/report.md`.
