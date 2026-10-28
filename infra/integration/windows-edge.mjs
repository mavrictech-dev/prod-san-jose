/** Windows candidate: native TCP ingress, opaque TLS to loopback Kong. No activation. */
import { validateEdgeConfig, renderEdge } from './private-edge.mjs';
import { readFileSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const fail = () => { throw new Error('INVALID_WINDOWS_EDGE_CONFIG'); };
export function validateWindowsEdge(input) {
  const keys = ['schemaVersion', 'environment', 'deployment', 'vpn', 'listenPort', 'kongLoopbackPort', 'upstreamPorts', 'rateLimits', 'relay'];
  if (!input || Object.keys(input).length !== keys.length || keys.some(k => !Object.hasOwn(input, k)) ||
      input.schemaVersion !== 'factuez.windows-edge.v1' || input.environment !== 'BETA' || input.deployment !== 'WINDOWS_DESKTOP_TCP_LOOPBACK') fail();
  const { kongLoopbackPort: port, relay } = input;
  // Reuse, do not widen, phase7 address/CIDR/DNS/port validation.
  try { validateEdgeConfig({ schemaVersion: 'factuez.private-edge.v1', environment: 'BETA', deployment: 'LINUX_HOST_LOOPBACK',
    vpn: input.vpn, listenPort: input.listenPort, upstreamPorts: input.upstreamPorts, rateLimits: input.rateLimits }); } catch { fail(); }
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || [input.listenPort, ...Object.values(input.upstreamPorts)].includes(port)) fail();
  const ranges = { maxConnections: [1, 16], maxPerPeer: [1, 4], newConnectionsPerMinute: [1, 30],
    idleTimeoutMs: [1000, 300000], maxLifetimeMs: [1000, 600000] };
  if (!relay || typeof relay !== 'object' || Object.keys(relay).length !== Object.keys(ranges).length) fail();
  for (const [key, [min, max]] of Object.entries(ranges)) if (!Number.isSafeInteger(relay[key]) || relay[key] < min || relay[key] > max) fail();
  if (relay.maxPerPeer > relay.maxConnections || relay.idleTimeoutMs > relay.maxLifetimeMs) fail();
  return structuredClone(input);
}
export function renderWindowsEdge(input) {
  const c = validateWindowsEdge(input);
  const legacy = renderEdge({ schemaVersion: 'factuez.private-edge.v1', environment: 'BETA', deployment: 'LINUX_HOST_LOOPBACK',
    vpn: c.vpn, listenPort: c.kongLoopbackPort, upstreamPorts: c.upstreamPorts, rateLimits: c.rateLimits });
  // Only Windows native ingress sees the actual VPN source. Kong sees relay
  // loopback; its HTTP quotas are deliberately GLOBAL, never claimed per ERP IP.
  const overrides = new Map([['proxy_listen', `127.0.0.1:${c.kongLoopbackPort} ssl`],
    ['nginx_proxy_allow', '127.0.0.1'], ['nginx_proxy_limit_conn', `private_edge_connections ${c.relay.maxConnections}`]]);
  const kongConf = '# Windows TCP relay; shared HTTP quota. Never trust forwarded headers.\n' + legacy.kongConf.split('\n').map(line => {
    const key = line.split(' = ')[0]; return overrides.has(key) ? key + ' = ' + overrides.get(key) : line;
  }).join('\n');
  const compose = legacy.compose.replace('# Candidate only. Explicit TI approval and preflight required. Linux only.',
    '# Windows Desktop candidate. Requires pre-enabled Desktop host networking and TI acceptance.')
    .replace('factuez-private-edge-beta', 'factuez-private-edge-windows-beta');
  const operations = [
    '# Operación privada Windows — candidato BETA', '',
    'TI debe aprobar VPN, DNS privado, firewall, certificados/CRL y permisos del ERP.',
    'Este paquete no instala Docker/WSL/WireGuard ni modifica tareas o firewall.',
    'No se debe combinar este Compose con la intranet ni ejecutar un compose general.', '',
    '1. Revisar los requisitos y la configuración; usar windows-operation.mjs --bundle RUTA --check.',
    '2. TI revisa el plan acotado de arranque: windows-operation.mjs --bundle RUTA --plan-start.',
    '3. Iniciar sólo kong-private con el plan aprobado. Los owners deben estar ya preparados',
    '   en HTTPS/mTLS 127.0.0.1; este paquete no los habilita ni migra sus bases.',
    '4. Iniciar la entrada nativa, en primer plano, con:',
    '   node infra/integration/windows-relay.mjs --config RUTA/windows-edge.json --serve --ti-approved-beta',
    '5. Ctrl+C cierra exclusivamente esa entrada y sus conexiones. Detener sólo el Kong privado',
    '   según el plan --plan-stop; nunca ejecutar down, prune o borrar volúmenes.', '',
    'La entrada nativa verifica la dirección/interfaz WireGuard y DNS antes de escuchar.',
    'No lee HTTP, tokens o XML; TLS termina en Kong y conserva el certificado del ERP.',
    'Kong mantiene mTLS, CRL, los 17 endpoints exactos y TLS verificado a los owners.',
    'Windows limita conexiones por IP real; Kong aplica cuota HTTP agregada al loopback.',
    'No se interpreta X-Forwarded-For/Forwarded como identidad del cliente.', '',
    'No hay inicio automático después de reiniciar Windows ni de cerrar sesión.',
    'TI debe ensayar eso y el soporte/licencias de Windows/Desktop antes de instalar tareas.',
    'La conexión remota y el piloto real siguen bloqueados hasta aceptación de TI.', '',
  ].join('\n');
  return { 'windows-edge.json': JSON.stringify(c, null, 2) + '\n', 'kong.json': JSON.stringify(legacy.kong, null, 2) + '\n',
    'kong.conf': kongConf, 'compose.yml': compose, 'OPERATOR.md': operations,
    'empty.env': '# Intentionally empty. Prevent implicit .env inheritance.\n' };
}
export function safeWindowsFile(path, max = 262144) {
  let cursor = resolve(path);
  for (;;) { if (lstatSync(cursor).isSymbolicLink()) throw new Error('WINDOWS_EDGE_FILE_INVALID');
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent; }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size < 1 || stat.size > max) throw new Error('WINDOWS_EDGE_FILE_INVALID');
  return readFileSync(path);
}
export function checkWindowsBundle(bundle) {
  const c = validateWindowsEdge(JSON.parse(safeWindowsFile(resolve(bundle, 'windows-edge.json'), 16384)));
  for (const [name, expected] of Object.entries(renderWindowsEdge(c)))
    if (safeWindowsFile(resolve(bundle, name)).toString('utf8') !== expected) throw new Error('WINDOWS_EDGE_RENDER_MISMATCH');
  return c;
}
export function prepareWindowsBundle(config, output) {
  const c = JSON.parse(safeWindowsFile(config, 16384));
  // New destination only, with no symlink/reparse parent and no overwrites.
  safeWindowsFile(config, 16384);
  let cursor = dirname(resolve(output));
  for (;;) { if (!lstatSync(cursor).isDirectory() || lstatSync(cursor).isSymbolicLink()) throw new Error('WINDOWS_EDGE_FILE_INVALID');
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent; }
  const files = renderWindowsEdge(c); mkdirSync(output, { mode: 0o700 });
  for (const [name, value] of Object.entries(files)) writeFileSync(resolve(output, name), value, { flag: 'wx', mode: 0o600 });
  return { status: 'PREPARED_NOT_ACTIVATED', environment: 'BETA', files: Object.keys(files).length, automaticActivation: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (process.argv.length !== 6 || process.argv[2] !== '--config' || process.argv[4] !== '--out') fail();
    process.stdout.write(JSON.stringify(prepareWindowsBundle(process.argv[3], process.argv[5])) + '\n');
  } catch { process.stderr.write('WINDOWS_EDGE_PREPARATION_FAILED\n'); process.exitCode = 1; }
}
