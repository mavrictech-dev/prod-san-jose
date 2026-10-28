// Isolated documentation render only: no Next app, B2B runtime or user's browser profile.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import ts from 'typescript';
if (process.argv.slice(2).join(' ') !== '--isolated-synthetic-only') throw new Error('Explicit isolated flag required');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
assert.ok(existsSync(chrome), 'Local Chrome required; nothing is downloaded');
const cache = new Map();
function loadTs(filename) {
  const path = resolve(root, filename); if (cache.has(path)) return cache.get(path);
  const compiled = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const require = createRequire(path), module = { exports: {} };
  const localRequire = name => name.startsWith('.') ? loadTs(resolve(dirname(path), name + '.ts')) : require(name);
  new Function('require', 'module', 'exports', compiled)(localRequire, module, module.exports);
  cache.set(path, module.exports); return module.exports;
}
const base = 'apps/web-pwa/app/api-docs/';
const routes = new Map([
  ['/api-docs', loadTs(base + 'route.ts').GET],
  ['/api-docs/swagger', loadTs(base + 'swagger/route.ts').GET],
  ['/api-docs/openapi.json', loadTs(base + 'openapi.json/route.ts').GET],
  ['/api-docs/sunat.json', loadTs(base + 'sunat.json/route.ts').GET],
]);
const asset = loadTs(base + 'assets/[asset]/route.ts').GET;
const requests = [], unexpected = [];
const server = createServer(async (req, res) => {
  try {
    requests.push(req.url);
    const url = new URL(req.url, 'http://127.0.0.1');
    let response;
    if (req.method === 'GET' && !url.search && routes.has(url.pathname)) response = routes.get(url.pathname)();
    else if (req.method === 'GET' && url.pathname.startsWith('/api-docs/assets/') && !url.search) response = await asset(new Request(url), { params: Promise.resolve({ asset: decodeURIComponent(url.pathname.slice('/api-docs/assets/'.length)) }) });
    else if (url.pathname === '/favicon.ico') response = new Response(null, { status: 204 });
    else { unexpected.push(req.method + ' ' + req.url); response = new Response('Unavailable', { status: 404 }); }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(500); res.end('Documentation fixture error'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const output = mkdtempSync(join(tmpdir(), 'factuez-public-docs-'));
async function render(path, width, label) {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const args = ['--headless', '--disable-gpu', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--no-first-run', '--no-default-browser-check', '--metrics-recording-only', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', `--user-data-dir=${join(output, label + '-profile')}`, '--remote-debugging-port=0', 'about:blank'];
  const child = spawn(chrome, args, { windowsHide: true });
  let socket, timer;
  const timedOut = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Chrome timeout')), 25000); });
  const work = async () => {
    const endpoint = await new Promise((resolve, reject) => {
      let errors = '';
      child.stderr.on('data', bytes => { errors += bytes; const match = errors.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) resolve(match[1]); });
      child.once('error', reject); child.once('exit', code => reject(new Error('Chrome exited early: ' + code)));
    });
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let sequence = 0, session;
    const pending = new Map();
    const send = (method, params = {}, sessionId = session) => new Promise((resolve, reject) => {
      const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    socket.addEventListener('message', event => {
      const value = JSON.parse(event.data);
      if (value.id && pending.has(value.id)) {
        const promise = pending.get(value.id); pending.delete(value.id);
        value.error ? promise.reject(new Error(JSON.stringify(value.error))) : promise.resolve(value.result);
      } else if (value.method === 'Fetch.requestPaused') {
        const url = value.params.request.url;
        const allowed = url.startsWith(origin + '/api-docs') || url === origin + '/favicon.ico';
        if (!allowed) unexpected.push(url);
        send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: value.params.requestId, ...(!allowed ? { errorReason: 'BlockedByClient' } : {}) }, value.sessionId).catch(() => {});
      }
    });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    session = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    await send('Page.enable'); await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: width < 600 });
    await send('Page.navigate', { url: origin + path });
    const ready = path.endsWith('/swagger') ? "document.querySelectorAll('.opblock').length === 25" : "document.querySelector('#webhooks')";
    const result = await send('Runtime.evaluate', { expression: `new Promise((resolve,reject) => { const end = Date.now()+8000; function check(){if(document.readyState==='complete' && ${ready}) resolve(true); else if(Date.now()>end) reject(new Error('Document not ready')); else setTimeout(check,50);} check(); })`, awaitPromise: true, returnByValue: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    const metrics = (await send('Runtime.evaluate', { expression: '({width:innerWidth,scroll:document.documentElement.scrollWidth})', returnByValue: true })).result.value;
    assert.equal(metrics.width, width, 'Must exercise actual mobile CSS viewport, not a cropped desktop window');
    assert.ok(metrics.scroll <= width, `${label}: horizontal page overflow ${metrics.scroll} > ${width}`);
    const html = (await send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true })).result.value;
    const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(output, label + '.png'), Buffer.from(screenshot.data, 'base64'));
    return html;
  };
  try { return await Promise.race([work(), timedOut]); }
  finally { clearTimeout(timer); if (socket) socket.close(); child.kill(); }
}
try {
  for (const [width, label] of [[1440, 'desktop'], [390, 'mobile']]) {
    const html = await render('/api-docs', width, label);
    assert.ok(html.includes('Conecta tu sistema con FactuEz'));
    assert.ok(html.includes('Runtime no verificado'));
    assert.ok(html.includes('href="/api-docs/swagger"'));
    assert.ok(html.includes('id="webhooks"'));
    assert.ok(!html.includes('sunat.json'));
  }
  await render('/api-docs/swagger', 390, 'swagger-mobile');
  const html = await render('/api-docs/swagger', 1440, 'swagger');
  assert.ok(!html.includes('Failed to load API definition'));
  assert.ok(!html.includes('OpenAPI.jsonSchemaDialect field contains a value different'));
  const count = (html.match(/class="opblock opblock-(?:get|post|patch)(?:\s|")/g) ?? []).length;
  assert.equal(count, 25, 'All 25 contract operations must render');
  assert.ok(!/class="[^"]*execute opblock-control__btn/.test(html));
  assert.ok(requests.includes('/api-docs/openapi.json'));
  assert.deepEqual(unexpected, [], 'No business or external API request allowed');
  console.log(JSON.stringify({ status: 'PASS', operations: count, widths: [1440, 390], businessRuntime: false, screenshots: ['desktop', 'mobile', 'swagger', 'swagger-mobile'].map(name => join(output, name + '.png')) }));
} finally { await new Promise(resolve => server.close(resolve)); }
