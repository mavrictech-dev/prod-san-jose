import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrintBrandingSettings, PrintLogoUpload, PrintSettingsResponseV1 } from "../packages/contracts/src/print-presentation";
import type { Catalog, Company, User } from "../apps/web-pwa/features/workspace/types";

const state = vi.hoisted(() => ({ workspace: {} as Record<string, any> }));
vi.mock("../apps/web-pwa/features/workspace/provider", () => ({
  useWorkspace: () => state.workspace,
  ApiError: class extends Error { constructor(message: string, readonly status: number) { super(message); } },
}));
import { PrintSettings, PrintSettingsEditor } from "../apps/web-pwa/features/workspace/print-settings";
import { PrintSettingsPdfViewer, PrintSettingsPreview } from "../apps/web-pwa/features/workspace/print-settings-preview";
import { assertPrintablePdf } from "../apps/web-pwa/features/workspace/pdf-print";
import {
  assertPrintLogoBytes, assertPrintSettingsResponse, canManagePrintSettings, createPrintObjectUrl, createPrintPreviewLifecycle,
  initialPrintDraft, MAX_PRINT_LOGO_BYTES, PRINT_DOCUMENT_OPTIONS, PRINT_FORMAT_OPTIONS, PRINT_LOGO_ACCEPT,
  PRINT_PREVIEW_NOTICE, PRINT_SETTINGS_NOTICE, PRINT_SOURCE_LABELS, printBrandingDraft, printBrandingError,
  printDraftChanged, printDraftError, printPreviewRequest, printSaveRequest, printSettingsBranches, printSettingsCompany,
  printSettingsPath, protectedPrintLogoPreview, readPrintLogo, validatePrintLogoUpload,
} from "../apps/web-pwa/features/workspace/print-settings-model";

const webRequire = createRequire(new URL("../apps/web-pwa/package.json", import.meta.url));
const React = webRequire("react");
const { renderToStaticMarkup } = webRequire("react-dom/server");
const contracts = webRequire("@factuez/contracts");
const defaults: PrintBrandingSettings = { ...contracts.DEFAULT_PRINT_BRANDING };
const issuer: Company = { id: 101, ruc: "00000000101", legalName: "EMISOR FICTICIO A", environment: "BETA" };
const second: Company = { id: 202, ruc: "00000000202", legalName: "EMISOR FICTICIO B", environment: "BETA" };
const branchA = { companyId: 101, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", code: "QA-A", name: "SEDE FICTICIA A" };
const branchB = { companyId: 202, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", code: "QA-B", name: "SEDE FICTICIA B" };
const catalog: Catalog = { companies: [issuer, second], branches: [branchA, branchB], products: [], emissionPoints: [], capabilities: { demoData: true, fiscalTransmission: false } };
const admin: User = { sub: "admin-ficticio", username: "QA", roles: ["ADMIN"], permissions: ["setup.manage"], exp: 9999999999, scope: { kind: "GLOBAL" } };
const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X6mQAAAAASUVORK5CYII=";
const png = new Uint8Array(Buffer.from(pngBase64, "base64"));
const pngUrl = `data:image/png;base64,${pngBase64}`;
const pngUpload: PrintLogoUpload = { mediaType: "image/png", base64: pngBase64 };
const status = (patch: Partial<PrintSettingsResponseV1> = {}): PrintSettingsResponseV1 => ({
  version: contracts.PRINT_SETTINGS_VERSION, companyId: issuer.id, ruc: issuer.ruc, branchId: null,
  revision: 0, updatedAt: null, override: null, effective: { ...defaults }, source: "DEFAULT",
  logoPreviewDataUrl: null, storageReady: true, fiscalTransmission: false, ...patch,
});
const render = (component: any, props?: Record<string, unknown>) => renderToStaticMarkup(React.createElement(component, props));
const editor = (props: Record<string, unknown> = {}) => render(PrintSettingsEditor, {
  company: issuer, status: status(), inherit: false, settings: defaults, disabled: false,
  onInherit: vi.fn(), onSettings: vi.fn(), onFile: vi.fn(), onRemoveFile: vi.fn(), ...props,
});
const file = (name: string, type: string, bytes = png, size = bytes.length) => ({ name, type, size, arrayBuffer: vi.fn(async () => bytes.slice().buffer) });

beforeEach(() => {
  vi.stubGlobal("React", React);
  state.workspace = {
    user: admin, catalog, companyId: "", branchId: "", dirty: false, restoring: false,
    can: vi.fn((permission: string) => state.workspace.user?.permissions.includes(permission) ?? false),
    api: vi.fn(), apiBlob: vi.fn(), setDirty: vi.fn(), reloadCatalog: vi.fn(async () => {}),
  };
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Formatos y logos: permisos y catálogo SSR", () => {
  it("exige GLOBAL, ADMIN y setup.manage antes de mostrar empresas o consultar", () => {
    for (const user of [undefined, { ...admin, roles: ["AUDITOR"] }, { ...admin, permissions: [] },
      { ...admin, scope: { kind: "ASSIGNED", branchIds: [branchA.id], emissionPointIds: [], series: [] } }]) {
      state.workspace.user = user;
      const html = render(PrintSettings);
      expect(html).toContain("Acceso no autorizado");
      expect(html).not.toContain(issuer.ruc);
      expect(html).not.toContain(issuer.legalName);
      expect(state.workspace.api).not.toHaveBeenCalled();
    }
    expect(canManagePrintSettings(admin, permission => permission === "setup.manage")).toBe(true);
  });

  it("no elige automáticamente el primer RUC en consolidado ni guarda al entrar", () => {
    const html = render(PrintSettings);
    expect(html).toContain("Formatos y logos");
    expect(html).toContain("Seleccione un RUC");
    expect(html).toContain("esta selección es local");
    expect(html).toContain(PRINT_SETTINGS_NOTICE);
    expect(html).not.toContain("Emisor de la cabecera");
    expect(state.workspace.api).not.toHaveBeenCalled();
    expect(state.workspace.apiBlob).not.toHaveBeenCalled();
  });

  it("toma el segundo emisor seleccionado en la cabecera y no usa el primero como fallback", () => {
    state.workspace.companyId = String(second.id);
    state.workspace.branchId = branchA.id;
    const html = render(PrintSettings);
    expect(html).toContain("Emisor de la cabecera");
    expect(html).toContain(second.legalName);
    expect(html).toContain(second.ruc);
    expect(html).not.toContain(issuer.legalName);
    expect(html).toContain("Cargando información");
    expect(state.workspace.api).not.toHaveBeenCalled();
  });

  it("limita las sedes al companyId y excluye IDs no UUID", () => {
    const withInvalid = { ...catalog, branches: [...catalog.branches, { ...branchA, id: "sede-externa" }] };
    expect(printSettingsBranches(withInvalid, issuer.id)).toEqual([branchA]);
    expect(printSettingsBranches(withInvalid, second.id)).toEqual([branchB]);
    expect(printSettingsBranches(withInvalid, 999)).toEqual([]);
    expect(printSettingsCompany(catalog, "")).toBeUndefined();
    expect(printSettingsCompany(catalog, "999")).toBeUndefined();
  });

  it("sólo permite emisores BETA y ofrece Sedes y maestros cuando no hay ninguno", () => {
    const production = { ...issuer, environment: "PRODUCTION", legalName: "NO MOSTRAR" };
    expect(printSettingsCompany({ ...catalog, companies: [production] }, "101")).toBeUndefined();
    state.workspace.catalog = { ...catalog, companies: [] };
    expect(render(PrintSettings)).toContain('href="/stations"');
    expect(render(PrintSettings)).toContain("Sin emisores BETA disponibles");
    state.workspace.catalog = { ...catalog, companies: [production] };
    expect(render(PrintSettings)).not.toContain("NO MOSTRAR");
    expect(state.workspace.api).not.toHaveBeenCalled();
  });

  it("ofrece estados de carga y error sin inventar configuración", () => {
    state.workspace.catalog = undefined;
    expect(render(PrintSettings)).toContain('role="status"');
    state.workspace.catalogError = "API local no disponible";
    expect(render(PrintSettings)).toContain('role="alert"');
    expect(render(PrintSettings)).toContain("Reintentar");
  });
});

describe("contrato compilado, herencia y CAS", () => {
  it("resuelve las exportaciones compiladas desde el package.json de la PWA", () => {
    expect(webRequire.resolve("@factuez/contracts").replace(/\\/g, "/")).toContain("/packages/contracts/dist/index.js");
    expect(contracts.PRINT_TEMPLATE).toBe("SAN_JOSE_V1");
    expect(defaults).toEqual({ template: "SAN_JOSE_V1", logoMode: "DEFAULT", logoWidthMm: 40, logoAlignment: "LEFT", showBranchAddress: true, footerNote: "" });
    expect(PRINT_SOURCE_LABELS).toEqual({ ISSUER: "Emisor", BRANCH: "Sede", DEFAULT: "Predeterminado" });
  });

  it("identifica RUC y UUID de sede en las rutas de consulta y POST preview", () => {
    expect(printSettingsPath(101)).toBe("/api/v1/stations/print-settings/101");
    expect(printSettingsPath(101, branchA.id)).toBe(`/api/v1/stations/print-settings/101?branchId=${branchA.id}`);
    expect(printSettingsPath(101, branchA.id, true)).toBe(`/api/v1/stations/print-settings/101/preview?branchId=${branchA.id}`);
    for (const id of [0, -1, 1.5, Number.NaN]) expect(() => printSettingsPath(id)).toThrow();
    expect(() => printSettingsPath(101, "../otro-ruc")).toThrow();
  });

  it("hereda por defecto y conserva expectedRevision al restablecer sin enviar archivos", () => {
    const inherited = status({ branchId: branchA.id, revision: 4, source: "ISSUER" });
    expect(initialPrintDraft(inherited)).toEqual({ inherit: true, settings: defaults });
    const draft = printBrandingDraft(true, { ...defaults, footerNote: "NO GUARDAR" }, pngUpload);
    expect(draft).toEqual({ settings: null });
    expect(printDraftChanged(inherited, draft)).toBe(false);
    expect(printSaveRequest(inherited, draft)).toEqual({ expectedRevision: 4, settings: null });
  });

  it("detecta personalización, descarte y retorno a herencia sin confundirse con el emisor", () => {
    const own = { ...defaults, footerNote: "Texto comercial ficticio" };
    const stored = status({ revision: 7, override: own, effective: own, source: "ISSUER" });
    expect(initialPrintDraft(stored)).toEqual({ inherit: false, settings: own });
    expect(printDraftChanged(stored, { settings: { ...own } })).toBe(false);
    expect(printDraftChanged(stored, { settings: { ...own, logoAlignment: "CENTER" } })).toBe(true);
    expect(printDraftChanged(stored, { settings: null })).toBe(true);
    expect(printSaveRequest(stored, { settings: null })).toEqual({ expectedRevision: 7, settings: null });
    expect(printDraftChanged(status(), { settings: defaults })).toBe(true);
  });

  it("conserva el CUSTOM guardado sin retransmitir su PNG y envía la carga nueva sólo en CUSTOM", () => {
    const settings = { ...defaults, logoMode: "CUSTOM" as const };
    const stored = status({ revision: 3, override: settings, effective: settings, source: "ISSUER", logoPreviewDataUrl: pngUrl });
    expect(printSaveRequest(stored, { settings: { ...settings, footerNote: "Nuevo texto" } })).toEqual({ expectedRevision: 3, settings: { ...settings, footerNote: "Nuevo texto" } });
    expect(printDraftChanged(stored, printBrandingDraft(false, settings, pngUpload))).toBe(true);
    expect(printBrandingDraft(false, defaults, pngUpload)).toEqual({ settings: defaults });
    expect(printDraftError({ settings }, false)).toContain("Seleccione una imagen");
    expect(printDraftError({ settings: null, logoUpload: pngUpload }, true)).toContain("heredada");
  });

  it("rechaza ancho no entero, HTML, controles, saltos y notas de más de 160 caracteres", () => {
    for (const width of [19, 61, 20.5, Number.NaN, Infinity]) expect(printBrandingError({ ...defaults, logoWidthMm: width })).toContain("20 y 60");
    for (const footerNote of ["<b>logo</b>", "línea\nsiguiente", "\u0000", "\u202e", "\u2066", "x".repeat(161)])
      expect(printBrandingError({ ...defaults, footerNote })).toContain("texto plano");
    for (const width of [20, 60]) expect(printBrandingError({ ...defaults, logoWidthMm: width, footerNote: "x".repeat(160) })).toBeUndefined();
  });

  it("rechaza respuestas de otro RUC/sede, transmisión fiscal o logo remoto", () => {
    expect(assertPrintSettingsResponse(status(), issuer, "").revision).toBe(0);
    for (const patch of [{ companyId: 202 }, { ruc: second.ruc }, { branchId: branchB.id }, { revision: -1 },
      { fiscalTransmission: true }, { logoPreviewDataUrl: "https://example.invalid/logo.png" }])
      expect(() => assertPrintSettingsResponse(status(patch as Partial<PrintSettingsResponseV1>), issuer, "")).toThrow("inválida o de otro RUC/sede");
  });
});

describe("logos locales y datos protegidos", () => {
  it("acepta PNG y devuelve base64 estricto sin prefijo data URL", async () => {
    const upload = await readPrintLogo(file("marca.PNG", "image/png"));
    expect(upload).toEqual(pngUpload);
    expect(upload.base64).not.toContain("data:");
    expect(() => validatePrintLogoUpload(upload)).not.toThrow();
    expect(PRINT_LOGO_ACCEPT).toContain("image/webp");
    expect(PRINT_LOGO_ACCEPT).not.toContain("svg");
  });

  it("admite firmas JPEG y WEBP coherentes, pero rechaza discrepancias de bytes", async () => {
    const jpeg = new Uint8Array([255, 216, 255, 224, 0, 2, 255, 217]);
    const webp = new Uint8Array(24); webp.set(Buffer.from("RIFF"), 0); new DataView(webp.buffer).setUint32(4, webp.length - 8, true);
    webp.set(Buffer.from("WEBPVP8L"), 8);
    expect((await readPrintLogo(file("marca.jpg", "image/jpeg", jpeg))).mediaType).toBe("image/jpeg");
    expect((await readPrintLogo(file("marca.webp", "image/webp", webp))).mediaType).toBe("image/webp");
    await expect(readPrintLogo(file("marca.jpg", "image/jpeg", png))).rejects.toThrow("contenido");
    expect(() => assertPrintLogoBytes(webp, "image/png")).toThrow();
  });

  it("rechaza SVG, URL, MIME/extensión incorrectos, contenido vacío y lectura incompleta", async () => {
    const svg = new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>NO_EJECUTAR</script></svg>'));
    for (const rejected of [file("logo.svg", "image/svg+xml", svg), file("logo.png", "image/jpeg"), file("logo.jpg", "image/png"),
      file("logo.png", "image/png", svg), file("https://example.invalid/logo", "image/png"), file("logo.png", "image/png", new Uint8Array()),
      file("logo.png", "image/png", png, png.length + 1)]) await expect(readPrintLogo(rejected)).rejects.toThrow();
    for (const base64 of [`data:image/png;base64,${pngBase64}`, `${pngBase64}\n`, "AB==", "https://example.invalid/logo"])
      expect(() => validatePrintLogoUpload({ mediaType: "image/png", base64 })).toThrow();
  });

  it("limita el archivo original a 256 KiB antes de leerlo y también limita el payload", async () => {
    const tooLarge = file("logo.png", "image/png", png, MAX_PRINT_LOGO_BYTES + 1);
    await expect(readPrintLogo(tooLarge)).rejects.toThrow("256 KiB");
    expect(tooLarge.arrayBuffer).not.toHaveBeenCalled();
    const boundary = new Uint8Array(MAX_PRINT_LOGO_BYTES); boundary.set(png);
    expect((await readPrintLogo(file("logo.png", "image/png", boundary))).base64.length).toBe(Math.ceil(MAX_PRINT_LOGO_BYTES / 3) * 4);
    expect(() => validatePrintLogoUpload({ mediaType: "image/png", base64: Buffer.alloc(MAX_PRINT_LOGO_BYTES + 1).toString("base64") })).toThrow("256 KiB");
  });

  it("permite únicamente PNG base64 protegido como preview efectivo", () => {
    expect(protectedPrintLogoPreview(pngUrl)).toBe(pngUrl);
    for (const value of [null, "blob:otro", "https://example.invalid/logo.png", "data:image/svg+xml;base64,PHN2Zy8+", `data:image/webp;base64,${pngBase64}`, "data:image/png;base64,PHN2Zy8+"])
      expect(protectedPrintLogoPreview(value)).toBeUndefined();
    expect(protectedPrintLogoPreview({} as never)).toBeUndefined();
  });

  it("usa SanJoseLogo actual, labels y tokens; escapa los datos del editor", () => {
    const html = editor({ company: { ...issuer, legalName: "<script>NO_EJECUTAR</script>" }, settings: { ...defaults, footerNote: 'texto "escapado" <b>QA</b>' } });
    expect(html).toContain("estaciones-san-jose.webp");
    expect(html).toContain("&lt;script&gt;NO_EJECUTAR&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;QA&lt;/b&gt;");
    expect(html).not.toContain("<script>NO_EJECUTAR");
    for (const id of ["print-inheritance", "print-template", "print-logo-width", "print-logo-alignment", "print-branch-address", "print-footer", "print-logo-mode"])
      expect(html).toContain(`for="${id}"`);
    expect(html).toContain('maxLength="160"');
    expect(html).toContain('min="20"'); expect(html).toContain('max="60"');
    expect(html).toContain("bg-muted");
  });

  it("muestra CUSTOM protegido y carga local sin mostrar ni almacenar el base64 original", () => {
    const settings = { ...defaults, logoMode: "CUSTOM" as const };
    const saved = status({ effective: settings, override: settings, logoPreviewDataUrl: pngUrl, source: "ISSUER" });
    expect(editor({ status: saved, settings })).toContain(`src="${pngUrl}"`);
    const local = editor({ status: saved, settings, localLogoUrl: "blob:logo-local-ficticio", uploadName: '<script>archivo.png</script>' });
    expect(local).toContain('src="blob:logo-local-ficticio"');
    expect(local).not.toContain(pngBase64);
    expect(local).toContain("&lt;script&gt;archivo.png&lt;/script&gt;");
    expect(local).toContain('type="file"');
    expect(local).toContain("Sin SVG ni URLs");
  });
});

describe("PDF real protegido y ciclo de vida", () => {
  it("ofrece seis tipos contractuales y A4/80 mm sin inventar una referencia NC boleta", () => {
    expect(PRINT_DOCUMENT_OPTIONS.map(option => option.code)).toEqual(["01", "03", "07", "08", "09", "31"]);
    expect(PRINT_FORMAT_OPTIONS.map(option => option.value)).toEqual(["a4", "ticket"]);
    expect(printPreviewRequest("07", "ticket")).toEqual({ documentTypeCode: "07", format: "ticket" });
    expect(printPreviewRequest("03", "a4", { settings: null })).toEqual({ documentTypeCode: "03", format: "a4", draft: { settings: null } });
    expect(() => printPreviewRequest("02" as never, "a4")).toThrow();
    expect(() => printPreviewRequest("01", "html" as never)).toThrow();
    const html = render(PrintSettingsPreview, { path: printSettingsPath(101, "", true), contextKey: "QA", ruc: issuer.ruc, disabled: false, onBusyChange: vi.fn() });
    expect(html).toContain(PRINT_PREVIEW_NOTICE);
    expect(html).toContain("Genere una muestra");
    expect(state.workspace.apiBlob).not.toHaveBeenCalled();
  });

  it("comprueba MIME y firma PDF antes de crear el visor", async () => {
    await expect(assertPrintablePdf(new Blob(["%PDF-1.7\n%%EOF"], { type: "application/pdf" }))).resolves.toBeUndefined();
    await expect(assertPrintablePdf(new Blob(["<html>error</html>"], { type: "application/pdf" }))).rejects.toThrow("PDF válido");
    await expect(assertPrintablePdf(new Blob(["%PDF-1.7"], { type: "text/html" }))).rejects.toThrow();
  });

  it("visor accesible usa únicamente blob PDF para abrir, descargar e imprimir", () => {
    const html = render(PrintSettingsPdfViewer, { url: "blob:pdf-ficticio", title: 'PDF <script>QA</script>', filename: "muestra-sin-validez.pdf", format: "a4" });
    expect(html).toContain('src="blob:pdf-ficticio#view=FitH"');
    expect(html).toContain('title="PDF &lt;script&gt;QA&lt;/script&gt;"');
    expect(html).toContain('download="muestra-sin-validez.pdf"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Imprimir PDF");
    expect(render(PrintSettingsPdfViewer, { url: "https://example.invalid/cliente.pdf", title: "QA", filename: "QA.pdf", format: "a4" })).not.toContain("<iframe");
  });

  it("revoca cada URL una vez y aborta/rechaza resultados tardíos al cambiar de solicitud o contexto", () => {
    const urls = { createObjectURL: vi.fn().mockReturnValueOnce("blob:uno").mockReturnValueOnce("blob:dos"), revokeObjectURL: vi.fn() };
    const blob = new Blob(["%PDF-1.7"], { type: "application/pdf" });
    const lease = createPrintObjectUrl(blob, urls); lease.release(); lease.release();
    expect(urls.revokeObjectURL).toHaveBeenCalledTimes(1);
    const lifecycle = createPrintPreviewLifecycle(urls);
    const stale = lifecycle.start(); const active = lifecycle.start();
    expect(stale.signal.aborted).toBe(true);
    expect(lifecycle.publish(stale, blob)).toBeUndefined();
    expect(urls.createObjectURL).toHaveBeenCalledTimes(1);
    expect(lifecycle.publish(active, blob)).toBe("blob:dos");
    lifecycle.cancel(); lifecycle.cancel();
    expect(active.signal.aborted).toBe(true);
    expect(lifecycle.publish(active, blob)).toBeUndefined();
    expect(urls.revokeObjectURL.mock.calls).toEqual([["blob:uno"], ["blob:dos"]]);
  });

  it("verifica estáticamente POST con cuarto argumento, limpieza, borradores y ausencia de persistencia browser", () => {
    const main = readFileSync(new URL("../apps/web-pwa/features/workspace/print-settings.tsx", import.meta.url), "utf8");
    const preview = readFileSync(new URL("../apps/web-pwa/features/workspace/print-settings-preview.tsx", import.meta.url), "utf8");
    const model = readFileSync(new URL("../apps/web-pwa/features/workspace/print-settings-model.ts", import.meta.url), "utf8");
    expect(preview).toContain('apiBlob(path, signal, "application/pdf", { method: "POST", body: JSON.stringify(body) })');
    expect(preview).toContain("await assertPrintablePdf(blob)");
    expect(preview).toContain("activeIdentity.current !== stamp");
    expect(preview).toContain("return () => lifecycle.current!.cancel()");
    expect(main).toContain("setDirty(changed || !!pending)");
    expect(main).toContain("if (dirty) setPendingSelection(next)");
    expect(main).toContain("operation.current?.abort()");
    expect(main).toContain("logoLease.current?.release()");
    expect(main).toContain("image.onerror");
    expect(main).toContain("PrintSettingsConfirmDialog");
    expect(main).toContain("La revisión cambió en otra sesión. El borrador se conserva.");
    expect(main + preview + model).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB|dangerouslySetInnerHTML|innerHTML|window\.print\s*\(|fetch\s*\(/);
    expect(main + preview).not.toContain("/snapshot");
  });
});
