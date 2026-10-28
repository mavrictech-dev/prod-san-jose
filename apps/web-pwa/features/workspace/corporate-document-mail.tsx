"use client";
import { useEffect, useRef, useState } from 'react';
import { Button } from '@factuez/ui/components/button';
import { Input } from '@factuez/ui/components/input';
import { Label } from '@factuez/ui/components/label';
import { Badge } from '@factuez/ui/components/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@factuez/ui/components/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@factuez/ui/components/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@factuez/ui/components/select';
import { useResource, useWorkspace } from './provider';
import { ErrorState, Loading } from './common';
export type FiscalDocumentMailProps = { companyId: number; ruc: string; documentId: string; disabled?: boolean };
type DocumentJob = { id: string; documentId: string; format: 'a4' | 'ticket'; state: string; configurationRevision: number;
  activationRevision: number; deliveredToClient: false; scope: 'DOCUMENT' };
type DocumentRuntime = { companyId: number; ruc: string; documentId: string; documentType: '01' | '03' | '07' | '08'; environment: 'PRODUCTION';
  fullNumber: string; configurationRevision: number; activationRevision: number; enabledForDocuments: boolean; grantCurrent: boolean;
  serverEnabled: boolean; storageReady: boolean; workerReady: boolean; readyToSendDocument: boolean; scope: 'DOCUMENT'; jobs: DocumentJob[] };
const labels: Record<string, string> = { QUEUED: 'En cola', PREPARING: 'Preparando adjuntos actuales', SENDING: 'Enviando',
  HANDED_OFF: 'Aceptado por SMTP; entrega al destinatario no confirmada', UNKNOWN: 'Resultado incierto; no se reenviará automáticamente',
  FAILED: 'Falló antes del envío', CANCELLED: 'Cancelado: autorización, comprobante o adjuntos no vigentes' };
/** Main imports this in the document detail; no page/provider changes are required here. */
export function FiscalDocumentMail(props: FiscalDocumentMailProps) {
  const { user, can } = useWorkspace();
  if (!user || !can('document.email') || user.scope.kind !== 'GLOBAL' || !user.roles.includes('ADMIN'))
    return <ErrorState message="El envío de comprobantes requiere ADMIN GLOBAL con permiso de correo." />;
  if (!Number.isSafeInteger(props.companyId) || props.companyId < 1 || !/^\d{11}$/.test(props.ruc) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(props.documentId))
    return <ErrorState message="Contexto del comprobante inválido." />;
  return <DocumentMailForm key={`${user.sub}:${props.companyId}:${props.documentId}`} {...props} />;
}
function DocumentMailForm({ companyId, ruc, documentId, disabled = false }: FiscalDocumentMailProps) {
  const { api } = useWorkspace(), path = `/api/v1/mail-settings/${companyId}`;
  const resource = useResource<DocumentRuntime>(`${path}/documents/${documentId}`);
  const [recipient, setRecipient] = useState(''), [format, setFormat] = useState<'a4' | 'ticket'>('a4');
  const [busy, setBusy] = useState(false), [secure, setSecure] = useState(false), [error, setError] = useState<string>();
  const [confirm, setConfirm] = useState<'authorize' | 'revoke' | 'send'>(), [submitted, setSubmitted] = useState<DocumentJob>();
  const attempt = useRef<{ body: string; key: string } | undefined>(undefined);
  useEffect(() => { setSecure(location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)); }, []);
  const runtime = resource.data;
  const matches = runtime?.companyId === companyId && runtime.ruc === ruc && runtime.documentId === documentId && runtime.scope === 'DOCUMENT' && runtime.environment === 'PRODUCTION' && ['01', '03', '07', '08'].includes(runtime.documentType);
  const locked = busy || disabled || !secure || !matches || !runtime?.storageReady;
  const validRecipient = recipient.length <= 254 && /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(recipient);
  async function execute() {
    if (!runtime || !confirm || locked) return;
    const action = confirm; setBusy(true); setError(undefined);
    try {
      const base = { expectedRevision: runtime.configurationRevision, expectedActivationRevision: runtime.activationRevision, confirmed: true };
      if (action === 'send') {
        if (!validRecipient || !runtime.readyToSendDocument) return;
        const body = JSON.stringify({ ...base, documentId, format, recipient });
        if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
        const job = await api<DocumentJob>(`${path}/send-document`, { method: 'POST', body,
          headers: { 'Idempotency-Key': attempt.current.key }, signal: AbortSignal.timeout(60000) });
        if (job.documentId !== documentId || job.scope !== 'DOCUMENT' || job.deliveredToClient !== false) throw new Error('Resultado documental inconsistente; consulte el estado.');
        setSubmitted(job);
      } else {
        await api(`${path}/document-activation`, { method: 'POST', body: JSON.stringify({ ...base, enabled: action === 'authorize' }), signal: AbortSignal.timeout(20000) });
      }
      setConfirm(undefined); resource.reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo completar el envío documental'); resource.reload(); }
    finally { setBusy(false); }
  }
  return <Card><CardHeader><CardTitle className="text-base">Enviar comprobante por correo corporativo</CardTitle>
    <CardDescription>Factura 01, boleta 03, nota de crédito 07 o nota de débito 08 de Producción aceptadas, incluidas las aceptadas con observaciones. Se utiliza el remitente SMTP guardado para este RUC.</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      {resource.error ? <ErrorState message={resource.error} retry={resource.reload} /> : !runtime ? <Loading /> : !matches ? <ErrorState message="El estado de correo pertenece a otro comprobante o emisor." /> : <>
        <Badge variant="outline">{runtime.readyToSendDocument ? 'Envío DOCUMENT disponible' : 'Envío DOCUMENT no disponible'}</Badge>
        <p className="text-sm">{runtime.fullNumber} · RUC {ruc} · Configuración {runtime.configurationRevision} · Autorización DOCUMENT {runtime.activationRevision}</p>
        <p className="text-xs text-muted-foreground">Servidor: {runtime.serverEnabled ? 'habilitado' : 'deshabilitado'} · Tablas: {runtime.storageReady ? 'preparadas' : 'pendientes'} · Worker: {runtime.workerReady ? 'disponible' : 'no disponible'} · Autorización: {runtime.grantCurrent ? 'vigente' : runtime.enabledForDocuments ? 'obsoleta' : 'no concedida'}</p>
        <p className="text-sm">La autorización de pruebas no habilita comprobantes. Autorizar DOCUMENT permite enviar comprobantes de este RUC con esta revisión; cada envío exige confirmar su destinatario.</p>
        <div className="flex flex-wrap gap-3"><Button variant="outline" disabled={locked || !runtime.serverEnabled || runtime.configurationRevision < 1 || runtime.grantCurrent} onClick={() => setConfirm('authorize')}>Autorizar DOCUMENT para este RUC</Button>
          <Button variant="outline" disabled={locked || !runtime.enabledForDocuments} onClick={() => setConfirm('revoke')}>Retirar autorización DOCUMENT</Button></div>
        <div className="space-y-2"><Label htmlFor="document-mail-recipient">Destinatario del comprobante</Label><Input id="document-mail-recipient" type="email" maxLength={254} autoComplete="off" value={recipient} disabled={busy || disabled}
          onChange={event => { setRecipient(event.target.value); setSubmitted(undefined); attempt.current = undefined; }} placeholder="Escriba el correo autorizado por el cliente" /></div>
        <div className="space-y-2"><Label htmlFor="document-mail-format">Formato del PDF actual</Label><Select value={format} disabled={busy || disabled} onValueChange={value => { setFormat(value as 'a4' | 'ticket'); setSubmitted(undefined); attempt.current = undefined; }}>
          <SelectTrigger id="document-mail-format"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="a4">A4</SelectItem><SelectItem value="ticket">Ticket 80 mm</SelectItem></SelectContent></Select></div>
        <p className="text-xs text-muted-foreground">Adjuntos: PDF actual, XML firmado, ZIP de envío, CDR XML y CDR ZIP originales. Para factura 01 y notas 07/08, el ZIP y CDR corresponden al comprobante individual. Para boleta 03, el ZIP y CDR corresponden al resumen RC vinculado. No se generan originales nuevos.</p>
        <p className="text-xs text-muted-foreground">La aceptación SMTP no confirma entrega. Un resultado incierto no se reenvía automáticamente. La sesión y autorización del trabajo deben seguir vigentes al procesarlo; la tarea vence en dos minutos.</p>
        <div className="flex flex-wrap gap-3"><Button disabled={locked || !runtime.readyToSendDocument || !validRecipient || Boolean(submitted)} onClick={() => setConfirm('send')}>Enviar comprobante</Button>
          <Button variant="outline" disabled={busy} onClick={resource.reload}>Actualizar estado</Button>
          {submitted && <Button variant="outline" disabled={busy} onClick={() => { setSubmitted(undefined); attempt.current = undefined; }}>Preparar otro envío</Button>}</div>
        {submitted && <p role="status" className="text-sm">Solicitud registrada: {submitted.id}. Consulte su resultado antes de solicitar otro envío.</p>}
        <FiscalDocumentMailHistory jobs={runtime.jobs ?? []} />
      </>}
      {!secure && <p className="text-xs text-muted-foreground">Abra esta pantalla con HTTPS para autorizar y enviar.</p>}
      {error && <ErrorState message={error} />}
      <Dialog open={Boolean(confirm)} onOpenChange={open => { if (!busy && !open) setConfirm(undefined); }}><DialogContent><DialogHeader>
        <DialogTitle>{confirm === 'send' ? 'Confirmar envío del comprobante' : confirm === 'authorize' ? 'Autorizar envío DOCUMENT' : 'Retirar autorización DOCUMENT'}</DialogTitle>
        <DialogDescription>RUC {ruc} · Configuración {runtime?.configurationRevision} · Autorización DOCUMENT {runtime?.activationRevision}.
          {confirm === 'send' ? ` Autorizo enviar ${runtime?.fullNumber} a ${recipient}, con PDF ${format} y sus originales. Confirmo que este es el destinatario autorizado. La aceptación SMTP no acredita entrega.` : confirm === 'authorize' ? ' Autorizo expresamente el envío de facturas 01, boletas 03, notas de crédito 07 y notas de débito 08 aceptadas en Producción de este RUC con estas credenciales y remitente. No concede B2B ni envía mensajes al activar.' : ' Las tareas que no hayan iniciado SMTP serán denegadas. No se puede retirar un mensaje ya entregado al servidor.'}</DialogDescription>
      </DialogHeader>{error && <ErrorState message={error} />}<DialogFooter><Button variant="outline" disabled={busy} onClick={() => setConfirm(undefined)}>Cancelar</Button>
        <Button disabled={locked} onClick={() => void execute()}>{busy ? 'Procesando…' : confirm === 'send' ? 'Confirmar destinatario y enviar comprobante' : 'Confirmar autorización DOCUMENT'}</Button></DialogFooter></DialogContent></Dialog>
    </CardContent></Card>;
}
export function FiscalDocumentMailHistory({ jobs }: { jobs: DocumentJob[] }) {
  return <div className="space-y-2">{jobs.map(job => <div key={job.id} className="rounded-md border p-3 text-sm"><p>{labels[job.state] ?? 'Estado no disponible'}</p>
    <p className="mt-1 break-all text-xs text-muted-foreground">{job.id} · PDF {job.format} · Configuración {job.configurationRevision} · Autorización DOCUMENT {job.activationRevision}</p></div>)}</div>;
}
