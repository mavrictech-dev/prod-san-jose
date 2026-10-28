"use client";
import {ReceivedProductionActivation} from './received-production-activation';

import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Badge } from '@factuez/ui/components/badge';
import { Button } from '@factuez/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@factuez/ui/components/card';
import { Input } from '@factuez/ui/components/input';
import { Label } from '@factuez/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@factuez/ui/components/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@factuez/ui/components/table';
import type { ReceivedAutomationConfig, ReceivedSireDiscovery, ReceivedSyncRun } from '@factuez/contracts';
import { Empty, ErrorState, Loading } from './common';
import { ApiError, useResource, useWorkspace } from './provider';
import { createReceivedOperation, receivedAmount, receivedTypeLabel, type ReceivedSelection } from './received-documents-model';
import {
  canManageReceivedAutomation, createReceivedAutomationDraft, createReceivedAutomationPoll,
  receivedAutomationConfigInScope, receivedAutomationDiscoveriesInScope, receivedAutomationDraftDirty,
  receivedAutomationIncidentsValid, receivedAutomationQuery, receivedAutomationRunsValid, receivedAutomationSave, receivedAutomationScopeKey,
  receivedAutomationSelectionAllowed, receivedAutomationSettingsError, receivedAutomationSyncBlock,
  reconcileReceivedAutomationDraft, RECEIVED_AUTOMATION_API, RECEIVED_AUTOMATION_POLL_MS,
  type ReceivedAutomationDraft, type ReceivedAutomationSource, type ReceivedSireIncidentMetadata,
} from './received-automation-model';

const states = { DISABLED: 'Deshabilitada', READY_LOCAL: 'Lista para fixtures locales', WAITING_TI: 'Esperando TI', READY_READ_ONLY: 'Lista para lectura externa' };
const runStates = { QUEUED: 'En cola', RUNNING: 'En curso', COMPLETED: 'Completada', FAILED: 'Fallida', BLOCKED: 'Bloqueada' };
const sources = { MAIL: 'Correo IMAP', SIRE: 'SIRE', ALL: 'Todas las fuentes' };
const ignoreDirtyChange = (_dirty: boolean) => {};
const counters: { key: keyof ReceivedSyncRun['counters']; label: string }[] = [
  { key: 'detected', label: 'Detectados' }, { key: 'imported', label: 'Importados' },
  { key: 'duplicate', label: 'Duplicados' }, { key: 'rejected', label: 'Rechazados' },
  { key: 'xmlPending', label: 'XML pendientes' }, { key: 'matches', label: 'Coincidencias' }, { key: 'mismatches', label: 'Conflictos' },
];

/** Use the provider for the initial read; keep background refreshes quiet and scoped. */
function useAutomationFeed<T>(path: string, valid: (value: unknown) => value is T, latest: (old: T | undefined, next: T) => T = (_, next) => next) {
  const { api } = useWorkspace();
  const initial = useResource<unknown>(path);
  const rules = useRef({ valid, latest });
  rules.current = { valid, latest };
  const [data, setData] = useState<T | undefined>(() => valid(initial.data) ? initial.data : undefined);
  const [error, setError] = useState(!!initial.error || initial.data !== undefined && !valid(initial.data));
  const initialSettled = useRef(false);
  initialSettled.current = initial.data !== undefined || !!initial.error;
  const poll = useRef<ReturnType<typeof createReceivedAutomationPoll<unknown>> | undefined>(undefined);
  const publish = useCallback((value: unknown) => {
    if (!rules.current.valid(value)) { setError(true); return false; }
    setData(previous => rules.current.latest(previous, value)); setError(false); return true;
  }, []);
  useEffect(() => { if (initial.data !== undefined) publish(initial.data); }, [initial.data, publish]);
  useEffect(() => { if (initial.error) setError(true); }, [initial.error]);
  useEffect(() => {
    const task = createReceivedAutomationPoll(signal => api<unknown>(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) }), publish, () => setError(true));
    poll.current = task;
    const timer = window.setInterval(() => { if (!document.hidden && initialSettled.current) void task.run(); }, RECEIVED_AUTOMATION_POLL_MS);
    return () => { window.clearInterval(timer); task.cancel(); poll.current = undefined; };
  }, [api, path, publish]);
  return { data, error, publish, reload: () => { void poll.current?.run(); } };
}

/** The received list owns workspace dirty state; this panel reports its own state. */
export function ReceivedAutomationPanel({ selection, onDirtyChange = ignoreDirtyChange }: { selection: ReceivedSelection; onDirtyChange?: (dirty: boolean) => void }) {
  const { user, can, catalogSource } = useWorkspace();
  const manage = canManageReceivedAutomation(user, can('setup.manage'));
  const read = can('report.view');
  if (!user || !receivedAutomationSelectionAllowed(selection, user) || !read && !manage) return <ErrorState message="Selecciona un RUC y una sede autorizados para consultar la recepción automática." />;
  return <ReceivedAutomationScope key={receivedAutomationScopeKey(selection, user, catalogSource)} selection={selection} manage={manage} read={read} onDirtyChange={onDirtyChange} />;
}

function ReceivedAutomationScope({ selection, manage, read, onDirtyChange }: { selection: ReceivedSelection; manage: boolean; read: boolean; onDirtyChange: (dirty: boolean) => void }) {
  return <section aria-label="Recepción automática" className="space-y-5">
    <Card className="shadow-none"><CardHeader><CardTitle>Recepción automática</CardTitle>
      <CardDescription>{selection.company.legalName} · RUC {selection.company.ruc}{selection.branchId ? ' · Sede seleccionada' : ' · Todas las sedes autorizadas'}</CardDescription></CardHeader>
      <CardContent className="space-y-2 text-sm text-muted-foreground">
        <p>IMAP recibe correos y sus adjuntos. SMTP es correo saliente y se configura por separado.</p>
        <p>SIRE permite descubrir comprobantes; no garantiza obtener el XML completo. Los hallazgos sin XML quedan pendientes para adjuntar o recibir el XML del proveedor.</p>
        <p>Este flujo no emite comprobantes, no acepta propuestas SIRE ni presenta RCE. Importar o relacionar un XML no acredita aceptación fiscal.</p>
      </CardContent></Card>
    {manage ? <ReceivedAutomationManager selection={selection} onDirtyChange={onDirtyChange} /> : <p className="text-sm text-muted-foreground">Consulta de descubrimientos de la sede autorizada. La configuración por RUC y las ejecuciones requieren un administrador general.</p>}
    {read && <ReceivedDiscoveriesResource selection={selection} />}
  </section>;
}

function ReceivedAutomationManager({ selection, onDirtyChange }: { selection: ReceivedSelection; onDirtyChange: (dirty: boolean) => void }) {
  const { api } = useWorkspace();
  const config = useAutomationFeed(receivedAutomationQuery(selection, 'config'),
    (value): value is ReceivedAutomationConfig => receivedAutomationConfigInScope(value, selection),
    (old, next) => old && old.revision > next.revision ? old : next);
  const [draft, setDraft] = useState<ReceivedAutomationDraft | undefined>(() => config.data ? createReceivedAutomationDraft(config.data) : undefined);
  const [busy, setBusy] = useState<'save' | ReceivedAutomationSource>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const operation = useRef(createReceivedOperation());
  const pending = useRef(false);
  const dirty = !!draft && receivedAutomationDraftDirty(draft);
  useEffect(() => { if (config.data) setDraft(previous => reconcileReceivedAutomationDraft(previous, config.data!)); }, [config.data]);
  useEffect(() => { onDirtyChange(dirty || !!busy); }, [dirty, busy, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => () => { operation.current.cancel(); pending.current = false; }, []);
  async function act<T>(label: 'save' | ReceivedAutomationSource, work: (signal: AbortSignal) => Promise<T>, done: (value: T) => void) {
    if (pending.current) return;
    pending.current = true;
    const controller = operation.current.start();
    setBusy(label); setError(undefined); setNotice(undefined);
    try {
      const value = await work(AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]));
      if (operation.current.current(controller)) done(value);
    } catch (reason) {
      if (operation.current.current(controller)) {
        setError(reason instanceof ApiError && reason.status === 409
          ? 'La revisión cambió. Conservamos tus campos; carga la configuración actual antes de volver a guardar.'
          : 'No se pudo completar la operación. Comprueba permisos y preparación del servidor e inténtalo de nuevo.');
        config.reload();
      }
    } finally {
      if (operation.current.current(controller)) { pending.current = false; setBusy(undefined); }
    }
  }
  function save() {
    if (!draft || !config.data?.canManage || config.error || !dirty || busy) return;
    const invalid = receivedAutomationSettingsError(draft.settings, selection.company.ruc);
    if (invalid) { setError(invalid); return; }
    if (draft.expectedRevision !== config.data.revision) { setError('La revisión cambió. Carga la configuración actual y vuelve a aplicar tus cambios.'); return; }
    void act('save', signal => api<unknown>(receivedAutomationQuery(selection, 'config'), { method: 'PATCH', signal, body: JSON.stringify(receivedAutomationSave(draft)) }), value => {
      setDraft(previous => previous ? { ...previous, credentials: { mailPassword: '', sireClientSecret: '', solPassword: '' } } : previous);
      if (!receivedAutomationConfigInScope(value, selection)) { setError('La respuesta de configuración no corresponde al RUC seleccionado o es inválida.'); return; }
      config.publish(value); setDraft(createReceivedAutomationDraft(value));
      setNotice(`Configuración guardada. ${states[value.state]}. Los campos de contraseñas se han vaciado.`);
    });
  }
  function sync(source: ReceivedAutomationSource) {
    if (!config.data || config.error || busy || dirty || receivedAutomationSyncBlock(config.data, source)) return;
    void act(source, signal => api<{ queued: number }>(`${RECEIVED_AUTOMATION_API}/sync`, { method: 'POST', signal, body: JSON.stringify({ companyId: selection.company.id, source }) }), value => {
      if (!value || !Number.isSafeInteger(value.queued) || value.queued < 0) { setError('El servidor devolvió una respuesta de sincronización inválida.'); return; }
      setNotice(value.queued ? `${value.queued} ejecución(es) en cola. Los resultados se actualizarán en segundo plano.` : 'No se agregaron ejecuciones a la cola.');
      config.reload();
    });
  }
  return <>
    {!config.data ? config.error ? <ErrorState message="No se pudo cargar una configuración segura para este RUC." retry={config.reload} /> : <Loading /> : <>
      <ReceivedAutomationStatus config={config.data} />
      {config.error && <p className="text-sm text-muted-foreground">No se pudo actualizar el estado. Conservamos tus campos. <Button type="button" variant="outline" size="sm" onClick={config.reload}>Reintentar consulta</Button></p>}
      {draft && <ReceivedAutomationForm config={config.data} draft={draft} busy={!!busy} unavailable={config.error} onChange={value => { setDraft(value); setError(undefined); setNotice(undefined); }} onSubmit={save} onDiscard={() => { setDraft(createReceivedAutomationDraft(config.data!)); setError(undefined); setNotice(undefined); }} />}
      {error && <ErrorState message={error} />}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      <ReceivedProductionActivation companyId={selection.company.id} ruc={selection.company.ruc} disabled={dirty || !!busy} onChanged={config.reload} />
    <ReceivedAutomationSyncControls config={config.data} busy={!!busy} dirty={dirty} unavailable={config.error} onSync={sync} />
    </>}
    <ReceivedRunsResource selection={selection} />
    <ReceivedIncidentsResource selection={selection} />
  </>;
}

export function ReceivedAutomationStatus({ config }: { config: ReceivedAutomationConfig }) {
  return <Card className="shadow-none"><CardHeader><CardTitle className="text-base">Estado de preparación</CardTitle><CardDescription>{config.notice}</CardDescription></CardHeader>
    <CardContent className="space-y-3 text-sm"><div className="flex flex-wrap gap-2"><Badge variant="outline">{states[config.state]}</Badge><Badge variant="outline">{config.settings.mode === 'LOCAL_FIXTURE' ? 'Fixtures locales' : 'Lectura externa sin escritura fiscal'}</Badge><Badge variant="outline">Revisión {config.revision}</Badge></div>
      <dl className="grid gap-3 sm:grid-cols-2"><div><dt className="text-muted-foreground">Lectura externa autorizada por el servidor</dt><dd>{config.liveReadAllowed ? 'Sí' : 'No · esperando TI'}</dd></div>
        <div><dt className="text-muted-foreground">Hostname IMAP guardado aprobado</dt><dd>{config.mailHostApproved ? 'Sí' : 'No · requiere aprobación exacta de TI'}</dd></div>
        <div><dt className="text-muted-foreground">Última actualización</dt><dd>{config.updatedAt ?? 'Todavía sin guardar'}</dd></div></dl>
      {!config.liveReadAllowed && <p>Se puede guardar la preparación LIVE_READ_ONLY. La lectura externa permanece bloqueada hasta que TI la autorice; en QA queda esperando TI.</p>}
      <p>LIVE_READ_ONLY consulta compras reales y requiere autorización separada de TI. No es SOAP beta.</p>
      {!config.canManage && <p>El servidor denegó la gestión de esta configuración.</p>}
    </CardContent></Card>;
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return <div className="space-y-2"><Label htmlFor={id}>{label}</Label>{children}</div>;
}

export function ReceivedAutomationForm({ config, draft, busy = false, unavailable = false, onChange, onSubmit, onDiscard }: {
  config: ReceivedAutomationConfig; draft: ReceivedAutomationDraft; busy?: boolean; unavailable?: boolean;
  onChange: (draft: ReceivedAutomationDraft) => void; onSubmit: () => void; onDiscard: () => void;
}) {
  const prefix = useId();
  const id = (name: string) => `${prefix}-${name}`;
  const { settings, credentials } = draft;
  const dirty = receivedAutomationDraftDirty(draft);
  const invalid = receivedAutomationSettingsError(settings, config.recipientRuc);
  const stale = draft.expectedRevision !== config.revision;
  const disabled = busy || !config.canManage;
  const update = (patch: Partial<typeof settings>) => onChange({ ...draft, settings: { ...settings, ...patch } });
  const secret = (key: keyof typeof credentials, value: string) => onChange({ ...draft, credentials: { ...credentials, [key]: value } });
  return <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (!disabled && !unavailable && dirty && !invalid && !stale) onSubmit(); }}>
    <Card className="shadow-none"><CardHeader><CardTitle className="text-base">Configuración por RUC</CardTitle><CardDescription>Guardar prepara las fuentes. La autorización de lectura se controla en el servidor.</CardDescription></CardHeader><CardContent>
      <fieldset disabled={disabled} className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3"><legend className="sr-only">Recepción e intervalo</legend>
        <div className="flex items-center gap-2"><input id={id('enabled')} type="checkbox" className="size-4 accent-primary" checked={settings.enabled} onChange={event => update({ enabled: event.target.checked })} /><Label htmlFor={id('enabled')}>Habilitar recepción automática</Label></div>
        <Field id={id('mode')} label="Modo de recepción"><Select value={settings.mode} disabled={disabled} onValueChange={value => { if (value === 'LOCAL_FIXTURE' || value === 'LIVE_READ_ONLY') update({ mode: value }); }}><SelectTrigger id={id('mode')} className="w-full"><SelectValue>{settings.mode === 'LOCAL_FIXTURE' ? 'Fixtures locales · RUC ficticio 00' : 'Lectura externa · LIVE_READ_ONLY'}</SelectValue></SelectTrigger><SelectContent><SelectItem value="LOCAL_FIXTURE">Fixtures locales · RUC ficticio 00</SelectItem><SelectItem value="LIVE_READ_ONLY">Lectura externa · LIVE_READ_ONLY</SelectItem></SelectContent></Select></Field>
        <Field id={id('interval')} label="Intervalo (minutos)"><Input id={id('interval')} type="number" min={5} max={1440} step={1} value={settings.intervalMinutes} onChange={event => update({ intervalMinutes: Number(event.target.value) })} /></Field>
      </fieldset>
    </CardContent></Card>
    <fieldset disabled={disabled} className="grid min-w-0 gap-4 lg:grid-cols-2"><legend className="sr-only">Fuentes de recepción y credenciales</legend>
      <Card className="shadow-none"><CardHeader><CardTitle className="text-base">Correo entrante · IMAP</CardTitle><CardDescription>TLS obligatorio · puerto 993. SMTP no recibe adjuntos.</CardDescription></CardHeader><CardContent className="space-y-4">
        <div className="flex items-center gap-2"><input id={id('mail-enabled')} type="checkbox" className="size-4 accent-primary" checked={settings.mailbox.enabled} onChange={event => update({ mailbox: { ...settings.mailbox, enabled: event.target.checked } })} /><Label htmlFor={id('mail-enabled')}>Recibir desde correo</Label></div>
        <Field id={id('host')} label="Hostname IMAP exacto"><Input id={id('host')} value={settings.mailbox.host} maxLength={253} autoComplete="off" aria-describedby={id('host-help')} onChange={event => update({ mailbox: { ...settings.mailbox, host: event.target.value } })} /></Field>
        <p id={id('host-help')} className="text-xs text-muted-foreground">TI debe aprobar este hostname exacto en el servidor. El estado de aprobación corresponde a la configuración guardada.</p>
        <Field id={id('port')} label="Puerto IMAP con TLS"><Input id={id('port')} type="number" value={settings.mailbox.port} readOnly /></Field>
        <Field id={id('folder')} label="Carpeta del buzón"><Input id={id('folder')} value={settings.mailbox.folder} autoComplete="off" onChange={event => update({ mailbox: { ...settings.mailbox, folder: event.target.value } })} /></Field>
        <Field id={id('mail-user')} label="Usuario IMAP"><Input id={id('mail-user')} value={settings.mailbox.username} autoComplete="off" onChange={event => update({ mailbox: { ...settings.mailbox, username: event.target.value } })} /></Field>
        <Field id={id('mail-password')} label="Nueva contraseña IMAP"><Input id={id('mail-password')} type="password" autoComplete="new-password" value={credentials.mailPassword} aria-describedby={id('secret-help')} onChange={event => secret('mailPassword', event.target.value)} /></Field>
        <p className="text-xs text-muted-foreground">Contraseña IMAP: {config.credentials.mailPassword ? 'guardada' : 'pendiente'}.</p>
      </CardContent></Card>
      <Card className="shadow-none"><CardHeader><CardTitle className="text-base">Descubrimiento · SIRE</CardTitle><CardDescription>Consulta de compras y relación con XML recibido. Sin aceptar propuestas ni presentar RCE. Cada consulta revisa los últimos tres periodos, sin retroceder más allá del periodo inicial.</CardDescription></CardHeader><CardContent className="space-y-4">
        <div className="flex items-center gap-2"><input id={id('sire-enabled')} type="checkbox" className="size-4 accent-primary" checked={settings.sire.enabled} onChange={event => update({ sire: { ...settings.sire, enabled: event.target.checked } })} /><Label htmlFor={id('sire-enabled')}>Descubrir desde SIRE</Label></div>
        <Field id={id('period')} label="Periodo inicial (AAAAMM)"><Input id={id('period')} value={settings.sire.startPeriod} inputMode="numeric" maxLength={6} onChange={event => update({ sire: { ...settings.sire, startPeriod: event.target.value } })} /></Field>
        <Field id={id('client-id')} label="Client ID SIRE"><Input id={id('client-id')} value={settings.sire.clientId} autoComplete="off" onChange={event => update({ sire: { ...settings.sire, clientId: event.target.value } })} /></Field>
        <Field id={id('client-secret')} label="Nuevo client secret SIRE"><Input id={id('client-secret')} type="password" autoComplete="new-password" value={credentials.sireClientSecret} aria-describedby={id('secret-help')} onChange={event => secret('sireClientSecret', event.target.value)} /></Field>
        <Field id={id('sol-user')} label="Usuario SOL (sin RUC como prefijo)"><Input id={id('sol-user')} value={settings.sire.solUsername} maxLength={32} autoComplete="off" onChange={event => update({ sire: { ...settings.sire, solUsername: event.target.value } })} /></Field>
        <Field id={id('sol-password')} label="Nueva contraseña SOL"><Input id={id('sol-password')} type="password" autoComplete="new-password" value={credentials.solPassword} aria-describedby={id('secret-help')} onChange={event => secret('solPassword', event.target.value)} /></Field>
        <p className="text-xs text-muted-foreground">Client secret: {config.credentials.sireClientSecret ? 'guardado' : 'pendiente'} · Contraseña SOL: {config.credentials.solPassword ? 'guardada' : 'pendiente'}.</p>
      </CardContent></Card>
    </fieldset>
    <p id={id('secret-help')} className="text-xs text-muted-foreground">Deja cada contraseña vacía para conservar la guardada. Los secretos sólo se envían al guardar, no se devuelven en las consultas y se vacían tras guardar. No se persisten en el navegador.</p>
    {invalid && <p className="text-sm text-destructive">{invalid}</p>}
    {stale && <p className="text-sm">Hay una revisión nueva en el servidor. Tus campos se conservan; carga la configuración actual y vuelve a aplicar tus cambios.</p>}
    <div className="flex flex-wrap justify-end gap-3"><Button type="button" variant="outline" disabled={busy || !dirty && !stale} onClick={onDiscard}>Cargar configuración actual</Button>
      <Button type="submit" disabled={disabled || unavailable || !dirty || !!invalid || stale}>{busy ? 'Procesando…' : 'Guardar configuración'}</Button></div>
  </form>;
}

export function ReceivedAutomationSyncControls({ config, busy = false, dirty = false, unavailable = false, onSync }: {
  config: ReceivedAutomationConfig; busy?: boolean; dirty?: boolean; unavailable?: boolean; onSync: (source: ReceivedAutomationSource) => void;
}) {
  const block = receivedAutomationSyncBlock(config, 'ALL');
  return <Card className="shadow-none"><CardHeader><CardTitle className="text-base">Consultar fuentes guardadas</CardTitle><CardDescription>La consulta usa la última configuración guardada y la autorización del servidor.</CardDescription></CardHeader><CardContent className="space-y-3">
    {block && <p className="text-sm">{block}</p>}{dirty && <p className="text-sm">Guarda o descarta los campos antes de consultar.</p>}
    <div className="flex flex-wrap gap-2">{(['MAIL', 'SIRE', 'ALL'] as const).map(source => <Button key={source} type="button" variant="outline" disabled={busy || dirty || unavailable || !!receivedAutomationSyncBlock(config, source)} onClick={() => onSync(source)}>{source === 'ALL' ? 'Consultar ambas fuentes' : `Consultar ${sources[source]}`}</Button>)}</div>
  </CardContent></Card>;
}

function ReceivedRunsResource({ selection }: { selection: ReceivedSelection }) {
  const feed = useAutomationFeed(receivedAutomationQuery(selection, 'runs'), receivedAutomationRunsValid);
  return <Card className="shadow-none"><CardHeader><CardTitle className="text-base">Ejecuciones de este RUC</CardTitle><CardDescription>Actualización en segundo plano cada 20 segundos.</CardDescription></CardHeader><CardContent>
    {feed.data ? <ReceivedAutomationRuns items={feed.data.items} /> : !feed.error ? <Loading /> : null}
    {feed.error && <p className="text-sm text-muted-foreground">No se pudieron actualizar las ejecuciones. <Button type="button" variant="outline" size="sm" onClick={feed.reload}>Reintentar</Button></p>}
  </CardContent></Card>;
}

export function ReceivedAutomationRuns({ items }: { items: ReceivedSyncRun[] }) {
  if (!items.length) return <Empty title="Sin ejecuciones" description="Todavía no hay ejecuciones registradas para este RUC." />;
  return <ul className="space-y-4">{items.map(run => <li key={run.id} className="space-y-3 rounded-lg border p-4 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">{sources[run.source]}</p><Badge variant="outline">{runStates[run.status]}</Badge></div>
    <p className="text-xs text-muted-foreground">Inicio: {run.startedAt ?? 'Pendiente'} · Fin: {run.finishedAt ?? 'Pendiente'}</p>
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">{counters.map(counter => <div key={counter.key}><dt className="text-xs text-muted-foreground">{counter.label}</dt><dd className="tabular-nums">{run.counters[counter.key]}</dd></div>)}</dl>
    {run.errorCode && <p className="text-xs">Código de diagnóstico: {run.errorCode}</p>}
  </li>)}</ul>;
}

function ReceivedIncidentsResource({ selection }: { selection: ReceivedSelection }) {
  const feed = useAutomationFeed(receivedAutomationQuery(selection, 'incidents'), receivedAutomationIncidentsValid);
  return <Card className="shadow-none"><CardHeader><CardTitle className="text-base">Incidentes SIRE de este RUC</CardTitle>
    <CardDescription>Registros no conciliables: revisa el periodo, el ordinal y el código informado. Sólo se muestran metadatos; estos incidentes no acreditan aceptación fiscal.</CardDescription></CardHeader><CardContent>
    {feed.data ? <ReceivedAutomationIncidents items={feed.data.items} /> : !feed.error ? <Loading /> : null}
    {feed.error && <p className="text-sm text-muted-foreground">No se pudieron actualizar metadatos seguros de incidentes SIRE. <Button type="button" variant="outline" size="sm" onClick={feed.reload}>Reintentar</Button></p>}
  </CardContent></Card>;
}

export function ReceivedAutomationIncidents({ items }: { items: ReceivedSireIncidentMetadata[] }) {
  if (!items.length) return <Empty title="Sin incidentes SIRE" description="No hay registros no conciliables informados para este RUC." />;
  return <Table><TableHeader><TableRow><TableHead>Periodo</TableHead><TableHead>Ordinal</TableHead><TableHead>Código</TableHead><TableHead>Observado</TableHead><TableHead>Identificador</TableHead></TableRow></TableHeader>
    <TableBody>{items.map(row => <TableRow key={row.id}><TableCell>{row.period}</TableCell><TableCell className="tabular-nums">{row.ordinal}</TableCell>
      <TableCell><code className="break-all text-xs">{row.code}</code></TableCell><TableCell>{row.observedAt}</TableCell><TableCell className="break-all font-mono text-xs">{row.id}</TableCell></TableRow>)}</TableBody>
  </Table>;
}

function ReceivedDiscoveriesResource({ selection }: { selection: ReceivedSelection }) {
  const { user } = useWorkspace();
  const feed = useAutomationFeed(receivedAutomationQuery(selection, 'discoveries'),
    (value): value is { items: ReceivedSireDiscovery[] } => receivedAutomationDiscoveriesInScope(value, selection, user?.scope.kind === 'ASSIGNED'));
  return <Card className="shadow-none"><CardHeader><CardTitle className="text-base">Descubrimientos SIRE</CardTitle><CardDescription>Datos consultados para el RUC{selection.branchId ? ' y la sede' : ''} seleccionados. El XML completo puede seguir pendiente.</CardDescription></CardHeader><CardContent>
    {feed.data ? <ReceivedAutomationDiscoveries items={feed.data.items} /> : !feed.error ? <Loading /> : null}
    {feed.error && <p className="text-sm text-muted-foreground">No se pudieron actualizar descubrimientos válidos de este RUC. <Button type="button" variant="outline" size="sm" onClick={feed.reload}>Reintentar</Button></p>}
  </CardContent></Card>;
}

export function ReceivedAutomationDiscoveries({ items }: { items: ReceivedSireDiscovery[] }) {
  if (!items.length) return <Empty title="Sin descubrimientos SIRE" description="No hay ítems informados para esta selección. Cuando exista un hallazgo sin XML, figurará como XML pendiente." />;
  const labels = { PENDING: 'XML pendiente', MATCHED: 'XML relacionado', CONFLICT: 'Conflicto con XML' };
  return <Table><TableHeader><TableRow><TableHead>Periodo / comprobante</TableHead><TableHead>Proveedor / RUC</TableHead><TableHead>Fecha</TableHead><TableHead className="text-right">Importe informado</TableHead><TableHead>XML</TableHead><TableHead>Documento recibido</TableHead></TableRow></TableHeader>
    <TableBody>{items.map(row => <TableRow key={row.id}><TableCell><p className="font-medium">{row.fullNumber}</p><p className="text-xs text-muted-foreground">{receivedTypeLabel(row.documentType)} · {row.period}</p></TableCell>
      <TableCell><p>{row.supplierName ?? 'Nombre no informado'}</p><p className="font-mono text-xs">{row.supplierRuc}</p></TableCell><TableCell>{row.issueDate}</TableCell><TableCell className="text-right tabular-nums">{receivedAmount(row.amount, row.currencyCode)}</TableCell>
      <TableCell><Badge variant="outline">{labels[row.xmlStatus]}</Badge></TableCell><TableCell>{row.xmlStatus === 'MATCHED' && row.documentId ? <Button asChild variant="outline" size="sm"><Link href={`/received/${encodeURIComponent(row.documentId)}`} aria-label={`Ver XML relacionado de ${row.fullNumber}`}>Ver documento</Link></Button> : <span className="text-xs text-muted-foreground">{row.xmlStatus === 'CONFLICT' ? 'Requiere revisión' : 'Sin XML relacionado'}</span>}</TableCell></TableRow>)}</TableBody>
  </Table>;
}
