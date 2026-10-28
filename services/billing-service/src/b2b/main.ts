import 'reflect-metadata';
import { loadBillingHostMount } from './host-config';
import { BillingHostMissingImplementations } from './host-implementations';
import { startBillingB2bHost } from './host';

export async function bootstrapBillingB2b(root = process.env.B2B_BILLING_CONFIG_ROOT) {
  if (typeof root !== 'string' || !root) throw Error('BILLING_HOST_CONFIG_ROOT_REQUIRED');
  const { config, credentials } = loadBillingHostMount(root);
  const host = await startBillingB2bHost(config, credentials);
  const shutdown = () => { void host.close().then(() => {
    process.off('SIGTERM', shutdown); process.off('SIGINT', shutdown);
  }, () => { process.stderr.write('BILLING_HOST_SHUTDOWN_INCOMPLETE\n'); process.exitCode = 1; }); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  return host;
}
export function reportBillingHostStartupFailure(error: unknown) {
  // Only our enumerated missing interface names may be logged. No DB/Redis/TLS/module diagnostics.
  process.stderr.write(error instanceof BillingHostMissingImplementations ? error.message + '\n' : 'BILLING_HOST_STARTUP_FAILED\n');
  process.exitCode = 1;
}
if (require.main === module) void bootstrapBillingB2b().catch(reportBillingHostStartupFailure);
