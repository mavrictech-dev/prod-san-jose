import { AccessError } from '@factuez/service-access';
/** Explicit deployment identity, independent of environment names and SMTP activation flags. */
export function mailerDatabaseName(): string {
  const name = process.env.MAILER_DATABASE_NAME;
  if (!name || !/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new AccessError(503, 'Identidad de base Mailer no configurada');
  if (process.env.DB_NAME !== undefined && process.env.DB_NAME !== name) throw new AccessError(503, 'Identidad de base Mailer inconsistente');
  return name;
}
export function validatedMailerDatabaseUrl(value: string): string {
  try {
    const name = mailerDatabaseName(), url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || decodeURIComponent(url.pathname) !== '/' + name || url.searchParams.has('options')) throw new Error();
    return value;
  } catch { throw new AccessError(503, 'Conexión de base Mailer no corresponde a la identidad configurada'); }
}
