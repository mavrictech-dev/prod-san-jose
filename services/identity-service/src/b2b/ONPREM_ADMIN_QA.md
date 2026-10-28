# OnPrem B2B admin: instalación QA apagada y prerrequisitos exactos

Bloque de configuración local BETA, independiente de OIDC/MFA. Usa el AuthService, PasswordService y PrismaService ya propiedad del AppModule de Identity. No instancia otro Prisma/Redis ni importa un AppModule paralelo. El wrapper OnpremCurrentIdentityGuard ejecuta el IdentityPermissionGuard existente sin modificarlo. La contraseña se verifica con PasswordService.verify contra User.passwordHash actual, antes y después de comprobaciones frescas de authVersion/roles/permisos/sesión browser. No acepta un claim stepUpVerified ni un usuario inventado para SERVICE.

## Instalación apagada

Copiar a la configuración gestionada por main, sin habilitarlo:

```dotenv
B2B_ONPREM_ADMIN_ENABLED=false
NEXT_PUBLIC_B2B_ADMIN_PROFILE=SSO
```

Con B2B_ONPREM_ADMIN_ENABLED=false (también ausente o cualquier valor distinto de true), OnpremAdminHost no lee montajes, no comprueba esquemas y no realiza conexiones adicionales. La ruta de status protegida devuelve explícitamente profile=ONPREM, enabled=false, authenticated=false; no emite cookie ni permite reautenticación/gestión. No es necesario montar claves ni aplicar DDL para instalar este módulo apagado. No cambiar B2B_PRIVATE_ACCESS global del stack sólo por instalarlo apagado: otros servicios pueden necesitar su valor actual.

NEXT_PUBLIC_B2B_ADMIN_PROFILE=ONPREM sólo selecciona la pantalla; jamás habilita el servidor. Con el flag server=false esa pantalla queda cerrada. SSO sigue siendo el valor predeterminado, no hay fallback por 404/503 ni por error de OIDC/MFA.

## DDL mínimo exacto, manual, sin ejecutar

Archivo: `onprem-admin.minimal.sql`, junto a este documento. Crea únicamente B2bClient, B2bAudit y B2bRateBucket y un índice de auditoría. No crea usuarios, roles, passwords, refresh sessions, links OIDC, grants, secretos ni clientes.

Aplicar sólo tras revisión y autorización del dueño de la base EXISTENTE de Identity, cuando las tres tablas estén ausentes. El archivo no usa IF NOT EXISTS: si ya existe el esquema B2B, comprobar compatibilidad de columnas/constraints con el archivo y NO volver a aplicarlo ni borrar/recrear tablas. No se requiere una base nueva, un usuario humano ficticio ni nuevas tablas de contraseña/sesión.

Prerrequisitos existentes de Identity (no creados por este DDL):

- User: id uuid, active boolean, authVersion integer, passwordHash text (scrypt con el formato actual); AuthService también usa sus columnas nativas username/fullName y asignaciones.
- UserRoleAssignment: userId, roleId; Role: id, code, active; RolePermission: roleId, permissionId; Permission: id, code.
- El administrador humano actual debe tener rol activo ADMIN/GLOBAL y permisos actuales SETUP_MANAGE, USER_MANAGE, ROLE_MANAGE. Se requieren tanto en el JWT como en el RBAC fresco de DB. Los permisos extra delegables no elevan a administrador.
- BrowserSessionStore/Redis actual debe validar browserSessionId del JWT. Login sólo con bearer heredado sin sesión browser no habilita OnPrem. La cookie original factuez_session conserva su Path actual; el nuevo endpoint usa el JWT de la sesión PWA y AuthService.assertActive, no intenta leer esa cookie fuera de su ruta.
- La conexión ya existente de Prisma Identity requiere SELECT sobre User/RBAC, SELECT/INSERT/UPDATE sobre B2bClient y B2bRateBucket e INSERT sobre B2bAudit. No requiere SQL a Billing/Fiscal. La reautenticación no actualiza User/passwordHash/lastLoginAt.

No se aplicó ningún SQL ni se arrancó una base. Las pruebas de este bloque usan registros sintéticos de prueba; ejecutan el guard, AuthService RS256/assertActive y PasswordService scrypt reales, además de pruebas del SQL parametrizado de los adaptadores.

## Habilitación posterior, sólo por main

```dotenv
B2B_ONPREM_ADMIN_ENABLED=true
B2B_PRIVATE_ACCESS=true
B2B_ONPREM_ADMIN_CONFIG_ROOT=/run/factuez/b2b-onprem
AUTH_BROWSER_ORIGINS=https://qa.example.invalid
NEXT_PUBLIC_B2B_ADMIN_PROFILE=ONPREM
```

Montar con propietario/ACL restrictivos `onprem-admin.json`:

```json
{
  "schemaVersion": "factuez.b2b.onprem-admin.v1",
  "profile": "ONPREM",
  "environment": "BETA",
  "approvedForLocalSetup": true,
  "origins": ["https://qa.example.invalid"],
  "billingOrigin": "https://billing-readonly:9020",
  "tokenIssuer": "https://identity-b2b.example.invalid"
}
```

Los origins deben ser HTTPS exactos, sin slash final, y estar YA en AUTH_BROWSER_ORIGINS del mecanismo browser existente. No usar LOCAL_BROWSER_SESSION_QA_ENABLED para rebajar HTTPS en este perfil.

Archivos de montaje, todos dedicados/sintéticos en QA:

- ca.pem, resource.crt, resource.key: transporte mTLS al catálogo Billing. El fingerprint de resource.crt debe estar en registrar del createBillingReadonlyOwner; SAN y CA de Billing deben validarse.
- signing-key.pem, human-public.pem, integration-public.pem, pepper.bin (32 bytes): mismas claves B2B, issuer y pepper del owner readonly que consumirá B2bClient. Nunca reemplazar las claves JWT humanas existentes. Un pepper diferente haría que el cliente creado no pudiera usar OAuth en el otro proceso.
- Este directorio no contiene credenciales PostgreSQL: se usa el Prisma propietario del Identity nativo. Los procesos nativo y readonly que deban ver los mismos clientes tienen que apuntar a la MISMA base Identity autorizada. No se consulta otra DB desde el módulo.

El Billing READ mínimo existente publica /internal/b2b/validate-bindings. Es un prerrequisito real: debe comprobar el tuple completo activo emisor/sede/punto/serie BETA 01/03. Si falta, crear/activar/modificar grants falla cerrado. Desactivar un cliente sigue permitido si su catálogo quedó inactivo.

## Ruta Kong que debe añadir main

Agregar `/api/v1/b2b-admin` al servicio identity-service, con strip_path=false, en el listener HTTPS del mismo origen PWA. Ejemplo de fragmento para incorporar manualmente a la ruta de Identity:

```yaml
- name: identity-b2b-onprem-admin
  paths: [/api/v1/b2b-admin]
  strip_path: false
  protocols: [https]
```

Este fragmento es una ruta hija del servicio `identity-service` existente, no un nuevo servicio ni listener público. No se cambió Kong. No exponer /internal/b2b/* por esa ruta. Mantener intactas las rutas OIDC/SSO actuales. No permitir orígenes arbitrarios ni registrar Authorization, Cookie, contraseña o clientSecret en gateway/body logs.

La PWA utiliza workspace.api, con su bearer actual y credentials=same-origin. Todos los accesos browser del SDK, incluso lecturas, usan POST para que el navegador adjunte Origin. Se conservan paths GET para clientes explícitos que adjunten Origin y CSRF. No se añaden excepciones al middleware browser existente.

Endpoints nativos:

- POST /api/v1/b2b-admin/status, body {}: status ONPREM explícito; genera challenge CSRF y cookie pendiente, no autoridad.
- POST /api/v1/b2b-admin/reauthenticate, body {password}: contraseña actual exacta; sin username/sub/claims en body.
- POST /api/v1/b2b-admin/logout, body {}.
- POST /api/v1/b2b-admin/applications/query, body {environment:"BETA",limit:25,after?:uuid}.
- POST /api/v1/b2b-admin/applications/:id/read?environment=BETA, body {}.
- POST /api/v1/b2b-admin/applications?environment=BETA: SERVICE, label, scopes readonly y bindings.
- PATCH /api/v1/b2b-admin/applications/:id?environment=BETA: expectedRevision y cambios admitidos.
- POST /api/v1/b2b-admin/applications/:id/rotate-secret?environment=BETA: {expectedRevision}.

Todas las rutas usan el guard actual. Con el perfil habilitado requieren Origin autorizado, X-FactuEz-B2b-Admin: ONPREM y Sec-Fetch-Site same-origin si está presente. Después de status requieren cookie __Secure-factuez_b2b_onprem y X-FactuEz-CSRF vigente. Cookie HttpOnly/Secure/SameSite=Strict/Path=/api/v1/b2b-admin. Caducidad absoluta de dos minutos, sin renovación automática. La sesión step-up vive sólo en memoria del proceso; reiniciar exige repetir contraseña. En múltiples réplicas hace falta afinidad de proceso o aceptar reautenticación al cambiar de réplica; no hay fallback distribuido permisivo.

La autoridad devuelve stepUpVerified sólo internamente y dentro de la operación actual; los callbacks de B2bIdentity vuelven a verificarla antes/después del commit/auditoría. El servidor conserva sujeción a authVersion, passwordHash, RBAC y browserSessionId. Cambiar o revocar cualquiera impide la siguiente operación; fallos de lectura/auditoría cierran el acceso. El cupo de intentos usa B2bRateBucket persistente (5/min y 20/h por usuario) y límite local de scrypt concurrentes.

## Alcance

Únicamente clientes SERVICE, scopes context/catalog/documents/artifacts READ y gestión/lectura de webhooks, bindings BETA 01/03 activos. El editor OnPrem expone exclusivamente esas opciones. No permite usuarios delegados, emisión, producción fiscal, cambios a OIDC/MFA ni ejecución del grafo completo. La envoltura candidateOnly=true se conserva por compatibilidad con el contrato histórico del panel; no es prueba de autoridad.

CREATE/ROTATE muestran clientSecret una sola vez. GET/list/PATCH nunca recuperan secretos. No hay cache/replay automático de comandos ni almacenamiento browser del password/secret. Las acciones de cliente y auditoría se guardan mediante los adaptadores PostgreSQL B2B existentes. La prueba step-up es efímera; no es un password store nuevo.

## Validación y congelación

```powershell
pnpm exec vitest run --config tests/b2b-onprem-admin.config.mts --reporter=verbose
pnpm --filter @factuez/identity-service typecheck
pnpm --filter @factuez/web-pwa typecheck
```

No ejecutar build/deploy ni aplicar DDL como parte de estas verificaciones. El cierre del bloque entrega los archivos validados y los deja congelados para integración por main.

### Cierre validado — archivos congelados

Validación final: 34 pruebas OnPrem aprobadas (autoridad, HTTPS nativo, SDK/UI y adaptador SQL), 329 regresiones de administración/SSO aprobadas; typecheck de Identity y PWA aprobado sin errores. No se ejecutó build ni deploy; no se creó una base ni se aplicó SQL. Las verificaciones usan únicamente claves y registros sintéticos de prueba. Código y documentación congelados para integración por main; el flag sigue false por defecto y el ejemplo de instalación está apagado.