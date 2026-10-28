"use client";
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { FileDown, FileMinus2, FilePlus2, ShieldCheck } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@factuez/ui/components/card';
import { Button } from '@factuez/ui/components/button';
import { Input } from '@factuez/ui/components/input';
import { Label } from '@factuez/ui/components/label';
import { Badge } from '@factuez/ui/components/badge';
import { Checkbox } from '@factuez/ui/components/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@factuez/ui/components/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@factuez/ui/components/table';
import { ErrorState, Loading, money } from './common';
import { useResource, useWorkspace } from './provider';
import { PdfPrintButton } from './pdf-print';

type Original = { id: string; immutableSnapshot: {
  documentTypeCode: string; fullNumber: string; issuer: { identityNumber: string; legalName: string };
  customer: { legalName: string }; currencyCode: string;
  lines: { lineNumber: number; description: string; quantity: string; unitCode: string; unitPriceWithTax: string }[];
  totals: { payableAmount: string };
} };
type Note = { id: string; state: string; description: string | null; digestValue: string | null; signatureVerified: boolean;
  xsdValidated: boolean; xmlAvailable: boolean; zipAvailable: boolean; pdfAvailable: boolean;
  transportQa: null | { state: string; scenario: string; mode: string; ticket: string | null; reference: string;
    attempts: number; polls: number; description: string; responseCode?: string; notes?: string[]; cdrAvailable: boolean; requestAvailable: boolean };
  snapshot: { documentTypeCode: string; fullNumber: string; reasonCode: string; reasonDescription: string;
    reference: { fullNumber: string }; totals: { taxableAmount: string; igvAmount: string; payableAmount: string }; } };
type NoteList = { reasons: Record<'07' | '08', { code: string; label: string; supported: boolean }[]>; items: Note[] };
const labels: Record<string, string> = { QUEUED: 'En cola de firma local', SIGNING: 'Firmando en laboratorio', SIGNED_LOCAL: 'Firmada localmente · No fiscal', BLOCKED: 'Bloqueada · Revisión requerida' };
const transportLabels: Record<string, string> = { QUEUED: 'Transporte en cola', SENDING: 'Procesando en emulador', WAITING_TICKET: 'Consultando el mismo ticket', ACCEPTED: 'Aceptada · Simulado', OBSERVED: 'Observada · Simulado', REJECTED: 'Rechazada · Simulado', UNKNOWN: 'Resultado incierto · No reenviar', BLOCKED: 'Transporte bloqueado' };
const scenarios = [ ['ACCEPTED', 'Aceptación'], ['OBSERVED', 'Observación'], ['REJECTED', 'Rechazo'], ['UNCERTAIN', 'Respuesta perdida'], ['INVALID_CDR', 'CDR de referencia incorrecta'], ['TRANSIENT_STATUS', 'Consulta temporalmente fallida'] ] as const;
type DownloadFormat = 'xml' | 'zip' | 'ticket' | 'a4' | 'cdr-xml' | 'cdr-zip' | 'transport-xml' | 'transport-zip';

export function NotesQaPanel({ originalDocumentId }: { originalDocumentId: string }) {
  const { user, api, apiBlob, setDirty, liveStatus } = useWorkspace();
  const { data: original, error: originalError } = useResource<Original>(`/api/v1/documents/${originalDocumentId}`);
  const { data, error: listError, reload } = useResource<NoteList>(`/api/v1/notes-qa/reference/${originalDocumentId}`, true);
  const [type, setType] = useState<'07' | '08'>('07'); const [reason, setReason] = useState('01');
  const [description, setDescription] = useState(''); const [selections, setSelections] = useState<Record<number, { selected: boolean; quantity: string; increment: string }>>({});
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string>();
  const [scenario, setScenario] = useState('ACCEPTED');
  const requestKey = useRef<string | undefined>(undefined); const version = useRef(0); const downloadUrls = useRef(new Set<string>());
  const full = type === '07' && ['01', '06'].includes(reason);
  const admin = user?.roles.includes('ADMIN') && user.scope.kind === 'GLOBAL' && user.permissions.includes('document.issue') && user.permissions.includes('sunat.configure');
  useEffect(() => { requestKey.current = undefined; setDescription(''); setSelections({}); setError(undefined); setDirty(false); version.current++; }, [originalDocumentId, api, setDirty]);
  useEffect(() => () => { version.current++; for (const url of downloadUrls.current) URL.revokeObjectURL(url); downloadUrls.current.clear(); }, []);
  const changed = () => { requestKey.current = undefined; setDirty(true); };
  const hasCredit = data?.items.some(note => note.snapshot.documentTypeCode === '07');
  async function submit() {
    setBusy(true); setError(undefined); const operation = version.current;
    requestKey.current ??= crypto.randomUUID();
    try {
      const lines = original?.immutableSnapshot.lines.filter(line => selections[line.lineNumber]?.selected).map(line => ({
        originalLineNumber: line.lineNumber, quantity: selections[line.lineNumber].quantity,
        ...(type === '08' ? { unitPriceWithTax: selections[line.lineNumber].increment } : {}),
      }));
      await api(`/api/v1/notes-qa/reference/${originalDocumentId}`, { method: 'POST',
        body: JSON.stringify({ idempotencyKey: requestKey.current, documentTypeCode: type, reasonCode: reason, reasonDescription: description, ...(!full ? { lines } : {}) }), signal: AbortSignal.timeout(25000) });
      if (version.current !== operation) return;
      requestKey.current = undefined; setDirty(false); setDescription(''); setSelections({}); reload();
    } catch (cause) { if (version.current === operation) setError(cause instanceof Error ? cause.message : 'No se pudo preparar la nota'); }
    finally { if (version.current === operation) setBusy(false); }
  }
  async function enqueueTransport(note: Note) {
    setBusy(true); setError(undefined); const operation = version.current;
    try {
      await api(`/api/v1/notes-qa/${note.id}/transport`, { method: 'POST', body: JSON.stringify({ scenario }), signal: AbortSignal.timeout(25000) });
      if (version.current === operation) reload();
    } catch (cause) { if (version.current === operation) setError(cause instanceof Error ? cause.message : 'Transporte QA no disponible'); }
    finally { if (version.current === operation) setBusy(false); }
  }
  async function download(note: Note, format: DownloadFormat) {
    setBusy(true); setError(undefined); const operation = version.current;
    try {
      const extension = format.endsWith('xml') ? 'xml' : format.endsWith('zip') ? 'zip' : 'pdf';
      const blob = await apiBlob(`/api/v1/notes-qa/${note.id}/${format}`, AbortSignal.timeout(25000), extension === 'xml' ? 'application/xml' : extension === 'zip' ? 'application/zip' : 'application/pdf');
      if (version.current !== operation) return;
      const url = URL.createObjectURL(blob); downloadUrls.current.add(url);
      const link = document.createElement('a'); link.href = url; link.download = `${note.snapshot.fullNumber}-${format}-SIMULADO-NO-FISCAL.${extension}`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.current.delete(url); }, 60000);
    } catch (cause) { if (version.current === operation) setError(cause instanceof Error ? cause.message : 'Descarga no disponible'); }
    finally { if (version.current === operation) setBusy(false); }
  }
  if (!admin) return <ErrorState message="Las notas QA están disponibles sólo para el administrador general. No emiten documentos fiscales." />;
  if (originalError) return <ErrorState message={originalError} />;
  if (!original) return <Loading />;
  const snapshot = original.immutableSnapshot;
  return <div className="space-y-6">
    <div role="note" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">Laboratorio con emisor ficticio 00…, BETA y certificado autofirmado. Transporte y CDR SIMULADOS: sin envío a SUNAT y sin valor fiscal. Cada nota admite un escenario; un resultado incierto conserva su reserva y no se reenvía.</div>
    <Card className="shadow-none"><CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="size-5" />Original de la nota</CardTitle>
      <CardDescription>Referencia obligatoria · Mismo emisor, cliente y moneda. Debe contar con CDR aceptado del emulador.</CardDescription></CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-4"><div><p className="font-semibold">{snapshot.fullNumber} · {money(snapshot.totals.payableAmount, snapshot.currencyCode)}</p><p className="mt-1 text-sm text-muted-foreground">{snapshot.issuer.legalName} · {snapshot.issuer.identityNumber}</p><p className="text-sm text-muted-foreground">{snapshot.customer.legalName}</p></div><Button variant="outline" asChild><Link href={`/documents/${originalDocumentId}`}>Ver comprobante original</Link></Button></CardContent>
    </Card>
    {listError ? <ErrorState message={listError} retry={reload} /> : !data ? <Loading /> : <Card className="shadow-none"><CardHeader><CardTitle>Preparar nota de prueba</CardTitle><CardDescription>UBL 2.1, PEN e IGV 18%. Numeración QA independiente. No cambia ventas ni el estado oficial.</CardDescription></CardHeader>
      <CardContent><form onSubmit={event => { event.preventDefault(); void submit(); }} className="space-y-5">
        <div className="grid gap-4 md:grid-cols-2"><div className="space-y-2"><Label htmlFor="note-type">Tipo de nota</Label><Select value={type} disabled={busy} onValueChange={value => { setType(value as '07' | '08'); setReason(value === '07' ? '01' : '02'); changed(); }}><SelectTrigger id="note-type"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="07">07 · Nota de crédito</SelectItem><SelectItem value="08">08 · Nota de débito</SelectItem></SelectContent></Select></div>
          <div className="space-y-2"><Label htmlFor="note-reason">Motivo SUNAT · Perfil acotado</Label><Select value={reason} disabled={busy} onValueChange={value => { setReason(value); changed(); }}><SelectTrigger id="note-reason"><SelectValue /></SelectTrigger><SelectContent>{data.reasons[type].map(item => <SelectItem key={item.code} value={item.code} disabled={!item.supported}>{item.code} · {item.label}{!item.supported ? ' · No habilitado' : ''}</SelectItem>)}</SelectContent></Select></div></div>
        <div className="space-y-2"><Label htmlFor="note-description">Sustento del ajuste</Label><Input id="note-description" required maxLength={250} value={description} disabled={busy} onChange={event => { setDescription(event.target.value); changed(); }} placeholder="Describe el motivo de esta nota ficticia…" /></div>
        {full ? <p className="rounded-lg bg-muted p-3 text-sm">Se derivarán todas las líneas e importes del original. Sólo se permite un crédito reservado por comprobante en este perfil, incluso si quedó bloqueado.</p> : <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>Aplicar</TableHead><TableHead>Ítem original</TableHead><TableHead>Cantidad del ajuste</TableHead>{type === '08' && <TableHead>Aumento unitario con IGV</TableHead>}</TableRow></TableHeader><TableBody>{snapshot.lines.map(line => {
          const value = selections[line.lineNumber] ?? { selected: false, quantity: line.quantity, increment: '' };
          const update = (change: Partial<typeof value>) => { setSelections(current => ({ ...current, [line.lineNumber]: { ...value, ...change } })); changed(); };
          return <TableRow key={line.lineNumber}><TableCell><Checkbox checked={value.selected} disabled={busy} aria-label={`Aplicar ajuste al ítem ${line.lineNumber}`} onCheckedChange={selected => update({ selected: selected === true })} /></TableCell><TableCell><p>{line.description}</p><p className="text-xs text-muted-foreground">Original: {line.quantity} {line.unitCode} · {money(line.unitPriceWithTax)}</p></TableCell><TableCell><Input aria-label={`Cantidad de ajuste ítem ${line.lineNumber}`} inputMode="decimal" maxLength={19} className="min-w-28" value={value.quantity} disabled={busy || !value.selected} onChange={event => update({ quantity: event.target.value })} /></TableCell>{type === '08' && <TableCell><Input aria-label={`Aumento unitario ítem ${line.lineNumber}`} inputMode="decimal" maxLength={19} className="min-w-28" value={value.increment} disabled={busy || !value.selected} onChange={event => update({ increment: event.target.value })} placeholder="Importe adicional, no precio final" /></TableCell>}</TableRow>;
        })}</TableBody></Table></div>}
        {type === '07' && hasCredit && <ErrorState message="Este original ya tiene un crédito reservado. El perfil v1 no libera saldo ni recicla números; utiliza otro comprobante ficticio para una nueva prueba de crédito." />}
        <p className="text-xs text-muted-foreground">Crédito: anulación total, devolución total o parcial con precio original. Débito: aumento en el valor, sólo el importe adicional por unidad. Los otros motivos quedan bloqueados; no se simula su tratamiento fiscal.</p>
        <Button type="submit" disabled={busy || !description.trim() || (type === '07' && hasCredit) || (!full && !Object.values(selections).some(line => line.selected))}>{type === '07' ? <FileMinus2 className="size-4" /> : <FilePlus2 className="size-4" />}{busy ? 'Preparando…' : 'Preparar y firmar nota local'}</Button>
      </form></CardContent></Card>}
    {error && <ErrorState message={error} />}
    <Card className="shadow-none"><CardHeader><CardTitle>Notas vinculadas</CardTitle><CardDescription>{liveStatus === 'connected' ? 'Socket.io conectado' : 'Actualización por consultas REST'} · Los artefactos se descargan con tu sesión vigente.</CardDescription></CardHeader>
      <CardContent className="space-y-2"><Label htmlFor="note-transport-scenario">Escenario del emulador para notas sin transporte reservado</Label><Select value={scenario} disabled={busy} onValueChange={setScenario}><SelectTrigger id="note-transport-scenario"><SelectValue /></SelectTrigger><SelectContent>{scenarios.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select><p className="text-xs text-muted-foreground">Notas F: sendBill. Notas B: RC propio con referencia a su boleta y consulta del mismo ticket. El escenario se fija al encolar.</p></CardContent>
      <CardContent className="space-y-4">{data?.items.length === 0 && <p className="text-sm text-muted-foreground">Todavía no se han preparado notas para este comprobante.</p>}{data?.items.map(note => <section key={note.id} className="rounded-lg border p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-semibold">{note.snapshot.fullNumber} · {note.snapshot.documentTypeCode === '07' ? 'Crédito' : 'Débito'}</p><p className="mt-1 text-sm text-muted-foreground">{note.snapshot.reasonCode} · {note.snapshot.reasonDescription}</p></div><Badge variant="outline">{labels[note.state] ?? note.state}</Badge></div>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3"><div><dt className="text-muted-foreground">Base del ajuste</dt><dd>{money(note.snapshot.totals.taxableAmount)}</dd></div><div><dt className="text-muted-foreground">IGV</dt><dd>{money(note.snapshot.totals.igvAmount)}</dd></div><div><dt className="text-muted-foreground">Total del ajuste</dt><dd className="font-semibold">{money(note.snapshot.totals.payableAmount)}</dd></div></dl>
        <p className="mt-3 text-xs text-muted-foreground">{note.description} · XSD: {note.xsdValidated ? 'estructura verificada' : 'sin evidencia'}. Sin aceptación ni CDR oficial.</p>{note.digestValue && <p className="mt-2 break-all font-mono text-xs">Hash de la nota: {note.digestValue}</p>}
        {note.transportQa && <div className="mt-3 space-y-2 rounded-md bg-muted p-3 text-sm"><Badge variant="outline">{transportLabels[note.transportQa.state] ?? note.transportQa.state}</Badge><p>{note.transportQa.description}</p><p className="break-all text-xs">{note.transportQa.mode} · {note.transportQa.reference} · Escenario {note.transportQa.scenario} · Preparaciones {note.transportQa.attempts}/3 · Consultas {note.transportQa.polls}/8{note.transportQa.ticket ? ` · Ticket ${note.transportQa.ticket}` : ''}</p>{note.transportQa.responseCode && <p>Código simulado: {note.transportQa.responseCode}</p>}{note.transportQa.notes?.map((text, index) => <p key={index}>{text}</p>)}</div>}
        <div className="mt-4 flex flex-wrap gap-2">{!note.transportQa && <Button variant="secondary" size="sm" disabled={busy || !note.signatureVerified || !note.xsdValidated} onClick={() => void enqueueTransport(note)}>Encolar transporte simulado</Button>}{note.transportQa?.requestAvailable && (['transport-xml', 'transport-zip'] as const).map(format => <Button key={format} variant="outline" size="sm" disabled={busy} onClick={() => void download(note, format)}>Petición {format.endsWith('xml') ? 'XML' : 'ZIP'} simulada</Button>)}{note.transportQa?.cdrAvailable && (['cdr-xml', 'cdr-zip'] as const).map(format => <Button key={format} variant="outline" size="sm" disabled={busy} onClick={() => void download(note, format)}><FileDown className="size-4" />CDR {format.endsWith('xml') ? 'XML' : 'ZIP'} simulado</Button>)}</div>
        <div className="mt-4 flex flex-wrap gap-2">{(['xml', 'zip'] as const).map(format => <Button key={format} variant="outline" size="sm" disabled={busy || !(format === 'xml' ? note.xmlAvailable : note.zipAvailable)} onClick={() => void download(note, format)}><FileDown className="size-4" />{format === 'xml' ? 'XML firmado local' : 'ZIP de nota local'}</Button>)}{note.pdfAvailable && <><Button variant="outline" size="sm" disabled={busy} onClick={() => void download(note, 'ticket')}>PDF ticket de nota</Button><Button variant="outline" size="sm" disabled={busy} onClick={() => void download(note, 'a4')}>PDF A4 de nota</Button><PdfPrintButton path={`/api/v1/notes-qa/${note.id}/ticket`} format="ticket" disabled={busy} /><PdfPrintButton path={`/api/v1/notes-qa/${note.id}/a4`} format="a4" disabled={busy} /></>}</div>
      </section>)}</CardContent>
    </Card>
  </div>;
}
