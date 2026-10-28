// Prueba de migración con PostgreSQL real, SOLO en un contenedor efímero sin red/volúmenes.
// No conecta con FactuEz en 8080 ni con SUNAT y no lee credenciales del usuario.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
if (!process.argv.includes("--isolated-db-only"))
  throw new Error("Se requiere --isolated-db-only");
const name = "factuez-multi-ruc-qa-" + randomBytes(5).toString("hex");
let containerId;
function docker(args, input = "", expectedFailure = false) {
  const result = spawnSync("docker", args, {
    input,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (expectedFailure) {
    assert.notEqual(
      result.status,
      0,
      "Debía rechazarse una operación inconsistente",
    );
    return result.stderr;
  }
  if (result.status !== 0)
    throw new Error(result.stderr || "Fallo Docker/PostgreSQL QA");
  return result.stdout.trim();
}
function sql(database, statement, expectedFailure = false) {
  return docker(
    [
      "exec",
      "-i",
      containerId,
      "psql",
      "-U",
      "postgres",
      "-d",
      database,
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
    ],
    statement,
    expectedFailure,
  );
}
try {
  containerId = docker([
    "run",
    "--rm",
    "-d",
    "--network",
    "none",
    "--tmpfs",
    "/var/lib/postgresql/data:rw",
    "--label",
    "factuez.qa=multi-ruc",
    "--name",
    name,
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "postgres:17-alpine",
  ]);
  assert.match(containerId, /^[a-f0-9]{64}$/);
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = spawnSync(
      "docker",
      ["exec", containerId, "pg_isready", "-U", "postgres"],
      { encoding: "utf8", timeout: 5000 },
    );
    if (result.status === 0) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(ready, "PostgreSQL QA no inició");
  sql(
    "postgres",
    "CREATE DATABASE qa_billing; CREATE DATABASE qa_sunat; CREATE DATABASE qa_identity;",
  );
  sql(
    "qa_billing",
    `
    CREATE TYPE "DocumentType" AS ENUM ('INVOICE','SALES_RECEIPT','CREDIT_NOTE','DEBIT_NOTE','DESPATCH_ADVICE');
    CREATE TABLE "CompanySettings" ("id" INTEGER PRIMARY KEY DEFAULT 1, "ruc" CHAR(11) NOT NULL UNIQUE);
    CREATE TABLE "Branch" ("id" UUID PRIMARY KEY, "companyId" INTEGER NOT NULL DEFAULT 1 REFERENCES "CompanySettings"("id"));
    CREATE TABLE "EmissionPoint" ("id" UUID PRIMARY KEY, "companyId" INTEGER NOT NULL REFERENCES "CompanySettings"("id"), "branchId" UUID,
      CONSTRAINT "EmissionPoint_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE);
    CREATE TABLE "SeriesCounter" ("id" UUID PRIMARY KEY, "emissionPointId" UUID NOT NULL, "documentType" "DocumentType" NOT NULL, "series" VARCHAR(4) NOT NULL, "nextNumber" BIGINT NOT NULL,
      CONSTRAINT "SeriesCounter_emissionPointId_fkey" FOREIGN KEY ("emissionPointId") REFERENCES "EmissionPoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE);
    CREATE UNIQUE INDEX "SeriesCounter_documentType_series_key" ON "SeriesCounter"("documentType","series");
    CREATE TABLE "Document" ("id" UUID PRIMARY KEY, "emissionPointId" UUID NOT NULL, "type" "DocumentType" NOT NULL, "series" VARCHAR(4) NOT NULL, "number" BIGINT NOT NULL, "fullNumber" TEXT NOT NULL, "immutableSnapshot" JSONB NOT NULL, "originSystem" TEXT, "originId" TEXT,
      CONSTRAINT "Document_emissionPointId_fkey" FOREIGN KEY ("emissionPointId") REFERENCES "EmissionPoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE);
    CREATE UNIQUE INDEX "Document_type_series_number_key" ON "Document"("type","series","number");
    CREATE UNIQUE INDEX "Document_originSystem_originId_key" ON "Document"("originSystem","originId");
    CREATE TABLE "DailySummary" ("id" UUID PRIMARY KEY, "emissionPointId" UUID NOT NULL, "referenceDate" DATE NOT NULL, "sequence" INTEGER NOT NULL, "identifier" TEXT NOT NULL,
      CONSTRAINT "DailySummary_emissionPointId_fkey" FOREIGN KEY ("emissionPointId") REFERENCES "EmissionPoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE);
    CREATE UNIQUE INDEX "DailySummary_identifier_key" ON "DailySummary"("identifier");
    CREATE UNIQUE INDEX "DailySummary_referenceDate_sequence_key" ON "DailySummary"("referenceDate","sequence");
    CREATE TABLE "ConfigurationAudit" ("id" UUID PRIMARY KEY, "entityId" UUID NOT NULL);
    INSERT INTO "CompanySettings" VALUES(1,'20450819230');
    INSERT INTO "Branch" VALUES('10000000-0000-4000-8000-000000000001',1);
    INSERT INTO "EmissionPoint" VALUES('20000000-0000-4000-8000-000000000001',1,'10000000-0000-4000-8000-000000000001');
    INSERT INTO "SeriesCounter" VALUES('40000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','INVOICE','F001',8);
    INSERT INTO "Document" VALUES('50000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','INVOICE','F001',7,'F001-7','{"issuer":{"identityNumber":"20450819230"},"environment":"BETA"}','QA','7');
  `,
  );
  const originalSnapshot = sql(
    "qa_billing",
    'SELECT "immutableSnapshot"::text FROM "Document";',
  );
  sql(
    "qa_identity",
    `
    CREATE TABLE "User" ("id" UUID PRIMARY KEY, "authVersion" INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE "UserSeries" ("userId" UUID NOT NULL REFERENCES "User", "series" VARCHAR(4) NOT NULL, PRIMARY KEY("userId","series"));
    CREATE TABLE "RefreshSession" ("id" UUID PRIMARY KEY, "userId" UUID NOT NULL REFERENCES "User", "revokedAt" TIMESTAMPTZ);
    INSERT INTO "User" VALUES('30000000-0000-4000-8000-000000000001',1);
    INSERT INTO "UserSeries" VALUES('30000000-0000-4000-8000-000000000001','F001');
    INSERT INTO "RefreshSession" VALUES('60000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',NULL);
  `,
  );
  sql(
    "qa_sunat",
    `
    CREATE TYPE "SunatEnvironment" AS ENUM ('BETA','PRODUCTION');
    CREATE TABLE "IssuerProjection" ("id" INTEGER PRIMARY KEY DEFAULT 1, "ruc" CHAR(11) NOT NULL UNIQUE, "environment" "SunatEnvironment" NOT NULL);
    CREATE TABLE "SunatCredentials" ("id" INTEGER PRIMARY KEY DEFAULT 1, "solPasswordCipher" TEXT);
    CREATE TABLE "FiscalDocument" ("documentId" UUID PRIMARY KEY, "environment" "SunatEnvironment" NOT NULL, "documentType" TEXT NOT NULL, "series" TEXT NOT NULL, "number" BIGINT NOT NULL, "immutablePayload" JSONB NOT NULL);
    CREATE UNIQUE INDEX "FiscalDocument_environment_documentType_series_number_key" ON "FiscalDocument"("environment","documentType","series","number");
    CREATE TABLE "FiscalBatch" ("id" UUID PRIMARY KEY, "identifier" TEXT NOT NULL, "environment" "SunatEnvironment" NOT NULL, "immutablePayload" JSONB NOT NULL);
    CREATE UNIQUE INDEX "FiscalBatch_identifier_key" ON "FiscalBatch"("identifier");
    INSERT INTO "IssuerProjection" VALUES(1,'20450819230','BETA');
    INSERT INTO "SunatCredentials" VALUES(1,'TEST-NOT-CREDENTIAL');
    INSERT INTO "FiscalDocument" VALUES('50000000-0000-4000-8000-000000000001','BETA','01','F001',7,'{"issuer":{"identityNumber":"20450819230"},"environment":"BETA"}');
  `,
  );
  for (const service of ["billing", "identity", "sunat"]) {
    const script = await readFile(
      new URL(
        `../services/${service}-service/prisma/multi-issuer-expand.sql`,
        import.meta.url,
      ),
      "utf8",
    );
    sql("qa_" + service, script);
  }
  assert.equal(
    sql("qa_billing", 'SELECT "immutableSnapshot"::text FROM "Document";'),
    originalSnapshot,
  );
  assert.equal(
    sql(
      "qa_billing",
      'SELECT "companyId" || \'|\' || "nextNumber" FROM "SeriesCounter";',
    ),
    "1|8",
  );
  assert.equal(
    sql(
      "qa_billing",
      'SELECT "companyId" || \'|\' || "fullNumber" FROM "Document";',
    ),
    "1|F001-7",
  );
  assert.equal(sql("qa_identity", 'SELECT "authVersion" FROM "User";'), "2");
  assert.equal(
    sql("qa_identity", 'SELECT "revokedAt" IS NOT NULL FROM "RefreshSession";'),
    "t",
  );
  assert.equal(
    sql("qa_identity", 'SELECT "series" FROM "UserSeries";'),
    "F001",
  );
  assert.equal(
    sql(
      "qa_sunat",
      'SELECT "issuerRuc" || \'|\' || "environment" FROM "SunatCredentials";',
    ),
    "20450819230|BETA",
  );
  sql(
    "qa_billing",
    `
    INSERT INTO "CompanySettings"("ruc") VALUES('00000000000');
    INSERT INTO "Branch" VALUES('10000000-0000-4000-8000-000000000002',2);
    INSERT INTO "EmissionPoint" VALUES('20000000-0000-4000-8000-000000000002',2,'10000000-0000-4000-8000-000000000002');
    INSERT INTO "SeriesCounter"("id","companyId","emissionPointId","documentType","series","nextNumber") VALUES('40000000-0000-4000-8000-000000000002',2,'20000000-0000-4000-8000-000000000002','INVOICE','F001',1);
    INSERT INTO "Document"("id","companyId","seriesCounterId","emissionPointId","type","series","number","fullNumber","immutableSnapshot","originSystem","originId")
      VALUES('50000000-0000-4000-8000-000000000002',2,'40000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','INVOICE','F001',7,'F001-7','{"issuer":{"identityNumber":"00000000000"},"environment":"BETA"}','QA','7');
  `,
  );
  assert.equal(
    sql(
      "qa_billing",
      'SELECT COUNT(*) FROM "Document" WHERE "fullNumber" = \'F001-7\';',
    ),
    "2",
  );
  const forbiddenBranch = sql(
    "qa_billing",
    'UPDATE "Branch" SET "companyId" = 2 WHERE "id" = \'10000000-0000-4000-8000-000000000001\';',
    true,
  );
  assert.match(forbiddenBranch, /foreign key constraint/i);
  const forbiddenPoint = sql(
    "qa_billing",
    'UPDATE "EmissionPoint" SET "branchId" = \'10000000-0000-4000-8000-000000000002\' WHERE "id" = \'20000000-0000-4000-8000-000000000001\';',
    true,
  );
  assert.match(forbiddenPoint, /foreign key constraint/i);
  const forbiddenDocument = sql(
    "qa_billing",
    'UPDATE "Document" SET "companyId" = 2, "number" = 99, "originId" = \'99\' WHERE "id" = \'50000000-0000-4000-8000-000000000001\';',
    true,
  );
  assert.match(forbiddenDocument, /foreign key constraint/i);
  sql(
    "qa_sunat",
    `INSERT INTO "FiscalDocument"("documentId","issuerRuc","environment","documentType","series","number","immutablePayload") VALUES('50000000-0000-4000-8000-000000000002','00000000000','BETA','01','F001',7,'{"issuer":{"identityNumber":"00000000000"},"environment":"BETA"}');`,
  );
  assert.equal(sql("qa_sunat", 'SELECT COUNT(*) FROM "FiscalDocument";'), "2");
  // Un snapshot no resoluble revierte toda la migración, no se asigna al RUC por defecto.
  sql("postgres", "CREATE DATABASE qa_unresolved TEMPLATE qa_billing;");
  sql(
    "qa_unresolved",
    'ALTER TABLE "Document" ALTER COLUMN "companyId" DROP NOT NULL; UPDATE "Document" SET "companyId" = NULL, "immutableSnapshot" = \'{"issuer":{"identityNumber":"99999999999"}}\' WHERE "id" = \'50000000-0000-4000-8000-000000000002\';',
  );
  const rejected = sql(
    "qa_unresolved",
    await readFile(
      new URL(
        "../services/billing-service/prisma/multi-issuer-expand.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    true,
  );
  assert.match(rejected, /Emisor histórico o serie sin resolver/);
  console.log(
    "OK PostgreSQL 17: tres migraciones, snapshots/correlativos preservados, números iguales entre RUC, claves compuestas y rollback seguro.",
  );
} finally {
  if (containerId && /^[a-f0-9]{64}$/.test(containerId)) {
    const label = docker([
      "inspect",
      "--format",
      '{{index .Config.Labels "factuez.qa"}}',
      containerId,
    ]);
    assert.equal(
      label,
      "multi-ruc",
      "No se elimina un contenedor sin la etiqueta QA",
    );
    docker(["rm", "-f", containerId]);
    console.log(
      "Contenedor QA y datos ficticios eliminados; instalación y volúmenes existentes intactos.",
    );
  }
}
