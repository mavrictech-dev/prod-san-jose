import path from 'node:path';
import { pathToFileURL } from 'node:url';

// No imports of the application or reads of its configuration until explicitly enabled.
export async function launch(env, load) {
  if (env.B2B_API_ENABLED !== 'true') throw new Error('B2B_API_DISABLED');
  const root = env.B2B_API_CONFIG_ROOT;
  if (typeof root !== 'string' || !path.posix.isAbsolute(root) || root === '/' || root.includes('\\') || path.posix.normalize(root) !== root) {
    throw new Error('B2B_API_CONFIG_ROOT_INVALID');
  }
  const app = await load();
  if (typeof app.bootstrapB2bApi !== 'function') throw new Error('B2B_API_BOOTSTRAP_MISSING');
  const runtime = await app.bootstrapB2bApi(env);
  if (!runtime) throw new Error('B2B_API_RUNTIME_NOT_STARTED');
  return runtime;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  launch(process.env, () => import('../../../services/b2b-api-service/dist/main.js'))
    .catch(() => { process.stderr.write('B2B_API_PACKAGE_STARTUP_BLOCKED\n'); process.exitCode = 78; });
}

