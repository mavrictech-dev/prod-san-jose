// Artefactos de QA con datos ficticios. Sin acceso a BD, certificados ni SUNAT.
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const require = createRequire(import.meta.url);
const {
  renderLocalDocumentPdf,
} = require("../packages/pdf-renderer/dist/index.js");
const {
  calculateDocumentTotals,
} = require("../packages/sunat-core/dist/index.js");
if (!process.argv.includes("--local-only"))
  throw new Error("Indique --local-only");
const large = process.argv.includes("--long");
const credit = process.argv.includes('--credit');
const calculation = calculateDocumentTotals(
  Array.from({ length: large ? 100 : 3 }, (_, index) => ({
    description:
      index % 2 === 0
        ? "Gasolina Premium - prueba de impresión en pista"
        : "Lubricante sintético para motores diésel, presentación comercial de un litro - descripción extensa para comprobar los saltos de línea y la legibilidad del ticket",
    quantity: "2.500000",
    unitCode: "GLL",
    unitPriceWithTax: "18.500000",
    taxAffectationCode: "10",
    igvRate: "18",
  })),
);
const snapshot = {
  documentId: "50000000-0000-4000-8000-000000000001",
  companyId: 1,
  environment: "BETA",
  documentTypeCode: "03",
  series: "B001",
  number: "1",
  fullNumber: "B001-1",
  issueDate: "2026-10-01T15:30:00.000Z",
  currencyCode: "PEN",
  operationTypeCode: "0101",
  issuer: {
    identityType: "6",
    identityNumber: "00000000000",
    legalName: "ESTACIÓN FICTICIA - SOLO QA",
    tradeName: "SAN JOSÉ - PRUEBA VISUAL",
    address: "Dirección ficticia para revisión de formatos, sin uso comercial",
    ubigeo: "200101",
    establishmentCode: "QA",
  },
  customer: {
    identityType: "0",
    identityNumber: "0",
    legalName: "CONSUMIDOR FINAL - PRUEBA",
  },
  ...calculation,
};
const output = resolve(large ? "tmp/pdfs/long" : "output/pdf");
if (credit) Object.assign(snapshot, { documentTypeCode: '01', series: 'FQ01', fullNumber: 'FQ01-1',
  customer: { identityType: '6', identityNumber: '00000000001', legalName: 'CLIENTE FICTICIO DE CRÉDITO' },
  paymentTerms: { type: 'CREDITO', currencyCode: 'PEN', pendingAmount: calculation.totals.payableAmount,
    installments: [{ amount: calculation.totals.payableAmount, dueDate: '2026-11-01' }] } });
await mkdir(output, { recursive: true });
for (const format of ["ticket", "a4"]) {
  const file = resolve(output, `${credit ? 'factura-credito' : 'boleta'}-${format}-PRUEBA.pdf`);
  await writeFile(file, await renderLocalDocumentPdf(snapshot, format));
  console.log(`PDF ficticio para QA: ${file}`);
}
