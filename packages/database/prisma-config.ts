import { readFileSync } from 'node:fs';

import { defineConfig } from 'prisma/config';

/**
 * Configuración Prisma reutilizable sin compartir schema ni Prisma Client.
 * La contraseña se lee desde Docker secrets y nunca se interpola en Compose.
 */
export function servicePrismaConfig() {
  const directUrl = process.env.DATABASE_URL;
  if (directUrl) {
    return defineConfig({
      schema: 'prisma/schema.prisma',
      migrations: { path: 'prisma/migrations' },
      datasource: { url: directUrl },
    });
  }

  const passwordFile = process.env.DB_PASSWORD_FILE;
  const user = process.env.DB_USER;
  const database = process.env.DB_NAME;

  if (!passwordFile || !user || !database) {
    throw new Error('DB_PASSWORD_FILE, DB_USER y DB_NAME son obligatorios');
  }

  const password = readFileSync(passwordFile, 'utf8').trim();
  const host = process.env.DB_HOST ?? 'postgres';
  const port = process.env.DB_PORT ?? '5432';
  const url = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;

  return defineConfig({
    schema: 'prisma/schema.prisma',
    migrations: { path: 'prisma/migrations' },
    datasource: { url },
  });
}
