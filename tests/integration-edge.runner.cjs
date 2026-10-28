'use strict';

// Executed only in a freshly labelled, internal-network Node container.
// All keys/certificates, mock upstreams and requests here are fictitious.
const assert = require('node:assert/strict');
const { randomUUID, X509Certificate } = require('node:crypto');
const { createServer, request } = require('node:https');
const { createServer: controlServer, request: controlRequest } = require('node:http');
const { readFileSync, mkdirSync, writeFileSync, existsSync } = require('node:fs');
const { networkInterfaces } = require('node:os');
const root = '/run/factuez-edge', dns = 'api.factuez.test';
const guard = '--isolated-synthetic-only';
const mode = process.argv[2], runId = process.env.FIXTURE_RUN_ID;
let checks = 0, stage = 'fixture-guard', httpStatus;
const pass = () => { checks++; };
const sleep = n => new Promise(r => setTimeout(r, n));
const summary = result => process.stdout.write(JSON.stringify({ result, stage, checks, realData: false,
  ...(result === 'FAIL' && Number.isSafeInteger(httpStatus) ? { httpStatus } : {}) }) + '\n');
function fail() { summary('FAIL'); process.exitCode = 1; }
function config(address) {
  return { schemaVersion: 'factuez.private-edge.v1', environment: 'BETA', deployment: 'LINUX_HOST_LOOPBACK',
    vpn: { interface: 'wg-factuez', address, clientCidrs: [address + '/32'], privateDnsName: dns }, listenPort: 9443,
    upstreamPorts: { identity: 3108, read: 3112 },
    rateLimits: { tokenPerMinute: 20, readPerMinute: 120, exportPerMinute: 4, changesPerMinute: 30 } };
}
function certificateFixture() {
  const forge = require('/fixture/vendor/node-forge'), pki = forge.pki;
  const keys = pki.rsa.generateKeyPair(2048), alienKeys = pki.rsa.generateKeyPair(2048), leafKeys = pki.rsa.generateKeyPair(2048);
  const valid = { notBefore: new Date(Date.now() - 120000), notAfter: new Date(Date.now() + 3600000) };
  function ca(pair, serial, name) {
    const c = pki.createCertificate(); c.publicKey = pair.publicKey; c.serialNumber = serial; c.validity = valid;
    c.setSubject([{ name: 'commonName', value: name }]); c.setIssuer(c.subject.attributes);
    c.setExtensions([{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true }]);
    c.sign(pair.privateKey, forge.md.sha256.create()); return c;
  }
  const rootCert = ca(keys, '01', 'FICTITIOUS phase7 CA'), alienCA = ca(alienKeys, '02', 'FICTITIOUS alien CA');
  function leaf(serial, usage, issuer = rootCert, signer = keys.privateKey, wrongName = false) {
    const c = pki.createCertificate(); c.publicKey = leafKeys.publicKey; c.serialNumber = serial; c.validity = valid;
    c.setSubject([{ name: 'commonName', value: usage === 'server' ? dns : 'FICTITIOUS peer ' + serial }]); c.setIssuer(issuer.subject.attributes);
    c.setExtensions([{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: usage === 'server', clientAuth: usage === 'client' },
      ...(usage === 'server' ? [{ name: 'subjectAltName', altNames: [
        { type: 2, value: wrongName ? 'wrong.factuez.test' : dns },
        ...(!wrongName ? ['identity.factuez.internal', 'read.factuez.internal'].map(value => ({ type: 2, value })) : []),
        { type: 7, ip: wrongName ? '127.0.0.2' : '127.0.0.1' }] }] : [])]);
    c.sign(signer, forge.md.sha256.create()); return pki.certificateToPem(c);
  }
  const a = forge.asn1, u = a.Class.UNIVERSAL, make = (type, constructed, value) => a.create(u, type, constructed, value);
  const algorithm = () => make(a.Type.SEQUENCE, true, [make(a.Type.OID, false, a.oidToDer(pki.oids.sha256WithRSAEncryption).getBytes()), make(a.Type.NULL, false, '')]);
  const utc = date => make(a.Type.UTCTIME, false, a.dateToUtcTime(date));
  const tbs = make(a.Type.SEQUENCE, true, [make(a.Type.INTEGER, false, '\x01'), algorithm(), pki.distinguishedNameToAsn1(rootCert.subject),
    utc(new Date(Date.now() - 60000)), utc(new Date(Date.now() + 1800000)),
    make(a.Type.SEQUENCE, true, [make(a.Type.SEQUENCE, true, [make(a.Type.INTEGER, false, '\x40'), utc(new Date(Date.now() - 60000))])])]);
  const md = forge.md.sha256.create(); md.update(a.toDer(tbs).getBytes());
  const crl = forge.pem.encode({ type: 'X509 CRL', body: a.toDer(make(a.Type.SEQUENCE, true,
    [tbs, algorithm(), make(a.Type.BITSTRING, false, '\x00' + keys.privateKey.sign(md))])).getBytes() });
  return { ca: pki.certificateToPem(rootCert), key: pki.privateKeyToPem(leafKeys.privateKey), crl,
    server: leaf('10', 'server'), client: leaf('20', 'client'), kong: leaf('30', 'client'), revoked: leaf('40', 'client'),
    alienClient: leaf('50', 'client', alienCA, alienKeys.privateKey), alienServer: leaf('60', 'server', alienCA, alienKeys.privateKey),
    wrongName: leaf('70', 'server', rootCert, keys.privateKey, true), alienCA: pki.certificateToPem(alienCA) };
}
async function serve() {
  stage = 'fictitious-certificate-generation';
  const ip = Object.values(networkInterfaces()).flat().find(x => x && x.family === 'IPv4' && !x.internal)?.address;
  assert.ok(ip && /^(?:10|172|192)\./.test(ip));
  const { renderEdge } = await import('/fixture/private-edge.mjs');
  const tls = certificateFixture(), expected = new X509Certificate(tls.kong).fingerprint256;
  mkdirSync(root + '/tls', { mode: 0o700 });
  const files = { 'edge-cert.pem': tls.server, 'edge-key.pem': tls.key, 'edge-server-ca.pem': tls.ca,
    'edge-client-ca.pem': tls.ca, 'edge-client.crl.pem': tls.crl, 'upstream-ca.pem': tls.ca,
    'kong-client-cert.pem': tls.kong, 'kong-client-key.pem': tls.key,
    'fixture-client.pem': tls.client, 'fixture-revoked.pem': tls.revoked, 'fixture-alien.pem': tls.alienClient, 'fixture-alien-ca.pem': tls.alienCA };
  for (const [name, pem] of Object.entries(files)) writeFileSync(root + '/tls/' + name, pem, { flag: 'wx', mode: 0o644 });
  const rendered = renderEdge(config(ip));
  writeFileSync(root + '/kong.json', JSON.stringify(rendered.kong), { flag: 'wx', mode: 0o644 });
  writeFileSync(root + '/kong.conf', rendered.kongConf, { flag: 'wx', mode: 0o644 });
  writeFileSync(root + '/fixture.json', JSON.stringify({ address: ip, runId }), { flag: 'wx', mode: 0o644 });
  let received = 0;
  const servers = [];
  for (const [owner, port] of [['identity', 3108], ['read', 3112]]) {
    const server = createServer({ cert: tls.server, key: tls.key, ca: tls.ca, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' }, (req, res) => {
      received++;
      const peer = req.socket.getPeerCertificate(), authorized = req.socket.authorized && peer.fingerprint256 === expected;
      let bytes = 0; req.on('data', chunk => { bytes += chunk.length; });
      req.on('end', () => {
        const token = req.url === '/integration/oauth/token';
        const credential = token ? req.headers.authorization === 'Basic ZmljdGl0aW91czpmaWN0aXRpb3Vz' : req.headers.authorization === 'Bearer fictitious-edge-token';
        res.statusCode = authorized && credential ? 200 : 401; res.setHeader('Connection', 'close'); res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ owner, method: req.method, url: req.url, mutualTls: authorized, bytes }));
      });
    });
    await new Promise((r, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', r); }); servers.push(server);
  }
  // Private test control only on shared loopback. It never touches real owners.
  const control = controlServer(async (req, res) => {
    if (req.headers['x-fixture-id'] !== runId) { res.writeHead(404).end(); return; }
    const command = req.url;
    if (command === '/upstream-untrusted' || command === '/upstream-wrong-name' || command === '/upstream-trusted') {
      const cert = command === '/upstream-untrusted' ? tls.alienServer : command === '/upstream-wrong-name' ? tls.wrongName : tls.server;
      for (const s of servers) { s.setSecureContext({ cert, key: tls.key, ca: tls.ca }); s.closeAllConnections(); }
    } else if (command !== '/ready' && command !== '/stats') { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ received, ready: true }));
  });
  await new Promise((r, reject) => { control.once('error', reject); control.listen(3199, '127.0.0.1', r); });
  stage = 'fixture-serving';
  process.on('SIGTERM', () => { control.close(); servers.forEach(x => { x.closeAllConnections(); x.close(); }); });
}
function control(path) {
  return new Promise((resolve, reject) => {
    const req = controlRequest({ host: '127.0.0.1', port: 3199, path, headers: { 'x-fixture-id': runId }, timeout: 3000 }, res => {
      const pieces = []; res.on('data', x => pieces.push(x)); res.on('end', () => {
        try { assert.equal(res.statusCode, 200); resolve(JSON.parse(Buffer.concat(pieces).toString())); } catch (e) { reject(e); }
      });
    }); req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Fixture timeout'))); req.end();
  });
}
async function verify() {
  const f = JSON.parse(readFileSync(root + '/fixture.json', 'utf8')); assert.equal(f.runId, runId);
  const ca = readFileSync(root + '/tls/edge-server-ca.pem'), key = readFileSync(root + '/tls/edge-key.pem');
  const cert = kind => readFileSync(root + '/tls/fixture-' + kind + '.pem');
  async function send(method, path, options = {}) {
    const body = options.body ?? (method === 'POST' ? '{}' : undefined);
    return new Promise((resolve, reject) => {
      const req = request({ hostname: options.address ?? f.address, servername: options.servername ?? dns, port: options.port ?? 9443,
        method, path, ca: options.ca ?? ca, ...(options.noCertificate ? {} : { cert: cert(options.client ?? 'client'), key }),
        minVersion: 'TLSv1.2', rejectUnauthorized: true, timeout: 4000, agent: false,
        headers: { Host: options.host ?? dns, Authorization: path === '/integration/oauth/token' ? 'Basic ZmljdGl0aW91czpmaWN0aXRpb3Vz' : 'Bearer fictitious-edge-token',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json',
            ...(options.chunkedBody ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': Buffer.byteLength(body) }) }), ...options.headers } }, res => {
        const pieces = []; let size = 0;
        res.on('data', x => { size += x.length; if (size > 16384) req.destroy(new Error('Oversized fixture response')); else pieces.push(x); });
        res.on('end', () => { httpStatus = res.statusCode; resolve({ status: res.statusCode, body: Buffer.concat(pieces).toString(), headers: res.headers }); });
      });
      req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Fixture request timeout')));
      if (body !== undefined) req.write(body); req.end();
    });
  }
  async function denied(method, path, options = {}, allowed = [400, 401, 403, 404, 405, 413, 429, 495, 496]) {
    const before = (await control('/stats')).received;
    try { const response = await send(method, path, options); assert.ok(allowed.includes(response.status)); }
    catch (e) { if (e.code === 'ERR_ASSERTION') throw e; assert.ok(/TLS|SSL|ECONNRESET|EPROTO|CERT_|ECONNREFUSED/.test(String(e.code))); }
    const after = (await control('/stats')).received; assert.equal(after, before); pass();
  }
  stage = 'kong-ready';
  let ready = false;
  for (let n = 0; n < 60; n++) {
    try { const result = await send('GET', '/integration/v1/capabilities'); if (result.status === 200) { ready = true; break; } }
    catch {} await sleep(200);
  }
  assert.equal(ready, true); pass();
  stage = 'exact-seventeen-contract-routes';
  const api = JSON.parse(readFileSync('/fixture/contract.json', 'utf8')), routes = [];
  for (const [path, operations] of Object.entries(api.paths)) for (const method of ['get', 'post', 'put', 'delete', 'patch', 'head', 'options']) {
    if (operations[method]) routes.push([method.toUpperCase(), path.replace(/\{[^}]+\}/g, randomUUID())]);
  }
  assert.equal(routes.length, 17); pass();
  for (const [method, path] of routes) {
    const r = await send(method, path); assert.equal(r.status, 200);
    const actual = JSON.parse(r.body); assert.equal(actual.method, method); assert.equal(actual.url, path);
    assert.equal(actual.owner, path === '/integration/oauth/token' ? 'identity' : 'read'); assert.equal(actual.mutualTls, true); pass();
  }
  stage = 'all-contract-paths-reject-prefix-and-suffix';
  for (const [method, path] of routes) for (const invalid of ['/prefix' + path, path + '/extra', path + '/']) await denied(method, invalid);
  stage = 'mandatory-client-mtls-and-crl';
  for (const options of [{ noCertificate: true }, { client: 'alien' }, { client: 'revoked' }]) await denied('GET', '/integration/v1/issuers', options);
  await denied('GET', '/integration/v1/issuers', { noCertificate: true, headers: {
    'X-Forwarded-For': f.address, 'X-Real-IP': f.address, 'X-SSL-Client-Verify': 'SUCCESS', 'X-SSL-Client-Cert': 'fictitious-spoof',
    'X-Client-Certificate': 'fictitious-spoof', 'X-Forwarded-Client-Cert': 'fictitious-spoof' } });
  stage = 'closed-pwa-admin-internal-and-unknown-routes';
  for (const path of ['/', '/login', '/stations', '/api/auth/login', '/api/documents', '/internal/integration/documents',
    '/integration/clients', '/integration/oauth/introspect', '/integration/v1/unknown', '/admin', '/config', '/services', '/status',
    '/integration/v1/documents/not-a-uuid', '/integration/v1/documents/' + randomUUID() + '/extra', '/integration/v1/documents/',
    '/integration/v1/%2Finternal', '/integration/v1/documents%2Flookup']) await denied('GET', path);
  for (const [method, path] of [['GET', '/integration/oauth/token'], ['POST', '/integration/v1/issuers'], ['PUT', '/integration/v1/exports'],
    ['DELETE', '/integration/v1/documents/' + randomUUID()], ['HEAD', '/integration/v1/points'], ['OPTIONS', '/integration/v1/documents']]) await denied(method, path);
  stage = 'exact-private-host-and-interface';
  for (const host of ['localhost', 'evil.factuez.test', 'api.factuez.test.evil.invalid', f.address]) await denied('GET', '/integration/v1/branches', { host });
  await denied('GET', '/integration/v1/branches', { servername: 'evil.factuez.test' });
  await denied('GET', '/integration/v1/branches', { address: '127.0.0.1' });
  for (const port of [8000, 8001, 8444, 8100]) await denied('GET', '/services', { port });
  stage = 'no-header-or-ip-authorization';
  const spoof = await send('GET', '/integration/v1/points', { headers: { Authorization: '', 'X-Forwarded-For': f.address,
    'X-SSL-Client-Verify': 'SUCCESS', 'X-User-Role': 'GENERAL_ADMIN' } }); assert.equal(spoof.status, 401); pass();
  stage = 'body-bounds-before-upstream';
  for (const path of ['/integration/oauth/token', '/integration/v1/exports']) await denied('POST', path, { body: 'X'.repeat(65536) }, [413]);
  // Buffering normalizes a bounded chunked request before plugins. Test the
  // real size boundary, not an assumed 411 for a valid normalized request.
  for (const path of ['/integration/oauth/token', '/integration/v1/exports']) {
    await denied('POST', path, { chunkedBody: true, body: 'X'.repeat(65536) }, [413]);
    const normalized = await send('POST', path, { chunkedBody: true, body: '{}' });
    assert.equal(normalized.status, 200); assert.equal(JSON.parse(normalized.body).bytes, 2); pass();
  }
  stage = 'upstream-trust-and-name-verification';
  for (const command of ['/upstream-untrusted', '/upstream-wrong-name']) {
    await control(command); const before = (await control('/stats')).received;
    const rejected = await send('GET', '/integration/v1/branches'); assert.equal(rejected.status, 502);
    assert.equal((await control('/stats')).received, before); pass();
  }
  await control('/upstream-trusted'); assert.equal((await send('GET', '/integration/v1/branches')).status, 200); pass();
  stage = 'per-route-rate-limits-not-spoofable';
  for (const [method, path, limit] of [['POST', '/integration/oauth/token', 20], ['POST', '/integration/v1/exports', 4],
    ['GET', '/integration/v1/changes', 30], ['GET', '/integration/v1/documents', 120]]) {
    let limited = false;
    for (let n = 0; n <= limit + 1; n++) {
      const r = await send(method, path, { headers: { 'X-Forwarded-For': '10.99.0.' + (n % 250 + 1), 'X-Real-IP': '10.99.1.' + (n % 250 + 1) } });
      if (r.status === 429) { limited = true; assert.ok(r.headers['retry-after']); break; }
      assert.equal(r.status, 200);
    }
    assert.equal(limited, true); pass();
  }
  stage = 'actual-kong-security-complete'; summary('PASS');
}
async function outside() {
  const f = JSON.parse(readFileSync(root + '/fixture.json', 'utf8')); assert.equal(f.runId, runId);
  stage = 'valid-client-outside-source-cidr-cannot-spoof-ip';
  const result = await new Promise((resolve, reject) => {
    const req = request({ host: f.address, servername: dns, port: 9443, path: '/integration/v1/issuers', agent: false, timeout: 4000,
      ca: readFileSync(root + '/tls/edge-server-ca.pem'), cert: readFileSync(root + '/tls/fixture-client.pem'), key: readFileSync(root + '/tls/edge-key.pem'),
      rejectUnauthorized: true, minVersion: 'TLSv1.2', headers: { Host: dns, Authorization: 'Bearer fictitious-edge-token',
        'X-Forwarded-For': f.address, 'X-Real-IP': f.address, 'X-SSL-Client-Verify': 'SUCCESS' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    }); req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Fixture timeout'))); req.end();
  });
  assert.equal(result, 403); pass(); summary('PASS');
}
async function main() {
  assert.equal(process.argv.length, 4); assert.equal(process.argv[3], guard); assert.ok(['serve', 'ready', 'verify', 'outside'].includes(mode));
  assert.match(runId ?? '', /^[0-9a-f-]{36}$/);
  if (mode === 'serve') await serve();
  else if (mode === 'ready') { assert.ok(existsSync(root + '/fixture.json')); await control('/ready'); stage = 'fixture-ready'; summary('PASS'); }
  else if (mode === 'outside') await outside();
  else await verify();
}
main().catch(fail);
