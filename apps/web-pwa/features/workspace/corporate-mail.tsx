"use client";
import { useRef, useState } from 'react';
import { Button } from '@factuez/ui/components/button';
import { Input } from '@factuez/ui/components/input';
import { Label } from '@factuez/ui/components/label';
import { Badge } from '@factuez/ui/components/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@factuez/ui/components/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@factuez/ui/components/dialog';
import { useResource, useWorkspace } from './provider';
import { ErrorState, Loading } from './common';

type Job = { id: string; state: string; configurationRevision: number; activationRevision: number; createdAt: string; handedOffToSmtp: boolean; deliveredToClient: false };
type Runtime = { companyId: number; ruc: string; configurationRevision: number; activationRevision: number;
  state: string; serverEnabled: boolean; storageReady: boolean; workerReady: boolean; enabledForRuc: boolean;
  grantCurrent: boolean; readyToSendTest: boolean; jobs: Job[];
  events: { event: string; actorId: string; configurationRevision: number; activationRevision: number; createdAt: string }[] };
export const corporateMailStateLabels: Record<string, string> = {
  QUEUED: 'En cola', PREPARING: 'Preparando', SENDING: 'Enviando', HANDED_OFF: 'Entregado al servidor SMTP; entrega al destinatario no confirmada',
  UNKNOWN: 'Resultado incierto; sin reenvío automático', FAILED: 'Falló antes del envío', CANCELLED: 'Cancelado o autorización vencida',
  ACTIVATED: 'Autorización concedida', DEACTIVATED: 'Autorización retirada',
};
export function CorporateMail({ companyId, ruc, revision, dirty, secureTransport, parentBusy, onChange }: {
  companyId: number; ruc: string; revision: number; dirty: boolean; secureTransport: boolean; parentBusy: boolean; onChange: () => void;
}) {
  const { api, user, can } = useWorkspace();
  const resource = useResource<Runtime>(`/api/v1/mail-settings/${companyId}/corporate`);
  const [recipient, setRecipient] = useState('');
  const [confirm, setConfirm] = useState<'activate' | 'deactivate' | 'test'>();
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const [submitted, setSubmitted] = useState<Job>();
  const attempt = useRef<{ body: string; key: string } | undefined>(undefined);
  if (!can('document.email') || user?.scope.kind !== 'GLOBAL' || !user.roles.includes('ADMIN')) return null;
  const runtime = resource.data;
  const current = runtime?.companyId === companyId && runtime.ruc === ruc && runtime.configurationRevision === revision;
  const locked = busy || parentBusy || dirty || !secureTransport || !current || !runtime?.storageReady;
  const path = `/api/v1/mail-settings/${companyId}`;
  const validRecipient = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(recipient) && recipient.length <= 254;
  async function execute() {
    if (!runtime || locked || !confirm) return;
    const action = confirm; setBusy(true); setError(undefined);
    try {
      const base = { expectedRevision: revision, expectedActivationRevision: runtime.activationRevision, confirmed: true };
      if (action === 'test') {
        if (!validRecipient || !runtime.readyToSendTest) return;
        const body = JSON.stringify({ ...base, recipient });
        if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
        const job = await api<Job>(`${path}/send-test`, { method: 'POST', body,
          headers: { 'Idempotency-Key': attempt.current.key }, signal: AbortSignal.timeout(20000) });
        if (job.deliveredToClient !== false || !job.id) throw new Error('Respuesta de tarea de correo inválida');
        setSubmitted(job);
      } else {
        await api(`${path}/activation`, { method: 'POST', body: JSON.stringify({ ...base, enabled: action === 'activate' }), signal: AbortSignal.timeout(20000) });
      }
      setConfirm(undefined); resource.reload(); onChange();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo completar la acción de correo'); resource.reload(); }
    finally { setBusy(false); }
  }
  return <Card><CardHeader><CardTitle className="text-base">Envío corporativo de prueba por RUC</CardTitle>
    <CardDescription>Autorización explícita para la revisión guardada. Este circuito envía una prueba sin adjuntos; no concede permisos B2B ni envía comprobantes de clientes API.</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      {resource.error ? <ErrorState message={resource.error} retry={resource.reload} /> : !runtime ? <Loading /> : <>
        <Badge variant="outline">{runtime.readyToSendTest && current ? 'Correo de prueba habilitado' : 'Envío corporativo no disponible'}</Badge>
        <p className="text-xs text-muted-foreground">Servidor: {runtime.serverEnabled ? 'habilitado' : 'deshabilitado'} · Tablas: {runtime.storageReady ? 'preparadas' : 'pendientes'} · Cola y worker: {runtime.workerReady ? 'disponibles' : 'no disponibles'} · Autorización del RUC: {runtime.grantCurrent && current ? 'vigente para esta revisión' : runtime.enabledForRuc ? 'obsoleta; requiere nueva autorización' : 'no concedida'} · Revisión de autorización {runtime.activationRevision}</p>
        <p className="text-sm">RUC {ruc} · Configuración {revision}. Guardar o cambiar credenciales exige autorizar la nueva revisión antes de enviar.</p>
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" disabled={locked || !runtime.serverEnabled || revision < 1 || runtime.grantCurrent} onClick={() => setConfirm('activate')}>Autorizar esta revisión para pruebas</Button>
          <Button variant="outline" disabled={locked || !runtime.enabledForRuc} onClick={() => setConfirm('deactivate')}>Retirar autorización de envío</Button>
        </div>
        <div className="space-y-2"><Label htmlFor="corporate-test-recipient">Destinatario de la prueba</Label>
          <Input id="corporate-test-recipient" type="email" value={recipient} maxLength={254} autoComplete="off" disabled={busy || parentBusy}
            onChange={event => { setRecipient(event.target.value); setSubmitted(undefined); attempt.current = undefined; }} placeholder="Escriba el correo que autoriza recibir esta prueba" />
        </div>
        <p className="text-xs text-muted-foreground">Se enviará un único mensaje real desde el remitente guardado, sin adjuntos. La aceptación del servidor SMTP no garantiza la entrega. No se guardan direcciones en el navegador, Redis ni la auditoría.</p>
        <div className="flex flex-wrap gap-3"><Button disabled={locked || !runtime.readyToSendTest || !validRecipient || Boolean(submitted)} onClick={() => setConfirm('test')}>Enviar correo de prueba</Button>
          {submitted && <Button variant="outline" disabled={busy} onClick={() => { setSubmitted(undefined); attempt.current = undefined; }}>Preparar otra prueba</Button>}
          <Button variant="outline" disabled={busy} onClick={resource.reload}>Actualizar estado</Button></div>
        {dirty && <p role="status" className="text-sm">Guarde o descarte los cambios antes de autorizar o enviar.</p>}
        {submitted && <p role="status" className="text-sm">Solicitud registrada: {submitted.id}. Consulte su estado antes de preparar otra prueba.</p>}
        <CorporateMailHistory jobs={runtime.jobs ?? []} events={runtime.events ?? []} />
      </>}
      {error && <ErrorState message={error} />}
      <Dialog open={Boolean(confirm)} onOpenChange={open => { if (!busy && !open) setConfirm(undefined); }}><DialogContent><DialogHeader>
        <DialogTitle>{confirm === 'test' ? 'Confirmar envío real de prueba' : confirm === 'activate' ? 'Autorizar correo para este RUC' : 'Retirar autorización de envío'}</DialogTitle>
        <DialogDescription>RUC {ruc} · Revisión {revision} · Autorización {runtime?.activationRevision ?? 0}.
          {confirm === 'test' ? ` Se enviará un mensaje sin adjuntos a ${recipient}. Confirmo que autorizo este destinatario. No se confirma entrega por la aceptación SMTP.` : confirm === 'activate' ? ' Autorizo expresamente el envío de pruebas desde este remitente y estas credenciales. Esta acción no envía mensajes ni concede permisos B2B.' : ' Las tareas pendientes de esta autorización no podrán iniciar nuevos envíos. Un mensaje ya entregado al servidor no se puede retirar.'}</DialogDescription>
      </DialogHeader>{error && <ErrorState message={error} />}<DialogFooter><Button variant="outline" disabled={busy} onClick={() => setConfirm(undefined)}>Cancelar</Button>
        <Button disabled={locked} onClick={() => void execute()}>{busy ? 'Procesando…' : confirm === 'test' ? 'Confirmar destinatario y enviar' : 'Confirmar autorización'}</Button></DialogFooter></DialogContent></Dialog>
    </CardContent>
  </Card>;
}
export function CorporateMailHistory({ jobs, events }: { jobs: Job[]; events: Runtime['events'] }) {
  return <div className="space-y-3"><p className="text-sm font-medium">Últimas pruebas y autorizaciones</p>
    {!jobs.length && <p className="text-xs text-muted-foreground">Todavía no hay pruebas registradas.</p>}
    {jobs.map(job => <div key={job.id} className="rounded-md border p-3 text-sm"><p>{corporateMailStateLabels[job.state] ?? 'Estado no disponible'}</p>
      <p className="mt-1 break-all text-xs text-muted-foreground">{job.id} · Configuración {job.configurationRevision} · Autorización {job.activationRevision}</p></div>)}
    {events.slice(0, 10).map((event, index) => <p key={index} className="text-xs text-muted-foreground">{corporateMailStateLabels[event.event] ?? 'Evento de correo'} · Configuración {event.configurationRevision} · Autorización {event.activationRevision} · {new Date(event.createdAt).toLocaleString('es-PE', { timeZone: 'America/Lima' })}</p>)}
  </div>;
}
