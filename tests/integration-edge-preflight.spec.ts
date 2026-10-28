import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, basename } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, readdirSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { renderEdge, renderBundle } from '../infra/integration/private-edge.mjs';
import { preflightEdge, validateTlsMaterial, validateCrlTimes, validateDeploymentSettings } from '../infra/integration/private-edge-preflight.mjs';

const forge = createRequire(resolve('packages/evidence-core/package.json'))('node-forge');
const now = Date.now();
const config = { schemaVersion: 'factuez.private-edge.v1', environment: 'BETA', deployment: 'LINUX_HOST_LOOPBACK',
  vpn: { interface: 'wg-factuez', address: '10.44.0.1', clientCidrs: ['10.44.0.0/24'], privateDnsName: 'api.factuez.test' },
  listenPort: 9443, upstreamPorts: { identity: 3108, read: 3112 },
  rateLimits: { tokenPerMinute: 20, readPerMinute: 120, exportPerMinute: 4, changesPerMinute: 30 } };
let material: Record<string, Buffer>, badKey: Buffer;
beforeAll(() => {
  const pki = forge.pki, root = pki.rsa.generateKeyPair(2048), edge = pki.rsa.generateKeyPair(2048), client = pki.rsa.generateKeyPair(2048);
  const ca = pki.createCertificate(); ca.serialNumber = '01'; ca.publicKey = root.publicKey;
  ca.validity.notBefore = new Date(now - 3600000); ca.validity.notAfter = new Date(now + 7 * 86400000);
  ca.setSubject([{ name: 'commonName', value: 'FICTITIOUS PHASE7 TEST CA' }]); ca.setIssuer(ca.subject.attributes);
  ca.setExtensions([{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true }]);
  ca.sign(root.privateKey, forge.md.sha256.create());
  function leaf(serial: string, pair: any, server: boolean) {
    const cert = pki.createCertificate(); cert.serialNumber = serial; cert.publicKey = pair.publicKey; cert.validity = ca.validity;
    cert.setSubject([{ name: 'commonName', value: server ? config.vpn.privateDnsName : 'FICTITIOUS KONG CLIENT' }]); cert.setIssuer(ca.subject.attributes);
    cert.setExtensions([{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: server, clientAuth: !server },
      ...(server ? [{ name: 'subjectAltName', altNames: [{ type: 2, value: config.vpn.privateDnsName }] }] : [])]);
    cert.sign(root.privateKey, forge.md.sha256.create()); return Buffer.from(pki.certificateToPem(cert));
  }
  const caPem = Buffer.from(pki.certificateToPem(ca)); badKey = Buffer.from(pki.privateKeyToPem(root.privateKey));
  material = { 'edge-cert.pem': leaf('02', edge, true), 'edge-key.pem': Buffer.from(pki.privateKeyToPem(edge.privateKey)),
    'edge-server-ca.pem': caPem, 'edge-client-ca.pem': caPem, 'upstream-ca.pem': caPem,
    'kong-client-cert.pem': leaf('03', client, false), 'kong-client-key.pem': Buffer.from(pki.privateKeyToPem(client.privateKey)),
    'edge-client.crl.pem': Buffer.from('-----BEGIN X509 CRL-----\nFICTITIOUS TEST STUB\n-----END X509 CRL-----\n') };
});
describe('Phase7 renderer writes only a new synthetic candidate bundle', () => {
  it('produces four exact files without keys, endpoints or activation', () => {
    const folder = mkdtempSync(resolve(tmpdir(), 'factuez-edge-render-fixture-'));
    try {
      const path = resolve(folder, 'input.json'), output = resolve(folder, 'bundle'); writeFileSync(path, JSON.stringify(config));
      expect(renderBundle(path, output)).toEqual({ status: 'PREPARED_NOT_ACTIVATED', environment: 'BETA', files: 4 });
      expect(readdirSync(output).sort()).toEqual(['compose.yml', 'firewall.nft', 'kong.conf', 'kong.json']);
      expect(JSON.parse(readFileSync(resolve(output, 'kong.json'), 'utf8'))).toEqual(renderEdge(config).kong);
      expect(readFileSync(resolve(output, 'compose.yml'), 'utf8')).toEqual(renderEdge(config).compose);
      expect(existsSync(resolve(output, 'tls'))).toBe(false);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
  it('does not overwrite existing output or add files to it', () => {
    const folder = mkdtempSync(resolve(tmpdir(), 'factuez-edge-render-fixture-'));
    try {
      const path = resolve(folder, 'input.json'), output = resolve(folder, 'existing'); writeFileSync(path, JSON.stringify(config));
      mkdirSync(output); writeFileSync(resolve(output, 'preserve.txt'), 'USER OWNED');
      expect(() => renderBundle(path, output)).toThrow();
      expect(readdirSync(output)).toEqual(['preserve.txt']); expect(readFileSync(resolve(output, 'preserve.txt'), 'utf8')).toBe('USER OWNED');
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
  it('refuses invalid/production input before creating a bundle', () => {
    const folder = mkdtempSync(resolve(tmpdir(), 'factuez-edge-render-fixture-'));
    try {
      const path = resolve(folder, 'input.json'), output = resolve(folder, 'bundle');
      writeFileSync(path, JSON.stringify({ ...config, environment: 'PRODUCTION', token: 'FICTITIOUS NEVER PRINT' }));
      const run = spawnSync(process.execPath, [resolve('infra/integration/private-edge.mjs'), '--config', path, '--out', output], { encoding: 'utf8' });
      expect(run.status).toBe(1); expect(run.stdout).toBe(''); expect(run.stderr).toBe('PRIVATE_EDGE_PREPARATION_FAILED\n');
      expect(existsSync(output)).toBe(false);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
  it('rejects a linked input or output parent', () => {
    const folder = mkdtempSync(resolve(tmpdir(), 'factuez-edge-render-fixture-'));
    try {
      const path = resolve(folder, 'input.json'), link = resolve(folder, 'linked'); writeFileSync(path, JSON.stringify(config)); symlinkSync(folder, link, 'junction');
      expect(() => renderBundle(resolve(link, 'input.json'), resolve(folder, 'out'))).toThrow('INVALID_PRIVATE_EDGE_CONFIG');
      expect(() => renderBundle(path, resolve(link, 'out'))).toThrow('INVALID_PRIVATE_EDGE_CONFIG'); expect(existsSync(resolve(folder, 'out'))).toBe(false);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
  it('rejects oversized input without reading a candidate key or activating anything', () => {
    const folder = mkdtempSync(resolve(tmpdir(), 'factuez-edge-render-fixture-'));
    try {
      const path = resolve(folder, 'input.json'), output = resolve(folder, 'out'); writeFileSync(path, ' '.repeat(16385));
      expect(() => renderBundle(path, output)).toThrow('INVALID_PRIVATE_EDGE_CONFIG'); expect(existsSync(output)).toBe(false);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
});
function fixture() {
  const rendered = renderEdge(config);
  const files: Record<string, string> = { 'kong.json': JSON.stringify(rendered.kong, null, 2) + '\n',
    'kong.conf': rendered.kongConf, 'compose.yml': rendered.compose, 'firewall.nft': rendered.firewall };
  const io = { platform: () => 'linux', interfaces: () => ({ 'wg-factuez': [{ address: config.vpn.address, internal: false }] }),
    kind: () => 'wireguard', dns: vi.fn(async () => [{ family: 4, address: config.vpn.address }]),
    read: vi.fn((path: string) => material[basename(path)] ?? Buffer.from(files[basename(path)])),
    openssl: vi.fn((args: string[]) => args.includes('-lastupdate') ?
      'lastUpdate=' + new Date(now - 60000).toUTCString() + '\nnextUpdate=' + new Date(now + 86400000).toUTCString() + '\n' : 'VERIFIED'),
    handshake: vi.fn(async () => true), now: () => now,
    deployment: () => ({ kongImage: 'kong:3.9.3@sha256:' + 'a'.repeat(64), bundle: '/synthetic/bundle' }) };
  return { io, files };
}
describe('Phase7 synthetic read-only network/TLS preflight', () => {
  it('returns precheck only, never activation or a fiscal acceptance claim', async () => {
    const { io } = fixture(), result = await preflightEdge(config, '/synthetic/bundle', io);
    expect(result.status).toBe('PRECHECK_PASSED_NOT_ACTIVATED'); expect(result.environment).toBe('BETA');
    expect(result.automaticActivation).toBe(false); expect(result.pending).toContain('CLIENT_GRANTS');
    expect(io.handshake.mock.calls.map(args => [args[0], args[2]])).toEqual([
      [3108, 'identity.factuez.internal'], [3112, 'read.factuez.internal'],
    ]); expect(io.openssl).toHaveBeenCalledTimes(4);
    // This unit test mocks OpenSSL/TLS; actual CRL enforcement is covered by the separate Kong runner.
  });
  it.each(['win32', 'darwin', 'freebsd'])('rejects %s before reading keys, DNS or connections', async platform => {
    const { io } = fixture(); io.platform = () => platform;
    await expect(preflightEdge(config, '/synthetic/bundle', io)).rejects.toThrow('EDGE_LINUX_HOST_REQUIRED');
    expect(io.read).not.toHaveBeenCalled(); expect(io.dns).not.toHaveBeenCalled(); expect(io.handshake).not.toHaveBeenCalled();
  });
  it.each(['ether', 'tun', null])('rejects non-WireGuard interface %s', async kind => {
    const { io } = fixture(); io.kind = () => kind as any;
    await expect(preflightEdge(config, '/synthetic/bundle', io)).rejects.toThrow('EDGE_VPN_INTERFACE_INVALID');
    expect(io.read).not.toHaveBeenCalled();
  });
  it.each([{ address: '10.44.0.2', internal: false }, { address: config.vpn.address, internal: true }])('rejects wrong/internal interface address', async address => {
    const { io } = fixture(); io.interfaces = () => ({ 'wg-factuez': [address] });
    await expect(preflightEdge(config, '/synthetic/bundle', io)).rejects.toThrow('EDGE_VPN_INTERFACE_INVALID');
  });
  it.each([[], [{ family: 4, address: '8.8.8.8' }], [{ family: 6, address: '::1' }],
    [{ family: 4, address: config.vpn.address }, { family: 4, address: '10.44.0.2' }]])('rejects DNS expansion/mismatch', async dns => {
    const { io } = fixture(); io.dns.mockResolvedValue(dns as any);
    await expect(preflightEdge(config, '/synthetic/bundle', io)).rejects.toThrow('EDGE_DNS_INVALID'); expect(io.read).not.toHaveBeenCalled();
  });
  it.each(['kong.json', 'kong.conf', 'compose.yml', 'firewall.nft'])('rejects altered %s before reading certificates', async file => {
    const { io, files } = fixture(); files[file] += '\n# UNAPPROVED CHANGE';
    await expect(preflightEdge(config, '/synthetic/bundle', io)).rejects.toThrow('EDGE_RENDER_MISMATCH');
    expect(io.handshake).not.toHaveBeenCalled();
  });
  it('never treats missing/forged headers as transport evidence', async () => {
    const { io } = fixture(); io.handshake.mockRejectedValue(new Error('EDGE_UPSTREAM_TLS_INVALID'));
    await expect(preflightEdge(config, '/synthetic/bundle', io)).rejects.toThrow('EDGE_UPSTREAM_TLS_INVALID');
  });
  it('OpenSSL check failure is blocking, not an optional skip', async () => {
    const { io } = fixture(); io.openssl.mockImplementation(() => { throw new Error('EDGE_TLS_TOOL_CHECK_FAILED'); });
    await expect(preflightEdge(config, '/synthetic/bundle', io)).rejects.toThrow('EDGE_TLS_TOOL_CHECK_FAILED'); expect(io.handshake).not.toHaveBeenCalled();
  });
  it('does not accept production configuration even before networking', async () => {
    const { io } = fixture();
    await expect(preflightEdge({ ...config, environment: 'PRODUCTION' }, '/synthetic/bundle', io)).rejects.toThrow('INVALID_PRIVATE_EDGE_CONFIG');
    expect(io.dns).not.toHaveBeenCalled();
  });
  it.each(['kong:latest', 'kong:3.9.3', 'registry.invalid/kong@sha256:' + 'a'.repeat(64), 'kong:3.9.3@sha256:' + 'a'.repeat(63)])('requires reviewed digest, not %s', kongImage => {
    expect(() => validateDeploymentSettings({ kongImage, bundle: '/synthetic/bundle' }, '/synthetic/bundle')).toThrow('EDGE_DEPLOYMENT_INVALID');
  });
  it('blocks deployment env drift/missing bundle before secrets or network', async () => {
    const { io } = fixture(); io.deployment = () => ({ kongImage: 'kong:latest', bundle: '/synthetic/bundle' });
    await expect(preflightEdge(config, '/synthetic/bundle', io)).rejects.toThrow('EDGE_DEPLOYMENT_INVALID');
    expect(io.dns).not.toHaveBeenCalled(); expect(io.read).not.toHaveBeenCalled();
    expect(() => validateDeploymentSettings({ kongImage: 'kong:3.9.3@sha256:' + 'a'.repeat(64), bundle: '/wrong/bundle' }, '/synthetic/bundle')).toThrow('EDGE_DEPLOYMENT_INVALID');
    expect(() => validateDeploymentSettings({}, '/synthetic/bundle')).toThrow('EDGE_DEPLOYMENT_INVALID');
  });
  it('accepts synthetic matching TLS keys/purposes without displaying material', () => {
    expect(validateTlsMaterial(material, config, now).clientFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each(['edge-key.pem', 'kong-client-key.pem'])('rejects mismatched %s', name => {
    expect(() => validateTlsMaterial({ ...material, [name]: badKey }, config, now)).toThrow('EDGE_TLS_INVALID');
  });
  it('rejects absent material and malformed certificate', () => {
    expect(() => validateTlsMaterial({}, config, now)).toThrow('EDGE_TLS_INVALID');
    expect(() => validateTlsMaterial({ ...material, 'edge-cert.pem': Buffer.from('NOT A CERTIFICATE') }, config, now)).toThrow('EDGE_TLS_INVALID');
  });
  it('rejects CA as leaf and wrong DNS', () => {
    expect(() => validateTlsMaterial({ ...material, 'edge-cert.pem': material['edge-server-ca.pem'] }, config, now)).toThrow('EDGE_TLS_INVALID');
    expect(() => validateTlsMaterial(material, { ...config, vpn: { ...config.vpn, privateDnsName: 'other.factuez.test' } }, now)).toThrow('EDGE_TLS_INVALID');
  });
  it('rejects swapped server/client purpose and expired or future certificates', () => {
    expect(() => validateTlsMaterial({ ...material, 'edge-cert.pem': material['kong-client-cert.pem'] }, config, now)).toThrow('EDGE_TLS_INVALID');
    expect(() => validateTlsMaterial(material, config, now + 8 * 86400000)).toThrow('EDGE_TLS_EXPIRED');
    expect(() => validateTlsMaterial(material, config, now - 2 * 86400000)).toThrow('EDGE_TLS_EXPIRED');
  });
  it('does not silently use the first certificate of an unvalidated chain', () => {
    expect(() => validateTlsMaterial({ ...material, 'edge-client-ca.pem': Buffer.concat([material['edge-client-ca.pem'], material['edge-server-ca.pem']]) }, config, now)).toThrow('EDGE_TLS_INVALID');
  });
  it.each(['', 'lastUpdate=invalid\nnextUpdate=invalid', 'nextUpdate=Jan 1 2028 GMT\nlastUpdate=Jan 1 2026 GMT',
    'lastUpdate=Jan 1 2026 GMT\nnextUpdate=Jan 1 2026 GMT',
    'lastUpdate=Jan 1 2030 GMT\nnextUpdate=Jan 1 2031 GMT',
    'lastUpdate=Jan 1 2026 GMT\nnextUpdate=Jan 1 2031 GMT\nEXTRA'])('rejects invalid/stale CRL timestamps', text => {
    expect(() => validateCrlTimes(text, now)).toThrow('EDGE_CRL_INVALID');
  });
  it('accepts fresh CRL timestamps and rejects imminent expiration', () => {
    const text = (expiry: number) => 'lastUpdate=' + new Date(now - 60000).toUTCString() + '\nnextUpdate=' + new Date(expiry).toUTCString();
    expect(() => validateCrlTimes(text(now + 86400000), now)).not.toThrow();
    expect(() => validateCrlTimes(text(now + 60000), now)).toThrow('EDGE_CRL_INVALID');
  });
  it('CLI emits a safe blocker with no filesystem/crypto error content', () => {
    const folder = mkdtempSync(resolve(tmpdir(), 'factuez-preflight-fixture-'));
    try {
      const path = resolve(folder, 'input.json'); writeFileSync(path, JSON.stringify(config));
      const run = spawnSync(process.execPath, [resolve('infra/integration/private-edge-preflight.mjs'),
        '--config', path, '--bundle', resolve(folder, 'not-real'), '--read-only'], { encoding: 'utf8' });
      expect(run.status).toBe(1); expect(run.stdout).toBe('');
      const result = JSON.parse(run.stderr);
      expect(result.status).toBe('BLOCKED_NOT_ACTIVATED'); expect(run.stderr).not.toContain(folder);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
  it('CLI refuses a symlink config without reading its content', () => {
    const folder = mkdtempSync(resolve(tmpdir(), 'factuez-preflight-fixture-'));
    try {
      const actual = resolve(folder, 'actual.json'); writeFileSync(actual, JSON.stringify(config));
      // Directory junctions are supported without Windows Developer Mode.
      const dir = resolve(folder, 'linked'); symlinkSync(folder, dir, 'junction');
      const run = spawnSync(process.execPath, [resolve('infra/integration/private-edge-preflight.mjs'),
        '--config', resolve(dir, 'actual.json'), '--bundle', resolve(folder, 'not-real'), '--read-only'], { encoding: 'utf8' });
      expect(run.status).toBe(1); expect(JSON.parse(run.stderr).code).toBe('EDGE_FILE_INVALID');
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
});
