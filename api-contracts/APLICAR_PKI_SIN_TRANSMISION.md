# Aplicar confianza fiscal sin activar transmisión

Desde la instalación existente, tras la revisión y publicación de este cambio:

```powershell
# Si las CRL caducaron o están próximas a caducar: descarga sólo material público.
.\infra\deployment\windows-test\Prepare-FiscalPki.ps1 -ReplaceReviewedPublicFiles
# Revalida los bytes actuales y aplica exclusivamente los tres pins públicos.
.\infra\deployment\windows-test\Operate-Production.ps1 -Action ApplyFiscalPki
```

Se exige `prepared.marker`, `public.env`, `secrets` y los tres PEM públicos existentes. La acción usa el proyecto instalado `factuez-san-jose-test`, Docker `--context desktop-linux`, el Compose existente y su `network.override.json`. Requiere transmisión nativa GRE y de facturas detenida (`NATIVE_GRE_WORKERS_ENABLED=false`, `SUNAT_PRODUCTION_WORKFLOW_ENABLED=false`); rechaza valores habilitados o ambiguos sin modificarlos. No ejecuta Build, Update, ProvisionGre, migraciones ni consultas fiscales. Verifica que la imagen SUNAT etiquetada aún coincide con la instalada antes de recrear sólo `sunat-service`, sin dependencias ni descarga de imágenes.

El verificador corre sin red, recibe sólo material público y comprueba los archivos contra el manifiesto revisado y las anclas fijadas en código, certificados vigentes, cadena, firmas y fechas de ambas CRL, y revocación completa del firmante CDR. `last-verification.json` no autoriza nada. Cambiar anclas requiere revisar manifiesto y código; una CRL nueva firmada por las mismas autoridades no cambia las anclas. Se conservan los hashes de los bytes exactos de cada PEM. Antes de escribir se rechazan pins heredados del proceso que difieran del hash verificado (Compose prioriza esos valores), definiciones duplicadas y líneas ambiguas con espacios o `export`; los valores en conflicto nunca se imprimen.

`operations.lock` excluye otras operaciones; también se rechaza `build.lock`. Prepare-FiscalPki ahora posee el mismo lock durante toda su descarga/verificación/copia. Ninguna acción elimina un lock ajeno. Los cambios de `public.env` se aplican mediante reemplazo atómico en el mismo directorio. Un fallo anterior al intento de recreación restaura los bytes anteriores; si la recreación ya pudo empezar, se conservan los pins verificados y la copia `.previous` dentro de la instalación protegida, y se informa `FISCAL_PKI_PINS_APPLIED_RECREATE_FAILED`. Revisar el servicio y repetir ApplyFiscalPki; no regenerar claves ni preparar otra instalación.

La salida contiene únicamente el resultado, hashes públicos y vencimiento CRL. No muestra entorno, credenciales ni logs Docker crudos. Los archivos `pki-apply-*` contienen sólo material público de la verificación. El refresco es explícito, no automático: renovar antes del `crlExpiresAt` reportado y volver a aplicar pins. Las CRL previamente ensayadas vencían el 26/11/2026 a las 14:30 Lima; para el viernes requieren renovación.

La pantalla general de readiness 01/03 puede seguir bloqueando facturas. Eso no invalida la evidencia PKI ni constituye readiness completo GRE. Esta acción conserva todos los gates y no concede perfiles/series/actores; `EnableGre`, concesiones y primera emisión real siguen siendo pasos posteriores explícitos del operador, con CDR íntegro verificado.

Validación reproducible, sólo sintética y offline:

```powershell
corepack pnpm exec vitest run tests/public-fiscal-pki.spec.ts tests/windows-fiscal-pki.spec.ts --maxWorkers=1 --testTimeout=40000 --hookTimeout=60000
```

El harness genera una CA, intermedia, firmante y CRL efímeros; ejercita criptografía OpenSSL real y Windows PowerShell 5 con stub Docker. Las anclas de prueba se inyectan sólo en la función del verificador desde el harness; el CLI de operación no admite override de anclas. Las claves temporales no se guardan en fixtures ni evidencia.
