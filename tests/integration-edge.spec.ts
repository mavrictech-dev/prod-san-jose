import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
// A pure renderer only: these tests never activate infrastructure or read TLS.
import { validateEdgeConfig, renderEdge } from '../infra/integration/private-edge.mjs';

function config() {
  return { schemaVersion: 'factuez.private-edge.v1', environment: 'BETA', deployment: 'LINUX_HOST_LOOPBACK',
    vpn: { interface: 'wg-factuez', address: '10.44.0.1', clientCidrs: ['10.44.0.0/24'], privateDnsName: 'api.factuez.test' },
    listenPort: 9443, upstreamPorts: { identity: 3108, read: 3112 },
    rateLimits: { tokenPerMinute: 20, readPerMinute: 120, exportPerMinute: 4, changesPerMinute: 30 } };
}
type Config = ReturnType<typeof config>;
const validId = '00000000-0000-4000-8000-000000000001';
const contract = JSON.parse(readFileSync(new URL('../api-contracts/integration/private-api.openapi.v1.json', import.meta.url), 'utf8'));
const operations = Object.entries(contract.paths).flatMap(([path, value]: [string, any]) =>
  ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'].filter(method => value[method]).map(method => ({
    method: method.toUpperCase(), path: path.replace(/\{[^}]+\}/g, validId) })));
const directives = (contents: string) => new Map(contents.split('\n').filter((line: string) => line.trim() && !line.startsWith('#'))
  .map((line: string) => { const index = line.indexOf('='); return [line.slice(0, index).trim(), line.slice(index + 1).trim()]; }));
// Kong's compatible router adds ^ itself; its schema only accepts ~/ regexes.
const matching = (route: any, path: string) => route.paths.some((pattern: string) => pattern.startsWith('~/') && new RegExp('^' + pattern.slice(1)).test(path));

describe('Phase7 strict private-edge candidate configuration', () => {
  it('accepts the supplied private Linux/BETA profile without mutation', () => {
    const c = config(), before = structuredClone(c); expect(validateEdgeConfig(c)).toEqual(c);
    expect(renderEdge(c)).toHaveProperty('kong'); expect(c).toEqual(before);
    const validated = validateEdgeConfig(c); validated.vpn.address = '10.44.0.2'; expect(c.vpn.address).toBe('10.44.0.1');
  });
  it.each([null, undefined, [], 'BETA', 1])('rejects non-object root %s', input => expect(() => validateEdgeConfig(input)).toThrow('INVALID_PRIVATE_EDGE_CONFIG'));
  it.each(['schemaVersion', 'environment', 'deployment', 'vpn', 'listenPort', 'upstreamPorts', 'rateLimits'])('rejects missing %s', key => {
    const c: any = config(); delete c[key]; expect(() => validateEdgeConfig(c)).toThrow('INVALID_PRIVATE_EDGE_CONFIG');
  });
  it.each(['certificate', 'credentials', 'tenantId', 'publicPort', 'allowProduction', 'tlsVerify'])('rejects extra root %s', key => {
    expect(() => validateEdgeConfig({ ...config(), [key]: 'unsafe' })).toThrow('INVALID_PRIVATE_EDGE_CONFIG');
  });
  it.each(['PRODUCTION', 'production', 'beta', '', null])('rejects environment %s', value => {
    expect(() => validateEdgeConfig({ ...config(), environment: value })).toThrow('INVALID_PRIVATE_EDGE_CONFIG');
  });
  it.each(['WINDOWS_HOST', 'DOCKER_DESKTOP', 'PUBLIC', 'LINUX_BRIDGE', '', null])('rejects deployment %s', value => {
    expect(() => validateEdgeConfig({ ...config(), deployment: value })).toThrow('INVALID_PRIVATE_EDGE_CONFIG');
  });
  it.each(['0.0.0.0', '127.0.0.1', '8.8.8.8', '169.254.0.1', '224.1.1.1', '::1', '::', '10.44.0.1; deny all', '10.44.0.01'])('rejects bind address %s', address => {
    const c = config(); c.vpn.address = address; expect(() => validateEdgeConfig(c)).toThrow('INVALID_PRIVATE_EDGE_CONFIG');
  });
  it.each(['wg;allow', 'wg facts', '../wg0', 'wg0\nadmin_listen=on', '0123', 'w'.repeat(16)])('rejects interface injection %s', iface => {
    const c = config(); c.vpn.interface = iface; expect(() => validateEdgeConfig(c)).toThrow('INVALID_PRIVATE_EDGE_CONFIG');
  });
  it.each(['localhost', '127.0.0.1', '*.factuez.test', 'https://api.factuez.test', 'api.factuez.test:9443', 'api.factuez.test\nadmin_listen=on', '-api.factuez.test'])('rejects DNS %s', name => {
    const c = config(); c.vpn.privateDnsName = name; expect(() => validateEdgeConfig(c)).toThrow('INVALID_PRIVATE_EDGE_CONFIG');
  });
  it.each([[], ['0.0.0.0/0'], ['10.0.0.0/8'], ['10.44.0.1/24'], ['10.44.0.0/24', '10.44.0.0/24'],
    ['8.8.8.0/24'], ['10.44.0.0/24;allow all'], ['10.44.0.0/33'], Array.from({ length: 17 }, (_, n) => '10.44.' + n + '.0/24')])('rejects unsafe client CIDRs %s', cidrs => {
    const c = config(); c.vpn.clientCidrs = cidrs; expect(() => validateEdgeConfig(c)).toThrow('INVALID_PRIVATE_EDGE_CONFIG');
  });
  it.each(['10.44.0.0', '10.44.0.255'])('rejects bind network/broadcast %s', address => {
    const c = config(); c.vpn.address = address; expect(() => validateEdgeConfig(c)).toThrow('INVALID_PRIVATE_EDGE_CONFIG');
  });
  it('accepts a narrow private /32 synthetic client range', () => {
    const c = config(); c.vpn.clientCidrs = [c.vpn.address + '/32']; expect(() => validateEdgeConfig(c)).not.toThrow();
  });
  it.each([0, 80, 443, 1023, 65536, 1.2, '9443', null])('rejects unsafe listen port %s', port => {
    expect(() => validateEdgeConfig({ ...config(), listenPort: port })).toThrow('INVALID_PRIVATE_EDGE_CONFIG');
  });
  it.each(['identity', 'read'])('rejects unsafe or duplicate upstream %s', key => {
    for (const port of [80, 0, 65536, 1.2, 9443]) {
      const c = config(); c.upstreamPorts[key as keyof Config['upstreamPorts']] = port;
      expect(() => validateEdgeConfig(c)).toThrow('INVALID_PRIVATE_EDGE_CONFIG');
    }
    expect(() => validateEdgeConfig({ ...config(), upstreamPorts: { identity: 3108, read: 3108 } })).toThrow();
  });
  it.each([['vpn', 'public'], ['upstreamPorts', 'host'], ['rateLimits', 'policy']])('rejects extra nested %s.%s', (section, key) => {
    const c: any = config(); c[section][key] = 'unsafe'; expect(() => validateEdgeConfig(c)).toThrow('INVALID_PRIVATE_EDGE_CONFIG');
  });
  it.each([['tokenPerMinute', 61], ['readPerMinute', 601], ['exportPerMinute', 11], ['changesPerMinute', 121]])('bounds %s', (key, maximum) => {
    for (const value of [0, -1, maximum, 1.5, '1', null]) {
      const c: any = config(); c.rateLimits[key] = value; expect(() => validateEdgeConfig(c)).toThrow('INVALID_PRIVATE_EDGE_CONFIG');
    }
  });
});

describe('Phase7 public-route and deployment boundary independent of renderer inventory', () => {
  const c = config(), rendered = renderEdge(c), routes = rendered.kong.services.flatMap((service: any) => service.routes), conf = directives(rendered.kongConf);
  it('is exactly seventeen OpenAPI operations, not a broad prefix/fallback proxy', () => {
    expect(operations).toHaveLength(17); expect(routes).toHaveLength(17);
    expect(new Set(routes.map((r: any) => r.name)).size).toBe(17);
    for (const op of operations) {
      const found = routes.filter((r: any) => r.methods.includes(op.method) && matching(r, op.path)); expect(found).toHaveLength(1);
      expect(found[0].protocols).toEqual(['https']); expect(found[0].hosts).toEqual([c.vpn.privateDnsName]); expect(found[0].snis).toEqual([c.vpn.privateDnsName]);
      expect(found[0].strip_path).toBe(false); expect(found[0].preserve_host).toBe(false);
    }
  });
  it('uses the pinned Kong schema and rejects leading or trailing additions for every operation', () => {
    for (const route of routes) for (const pattern of route.paths) {
      expect(pattern.startsWith('~/')).toBe(true); expect(pattern.endsWith('$')).toBe(true);
      expect(pattern.startsWith('~^')).toBe(false);
    }
    for (const op of operations) for (const path of ['/prefix' + op.path, op.path + '/extra', op.path + '/']) {
      expect(routes.filter((r: any) => r.methods.includes(op.method) && matching(r, path))).toHaveLength(0);
    }
  });
  it.each(operations)('matches only $method $path', op => {
    const match = routes.filter((r: any) => r.methods.includes(op.method) && matching(r, op.path)); expect(match).toHaveLength(1);
    for (const other of ['PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) expect(routes.filter((r: any) => r.methods.includes(other) && matching(r, op.path))).toHaveLength(0);
  });
  it.each(['/', '/login', '/stations', '/api/auth/login', '/api/documents', '/internal/integration/documents', '/integration/clients',
    '/integration/oauth/introspect', '/admin', '/config', '/services', '/status', '/integration/v1/unknown',
    '/integration/v1/documents/not-a-uuid', '/integration/v1/documents/' + validId + '/extra', '/integration/v1/documents/'])('does not expose %s', path => {
    expect(routes.filter((r: any) => matching(r, path))).toHaveLength(0);
  });
  it('maps OAuth exclusively to the identity loopback and all reads/exports to read loopback', () => {
    expect(rendered.kong.services).toHaveLength(2);
    for (const s of rendered.kong.services) {
      expect(s.protocol).toBe('https'); expect(s.host).toBe(s.name + '-loopback'); expect(s.tls_verify).toBe(true); expect(s.tls_verify_depth).toBeGreaterThan(0);
      expect(s.retries).toBe(0);
      expect(s.port).toBe(s.routes.length === 1 ? c.upstreamPorts.identity : c.upstreamPorts.read);
      const upstream = rendered.kong.upstreams.find((u: any) => u.name === s.host);
      expect(upstream.targets).toEqual([{ target: '127.0.0.1:' + s.port, weight: 100 }]);
      expect(upstream.host_header).toBe(s.routes.length === 1 ? 'identity.factuez.internal' : 'read.factuez.internal');
    }
  });
  it('requires inbound mTLS, a fresh configured CRL and trusted outbound TLS', () => {
    expect(conf.get('nginx_proxy_ssl_verify_client')).toBe('on'); expect(conf.get('nginx_proxy_ssl_verify_depth')).toBe('3');
    expect(conf.get('nginx_proxy_ssl_client_certificate')).toBe('/run/factuez-edge/tls/edge-client-ca.pem');
    expect(conf.get('nginx_proxy_ssl_crl')).toBe('/run/factuez-edge/tls/edge-client.crl.pem');
    expect(conf.get('client_ssl')).toBe('on'); expect(conf.get('client_ssl_cert')).toBe('/run/factuez-edge/tls/kong-client-cert.pem');
    expect(conf.get('client_ssl_cert_key')).toBe('/run/factuez-edge/tls/kong-client-key.pem');
    expect(conf.get('nginx_proxy_proxy_ssl_trusted_certificate')).toBe('/run/factuez-edge/tls/upstream-ca.pem');
    expect(conf.get('nginx_proxy_proxy_ssl_verify')).toBe('on'); expect(conf.get('nginx_proxy_proxy_ssl_verify_depth')).toBe('3');
    expect(conf.get('ssl_protocols')).toBe('TLSv1.2 TLSv1.3'); expect(conf.get('trusted_ips')).toBe(''); expect(conf.get('real_ip_recursive')).toBe('off');
  });
  it('closes every non-proxy listener and avoids identifying/debug/access logs', () => {
    expect(conf.get('proxy_listen')).toBe('10.44.0.1:9443 ssl');
    for (const name of ['admin_listen', 'admin_gui_listen', 'status_listen', 'stream_listen', 'debug_listen', 'anonymous_reports',
      'allow_debug_header', 'headers', 'proxy_access_log', 'admin_access_log']) expect(conf.get(name)).toBe('off');
    expect(conf.get('database')).toBe('off'); expect(conf.get('nginx_proxy_deny')).toBe('all'); expect(conf.get('nginx_proxy_allow')).toBe('10.44.0.0/24');
  });
  it('selects a router flavor accepted by the pinned Kong 3.9.3 build', () => {
    expect(['traditional', 'traditional_compatible', 'expressions']).toContain(conf.get('router_flavor'));
  });
  it('uses bounded body, time, connection and exact route/IP rate limits', () => {
    expect(conf.get('nginx_proxy_client_max_body_size')).toBe('16k'); expect(conf.get('nginx_proxy_client_body_timeout')).toBe('10s');
    expect(conf.get('nginx_proxy_limit_conn')).toBe('private_edge_connections 16');
    for (const route of routes) {
      const bodies = route.plugins.filter((p: any) => p.name === 'request-size-limiting');
      expect(bodies).toHaveLength(route.methods[0] === 'POST' ? 1 : 0);
      if (bodies.length) expect(bodies[0].config).toEqual({ allowed_payload_size: 16, size_unit: 'kilobytes', require_content_length: true });
      const rate = route.plugins.find((p: any) => p.name === 'rate-limiting');
      const expected = matching(route, '/integration/oauth/token') ? 20 : route.methods[0] === 'POST' ? 4 : matching(route, '/integration/v1/changes') ? 30 : 120;
      expect(rate.config).toMatchObject({ minute: expected, policy: 'local', limit_by: 'ip', fault_tolerant: false, hide_client_headers: false });
    }
  });
  it('can permit several explicit private ranges without injecting directives', () => {
    const multiple = config(); multiple.vpn.clientCidrs.push('10.45.0.0/24');
    const conf = directives(renderEdge(multiple).kongConf); expect(conf.get('nginx_proxy_allow')).toBe('10.44.0.0/24; allow 10.45.0.0/24');
  });
  it('renders an opt-in standalone Linux host-network container, not the QA/intranet gateway', () => {
    expect(rendered.compose).toContain('profiles: [private-edge-beta]'); expect(rendered.compose).toContain('network_mode: host');
    expect(rendered.compose).toContain('read_only: true'); expect(rendered.compose).toContain('cap_drop: [ALL]');
    expect(rendered.compose).toContain('no-new-privileges:true'); expect(rendered.compose).toContain('driver: "none"');
    expect(rendered.compose).toContain('KONG_PREFIX: /tmp/kong');
    expect(conf.get('nginx_worker_processes')).toBe('1'); expect(conf.get('mem_cache_size')).toBe('64m');
    expect(rendered.compose).not.toMatch(/^\s*(ports|depends_on|env_file|privileged|build):/m);
    expect(rendered.compose).not.toContain('docker.sock'); expect(rendered.compose).not.toContain('factuez-stage2-qa');
    expect(rendered.compose.split('\n').filter((line: string) => !line.trim().startsWith('#')).join('\n')).not.toMatch(/certificates-volume|postgres|redis|production/i);
  });
  it('renders only address/port-specific firewall drops without flushing existing rules', () => {
    expect(rendered.firewall).toContain('ip daddr 10.44.0.1 tcp dport 9443 iifname != "wg-factuez" drop');
    expect(rendered.firewall).toContain('ip saddr != { 10.44.0.0/24 } drop'); expect(rendered.firewall).toContain('policy accept');
    expect(rendered.firewall.split('\n').filter((line: string) => !line.trim().startsWith('#')).join('\n')).not.toMatch(/flush|policy drop|0\.0\.0\.0|0\/0/);
    expect(rendered.firewall).not.toContain('8091');
  });
});
