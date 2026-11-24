# FactuEz — San José · Windows 11 Pro (pruebas)

## Actualización de IGV catálogos y guías

La administración incorpora **Política tributaria y GRE** y **Categorías y unidades** en Sedes y maestros. El IGV general parte de **18 %**; cada RUC configura su política y cada sede puede heredar o declarar una excepción. Los productos seleccionan categorías y medidas existentes. Las afectaciones exoneradas e inafectas requieren una política que las permita y, para emisión oficial, una autorización expresa del perfil 10/20/30.

Guías de remisión abre el flujo nativo del emisor; el laboratorio queda separado en `/guides/laboratory`. La documentación principal corresponde a la API nativa; la referencia B2B queda en `/api-docs/b2b` y no habilita por sí sola un consumidor SERVICE.

Para una instalación **ya preparada**, ejecutar desde su carpeta, con Docker Desktop activo:

```powershell
git pull --ff-only
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\infra\deployment\windows-test\Install-Test.ps1 -Action Build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\infra\deployment\windows-test\Install-Test.ps1 -Action Update
```

Update detiene Billing y SUNAT, respalda sus bases y secretos en la carpeta privada de instalación, aplica cambios aditivos por propietario y reinicia con las imágenes compiladas. Conserva los volúmenes, usuarios, claves y correlativos. No repetir Prepare. `CheckUpdate` permite diagnosticar migraciones pendientes antes de Update; ese diagnóstico termina con código distinto de cero cuando hay trabajo pendiente.

**Elegir Producción en Configuración SUNAT sólo selecciona el ambiente de las credenciales.** La página muestra también el ambiente real de emisión. Se pueden reutilizar grupos del mismo RUC entre ambientes con confirmación, revisión y nuevo cifrado, sin volver a escribir secretos ni mostrarlos en el navegador. El paso efectivo a Producción exige autorización vigente, turnos cerrados y series nuevas cuando hay historial Beta.

La transmisión requiere habilitar el servidor y después cada emisor/actor. La provisión GRE genera únicamente su identidad privada de transporte; los certificados fiscales y archivos públicos de confianza se configuran aparte. Ver [pasos de activación, endpoints y evidencia de pruebas](api-contracts/IMPLEMENTACION_IGV_CATALOGOS_GRE.md) y el [plan de implementación](api-contracts/PLAN_IGV_CATALOGOS_GRE.md). Subir código a GitHub no actualiza la PC ni activa envíos a SUNAT.

Repositorio de entrega independiente, sin carpeta `docs` ni historial del repositorio de desarrollo. Incluye la aplicación, Swagger y contratos API. El perfil Windows instala el **core local de pruebas**, no una habilitación fiscal productiva ni todas las variantes B2B pendientes.

## Preparar el equipo una sola vez

Instalar Git y [Docker Desktop para Windows](https://docs.docker.com/desktop/setup/install/windows-install/). Usar WSL 2 y contenedores **Linux**, no Windows containers. Docker Desktop debe estar abierto durante el uso. Reservar recursos suficientes para los contenedores: el core tiene un máximo conjunto de 7,7 GB; el equipo también necesita memoria para Windows y Docker. Conviene un equipo de al menos 16 GB y espacio libre para imágenes y datos.

Abrir PowerShell. Estos comandos comprueban la instalación:

```powershell
git --version
docker version
docker compose version
docker info --format '{{.OSType}}'
```

El último debe mostrar `linux`. Si Docker no responde, abrir Docker Desktop y esperar que su motor esté listo. No hace falta Node.js o PostgreSQL instalado en Windows: las herramientas de compilación y las bases se ejecutan en contenedores.

## Descargar sólo esta entrega

Usar una carpeta nueva; no copiar secretos o bases del desarrollador:

```powershell
git clone --single-branch --branch main https://github.com/mavrictech-dev/prod-san-jose.git C:\FactuEz-SanJose
Set-Location C:\FactuEz-SanJose
```

## 1. Compilar

La primera compilación necesita Internet y puede tardar. No se inicia la aplicación ni se crean bases en este paso:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\infra\deployment\windows-test\Install-Test.ps1 -Action Build
```

`Bypass` se aplica únicamente a este proceso; no cambia permanentemente la política del equipo. Revisar el script antes de ejecutarlo.

## 2. Preparar el primer administrador

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\infra\deployment\windows-test\Install-Test.ps1 -Action Prepare
```

El asistente pide usuario, nombre y contraseña dos veces. La contraseña debe tener entre 12 y 256 caracteres, sin espacios iniciales/finales. No existe una contraseña predeterminada ni se imprime la elegida. Guardarla en el gestor de contraseñas de la empresa.

Prepare crea claves aleatorias propias y esquemas para cinco bases nuevas, sin datos de negocio. Los archivos privados quedan en `.installation/windows-test`, protegidos por permisos de Windows y excluidos de Git/Docker build. El paso rechaza una preparación o volúmenes existentes: no sirve para rotar claves ni recuperar contraseñas.

## 3. Iniciar la instalación

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\infra\deployment\windows-test\Install-Test.ps1 -Action Start
```

PostgreSQL inicializa sus cinco bases sólo si el volumen es nuevo; cada servicio tiene su propietario. Identity crea el catálogo de permisos y la cuenta indicada con rol **ADMIN**. La contraseña se almacena como hash scrypt, no como contraseña legible en la base. El rol ADMIN tiene alcance global. No se crean RUC, sedes, ventas o correlativos de demostración.

Abrir:

```powershell
Start-Process 'http://localhost:8091/login'
```

Ingresar con el usuario y contraseña elegidos en Prepare. El puerto 8091 se publica sólo en loopback: esta instalación no se expone por sí sola a otras computadoras de la red.

## 4. Desactivar la creación inicial después de comprobar el acceso

Tras ingresar correctamente, ejecutar:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\infra\deployment\windows-test\Install-Test.ps1 -Action DisableBootstrap
```

Se elimina el usuario de las variables de bootstrap y se actualiza únicamente Identity. La cuenta y su contraseña ya creadas se conservan. Esto evita crear accidentalmente otro administrador cambiando las variables de instalación.

En el código actual, el bootstrap omite la creación si ese **nombre de usuario** ya existe; no reemplaza su contraseña. No es un sistema de recuperación de acceso. No modificar ese nombre para crear administradores adicionales: gestionar las cuentas desde el módulo Usuarios, usando el administrador existente.

## 5. Configurar la aplicación

Desde la plataforma, el administrador registra emisores/RUC, sedes, puntos, series, usuarios y permisos. Mantener los emisores en Beta/pruebas. Se pueden preparar las configuraciones propias en la aplicación; este perfil bloquea transmisión oficial, correos SMTP externos y recepción externa. No solicita credenciales reales para instalar.

Swagger está en:

```powershell
Start-Process 'http://localhost:8091/api-docs'
```

Las APIs visibles siguen los permisos y capacidades instalados; mostrar Swagger no significa que todas las funciones B2B estén habilitadas. El perfil no crea un acceso B2B productivo ni expone bases de datos.

## Uso cotidiano

Estado:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\infra\deployment\windows-test\Install-Test.ps1 -Action Status
```

Detener sin borrar datos:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\infra\deployment\windows-test\Install-Test.ps1 -Action Stop
```

Volver a iniciar:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\infra\deployment\windows-test\Install-Test.ps1 -Action Start
```

Los servicios usan `restart: unless-stopped` y registros con tamaño limitado. Docker Desktop debe iniciarse en Windows para que los contenedores funcionen; configurar su inicio con la sesión del usuario en sus ajustes. No es un servicio de Windows Server que garantice arranque antes del inicio de sesión. Si se detuvieron con Stop, volver a ejecutar Start.

## Si todos están saludables pero el puerto 8091 no responde

Actualizar esta corrección y recrear únicamente Kong; conserva el administrador, claves, volúmenes y bases existentes:

```powershell
git pull --ff-only
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\infra\deployment\windows-test\Install-Test.ps1 -Action RepairAccess
Start-Process 'http://127.0.0.1:8091/login'
```

Kong debe publicar `127.0.0.1:8091->8000/tcp`. La red `host-access` permite esa publicación hacia Windows; únicamente Kong participa en ella. Las redes de base de datos y servicios siguen siendo internas. Start y RepairAccess comprueban además una respuesta HTTP 200 de `/login` antes de anunciar éxito. Esta corrección no requiere Build ni Prepare.

## Si el login devuelve error interno por permisos de JWT

Si el registro de Identity indica `EACCES` al leer `jwt_public_key` o `jwt_private_key`, aplicar:

```powershell
git pull --ff-only
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\infra\deployment\windows-test\Install-Test.ps1 -Action RepairAuth
```

La reparación verifica que las claves existentes forman pareja, ajusta su propietario al usuario 1000 del servicio y conserva su contenido. La privada permanece con permisos 0600; la pública, que no es secreta, 0644. Comprueba lectura y firma/verificación desde el usuario real de Identity. No requiere Build ni Prepare y no modifica usuarios ni contraseñas. Las nuevas preparaciones y el arranque también comprueban este acceso.

## Diagnóstico

```powershell
docker compose -p factuez-san-jose-test --env-file .\.installation\windows-test\public.env -f .\infra\deployment\windows-test\docker-compose.yml ps
docker compose -p factuez-san-jose-test --env-file .\.installation\windows-test\public.env -f .\infra\deployment\windows-test\docker-compose.yml logs --tail 80 identity-service
```

No compartir registros completos sin revisar datos sensibles. Si falla Prepare/Start, conservar el mensaje y revisar el paso; no borrar volúmenes ni repetir Prepare para resolverlo. Si el puerto 8091 está ocupado, detener la otra aplicación por su procedimiento o revisar un puerto/origen nuevo de forma consistente; no cambiar sólo el puerto del navegador.

No utilizar `docker compose down -v`, `docker volume prune` o `docker system prune --volumes` para una actualización: eliminan datos. No regenerar las claves de cifrado sobre una instalación existente.

## Actualizar después

Revisar la versión, respaldo/restauración y compatibilidad de esquema antes de actualizar. La inicialización automática sólo se ejecuta en un volumen nuevo y **no aplica migraciones a una instalación existente**. El script de despliegue remoto del perfil Ubuntu no se utiliza en Windows. No ejecutar `git pull` y Build/Start sobre datos existentes sin un procedimiento revisado de actualización.

Acceso de TI: al ser un repositorio separado, pueden clonarlo sin acceder al proyecto de desarrollo. Si el repositorio es público, cualquiera puede leer su código; sólo los colaboradores autorizados podrán escribir. Para restringir lectura, cambiarlo a privado e invitar a las cuentas de TI.
