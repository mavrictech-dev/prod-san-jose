/** Opaque TCP relay. Never terminate TLS, parse HTTP or forward identity headers. */
import { createServer, connect, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateWindowsEdge, safeWindowsFile, checkWindowsBundle } from './windows-edge.mjs';
import { inspectWindows } from './windows-readiness.mjs';
const deny = code => { throw new Error(code); };
const integer = ip => ip.split('.').reduce((n, v) => n * 256 + Number(v), 0);
export function allowedPeer(address, cidrs) {
  // IPv4-only listener: IPv6/mapped aliases are not an alternate ingress.
  if (isIP(address ?? '') !== 4) return false;
  const n = integer(address);
  return cidrs.some(cidr => { const [ip, bits] = cidr.split('/'); const size = 2 ** (32 - Number(bits));
    return n >= integer(ip) && n < integer(ip) + size; });
}
export async function verifyWindowsNetwork(input, injected = {}) {
  const c = validateWindowsEdge(input);
  const io = { platform: () => process.platform, interfaces: networkInterfaces,
    adapter: iface => JSON.parse(execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; $taskAdapter=Get-NetAdapter -Name '" + iface + "' -ErrorAction Stop; [ordered]@{wireguard=($taskAdapter.InterfaceDescription -match 'WireGuard'); up=($taskAdapter.Status -eq 'Up')} | ConvertTo-Json -Compress"],
      { windowsHide: true, timeout: 5000, maxBuffer: 4096, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })),
    dns: host => lookup(host, { all: true }), ...injected };
  if (io.platform() !== 'win32') deny('WINDOWS_NATIVE_HOST_REQUIRED');
  const iface = io.interfaces()[c.vpn.interface];
  if (!Array.isArray(iface) || !iface.some(row => row.address === c.vpn.address && row.internal === false)) deny('WINDOWS_VPN_ADDRESS_INVALID');
  const adapter = await io.adapter(c.vpn.interface);
  if (!adapter || adapter.wireguard !== true || adapter.up !== true || Object.keys(adapter).length !== 2) deny('WINDOWS_WIREGUARD_REQUIRED');
  let timer;
  try {
    const addresses = await Promise.race([io.dns(c.vpn.privateDnsName), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('WINDOWS_PRIVATE_DNS_INVALID')), 3000); })]);
    if (!Array.isArray(addresses) || !addresses.length || addresses.some(a => a.family !== 4 || a.address !== c.vpn.address)) deny('WINDOWS_PRIVATE_DNS_INVALID');
  } finally { clearTimeout(timer); }
  return { status: 'NETWORK_METADATA_PASSED_TI_ACCEPTANCE_PENDING', environment: 'BETA', automaticActivation: false };
}
export function createWindowsRelay(input, injected = {}) {
  const c = validateWindowsEdge(input), io = { server: createServer, connect, now: Date.now, ...injected };
  const peers = new Map(), active = new Set(), sockets = new Set(); let stopping = false;
  const server = io.server({ allowHalfOpen: false }, client => {
    const now = io.now(), ip = client.remoteAddress;
    for (const [key, value] of peers) if (!value.active && value.until <= now) peers.delete(key);
    if (stopping || client.localAddress !== c.vpn.address || !allowedPeer(ip, c.vpn.clientCidrs)) { client.destroy(); return; }
    let state = peers.get(ip);
    if (!state) { if (peers.size >= 512) { client.destroy(); return; }
      state = { active: 0, count: 0, until: now + 60000 }; peers.set(ip, state); }
    if (state.until <= now) { state.count = 0; state.until = now + 60000; }
    if (active.size >= c.relay.maxConnections || state.active >= c.relay.maxPerPeer || state.count >= c.relay.newConnectionsPerMinute) {
      client.destroy(); return;
    }
    state.count++; state.active++; active.add(client); sockets.add(client);
    client.pause(); client.setNoDelay(true);
    let upstream, cleaned = false, connectTimer, lifetime;
    const close = () => { if (cleaned) return; cleaned = true; clearTimeout(connectTimer); clearTimeout(lifetime);
      state.active--; active.delete(client); sockets.delete(client); client.destroy();
      if (upstream) { sockets.delete(upstream); upstream.destroy(); } };
    client.on('error', close); client.on('close', close); client.setTimeout(c.relay.idleTimeoutMs, close);
    lifetime = setTimeout(close, c.relay.maxLifetimeMs); lifetime.unref();
    try { upstream = io.connect({ host: '127.0.0.1', port: c.kongLoopbackPort }); }
    catch { close(); return; }
    sockets.add(upstream); upstream.setNoDelay(true); upstream.setTimeout(c.relay.idleTimeoutMs, close);
    connectTimer = setTimeout(close, 3000); connectTimer.unref();
    upstream.on('error', close); upstream.on('close', close);
    upstream.once('connect', () => { clearTimeout(connectTimer); if (cleaned) return;
      // Node pipe backpressure preserves bounded socket buffering. No payload copy/log.
      client.pipe(upstream); upstream.pipe(client); client.resume(); });
  });
  return { server,
    start: () => new Promise((done, reject) => { server.once('error', reject);
      server.listen({ host: c.vpn.address, port: c.listenPort, exclusive: true, ipv6Only: true }, () => { server.removeListener('error', reject); done(); }); }),
    stop: () => new Promise(done => { stopping = true; for (const socket of sockets) socket.destroy();
      if (server.listening) server.close(() => done()); else done(); }),
    metadata: () => ({ activeConnections: active.size, trackedPeers: peers.size, environment: 'BETA' }),
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 6 || process.argv[2] !== '--config' || process.argv[4] !== '--serve' || process.argv[5] !== '--ti-approved-beta') deny('WINDOWS_RELAY_APPROVAL_REQUIRED');
    const c = validateWindowsEdge(JSON.parse(safeWindowsFile(process.argv[3], 16384)));
    checkWindowsBundle(dirname(resolve(process.argv[3])));
    if ((await inspectWindows()).status !== 'HOST_CHECKS_PASSED_PILOT_PENDING') deny('WINDOWS_HOST_CHECKS_REQUIRED');
    await verifyWindowsNetwork(c); const relay = createWindowsRelay(c); await relay.start();
    relay.server.on('error', () => { void relay.stop(); process.exitCode = 1; });
    let closing = false; const close = () => { if (!closing) { closing = true; void relay.stop(); } };
    process.once('SIGINT', close); process.once('SIGTERM', close);
    process.stdout.write(JSON.stringify({ status: 'BETA_RELAY_RUNNING', tlsTermination: 'KONG', httpQuota: 'AGGREGATE', realPeerConnectionLimits: true }) + '\n');
  } catch { process.stderr.write('WINDOWS_RELAY_BLOCKED_NOT_ACTIVATED\n'); process.exitCode = 1; }
}
