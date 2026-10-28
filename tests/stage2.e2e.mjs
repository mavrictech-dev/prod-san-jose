// QA exclusivamente en el puerto reservado del Compose aislado, nunca en 8080.
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const base = "http://127.0.0.1:8091";
if (!process.argv.includes("--isolated-only"))
  throw new Error("Indique --isolated-only");
async function call(path, token, body, key) {
  return fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
}
async function json(response, expected = 200) {
  assert.equal(response.status, expected, `HTTP inesperado ${response.status}`);
  return response.json();
}
const password = (
  await readFile(
    new URL(
      "../.factuez-demo/secrets/initial_admin_password.txt",
      import.meta.url,
    ),
    "utf8",
  )
).trim();
const { accessToken } = await json(
  await call("/api/v1/auth/login", undefined, {
    username: "demo.admin",
    password,
  }),
);
const catalog = await json(
  await call("/api/v1/documents/catalog/issuance", accessToken),
);
assert.equal(catalog.capabilities.demoData, true);
assert.equal(catalog.capabilities.fiscalTransmission, false);
assert.ok(catalog.companies.every((issuer) => issuer.environment === "BETA"));
const point = catalog.emissionPoints.find(
  (point) =>
    point.series.some((s) => s.documentType === "SALES_RECEIPT") &&
    point.series.some((s) => s.documentType === "INVOICE"),
);
assert.ok(point);
await mkdir("tmp/pdfs/e2e", { recursive: true });
for (const type of ["SALES_RECEIPT", "INVOICE"]) {
  const key = randomUUID();
  const body = {
    emissionPointId: point.id,
    documentType: type,
    series: point.series.find((s) => s.documentType === type).series,
    customer: {
      identityType: type === "INVOICE" ? "6" : "0",
      identityNumber: type === "INVOICE" ? "20450819230" : "0",
      legalName: "CLIENTE QA - SIN USO FISCAL",
    },
    lines: [
      {
        description: "Diésel B5 - PRUEBA DOCKER AISLADA",
        quantity: "2.500000",
        unitCode: "GLL",
        unitPriceWithTax: "18.500000",
        taxAffectationCode: "10",
        igvRate: "18",
      },
    ],
  };
  const issued = await json(
    await call("/api/v1/documents", accessToken, body, key),
    202,
  );
  const repeated = await json(
    await call("/api/v1/documents", accessToken, body, key),
    202,
  );
  assert.equal(issued.documentId, repeated.documentId);
  const detail = await json(
    await call(`/api/v1/documents/${issued.documentId}`, accessToken),
  );
  assert.equal(detail.immutableSnapshot.documentId, issued.documentId);
  assert.deepEqual(detail.immutableSnapshot.totals, {
    taxableAmount: "39.19",
    igvAmount: "7.06",
    payableAmount: "46.25",
  });
  assert.equal(
    (await call(`/api/v1/fiscal-artifacts/${issued.documentId}/ticket`)).status,
    401,
  );
  for (const format of ["ticket", "a4"]) {
    let response;
    for (let attempt = 0; attempt < 30; attempt++) {
      response = await call(
        `/api/v1/fiscal-artifacts/${issued.documentId}/${format}`,
        accessToken,
      );
      if (response.status === 200) break;
      assert.equal(
        response.status,
        409,
        "Sólo se espera PDF pendiente, no un fallo de autenticación/servicio",
      );
      await response.arrayBuffer();
      await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
    }
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^application\/pdf/);
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.match(response.headers.get("content-disposition"), /PRUEBA\.pdf/);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
    await writeFile(`tmp/pdfs/e2e/${type}-${format}.pdf`, bytes);
  }
  // Billing expone PROCESSING; BUILDING es el estado interno de SUNAT-service.
  // La proyección es asíncrona y puede llegar después de los artefactos.
  let final;
  for (let attempt = 0; attempt < 20; attempt++) {
    final = await json(
      await call(`/api/v1/documents/${issued.documentId}`, accessToken),
    );
    if (final.sunatStatus === "PROCESSING") break;
    assert.ok(["QUEUED", "PENDING"].includes(final.sunatStatus));
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  assert.equal(final.sunatStatus, "PROCESSING");
  assert.match(final.sunatResponseDescription, /UBL y PDF locales preparados/);
  assert.equal(final.fiscalTransmission, false);
  console.log(
    `OK ${type}: idempotencia, detalle autorizado, ticket y A4 por Kong; estado local PROCESSING, sin transmisión`,
  );
}
