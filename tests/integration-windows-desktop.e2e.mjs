/** Actual Desktop host-loopback + Kong, SYNTHETIC ONLY, never a VPN pilot. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID, X509Certificate } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { createServer, request } from 'node:https';
import { createServer as tcpServer } from 'node:net';
import { renderWindowsEdge } from '../infra/integration/windows-edge.mjs';
import { createWindowsRelay } from '../infra/integration/windows-relay.mjs';
const runId = randomUUID(), name = 'factuez-i8w-' + runId.replaceAll('-', '').slice(0, 12), guard = '--isolated-synthetic-only';
let stage = 'guard', checks = 0, directory, created = false, relay; const servers = [];
const pass = () => { checks++; };
function docker(args) {
  const result = spawnSync('docker.exe', ['--context', 'desktop-linux', ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 65536 });
  if (result.error || result.status !== 0) throw new Error('SYNTHETIC_DESKTOP_OPERATION_FAILED'); return result.stdout.trim();
}
function owned() {
  const rows = JSON.parse(docker(['container', 'inspect', name])); assert.equal(rows.length, 1);
  assert.equal(rows[0].Name.slice(1), name); assert.equal(rows[0].Config.Labels['factuez.integration.test'], runId);
  assert.equal(rows[0].Config.Labels['factuez.integration.phase'], '8-windows'); return rows[0];
}
async function listen(server) {
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return server.address().port;
}
function certificates() {
  const forge = createRequire(resolve('packages/evidence-core/package.json'))('node-forge'), pki = forge.pki;
  const pair = pki.rsa.generateKeyPair(2048), ca = pki.createCertificate(); ca.publicKey = pair.publicKey; ca.serialNumber = '01';
  ca.validity.notBefore = new Date(Date.now() - 60000); ca.validity.notAfter = new Date(Date.now() + 3600000);
  ca.setSubject([{ name: 'commonName', value: 'SYNTHETIC Windows Desktop CA' }]); ca.setIssuer(ca.subject.attributes);
  ca.setExtensions([{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true }]); ca.sign(pair.privateKey, forge.md.sha256.create());
  const leaf = (serial, host) => {
    const keys = pki.rsa.generateKeyPair(2048), cert = pki.createCertificate(); cert.publicKey = keys.publicKey; cert.serialNumber = serial;
    cert.validity = ca.validity; cert.setSubject([{ name: 'commonName', value: host ?? 'SYNTHETIC client' }]); cert.setIssuer(ca.subject.attributes);
    cert.setExtensions([{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: Boolean(host), clientAuth: !host }, ...(host ? [{ name: 'subjectAltName', altNames: [{ type: 2, value: host }, { type: 7, ip: '127.0.0.1' }] }] : [])]);
    cert.sign(pair.privateKey, forge.md.sha256.create()); return { cert: pki.certificateToPem(cert), key: pki.privateKeyToPem(keys.privateKey) };
  };
  const a = forge.asn1, u = a.Class.UNIVERSAL, make = (t, constructed, value) => a.create(u, t, constructed, value);
  const alg = () => make(a.Type.SEQUENCE, true, [make(a.Type.OID, false, a.oidToDer(pki.oids.sha256WithRSAEncryption).getBytes()), make(a.Type.NULL, false, '')]);
  const utc = date => make(a.Type.UTCTIME, false, a.dateToUtcTime(date));
  const tbs = make(a.Type.SEQUENCE, true, [make(a.Type.INTEGER, false, '\x01'), alg(), pki.distinguishedNameToAsn1(ca.subject),
    utc(new Date(Date.now() - 60000)), utc(new Date(Date.now() + 1800000)),
    make(a.Type.SEQUENCE, true, [make(a.Type.SEQUENCE, true, [make(a.Type.INTEGER, false, '\x40'), utc(new Date(Date.now() - 60000))])])]);
  const md = forge.md.sha256.create(); md.update(a.toDer(tbs).getBytes());
  const crl = forge.pem.encode({ type: 'X509 CRL', body: a.toDer(make(a.Type.SEQUENCE, true,
    [tbs, alg(), make(a.Type.BITSTRING, false, '\x00' + pair.privateKey.sign(md))])).getBytes() });
  return { ca: pki.certificateToPem(ca), crl, edge: leaf('10', 'api.factuez.test'), identity: leaf('11', 'identity.factuez.internal'),
    read: leaf('12', 'read.factuez.internal'), kong: leaf('20'), client: leaf('30'), revoked: leaf('40'), wrongRead: leaf('50', 'wrong.factuez.test') };
}
try {
  assert.equal(process.platform, 'win32'); assert.equal(process.argv.length, 3); assert.equal(process.argv[2], guard);
  const context = spawnSync('docker.exe', ['context', 'inspect', 'desktop-linux', '--format', '{{(index .Endpoints "docker").Host}}'],
    { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 4096 });
  assert.equal(context.status, 0); assert.equal(context.stdout.trim(), 'npipe:////./pipe/dockerDesktopLinuxEngine'); pass();
  stage = 'reviewed-local-kong-image'; const image = docker(['image', 'inspect', '--format', '{{.Id}}', 'kong:3.9.3']);
  assert.equal(image, 'sha256:12972ce1ab6396083e56e7d46fce084836c98cc819344bef44a1f583ec3ab191'); pass();
  stage = 'new-synthetic-native-https-owners'; const tls = certificates(), expected = new X509Certificate(tls.kong.cert).fingerprint256;
  let received = 0;
  const ports = {};
  for (const owner of ['identity', 'read']) {
    const server = createServer({ ...tls[owner], ca: tls.ca, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' }, (req, res) => {
      received++; const allowed = req.socket.authorized && req.socket.getPeerCertificate().fingerprint256 === expected;
      res.writeHead(allowed ? 200 : 401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ owner, peerAllowed: allowed, source: 'SYNTHETIC' }));
    }); servers.push(server); ports[owner] = await listen(server);
  }
  const reservation = tcpServer(); const kongPort = await listen(reservation); await new Promise(done => reservation.close(done));
  const c = JSON.parse(readFileSync(resolve('infra/integration/windows-edge.example.json'))); c.upstreamPorts = ports; c.kongLoopbackPort = kongPort;
  directory = mkdtempSync(join(tmpdir(), name + '-')); writeFileSync(join(directory, 'fixture-owner.txt'), runId, { flag: 'wx' });
  const files = renderWindowsEdge(c); for (const [file, bytes] of Object.entries(files)) writeFileSync(join(directory, file), bytes, { flag: 'wx' });
  mkdirSync(join(directory, 'tls'));
  const material = { 'edge-cert.pem': tls.edge.cert, 'edge-key.pem': tls.edge.key, 'edge-server-ca.pem': tls.ca,
    'edge-client-ca.pem': tls.ca, 'edge-client.crl.pem': tls.crl, 'upstream-ca.pem': tls.ca,
    'kong-client-cert.pem': tls.kong.cert, 'kong-client-key.pem': tls.kong.key };
  for (const [file, bytes] of Object.entries(material)) writeFileSync(join(directory, 'tls', file), bytes, { flag: 'wx', mode: 0o600 });
  stage = 'new-private-kong-host-loopback';
  docker(['create', '--name', name, '--label', 'factuez.integration.test=' + runId, '--label', 'factuez.integration.phase=8-windows',
    '--network', 'host', '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000',
    '--memory', '384m', '--cpus', '1', '--pids-limit', '128', '--mount', 'type=bind,source=' + directory + ',target=/run/factuez-edge,readonly',
    '--mount', 'type=tmpfs,destination=/tmp,tmpfs-size=33554432,tmpfs-mode=1777',
    '--mount', 'type=tmpfs,destination=/tmp/kong,tmpfs-size=67108864,tmpfs-mode=1777', '--env', 'KONG_PREFIX=/tmp/kong',
    '--entrypoint', '/bin/sh', image, '-c', 'mkdir -p /tmp/kong && exec /docker-entrypoint.sh kong docker-start -c /run/factuez-edge/kong.conf']);
  created = true; const container = owned(); assert.equal(container.HostConfig.NetworkMode, 'host');
  assert.equal(Object.keys(container.HostConfig.PortBindings ?? {}).length, 0); assert.equal(container.HostConfig.ReadonlyRootfs, true); pass();
  docker(['start', name]);
  const send = (port, path, cert = tls.client) => new Promise((done, reject) => {
    const req = request({ hostname: '127.0.0.1', servername: 'api.factuez.test', port, path, ca: tls.ca, ...(cert ?? {}),
      minVersion: 'TLSv1.2', rejectUnauthorized: true, agent: false, timeout: 3000,
      headers: { Host: 'api.factuez.test', Authorization: 'Bearer FICTITIOUS-NO-REAL-AUTH' } }, res => {
      const chunks = []; let size = 0; res.on('data', b => { size += b.length; if (size > 16384) req.destroy(new Error('BOUND')); else chunks.push(b); });
      res.on('end', () => done({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    }); req.on('error', reject); req.on('timeout', () => req.destroy(new Error('TIMEOUT'))); req.end();
  });
  stage = 'desktop-host-networking-must-already-work'; let ready = false, lastStatus = null, lastError = null;
  for (let i = 0; i < 30; i++) { try { lastStatus = (await send(kongPort, '/integration/v1/capabilities')).status; if (lastStatus === 200) { ready = true; break; } } catch (error) { lastError = error.code ?? null; }
    await new Promise(done => setTimeout(done, 200)); }
  if (!ready) { const state = owned().State, logs = docker(['logs', name]);
    const internal = spawnSync('docker.exe', ['--context', 'desktop-linux', 'exec', '-i', name, 'openssl', 's_client',
      '-connect', '127.0.0.1:' + kongPort, '-servername', 'api.factuez.test', '-cert', '/run/factuez-edge/tls/kong-client-cert.pem',
      '-key', '/run/factuez-edge/tls/kong-client-key.pem', '-CAfile', '/run/factuez-edge/tls/edge-server-ca.pem', '-verify_return_error', '-quiet'],
      { input: 'GET /integration/v1/capabilities HTTP/1.1\r\nHost: api.factuez.test\r\nAuthorization: Bearer SYNTHETIC\r\nConnection: close\r\n\r\n',
        encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 16384 });
    const internalStatus = /^HTTP\/1\.1 ([1-5][0-9]{2})\b/m.exec(internal.stdout ?? '')?.[1];
    console.log(JSON.stringify({ result: 'FAIL', stage: 'synthetic-startup-diagnostic', realData: false,
      running: state.Running, exitCode: state.ExitCode, httpStatus: lastStatus,
      containerLoopbackStatus: internalStatus ? Number(internalStatus) : null,
      transportCode: ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPROTO'].includes(lastError) ? lastError : 'OTHER',
      categories: [['PERMISSION', /permission denied/i], ['CONFIG', /invalid configuration|invalid config|declarative.*error/i],
        ['BIND', /bind.*failed|address already in use|cannot assign/i], ['MISSING_FILE', /No such file/i]].filter(([, pattern]) => pattern.test(logs)).map(([code]) => code) })); }
  assert.equal(ready, true); pass();
  stage = 'native-opaque-relay-loopback-fixture';
  // Explicit test mapper; never bind a real VPN/LAN address or invoke production CLI.
  relay = createWindowsRelay(c, { server: (options, callback) => {
    const server = tcpServer(options, socket => { Object.defineProperty(socket, 'localAddress', { value: c.vpn.address });
      Object.defineProperty(socket, 'remoteAddress', { value: '10.44.0.2' }); callback(socket); });
    const original = server.listen.bind(server); server.listen = (_options, done) => original(0, '127.0.0.1', done); return server;
  } });
  await relay.start(); const relayPort = relay.server.address().port;
  const ok = await send(relayPort, '/integration/v1/capabilities'); assert.equal(ok.status, 200); assert.equal(JSON.parse(ok.body).peerAllowed, true); pass();
  for (const path of ['/login', '/internal/integration/documents', '/integration/clients', '/integration/oauth/introspect', '/admin', '/status']) {
    const before = received, rejected = await send(relayPort, path); assert.ok([400, 403, 404, 405].includes(rejected.status)); assert.equal(received, before); pass();
  }
  for (const client of [null, tls.revoked]) {
    const before = received;
    try { const rejected = await send(relayPort, '/integration/v1/capabilities', client); assert.ok([400, 401, 403, 495, 496].includes(rejected.status)); }
    catch (e) { if (e.code === 'ERR_ASSERTION') throw e; assert.match(e.code ?? '', /SSL|TLS|ECONNRESET|EPROTO/); }
    assert.equal(received, before); pass();
  }
  stage = 'upstream-tls-name-mismatch-must-fail';
  servers[1].setSecureContext({ ...tls.wrongRead, ca: tls.ca }); servers[1].closeAllConnections();
  const before = received, mismatch = await send(relayPort, '/integration/v1/capabilities'); assert.equal(mismatch.status, 502); assert.equal(received, before); pass();
  servers[1].setSecureContext({ ...tls.read, ca: tls.ca }); servers[1].closeAllConnections();
  assert.equal((await send(relayPort, '/integration/v1/capabilities')).status, 200); pass();
  console.log(JSON.stringify({ result: 'PASS', checks, stage: 'desktop-kong-native-loopback', realData: false,
    vpnVerified: false, hostSettingsChanged: false, production: false }));
} catch { process.exitCode = 1; console.error(JSON.stringify({ result: 'FAIL', stage, checks, realData: false, hostSettingsChanged: false })); }
finally {
  let failed = false;
  try { await relay?.stop(); } catch { failed = true; }
  for (const server of servers) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  if (created) { try { owned(); docker(['container', 'rm', '--force', name]); } catch { failed = true; } }
  if (directory && !failed) { try {
    const root = realpathSync(directory), inside = relative(realpathSync(tmpdir()), root);
    assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside) && inside.startsWith(name + '-'));
    assert.equal(readFileSync(join(root, 'fixture-owner.txt'), 'utf8'), runId); rmSync(root, { recursive: true });
  } catch { failed = true; } }
  console.log(JSON.stringify({ result: failed ? 'FAIL' : 'PASS', stage: 'cleanup-exact-labelled-resources', realData: false }));
  if (failed) process.exitCode = 1;
}
