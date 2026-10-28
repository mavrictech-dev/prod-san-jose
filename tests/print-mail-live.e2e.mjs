// Sólo QA local 8091: sin envíos a SUNAT, SMTP externo ni impresión física.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
if (!process.argv.includes('--isolated-only')) throw new Error('Use --isolated-only');
const webRequire = createRequire(new URL('../apps/web-pwa/package.json', import.meta.url));
const { io } = webRequire('socket.io-client');
const base = 'http://127.0.0.1:8091';
async function call(path, token, body, method = body ? 'POST' : 'GET') {
  return fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(40000) });
}
async function json(response, status = 200) { assert.equal(response.status, status, `HTTP ${response.status}`); return response.json(); }
const password = (await readFile(new URL('../.factuez-demo/secrets/initial_admin_password.txt', import.meta.url), 'utf8')).trim();
const { accessToken: admin } = await json(await call('/api/v1/auth/login', undefined, { username: 'demo.admin', password }));
const catalog = await json(await call('/api/v1/documents/catalog/issuance', admin));
assert.equal(catalog.capabilities.demoData, true); assert.equal(catalog.capabilities.fiscalTransmission, false);
// El recorrido ampliado crea certificado/ventas nuevos; preferir esa evidencia
// evita depender de un PKCS#12 ficticio vencido del circuito histórico.
let fixture;
try {
  const prepared=JSON.parse(await readFile('tmp/stage2-prepared/proof.json','utf8'));
  const invoice=prepared.documents?.find(d=>d.type==='INVOICE');
  assert.match(invoice?.id??'',/^[0-9a-f-]{36}$/i);assert.match(prepared.originBranchId??'',/^[0-9a-f-]{36}$/i);
  fixture={ruc:prepared.ruc,pdfDocumentId:invoice.id,branchId:prepared.originBranchId};
} catch(error) {
  if(error.code!=='ENOENT')throw error;
  fixture=JSON.parse(await readFile('tmp/circuit-qa/proof.json','utf8'));
}
assert.match(fixture.ruc, /^00\d{9}$/); const documentId = fixture.pdfDocumentId;
const detail = await json(await call(`/api/v1/documents/${documentId}`, admin)); assert.equal(detail.immutableSnapshot.issuer.identityNumber, fixture.ruc);
const point = catalog.emissionPoints.find(p => p.branchId === fixture.branchId); assert.ok(point);
const foreignPoint = catalog.emissionPoints.find(p => p.branchId !== fixture.branchId); assert.ok(foreignPoint);
const suffix = randomBytes(4).toString('hex'), testPassword = randomBytes(24).toString('base64url');
const accounts = [], sockets = [], events = { admin: [], cashier: [], foreign: [] };
async function openSocket(token, origin = base) {
  const socket = io(base, { path: '/socket.io', transports: ['websocket'], auth: token ? { token } : {}, extraHeaders: { Origin: origin }, reconnection: false, timeout: 5000 }); sockets.push(socket);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); }); return socket;
}
try {
  for (const [label, selected] of [['cashier', point], ['foreign', foreignPoint]]) {
    const user = await json(await call('/api/v1/users', admin, { username: `qa.live.${label}.${suffix}`, fullName: 'PRUEBA temporal correo/socket', password: testPassword, roles: ['CASHIER'], branchIds: [selected.branchId], emissionPointIds: [selected.id], series: selected.series.map(s => s.id) }), 201);
    accounts.push(user); const { accessToken } = await json(await call('/api/v1/auth/login', undefined, { username: user.username, password: testPassword })); user.token = accessToken;
  }
  await assert.rejects(openSocket(undefined)); await assert.rejects(openSocket(admin, 'http://host.invalid'));
  const adminSocket = await openSocket(admin), cashierSocket = await openSocket(accounts[0].token), foreignSocket = await openSocket(accounts[1].token);
  for (const [socket, label] of [[adminSocket,'admin'],[cashierSocket,'cashier'],[foreignSocket,'foreign']]) socket.on('document.changed.v1', value => events[label].push(value));
  const mailPath = `/api/v1/mail-qa/${documentId}`;
  assert.equal((await call(mailPath)).status, 401);
  assert.equal((await call(mailPath, accounts[0].token, { recipient: 'qa@pruebas.invalid' })).status, 403);
  assert.equal((await call(mailPath, admin, { recipient: 'cliente@real.pe' })).status, 400);
  assert.equal((await call(mailPath, admin, { recipient: 'qa@pruebas.invalid\r\nBcc:otro@pruebas.invalid' })).status, 400);
  const body = { recipient: `qa.${suffix}@pruebas.invalid`, format: 'ticket' };
  const sent = await json(await call(mailPath, admin, body), 201);
  const repeated = await Promise.all([call(mailPath, admin, body).then(r => json(r,201)), call(mailPath, admin, body).then(r => json(r,201))]);
  assert.ok(repeated.every(row => row.id === sent.id)); assert.equal(sent.deliveredToClient,false); assert.equal(sent.officialCdr,false);
  assert.equal(sent.attachments.length,2); assert.match(sent.attachments[0].filename,/-SIMULADO.pdf$/); assert.match(sent.attachments[1].filename,/-XML-CDR-SIMULADO.zip$/);
  let captured;
  for (let i=0;i<60;i++) {
    const value = await json(await call(mailPath,admin)); captured = value.deliveries.find(row => row.id === sent.id);
    if (captured?.status === 'CAPTURED_LOCAL' && events.admin.some(e=>e.documentId===documentId) && events.cashier.some(e=>e.documentId===documentId)) break;
    assert.ok(!['FAILED','UNKNOWN'].includes(captured?.status)); await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert.equal(captured.status,'CAPTURED_LOCAL');
  assert.ok(events.admin.some(e=>e.documentId===documentId)); assert.ok(events.cashier.some(e=>e.documentId===documentId)); assert.equal(events.foreign.length,0);
  for (const event of [...events.admin,...events.cashier]) assert.deepEqual(Object.keys(event).sort(),['documentId','eventId']);
  const pdf = await call(`/api/v1/fiscal-circuit-qa/${documentId}/ticket`,admin); assert.equal(pdf.status,200); assert.match(pdf.headers.get('cache-control'),/no-store/); assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,5).toString(),'%PDF-');
  assert.equal((await call(`/api/v1/fiscal-circuit-qa/${documentId}/ticket`)).status,401);
  const disconnected = new Promise(resolve => cashierSocket.once('disconnect',resolve));
  await json(await call(`/api/v1/users/${accounts[0].id}/access`,admin,{active:false},'PATCH'));
  await Promise.race([disconnected,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Socket revocado no se cerró')),22000))]);
  assert.equal(cashierSocket.connected,false); assert.equal((await call('/api/v1/auth/me',accounts[0].token)).status,401);
  const proof = { documentId,ruc:fixture.ruc,mailId:sent.id,recipient:body.recipient,status:captured.status,attachments:sent.attachments,websocket:true,scopeIsolation:true,revocation:true,externalMail:false,physicalPrint:false };
  await mkdir('tmp/print-mail-live',{recursive:true}); await writeFile('tmp/print-mail-live/proof.json',JSON.stringify(proof,null,2));
  console.log('OK QA: correo local capturado, dos adjuntos, replay sin duplicar, Socket.io por Kong, ámbito ajeno sin eventos y revocación desconectada. PDF protegido; impresión física no probada.');
} finally {
  for (const socket of sockets) socket.disconnect();
  for (const account of accounts) assert.equal((await call(`/api/v1/users/${account.id}/access`,admin,{active:false},'PATCH')).status,200);
}
