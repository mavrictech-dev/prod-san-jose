# Database tooling

Este paquete sólo comparte utilidades de configuración, health checks y helpers
de transacción. No publica un Prisma Client ni un schema común.

Cada microservicio es dueño de `services/<service>/prisma/schema.prisma`, sus
migraciones y su base lógica PostgreSQL. Está prohibido importar el cliente
generado de otro servicio.

`prisma-config.ts` sólo construye la conexión desde `DB_*` y Docker secrets.
Cada servicio mantiene su propio `prisma.config.ts`; no existe un schema global.
