/** Phase 7: pure deployment renderer. No sockets, Docker, secrets, DDL or activation. */
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { readFileSync, mkdirSync, writeFileSync, lstatSync } from 'node:fs';
const version = 'factuez.private-edge.v1', root = '/run/factuez-edge';
// Private TLS identities, not DNS-resolved destinations. Targets remain 127.0.0.1.
export const upstreamTlsNames = Object.freeze({ identity: 'identity.factuez.internal', read: 'read.factuez.internal' });
const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
const invalid = () => { throw new Error('INVALID_PRIVATE_EDGE_CONFIG'); };
function object(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) invalid();
}
function number(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid();
}
function ipv4(value) {
  if (typeof value !== 'string' || isIP(value) !== 4) invalid();
  const bytes = value.split('.').map(Number);
  if (!(bytes[0] === 10 || bytes[0] === 172 && bytes[1] >= 16 && bytes[1] <= 31 || bytes[0] === 192 && bytes[1] === 168)) invalid();
  return bytes.reduce((n, byte) => n * 256 + byte, 0);
}
export function validateEdgeConfig(input) {
  object(input, ['schemaVersion', 'environment', 'deployment', 'vpn', 'listenPort', 'upstreamPorts', 'rateLimits']);
  if (input.schemaVersion !== version || input.environment !== 'BETA' || input.deployment !== 'LINUX_HOST_LOOPBACK') invalid();
  object(input.vpn, ['interface', 'address', 'clientCidrs', 'privateDnsName']);
  if (typeof input.vpn.interface !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,14}$/.test(input.vpn.interface)) invalid();
  const address = ipv4(input.vpn.address);
  if (typeof input.vpn.privateDnsName !== 'string' || input.vpn.privateDnsName.length > 253 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(input.vpn.privateDnsName)) invalid();
  const cidrs = input.vpn.clientCidrs;
  if (!Array.isArray(cidrs) || !cidrs.length || cidrs.length > 16 || new Set(cidrs).size !== cidrs.length) invalid();
  for (const cidr of cidrs) {
    if (typeof cidr !== 'string' || !/^\d+\.\d+\.\d+\.\d+\/(?:2[4-9]|3[0-2])$/.test(cidr)) invalid();
    const [ip, bits] = cidr.split('/'), network = ipv4(ip), size = 2 ** (32 - Number(bits));
    if (network % size !== 0) invalid();
    ipv4([Math.floor((network + size - 1) / 2 ** 24), Math.floor((network + size - 1) / 2 ** 16) % 256,
      Math.floor((network + size - 1) / 256) % 256, (network + size - 1) % 256].join('.'));
    if (size > 1 && (address === network || address === network + size - 1)) invalid();
  }
  number(input.listenPort, 1024, 65535);
  object(input.upstreamPorts, ['identity', 'read']);
  for (const port of Object.values(input.upstreamPorts)) number(port, 1024, 65535);
  if (new Set([input.listenPort, ...Object.values(input.upstreamPorts)]).size !== 3) invalid();
  object(input.rateLimits, ['tokenPerMinute', 'readPerMinute', 'exportPerMinute', 'changesPerMinute']);
  number(input.rateLimits.tokenPerMinute, 1, 60); number(input.rateLimits.readPerMinute, 1, 600);
  number(input.rateLimits.exportPerMinute, 1, 10); number(input.rateLimits.changesPerMinute, 1, 120);
  return structuredClone(input);
}
const rate = minute => ({ name: 'rate-limiting', config: {
  // Expose quota metadata/Retry-After so authorized clients can back off safely.
  minute, policy: 'local', limit_by: 'ip', fault_tolerant: false, hide_client_headers: false,
} });
const bodyLimit = () => ({ name: 'request-size-limiting', config: {
  allowed_payload_size: 16, size_unit: 'kilobytes', require_content_length: true,
} });
function route(config, name, method, path, minute) {
  return { name, protocols: ['https'], methods: [method], hosts: [config.vpn.privateDnsName],
    // Kong 3.9.3 requires "~/" and its compatible router adds the initial anchor.
    // Keep the final anchor: this must never become a broad prefix route.
    snis: [config.vpn.privateDnsName], paths: ['~' + path + '$'], regex_priority: 10,
    strip_path: false, preserve_host: false, path_handling: 'v0',
    request_buffering: true, response_buffering: false,
    plugins: [rate(minute), ...(method === 'POST' ? [bodyLimit()] : [])] };
}
export function renderEdge(input) {
  const c = validateEdgeConfig(input), r = c.rateLimits;
  const publicReads = [
    ['capabilities', '/integration/v1/capabilities'], ['issuers', '/integration/v1/issuers'],
    ['branches', '/integration/v1/branches'], ['points', '/integration/v1/points'],
    ['lookup', '/integration/v1/documents/lookup'], ['documents', '/integration/v1/documents'],
    ['document', '/integration/v1/documents/' + uuid], ['document-artifacts', '/integration/v1/documents/' + uuid + '/artifacts'],
    ['batch', '/integration/v1/batches/' + uuid], ['batch-artifacts', '/integration/v1/batches/' + uuid + '/artifacts'],
    ['artifact-content', '/integration/v1/artifacts/' + uuid + '/content'],
    ['export-status', '/integration/v1/exports/' + uuid], ['export-manifest', '/integration/v1/exports/' + uuid + '/manifest'],
    ['export-content', '/integration/v1/exports/' + uuid + '/content'],
  ];
  const service = (name, port, routes, timeout) => ({ name, protocol: 'https', host: name + '-loopback', port,
    connect_timeout: 3000, write_timeout: 10000, read_timeout: timeout, retries: 0,
    tls_verify: true, tls_verify_depth: 3, routes });
  const kong = { _format_version: '3.0', _transform: true, services: [
    service('private-integration-identity', c.upstreamPorts.identity,
      [route(c, 'private-token', 'POST', '/integration/oauth/token', r.tokenPerMinute)], 10000),
    service('private-integration-read', c.upstreamPorts.read, [
      ...publicReads.map(([name, path]) => route(c, 'private-' + name, 'GET', path, r.readPerMinute)),
      route(c, 'private-changes', 'GET', '/integration/v1/changes', r.changesPerMinute),
      route(c, 'private-export-create', 'POST', '/integration/v1/exports', r.exportPerMinute),
    ], 250000),
  ], upstreams: [
    { name: 'private-integration-identity-loopback', host_header: upstreamTlsNames.identity,
      targets: [{ target: '127.0.0.1:' + c.upstreamPorts.identity, weight: 100 }] },
    { name: 'private-integration-read-loopback', host_header: upstreamTlsNames.read,
      targets: [{ target: '127.0.0.1:' + c.upstreamPorts.read, weight: 100 }] },
  ] };
  const kongConf = [
    '# Generated, BETA only. Separate Kong; never merge into the intranet gateway.',
    'database = off', 'declarative_config = ' + root + '/kong.json', 'prefix = /tmp/kong',
    'proxy_listen = ' + c.vpn.address + ':' + c.listenPort + ' ssl',
    'admin_listen = off', 'admin_gui_listen = off', 'status_listen = off', 'stream_listen = off', 'debug_listen = off',
    'router_flavor = traditional_compatible', 'plugins = rate-limiting,request-size-limiting',
    'nginx_worker_processes = 1', 'mem_cache_size = 64m',
    'anonymous_reports = off', 'allow_debug_header = off', 'headers = off',
    'proxy_access_log = off', 'admin_access_log = off', 'proxy_error_log = /dev/null', 'admin_error_log = /dev/null', 'log_level = crit',
    'trusted_ips =', 'real_ip_recursive = off', 'ssl_protocols = TLSv1.2 TLSv1.3',
    'ssl_cert = ' + root + '/tls/edge-cert.pem', 'ssl_cert_key = ' + root + '/tls/edge-key.pem',
    'client_ssl = on', 'client_ssl_cert = ' + root + '/tls/kong-client-cert.pem',
    'client_ssl_cert_key = ' + root + '/tls/kong-client-key.pem',
    'lua_ssl_trusted_certificate = ' + root + '/tls/upstream-ca.pem',
    'nginx_proxy_proxy_ssl_trusted_certificate = ' + root + '/tls/upstream-ca.pem',
    // Nginx must load the CA store during configuration, before per-service TLS.
    'nginx_proxy_proxy_ssl_verify = on', 'nginx_proxy_proxy_ssl_verify_depth = 3',
    'nginx_proxy_ssl_client_certificate = ' + root + '/tls/edge-client-ca.pem',
    'nginx_proxy_ssl_verify_client = on', 'nginx_proxy_ssl_verify_depth = 3',
    'nginx_proxy_ssl_crl = ' + root + '/tls/edge-client.crl.pem',
    'nginx_proxy_client_max_body_size = 16k', 'nginx_proxy_client_header_timeout = 10s',
    'nginx_proxy_client_body_timeout = 10s',
    'nginx_http_limit_conn_zone = $binary_remote_addr zone=private_edge_connections:1m',
    'nginx_proxy_limit_conn = private_edge_connections 16', 'nginx_proxy_limit_conn_status = 429',
    'nginx_proxy_allow = ' + c.vpn.clientCidrs.join('; allow '), 'nginx_proxy_deny = all',
    '',
  ].join('\n');
  // Host network is deliberate: existing opt-in owners stay on host loopback.
  // Linux VM/native host only, NOT Docker Desktop's host-loopback semantics.
  const compose = [
    '# Candidate only. Explicit TI approval and preflight required. Linux only.',
    'name: factuez-private-edge-beta', 'services:', '  kong-private:',
    '    profiles: [private-edge-beta]',
    '    image: ${FACTUEZ_PRIVATE_KONG_IMAGE:?Use a reviewed Kong 3.9.3 digest, never latest}',
    '    network_mode: host', '    user: kong', '    read_only: true',
    '    environment:', '      KONG_PREFIX: /tmp/kong',
    '    cap_drop: [ALL]', '    security_opt: [no-new-privileges:true]',
    '    pids_limit: 128', '    mem_limit: 512m', '    cpus: 1.0', '    init: true', '    restart: "no"',
    '    command: [kong, docker-start, -c, ' + root + '/kong.conf]',
    '    volumes:', '      - type: bind',
    '        source: ${FACTUEZ_PRIVATE_EDGE_BUNDLE:?Absolute approved bundle directory}',
    '        target: ' + root, '        read_only: true',
    '    tmpfs:', '      - /tmp:rw,noexec,nosuid,size=33554432,mode=1777',
    '      - /tmp/kong:rw,noexec,nosuid,size=67108864,mode=1777',
    '    logging:', '      driver: "none"',
    '# No ports, databases, Redis, Docker socket, real fiscal volumes or dependencies.',
    '# Do not combine with any existing Compose/QA or publish a host-wide HTTP port.',
    '',
  ].join('\n');
  const firewall = [
    '# Candidate only. TI merges after reviewing existing firewall; NEVER flush rules.',
    '# Restricts only this private edge address/port. VPN provisioning is separate.',
    'table inet factuez_private_edge_beta {', '  chain input {',
    '    type filter hook input priority -10; policy accept;',
    '    ip daddr ' + c.vpn.address + ' tcp dport ' + c.listenPort + ' iifname != "' + c.vpn.interface + '" drop',
    '    ip daddr ' + c.vpn.address + ' tcp dport ' + c.listenPort + ' ip saddr != { ' + c.vpn.clientCidrs.join(', ') + ' } drop',
    '  }', '}', '',
  ].join('\n');
  return { kong, kongConf, compose, firewall };
}
function noLinks(path) {
  const absolute = resolve(path); let cursor = absolute;
  for (;;) {
    try { if (lstatSync(cursor).isSymbolicLink()) invalid(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  return absolute;
}
export function renderBundle(configPath, outputPath) {
  const input = noLinks(configPath), output = noLinks(outputPath);
  const stat = lstatSync(input);
  if (!stat.isFile() || stat.size > 16384) invalid();
  const files = renderEdge(JSON.parse(readFileSync(input, 'utf8')));
  // Fail if output exists; no overwrite, cleanup, activation or shell execution.
  mkdirSync(output, { mode: 0o700 });
  for (const [name, contents] of Object.entries({ 'kong.json': JSON.stringify(files.kong, null, 2) + '\n',
    'kong.conf': files.kongConf, 'compose.yml': files.compose, 'firewall.nft': files.firewall })) {
    writeFileSync(resolve(output, name), contents, { flag: 'wx', mode: 0o600 });
  }
  return { status: 'PREPARED_NOT_ACTIVATED', environment: 'BETA', files: 4 };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 6 || process.argv[2] !== '--config' || process.argv[4] !== '--out') invalid();
    process.stdout.write(JSON.stringify(renderBundle(process.argv[3], process.argv[5])) + '\n');
  } catch { process.stderr.write('PRIVATE_EDGE_PREPARATION_FAILED\n'); process.exitCode = 1; }
}
