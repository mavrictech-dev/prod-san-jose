"use client";
import { useEffect, useState } from 'react';
import { Mail, Wifi } from 'lucide-react';
import { Button } from '@factuez/ui/components/button';
import { Input } from '@factuez/ui/components/input';
import { Label } from '@factuez/ui/components/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@factuez/ui/components/dialog';
import { useResource, useWorkspace } from './provider';
type Delivery = { id: string; recipient: string; status: string; description: string | null; attachments: { filename: string; size: number }[] };
export function LocalMailPanel({ documentId, enabled }: { documentId: string; enabled: boolean }) {
  const { api, liveStatus } = useWorkspace(); const resource = useResource<{ deliveries: Delivery[] }>(`/api/v1/mail-qa/${documentId}`, true);
  const [open, setOpen] = useState(false); const [recipient, setRecipient] = useState('cliente@pruebas.invalid');
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string>();
  useEffect(() => { setError(undefined); }, [documentId]);
  async function send() {
    if (busy) return; setBusy(true); setError(undefined);
    try { await api(`/api/v1/mail-qa/${documentId}`, { method: 'POST', body: JSON.stringify({ recipient, format: 'ticket' }), signal: AbortSignal.timeout(35000) }); setOpen(false); resource.reload(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo encolar el correo'); } finally { setBusy(false); }
  }
  return <div className="space-y-3 rounded-lg border p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">Correo de prueba local</p><span className="flex items-center gap-1 text-xs text-muted-foreground"><Wifi className="size-3" />{liveStatus === 'connected' ? 'Socket.io conectado' : 'Socket.io no conectado · Consulta REST disponible'}</span></div>
    <p className="text-xs text-muted-foreground">Mailpit captura los mensajes dentro de la red QA. No se envían a clientes. Adjuntos: ticket PDF y ZIP con XML firmado/CDR simulado.</p>
    <Button variant="outline" disabled={!enabled} onClick={() => setOpen(true)}><Mail className="size-4" />Enviar a capturador local</Button>
    {resource.error && <p role="alert" className="text-sm text-destructive">{resource.error}</p>}
    {resource.data?.deliveries.map(row => <div key={row.id} role="status" className="rounded-md bg-muted p-3 text-xs"><p className="font-medium">{row.recipient} · {row.status === 'CAPTURED_LOCAL' ? 'Capturado localmente' : row.status}</p><p>{row.description}</p>{row.attachments.map(file => <p className="mt-1 break-all" key={file.filename}>{file.filename}</p>)}</div>)}
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}><DialogContent><DialogHeader><DialogTitle>Capturar correo de desarrollo</DialogTitle><DialogDescription>Use un destinatario .invalid. El mensaje no saldrá de Mailpit local.</DialogDescription></DialogHeader>
      <Label htmlFor="qa-recipient">Correo ficticio</Label><Input id="qa-recipient" type="email" value={recipient} onChange={event => setRecipient(event.target.value)} disabled={busy} />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter><Button disabled={busy} onClick={() => void send()}>{busy ? 'Preparando adjuntos…' : 'Encolar prueba local'}</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>;
}
