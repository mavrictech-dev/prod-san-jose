import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(process.cwd());
const demoRoot = join(root, '.factuez-demo');
const secretsRoot = join(demoRoot, 'secrets');

function randomSecret(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

async function writeSecret(name, content) {
  const file = join(secretsRoot, name);
  await writeFile(file, `${content.trim()}\n`, { encoding: 'utf8', mode: 0o600 });
  try { await chmod(file, 0o600); } catch { /* Windows puede no aplicar POSIX mode. */ }
}

async function demoCredentials() {
  const file = join(demoRoot, 'demo-admin.txt');
  if (process.env.DEMO_ADMIN_PASSWORD?.trim()) {
    return { password: process.env.DEMO_ADMIN_PASSWORD.trim(), file };
  }
  try {
    const saved = await readFile(file, 'utf8');
    const password = saved.split(/\r?\n/).find((line) => line.startsWith('password='))?.slice('password='.length);
    if (password) return { password, file };
  } catch { /* Primera ejecución. */ }
  return { password: `Demo-${randomSecret(18)}`, file };
}

await mkdir(secretsRoot, { recursive: true, mode: 0o700 });
const existingSecrets = await readdir(secretsRoot);
if (existingSecrets.length && !process.argv.includes('--rotate')) {
  console.log(`Los secretos de demo ya existen en ${secretsRoot}`);
  console.log(`Credenciales de prueba: ${join(demoRoot, 'demo-admin.txt')}`);
  console.log('Use --rotate sólo después de detener y eliminar los contenedores y volúmenes de demo.');
  process.exit(0);
}

const credentials = await demoCredentials();
await writeFile(credentials.file, `username=demo.admin\npassword=${credentials.password}\n`, { encoding: 'utf8', mode: 0o600 });
try { await chmod(credentials.file, 0o600); } catch { /* Windows puede no aplicar POSIX mode. */ }

for (const name of ['demo_postgres_password.txt', 'demo_db_password.txt', 'redis_password.txt', 'app_master_key.txt', 'internal_service_token.txt']) {
  await writeSecret(name, randomSecret());
}
await writeSecret('initial_admin_password.txt', credentials.password);

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
await writeSecret('jwt_private_key.pem', privateKey);
await writeSecret('jwt_public_key.pem', publicKey);

console.log(`Secretos de demo creados en ${secretsRoot}`);
console.log(`Credenciales de prueba: ${credentials.file}`);
console.log('No se usaron certificados, credenciales SOL ni endpoints reales de SUNAT.');
