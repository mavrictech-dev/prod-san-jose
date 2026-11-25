// Start only the real local PWA, with no inherited application configuration.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = resolve(root, 'apps/web-pwa');
// Next loads these automatically. Refuse their presence without opening them.
for (const directory of [root, app]) {
  for (const name of ['.env', '.env.local', '.env.development', '.env.development.local']) {
    if (existsSync(resolve(directory, name))) throw new Error(`Local browser smoke refuses ${name} files`);
  }
}
const output = resolve(root, 'output/guide-settings/ui');
mkdirSync(output, { recursive: true });
const log = createWriteStream(resolve(output, 'server.log'), { flags: 'w' });
const env = {};
for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT']) {
  if (process.env[name]) env[name] = process.env[name];
}
Object.assign(env, {
  NODE_ENV: 'development',
  NEXT_TELEMETRY_DISABLED: '1',
  NEXT_PUBLIC_API_BASE_URL: 'http://127.0.0.1:3117',
});
const require = createRequire(resolve(app, 'package.json'));
const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', '3117'], {
  cwd: app, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.pipe(log);
child.stderr.on('data', chunk => { log.write(chunk); process.stderr.write(chunk); });
child.on('error', error => { log.end(String(error)); process.exitCode = 1; });
child.on('exit', code => { log.end(); process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
