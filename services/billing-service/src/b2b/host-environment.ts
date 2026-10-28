import { readFileSync } from 'node:fs';
import type { BillingHostConfig, BillingHostCredentials } from './host-config';

let leased = false;
/** Existing owner constructors consume env. Standalone projects ONLY explicit
 * mounted values; conflicting inherited settings reject, and legacy defaults are untouched. */
export function installBillingHostEnvironment(config: BillingHostConfig, credentials: BillingHostCredentials, env: NodeJS.ProcessEnv = process.env) {
  if (leased) throw Error('BILLING_HOST_ENVIRONMENT_ALREADY_OWNED');
  try {
    if (!readFileSync(credentials.redisPasswordFile).equals(credentials.redisPassword)) throw Error();
  } catch { throw Error('BILLING_HOST_REDIS_MOUNT_CHANGED'); }
  const values: Record<string, string> = {
    DATABASE_URL: credentials.databaseUrl, REDIS_HOST: config.redis.host, REDIS_PORT: String(config.redis.port),
    REDIS_PASSWORD_FILE: credentials.redisPasswordFile, PRINT_SETTINGS_ENABLED: 'true', PRINT_BRANDING_ROOT: config.printRoot,
    STATION_MASTER_CRUD_ENABLED: 'true',
  };
  for (const [key, value] of Object.entries(values)) if (env[key] !== undefined && env[key] !== value) throw Error('BILLING_HOST_ENVIRONMENT_CONFLICT:' + key);
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, env[key]]));
  for (const [key, value] of Object.entries(values)) env[key] = value;
  leased = true; let restored = false;
  return () => {
    if (restored) return; restored = true;
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete env[key]; else env[key] = value;
    leased = false;
  };
}
