"use client";

import { useEffect, useRef, useState } from "react";
import type { DocumentPrintFormat, PrintBrandingDraft, PrintableDocumentTypeCode } from "@factuez/contracts";
import { Download, ExternalLink, FileText, Printer, X } from "lucide-react";
import { Button } from "@factuez/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@factuez/ui/components/card";
import { Label } from "@factuez/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@factuez/ui/components/select";
import { assertPrintablePdf, PrintHelp, pdfViewerSource } from "./pdf-print";
import { useWorkspace } from "./provider";
import {
  createPrintPreviewLifecycle, PRINT_DOCUMENT_OPTIONS, PRINT_FORMAT_OPTIONS, PRINT_PREVIEW_NOTICE,
  printPreviewRequest,
} from "./print-settings-model";

export function PrintSettingsPdfViewer({ url, title, filename, format }: {
  url: string; title: string; filename: string; format: DocumentPrintFormat;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState<string>();
  useEffect(() => { setReady(false); setNotice(undefined); }, [url]);
  if (!url.startsWith("blob:")) return <p role="alert" className="text-sm text-destructive">El visor requiere un PDF protegido preparado localmente.</p>;
  function print() {
    try {
      if (!ready || !frame.current?.contentWindow || frame.current.contentWindow.location.href === "about:blank")
        throw new Error("Visor PDF no integrado");
      frame.current.contentWindow.focus();
      frame.current.contentWindow.print();
      setNotice("Seleccione la impresora en el diálogo del navegador. La impresión física no se confirma aquí.");
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
      setNotice("Se solicitó abrir el PDF. Si el navegador bloquea la ventana, use Abrir PDF o Descargar y luego Imprimir en su lector.");
    }
  }
  return <div className="min-w-0 space-y-4">
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" asChild><a href={url} download={filename}><Download className="size-4" />Descargar</a></Button>
      <Button variant="outline" size="sm" asChild><a href={url} target="_blank" rel="noopener noreferrer"><ExternalLink className="size-4" />Abrir PDF</a></Button>
      <Button size="sm" onClick={print}><Printer className="size-4" />Imprimir PDF</Button>
    </div>
    <div className="rounded-xl border bg-muted/40 p-2 sm:p-3"><iframe ref={frame} src={pdfViewerSource(url)} title={title} onLoad={() => setReady(true)} className="h-[60dvh] min-h-64 w-full rounded-lg border bg-white shadow-sm sm:min-h-80" /></div>
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    <PrintHelp format={format} />
  </div>;
}

export function PrintSettingsPreview({ path, contextKey, ruc, branchName, draft, disabled, onBusyChange }: {
  path: string; contextKey: string; ruc: string; branchName?: string; draft?: PrintBrandingDraft;
  disabled: boolean; onBusyChange: (busy: boolean) => void;
}) {
  const workspace = useWorkspace();
  const { apiBlob } = workspace;
  const [documentType, setDocumentType] = useState<PrintableDocumentTypeCode>("01");
  const [format, setFormat] = useState<DocumentPrintFormat>("a4");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [pdf, setPdf] = useState<{ url: string; title: string; filename: string; format: DocumentPrintFormat }>();
  const lifecycle = useRef<ReturnType<typeof createPrintPreviewLifecycle> | null>(null);
  if (!lifecycle.current) lifecycle.current = createPrintPreviewLifecycle();
  const identity = `${workspace.user?.sub ?? ""}:${contextKey}:${documentType}:${format}`;
  const activeIdentity = useRef(identity);
  activeIdentity.current = identity;

  useEffect(() => {
    lifecycle.current!.cancel(); setPdf(undefined); setError(undefined); setBusy(false);
    return () => lifecycle.current!.cancel();
  }, [identity]);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);

  function cancel() {
    lifecycle.current!.cancel(); setPdf(undefined); setBusy(false); setError(undefined);
  }
  async function generate() {
    if (disabled || busy || !workspace.user) return;
    const stamp = identity;
    const flight = lifecycle.current!.start();
    const signal = AbortSignal.any([flight.signal, AbortSignal.timeout(30000)]);
    setPdf(undefined); setError(undefined); setBusy(true);
    try {
      const body = printPreviewRequest(documentType, format, draft);
      const blob = await apiBlob(path, signal, "application/pdf", { method: "POST", body: JSON.stringify(body) });
      await assertPrintablePdf(blob);
      if (signal.aborted || activeIdentity.current !== stamp || !flight.isCurrent()) return;
      const url = lifecycle.current!.publish(flight, blob);
      if (!url) return;
      const label = PRINT_DOCUMENT_OPTIONS.find(option => option.code === documentType)!.label;
      setPdf({ url, title: `PDF de prueba: ${label}, RUC ${ruc}${branchName ? `, ${branchName}` : ""}, ${format === "a4" ? "A4" : "80 mm"}`,
        filename: `muestra-sin-validez-${ruc}-${documentType}-${format}.pdf`, format });
    } catch (reason) {
      if (flight.isCurrent() && activeIdentity.current === stamp)
        setError(signal.aborted ? "El PDF tardó demasiado. Vuelva a intentarlo." : reason instanceof Error ? reason.message : "No se pudo generar el PDF de prueba.");
    } finally {
      if (flight.isCurrent() && activeIdentity.current === stamp) setBusy(false);
    }
  }
  return <Card>
    <CardHeader><CardTitle className="text-base">PDF de prueba</CardTitle><p className="text-xs text-muted-foreground">{PRINT_PREVIEW_NOTICE}</p></CardHeader>
    <CardContent className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2"><Label htmlFor="print-preview-document">Documento</Label>
          <Select value={documentType} disabled={disabled || busy} onValueChange={value => setDocumentType(value as PrintableDocumentTypeCode)}>
            <SelectTrigger id="print-preview-document"><SelectValue /></SelectTrigger><SelectContent>
              {PRINT_DOCUMENT_OPTIONS.map(option => <SelectItem key={option.code} value={option.code}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2"><Label htmlFor="print-preview-format">Papel</Label>
          <Select value={format} disabled={disabled || busy} onValueChange={value => setFormat(value as DocumentPrintFormat)}>
            <SelectTrigger id="print-preview-format"><SelectValue /></SelectTrigger><SelectContent>
              {PRINT_FORMAT_OPTIONS.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      {documentType === "07" && <p className="text-xs text-muted-foreground">La nota de crédito de esta muestra se refiere a una factura.</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={disabled || busy} onClick={() => void generate()}><FileText className="size-4" />{busy ? "Generando PDF…" : "Generar PDF"}</Button>
        {busy && <Button variant="outline" onClick={cancel}><X className="size-4" />Cancelar</Button>}
        <p className="text-xs text-muted-foreground">{draft ? "Usa los cambios del borrador, sin guardarlos." : "Usa la configuración guardada."}</p>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {busy && <div role="status" aria-live="polite" className="flex min-h-64 items-center justify-center rounded-md border bg-muted/30 text-sm text-muted-foreground">Preparando PDF local protegido…</div>}
      {!busy && !error && !pdf && <div className="flex min-h-64 items-center justify-center rounded-md border bg-muted/30 p-6 text-center text-sm text-muted-foreground">Genere una muestra para revisar el PDF real.</div>}
      {pdf && <PrintSettingsPdfViewer key={pdf.url} {...pdf} />}
    </CardContent>
  </Card>;
}
