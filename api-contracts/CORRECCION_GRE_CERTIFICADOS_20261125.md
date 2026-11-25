# Correcciones GRE sobre la instalación Windows existente

Base de entrega: `68e8d361da8dfd4526b955e456dbf211e17b6554` de este repositorio. Se conserva la integración nativa ya existente: Identity/Billing/SUNAT, mTLS, pantalla productiva, concesiones, catálogos, controles HYDROCARBON y XSL/XSD.

## Cambios de interoperabilidad

- Lectura del RUC en el OU exacto `FACTURA ELECTRONICA RUC NNNNNNNNNNN` de certificados de emisor, conservando rechazo de identidades contradictorias, uso de clave, cadena y revocación.
- Normalización del usuario SOL para OAuth GRE y lectura del tipo de token JWT/Bearer. No se cambia el contrato compartido de usuario SOL para SOAP.
- Conservación de errores funcionales del ticket, respuesta/observaciones de CDR y URL QR autenticada; descarga de certificado público DER sin claves privadas.
- La firma saliente permanece SHA-256. Para verificar CDR se admite además la combinación observada RSA-SHA512, digest SHA-1 y canonicalización exclusiva con comentarios. Se exige la combinación completa, referencia a todo el documento, certificado externo fijado, firma y digest válidos, además del vínculo con el documento. No se acepta RSA-SHA1 ni una mezcla arbitraria de algoritmos.
- ApplicationResponse permite texto CDATA estándar. DTD, entidades, comentarios, instrucciones adicionales, complejidad excesiva y referencias remotas siguen rechazados.
- Un certificado institucional de SUNAT sin RUC en el subject puede validarse únicamente en el circuito CDR: archivo y hash fijados, bytes de certificado idénticos y C/O/CN institucionales exactos, cadena y CRL verificadas. El certificado del emisor sigue necesitando su RUC; el circuito CDR no autoriza firmar documentos de otro RUC.

Una cadena válida o un ResponseCode 0 aislado no prueban integridad del CDR. En una comprobación local la firma RSA del bloque SignedInfo era válida pero el digest del contenido no coincidía, también dentro de su ZIP original; ese documento permanece rechazado. No se incluyen documentos, RUC de operaciones ni archivos del cliente en los fixtures.

## Datos declarados y autoridad de emisión

La pantalla Configuración de guías guarda declaraciones de productos, rutas, rol y registro de hidrocarburos por emisor, con revisiones y auditoría. La pantalla productiva contrasta esas declaraciones con el catálogo revisado. Las declaraciones no crean concesiones ni reemplazan la clasificación del maestro.

Se reutilizan `GRE09_HYDROCARBON_PRIVATE04_V1` y `GRE09_HYDROCARBON_PUBLIC01_V1`, con sus restricciones por sede, familia, ruta completa, registros y transporte. No se incorporan los perfiles FUEL_SCOP de la otra rama. GRE 31 de combustible, GNV móvil y GRE-BF continúan fuera del alcance habilitado.

Las migraciones aditivas de declaraciones se incorporan al actualizador Windows y al exportador de esquemas. La administración humana de series y concesiones requiere ADMIN GLOBAL y permiso actual de configuración.

## Preparar confianza pública

Una instalación existente debe conservar `.installation/windows-test`, sus volúmenes, usuarios y claves. No repetir Prepare ni ProvisionGre si ya existe la identidad GRE.

Después de actualizar el código revisado, desde la raíz del checkout:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\infra\deployment\windows-test\Prepare-FiscalPki.ps1
```

Este comando copia exclusivamente certificados públicos revisados y descarga las CRL de la certificadora a staging. Un contenedor sin red verifica los hashes aprobados, fechas, firmas de CRL y cadena estricta con `crl_check_all` antes de copiar los tres archivos públicos a la instalación. No lee P12, no cambia el vault y no activa envíos. Conserva staging como evidencia y rechaza una operación de instalación o build concurrente.

El manifiesto público fija la raíz y el certificado institucional de SUNAT. La raíz/intermedia proceden de [Llama.pe](https://llama.pe/repository/). El certificado público de SUNAT fue identificado en un CDR externo y validado independientemente contra esa cadena y CRL vigentes; no se confía únicamente en KeyInfo ni se toma el CDR recibido como ancla.

Las CRL comprobadas el 25/11/2026 caducan, como máximo, el **26/11/2026 a las 19:30:06 UTC (14:30:06 Lima)**. La preparación descarga las listas actuales en cada ejecución: los archivos de ese ensayo no sirven como evidencia vigente para el viernes. Para renovar archivos ya instalados, revisar el destino y usar `-ReplaceReviewedPublicFiles`, que conserva copia de los anteriores. Reaplicar después la configuración revisada de hashes del servidor; hasta que los archivos y pins coincidan el verificador conserva el bloqueo. La renovación automática desatendida no se incorpora en este cambio.

## Secuencia de actualización y activación

1. Revisar Status y la revisión Git, detener cualquier operación de mantenimiento concurrente y seguir el procedimiento existente de backup/Build/Update. Update aplica las migraciones y conserva la identidad GRE ya aprovisionada. Un cambio de rama en Git no actualiza las imágenes.
2. Preparar y verificar la confianza pública con el comando anterior.
3. Revisar Status, credenciales del RUC, ambiente efectivo, clasificación, catálogo, registros, rutas y concesiones. Habilitar el servidor mediante las acciones existentes EnableGre/EnableProduction y su confirmación explícita, sin ampliar autorizaciones por RUC automáticamente.
4. Ejecutar una operación real revisada y autorizada y comprobar ticket, CDR íntegro y aceptado, originales y PDF. Ninguna prueba sintética ni contenedor healthy sustituye esa aceptación.

El paso a producción y la emisión oficial del cliente siguen pendientes. Esta entrega corrige el código y prepara herramientas verificables; no afirma una transmisión real.

## Validación local de la entrega

Se comprobaron 344 casos dirigidos de GRE, confianza CDR, identidad, declaraciones, combustible y PKI (216 + 122 + 6 aprobados; un caso preexistente de catálogo fiscal omitido). El circuito nativo incluye PostgreSQL aislado, Identity real y mTLS. La configuración cuenta además con 15 comprobaciones de persistencia/HTTP sobre PostgreSQL aislado.

La PWA pasó 22 comprobaciones por tamaño de pantalla para la configuración de guías y las comprobaciones de descarga DER, carga, cancelación por contexto, error y permisos tanto en escritorio como en móvil. Se revisaron capturas. Compilaron los servicios/paquetes y la PWA de producción; también pasaron el chequeo TypeScript dirigido, la validación del gateway y la sintaxis PowerShell. El preparador de PKI se ejercitó con los certificados públicos fijados y CRL actuales, además de casos de rechazo.

Estas comprobaciones no conectaron con credenciales fiscales del cliente ni emitieron a SUNAT. El servidor existente todavía necesita instalar esta revisión y verificar una aceptación íntegra de una operación autorizada.
