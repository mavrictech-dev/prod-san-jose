// Prueba integrada SOLO demo: crea sedes/series de prueba y conserva los documentos.
// Desactiva al terminar las cuentas temporales. Nunca transmite a SUNAT.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
const base = (process.env.FACTUEZ_TEST_URL ?? "http://127.0.0.1:8080").replace(
  /\/$/,
  "",
);
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base))
  throw new Error("La prueba sólo admite un demo local");
async function call(path, token, body, method = body ? "POST" : "GET", key) {
  const response = await fetch(base + path, {
    method,
    headers: {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => null),
  };
}
function ok(result, status = 200) {
  assert.equal(
    result.status,
    status,
    `HTTP ${result.status}: ${result.body?.message ?? "Respuesta inesperada"}`,
  );
  return result.body;
}
const adminPassword = (
  await readFile(
    new URL(
      "../.factuez-demo/secrets/initial_admin_password.txt",
      import.meta.url,
    ),
    "utf8",
  )
).trim();
const admin = ok(
  await call("/api/v1/auth/login", undefined, {
    username: "demo.admin",
    password: adminPassword,
  }),
).accessToken;
const catalog = ok(await call("/api/v1/documents/catalog/issuance", admin));
assert.equal(
  catalog.capabilities?.demoData,
  true,
  "Se rechaza ejecutar fuera del demo",
);
const issuer = catalog.companies.find(
  (company) => company.ruc === "20450819230",
);
assert.ok(issuer, "Falta el emisor demo esperado");
assert.equal(issuer.environment, "BETA", "Se rechaza ejecutar en producción");
const suffix = randomBytes(4).toString("hex");
const testPassword = randomBytes(20).toString("base64url");
const cleanup = [];
try {
  const branches = [];
  const points = [];
  const used = new Set(
    catalog.emissionPoints.flatMap((point) =>
      point.series.map((counter) => counter.series),
    ),
  );
  for (const side of ["A", "B"]) {
    const branch = ok(
      await call("/api/v1/stations", admin, {
        companyId: issuer.id,
        code: `QA${side}_${suffix}`,
        name: `PRUEBA Etapa1 ${side} ${suffix}`,
      }),
      201,
    );
    branches.push(branch);
    let code;
    do {
      code = randomBytes(3).toString("hex").slice(0, 3).toUpperCase();
    } while (used.has("F" + code) || used.has("B" + code));
    used.add("F" + code);
    used.add("B" + code);
    const point = ok(
      await call(`/api/v1/stations/${branch.id}/points`, admin, {
        code: `QA${side}_${suffix}`,
        name: `Caja de prueba ${side}`,
        invoiceSeries: "F" + code,
        receiptSeries: "B" + code,
      }),
      201,
    );
    points.push({
      ...point,
      invoiceSeries: "F" + code,
      receiptSeries: "B" + code,
    });
  }
  const scopeA = {
    branchIds: [branches[0].id],
    emissionPointIds: [points[0].id],
    series: points[0].series.map((counter) => counter.id),
  };
  async function account(role, scope, label) {
    const username = `qa.${label}.${suffix}`;
    const user = ok(
      await call("/api/v1/users", admin, {
        username,
        fullName: `PRUEBA ${label} ${suffix}`,
        password: testPassword,
        roles: [role],
        ...scope,
      }),
      201,
    );
    cleanup.push(user.id);
    return {
      id: user.id,
      token: ok(
        await call("/api/v1/auth/login", undefined, {
          username,
          password: testPassword,
        }),
      ).accessToken,
    };
  }
  const cashier = await account("CASHIER", scopeA, "cajero");
  const manager = await account("STATION_MANAGER", scopeA, "jefe");
  const empty = await account(
    "TRACK_OPERATOR",
    { ...scopeA, emissionPointIds: [], series: [] },
    "sinpuntos",
  );
  const localCatalog = ok(
    await call("/api/v1/documents/catalog/issuance", cashier.token),
  );
  assert.deepEqual(
    localCatalog.branches.map((branch) => branch.id),
    [branches[0].id],
  );
  assert.deepEqual(
    localCatalog.emissionPoints.map((point) => point.id),
    [points[0].id],
  );
  assert.equal(
    ok(await call("/api/v1/documents/catalog/issuance", empty.token))
      .emissionPoints.length,
    0,
  );
  assert.equal(
    (await call(`/api/v1/documents?branchId=${branches[1].id}`, cashier.token))
      .status,
    403,
  );
  assert.equal((await call("/api/v1/users", cashier.token)).status, 403);
  const lines = [
    {
      description: "Diesel B5 · TEST",
      unitCode: "GLL",
      quantity: "1",
      unitPriceWithTax: "18.50",
      taxAffectationCode: "10",
      igvRate: "18",
    },
  ];
  const body = {
    documentType: "SALES_RECEIPT",
    currencyCode: "PEN",
    emissionPointId: points[0].id,
    series: points[0].receiptSeries,
    customer: {
      identityType: "0",
      identityNumber: "0",
      legalName: "CONSUMIDOR FINAL PRUEBA",
    },
    lines,
  };
  const key = randomUUID();
  const first = ok(
    await call("/api/v1/documents", cashier.token, body, "POST", key),
    202,
  );
  const replay = ok(
    await call("/api/v1/documents", cashier.token, body, "POST", key),
    202,
  );
  assert.equal(first.documentId, replay.documentId);
  assert.equal(first.fullNumber, replay.fullNumber);
  ok(await call(`/api/v1/documents/${first.documentId}`, cashier.token));
  assert.equal(
    (await call(`/api/v1/documents/${first.documentId}`, empty.token)).status,
    404,
  );
  assert.equal(
    (
      await call(
        `/api/v1/fiscal-artifacts/${first.documentId}/ticket`,
        empty.token,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await call(
        "/api/v1/documents",
        cashier.token,
        {
          ...body,
          emissionPointId: points[1].id,
          series: points[1].receiptSeries,
        },
        "POST",
        randomUUID(),
      )
    ).status,
    403,
  );
  assert.equal(
    (await call("/api/v1/documents", empty.token, body, "POST", randomUUID()))
      .status,
    403,
  );
  assert.equal(
    (
      await call("/api/v1/users", manager.token, {
        username: `qa.elevado.${suffix}`,
        fullName: "Elevación no permitida",
        password: testPassword,
        roles: ["ADMIN"],
        branchIds: [],
        emissionPointIds: [],
        series: [],
      })
    ).status,
    403,
  );
  const delegable = await call("/api/v1/users", manager.token, {
    username: `qa.delegado.${suffix}`,
    fullName: "PRUEBA Delegado local",
    password: testPassword,
    roles: ["TRACK_OPERATOR"],
    ...scopeA,
  });
  cleanup.push(ok(delegable, 201).id);
  assert.equal(
    (
      await call(
        `/api/v1/users/${cashier.id}/access`,
        manager.token,
        { branchIds: [branches[1].id] },
        "PATCH",
      )
    ).status,
    403,
  );
  ok(
    await call(
      `/api/v1/users/${cashier.id}/access`,
      admin,
      { active: false },
      "PATCH",
    ),
  );
  assert.equal((await call("/api/v1/auth/me", cashier.token)).status, 401);
  assert.equal((await call("/api/v1/documents", cashier.token)).status, 401);
  assert.equal(
    (
      await call(
        `/api/v1/fiscal-artifacts/${first.documentId}/ticket`,
        cashier.token,
      )
    ).status,
    401,
  );
  console.log(
    "OK: login, sedes, series, emisión local, idempotencia, delegación y revocación a través de Kong.",
  );
  console.log(
    "Se conservaron sedes y documento rotulados PRUEBA para trazabilidad.",
  );
} finally {
  for (const id of cleanup) {
    try {
      const result = await call(
        `/api/v1/users/${id}/access`,
        admin,
        { active: false },
        "PATCH",
      );
      if (result.status !== 200)
        console.error("Una cuenta de prueba no pudo desactivarse:", id);
    } catch {
      console.error("Una cuenta de prueba no pudo desactivarse:", id);
    }
  }
}
