/** Plantillas de coordinación: no contienen credenciales ni ordenan escrituras. */
export type IntakeMapRow = {
  issuerRuc: string;
  legalName: string;
  branchCode: string;
  branchName: string;
  taxAddress: string;
};

function csvCell(value: string): string {
  // Evita que Excel interprete texto como una fórmula al abrir la plantilla.
  const safe = /^[\s\u0000-\u001f\ufeff]*[=+\-@]/u.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function intakeMapCsv(rows: readonly IntakeMapRow[]): string {
  const header = [
    "RUC", "Razón social según ficha", "Código sede", "Nombre sede",
    "Dirección fiscal según ficha", "Ubigeo fiscal (6 dígitos)",
    "Dirección sede", "Código establecimiento SUNAT", "Código punto emisión",
    "Nombre punto emisión", "Tipo comprobante", "Serie", "Confirmado por Contabilidad",
  ];
  const content = rows.map((row) => [
    row.issuerRuc, row.legalName, row.branchCode, row.branchName, row.taxAddress,
    "", "", "", "", "", "", "", "",
  ]);
  return "\ufeff" + [header, ...content].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function intakeScopeTemplate(issuerRucs: readonly string[]) {
  return {
    schemaVersion: "factuez.client-scope-template.v1",
    purpose: "COORDINATION_ONLY",
    environment: "BETA",
    status: "PENDING_APPROVAL",
    productionAllowed: false,
    officialTransmissionAuthorized: false,
    realCertificateSigningAuthorized: false,
    historyImportAuthorized: false,
    counterChangeAuthorized: false,
    cutoverApproved: false,
    issuers: [...new Set(issuerRucs)].map((issuerRuc) => ({
      issuerRuc,
      pilot: {
        documentTypes: [],
        maximumOperations: null,
        dateFrom: null,
        dateTo: null,
        testSeries: null,
        certificateConfiguredByIssuer: false,
        authorizedBy: null,
        authorizationReference: null,
      },
      history: {
        sourceSystem: null,
        periodFrom: null,
        periodTo: null,
        recordCount: null,
        databaseOrExportFormat: null,
        sourceCopyRoot: null,
        artifactCopyRoot: null,
        isolatedDestination: null,
        personalDataTreatment: null,
        authorizedByTi: null,
        authorizationReference: null,
        approvedByAccounting: null,
      },
    })),
    notice: "Plantilla para revisión humana. Este archivo no es una autorización ni se procesa como comando de emisión, importación o corte.",
  } as const;
}
