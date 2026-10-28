/**
 * Expediente parcial de configuración empresarial. No es un contrato de
 * comprobantes, un dataset SYNTHETIC ni una autorización de importación.
 * Sólo metadatos empresariales: los PDF del cliente no se incluyen aquí.
 */
export interface ClientIntakeCompany {
  ruc: string;
  legalName: string;
  taxAddress: string;
  ubigeo: null;
  verifiedOnline: false;
}
export interface ClientIntakeBranch {
  code: string;
  name: string;
  issuerRuc: string;
  address: null;
  establishmentCode: null;
  emissionPointCode: null;
  series: null;
}
export interface ClientIntakeV1 {
  schemaVersion: "factuez.client-intake.v1";
  kind: "BUSINESS_CONFIGURATION";
  environment: "BETA";
  receivedOn: "2026-10-05";
  sources: {
    wordResponse: true;
    rucSheets: 3;
    pdfSamples: 7;
    signedXml: 0;
    originalCdr: 0;
    offlineDatabaseCopy: false;
    completeHistoryExport: false;
  };
  companies: readonly ClientIntakeCompany[];
  branches: readonly ClientIntakeBranch[];
  nameDiscrepancies: readonly {
    issuerRuc: string;
    wordLegalName: string;
    sheetLegalName: string;
    status: "PENDING_ACCOUNTING";
  }[];
  fiscalEvidence: {
    signatureVerified: false;
    certificateTrusted: false;
    originalCdrValidated: false;
  };
  authorizations: {
    betaDevelopmentDeclared: true;
    officialPilotScope: null;
    offlineHistoryScope: null;
    reconciliationApproved: false;
    cutoverApproved: false;
  };
}
export interface ClientIntakePending {
  id: string;
  phase: 2 | 3;
  owner: "TI" | "ADMINISTRACION_CONTABILIDAD" | "EMISOR" | "MAVRIC";
  description: string;
}
export interface ClientIntakeReportV1 {
  schemaVersion: "factuez.client-intake-report.v1";
  kind: "BUSINESS_CONFIGURATION";
  environment: "BETA";
  status: "PARTIAL_REVIEW_REQUIRED";
  data: ClientIntakeV1;
  summary: {
    companyCount: number;
    branchCount: number;
    pdfSampleCount: number;
    signedXmlCount: 0;
    originalCdrCount: 0;
    rucBranchCounts: readonly { ruc: string; count: number }[];
  };
  pending: readonly ClientIntakePending[];
  canEmit: false;
  canImportHistory: false;
  canChangeCounters: false;
  phase2Closed: false;
  phase3Closed: false;
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}
const company = (ruc: string, legalName: string, taxAddress: string): ClientIntakeCompany => ({
  ruc, legalName, taxAddress, ubigeo: null, verifiedOnline: false,
});
const branch = (code: string, name: string, issuerRuc: string): ClientIntakeBranch => ({
  code, name, issuerRuc, address: null, establishmentCode: null, emissionPointCode: null, series: null,
});

export const SAN_JOSE_CLIENT_INTAKE_V1: ClientIntakeV1 = freezeDeep({
  schemaVersion: "factuez.client-intake.v1",
  kind: "BUSINESS_CONFIGURATION",
  environment: "BETA",
  receivedOn: "2026-10-05",
  sources: {
    wordResponse: true, rucSheets: 3, pdfSamples: 7, signedXml: 0, originalCdr: 0,
    offlineDatabaseCopy: false, completeHistoryExport: false,
  },
  companies: [
    company("20175642341", "ESTACION DE SERVICIOS SAN JOSE S.A.C.", "AV. GRAU NRO. 1602 PIURA - PIURA - PIURA"),
    company("20614605864", "ESTACION DE SERVICIOS SAN JOSE ORIENTE S.A.C.", "CAR.FEDERICO BASADRE KM. 12.3 UCAYALI - CORONEL PORTILLO - YARINACOCHA"),
    company("20600979630", "MAX GAS SOCIEDAD ANONIMA CERRADA", "CAR.PANAMERICANA-A KM. 1004 ZONA INDUSTRIAL (CERCA ANTIGUO PEAJE PIURA SULLANA) PIURA - PIURA - VEINTISEIS DE OCTUBRE"),
  ],
  branches: [
    branch("26O", "26 de Octubre", "20175642341"),
    branch("ASI", "Asia", "20175642341"),
    branch("BLL", "Bellavista", "20175642341"),
    branch("CHC", "Chiclayo", "20600979630"),
    branch("CSC", "Coscomba", "20175642341"),
    branch("CST", "Castilla", "20175642341"),
    branch("HCH", "Huacho", "20175642341"),
    branch("LCH", "La Chata", "20175642341"),
    branch("LMB", "Lambayeque", "20175642341"),
    branch("LV1", "La Victoria", "20600979630"),
    branch("NRH", "Narihualá", "20175642341"),
    branch("OLM", "Olmos", "20175642341"),
    branch("ORG", "Órganos", "20175642341"),
    branch("PCL", "Pucallpa", "20614605864"),
    branch("SIM", "Simbila", "20175642341"),
    branch("SJ1", "San José I", "20175642341"),
    branch("SJ2", "San José II", "20600979630"),
    branch("SJG", "San José GLP", "20175642341"),
    branch("SLL", "Sullana", "20175642341"),
    branch("TLR", "Talara", "20175642341"),
    branch("TRJ", "Trujillo", "20175642341"),
  ],
  nameDiscrepancies: [{
    issuerRuc: "20175642341", wordLegalName: "ESTACIONES SAN JOSE S.A.C.",
    sheetLegalName: "ESTACION DE SERVICIOS SAN JOSE S.A.C.", status: "PENDING_ACCOUNTING",
  }],
  fiscalEvidence: { signatureVerified: false, certificateTrusted: false, originalCdrValidated: false },
  authorizations: {
    betaDevelopmentDeclared: true, officialPilotScope: null, offlineHistoryScope: null,
    reconciliationApproved: false, cutoverApproved: false,
  },
});

const PENDING: readonly ClientIntakePending[] = freezeDeep([
  { id: "originals", phase: 2, owner: "TI", description: "Entregar los XML firmados y CDR originales de las muestras. Los siete PDF no sustituyen esos archivos." },
  { id: "map", phase: 2, owner: "ADMINISTRACION_CONTABILIDAD", description: "Confirmar ubigeo numérico de cada emisor, dirección y establecimiento de cada sede, puntos y series. Las series visibles en muestras no se asignan al mapa." },
  { id: "legal-name", phase: 2, owner: "ADMINISTRACION_CONTABILIDAD", description: "Resolver la diferencia de razón social del RUC 20175642341 entre la respuesta Word y la ficha RUC." },
  { id: "pilot", phase: 2, owner: "TI", description: "Definir y autorizar el piloto Beta concreto: RUC, tipos, fecha, número de operaciones, series de prueba y uso del certificado. La declaración general de desarrollo no habilita envíos." },
  { id: "issuer-configuration", phase: 2, owner: "EMISOR", description: "Configurar certificado y credenciales directamente en la aplicación, por RUC y ambiente. Verificar identidad y confianza; no enviar secretos por documentos o chat." },
  { id: "official-circuit", phase: 2, owner: "MAVRIC", description: "Completar y verificar la integración fiscal oficial de notas/lotes y reglas adicionales con pruebas controladas. La entrega documental no resuelve estos pendientes técnicos." },
  { id: "gre", phase: 2, owner: "MAVRIC", description: "Delimitar perfiles de guías: la muestra de tipo 31 no equivale al adaptador remitente 09. El QA actual no autoriza traslado real de combustibles." },
  { id: "offline-copy", phase: 3, owner: "TI", description: "Entregar copia offline íntegra o exportación completa, esquema, historial de cabecera/cliente/ítems y archivos asociados; no sólo las muestras PDF." },
  { id: "history-scope", phase: 3, owner: "TI", description: "Autorizar RUC, periodo, filas, raíces, destino aislado, permisos y tratamiento de datos antes de leer o conciliar una copia. Identificar el sistema de origen; no asumir RestoApp." },
  { id: "extractor", phase: 3, owner: "MAVRIC", description: "Contrastar el extractor y el contrato completo con el origen autorizado. Los runners SYNTHETIC actuales no aceptan el historial real cambiando una bandera." },
  { id: "evidence", phase: 3, owner: "MAVRIC", description: "Verificar XML/CDR, firma, cadena de confianza, estados y correspondencia con PDF/QR sobre la copia autorizada. Un SHA correcto no acredita aceptación SUNAT." },
  { id: "reconciliation", phase: 3, owner: "ADMINISTRACION_CONTABILIDAD", description: "Conciliar por RUC, moneda y serie; resolver diferencias y aprobar el informe. La configuración parcial no equivale a una conciliación." },
  { id: "restore", phase: 3, owner: "TI", description: "Ensayar respaldo/restauración y consulta con permisos sobre la copia autorizada, conservando inventario estable, evidencias e incidencias." },
  { id: "cutover", phase: 3, owner: "ADMINISTRACION_CONTABILIDAD", description: "Aprobar el acta de corte antes de cambiar contador o propietario de una serie. No usar el máximo observado como permiso para iniciar numeración." },
]);

/** Valida formato/dígito de control; no consulta SUNAT ni acredita identidad. */
export function clientIntakeRucChecksum(ruc: string): boolean {
  if (!/^(10|15|17|20)\d{9}$/.test(ruc)) return false;
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((total, weight, index) => total + Number(ruc[index]) * weight, 0);
  return (11 - (sum % 11)) % 10 === Number(ruc[10]);
}

function invalid(): never {
  throw new Error("Expediente parcial inválido: sólo metadatos empresariales BETA v1, sin emisión, importación o corte.");
}
function plainTree(value: unknown, seen = new Set<object>(), budget = { nodes: 0 }): void {
  if (++budget.nodes > 1000) invalid();
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return;
  if (typeof value !== "object") invalid();
  const object = value as object;
  if (seen.has(object)) invalid();
  seen.add(object);
  const prototype = Object.getPrototypeOf(object);
  const array = Array.isArray(object);
  if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) invalid();
  if (array && (object as unknown[]).length > 256) invalid();
  if (array && Object.keys(object).length !== (object as unknown[]).length) invalid();
  for (const key of Reflect.ownKeys(object)) {
    if (array && key === "length") continue;
    if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)) invalid();
    if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= (object as unknown[]).length)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) invalid();
    plainTree(descriptor.value, seen, budget);
  }
}
function sameFields(actual: unknown, expected: unknown): void {
  if (actual === null || expected === null || typeof actual !== "object" || typeof expected !== "object") {
    if (actual !== expected) invalid();
    return;
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) invalid();
    actual.forEach((value, index) => sameFields(value, expected[index]));
    return;
  }
  const keys = Object.keys(actual), reference = Object.keys(expected);
  if (keys.length !== reference.length || keys.some((key) => !reference.includes(key))) invalid();
  for (const key of reference) sameFields((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key]);
}

/**
 * v1 corresponde exactamente a la entrega revisada el 05/10, no acepta uploads.
 * Una entrega ampliada exige nueva revisión/versión; no quitar estos guards.
 */
export function buildClientIntakeReport(input: unknown = SAN_JOSE_CLIENT_INTAKE_V1): ClientIntakeReportV1 {
  plainTree(input);
  sameFields(input, SAN_JOSE_CLIENT_INTAKE_V1);
  const data: ClientIntakeV1 = JSON.parse(JSON.stringify(input));
  if (data.companies.some((entry) => !clientIntakeRucChecksum(entry.ruc))) invalid();
  return freezeDeep({
    schemaVersion: "factuez.client-intake-report.v1",
    kind: "BUSINESS_CONFIGURATION", environment: "BETA", status: "PARTIAL_REVIEW_REQUIRED", data,
    summary: {
      companyCount: data.companies.length, branchCount: data.branches.length, pdfSampleCount: data.sources.pdfSamples,
      signedXmlCount: 0, originalCdrCount: 0,
      rucBranchCounts: data.companies.map((entry) => ({ ruc: entry.ruc, count: data.branches.filter((site) => site.issuerRuc === entry.ruc).length })),
    },
    pending: PENDING,
    canEmit: false, canImportHistory: false, canChangeCounters: false, phase2Closed: false, phase3Closed: false,
  });
}
