import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer as netServer } from 'node:net';
import { createServer as httpsServer, request } from 'node:https';
import { createRequire } from 'node:module';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, realpathSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { X509Certificate } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import { validateWindowsEdge, renderWindowsEdge, prepareWindowsBundle, checkWindowsBundle } from '../infra/integration/windows-edge.mjs';
import { allowedPeer, createWindowsRelay, verifyWindowsNetwork } from '../infra/integration/windows-relay.mjs';
import { windowsOperationPlan } from '../infra/integration/windows-operation.mjs';
const fixture = () => JSON.parse(readFileSync(resolve('infra/integration/windows-edge.example.json'), 'utf8'));
const failure = 'INVALID_WINDOWS_EDGE_CONFIG';
function disposeFixture(root: string) {
  expect(lstatSync(root).isSymbolicLink()).toBe(false);
  const absolute = realpathSync(root), inside = relative(realpathSync(tmpdir()), absolute);
  expect(isAbsolute(inside) || inside.startsWith('..') || !/^factuez-i8-(bundle|links|operation)-[a-zA-Z0-9_-]+$/.test(inside)).toBe(false);
  rmSync(absolute, { recursive: true });
}
describe('Windows distinct candidate, never weaken phase7', () => {
  it('requires an exact BETA-only schema', () => {
    expect(validateWindowsEdge(fixture())).toEqual(fixture());
    for (const change of [{ environment: 'PRODUCTION' }, { deployment: 'PUBLIC' }, { schemaVersion: 'other' }, { tls: false }])
      expect(() => validateWindowsEdge({ ...fixture(), ...change })).toThrow(failure);
    for (const key of Object.keys(fixture())) { const c = fixture(); delete c[key]; expect(() => validateWindowsEdge(c)).toThrow(failure); }
  });
  it.each(['0.0.0.0', '127.0.0.1', '8.8.8.8', '::1', '::', '169.254.0.1'])('rejects native ingress %s', address => {
    const c = fixture(); c.vpn.address = address; expect(() => validateWindowsEdge(c)).toThrow(failure);
  });
  it.each([0, 443, 65536, 9443, 3108, 3112, 1.1, '19443', null])('rejects loopback port %s', port => {
    expect(() => validateWindowsEdge({ ...fixture(), kongLoopbackPort: port })).toThrow(failure);
  });
  it.each(['maxConnections', 'maxPerPeer', 'newConnectionsPerMinute', 'idleTimeoutMs', 'maxLifetimeMs'])('bounds %s', key => {
    for (const value of [0, -1, 99999999, 1.1, '1', null]) { const c = fixture(); c.relay[key] = value; expect(() => validateWindowsEdge(c)).toThrow(failure); }
  });
  it('rejects injected fields, commands, destinations and broad networks', () => {
    for (const [key, value] of [['interface', "wg';Start-Process calc"], ['privateDnsName', 'localhost'], ['clientCidrs', ['0.0.0.0/0']]] as [string, unknown][]) {
      const c = fixture(); c.vpn[key] = value; expect(() => validateWindowsEdge(c)).toThrow(failure);
    }
    const c = fixture(); c.relay.destination = 'remote'; expect(() => validateWindowsEdge(c)).toThrow(failure);
  });
  it('preserves all seventeen routes, peer TLS, CRL and no forwarded-header trust', () => {
    const r = renderWindowsEdge(fixture()), conf = r['kong.conf'];
    expect(JSON.parse(r['kong.json']).services.flatMap((s: any) => s.routes)).toHaveLength(17);
    for (const line of ['proxy_listen = 127.0.0.1:19443 ssl', 'nginx_proxy_allow = 127.0.0.1', 'nginx_proxy_deny = all',
      'trusted_ips =', 'real_ip_recursive = off', 'nginx_proxy_ssl_verify_client = on', 'nginx_proxy_proxy_ssl_verify = on',
      'nginx_proxy_ssl_crl = /run/factuez-edge/tls/edge-client.crl.pem', 'admin_listen = off', 'status_listen = off']) expect(conf).toContain(line + '\n');
    expect(conf).not.toContain('proxy_listen = 0.0.0.0');
    expect(r['compose.yml']).toContain('network_mode: host'); expect(r['compose.yml']).not.toMatch(/^\s+ports:/m);
    expect(r['compose.yml']).toContain('restart: "no"'); expect(r['OPERATOR.md']).toContain('cuota HTTP agregada');
  });
  it('never overwrites a bundle; exact regeneration detects any changed route or script', () => {
    const root = mkdtempSync(join(tmpdir(), 'factuez-i8-bundle-'));
    try {
      const source = join(root, 'config.json'), bundle = join(root, 'bundle'); writeFileSync(source, JSON.stringify(fixture()));
      expect(prepareWindowsBundle(source, bundle).automaticActivation).toBe(false); expect(checkWindowsBundle(bundle)).toEqual(fixture());
      expect(() => prepareWindowsBundle(source, bundle)).toThrow();
      writeFileSync(join(bundle, 'kong.conf'), renderWindowsEdge(fixture())['kong.conf'] + 'admin_listen = on\n');
      expect(() => checkWindowsBundle(bundle)).toThrow('WINDOWS_EDGE_RENDER_MISMATCH');
    } finally { disposeFixture(root); }
  });
  it('rejects symlinked configuration instead of following a destination outside the bundle', () => {
    const root = mkdtempSync(join(tmpdir(), 'factuez-i8-links-'));
    try {
      const directory = join(root, 'actual'); prepareWindowsBundle(resolve('infra/integration/windows-edge.example.json'), directory);
      const link = join(root, 'link'); symlinkSync(directory, link, 'junction'); expect(() => checkWindowsBundle(link)).toThrow('WINDOWS_EDGE_FILE_INVALID');
    } finally { disposeFixture(root); }
  });
  it('operation plans target ONLY private Kong, local Desktop, no-deps and no implicit .env', () => {
    const root = mkdtempSync(join(tmpdir(), 'factuez-i8-operation-'));
    try {
      const bundle = join(root, 'bundle'); prepareWindowsBundle(resolve('infra/integration/windows-edge.example.json'), bundle);
      const start = windowsOperationPlan(bundle, 'START'), stop = windowsOperationPlan(bundle, 'STOP');
      expect(start.status).toBe('PLAN_ONLY_NOT_EXECUTED'); expect(start.command.args.slice(-7)).toEqual(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'kong-private']);
      expect(start.command.args.slice(0, 2)).toEqual(['--context', 'desktop-linux']); expect(start.command.args).toContain('--env-file');
      expect(stop.command.args.slice(-2)).toEqual(['stop', 'kong-private']);
      expect(start.command.args).not.toContain('down'); expect(stop.deletesData).toBe(false); expect(() => windowsOperationPlan(bundle, 'RESTART_ALL')).toThrow();
    } finally { disposeFixture(root); }
  });
});
describe('Native WireGuard metadata precheck, no adaptation through flags', () => {
  const metadata = () => ({ platform: () => 'win32', interfaces: () => ({ 'wg-factuez': [{ address: '10.44.0.1', internal: false }] }),
    adapter: () => ({ wireguard: true, up: true }), dns: () => [{ address: '10.44.0.1', family: 4 }] });
  it('passes only explicit Windows native interface and exact DNS', async () => {
    expect((await verifyWindowsNetwork(fixture(), metadata())).automaticActivation).toBe(false);
  });
  it.each(['linux', 'darwin'])('rejects %s', async platform => {
    await expect(verifyWindowsNetwork(fixture(), { ...metadata(), platform: () => platform })).rejects.toThrow('WINDOWS_NATIVE_HOST_REQUIRED');
  });
  it.each([{}, { 'wg-factuez': [{ address: '10.44.0.2', internal: false }] }, { 'wg-factuez': [{ address: '10.44.0.1', internal: true }] }])('rejects address mismatch %j', interfaces => {
    return expect(verifyWindowsNetwork(fixture(), { ...metadata(), interfaces: () => interfaces })).rejects.toThrow('WINDOWS_VPN_ADDRESS_INVALID');
  });
  it.each([{ wireguard: false, up: true }, { wireguard: true, up: false }, { wireguard: true, up: true, arbitrary: true }])('rejects non-WG/down %j', adapter => {
    return expect(verifyWindowsNetwork(fixture(), { ...metadata(), adapter: () => adapter })).rejects.toThrow('WINDOWS_WIREGUARD_REQUIRED');
  });
  it.each([[], [{ address: '8.8.8.8', family: 4 }], [{ address: '10.44.0.1', family: 4 }, { address: '::1', family: 6 }]].map(dns => ({ dns })))('rejects non-private DNS $dns', ({ dns }) => {
    return expect(verifyWindowsNetwork(fixture(), { ...metadata(), dns: () => dns })).rejects.toThrow('WINDOWS_PRIVATE_DNS_INVALID');
  });
});
class Socket extends EventEmitter {
  remoteAddress = '10.44.0.2'; localAddress = '10.44.0.1'; destroyed = false; pipes: any[] = [];
  pause() {} resume() {} setNoDelay() {} setTimeout(_ms: number, _fn: any) {} pipe(other: any) { this.pipes.push(other); return other; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } return this; }
}
function harness(c = fixture()) {
  let accept: any; const targets: any[] = [], upstreams: Socket[] = [];
  const server: any = Object.assign(new EventEmitter(), { listening: false, listen(options: any, done: any) {
    targets.push(options); server.listening = true; done(); }, close(done: any) { server.listening = false; done(); } });
  let now = 0;
  const relay = createWindowsRelay(c, { server: (_opts: any, callback: any) => { accept = callback; return server; },
    now: () => now, connect: (target: any) => { targets.push(target); const socket = new Socket(); upstreams.push(socket); return socket; } });
  return { relay, targets, upstreams, accept: (ip = '10.44.0.2', local = '10.44.0.1') => {
    const socket = new Socket(); socket.remoteAddress = ip; socket.localAddress = local; accept(socket); return socket;
  }, time: (n: number) => { now = n; } };
}
describe('Opaque relay admission and lifecycle', () => {
  it.each(['127.0.0.1', '::ffff:10.44.0.2', '8.8.8.8', '10.44.0.3', '', undefined])('does not authorize %s', ip => {
    expect(allowedPeer(ip, fixture().vpn.clientCidrs)).toBe(false);
  });
  it('binds exclusively the native VPN IP and targets exclusively loopback', async () => {
    const h = harness(); await h.relay.start(); const client = h.accept();
    expect(h.targets[0]).toMatchObject({ host: '10.44.0.1', port: 9443, exclusive: true });
    expect(h.targets[1]).toEqual({ host: '127.0.0.1', port: 19443 });
    h.upstreams[0].emit('connect'); expect(client.pipes).toEqual([h.upstreams[0]]); expect(h.upstreams[0].pipes).toEqual([client]);
    await h.relay.stop(); expect(h.relay.metadata().activeConnections).toBe(0);
  });
  it('rejects CIDR/local-address mismatch before upstream connection', async () => {
    const h = harness(); const one = h.accept('10.44.0.3'), two = h.accept('10.44.0.2', '127.0.0.1');
    expect(one.destroyed && two.destroyed).toBe(true); expect(h.upstreams).toHaveLength(0); await h.relay.stop();
  });
  it('enforces per-peer concurrent limits and releases on disconnect', async () => {
    const c = fixture(); c.relay.maxPerPeer = 1; const h = harness(c), first = h.accept();
    expect(h.accept().destroyed).toBe(true); first.destroy(); expect(h.accept().destroyed).toBe(false); await h.relay.stop();
  });
  it('enforces aggregate limits independently of peer IP', async () => {
    const c = fixture(); c.relay.maxConnections = 1; c.relay.maxPerPeer = 1; c.vpn.clientCidrs = ['10.44.0.0/24'];
    const h = harness(c); h.accept(); expect(h.accept('10.44.0.3').destroyed).toBe(true); await h.relay.stop();
  });
  it('connection rate persists after disconnect; bounded window recovers', async () => {
    const c = fixture(); c.relay.newConnectionsPerMinute = 1; const h = harness(c); h.accept().destroy();
    expect(h.accept().destroyed).toBe(true); h.time(60001); expect(h.accept().destroyed).toBe(false); await h.relay.stop();
  });
  it('owner error closes both sockets with no retry/fallback', async () => {
    const h = harness(), client = h.accept(); h.upstreams[0].emit('error', new Error('fictitious failure'));
    expect(client.destroyed && h.upstreams[0].destroyed).toBe(true); expect(h.relay.metadata().activeConnections).toBe(0);
    expect(h.upstreams).toHaveLength(1); await h.relay.stop();
  });
  it('stopping destroys active connections and denies subsequent connections', async () => {
    const h = harness(); await h.relay.start(); const client = h.accept(); await h.relay.stop();
    expect(client.destroyed).toBe(true); expect(h.accept().destroyed).toBe(true);
  });
  it('preserves mTLS client identity through real loopback TCP; no key is provided to the relay', async () => {
    const forge = createRequire(resolve('packages/evidence-core/package.json'))('node-forge'), pki = forge.pki;
    const rootPair = pki.rsa.generateKeyPair(2048), root = pki.createCertificate(); root.publicKey = rootPair.publicKey; root.serialNumber = '01';
    root.validity.notBefore = new Date(Date.now() - 60000); root.validity.notAfter = new Date(Date.now() + 3600000);
    root.setSubject([{ name: 'commonName', value: 'SYNTHETIC TCP TEST' }]); root.setIssuer(root.subject.attributes);
    root.setExtensions([{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true }]); root.sign(rootPair.privateKey, forge.md.sha256.create());
    const leaf = (serial: string, server: boolean) => {
      const pair = pki.rsa.generateKeyPair(2048), cert = pki.createCertificate(); cert.publicKey = pair.publicKey; cert.serialNumber = serial;
      cert.validity = root.validity; cert.setSubject([{ name: 'commonName', value: 'SYNTHETIC LEAF' }]); cert.setIssuer(root.subject.attributes);
      cert.setExtensions([{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: server, clientAuth: !server }, ...(server ? [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] }] : [])]);
      cert.sign(rootPair.privateKey, forge.md.sha256.create()); return { cert: pki.certificateToPem(cert), key: pki.privateKeyToPem(pair.privateKey) };
    };
    const serverTls = leaf('02', true), clientTls = leaf('03', false), ca = pki.certificateToPem(root);
    const expected = new X509Certificate(clientTls.cert).fingerprint256; let received = 0;
    const owner = httpsServer({ ...serverTls, ca, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' }, (req, res) => {
      received++; res.end(JSON.stringify({ fingerprint: (req.socket as TLSSocket).getPeerCertificate().fingerprint256 }));
    });
    await new Promise<void>(done => owner.listen(0, '127.0.0.1', done));
    const c = fixture(); c.kongLoopbackPort = (owner.address() as any).port;
    // Fixture-only address mapper: this is a TCP/TLS test, NOT a real WireGuard pilot.
    const relay = createWindowsRelay(c, { server: (options: any, callback: any) => {
      const server = netServer(options, socket => { Object.defineProperty(socket, 'localAddress', { value: c.vpn.address });
        Object.defineProperty(socket, 'remoteAddress', { value: '10.44.0.2' }); callback(socket); });
      const listen = server.listen.bind(server); (server as any).listen = (_opts: any, done: any) => listen(0, '127.0.0.1', done); return server;
    } });
    try {
      await relay.start(); const port = (relay.server.address() as any).port;
      const call = (cert: boolean) => new Promise<string>((done, reject) => {
        const req = request({ hostname: '127.0.0.1', servername: 'localhost', port, ca, ...(cert ? clientTls : {}), agent: false, timeout: 2000 }, res => {
          const chunks: Buffer[] = []; res.on('data', b => chunks.push(b)); res.on('end', () => done(Buffer.concat(chunks).toString()));
        }); req.on('error', reject); req.on('timeout', () => req.destroy(new Error('TIMEOUT'))); req.end();
      });
      expect(JSON.parse(await call(true)).fingerprint).toBe(expected); await expect(call(false)).rejects.toThrow(); expect(received).toBe(1);
    } finally { await relay.stop(); owner.closeAllConnections(); await new Promise<void>(done => owner.close(() => done())); }
  }, 15000);
});
