# Plan de implementación de IGV catálogos y guías de remisión

Fecha: 23 de noviembre de 2026. Repositorio de entrega: `mavrictech-dev/prod-san-jose`. Base revisada: `7b7eb7206dfe72af4ffa917c84469e298c649afa`. Destino autorizado por el cliente: rama `main`, después de implementar y verificar. Publicar código no actualiza automáticamente la PC instalada.

## Resultado esperado

El administrador selecciona la región de operación, configura el tratamiento tributario de cada emisor y escoge categorías y unidades existentes al registrar productos. El formulario distingue el código SUNAT de afectación de la tasa porcentual. Una tasa personalizada de 17 % debe aparecer como porcentaje, nunca como código de afectación. Para la selva se permite elegir un tratamiento exonerado cuando corresponde al emisor y operación, manteniendo productos gravados.

La pantalla Guías de remisión debe ofrecer el flujo real disponible para el RUC seleccionado, mostrar los requisitos pendientes y usar endpoints documentados. El laboratorio continúa identificado como pruebas. Ni guardar credenciales ni mostrar una operación en Swagger equivale a habilitarla o a obtener aceptación SUNAT.

## Diagnóstico de la base

| Hallazgo | Ubicación | Cambio necesario |
| --- | --- | --- |
| Producto usa texto libre para categoría, unidad y afectación | `apps/web-pwa/features/workspace/product-admin.tsx` | Selectores con etiquetas y catálogos persistentes |
| FuelProduct guarda categoría y unidad como cadenas | `services/billing-service/prisma/schema.prisma` | Reutilizar los maestros de la instalación o normalizar los valores existentes con relaciones estables |
| CompanySettings ya tiene igvRate, pero no basta para configurar todos los flujos | `services/billing-service/prisma/schema.prisma` | Política tributaria explícita por emisor, región y revisión |
| La emisión de desarrollo y las reglas fiscales restringen afectación 10 y tasa 18 | `services/billing-service/src/application/issue-document.service.ts`, `packages/sunat-core/src/fiscal-rules.ts` | Propagar la política hasta validación, cálculos, snapshot, XML, PDF y reportes |
| `/guides` monta GreQa y exige un emisor sintético BETA | `apps/web-pwa/app/(workspace)/guides/page.tsx`, `features/workspace/gre-qa-model.ts` | Pantalla operativa distinta del laboratorio |
| Existen propietarios, transporte REST y controladores de guías productivas | `services/billing-service/src/production-guides*`, `services/sunat-service/src/production-guides*` | Ensamblar y verificar esos componentes en el runtime; evitar otro motor paralelo |
| Swagger B2B documenta un contrato estrecho y hay contratos candidatos | `apps/web-pwa/app/api-docs/_lib/guide.ts`, `packages/contracts/src/b2b-guide-issue-openapi.ts` | Distinguir referencia, candidato y ruta efectivamente instalada |
| El instalador Windows es un perfil de pruebas con transmisión externa deshabilitada | `README.md`, `infra/deployment/windows-test/docker-compose.yml` | Actualización compatible y activación explícita del perfil operativo |

El cliente informa que ya tiene categorías y medidas. Antes de crear tablas, localizar su origen en la instalación. En esta base FuelProduct no tiene relaciones a maestros de categorías o unidades: si los valores existentes están en productos, importarlos y deduplicarlos; si hay un maestro desplegado, usarlo como fuente autoritativa y conservar sus identificadores.

## Reglas tributarias

La tasa general total aplicable en 2026 publicada por SUNAT es 18 %. El código de afectación `17` corresponde a Gravado IVAP; no representa 17 %. La exoneración amazónica depende de requisitos del contribuyente y de la operación; una etiqueta geográfica Selva no basta para determinarla.

Fuentes oficiales consultadas el 23 de noviembre de 2026:

- [SUNAT tasa general del IGV](https://emprender.sunat.gob.pe/principales-impuestos/impuesto-general-las-ventas/impuesto-general-las-ventas).
- [SUNAT catálogo 07 de afectación](https://www.sunat.gob.pe/legislacion/superin/2017/anexoE-245-2017.pdf).
- [SUNAT condiciones de exoneración en la Amazonía](https://www.sunat.gob.pe/legislacion/oficios/2005/oficios/i0162005.htm).

### Configuración propuesta

- Región natural por sede/emisor: Costa, Sierra o Selva; mantener ubigeo como identificación territorial precisa. La región no sustituye departamento, provincia ni distrito.
- Política por emisor con tratamiento habilitado, tasa predeterminada, vigencia y revisión. Cambios administrativos auditados y con control de concurrencia.
- Producto compartido con categoría, unidad y tratamiento de referencia; la tasa efectiva depende del emisor activo. No propagar una exoneración de un RUC al catálogo de todos los RUC.
- Separar en el modal Afectación IGV y Tasa IGV (%). Mostrar por ejemplo `10 — Gravado` y `17 % — Personalizada` o `20 — Exonerado` y `0 %`. Las opciones de afectación disponibles deben coincidir con los perfiles de emisión soportados.
- Tasas configurables como decimales exactos, con límites y validación; conservar 18 % como valor inicial del régimen general. Registrar 17 % como solicitud comercial personalizada, sin presentarlo como tasa legal general.
- En Selva, permitir configurar por producto gravado o exonerado bajo la política del emisor. Sin IGV significa un tratamiento explícito con tasa cero, nunca un dato ausente interpretado silenciosamente.
- La emisión oficial valida la combinación código/tasa/régimen y vigencia. Una tasa personalizada no admitida por el perfil fiscal produce una explicación accionable antes de reservar correlativo; el modo local de pruebas debe quedar claramente identificado.

### Propagación y preservación

El servidor resuelve la política autorizada, valida lo enviado por el cliente y fija su revisión en el snapshot inmutable de cada nueva operación. Calcular con decimales exactos, separar base gravada, exonerada e inafecta y cuadrar IGV y total. XML, PDF, notas, resúmenes y reportes deben interpretar el mismo tratamiento. Actualizar sólo las capacidades comprobadas; no eliminar validaciones de otros documentos para aceptar cualquier tasa.

Los comprobantes anteriores conservan tasa, descripción, unidad, precios, totales, XML y CDR originales. Editar el producto o la configuración no recalcula el historial. Las notas sobre originales deben usar el tratamiento tributario de esos originales.

## Categorías y unidades

1. Inventariar los maestros existentes y valores de FuelProduct. Normalizar espacios y comparación sin distinguir mayúsculas para detectar duplicados; no fusionar categorías de significado distinto automáticamente.
2. Categorías con identificador estable, nombre, clave normalizada, estado activo y revisión. Restricción única en la base y desactivación en vez de borrar referencias.
3. Unidades con código SUNAT único, descripción y estado. Reutilizar el catálogo existente; no aceptar códigos arbitrarios por cumplir sólo una expresión regular.
4. Producto selecciona categoría y unidad por selector buscable. Crear o editar catálogos desde su módulo administrativo, no escribiendo nuevos valores dentro del modal de producto.
5. Las opciones guardadas e inactivas siguen visibles al consultar un producto antiguo, pero no se pueden elegir para registros nuevos.
6. Migrar de forma aditiva los valores existentes, verificar asociaciones y mantener compatibilidad con lectores actuales durante la transición. Mantener SKU y UUID del producto.

## Endpoints y documentación

Los siguientes endpoints de administración son la propuesta a consolidar con las rutas existentes antes de agregar alias:

| Método y ruta | Propósito | Control |
| --- | --- | --- |
| `GET /api/v1/stations/product-categories` | Listar categorías reutilizables | Lectura de catálogo autorizada |
| `POST /api/v1/stations/product-categories` | Registrar categoría única | Administrador con permiso de productos |
| `PATCH /api/v1/stations/product-categories/{id}` | Editar o desactivar categoría | Revisión esperada y auditoría |
| `GET /api/v1/stations/product-units` | Listar unidades del catálogo | Lectura de catálogo autorizada |
| `PATCH /api/v1/stations/product-units/{code}` | Administrar estado o descripción de unidades soportadas | Administrador con permiso de productos |
| `GET /api/v1/stations/companies/{id}/tax-policy` | Consultar política por emisor | Alcance del emisor |
| `PUT /api/v1/stations/companies/{id}/tax-policy` | Configurar región, régimen y tasa | Administrador autorizado, revisión y auditoría |
| `POST/PATCH /api/v1/stations/products[/{id}]` | Guardar referencias a categoría, unidad y tratamiento | Validación de referencias y versión |

### Guías nativas

Reutilizar el contrato de `ProductionGuidesBillingController`, que ya define estas rutas en el código. Su presencia en el archivo no prueba que estén montadas:

| Método y ruta | Comportamiento |
| --- | --- |
| `POST /api/v1/production-guides/series` | Crear serie de guía válida para el punto autorizado |
| `GET /api/v1/production-guides/series/point/{id}` | Series y habilitación del punto |
| `POST /api/v1/production-guides/series/{id}/grants` | Configurar autorización por actor, serie, perfil y revisión de credenciales |
| `POST /api/v1/production-guides` | Validar y reservar una guía idempotente; continuar por trabajo durable |
| `GET /api/v1/production-guides/{id}/status` | Estado y resultado conservado del envío |
| `GET /api/v1/production-guides/{id}/artifacts/{kind}` | Originales XML, ZIP o CDR disponibles |
| `GET /api/v1/production-guides/{id}/pdf` | Representación PDF |

Agregar capacidades y requisitos previos consultables por la pantalla, y un listado paginado de guías si el propietario aún no lo ofrece. Sólo publicar las rutas con alcance y runtime comprobados. Mantener los adaptadores privados de SUNAT y Billing fuera del gateway público.

### Integraciones B2B y Swagger

El OAuth de la captura (`/b2b/oauth/token`, client credentials) autentica un consumidor de FactuEz. El OAuth GRE de SUNAT es distinto. Nunca intercambiar sus credenciales o tokens.

La primera entrega conecta los endpoints nativos anteriores con el portal y los documenta con su autenticación. Para consumo externo, extender el adaptador B2B con sus permisos SERVICE y concesiones por emisor/sede/punto/serie, sólo si ese servicio está instalado. Reutilizar contratos de borrador, emisión, estado y artefactos existentes cuando su semántica coincida; no convertir una emisión local candidata en oficial cambiando sus etiquetas.

Swagger debe indicar por operación: método, cuerpo exacto, actor y autenticación, permisos, ambiente, idempotencia, respuestas y disponibilidad real. Las respuestas de capacidades deben distinguir `implemented`, `installed`, `enabled` y requisitos pendientes, sin divulgar secretos. No anunciar un endpoint como operativo porque sólo exista su esquema OpenAPI.

### Conexión con SUNAT

Reutilizar `ProductionGuidesRest` y contrastar el contrato vigente antes de activarlo:

- OAuth GRE: `POST https://api-seguridad.sunat.gob.pe/v1/clientessol/{client_id}/oauth2/token/`.
- Envío configurado en el adaptador: `POST https://api-cpe.sunat.gob.pe/v1/contribuyente/gem/comprobantes/{RUC}-{tipo}-{serie}-{numero}`.
- Consulta configurada en el adaptador: `GET https://api-cpe.sunat.gob.pe/v1/contribuyente/gem/comprobantes/envios/{ticket}`.

El [manual oficial de autenticación GRE](https://cpe.sunat.gob.pe/sites/default/files/inline-files/Manual_Servicios_GRE%20%281%29.pdf) describe tokens con Client ID, Client Secret y credenciales SOL. El formato completo de envío/consulta debe cotejarse con la especificación oficial de servicios GRE al probar el adaptador. La existencia de URLs en el código no acredita conectividad o aceptación oficial.

Almacenar secretos cifrados por RUC y ambiente. El navegador recibe sólo presencia, revisión y resultado saneado. Usar certificado y reglas/XSD vigentes, HTTPS validado y permisos actuales. Conservar ticket y CDR; recibir un ticket no significa aceptación. Después de un timeout con resultado incierto, consultar y conciliar antes de repetir un POST.

## Diseño de pantallas

### Configuración tributaria

Módulo administrativo por emisor con región natural, ubicación, régimen, tasa (%) y vigencia. Mostrar explicación breve de Selva y exoneración, vista previa de importe base/impuesto/total y revisión actual. Guardar exige permiso y detecta ediciones simultáneas.

### Productos

Selectores para categoría, unidad y afectación con nombre y código. Tasa (%) visible en su campo separado, heredada de la política del emisor o personalizada cuando la política lo permite. Al seleccionar exonerado, mostrar 0 %. Errores junto al campo, con etiqueta legible; nunca mostrar sólo el nombre técnico taxAffectationCode. Conservar los valores del formulario después de un rechazo.

### Guías

La ruta principal usa el RUC/sede activos y muestra listado, nueva guía, series, destinatario, origen/destino, motivo, fechas, bienes, peso, transporte y estado. Los perfiles efectivos se limitan a los validados por el motor existente; una modalidad no soportada debe explicarse antes de emitir. Credenciales guardadas, validación local, habilitación y aceptación son estados diferentes. El laboratorio queda separado con etiqueta Pruebas y no reemplaza el flujo del RUC real.

Verificar escritorio y móvil, carga, catálogo vacío, fallo de red, permisos, región Selva, tasa 17 % personalizada y guía sin autorización. Evitar que una selección visual habilite transmisión externa automáticamente.

## Entregas y dependencias

| Orden | Entrega | Criterio para cerrar |
| --- | --- | --- |
| 1 | Inventario de catálogo y migración aditiva | Productos existentes mantienen UUID/SKU y referencias sin duplicados |
| 2 | Política tributaria, cálculo y formularios | Guardar y recuperar región/tasa, seleccionar catálogos y mostrar errores claros |
| 3 | Propagación fiscal | Gravado/exonerado coherentes en totales, snapshot, XML, PDF y restricciones oficiales |
| 4 | Runtime GRE y rutas nativas | Capacidades reales, permisos, persistencia y envío/consulta probados con servidor aislado |
| 5 | Pantalla GRE y OpenAPI | RUC real llega al flujo operativo; laboratorio separado; contratos coinciden con HTTP |
| 6 | Actualización Windows y entrega | Actualizar instalación existente sin Prepare, reset, rotación de claves ni pérdida de datos |

Las entregas 2–3 dependen de los catálogos y la política; la interfaz de guías depende del runtime verificado. Cada entrega debe incluir cambios, pruebas y límites concretos en el registro final de implementación.

## Pruebas de aceptación

1. El usuario no puede introducir 18 como código de afectación: el selector ofrece etiquetas y la tasa se captura aparte.
2. Un administrador guarda 17 % personalizado y el modal lo presenta como porcentaje; persiste tras reiniciar. La emisión oficial rechaza una combinación no validada antes de reservar un número.
3. Selva permite elegir productos gravados y exonerados bajo la política del emisor. Exonerado calcula impuesto cero; seleccionar Selva por sí solo no exonera otras operaciones.
4. Cambiar el RUC no arrastra una política fiscal de otro emisor. Cambiar región o tasa no modifica originales históricos.
5. Categorías existentes repetidas por espacios/mayúsculas no producen nuevas categorías equivalentes; unidades se seleccionan de un catálogo único.
6. Dos ediciones o creaciones simultáneas detectan revisión obsoleta o duplicidad de catálogo en servidor y base.
7. Una venta gravada a 18 %, una exonerada y un documento mixto cuadran hasta el céntimo con XML, PDF y reportes de los perfiles habilitados. Mantener regresión de notas y resúmenes.
8. La pantalla principal de guías admite contexto de un RUC real y muestra requisitos precisos cuando falta activación, sin pedir un RUC ficticio como solución productiva.
9. Dos solicitudes idénticas de guía con la misma clave retornan la misma reserva; contenido distinto da conflicto. Reiniciar workers no duplica correlativo ni envío.
10. Credenciales inválidas, token vencido, revocación de permiso, ticket pendiente, rechazo con/sin CDR y POST incierto conservan estados correctos y no exponen secretos.
11. Las rutas nativas están registradas y enrutadas; Swagger distingue el contrato de la API instalada y los permisos impiden consultar otra empresa/sede.
12. Migración y actualización preservan filas, correlativos, XML/CDR y claves. Respaldar y ensayar recuperación aislada antes de tocar la instalación del cliente.

## Verificación y publicación

Implementar en rama aislada desde la base de producción, revisar el diff completo y ejecutar suites pertinentes de catálogos, cálculos, emisión, GRE y contratos, además de generación Prisma y compilación de los paquetes afectados. Usar PostgreSQL/Redis y un servidor GRE sintéticos aislados; no enviar pruebas con datos reales a SUNAT. Ejecutar los checks del workflow `factuez-delivery.yml` cuando corresponda.

La migración debe ser aditiva, versionada y reintentable, con diagnóstico de instalaciones que no la aplicaron. Una actualización no debe ejecutar instalación inicial, `down -v`, `migrate reset`, `db push --accept-data-loss` ni regenerar credenciales. Mantener los volúmenes y un rollback de código compatible con el esquema agregado.

Publicar en `main` mediante avance normal, sin force-push, después de comprobar que el remoto no cambió. Revisar el resultado de CI y registrar el commit exacto. La actualización de la PC y la activación fiscal requieren sus pasos operativos explícitos: no se consideran ejecutadas por subir el commit.
