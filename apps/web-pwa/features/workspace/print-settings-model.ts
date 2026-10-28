import {
  DEFAULT_PRINT_BRANDING,
  PRINT_DOCUMENT_LABELS,
  PRINT_SETTINGS_VERSION,
  PRINT_TEMPLATE,
  type DocumentPrintFormat,
  type PrintBrandingDraft,
  type PrintBrandingSettings,
  type PrintLogoUpload,
  type PrintPreviewRequest,
  type PrintSettingsResponseV1,
  type PrintableDocumentTypeCode,
  type SavePrintSettingsRequest,
} from "@factuez/contracts";
import type { Branch, Catalog, Company, User } from "./types";

export const MAX_PRINT_LOGO_BYTES = 256 * 1024;
export const PRINT_LOGO_ACCEPT = "image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp";
export const PRINT_SOURCE_LABELS = { ISSUER: "Emisor", BRANCH: "Sede", DEFAULT: "Predeterminado" } as const;
export const PRINT_DOCUMENT_OPTIONS: ReadonlyArray<{ code: PrintableDocumentTypeCode; label: string }> =
  (["01", "03", "07", "08", "09", "31"] as const).map(code => ({ code, label: PRINT_DOCUMENT_LABELS[code] }));
export const PRINT_FORMAT_OPTIONS: ReadonlyArray<{ value: DocumentPrintFormat; label: string }> = [
  { value: "a4", label: "A4" }, { value: "ticket", label: "Ticket de 80 mm" },
];
export const PRINT_SETTINGS_NOTICE = "Aplica al volver a abrir los PDF, también de documentos anteriores. Los datos de emisión, XML y CDR no cambian.";
export const PRINT_PREVIEW_NOTICE = "Muestra ficticia SIN VALIDEZ TRIBUTARIA. Sin firma ni envío a SUNAT; no consume correlativos.";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const strictBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const fields: ReadonlyArray<keyof PrintBrandingSettings> =
  ["template", "logoMode", "logoWidthMm", "logoAlignment", "showBranchAddress", "footerNote"];

export function canManagePrintSettings(user: User | undefined, can: (permission: string) => boolean) {
  return user?.scope.kind === "GLOBAL" && user.roles.includes("ADMIN") && can("setup.manage");
}

export function printSettingsCompany(catalog: Catalog, companyId: string): Company | undefined {
  return catalog.companies.find(company => String(company.id) === companyId && company.environment === "BETA");
}

export function printSettingsBranches(catalog: Catalog, companyId: number): Branch[] {
  return catalog.branches.filter(branch => branch.companyId === companyId && uuid.test(branch.id));
}

export function printSettingsPath(companyId: number, branchId = "", preview = false) {
  if (!Number.isSafeInteger(companyId) || companyId <= 0 || (branchId && !uuid.test(branchId)))
    throw new Error("Seleccione un RUC y una sede válidos.");
  return `/api/v1/stations/print-settings/${companyId}${preview ? "/preview" : ""}${branchId ? `?branchId=${encodeURIComponent(branchId)}` : ""}`;
}

export function printBrandingError(settings: PrintBrandingSettings): string | undefined {
  if (!settings || settings.template !== PRINT_TEMPLATE) return "La plantilla debe ser San José.";
  if (!["DEFAULT", "CUSTOM", "NONE"].includes(settings.logoMode)) return "Seleccione un modo de logo válido.";
  if (!Number.isInteger(settings.logoWidthMm) || settings.logoWidthMm < 20 || settings.logoWidthMm > 60)
    return "El ancho del logo debe ser un entero entre 20 y 60 mm.";
  if (!["LEFT", "CENTER"].includes(settings.logoAlignment)) return "Seleccione la alineación del logo.";
  if (typeof settings.showBranchAddress !== "boolean") return "Indique si desea mostrar la dirección de la sede.";
  if (typeof settings.footerNote !== "string" || settings.footerNote.length > 160 || /[<>\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(settings.footerNote))
    return "La nota al pie admite hasta 160 caracteres de texto plano, sin HTML ni saltos de línea.";
}

export function printBrandingDraft(inherit: boolean, settings: PrintBrandingSettings, logoUpload?: PrintLogoUpload): PrintBrandingDraft {
  if (inherit) return { settings: null };
  return { settings: { ...settings }, ...(settings.logoMode === "CUSTOM" && logoUpload ? { logoUpload } : {}) };
}

export function printDraftChanged(status: PrintSettingsResponseV1, draft: PrintBrandingDraft) {
  if (draft.settings === null || status.override === null) return draft.settings !== status.override;
  return !!draft.logoUpload || fields.some(field => draft.settings![field] !== status.override![field]);
}

export function printDraftError(draft: PrintBrandingDraft, hasSavedCustomLogo: boolean): string | undefined {
  if (draft.settings === null) return draft.logoUpload ? "Una configuración heredada no admite un logo propio." : undefined;
  const error = printBrandingError(draft.settings);
  if (error) return error;
  if (draft.logoUpload) {
    try { validatePrintLogoUpload(draft.logoUpload); }
    catch (reason) { return reason instanceof Error ? reason.message : "El logo no es válido."; }
    if (draft.settings.logoMode !== "CUSTOM") return "Seleccione Logo personalizado para cargar una imagen.";
  }
  if (draft.settings.logoMode === "CUSTOM" && !draft.logoUpload && !hasSavedCustomLogo)
    return "Seleccione una imagen para el logo personalizado.";
}

export function printSaveRequest(status: PrintSettingsResponseV1, draft: PrintBrandingDraft): SavePrintSettingsRequest {
  const error = printDraftError(draft, status.effective.logoMode === "CUSTOM" && !!status.logoPreviewDataUrl);
  if (error) throw new Error(error);
  return { expectedRevision: status.revision, ...draft };
}

export function printPreviewRequest(documentTypeCode: PrintableDocumentTypeCode, format: DocumentPrintFormat, draft?: PrintBrandingDraft): PrintPreviewRequest {
  if (!PRINT_DOCUMENT_OPTIONS.some(option => option.code === documentTypeCode) || !PRINT_FORMAT_OPTIONS.some(option => option.value === format))
    throw new Error("Seleccione un documento y un formato de prueba válidos.");
  return { documentTypeCode, format, ...(draft ? { draft } : {}) };
}

function decodeBase64(value: string): Uint8Array {
  if (!value || value.length % 4 !== 0 || !strictBase64.test(value)) throw new Error("El logo debe contener base64 estricto.");
  const binary = atob(value);
  if (btoa(binary) !== value) throw new Error("El logo debe contener base64 estricto.");
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function ascii(bytes: Uint8Array, offset: number, count: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + count));
}

export function assertPrintLogoBytes(bytes: Uint8Array, mediaType: PrintLogoUpload["mediaType"]) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const png = bytes.length >= 33 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte) &&
    ascii(bytes, 12, 4) === "IHDR" && view.getUint32(8) === 13 && view.getUint32(16) > 0 && view.getUint32(20) > 0;
  const jpeg = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 &&
    bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217;
  const webp = bytes.length >= 20 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP" &&
    ["VP8 ", "VP8L", "VP8X"].includes(ascii(bytes, 12, 4)) && view.getUint32(4, true) === bytes.length - 8;
  if (!(mediaType === "image/png" ? png : mediaType === "image/jpeg" ? jpeg : mediaType === "image/webp" && webp))
    throw new Error("El contenido del archivo no coincide con PNG, JPEG o WEBP. No se admiten SVG.");
}

export function validatePrintLogoUpload(upload: PrintLogoUpload) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(upload.mediaType)) throw new Error("Sólo se admiten logos PNG, JPEG o WEBP.");
  if (upload.base64.length > Math.ceil(MAX_PRINT_LOGO_BYTES / 3) * 4) throw new Error("El logo original debe pesar como máximo 256 KiB.");
  const bytes = decodeBase64(upload.base64);
  if (!bytes.length || bytes.length > MAX_PRINT_LOGO_BYTES) throw new Error("El logo original debe pesar entre 1 byte y 256 KiB.");
  assertPrintLogoBytes(bytes, upload.mediaType);
}

export async function readPrintLogo(file: Pick<File, "name" | "type" | "size" | "arrayBuffer">) {
  if (!file.size || file.size > MAX_PRINT_LOGO_BYTES) throw new Error("El logo original debe pesar entre 1 byte y 256 KiB.");
  const extension = file.name.split(".").pop()?.toLowerCase();
  const expected: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
  if (!extension || expected[extension] !== file.type) throw new Error("La extensión y el tipo de archivo deben coincidir: PNG, JPEG o WEBP. No se admiten SVG.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== file.size) throw new Error("No se pudo leer el logo completo. Seleccione el archivo nuevamente.");
  const mediaType = file.type as PrintLogoUpload["mediaType"];
  assertPrintLogoBytes(bytes, mediaType);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  const upload: PrintLogoUpload = { mediaType, base64: btoa(binary) };
  validatePrintLogoUpload(upload);
  return upload;
}

/** Sólo se llama con el logo efectivo recibido de la API protegida. */
export function protectedPrintLogoPreview(value: string | null): string | undefined {
  if (typeof value !== "string" || !value.startsWith("data:image/png;base64,")) return undefined;
  try {
    assertPrintLogoBytes(decodeBase64(value.slice("data:image/png;base64,".length)), "image/png");
    return value;
  } catch { return undefined; }
}

export function assertPrintSettingsResponse(value: PrintSettingsResponseV1, company: Company, branchId: string): PrintSettingsResponseV1 {
  if (!value || value.version !== PRINT_SETTINGS_VERSION || value.companyId !== company.id || value.ruc !== company.ruc ||
    value.branchId !== (branchId || null) || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    !["BRANCH", "ISSUER", "DEFAULT"].includes(value.source) || (value.source === "BRANCH" && !branchId) ||
    typeof value.storageReady !== "boolean" || value.fiscalTransmission !== false ||
    printBrandingError(value.effective) || (value.override !== null && printBrandingError(value.override)) ||
    (value.logoPreviewDataUrl !== null && !protectedPrintLogoPreview(value.logoPreviewDataUrl)))
    throw new Error("La API devolvió una configuración de impresión inválida o de otro RUC/sede. Recargue la configuración.");
  return value;
}

export function initialPrintDraft(status: PrintSettingsResponseV1) {
  return { inherit: status.override === null, settings: { ...(status.override ?? status.effective ?? DEFAULT_PRINT_BRANDING) } };
}

export type ObjectUrlLease = { url: string; release: () => void };
type ObjectUrlApi = Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
export function createPrintObjectUrl(blob: Blob, api: ObjectUrlApi = URL): ObjectUrlLease {
  const url = api.createObjectURL(blob);
  let released = false;
  return { url, release: () => { if (!released) { released = true; api.revokeObjectURL(url); } } };
}

export type PrintPreviewFlight = { signal: AbortSignal; isCurrent: () => boolean };
/** Una sola solicitud y una sola URL vivas; una respuesta tardía nunca reemplaza el contexto actual. */
export function createPrintPreviewLifecycle(api: ObjectUrlApi = URL) {
  let sequence = 0;
  let controller: AbortController | undefined;
  let lease: ObjectUrlLease | undefined;
  const cancel = () => { sequence++; controller?.abort(); controller = undefined; lease?.release(); lease = undefined; };
  return {
    cancel,
    start(): PrintPreviewFlight {
      cancel();
      const stamp = sequence;
      controller = new AbortController();
      const own = controller;
      return { signal: own.signal, isCurrent: () => stamp === sequence && !own.signal.aborted };
    },
    publish(flight: PrintPreviewFlight, blob: Blob): string | undefined {
      if (!flight.isCurrent()) return undefined;
      lease?.release(); lease = createPrintObjectUrl(blob, api);
      return lease.url;
    },
  };
}
