"use client";
import { useEffect, useState } from 'react';
import { useWorkspace } from './provider';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@factuez/ui/components/card';
import { Button } from '@factuez/ui/components/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@factuez/ui/components/select';
import { ErrorState } from './common';
import { PdfPrintButton } from './pdf-print';
import { LocalMailPanel } from './local-mail';
type Circuit = { ready: boolean; state: string; cdrAvailable: boolean; requestFileName: string | null; responseCode: string | null; description: string | null; pollAttempts: number; ticket: string | null; digestValue: string | null; scenario: string | null; xsdValidated: boolean; xsdProfile: string | null };
const labels: Record<string, string> = { NOT_STARTED: 'Sin ejecutar', QUEUED: 'En cola', SENDING: 'Enviando al emulador', WAITING_TICKET: 'Esperando resultado del ticket', POLLING: 'Consultando ticket', ACCEPTED: 'Aceptado por emulador', ACCEPTED_WITH_OBSERVATIONS: 'Observado por emulador', REJECTED: 'Rechazado por emulador', UNKNOWN: 'Resultado desconocido · No reenviar', POLL_LIMIT: 'Límite de consultas · Revisar', BLOCKED: 'Bloqueado · Revisar configuración' };
const scenarios = [['ACCEPTED','Aceptación'],['OBSERVED','Observaciones'],['REJECTED','Rechazo'],['UNCERTAIN','Respuesta perdida'],['INVALID_CDR','CDR ajeno'],['TRANSIENT_STATUS','Fallo temporal de consulta']];
export function CircuitQa({ documentId, fileNumber }: { documentId: string; fileNumber: string }) {
  const { api, apiBlob } = useWorkspace(); const [result, setResult] = useState<Circuit>();
  const [scenario, setScenario] = useState('ACCEPTED'); const [busy, setBusy] = useState(false); const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const value = await api<Circuit>(`/api/v1/fiscal-circuit-qa/${documentId}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
        if (!controller.signal.aborted) { setResult(value); if (value.scenario) setScenario(value.scenario); setError(undefined); }
      } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'No se pudo consultar'); }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 5000);
    }; void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [api, documentId]);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => { void api<Circuit>(`/api/v1/fiscal-circuit-qa/${documentId}`, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setResult(value); }).catch(() => {}); };
    window.addEventListener('factuez:live-refresh', refresh);
    return () => { controller.abort(); window.removeEventListener('factuez:live-refresh', refresh); };
  }, [api, documentId]);
  async function start() {
    setBusy(true); setError(undefined);
    try { setResult(await api<Circuit>(`/api/v1/fiscal-circuit-qa/${documentId}`, { method: 'POST', body: JSON.stringify({ scenario }), signal: AbortSignal.timeout(30000) })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo iniciar'); } finally { setBusy(false); }
  }
  async function download(format: string) {
    setBusy(true); setError(undefined);
    try {
      const type = format === 'xml' ? 'application/xml' : ['ticket','a4'].includes(format) ? 'application/pdf' : 'application/zip';
      const blob = await apiBlob(`/api/v1/fiscal-circuit-qa/${documentId}/${format}`, AbortSignal.timeout(25000), type);
      const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url;
      const issuerRuc = result?.requestFileName?.match(/^(\d{11})-/)?.[1];
      link.download = `${issuerRuc ? `${issuerRuc}-` : ''}${fileNumber}-${format}-SIMULADO.${format === 'xml' ? 'xml' : ['ticket','a4'].includes(format) ? 'pdf' : 'zip'}`;
      document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Descarga no disponible'); } finally { setBusy(false); }
  }
  return <Card className="mb-6 shadow-none">
    <CardHeader><CardTitle>Circuito de transporte · QA aislada</CardTitle><CardDescription>SOAP y respuestas simuladas. No hay conexión ni aceptación de SUNAT.</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      <p className="text-sm text-muted-foreground">Factura: envío individual. Boleta: resumen RC firmado y consulta de ticket. Los estados de este bloque no cambian el estado fiscal de la venta. Si se pierde la respuesta, el envío queda detenido para conciliación.</p>
      <div className="flex flex-wrap items-center gap-3"><Select value={scenario} onValueChange={setScenario} disabled={busy || result?.ready}><SelectTrigger className="w-72" aria-label="Escenario de transporte"><SelectValue /></SelectTrigger><SelectContent>{scenarios.map(([value,label]) => <SelectItem value={value} key={value}>{label}</SelectItem>)}</SelectContent></Select>
        <Button variant="outline" disabled={busy || !result || result.ready} onClick={() => void start()}>{busy ? 'Procesando…' : 'Ejecutar circuito simulado'}</Button></div>
      {error && <ErrorState message={error} />}
      {result?.ready && <div role="status" className="rounded-lg border p-4 text-sm"><p className="font-medium">{labels[result.state] ?? result.state}</p><p className="mt-1 text-muted-foreground">{result.description}</p><p className="mt-2 break-all font-mono text-xs">{result.requestFileName}</p>{result.ticket && <p className="mt-1 break-all text-xs">Ticket local: {result.ticket} · Consultas: {result.pollAttempts}</p>}{result.responseCode && <p className="mt-1 text-xs">Código: {result.responseCode}</p>}{result.digestValue && <p className="mt-1 break-all font-mono text-xs">Hash XML: {result.digestValue}</p>}</div>}
      {result?.ready && <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => void download('xml')}>XML firmado de prueba</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void download('request')}>ZIP enviado al emulador</Button><Button size="sm" variant="outline" disabled={busy || !result.cdrAvailable} onClick={() => void download('cdr')}>CDR simulado</Button>{['ACCEPTED','ACCEPTED_WITH_OBSERVATIONS','REJECTED','UNKNOWN'].includes(result.state) && <><Button size="sm" variant="outline" disabled={busy} onClick={() => void download('ticket')}>Ticket de prueba con QR/hash</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void download('a4')}>A4 de prueba con QR/hash</Button></>}</div>}
      {result?.ready && <p className="text-xs text-muted-foreground">XSD estructural: {result.xsdValidated ? 'verificado con paquete oficial versionado' : 'sin evidencia del gate en este registro anterior'}. {result.xsdProfile}</p>}
      {result?.ready && ['ACCEPTED','ACCEPTED_WITH_OBSERVATIONS','REJECTED','UNKNOWN'].includes(result.state) && <div className="flex flex-wrap gap-2">
        <PdfPrintButton path={`/api/v1/fiscal-circuit-qa/${documentId}/ticket`} format="ticket" disabled={busy} />
        <PdfPrintButton path={`/api/v1/fiscal-circuit-qa/${documentId}/a4`} format="a4" disabled={busy} />
      </div>}
      <p className="text-xs text-muted-foreground">Prueba local, sin validez tributaria · Reglas fiscales completas, confianza del certificado y CDR oficial pendientes. XSD correcto no significa aceptado por SUNAT. Un escenario por documento; no cambia ni reutiliza correlativos fiscales.</p>
      <LocalMailPanel documentId={documentId} enabled={Boolean(result?.cdrAvailable && ['ACCEPTED','ACCEPTED_WITH_OBSERVATIONS'].includes(result.state))} />
    </CardContent>
  </Card>;
}
