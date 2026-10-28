import { defineConfig } from 'prisma/config';
// Generation/validation ONLY. Never reads DATABASE_URL, .env or existing secrets.
// No migrate/deploy script. The isolated rehearsal provisions its own empty DB.
export default defineConfig({ schema: 'prisma/schema.prisma', datasource: { url: 'postgresql://unbound.invalid:1/factuez_history_unbound' } });
