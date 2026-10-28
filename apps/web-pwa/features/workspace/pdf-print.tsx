"use client";
import { useEffect, useRef, useState } from 'react';
import { Printer, ExternalLink, FileText, LoaderCircle } from 'lucide-react';
import { Button } from '@factuez/ui/components/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@factuez/ui/components/dialog';
import { useWorkspace } from './provider';

export const PRINTER_COMPATIBILITY = 'Imprime en cualquier marca con controlador instalado: USB, red o compartida. Selecciona la impresora en el diálogo del sistema; también puedes guardar como PDF.';
export const PRINT_GUIDANCE = {
  ticket: 'Ticket de 80 mm: usa una térmica que admita ese ancho, tamaño real (100 %) y sin ajustar a página. Para otro tamaño de papel, utiliza A4 o ajusta en tu visor y comprueba que texto y QR sean legibles.',
  a4: 'PDF A4: compatible con impresoras láser, de tinta o multifunción que admitan este papel. Selecciona A4 y tamaño real (100 %); si utilizas otro tamaño, ajusta en el visor y revisa el resultado.',
} as const;

export function PrintHelp({ format }: { format: 'ticket' | 'a4' }) {
  return <details className="text-xs leading-relaxed text-muted-foreground">
    <summary className="w-fit cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-ring">Papel, impresora y ayuda del visor</summary>
    <div className="mt-2 max-w-3xl space-y-2">
      <p>{PRINT_GUIDANCE[format]} {PRINTER_COMPATIBILITY}</p>
      <p>Si el visor aparece vacío, usa Abrir en visor y luego Imprimir en tu lector. La aplicación no confirma una impresión física ni controla directamente la impresora.</p>
    </div>
  </details>;
}

export function pdfViewerSource(url: string): string {
  if (!url.startsWith('blob:') || url.includes('#')) throw new Error('El visor requiere un PDF protegido');
  return `${url}#view=FitH`;
}

export async function assertPrintablePdf(blob: Blob) {
  if (blob.type.split(';')[0] !== 'application/pdf' || blob.size < 5 || blob.size > 10 * 1024 * 1024 ||
    await blob.slice(0, 5).text() !== '%PDF-') throw new Error('El archivo no es un PDF válido para imprimir');
}

/** Siempre recupera el PDF con la sesión. Nunca imprime la página ni publica el JWT. */
export function PdfPrintButton({ path, format, label: customLabel, disabled = false, mode = 'LOCAL' }: { mode?: 'LOCAL' | 'FISCAL'; path: string; format: 'ticket' | 'a4'; label?: string; disabled?: boolean }) {
  const { apiBlob, user } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState<string>();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (!open || !user) return;
    const controller = new AbortController(); let objectUrl: string | undefined;
    setUrl(undefined); setReady(false); setError(undefined); setNotice(undefined);
    void (async () => {
      try {
        const blob = await apiBlob(path, AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]));
        await assertPrintablePdf(blob);
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'No se pudo preparar la impresión');
      }
    })();
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [open, path, apiBlob, user]);
  useEffect(() => { if (!user) setOpen(false); }, [user]);
  const label = customLabel ?? (format === 'ticket' ? 'Imprimir ticket 80 mm' : 'Imprimir A4');
  function print() {
    try {
      if (!url) return;
      if (!ready || !frame.current?.contentWindow || frame.current.contentWindow.location.href === 'about:blank') throw new Error('Visor no integrado');
      frame.current.contentWindow.focus(); frame.current.contentWindow.print();
      setNotice('Selecciona la impresora y confirma en el diálogo del navegador. Esto no confirma una impresión física.');
    } catch {
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
      setNotice('Se solicitó abrir el PDF. Si el navegador bloquea la apertura o sólo descarga el archivo, abre el PDF descargado en Chrome, Edge o tu lector habitual y usa Imprimir (Ctrl+P). La apertura no está confirmada por el sistema.');
    }
  }
  return <>
    <Button variant="outline" disabled={disabled} onClick={() => setOpen(true)}><Printer className="size-4" />{label}</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex h-[90dvh] max-h-[calc(100dvh-1.5rem)] w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-xl p-0 sm:h-[88dvh] sm:max-w-6xl">
        <DialogHeader className="shrink-0 gap-2 border-b px-5 py-5 pr-12 text-left sm:px-6 sm:pr-14">
          <DialogTitle className="flex items-center gap-3 text-base leading-snug sm:text-lg"><FileText className="size-5 shrink-0 text-muted-foreground" />{label}</DialogTitle>
          <DialogDescription className="leading-relaxed">Vista previa {format === 'a4' ? 'A4' : '80 mm'} · {mode === 'FISCAL' ? 'Representación del comprobante. Consulte el estado fiscal en el PDF.' : 'Documento de desarrollo, sin validez tributaria.'}</DialogDescription>
        </DialogHeader>
        <div className="relative flex min-h-0 flex-1 flex-col bg-muted/40 p-3 sm:p-5">
          {error && <div className="flex flex-1 items-center justify-center rounded-lg border bg-card p-6"><p role="alert" className="max-w-md text-center text-sm leading-relaxed text-destructive">{error}</p></div>}
          {!url && !error && <div role="status" className="flex flex-1 items-center justify-center gap-3 rounded-lg border bg-card text-sm text-muted-foreground"><LoaderCircle className="size-5 animate-spin motion-reduce:animate-none" />Preparando PDF protegido…</div>}
          {url && <iframe ref={frame} title={`Vista previa · ${label}`} src={pdfViewerSource(url)} onLoad={() => setReady(true)} className="min-h-0 w-full flex-1 rounded-lg border bg-white shadow-sm" />}
        </div>
        <DialogFooter className="max-h-[32dvh] shrink-0 flex-col gap-4 overflow-y-auto border-t bg-card px-5 py-4 sm:flex-col sm:items-stretch sm:px-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <PrintHelp format={format} />
            <div className="grid shrink-0 grid-cols-2 gap-2 sm:flex">
              {url && <Button variant="outline" asChild><a href={url} target="_blank" rel="noopener noreferrer"><ExternalLink className="size-4" />Abrir en visor</a></Button>}
              <Button className={!url ? 'col-span-2' : undefined} disabled={!url} onClick={print}><Printer className="size-4" />Imprimir</Button>
            </div>
          </div>
          {notice && <p role="status" className="text-xs leading-relaxed text-muted-foreground">{notice}</p>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
