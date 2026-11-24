# GRE de combustibles y operación Windows

## Alcance implementado

La clasificación de traslado se administra en el maestro de productos y es independiente del IGV. Los productos existentes conservan sus datos y reciben `UNCLASSIFIED`; no se les concede emisión de combustible automáticamente. Categorías y unidades siguen siendo maestros reutilizables. La política tributaria mantiene 18 % como valor general configurable por RUC y sede.

| Familia | GRE 09 privado, motivo 04 | GRE 09 público, motivo 01 | Límite |
| --- | --- | --- | --- |
| Diésel | Implementado | Implementado | Recorrido ordinario revisado, fuera de zonas especiales |
| Gasohol premium | Implementado | Implementado | Mismo alcance |
| Gasohol regular | Implementado | Implementado | Mismo alcance |
| GLP | Implementado | Implementado | Registro, transporte y recorrido revisados |
| GNV | Sin habilitación de traslado | Sin habilitación de traslado | Falta precisar venta en estación frente a carga móvil GNC/GNL |

Los perfiles nuevos son `GRE09_HYDROCARBON_PRIVATE04_V1` y `GRE09_HYDROCARBON_PUBLIC01_V1`. Requieren concesiones explícitas nuevas; las concesiones anteriores de bienes no regulados no se amplían. La GRE 31 de combustible y otros motivos/modalidades quedan fuera de estos perfiles. La facturación de un producto GNV no se confunde con la autorización para transportarlo.

## Configuración por RUC y sede

En el catálogo GRE del RUC se seleccionan productos clasificados, rutas, vehículos y conductores del catálogo. Cada habilitación vincula sede, perfil, familia, recorrido completo de ubigeos, registros OSINERGMIN, vehículo o transportista, fuente revisada y fecha de vigencia. El formulario público incluye el transportista y su registro MTC; la operación incorpora SCOP y fecha de entrega cuando corresponden al perfil. No se generan ni verifican órdenes SCOP mediante una API de OSINERGMIN.

El servidor rechaza una ruta declarada fuera del régimen especial si alguno de sus ubigeos registrados pertenece al conjunto restringido. Diésel/gasoholes en Madre de Dios y en las zonas especiales revisadas no se habilitan como operación ordinaria. El operador debe revisar el itinerario completo: la ausencia de coincidencia geográfica no es una certificación legal automática.

La clasificación actual del producto, la sede, las concesiones y las reglas se comprueban antes de confirmar el correlativo. Una operación inválida no debe crear documento ni outbox. La idempotencia conserva la misma operación y no emite otra guía por un reintento. Ticket recibido, CDR aceptada y autorización efectiva del traslado son estados distintos.

## Reglas oficiales utilizadas

Los archivos y sus SHA-256 se registran en `services/sunat-service/assets/sunat/gre-official-sources.json`. Se incluyen:

- Reglas GRE publicadas el 06/11/2026 y XSL 2.0.1 actualizado el 01/10/2026.
- Raíz XSD GRE del enlace oficial actualizado el 13/07/2022 y dependencias comunes del archivo XSD previamente fijado.
- Dependencias XSL y catálogos extraídos del SFS oficial 2.6, con archivo derivado fijado por hash.

La imagen SUNAT incorpora Python 3 y lxml. El validador funciona sin red, limita entrada/salida/tiempo y verifica los hashes de los archivos y del XML. Adapta en memoria tres incompatibilidades concretas del paquete con libxslt: declaración EXSLT, dos llamadas `matches` y una declaración duplicada idéntica. Conserva los predicados y patrones oficiales; se documenta como adaptación local, no como homologación o aceptación de SUNAT.

La base normativa geográfica revisada incluye las páginas de SUNAT sobre régimen especial, Ley 32412 y su reglamento DS 117-2026-EF. La documentación distingue la GRE ordinaria de los controles de bienes fiscalizados; no infiere que todos los combustibles tengan el mismo régimen.

## Instalación y recuperación

La migración aditiva `20261124_gre_hydrocarbon_v1` está incluida tanto en el actualizador de instalaciones existentes como en el baseline de instalaciones nuevas, con ledger de hashes. No ejecutar Prepare sobre una instalación existente.

`Operate-Production.ps1` utiliza el mismo proyecto y los mismos volúmenes de la instalación Windows. Build/Prepare verifican que las imágenes y el código correspondan a la misma revisión Git. El diagnóstico separa disponibilidad de la máquina, activación del servidor, requisitos del RUC y aceptación fiscal. Comprueba también espacio libre en la unidad que aloja el VHD de Docker; el espacio libre dentro de Linux no sustituye esa comprobación.

Una instalación nueva recibe redes propias con subredes seleccionadas sin solaparse con redes Docker y rutas IPv4 del host. Esto evita agotar los pools predeterminados en equipos con muchos proyectos. Las instalaciones anteriores no reciben cambios automáticos en sus redes. La configuración de red privada queda en el estado de instalación y se incluye en el respaldo.

Los respaldos incluyen las cinco bases, originales, claves y configuración, además de una imagen PostgreSQL exportada para recuperar datos sin depender de una descarga futura. Se verifican mediante restauración aislada y hashes. Los destinos deben admitir ACL de Windows; una copia en el mismo equipo no acredita protección frente a pérdida del disco. Véase `WINDOWS_OPERACION_RECUPERACION.md` para los comandos y límites.

## Verificación y pendientes del cliente

Las pruebas usan emisores, certificados, CDR y bases sintéticas. Cubren XML firmado de las cuatro familias y dos perfiles, XSL/XSD actuales, rechazo de rutas especiales, aislamiento por sede, concesiones nuevas, rechazo antes de numerar y persistencia de XML/CDR/PDF.

Quedan por verificar en la instalación del cliente sus RUC, certificados, accesos, registros, rutas, modalidad de transporte y respuesta oficial. No se realizaron transmisiones fiscales del cliente. No se declara cobertura de GNV móvil, GRE 31 de combustibles, GRE-BF ni aceptación real basándose en las pruebas sintéticas.

Fuentes principales: [manuales GRE](https://cpe.sunat.gob.pe/node/116), [bienes fiscalizados](https://orientacion.sunat.gob.pe/427-bienes-o-insumos-fiscalizados), [Ley 32412](https://orientacion.sunat.gob.pe/15-ley-32412).

## Evidencia de integración del 24/11/2026

- Compilación completa: 21 tareas aprobadas; contratos y servicio SUNAT recompilados después de corregir la documentación de productos.
- Siete suites pertinentes: 24 pruebas aprobadas tras corregir el conteo de migraciones y evitar que la documentación GRE sobrescribiera los contratos detallados de productos.
- Imagen Linux SUNAT final, usuario 1000 y sin red: seis pruebas aprobadas, incluyendo ocho XML firmados (cuatro familias y dos modalidades) con Python/lxml del contenedor.
- Ensayo Windows/Docker: inicialización de cinco propietarios, acceso real del administrador, bootstrap deshabilitado, checksum alterado rechazado, reinicio y SIGKILL conservando datos/correlativos, respaldo completo restaurado, verificación sin Docker, restauración aislada de originales y claves, corrupción detectada y fallo de dump sin marcador de finalización.
- El ensayo de operaciones utiliza exclusivamente imágenes y datos de prueba identificados por etiquetas. La puesta en marcha local se verifica por separado; no se presenta como prueba en la PC del cliente ni como aceptación de SUNAT.

La prueba Windows detectó y permitió corregir la conversión de argumentos de PowerShell 5 al restaurar roles; ahora usa un archivo shell fijo con finales LF. En esta PC también se detectó agotamiento de pools de red Docker; las instalaciones nuevas seleccionan subredes libres explícitas sin modificar los proyectos existentes.
