"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { DEFAULT_PRINT_BRANDING, type PrintBrandingSettings, type PrintLogoUpload, type PrintSettingsResponseV1 } from "@factuez/contracts";
import { ImageIcon, RotateCcw, Save } from "lucide-react";
import { Badge } from "@factuez/ui/components/badge";
import { Button } from "@factuez/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@factuez/ui/components/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@factuez/ui/components/dialog";
import { Input } from "@factuez/ui/components/input";
import { Label } from "@factuez/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@factuez/ui/components/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@factuez/ui/components/tabs";
import { SanJoseLogo } from "./brand";
import { Empty, Loading, PageHeading } from "./common";
import { ApiError, useWorkspace } from "./provider";
import type { Branch, Catalog, Company } from "./types";
import {
  assertPrintSettingsResponse, canManagePrintSettings, createPrintObjectUrl, initialPrintDraft,
  PRINT_LOGO_ACCEPT, PRINT_SETTINGS_NOTICE, PRINT_SOURCE_LABELS, printBrandingDraft,
  printDraftChanged, printDraftError, printSaveRequest, printSettingsBranches, printSettingsCompany,
  printSettingsPath, protectedPrintLogoPreview, readPrintLogo, type ObjectUrlLease,
} from "./print-settings-model";
import { PrintSettingsPreview } from "./print-settings-preview";

function PrintSettingsError({ message, retry }: { message: string; retry?: () => void }) {
  return <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
    <p className="min-w-0 flex-1">{message}</p>{retry && <Button size="sm" variant="outline" onClick={retry}>Reintentar</Button>}
  </div>;
}

export function PrintSettingsConfirmDialog({ open, title, description, confirmLabel, onCancel, onConfirm, busy = false }: {
  open: boolean; title: string; description: string; confirmLabel: string; onCancel: () => void; onConfirm: () => void; busy?: boolean;
}) {
  return <Dialog open={open} onOpenChange={value => { if (!value && !busy) onCancel(); }}>
    <DialogContent showCloseButton={!busy}><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
      <DialogFooter><Button variant="outline" disabled={busy} onClick={onCancel}>Cancelar</Button><Button disabled={busy} onClick={onConfirm}>{confirmLabel}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function PrintSettings() {
  const { user, catalog, catalogError, companyId, branchId, can, restoring, reloadCatalog } = useWorkspace();
  if (restoring) return <Loading />;
  if (!canManagePrintSettings(user, can)) return <Empty title="Acceso no autorizado" description="Formatos y logos requiere un administrador global con permiso de administración de maestros." />;
  if (catalogError) return <PrintSettingsError message={catalogError} retry={() => void reloadCatalog().catch(() => {})} />;
  if (!catalog) return <Loading />;
  return <>
    <PageHeading eyebrow="Administración" title="Formatos y logos" description="Personalización de impresión por RUC y sede." />
    <p className="mb-5 text-xs text-muted-foreground">{PRINT_SETTINGS_NOTICE}</p>
    {catalog.companies.some(company => company.environment === "BETA") ? <PrintSettingsScope key={`${user!.sub}:${companyId}:${branchId}`} catalog={catalog} headerCompanyId={companyId} headerBranchId={branchId} />
      : <div><Empty title="Sin emisores BETA disponibles" description="Configure un emisor BETA en Sedes y maestros para personalizar la impresión." />
        <div className="flex justify-center"><Button variant="outline" asChild><Link href="/stations">Sedes y maestros</Link></Button></div></div>}
  </>;
}

function PrintSettingsScope({ catalog, headerCompanyId, headerBranchId }: { catalog: Catalog; headerCompanyId: string; headerBranchId: string }) {
  const { dirty, setDirty } = useWorkspace();
  const headerCompany = printSettingsCompany(catalog, headerCompanyId);
  const [selection, setSelection] = useState(() => ({ companyId: headerCompanyId,
    branchId: headerCompany && printSettingsBranches(catalog, headerCompany.id).some(branch => branch.id === headerBranchId) ? headerBranchId : "" }));
  const [pendingSelection, setPendingSelection] = useState<typeof selection>();
  const [busy, setBusy] = useState(!!headerCompany);
  const company = printSettingsCompany(catalog, selection.companyId);
  const branches = company ? printSettingsBranches(catalog, company.id) : [];
  const branch = branches.find(row => row.id === selection.branchId);
  function applySelection(next: typeof selection) { setDirty(false); setBusy(!!next.companyId); setSelection(next); setPendingSelection(undefined); }
  function select(next: typeof selection) {
    if (busy || (selection.companyId === next.companyId && selection.branchId === next.branchId)) return;
    if (dirty) setPendingSelection(next); else applySelection(next);
  }
  return <div className="space-y-5">
    <Card><CardContent className="grid gap-4 pt-5 sm:grid-cols-2">
      {headerCompanyId ? <div className="min-w-0"><p className="text-xs text-muted-foreground">Emisor de la cabecera</p>
        <p className="mt-1 break-words text-sm font-medium">{headerCompany?.legalName ?? "Emisor no disponible"}</p><p className="mt-1 text-xs text-muted-foreground">RUC {headerCompany?.ruc ?? "sin seleccionar"}</p>
      </div> : <div className="space-y-2"><Label htmlFor="print-company">RUC para personalizar</Label>
        <Select value={selection.companyId || undefined} disabled={busy} onValueChange={value => select({ companyId: value, branchId: "" })}>
          <SelectTrigger id="print-company"><SelectValue placeholder="Seleccione un emisor" /></SelectTrigger><SelectContent>
            {catalog.companies.filter(row => row.environment === "BETA").map(row => <SelectItem value={String(row.id)} key={row.id}>{row.ruc} · {row.legalName}</SelectItem>)}
          </SelectContent>
        </Select><p className="text-xs text-muted-foreground">Vista consolidada: esta selección es local. Elegir un RUC no guarda cambios.</p>
      </div>}
      <div className="space-y-2"><Label htmlFor="print-branch">Ámbito de personalización</Label>
        <Select value={selection.branchId || "issuer"} disabled={busy || !company} onValueChange={value => select({ ...selection, branchId: value === "issuer" ? "" : value })}>
          <SelectTrigger id="print-branch"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="issuer">Base del RUC</SelectItem>
            {branches.map(row => <SelectItem value={row.id} key={row.id}>{row.name} ({row.code})</SelectItem>)}
          </SelectContent>
        </Select>{company && !branches.length && <p className="text-xs text-muted-foreground">Este RUC no tiene sedes disponibles; puede configurar su formato base.</p>}
      </div>
    </CardContent></Card>
    {company && (!selection.branchId || branch) ? <PrintSettingsForm key={`${company.id}:${selection.branchId}`} company={company} branch={branch} onBusyChange={setBusy} />
      : <Empty title={company ? "Sede no disponible" : headerCompanyId ? "Emisor BETA no disponible" : "Seleccione un RUC"} description={company ? "La sede seleccionada ya no está en el catálogo de este RUC." : headerCompanyId ? "El emisor de la cabecera debe estar en el catálogo autorizado y en entorno BETA." : "Elija el emisor que desea personalizar para consultar su configuración."} />}
    <PrintSettingsConfirmDialog open={!!pendingSelection} title="Descartar borrador y cambiar de ámbito" description={`Se descartarán los cambios pendientes de RUC ${company?.ruc ?? ""}${branch ? `, sede ${branch.name}` : ", base del RUC"}. No se guardará ninguna configuración.`}
      confirmLabel="Descartar y cambiar" onCancel={() => setPendingSelection(undefined)} onConfirm={() => { if (pendingSelection && !busy) applySelection(pendingSelection); }} busy={busy} />
  </div>;
}

type EditorProps = {
  company: Company; branch?: Branch; status: PrintSettingsResponseV1; inherit: boolean; settings: PrintBrandingSettings;
  disabled: boolean; localLogoUrl?: string; uploadName?: string; logoError?: string; validationError?: string;
  onInherit: (inherit: boolean) => void; onSettings: (patch: Partial<PrintBrandingSettings>) => void;
  onFile: (file: File | undefined) => void; onRemoveFile: () => void;
};

/** Editor sin consultas: todos los datos guardados provienen de la API protegida. */
export function PrintSettingsEditor({ company, branch, status, inherit, settings, disabled, localLogoUrl, uploadName, logoError, validationError,
  onInherit, onSettings, onFile, onRemoveFile }: EditorProps) {
  const shown = inherit ? status.effective : settings;
  const savedLogo = status.effective.logoMode === "CUSTOM" ? protectedPrintLogoPreview(status.logoPreviewDataUrl) : undefined;
  const customLogo = !inherit && localLogoUrl?.startsWith("blob:") ? localLogoUrl : savedLogo;
  const widthsInvalid = !Number.isInteger(settings.logoWidthMm) || settings.logoWidthMm < 20 || settings.logoWidthMm > 60;
  return <div className="grid min-w-0 gap-5 lg:grid-cols-2">
    <Card><CardHeader><CardTitle className="text-base">{branch ? "Formato de sede" : "Formato del emisor"}</CardTitle>
      <CardDescription>{branch ? branch.name : company.legalName}</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2"><Label htmlFor="print-inheritance">Configuración</Label><Select value={inherit ? "inherit" : "custom"} disabled={disabled} onValueChange={value => onInherit(value === "inherit")}>
          <SelectTrigger id="print-inheritance"><SelectValue /></SelectTrigger><SelectContent>
            <SelectItem value="inherit">{branch ? "Heredar del RUC" : "Usar predeterminado"}</SelectItem><SelectItem value="custom">{branch ? "Personalizar esta sede" : "Personalizar este RUC"}</SelectItem>
          </SelectContent>
        </Select></div>
        {inherit ? <p className="text-sm text-muted-foreground">{branch ? "La sede usa el formato del RUC por defecto. El PDF de prueba resuelve la configuración heredada." : "Se usa el formato predeterminado San José."}</p>
          : <fieldset disabled={disabled} className="min-w-0 space-y-4">
            <div className="space-y-2"><Label htmlFor="print-template">Plantilla</Label><Input id="print-template" value="San José" readOnly /></div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2"><Label htmlFor="print-logo-width">Ancho del logo (mm)</Label><Input id="print-logo-width" type="number" min={20} max={60} step={1} value={Number.isFinite(settings.logoWidthMm) ? settings.logoWidthMm : ""}
                aria-invalid={widthsInvalid} aria-describedby="print-logo-width-help" onChange={event => onSettings({ logoWidthMm: event.target.value === "" ? Number.NaN : Number(event.target.value) })} />
                <p id="print-logo-width-help" className="text-xs text-muted-foreground">Entero entre 20 y 60 mm.</p></div>
              <div className="space-y-2"><Label htmlFor="print-logo-alignment">Alineación</Label><Select value={settings.logoAlignment} disabled={disabled} onValueChange={value => onSettings({ logoAlignment: value as PrintBrandingSettings["logoAlignment"] })}>
                <SelectTrigger id="print-logo-alignment"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="LEFT">Izquierda</SelectItem><SelectItem value="CENTER">Centrada</SelectItem></SelectContent>
              </Select></div>
            </div>
            <div className="space-y-2"><Label htmlFor="print-branch-address">Dirección de sede</Label><Select value={settings.showBranchAddress ? "show" : "hide"} disabled={disabled} onValueChange={value => onSettings({ showBranchAddress: value === "show" })}>
              <SelectTrigger id="print-branch-address"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="show">Mostrar dirección</SelectItem><SelectItem value="hide">Ocultar dirección</SelectItem></SelectContent>
            </Select></div>
            <div className="space-y-2"><Label htmlFor="print-footer">Nota al pie (opcional)</Label><Input id="print-footer" value={settings.footerNote} maxLength={160} aria-describedby="print-footer-help" onChange={event => onSettings({ footerNote: event.target.value })} />
              <p id="print-footer-help" className="text-xs text-muted-foreground">Texto plano · {settings.footerNote.length}/160</p></div>
          </fieldset>}
        {validationError && <p role="alert" className="text-sm text-destructive">{validationError}</p>}
      </CardContent>
    </Card>
    <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><ImageIcon className="size-4" />Logo</CardTitle>
      <CardDescription>{inherit ? "Logo efectivo guardado" : "Vista del logo del borrador"}</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        {!inherit && <div className="space-y-2"><Label htmlFor="print-logo-mode">Logo del documento</Label><Select value={settings.logoMode} disabled={disabled} onValueChange={value => onSettings({ logoMode: value as PrintBrandingSettings["logoMode"] })}>
          <SelectTrigger id="print-logo-mode"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="DEFAULT">San José</SelectItem><SelectItem value="CUSTOM">Personalizado</SelectItem><SelectItem value="NONE">Sin logo</SelectItem></SelectContent>
        </Select></div>}
        <div className={`flex min-h-32 overflow-hidden rounded-md border bg-muted/20 p-5 ${shown.logoAlignment === "CENTER" ? "justify-center" : "justify-start"}`}>
          <div className="max-w-full self-center" style={{ width: `${Number.isFinite(shown.logoWidthMm) ? Math.min(60, Math.max(20, shown.logoWidthMm)) : 40}mm` }}>
            {shown.logoMode === "DEFAULT" ? <SanJoseLogo className="w-full" /> : shown.logoMode === "NONE" ? <p className="text-sm text-muted-foreground">Sin logo</p>
              : customLogo ? <img src={customLogo} alt={`${!inherit && localLogoUrl ? "Logo pendiente de guardar" : "Logo efectivo guardado"} para RUC ${company.ruc}`} className="max-h-32 w-full object-contain" />
                : <p className="text-sm text-muted-foreground">Seleccione un logo personalizado.</p>}
          </div>
        </div>
        {!inherit && settings.logoMode === "CUSTOM" && <div className="space-y-2"><Label htmlFor="print-logo-file">Imagen PNG, JPEG o WEBP</Label>
          <Input id="print-logo-file" type="file" accept={PRINT_LOGO_ACCEPT} disabled={disabled} aria-invalid={!!logoError} aria-describedby="print-logo-help" onChange={event => {
            const file = event.target.files?.[0]; event.target.value = ""; if (file) onFile(file);
          }} />
          <p id="print-logo-help" className="text-xs text-muted-foreground">Máximo 256 KiB original. Sin SVG ni URLs. Sin archivo nuevo se conserva el logo guardado.</p>
          {uploadName && <div className="flex flex-wrap items-center gap-2 text-xs"><span className="break-all">{uploadName} · pendiente de guardar</span><Button variant="ghost" size="sm" disabled={disabled} onClick={onRemoveFile}>Quitar imagen nueva</Button></div>}
          {logoError && <p role="alert" className="text-sm text-destructive">{logoError}</p>}
        </div>}
      </CardContent>
    </Card>
  </div>;
}

function decodeLocalLogo(url: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const clean = () => { image.onload = null; image.onerror = null; signal.removeEventListener("abort", abort); image.removeAttribute("src"); };
    const abort = () => { clean(); reject(new Error("La lectura del logo fue cancelada.")); };
    image.onload = () => {
      const valid = image.naturalWidth >= 8 && image.naturalHeight >= 8 && image.naturalWidth <= 4096 && image.naturalHeight <= 4096 && image.naturalWidth * image.naturalHeight <= 4_194_304;
      clean(); valid ? resolve() : reject(new Error("El logo debe ser una imagen estática de al menos 8 × 8 px, hasta 4096 px por lado y 4 megapíxeles."));
    };
    image.onerror = () => { clean(); reject(new Error("No se pudo decodificar el logo. Seleccione una imagen PNG, JPEG o WEBP válida.")); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true }); image.src = url;
  });
}

function PrintSettingsForm({ company, branch, onBusyChange }: { company: Company; branch?: Branch; onBusyChange: (busy: boolean) => void }) {
  const { api, setDirty } = useWorkspace();
  const branchId = branch?.id ?? "";
  const path = printSettingsPath(company.id, branchId);
  const [status, setStatus] = useState<PrintSettingsResponseV1>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [loadVersion, setLoadVersion] = useState(0);
  const [settings, setSettings] = useState<PrintBrandingSettings>({ ...DEFAULT_PRINT_BRANDING });
  const [inherit, setInherit] = useState(true);
  const [upload, setUpload] = useState<PrintLogoUpload>();
  const [uploadName, setUploadName] = useState<string>();
  const [logoUrl, setLogoUrl] = useState<string>();
  const [logoError, setLogoError] = useState<string>();
  const [pending, setPending] = useState<"upload" | "save">();
  const [previewBusy, setPreviewBusy] = useState(false);
  const [editVersion, setEditVersion] = useState(0);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [confirm, setConfirm] = useState<"save" | "reset" | "discard" | "reload">();
  const logoLease = useRef<ObjectUrlLease | undefined>(undefined);
  const operation = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  const draft = printBrandingDraft(inherit, settings, upload);
  const changed = !!status && printDraftChanged(status, draft);
  const busy = loading || !!pending || previewBusy;
  const validationError = status ? printDraftError(draft, status.effective.logoMode === "CUSTOM" && !!status.logoPreviewDataUrl) : undefined;

  useEffect(() => { setDirty(changed || !!pending); }, [changed, pending, setDirty]);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; operation.current?.abort(); logoLease.current?.release(); setDirty(false); };
  }, [setDirty]);
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]);
    setLoading(true); setStatus(undefined); setLoadError(undefined);
    void (async () => {
      try {
        const response = assertPrintSettingsResponse(await api<PrintSettingsResponseV1>(path, { signal }), company, branchId);
        if (controller.signal.aborted) return;
        const initial = initialPrintDraft(response);
        setStatus(response); setInherit(initial.inherit); setSettings(initial.settings);
      } catch (reason) {
        if (!controller.signal.aborted) setLoadError(signal.aborted ? "La consulta tardó demasiado. Reintente." : reason instanceof Error ? reason.message : "No se pudo consultar la configuración de impresión.");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [api, path, company.id, company.ruc, branchId, loadVersion]);

  function clearUpload() {
    logoLease.current?.release(); logoLease.current = undefined;
    setUpload(undefined); setUploadName(undefined); setLogoUrl(undefined); setLogoError(undefined);
  }
  function edited() { setEditVersion(value => value + 1); setSuccess(undefined); if (!conflict) setError(undefined); }
  function update(patch: Partial<PrintBrandingSettings>) {
    if (busy) return;
    if (patch.logoMode && patch.logoMode !== "CUSTOM") clearUpload();
    setSettings(current => ({ ...current, ...patch })); edited();
  }
  function toggleInheritance(value: boolean) {
    if (busy || !status) return;
    clearUpload(); setInherit(value);
    if (!value && inherit) setSettings({ ...status.effective });
    edited();
  }
  function discard() {
    if (!status || busy) return;
    const initial = initialPrintDraft(status);
    clearUpload(); setInherit(initial.inherit); setSettings(initial.settings); setConfirm(undefined); edited(); setDirty(false);
  }
  function reload() {
    if (busy) return;
    clearUpload(); setConfirm(undefined); setConflict(false); setError(undefined); setSuccess(undefined); setEditVersion(value => value + 1); setLoadVersion(value => value + 1);
  }
  async function selectLogo(file: File | undefined) {
    if (!file || busy) return;
    const controller = new AbortController(); operation.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]);
    let lease: ObjectUrlLease | undefined;
    setPending("upload"); setLogoError(undefined);
    try {
      const logoUpload = await readPrintLogo(file);
      if (controller.signal.aborted || !mounted.current) return;
      if (signal.aborted) throw new Error("La lectura del logo tardó demasiado. Seleccione la imagen nuevamente.");
      lease = createPrintObjectUrl(file);
      await decodeLocalLogo(lease.url, signal);
      if (signal.aborted || !mounted.current) return;
      logoLease.current?.release(); logoLease.current = lease; lease = undefined;
      setLogoUrl(logoLease.current.url); setUpload(logoUpload); setUploadName(file.name); edited();
    } catch (reason) {
      if (!controller.signal.aborted && mounted.current) setLogoError(reason instanceof Error ? reason.message : "No se pudo leer el logo.");
    } finally {
      lease?.release();
      if (operation.current === controller) operation.current = undefined;
      if (!controller.signal.aborted && mounted.current) setPending(undefined);
    }
  }
  async function save(reset = false) {
    if (!status || busy || !status.storageReady || conflict) return;
    const controller = new AbortController(); operation.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]);
    setConfirm(undefined); setPending("save"); setError(undefined); setSuccess(undefined);
    try {
      const body = printSaveRequest(status, reset ? { settings: null } : draft);
      const response = assertPrintSettingsResponse(await api<PrintSettingsResponseV1>(path, { method: "POST", body: JSON.stringify(body), signal }), company, branchId);
      if (controller.signal.aborted || !mounted.current) return;
      const initial = initialPrintDraft(response);
      clearUpload(); setStatus(response); setSettings(initial.settings); setInherit(initial.inherit); setConflict(false); setDirty(false); setEditVersion(value => value + 1);
      setSuccess(body.settings === null ? branch ? "Sede restablecida: hereda del RUC. No se borraron archivos." : "Formato predeterminado restablecido. No se borraron archivos." : "Configuración guardada. Se aplica al volver a abrir los PDF, incluidos los documentos anteriores.");
    } catch (reason) {
      if (!controller.signal.aborted && mounted.current) {
        if (reason instanceof ApiError && reason.status === 409) { setConflict(true); setError("La revisión cambió en otra sesión. El borrador se conserva. Recargue la configuración antes de guardar."); }
        else {
          if (signal.aborted) setConflict(true);
          setError(signal.aborted ? "No se pudo confirmar el guardado a tiempo. Recargue para comprobar la revisión; el borrador se conserva." : reason instanceof Error ? reason.message : "No se pudo guardar la configuración de impresión.");
        }
      }
    } finally {
      if (operation.current === controller) operation.current = undefined;
      if (!controller.signal.aborted && mounted.current) setPending(undefined);
    }
  }

  if (loading) return <Loading />;
  if (loadError || !status) return <PrintSettingsError message={loadError ?? "No hay una configuración disponible."} retry={reload} />;
  const target = `RUC ${company.ruc}${branch ? `, sede ${branch.name}` : ", base del emisor"}`;
  const restoring = confirm === "reset" || (confirm === "save" && draft.settings === null);
  const title = confirm === "discard" ? "Descartar borrador" : confirm === "reload" ? "Recargar configuración" : restoring ? branch ? "Restablecer herencia del RUC" : "Restablecer formato predeterminado" : "Guardar formato y logo";
  const description = confirm === "discard" || confirm === "reload" ? `Se descartarán los cambios pendientes de ${target}. No se guardará el borrador.`
    : restoring ? `Se quitará la configuración propia de ${target}${branch ? " y se heredará la del RUC" : " y se usará la predeterminada"}. No se borran archivos. ${PRINT_SETTINGS_NOTICE}`
      : `Se guardará la configuración de ${target}. ${PRINT_SETTINGS_NOTICE}`;
  return <div className="space-y-5" aria-busy={!!pending || previewBusy}>
    <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">RUC {status.ruc}</Badge><Badge variant="outline">{branch ? branch.name : "Base del RUC"}</Badge>
      <Badge variant="outline">Origen efectivo: {PRINT_SOURCE_LABELS[status.source]}</Badge><Badge variant="outline">Revisión {status.revision}</Badge>
      {changed && <Badge variant="secondary">Borrador sin guardar</Badge>}
    </div>
    {!status.storageReady && <p role="status" className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">Almacenamiento de formatos pendiente. Puede revisar muestras; guardar y restablecer estará disponible cuando el integrador lo prepare.</p>}
    <Tabs defaultValue="branding" className="gap-5"><TabsList aria-label="Configuración de impresión"><TabsTrigger value="branding">Formato y logo</TabsTrigger><TabsTrigger value="preview">PDF de prueba</TabsTrigger></TabsList>
      <TabsContent value="branding"><PrintSettingsEditor company={company} branch={branch} status={status} inherit={inherit} settings={settings} disabled={busy}
        localLogoUrl={logoUrl} uploadName={uploadName} logoError={logoError} validationError={validationError} onInherit={toggleInheritance} onSettings={update}
        onFile={file => void selectLogo(file)} onRemoveFile={() => { if (!busy) { clearUpload(); edited(); } }} />
        {pending === "upload" && <p role="status" className="mt-3 text-sm text-muted-foreground">Validando imagen local…</p>}
      </TabsContent>
      <TabsContent value="preview"><PrintSettingsPreview path={printSettingsPath(company.id, branchId, true)} contextKey={`${company.id}:${branchId}:${status.revision}:${editVersion}`} ruc={company.ruc} branchName={branch?.name}
        draft={changed ? draft : undefined} disabled={!!pending || !!validationError} onBusyChange={setPreviewBusy} /></TabsContent>
    </Tabs>
    {error && <PrintSettingsError message={error} />}
    {success && <p role="status" className="text-sm text-foreground">{success}</p>}
    <div className="flex flex-wrap justify-end gap-3">
      {conflict && <Button variant="outline" disabled={busy} onClick={() => setConfirm("reload")}>Recargar configuración</Button>}
      <Button variant="outline" disabled={busy || !changed} onClick={() => setConfirm("discard")}>Descartar borrador</Button>
      <Button variant="outline" disabled={busy || !status.storageReady || conflict || (!status.override && !changed)} onClick={() => setConfirm("reset")}><RotateCcw className="size-4" />{branch ? "Heredar del RUC" : "Restablecer"}</Button>
      <Button disabled={busy || !changed || !status.storageReady || conflict || !!validationError} onClick={() => setConfirm("save")}><Save className="size-4" />{pending === "save" ? "Guardando…" : "Guardar cambios"}</Button>
    </div>
    <PrintSettingsConfirmDialog open={!!confirm} title={title} description={description} busy={busy} confirmLabel={confirm === "discard" ? "Descartar" : confirm === "reload" ? "Recargar" : restoring ? "Restablecer" : "Guardar"}
      onCancel={() => setConfirm(undefined)} onConfirm={() => {
        if (busy) return;
        if (confirm === "discard") discard(); else if (confirm === "reload") reload(); else void save(confirm === "reset");
      }} />
  </div>;
}
