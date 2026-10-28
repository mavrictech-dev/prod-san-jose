# Fase 1: verificación local de la imagen de fachada

Fecha: 27/10/2026. Estado: **avance parcial; no es una composición Beta runnable ni una aprobación de despliegue**.

## Qué se verificó

Se construyó el Dockerfile independiente de esta carpeta en Docker Desktop local,
Linux/amd64, con la base Node 22 bookworm-slim identificada por el digest
`sha256:3ed748ce9dea62d2f0f0205cdbb6823106d9f973a6f555c402fe2575f8d6e1ae`.
La construcción reutilizó capas de caché: no demuestra una compilación limpia ni
la procedencia aprobada de la base o dependencias. La imagen local quedó como
`factuez-phase1-b2b-api:local-20261027`, ID
`sha256:76840a58f12eae916c49f730d0e1a3a82da665db66c64fc4072b9491837fecd9`,
1.639.529.931 bytes informados por Docker, usuario `node`. No fue publicada.
La etiqueta y la imagen son locales y podrían cambiar; las pruebas usan el ID.

La prueba `container-isolation.test.mjs` aprobó 4 de 4 comprobaciones con esa
imagen: arquitectura y usuario; salida 78 sin activación; salida 78 con activación
pero sin archivos de configuración; importación del bootstrap compilado real y
resultado `null` sin activación. Cada ejecución de contenedor usó
`--network=none`, sistema de archivos de solo lectura, ninguna capacidad,
sin privilegios adicionales, sin puertos ni montajes, y `--pull=never`.
No quedaron contenedores de esa imagen después del ensayo. No se comprobó que la
fachada llegue a atender solicitudes con su grafo de propietarios real.

La suite previa `launch.test.mjs` aprobó 3 de 3 pruebas. El validador
`config-review.mjs --model-only` mantuvo `BLOCKED`, activación `false`,
modelo válido, 6.912.212.992 bytes y 8,2 CPU en todos los perfiles.

Una construcción previa con `docker build --network none` falló antes de
instalar dependencias: Corepack no pudo descargar pnpm del registro npm. La
construcción posterior usó el modo de red normal de Docker y capas en caché; no
acredita una construcción offline reproducible. Las comprobaciones de ejecución,
a diferencia de la construcción, sí se realizaron sin red.

## Repetición local

Desde la raíz del repositorio, si la imagen indicada está disponible localmente:

```sh
export FACTUEZ_PHASE1_TEST_IMAGE='sha256:76840a58f12eae916c49f730d0e1a3a82da665db66c64fc4072b9491837fecd9'
node --test infra/b2b/ubuntu-package-phase1/launch.test.mjs
node --test infra/b2b/ubuntu-package-phase1/container-isolation.test.mjs
node infra/b2b/ubuntu-vps/config-review.mjs --model-only
```

La prueba requiere Docker Linux y rechaza etiquetas: debe suministrarse el ID
local completo de la imagen concreta. No descarga imágenes. Los ID de una nueva
construcción pueden diferir; deben inspeccionarse antes de repetir la prueba.

## Límites y próximos trabajos

No se creó un Compose ejecutable porque no se ha verificado la composición real
de los ocho propietarios, sus imágenes y contratos, PKI, configuración,
esquemas y roles, controles operativos y respaldo/restauración. Permanecen los
pendientes descritos en `docs/B2B_FASE9_CIERRE_OPERATIVO_UBUNTU.md`.
La imagen contiene fuentes y herramientas, no es mínima ni tiene auditoría de
seguridad o licencias. No se han hecho pruebas de integración, disponibilidad,
carga, recuperación ni del servidor Ubuntu del cliente.

No se modificaron el Compose de revisión, su bloqueo ni
`docker/Dockerfile.service`; este último ya tenía cambios previos. No se
conectaron bases existentes ni VPS, y no se hizo ninguna operación SUNAT.