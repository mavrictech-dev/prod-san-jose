# Fase 1 Ubuntu: candidato de imagen para la fachada B2B

Estado: DESARROLLO / NO APROBADO PARA DESPLIEGUE. Esta carpeta es independiente del Compose de revisión; no modifica su bloqueo. El alcance es exclusivamente `b2b-api-service`, no la instalación completa.

## Integración realizada

`Dockerfile.b2b-api` compila contracts, service-access y la fachada con el lockfile existente, conserva la estructura y enlaces de pnpm en la etapa de ejecución y usa el usuario `node`. Su base es un argumento obligatorio: antes de construir, TI debe verificar que sea Node 22 bookworm-slim >=22.18, linux/amd64, procedencia aprobada y referencia inmutable por digest. El Dockerfile comprueba la versión de Node, pero no verifica por sí mismo el digest ni la arquitectura. Requiere Corepack, acceso a dependencias de compilación o una caché previamente preparada y un constructor con almacenamiento adecuado. No copia deliberadamente secretos, pero se debe auditar todo el contexto efectivo y `.dockerignore` antes de construir; los directorios de código se copian completos. El resultado conserva herramientas y fuentes, por lo que no es una imagen mínima ni ha pasado revisión de seguridad o licencia.

`launch.mjs` sale con 78 si falta el opt-in exacto `B2B_API_ENABLED=true` o una ruta absoluta POSIX normalizada de configuración. Antes de ese control no carga la aplicación. Con opt-in invoca `bootstrapB2bApi` existente y exige que devuelva un runtime. El bootstrap real, además, valida los archivos y política inicial PAUSED, mTLS y disponibilidad de los ocho propietarios. El lanzador no sustituye esas comprobaciones y no cambia las condiciones de activación fiscal. Cualquier fallo se registra con mensaje genérico; una investigación adicional requerirá diagnósticos seguros.

No se incluye un Compose ejecutable ni se conectó este candidato a la configuración de revisión. Faltan las imágenes y composición del resto de servicios, los bootstrap y contratos propietarios pendientes, configuración y PKI de TI, esquemas/grants, mantenimiento distribuido y respaldo/restauración integral. La fachada por sí sola no es un paquete ejecutable de la instalación. La documentación de cierre B2B-09 conserva los pendientes completos.

## Evidencia local 27/10/2026

- `node --test infra/b2b/ubuntu-package-phase1/launch.test.mjs`: 3 pruebas aprobadas, incluyendo rechazo previo a importar y salida 78 en un proceso sin opt-in. Las pruebas usan dependencias simuladas y no levantan listeners.
- El bootstrap compilado presente exporta `bootstrapB2bApi` y, con entorno vacío explícito, devuelve `null`; no se acredita que el `dist` presente corresponda a una compilación limpia actual.
- Validador `config-review.mjs --model-only`: modelo válido, BLOCKED, activación false; 6.912.212.992 bytes y 8,2 CPU para todos los perfiles.
- Pruebas aisladas del modelo: 141 aprobadas en tres archivos.
- Docker local respondió linux/amd64. Las imágenes Node locales observadas son 24; no se identificó base Node 22 local. No se construyó ni arrancó el candidato, ni se descargaron imágenes. Su Dockerfile y el arranque dentro de contenedor no han sido validados por Docker.

No se accedió a VPS, bases existentes o secretos y no hubo migraciones ni envíos SUNAT. No se hicieron pruebas de red, carga, resiliencia ni restauración. La comprobación local de Docker no es evidencia del VPS.


## Verificación posterior de construcción local

Se construyó en Docker Desktop local la imagen genérica `factuez-buildcheck/b2b-api:local`; compiló con lockfile y dependencias del servicio y, ejecutada en un contenedor sin red, confirmó que el bootstrap sin activación devuelve `null`. Arquitectura amd64; tamaño reportado 2.285.408.930 bytes. Este tamaño y la presencia de fuentes y herramientas requieren optimización y revisión antes del despliegue.

También se ejecutó `docker build` del Dockerfile candidato de esta carpeta con base Node 22 por digest `sha256:3ed748ce9dea62d2f0f0205cdbb6823106d9f973a6f555c402fe2575f8d6e1ae` y `--output type=cacheonly`: ambas etapas terminaron. No se publicó ni arrancó una imagen de ese candidato, por lo que no es evidencia de arranque de runtime ni aprobación del digest para producción. Docker mostró avisos por el argumento BASE_IMAGE sin valor predeterminado, que es intencionalmente obligatorio, y un aviso Prisma durante la instalación de todo el workspace; la fachada no usa Prisma directamente.

La construcción ocurrió exclusivamente en el equipo local, no en el VPS. No prueba el almacenamiento ni permisos del servidor remoto, ni habilita la aplicación o SUNAT.
