/** TI opt-in, read-only preflight. No HTTP, OAuth, production, DDL or activation. */
import { validateEdgeConfig, renderEdge, upstreamTlsNames } from './private-edge.mjs';
import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { lookup } from 'node:dns/promises';
import { connect } from 'node:tls';
import { execFileSync } from 'node:child_process';

const fail = code => { throw new Error(code); };
const publicKey = key => createPublicKey(key).export({ type: 'spki', format: 'der' });
export function validateTlsMaterial(material, config, now = Date.now()) {
  try {
    const certificates = {};
    for (const name of ['edge-cert.pem', 'edge-server-ca.pem', 'edge-client-ca.pem', 'upstream-ca.pem', 'kong-client-cert.pem']) {
      const bytes = material[name];
      if (!Buffer.isBuffer(bytes) || bytes.length > 128 * 1024 ||
          (bytes.toString().match(/-----BEGIN CERTIFICATE-----/g) ?? []).length !== 1) fail('EDGE_TLS_INVALID');
      const cert = new X509Certificate(bytes);
      if (Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) <= now + 86400000) fail('EDGE_TLS_EXPIRED');
      const key = cert.publicKey, kind = key.asymmetricKeyType, details = key.asymmetricKeyDetails;
      if (!(['rsa', 'rsa-pss'].includes(kind) && details?.modulusLength >= 2048 ||
          kind === 'ec' && ['prime256v1', 'secp384r1', 'secp521r1'].includes(details?.namedCurve) ||
          kind === 'ed25519')) fail('EDGE_TLS_INVALID');
      certificates[name] = cert;
    }
    for (const caName of ['edge-server-ca.pem', 'edge-client-ca.pem', 'upstream-ca.pem']) {
      const ca = certificates[caName];
      if (!ca.ca || ca.subject !== ca.issuer || !ca.verify(ca.publicKey)) fail('EDGE_TLS_INVALID');
    }
    const edge = certificates['edge-cert.pem'], client = certificates['kong-client-cert.pem'];
    if (edge.ca || client.ca || !edge.checkHost(config.vpn.privateDnsName) ||
        !edge.keyUsage?.includes('1.3.6.1.5.5.7.3.1') || !client.keyUsage?.includes('1.3.6.1.5.5.7.3.2') ||
        !edge.verify(certificates['edge-server-ca.pem'].publicKey) || !client.verify(certificates['upstream-ca.pem'].publicKey)) fail('EDGE_TLS_INVALID');
    for (const [cert, keyName] of [[edge, 'edge-key.pem'], [client, 'kong-client-key.pem']]) {
      const privateKey = createPrivateKey(material[keyName]);
      if (!cert.publicKey.export({ type: 'spki', format: 'der' }).equals(publicKey(privateKey))) fail('EDGE_TLS_INVALID');
    }
    if (edge.publicKey.export({ type: 'spki', format: 'der' }).equals(client.publicKey.export({ type: 'spki', format: 'der' }))) fail('EDGE_TLS_INVALID');
    return { clientFingerprint: client.fingerprint256.replace(/:/g, '').toLowerCase() };
  } catch (error) {
    if (['EDGE_TLS_INVALID', 'EDGE_TLS_EXPIRED'].includes(error.message)) throw error;
    fail('EDGE_TLS_INVALID');
  }
}
export function validateCrlTimes(text, now = Date.now()) {
  const lines = text.trim().split(/\r?\n/);
  const last = /^lastUpdate=(.+)$/.exec(lines[0] ?? ''), next = /^nextUpdate=(.+)$/.exec(lines[1] ?? '');
  const previous = Date.parse(last?.[1] ?? ''), expiry = Date.parse(next?.[1] ?? '');
  if (lines.length !== 2 || !Number.isFinite(previous) || !Number.isFinite(expiry) ||
      previous > now || expiry <= now + 3600000 || previous >= expiry) fail('EDGE_CRL_INVALID');
}
export function validateDeploymentSettings(environment, bundlePath) {
  if (!environment || typeof environment.kongImage !== 'string' ||
      !/^kong:3\.9\.3@sha256:[a-f0-9]{64}$/.test(environment.kongImage) ||
      typeof environment.bundle !== 'string' || !environment.bundle.startsWith('/') ||
      resolve(environment.bundle) !== resolve(bundlePath)) fail('EDGE_DEPLOYMENT_INVALID');
}
function safeFile(path, maximum, secret = false) {
  const file = resolve(path); let cursor = file;
  for (;;) {
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) fail('EDGE_FILE_INVALID');
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size < 1 || stat.size > maximum ||
      secret && (stat.mode & 0o027) !== 0) fail('EDGE_FILE_INVALID');
  return readFileSync(file);
}
function openssl(args) {
  try { return execFileSync('openssl', args, { encoding: 'utf8', timeout: 3000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { fail('EDGE_TLS_TOOL_CHECK_FAILED'); }
}
function ifaceKind(name) {
  try {
    const data = execFileSync('ip', ['-j', '-d', 'link', 'show', 'dev', name], {
      encoding: 'utf8', timeout: 3000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const rows = JSON.parse(data);
    return rows.length === 1 && rows[0].ifname === name ? rows[0].linkinfo?.info_kind : null;
  } catch { fail('EDGE_VPN_INTERFACE_INVALID'); }
}
async function boundedDns(host) {
  let timer;
  try {
    return await Promise.race([lookup(host, { all: true }), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('EDGE_DNS_INVALID')), 3000);
    })]);
  } finally { clearTimeout(timer); }
}
function handshake(port, material, servername) {
  return new Promise((resolveResult, reject) => {
    const socket = connect({ host: '127.0.0.1', port, servername, ca: material['upstream-ca.pem'],
      cert: material['kong-client-cert.pem'], key: material['kong-client-key.pem'],
      rejectUnauthorized: true, minVersion: 'TLSv1.2' });
    const timer = setTimeout(() => socket.destroy(new Error('TLS_TIMEOUT')), 3000);
    socket.on('secureConnect', () => {
      if (!socket.authorized || !socket.getPeerCertificate().fingerprint256) return socket.destroy(new Error('TLS_FAILED'));
      const cert = new X509Certificate(socket.getPeerCertificate().raw);
      if (cert.ca || !cert.checkIP('127.0.0.1') || !cert.checkHost(servername) || !cert.keyUsage?.includes('1.3.6.1.5.5.7.3.1') ||
          Date.parse(cert.validTo) <= Date.now() + 86400000) return socket.destroy(new Error('TLS_FAILED'));
      socket.end(); resolveResult(true);
    });
    socket.once('close', () => clearTimeout(timer));
    socket.on('error', () => reject(new Error('EDGE_UPSTREAM_TLS_INVALID')));
  });
}
const defaults = { platform: () => process.platform, interfaces: networkInterfaces, kind: ifaceKind,
  dns: boundedDns, read: safeFile, openssl, handshake, now: Date.now,
  deployment: () => ({ kongImage: process.env.FACTUEZ_PRIVATE_KONG_IMAGE, bundle: process.env.FACTUEZ_PRIVATE_EDGE_BUNDLE }) };
export async function preflightEdge(input, bundlePath, injected = {}) {
  // Dependency injection is for synthetic tests, never a CLI switch or runtime bypass.
  const io = { ...defaults, ...injected }, c = validateEdgeConfig(input);
  if (io.platform() !== 'linux') fail('EDGE_LINUX_HOST_REQUIRED');
  validateDeploymentSettings(io.deployment(), bundlePath);
  const iface = io.interfaces()[c.vpn.interface];
  if (io.kind(c.vpn.interface) !== 'wireguard' || !Array.isArray(iface) ||
      !iface.some(address => address.address === c.vpn.address && !address.internal)) fail('EDGE_VPN_INTERFACE_INVALID');
  const dns = await io.dns(c.vpn.privateDnsName);
  if (!Array.isArray(dns) || !dns.length || dns.some(row => row.family !== 4 || row.address !== c.vpn.address)) fail('EDGE_DNS_INVALID');
  const bundle = resolve(bundlePath), render = renderEdge(c);
  const expected = { 'kong.json': JSON.stringify(render.kong, null, 2) + '\n',
    'kong.conf': render.kongConf, 'compose.yml': render.compose, 'firewall.nft': render.firewall };
  for (const [name, value] of Object.entries(expected)) {
    if (io.read(resolve(bundle, name), 256 * 1024).toString('utf8') !== value) fail('EDGE_RENDER_MISMATCH');
  }
  const names = ['edge-cert.pem', 'edge-key.pem', 'edge-server-ca.pem', 'edge-client-ca.pem',
    'edge-client.crl.pem', 'upstream-ca.pem', 'kong-client-cert.pem', 'kong-client-key.pem'];
  const material = Object.fromEntries(names.map(name => [name,
    io.read(resolve(bundle, 'tls', name), 128 * 1024, name.includes('-key.'))]));
  validateTlsMaterial(material, c, io.now());
  const tlsPath = name => resolve(bundle, 'tls', name);
  if ((material['edge-client.crl.pem'].toString().match(/-----BEGIN X509 CRL-----/g) ?? []).length !== 1) fail('EDGE_CRL_INVALID');
  io.openssl(['verify', '-auth_level', '2', '-CAfile', tlsPath('edge-server-ca.pem'), '-purpose', 'sslserver',
    '-verify_hostname', c.vpn.privateDnsName, tlsPath('edge-cert.pem')]);
  io.openssl(['verify', '-auth_level', '2', '-CAfile', tlsPath('upstream-ca.pem'), '-purpose', 'sslclient', tlsPath('kong-client-cert.pem')]);
  io.openssl(['crl', '-in', tlsPath('edge-client.crl.pem'), '-verify', '-CAfile', tlsPath('edge-client-ca.pem'), '-noout']);
  validateCrlTimes(io.openssl(['crl', '-in', tlsPath('edge-client.crl.pem'), '-noout', '-lastupdate', '-nextupdate']), io.now());
  for (const [owner, port] of Object.entries(c.upstreamPorts)) await io.handshake(port, material, upstreamTlsNames[owner]);
  // TLS-only read proves neither application peer authorization nor firewall/VPN peer policy.
  return { status: 'PRECHECK_PASSED_NOT_ACTIVATED', environment: 'BETA', automaticActivation: false,
    checks: ['LINUX', 'WIREGUARD_ADDRESS', 'PRIVATE_DNS', 'EXACT_RENDER', 'TLS_KEYS_AND_PURPOSES', 'FRESH_SIGNED_CRL', 'LOOPBACK_UPSTREAM_TLS'],
    pending: ['TI_FIREWALL_AND_VPN_PEER_APPROVAL', 'APPLICATION_MTLS_PEER_ALLOWLIST', 'CLIENT_GRANTS', 'DATA_PILOT_PHASE8'] };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 7 || process.argv[2] !== '--config' || process.argv[4] !== '--bundle' || process.argv[6] !== '--read-only') fail('INVALID_PREFLIGHT_INVOCATION');
    const input = JSON.parse(safeFile(process.argv[3], 16384).toString('utf8'));
    process.stdout.write(JSON.stringify(await preflightEdge(input, process.argv[5])) + '\n');
  } catch (error) {
    const allowed = ['EDGE_LINUX_HOST_REQUIRED', 'EDGE_DEPLOYMENT_INVALID', 'EDGE_VPN_INTERFACE_INVALID', 'EDGE_DNS_INVALID', 'EDGE_FILE_INVALID',
      'EDGE_RENDER_MISMATCH', 'EDGE_TLS_INVALID', 'EDGE_TLS_EXPIRED', 'EDGE_CRL_INVALID', 'EDGE_TLS_TOOL_CHECK_FAILED', 'EDGE_UPSTREAM_TLS_INVALID'];
    process.stderr.write(JSON.stringify({ status: 'BLOCKED_NOT_ACTIVATED', code: allowed.includes(error.message) ? error.message : 'EDGE_PREFLIGHT_FAILED' }) + '\n');
    process.exitCode = 1;
  }
}
