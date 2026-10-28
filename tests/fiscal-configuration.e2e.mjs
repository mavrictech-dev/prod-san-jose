// Sólo Compose QA 8091, datos/certificado ficticios y cero llamadas a SUNAT.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes, generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(new URL("../services/sunat-service/package.json", import.meta.url));
const forge = require("node-forge");
const base = "http://127.0.0.1:8091";
if (!process.argv.includes("--isolated-only")) throw new Error("Indique --isolated-only");
async function call(path, token, body, method = body ? "POST" : "GET") {
  return fetch(base + path, { method, headers: {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(body ? { "Content-Type": "application/json" } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
}
async function json(response, expected = 200) {
  assert.equal(response.status, expected, `HTTP inesperado ${response.status}`);
  return response.json();
}
const password = (await readFile(new URL("../.factuez-demo/secrets/initial_admin_password.txt", import.meta.url), "utf8")).trim();
const { accessToken: admin } = await json(await call("/api/v1/auth/login", undefined, { username: "demo.admin", password }));
const catalog = await json(await call("/api/v1/documents/catalog/issuance", admin));
assert.equal(catalog.capabilities.demoData, true); assert.equal(catalog.capabilities.fiscalTransmission, false);
assert.ok(catalog.companies.every(company => company.environment === "BETA"));
const suffix = randomBytes(4).toString("hex");
const fakeSecret = `ONLY-QA-${randomBytes(20).toString("base64url")}`;
let cashier;
try {
  const issuers = [];
  for (const label of ["A", "B"]) {
    const ruc = "00" + String(BigInt("0x" + randomBytes(5).toString("hex")) % 1000000000n).padStart(9, "0");
    const issuer = await json(await call("/api/v1/stations/issuers", admin, {
      ruc, legalName: `PRUEBA CONFIG FICTICIA ${label} ${suffix}`, taxAddress: "FICTICIA - SIN USO FISCAL", ubigeo: "200101",
    }), 201);
    issuers.push(issuer);
  }
  const path = `/api/v1/setup/sunat/${issuers[0].id}/BETA`;
  assert.equal((await call(path)).status, 401);
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const privateKey = forge.pki.privateKeyFromPem(pair.privateKey);
  const cert = forge.pki.createCertificate(); cert.publicKey = forge.pki.publicKeyFromPem(pair.publicKey);
  cert.serialNumber = "01"; cert.validity.notBefore = new Date(Date.now() - 3600000); cert.validity.notAfter = new Date(Date.now() + 86400000);
  cert.setSubject([{ name: "commonName", value: "FICTICIO QA NO VALIDO SUNAT" }]); cert.setIssuer(cert.subject.attributes);
  cert.setExtensions([{ name: "basicConstraints", cA: false }, { name: "keyUsage", digitalSignature: true }]); cert.sign(privateKey, forge.md.sha256.create());
  const certificate = Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(privateKey, cert, fakeSecret, { algorithm: "aes256" })).getBytes(), "binary");
  const payload = { expectedRevision: 0,
    certificate: { fileName: "QA-FICTICIO.p12", base64: certificate.toString("base64"), password: fakeSecret },
    sol: { username: "QAUSER", password: fakeSecret }, gre: { clientId: "QA-CLIENT", clientSecret: fakeSecret },
  };
  const saved = await json(await call(path, admin, payload), 201);
  assert.equal(saved.revision, 1); assert.equal(saved.certificate.configured, true);
  assert.equal(saved.certificate.selfSigned, true); assert.equal(saved.certificate.trustAndRucVerified, false);
  assert.equal(saved.fiscalTransmission, false); assert.equal(saved.solConfigured, true); assert.equal(saved.greConfigured, true);
  assert.doesNotMatch(JSON.stringify(saved), /Cipher|StorageKey|password|base64/);
  assert.ok(!JSON.stringify(saved).includes(fakeSecret));
  const response = await call(path, admin);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal((await json(response)).revision, 1);
  assert.equal((await call(path, admin, payload)).status, 409);
  assert.equal((await call(path, admin, { expectedRevision: 1, sol: { username: "QAUSER" } })).status, 400);
  assert.equal((await call(path, admin, { expectedRevision: 1, certificate: { fileName: "invalid.p12", base64: "YWJj", password: fakeSecret } })).status, 400);
  const updated = await json(await call(path, admin, { expectedRevision: 1, sol: { username: "QAUSER2", password: fakeSecret } }), 201);
  assert.equal(updated.revision, 2); assert.equal(updated.certificate.fingerprint, saved.certificate.fingerprint);
  assert.equal(updated.greConfigured, true);
  for (const target of [`/api/v1/setup/sunat/${issuers[0].id}/PRODUCTION`, `/api/v1/setup/sunat/${issuers[1].id}/BETA`]) {
    const empty = await json(await call(target, admin));
    assert.equal(empty.revision, 0); assert.equal(empty.certificate.configured, false); assert.equal(empty.solConfigured, false);
  }
  const point = catalog.emissionPoints[0]; assert.ok(point);
  cashier = await json(await call("/api/v1/users", admin, {
    username: `qa.config.${suffix}`, fullName: "PRUEBA permisos de configuración", password: fakeSecret,
    roles: ["CASHIER"], branchIds: [point.branchId], emissionPointIds: [point.id], series: point.series.map(counter => counter.id),
  }), 201);
  const { accessToken } = await json(await call("/api/v1/auth/login", undefined, { username: cashier.username, password: fakeSecret }));
  assert.equal((await call(path, accessToken)).status, 403);
  assert.equal((await call(path, accessToken, payload)).status, 403);
  await json(await call(`/api/v1/users/${cashier.id}/access`, admin, { active: false }, "PATCH"));
  assert.equal((await call(path, accessToken)).status, 401);
  const after = await json(await call("/api/v1/documents/catalog/issuance", admin));
  assert.equal(after.capabilities.fiscalTransmission, false);
  assert.equal(after.companies.find(company => company.id === issuers[0].id).environment, "BETA");
  certificate.fill(0);
  console.log("OK configuración por Kong: certificado ficticio, SOL/GRE cifrados, revisión, actualización parcial, aislamiento RUC/ambiente, 401/403 y revocación. Cero transmisión fiscal.");
} finally {
  if (cashier) await json(await call(`/api/v1/users/${cashier.id}/access`, admin, { active: false }, "PATCH"));
}
